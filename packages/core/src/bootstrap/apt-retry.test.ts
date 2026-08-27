import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_SCRIPT_PATH } from './index.js'
import { serializeInstallPlan, type InstallPlan, type InstallStep } from './plan.js'

/**
 * The tool-install retry standard, exercised against the real `agent.sh` (issue #188).
 *
 * The promise `docs/writing-a-pack.md` makes to every pack author is that the AGENT retries an
 * apt fetch failure, so no pack script writes its own loop: two attempts at every step, and no
 * more. It used to be one retry for the whole bootstrap — whichever step failed first spent it
 * and every later step got none — which is not something a pack author can rely on.
 *
 * Why here and not only in `scripts/agent-smoke.sh`: that script needs Docker and CI does not
 * run it. This runs the same shell, with a fake `apt-get` on PATH so the agent's own
 * `apt-get update` between attempts touches nothing, and a wait of zero so nobody sits through
 * two minutes. What it cannot cover is the mirror REWRITE (there is no `/etc/apt` to rewrite on
 * a developer's laptop) — that is the agent smoke's run 5, and it is unchanged by this issue.
 *
 * The agent needs `jq` to read its plan and would otherwise try to `apt-get` one, which is not
 * a thing a unit test does to a developer's machine — so the test is skipped, loudly, where jq
 * is absent. Every CI runner this repository uses has it.
 */

const hasJq = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0

/** apt's own words for the failure mode, verbatim from Pack smoke on #187 (arm64). */
const FETCH_404 =
  'E: Failed to fetch http://ports.ubuntu.com/ubuntu-ports/pool/main/p/perl/perl-base_5.38.2-3.2ubuntu0.4_arm64.deb  404  Not Found [IP: 91.189.91.103 80]'

/** Counts its own attempts in the state directory, then fails the way a sick mirror makes apt fail. */
const alwaysFetchFails = (counter: string) =>
  `printf 'x\\n' >> "$ROCKYSURF_STATE_DIR/${counter}"\necho '${FETCH_404}' >&2\nexit 100`

/** Fails the same way once, then converges — the transient the retry exists for. */
const fetchFailsOnce = (counter: string) =>
  `printf 'x\\n' >> "$ROCKYSURF_STATE_DIR/${counter}"\n` +
  `[ -f "$ROCKYSURF_STATE_DIR/${counter}.seen" ] && exit 0\n` +
  `touch "$ROCKYSURF_STATE_DIR/${counter}.seen"\necho '${FETCH_404}' >&2\nexit 100`

let stateDir: string | null = null
let binDir: string | null = null

afterEach(() => {
  for (const dir of [stateDir, binDir]) if (dir) rmSync(dir, { recursive: true, force: true })
  stateDir = null
  binDir = null
})

