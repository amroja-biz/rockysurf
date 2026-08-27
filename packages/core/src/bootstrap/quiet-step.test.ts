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

/** apt's own words for the failure mode, verbatim from Pack smoke on #187 (arm64). */
const FETCH_404_URL = 'http://ports.ubuntu.com/ubuntu-ports/pool/main/p/perl/perl-base_5.38.2-3.2ubuntu0.4_arm64.deb'
const FETCH_404 = `E: Failed to fetch ${FETCH_404_URL}  404  Not Found [IP: 91.189.91.103 80]`

/**
 * Fails the first time the way a sick mirror makes apt fail, then — on the second attempt —
 * copies the journal (what the timeline is showing while the retry runs) and converges.
 */
const failsOnceThenSnapshots = (signature: string) =>
  [
    `if [ -f "$ROCKYSURF_STATE_DIR/seen" ]; then ${snapshot('during-retry.json')}; exit 0; fi`,
    'touch "$ROCKYSURF_STATE_DIR/seen"',
    `echo '${signature}' >&2`,
    'exit 100',
  ].join('\n')

describe.skipIf(!hasJq)('the retry is announced, with the choice it leaves the user (#205)', () => {
  it('names the tool, the mirror and the URL, what happens next, the bound, and the two options', () => {
    const { journal, snapshot: read, agentLog } = runAgent([
      step('tool:build-essential', failsOnceThenSnapshots(FETCH_404), { timeoutSeconds: 1800 }),
      step('branding', 'true', { reports: 'ready' }),
    ])

    const notice = read('during-retry.json')?.notice
    expect(notice, agentLog).toBeDefined()
    // What failed, from where, with what answer — the fact the user can check themselves.
    expect(notice).toMatch(/^build-essential could not be downloaded — ports\.ubuntu\.com answered HTTP 404 for /)
    expect(notice).toContain(FETCH_404_URL)
    // What happens next: one more attempt, after the wait (no /etc/apt to swap on a laptop).
    expect(notice).toContain('then trying this step once more')
    // The bound, derived: a 1800 s timeout on the second attempt plus a zero wait is 30 min.
    expect(notice).toContain('it gives up after 30 more minutes at most')
    // The choice, in the user's terms, pointing at the control that already exists.
    expect(notice).toContain(
      'You can wait, or terminate this server now (Terminate, on this page) and launch it on another provider.',
    )

    // The notice stands for the second attempt only: gone once the step has converged.
    expect(journal.status, agentLog).toBe('done')
    expect(journal.notice).toBeUndefined()
  })

  it('still says what it can when apt phrased the failure without a URL', () => {
    const { journal, snapshot: read, agentLog } = runAgent([
      step(
        'tool:build-essential',
        failsOnceThenSnapshots('E: Some index files failed to download. They have been ignored, or old ones used instead.'),
        { timeoutSeconds: 600 },
      ),
    ])

    const notice = read('during-retry.json')?.notice
    expect(notice, agentLog).toContain(
      "build-essential could not be downloaded — Ubuntu's package mirror was not serving what apt asked for",
    )
    expect(notice).not.toContain('http')
    expect(notice).toContain('it gives up after 10 more minutes at most')
    expect(notice).toContain('terminate this server now')
    expect(journal.status).toBe('done')
  })

  it('is taken back when the second attempt fails too, so it never sits under a failed step', () => {
    const { journal, agentLog } = runAgent([step('tool:build-essential', `echo '${FETCH_404}' >&2; exit 100`)])

    expect(journal.status, agentLog).toBe('failed')
    expect(journal.failedStep).toBe('tool:build-essential')
    expect(journal.notice).toBeUndefined()
    expect(agentLog).toContain('apt is out of retries for this step')
  })
})
