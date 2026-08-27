import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_SCRIPT_PATH } from './index.js'
import { serializeInstallPlan, type InstallPlan } from './plan.js'
import { renderSecretsEnv } from './push.js'

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

/**
 * A PACK'S OWN INPUTS REACH A STEP, delivered exactly as the box delivers them (issue #189,
 * ADR-0013).
 *
 * The issue's whole promise is "an install script simply reads `$HEADLONG_HEADLESS`", and the
 * only way to prove it is to run the real `agent.sh` against a real `secrets.env` written by
 * the real writer. Asserting on the env object core builds would prove core builds an object.
 *
 * ROOT STEPS ARE THE ONE WORTH PINNING HERE. `secrets.env` is documented as reaching "every
 * unprivileged step" — those get theirs from the explicit `env` list `install_tool` builds out
 * of `SECRET_NAMES` — while a root step inherits the agent's own environment from `set -a; .
 * secrets.env`. A tool install runs as root in most packs, so the case that had to be checked
 * rather than assumed is the inherited one. The name list is asserted alongside it, because it
 * is what the unprivileged path is built from and it is the thing the writer's quoting could
 * have broken.
 */
describe.skipIf(!hasJq)('agent.sh hands a pack input to a root step (issue #189)', () => {
  const INPUTS = {
    HEADLONG_HEADLESS: '1',
    // A value with spaces and shell metacharacters, because a form field carries whatever was
    // typed and an unquoted `secrets.env` would execute this rather than deliver it.
    HEADLONG_NOTE: "run $(id -u) 'now'",
  }

  function runWithSecrets(): { journal: { status: string }; stepLog: string; output: string } {
    stateDir = mkdtempSync(join(tmpdir(), 'rockysurf-agent-inputs-'))
    const withInput: InstallPlan = {
      ...plan,
      steps: [
        {
          id: 'tool:reads-input',
          reports: 'installing_tools',
          runAs: 'root',
          // `set -u`, so a variable the agent failed to export fails the step loudly.
          run: 'set -euo pipefail\nprintf "HEADLESS=%s\\nNOTE=%s\\n" "$HEADLONG_HEADLESS" "$HEADLONG_NOTE"',
        },
      ],
    }
    writeFileSync(join(stateDir, 'plan.json'), serializeInstallPlan(withInput))
    writeFileSync(join(stateDir, 'secrets.env'), `${renderSecretsEnv(INPUTS)}\n`, { mode: 0o600 })
    const run = spawnSync('bash', [AGENT_SCRIPT_PATH, join(stateDir, 'plan.json')], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ROCKYSURF_STATE_DIR: stateDir },
    })
    return {
      journal: JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')) as { status: string },
      stepLog: readFileSync(join(stateDir, 'steps', 'tool:reads-input.log'), 'utf8'),
      output: `${run.stdout}${run.stderr}`,
    }
  }

  it('exports every declared input into the step, values intact', () => {
    const { journal, stepLog, output } = runWithSecrets()
    expect(stepLog).not.toContain('unbound variable')
    expect(journal.status, output).toBe('done')
    expect(stepLog).toContain('HEADLESS=1\n')
    // Delivered, not executed: an unquoted writer would have run `id -u` on the box instead.
    expect(stepLog).toContain(`NOTE=${INPUTS.HEADLONG_NOTE}\n`)
  })

  it('learns the NAMES, which is what an unprivileged step is handed', () => {
    // `load_secrets` reads `KEY=` off each line into `SECRET_NAMES`, and `install_tool` turns
    // that list into the explicit `env` a `sudo -u rocky` step receives. Quoting the value must
    // not disturb the name, and the agent logs the names (never the values) as it goes.
    const { output } = runWithSecrets()
    const line = output.split('\n').find((l) => l.includes('secret(s):'))
    expect(line).toContain('loaded 2 secret(s): HEADLONG_HEADLESS HEADLONG_NOTE')
    // Names alone on that line: the agent never logs a secret's value, which is the whole
    // reason it keeps a name list rather than dumping the file. (The step's own output below
    // does print them — that is the step's choice, and this test asked it to.)
    expect(line).not.toContain(INPUTS.HEADLONG_NOTE)
  })
})