function runAgent(steps: InstallStep[]) {
  stateDir = mkdtempSync(join(tmpdir(), 'rockysurf-apt-retry-'))
  // The agent refreshes the apt lists between attempts. On a laptop there is no apt-get and on
  // a CI runner there is one that must not be run: a fake, first on PATH, answers both.
  binDir = mkdtempSync(join(tmpdir(), 'rockysurf-apt-retry-bin-'))
  const fakeApt = join(binDir, 'apt-get')
  writeFileSync(fakeApt, '#!/bin/bash\necho "fake apt-get $*"\nexit 0\n')
  chmodSync(fakeApt, 0o755)

  const plan: InstallPlan = { version: 1, serverId: 'srv-apt-retry', mode: 'push', runId: 'run-1', steps }
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'plan.json'), serializeInstallPlan(plan))

  const run = spawnSync('bash', [AGENT_SCRIPT_PATH, join(stateDir, 'plan.json')], {
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      PATH: `${binDir}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
      ROCKYSURF_STATE_DIR: stateDir,
      // A box never sets this; the retry's wait is the point of the standard, not its duration.
      ROCKYSURF_APT_RETRY_WAIT_S: '0',
    },
  })
  const journal = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')) as {
    status: string
    failedStep?: string
    notice?: string
    steps: Array<{ id: string; status: string }>
  }
  const attempts = (counter: string) => {
    try {
      return readFileSync(join(stateDir!, counter), 'utf8').trim().split('\n').length
    } catch {
      return 0
    }
  }
  const stepLog = (id: string) => readFileSync(join(stateDir!, 'steps', `${id}.log`), 'utf8')
  return { status: run.status, agentLog: `${run.stdout}${run.stderr}`, journal, attempts, stepLog }
}

const step = (id: string, run: string, extra: Partial<InstallStep> = {}): InstallStep => ({
  id,
  reports: 'installing_tools',
  runAs: 'root',
  run,
  ...extra,
})

describe.skipIf(!hasJq)('every tool step gets two attempts at an apt fetch failure, and no more', () => {
  it('gives a LATER step its own retry after an earlier one has already used theirs', () => {
    // Under the old one-shot-per-bootstrap budget the first step spent the only retry and
    // `tool:second` — which would have converged on its second attempt — was never given one,
    // so the whole plan failed on a transient.
    const { status, journal, attempts, agentLog } = runAgent([
      step('tool:first', alwaysFetchFails('first'), { optional: true }),
      step('tool:second', fetchFailsOnce('second')),
      step('branding', 'true', { reports: 'ready' }),
    ])

    expect(journal.status, agentLog).toBe('done')
    expect(status).toBe(0)
    expect(attempts('first'), 'the first step got two attempts').toBe(2)
    expect(attempts('second'), 'and so did the second, independently').toBe(2)
    expect(journal.steps.find((s) => s.id === 'tool:first')?.status).toBe('failed')
    expect(journal.steps.find((s) => s.id === 'tool:second')?.status).toBe('done')
  })

  it('stops at two: a mirror that stays broken fails the launch, with the URL in the step log', () => {
    const { status, journal, attempts, stepLog, agentLog } = runAgent([
      step('tool:build-essential', alwaysFetchFails('build')),
      step('branding', 'true', { reports: 'ready' }),
    ])

    expect(attempts('build'), 'two attempts, not three').toBe(2)
    expect(journal.status, agentLog).toBe('failed')
    expect(journal.failedStep).toBe('tool:build-essential')
    // ADR-0010's terminate rule keys on this being a required TOOL step that failed.
    expect(status).toBe(1)
    // The plan stopped there: nothing after a failed required step runs.
    expect(journal.steps.find((s) => s.id === 'branding')?.status).toBe('pending')
    // And the evidence the failure report reads the URL out of survived both attempts.
    expect(stepLog('tool:build-essential')).toContain('perl-base_5.38.2-3.2ubuntu0.4_arm64.deb')
    expect(agentLog).toContain('apt is out of retries for this step')
  })

  it('does not retry — or pay the wait for — a step that failed for its own reasons', () => {
    const { journal, attempts, agentLog } = runAgent([
      step('tool:broken-pack', `printf 'x\\n' >> "$ROCKYSURF_STATE_DIR/own"\necho 'error: bad option --nope' >&2\nexit 2`),
    ])

    expect(attempts('own')).toBe(1)
    expect(journal.status).toBe('failed')
    expect(agentLog).not.toContain('engaging the mirror fallback')
  })

  it('announces the wait on the journal while it lasts, and takes it back afterwards', () => {
    // Two minutes under "Installing tools" with nothing moving looks like a hang (#129); a
    // notice that outlived its cause would sit under a failed step claiming nothing is stuck.
    const { journal, agentLog } = runAgent([step('tool:first', alwaysFetchFails('first'))])

    expect(agentLog).toContain('already on the global Ubuntu mirror')
    expect(agentLog).toContain('Ubuntu')
    expect(journal.notice, 'cleared once the wait was over').toBeUndefined()
  })
})
