import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_SCRIPT_PATH } from './index.js'
import { serializeInstallPlan, type InstallPlan, type InstallStep } from './plan.js'

/**
 * A step that says nothing is announced on the journal while it lasts (issue #205), exercised
 * against the real `agent.sh`.
 *
 * The owner terminated a healthy box at five minutes because "Installing tools" had not moved
 * and the setup log had six lines: the first apt step was waiting on a mirror that was slow to
 * answer, `apt-get update -qq` prints nothing until it has succeeded or given up, and the #129
 * notice only covers the wait BETWEEN two attempts — not the silent first attempt. Nothing in
 * core or the SPA was wrong, and nothing in core or the SPA could know: the agent is the only
 * thing that can see a step's log not moving. So the agent says so, in the journal's existing
 * `notice` field, with a clock that moves.
 *
 * Same harness as `apt-retry.test.ts`: the real shell, a fake `apt-get` on PATH, and the
 * quiet threshold turned down from a minute to a second so the test does not sit through one.
 * The step under test is the observer as well as the subject — it copies the journal while it
 * is being silent, because `spawnSync` gives the test no way to look during the run.
 */

const hasJq = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0

let stateDir: string | null = null
let binDir: string | null = null

afterEach(() => {
  for (const dir of [stateDir, binDir]) if (dir) rmSync(dir, { recursive: true, force: true })
  stateDir = null
  binDir = null
})

interface Journal {
  status: string
  failedStep?: string
  notice?: string
  steps: Array<{ id: string; status: string }>
}

function runAgent(steps: InstallStep[]) {
  stateDir = mkdtempSync(join(tmpdir(), 'rockysurf-quiet-step-'))
  binDir = mkdtempSync(join(tmpdir(), 'rockysurf-quiet-step-bin-'))
  const fakeApt = join(binDir, 'apt-get')
  writeFileSync(fakeApt, '#!/bin/bash\necho "fake apt-get $*"\nexit 0\n')
  spawnSync('chmod', ['755', fakeApt])

  const plan: InstallPlan = { version: 1, serverId: 'srv-quiet-step', mode: 'push', runId: 'run-1', steps }
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'plan.json'), serializeInstallPlan(plan))

  const run = spawnSync('bash', [AGENT_SCRIPT_PATH, join(stateDir, 'plan.json')], {
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      PATH: `${binDir}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
      ROCKYSURF_STATE_DIR: stateDir,
      ROCKYSURF_APT_RETRY_WAIT_S: '0',
      // A box waits a minute before it says anything; the test waits a second.
      ROCKYSURF_STEP_QUIET_S: '1',
    },
  })
  const readJson = (name: string): Journal | null => {
    const path = join(stateDir!, name)
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Journal) : null
  }
  const stepLog = (id: string) => readFileSync(join(stateDir!, 'steps', `${id}.log`), 'utf8')
  return {
    status: run.status,
    agentLog: `${run.stdout}${run.stderr}`,
    journal: readJson('state.json')!,
    snapshot: (name: string) => readJson(name),
    stepLog,
  }
}

const step = (id: string, run: string, extra: Partial<InstallStep> = {}): InstallStep => ({
  id,
  reports: 'installing_tools',
  runAs: 'root',
  run,
  ...extra,
})

/** Copies the journal as the step sees it at that moment, under a name the test reads back. */
const snapshot = (name: string) => `cp "$ROCKYSURF_STATE_DIR/state.json" "$ROCKYSURF_STATE_DIR/${name}"`

describe.skipIf(!hasJq)('a step that says nothing is announced on the journal while it lasts', () => {
  it('posts a notice naming the step and the elapsed time, and takes it back when output resumes', () => {
    const { journal, snapshot: read, agentLog, stepLog } = runAgent([
      step(
        'tool:build-essential',
        [
          'echo "Reading package lists..."',
          // Four seconds of nothing, then a look at what the journal says about it.
          'sleep 4',
          snapshot('while-quiet.json'),
          'echo "Get:1 http://ports.ubuntu.com/ubuntu-ports noble/main arm64 gcc"',
          // Long enough for the watcher to notice the log moved, short of a second of silence
          // — which would, correctly, be announced again.
          'sleep 0.5',
          snapshot('after-output.json'),
          'exit 0',
        ].join('\n'),
      ),
      step('branding', 'true', { reports: 'ready' }),
    ])

    const whileQuiet = read('while-quiet.json')
    expect(whileQuiet?.notice, agentLog).toMatch(/^build-essential has said nothing for \d+ s — /)
    expect(whileQuiet?.notice).toContain('Nothing is stuck.')
    // The clock moved: by four seconds the notice had been re-posted at least once.
    expect(whileQuiet?.notice).not.toMatch(/for 1 s/)

    expect(read('after-output.json')?.notice, 'the first line the step wrote took it back').toBeUndefined()
    expect(agentLog).toContain('tool:build-essential: no output for')
    expect(agentLog).toContain('tool:build-essential: output resumed')

    expect(journal.status, agentLog).toBe('done')
    expect(journal.notice).toBeUndefined()
    // The step's own output still lands in its log, and still reaches the agent's.
    expect(stepLog('tool:build-essential')).toContain('Reading package lists...')
    expect(agentLog).toContain('Get:1 http://ports.ubuntu.com')
    // Real seconds of real silence: this one cannot fit vitest's default five.
  }, 20_000)

  it('says nothing about a step that is talking', () => {
    const { journal, agentLog } = runAgent([
      // Three seconds of a line every fifth of a second: never a whole second of silence.
      step('tool:chatty', 'for i in $(seq 1 15); do echo "line $i"; sleep 0.2; done'),
      step('branding', 'true', { reports: 'ready' }),
    ])

    expect(journal.status, agentLog).toBe('done')
    expect(agentLog).not.toContain('no output for')
  })

  it("still reports the step's own exit status, and clears the notice when the step ends", () => {
    // The step now runs in the background so the agent can watch it; its exit status travels
    // through a file. A quiet step that fails must still fail the plan with ITS code, not
    // `tee`'s zero — and a notice must not outlive the step it was about.
    const { status, journal, agentLog } = runAgent([step('tool:silent-failure', 'sleep 2.2\nexit 3')])

    expect(agentLog).toContain('tool:silent-failure: no output for')
    expect(journal.status, agentLog).toBe('failed')
    expect(journal.failedStep).toBe('tool:silent-failure')
    expect(journal.notice, 'cleared when the step ended').toBeUndefined()
    expect(agentLog).toContain('FAILED (rc=3)')
    expect(status).toBe(1)
  })
})
