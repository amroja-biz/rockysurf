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
 * The promise `docs/pack-contract.md` makes to every pack author is that the AGENT retries an
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

/**
 * apt's own words for a held dpkg lock, verbatim from the owner's droplet during the
 * DigitalOcean UAT (issue #404): the image's first-boot apt still had the lock when the first
 * tool step ran.
 */
const LOCK_HELD = [
  'E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 1527 (apt-get)',
  'E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), is another process using it?',
].join('\n')

/** Fails on the lock every time — the image's apt never lets go. */
const alwaysLockHeld = (counter: string) =>
  `printf 'x\\n' >> "$ROCKYSURF_STATE_DIR/${counter}"\nprintf '%s\\n' '${LOCK_HELD.replace(/\n/g, "' '")}' >&2\nexit 100`

/** Meets the lock once, then finds it released — the race the retry exists for. */
const lockHeldOnce = (counter: string) =>
  `printf 'x\\n' >> "$ROCKYSURF_STATE_DIR/${counter}"\n` +
  `[ -f "$ROCKYSURF_STATE_DIR/${counter}.seen" ] && exit 0\n` +
  `touch "$ROCKYSURF_STATE_DIR/${counter}.seen"\nprintf '%s\\n' '${LOCK_HELD.replace(/\n/g, "' '")}' >&2\nexit 100`

let stateDir: string | null = null
let binDir: string | null = null

afterEach(() => {
  for (const dir of [stateDir, binDir]) if (dir) rmSync(dir, { recursive: true, force: true })
  stateDir = null
  binDir = null
})

interface RunOptions {
  /**
   * How many times the fake `fuser` reports apt's lock held before reporting it free. The
   * fake counts its calls in the state directory and, on its second call — the first poll
   * after the agent announced the wait — snapshots `state.json`, which is the only way to see
   * a notice the agent takes back before the step runs.
   */
  lockHeldPolls?: number
  /** `ROCKYSURF_APT_LOCK_WAIT_S`: the bound on the agent's own wait for the lock. */
  lockWaitSeconds?: number
}

