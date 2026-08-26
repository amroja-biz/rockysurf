import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_SCRIPT_PATH } from './index.js'
import { serializeInstallPlan, type InstallPlan } from './plan.js'

/**
 * The environment a ROOT step inherits from the agent, exercised the way the real box
 * delivers it (issue #158).
 *
 * `docs/writing-a-pack.md` promises every step `$HOME`. Unprivileged steps get theirs from
 * `sudo -H`; root steps inherit the agent's own environment — and under the transient systemd
 * unit core launches (`docs/bootstrap-contract.md` § The systemd unit contract) that
 * environment carries no HOME, USER or LOGNAME, because systemd sets those only for units with
 * `User=`. The owner's personal pack piped an upstream installer to `bash` as root; its
 * second line under `set -u` was `${HEADLONG_HOME:-$HOME/.headlong}`, and the box died with
 * `bash: line 32: HOME: unbound variable` after every shipped tool had installed cleanly.
 *
 * Nothing else caught it: `docker exec` and a `nohup` shell both hand the agent a HOME, so
 * the pack smoke harness and the agent smoke were green. This test runs the real `agent.sh`
 * with the systemd-shaped environment — PATH and the state directory, nothing else — and a
 * one-step plan whose root step reads `$HOME` under `set -u`, exactly as the installer did.
 *
 * The agent needs `jq` to read its plan and would otherwise try to `apt-get` one, which is
 * not a thing a unit test does to a developer's machine — so the test is skipped, loudly,
 * where jq is absent. Every CI runner this repository uses has it.
 */

const hasJq = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0

/** The agent runs its steps as itself when `runAs` names the user it already is (or root). */
const plan: InstallPlan = {
  version: 1,
  serverId: 'srv-agent-env-test',
  mode: 'push',
  runId: 'run-1',
  steps: [
    {
      id: 'tool:reads-home',
      reports: 'installing_tools',
      runAs: 'root',
      // The shape of the failure: a strict script whose first expansion is `$HOME`.
      run: 'set -euo pipefail\nprintf "HOME=%s\\nUSER=%s\\nLOGNAME=%s\\n" "$HOME" "$USER" "$LOGNAME"',
    },
  ],
}

let stateDir: string | null = null

afterEach(() => {
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
  stateDir = null
})

function runAgentLikeSystemd() {
  stateDir = mkdtempSync(join(tmpdir(), 'rockysurf-agent-env-'))
  writeFileSync(join(stateDir, 'plan.json'), serializeInstallPlan(plan))
  const run = spawnSync('bash', [AGENT_SCRIPT_PATH, join(stateDir, 'plan.json')], {
    encoding: 'utf8',
    timeout: 60_000,
    // Deliberately NOT process.env: a transient root unit has PATH and little else.
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ROCKYSURF_STATE_DIR: stateDir },
  })
  const journal = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')) as {
    status: string
    failedStep?: string
    logTail?: string
  }
  const stepLog = readFileSync(join(stateDir, 'steps', 'tool:reads-home.log'), 'utf8')
  return { status: run.status, output: `${run.stdout}${run.stderr}`, journal, stepLog }
}

describe.skipIf(!hasJq)('agent.sh gives a root step the environment the pack contract promises', () => {
  it('sets HOME, USER and LOGNAME itself when the launcher provided none', () => {
    const { status, journal, stepLog, output } = runAgentLikeSystemd()

    // Without the fix this is `bash: line 1: HOME: unbound variable`, rc=1, status=failed.
    expect(stepLog).not.toContain('unbound variable')
    expect(journal.status, output).toBe('done')
    expect(status).toBe(0)

    const values = Object.fromEntries(stepLog.trim().split('\n').map((line) => line.split('=', 2)))
    expect(values['HOME']).toMatch(/^\/\S+/)
    expect(values['USER']).toBeTruthy()
    expect(values['LOGNAME']).toBe(values['USER'])
  })

  it('takes HOME from the passwd entry of the user the agent runs as, where the box can say', () => {
    // `getent` is the Linux answer; the real box always has it. Elsewhere the agent falls back
    // to `/root`, which is only ever wrong on a developer's laptop.
    const getent = spawnSync('getent', ['passwd', process.env['USER'] ?? ''], { encoding: 'utf8' })
    if (getent.status !== 0) return
    const expected = getent.stdout.trim().split(':')[5]

    const { stepLog } = runAgentLikeSystemd()
    expect(stepLog).toContain(`HOME=${expected}\n`)
  })
})