function runAgent(steps: InstallStep[], options: RunOptions = {}) {
  stateDir = mkdtempSync(join(tmpdir(), 'rockysurf-apt-retry-'))
  // The agent refreshes the apt lists between attempts. On a laptop there is no apt-get and on
  // a CI runner there is one that must not be run: a fake, first on PATH, answers both.
  binDir = mkdtempSync(join(tmpdir(), 'rockysurf-apt-retry-bin-'))
  const fakeApt = join(binDir, 'apt-get')
  writeFileSync(fakeApt, '#!/bin/bash\necho "fake apt-get $*"\nexit 0\n')
  chmodSync(fakeApt, 0o755)
  // The agent asks `fuser` who holds apt's locks before the first step (#404). A CI runner
  // has a real one — and, as a user, could not see root's apt-daily holding the lock anyway —
  // so the fake decides: held for the first N calls, then free. `cloud-init` is faked too,
  // although the agent only consults it as root.
  const held = options.lockHeldPolls ?? 0
  const fakeFuser = join(binDir, 'fuser')
  writeFileSync(
    fakeFuser,
    '#!/bin/bash\n' +
      'n=$(cat "$ROCKYSURF_STATE_DIR/fuser.calls" 2>/dev/null || echo 0); n=$((n + 1))\n' +
      'echo "$n" > "$ROCKYSURF_STATE_DIR/fuser.calls"\n' +
      `if [ "$n" -le ${held} ]; then\n` +
      '  [ "$n" -eq 2 ] && cp "$ROCKYSURF_STATE_DIR/state.json" "$ROCKYSURF_STATE_DIR/notice-snapshot.json"\n' +
      '  echo "$PPID"; exit 0\n' +
      'fi\n' +
      'exit 1\n',
  )
  chmodSync(fakeFuser, 0o755)
  const fakeCloudInit = join(binDir, 'cloud-init')
  writeFileSync(fakeCloudInit, '#!/bin/bash\nexit 0\n')
  chmodSync(fakeCloudInit, 0o755)

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
      ...(options.lockWaitSeconds !== undefined ? { ROCKYSURF_APT_LOCK_WAIT_S: String(options.lockWaitSeconds) } : {}),
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
  /** The journal as it stood on the fake fuser's second call: mid-wait, notice and all. */
  const noticeSnapshot = (): { notice?: string; step: string } | undefined => {
    try {
      return JSON.parse(readFileSync(join(stateDir!, 'notice-snapshot.json'), 'utf8'))
    } catch {
      return undefined
    }
  }
  return { status: run.status, agentLog: `${run.stdout}${run.stderr}`, journal, attempts, stepLog, noticeSnapshot }
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

/**
 * The image's own first-boot apt (issue #404). Every Ubuntu cloud image runs unattended-upgrades
 * and the like right after first boot, and the first tool step of every pack races it for the
 * dpkg lock. What the agent promises: it waits for the lock once before the first step and says
 * so; a step that meets the lock anyway gets the same second attempt a fetch failure gets; and a
 * step that fails for its own reasons is not mistaken for either.
 */
describe.skipIf(!hasJq)("the image's own first-boot apt holding the dpkg lock", () => {
  it('waits for the lock before the first step, announces it on the journal, and takes the notice back', () => {
    const { status, journal, attempts, agentLog, noticeSnapshot } = runAgent(
      [step('tool:build-essential', `printf 'x\\n' >> "$ROCKYSURF_STATE_DIR/build"`), step('branding', 'true', { reports: 'ready' })],
      { lockHeldPolls: 2 },
    )

    expect(journal.status, agentLog).toBe('done')
    expect(status).toBe(0)
    expect(attempts('build'), 'the step ran once the lock was free — no retry was needed').toBe(1)
    // The operator's view: why the box is doing nothing, and who is holding it up.
    expect(agentLog).toContain("waiting for the image's own package updates to finish")
    expect(agentLog).toMatch(/apt's lock is held by process \d+/)
    expect(agentLog).toMatch(/apt's lock is free after \d+s/)
    // The user's view: under the active step while the wait lasts, gone when it ends.
    const midWait = noticeSnapshot()
    expect(midWait?.step).toBe('tool:build-essential')
    expect(midWait?.notice).toContain("build-essential is waiting for the image's own package updates to finish")
    expect(midWait?.notice).toContain('Nothing is stuck')
    expect(journal.notice, 'a notice never outlives its cause').toBeUndefined()
  })

  it('gives up waiting at the bound and lets apt itself take the wait from there', () => {
    // Two seconds of bound, a lock that is never released: the step still runs (apt-get on
    // a box would then wait its own DPkg::Lock::Timeout), and the log says why it went ahead.
    const { journal, attempts, agentLog } = runAgent(
      [step('tool:build-essential', `printf 'x\\n' >> "$ROCKYSURF_STATE_DIR/build"`)],
      { lockHeldPolls: 1000, lockWaitSeconds: 2 },
    )

    expect(journal.status, agentLog).toBe('done')
    expect(attempts('build')).toBe(1)
    expect(agentLog).toMatch(/apt's lock is still held after \d+s .* — going ahead/)
    expect(agentLog).not.toContain("apt's lock is free after")
  })

  it('retries a step that met the lock once, without the mirror fallback', () => {
    // The lock was free when the agent looked and taken by the time the step's own apt-get
    // ran — a race the pre-step wait cannot close, so the step gets its second attempt.
    const { status, journal, attempts, agentLog } = runAgent([
      step('tool:build-essential', lockHeldOnce('build')),
      step('branding', 'true', { reports: 'ready' }),
    ])

    expect(journal.status, agentLog).toBe('done')
    expect(status).toBe(0)
    expect(attempts('build'), 'two attempts: the lock, then the install').toBe(2)
    expect(agentLog).toContain("apt's lock was held by another package manager")
    expect(agentLog).toContain('attempt 2 of 2')
    expect(agentLog, 'nothing about the mirror was wrong').not.toContain('engaging the mirror fallback')
    expect(journal.steps.find((s) => s.id === 'tool:build-essential')?.status).toBe('done')
    expect(journal.notice).toBeUndefined()
  })

  it("stops at two when the lock is never released, and the step log keeps apt's verdict", () => {
    const { status, journal, attempts, stepLog, agentLog } = runAgent([
      step('tool:build-essential', alwaysLockHeld('build')),
      step('branding', 'true', { reports: 'ready' }),
    ])

    expect(attempts('build'), 'two attempts, not three').toBe(2)
    expect(journal.status, agentLog).toBe('failed')
    expect(journal.failedStep).toBe('tool:build-essential')
    expect(status).toBe(1)
    expect(agentLog).toContain('apt is out of retries for this step')
    // What the failure report classifies on (`failure-report.ts`, cause `apt-lock`).
    expect(stepLog('tool:build-essential')).toContain('E: Could not get lock /var/lib/dpkg/lock-frontend')
  })

  it("does not take apt's own 'Waiting for cache lock' progress line for a lock failure", () => {
    // Under DPkg::Lock::Timeout apt prints the same words as progress while it waits and then
    // carries on. A step that later fails for its own reasons must not pay a retry for them.
    const { journal, attempts, agentLog } = runAgent([
      step(
        'tool:broken-pack',
        `printf 'x\\n' >> "$ROCKYSURF_STATE_DIR/own"\n` +
          `echo 'Waiting for cache lock: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 1527 (apt-get)... 5s'\n` +
          `echo 'E: Unable to locate package no-such-thing' >&2\nexit 100`,
      ),
    ])

    expect(attempts('own')).toBe(1)
    expect(journal.status).toBe('failed')
    expect(agentLog).not.toContain("apt's lock was held")
  })

  it("passes the lock timeout on the agent's own apt-get calls", () => {
    // The list refresh between two attempts goes through the one wrapper, so it too waits for
    // a held lock rather than failing the retry before it starts.
    const { agentLog } = runAgent([step('tool:first', alwaysFetchFails('first'), { optional: true })])

    expect(agentLog).toContain('fake apt-get -o DPkg::Lock::Timeout=300 update -qq')
  })
})
