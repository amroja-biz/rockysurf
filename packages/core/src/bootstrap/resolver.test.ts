import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile, spawnSync } from 'node:child_process'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDatabase } from '../db/client.js'
import { getServer, insertServer, setInstallPlan } from '../db/repositories/servers.js'
import { upsertUserByGithubId } from '../db/repositories/users.js'
import type { ToolRow } from '../db/schema.js'
import { isValidProvisioningStep } from '../db/transitions.js'
import { stepPhase } from './failure-report.js'
import { installPlanSchema, parseInstallPlan, serializeInstallPlan } from './plan.js'
import {
  GIT_CREDENTIAL_HELPER,
  NO_MATCHING_TOKEN_PREFIX,
  SETUP_GIT_AUTH_PREAMBLE,
  SHELL_ENVIRONMENT_BASHRC_MARKERS,
  SHELL_ENVIRONMENT_FILE,
  SHELL_ENVIRONMENT_PLATFORM_NAMES,
  SHELL_ENVIRONMENT_PROFILE_HOOK,
  SHELL_ENVIRONMENT_RENDER_FN,
  repoDirName,
  resolveInstallPlan,
  shellEnvironmentNames,
  type ResolveInstallPlanInput,
} from './resolver.js'

/**
 * Plan rendering, against `docs/bootstrap-contract.md` § Step ordering and its conformance
 * checklist. The two properties worth more than the rest: the phase order, and determinism —
 * a snapshotted plan that renders differently the second time makes resume skip the wrong
 * work, which is the failure the run id and the journal exist to prevent.
 */

const NOW = '2026-08-12T00:00:00.000Z'

const tool = (over: Partial<ToolRow> & { id: string }): ToolRow => ({
  name: over.id,
  description: 'a tool',
  // The resolver never reads it — the union happens in `resolvePack`, before this (issue #295).
  alwaysInstall: false,
  category: 'base',
  url: 'https://example.com',
  installScript: `install ${over.id}\n`,
  setupScript: null,
  enabled: true,
  installOrder: 10,
  bootstrap: false,
  runAs: 'root',
  sourceFile: null,
  registrySource: null,
  registryUrl: null,
  registrySha256: null,
  registryTrust: null,
  registryInstalledAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
})

const base = (over: Partial<ResolveInstallPlanInput> = {}): ResolveInstallPlanInput => ({
  serverId: 'srv-abc123',
  runId: 'run-1',
  mode: 'push',
  pack: { id: 'p', tools: ['claude-code'], requiresRdp: false },
  tools: [tool({ id: 'claude-code', installOrder: 40, runAs: 'rocky' })],
  ...over,
})

const ids = (input: ResolveInstallPlanInput) => resolveInstallPlan(input).steps.map((s) => s.id)

describe('phase ordering', () => {
  it('renders the documented phases in order with namespaced ids', () => {
    const plan = resolveInstallPlan(
      base({
        pack: { id: 'p', tools: ['node', 'claude-code'], requiresRdp: true, desktop: 'xfce' },
        tools: [
          tool({ id: 'guaranteed', bootstrap: true, installOrder: 0 }),
          tool({ id: 'node', installOrder: 20 }),
          tool({ id: 'claude-code', installOrder: 40, runAs: 'rocky', setupScript: 'setup claude\n' }),
        ],
        repositories: ['https://github.com/example/thing.git'],
        userScript: { script: 'echo mine\n', runAs: 'rocky' },
      }),
    )

    expect(plan.steps.map((s) => s.id)).toEqual([
      'tool:guaranteed', // 1 runtime-guaranteed, even though the pack never listed it
      'tool:node', // 2 pack tools by installOrder
      'tool:claude-code',
      'repo:thing', // 3 clones
      'tool-setup:claude-code', // 4 setup, after clones so it can read $REPOS
      'user-script', // 5 the user's own, after everything the pack does (issue #184)
      'shell-environment', // 6 what the creator supplied, into rocky's shell (issue #244)
      'branding', // 7
      'rdp', // 8 only because requiresRdp
    ])
  })

  it('breaks installOrder ties on toolId ascending', () => {
    // The rule the pack contract and the bootstrap contract agree on: a determinism guarantee
    // for the renderer, never a dependency mechanism for authors.
    const tools = ['zebra', 'apple', 'mango'].map((id) => tool({ id, installOrder: 30 }))
    expect(ids(base({ pack: { id: 'p', tools: ['zebra', 'apple', 'mango'], requiresRdp: false }, tools }))).toEqual([
      'tool:apple',
      'tool:mango',
      'tool:zebra',
      'shell-environment',
      'branding',
    ])
  })

  it('orders by installOrder before toolId', () => {
    const tools = [tool({ id: 'zzz', installOrder: 10 }), tool({ id: 'aaa', installOrder: 20 })]
    expect(ids(base({ pack: { id: 'p', tools: ['aaa', 'zzz'], requiresRdp: false }, tools }))).toEqual([
      'tool:zzz',
      'tool:aaa',
      'shell-environment',
      'branding',
    ])
  })

  it('skips a disabled tool rather than failing the render', () => {
    const tools = [tool({ id: 'on' }), tool({ id: 'off', enabled: false })]
    expect(ids(base({ pack: { id: 'p', tools: ['on', 'off'], requiresRdp: false }, tools }))).toEqual([
      'tool:on',
      'shell-environment',
      'branding',
    ])
  })

  it('ignores a pack reference to a tool that does not exist', () => {
    expect(ids(base({ pack: { id: 'p', tools: ['claude-code', 'ghost'], requiresRdp: false } }))).toEqual([
      'tool:claude-code',
      'shell-environment',
      'branding',
    ])
  })

  it('omits rdp unless the pack asks for it, and branding when told to', () => {
    expect(ids(base({ branding: false }))).toEqual(['tool:claude-code', 'shell-environment'])
    expect(ids(base({ pack: { id: 'p', tools: ['claude-code'], requiresRdp: true }, branding: false }))).toEqual([
      'tool:claude-code',
      'shell-environment',
      'rdp',
    ])
  })

  it('renders setup scripts in the same order as their install steps', () => {
    const tools = [
      tool({ id: 'b', installOrder: 20, setupScript: 'setup b\n' }),
      tool({ id: 'a', installOrder: 30, setupScript: 'setup a\n' }),
    ]
    expect(ids(base({ pack: { id: 'p', tools: ['a', 'b'], requiresRdp: false }, tools, branding: false }))).toEqual([
      'tool:b',
      'tool:a',
      'tool-setup:b',
      'tool-setup:a',
      'shell-environment',
    ])
  })
})

describe('phase 9: retiring the managed key (ADR-0008, issue #92)', () => {
  const USER_KEY = 'ssh-ed25519 AAAAuser me@laptop'
  const MANAGED_KEY = 'ssh-ed25519 AAAAmanaged rockysurf'

  it('adds the step last, after rdp, only when both keys are given', () => {
    expect(
      ids(
        base({
          pack: { id: 'p', tools: ['claude-code'], requiresRdp: true },
          branding: false,
          userSuppliedPublicKey: USER_KEY,
          managedPublicKey: MANAGED_KEY,
        }),
      ),
    ).toEqual(['tool:claude-code', 'shell-environment', 'rdp', 'supplied-key-only'])
  })

  it('is absent with no supplied key, and absent with a supplied key but no managed key', () => {
    expect(ids(base({ branding: false }))).not.toContain('supplied-key-only')
    expect(ids(base({ branding: false, userSuppliedPublicKey: USER_KEY }))).not.toContain('supplied-key-only')
    expect(ids(base({ branding: false, managedPublicKey: MANAGED_KEY }))).not.toContain('supplied-key-only')
  })

  it('is required, not optional — a failed guard must fail the whole plan', () => {
    const step = resolveInstallPlan(
      base({ branding: false, userSuppliedPublicKey: USER_KEY, managedPublicKey: MANAGED_KEY }),
    ).steps.find((s) => s.id === 'supplied-key-only')!
    expect(step.optional).toBeUndefined()
    expect(step.reports).toBe('ready')
    expect(step.runAs).toBe('rocky')
  })

  it('guards on the user key before touching anything, and removes only the managed key line', () => {
    const step = resolveInstallPlan(
      base({ branding: false, userSuppliedPublicKey: USER_KEY, managedPublicKey: MANAGED_KEY }),
    ).steps.find((s) => s.id === 'supplied-key-only')!

    // The guard: fails closed under `set -euo pipefail` if the user's line is not present.
    expect(step.run).toContain('grep -qxF -- "$user_line" "$auth"')
    // Surgical removal — a whole-line filter on core's OWN key, never a rewrite of the file, so
    // any other line a BYO host's authorized_keys already held survives untouched.
    expect(step.run).toContain('grep -vxF -- "$managed_line" "$auth" > "$auth.tmp"')
    expect(step.run).toContain(`user_line='${USER_KEY}'`)
    expect(step.run).toContain(`managed_line='${MANAGED_KEY}'`)

    // `check` re-verifies independently: the user's key present, the managed key gone.
    expect(step.check).toContain('grep -qxF')
    expect(step.check).toContain('! grep -qxF')
  })

  it('never embeds a raw single quote from either key unescaped', () => {
    // shellQuote's job: a key or comment containing `'` must not be able to break out of the
    // single-quoted literal and inject a second command.
    const tricky = `ssh-ed25519 AAAA it's-mine`
    const step = resolveInstallPlan(
      base({ branding: false, userSuppliedPublicKey: tricky, managedPublicKey: MANAGED_KEY }),
    ).steps.find((s) => s.id === 'supplied-key-only')!
    expect(step.run).toContain(`'\\''`)
  })
})

describe("phase 5: the user's own script (ADR-0011, issue #184)", () => {
  const withScript = (over: Partial<ResolveInstallPlanInput> = {}) =>
    base({ branding: false, userScript: { script: 'echo mine\n', runAs: 'rocky' }, ...over })

  it('renders no step at all when the user supplied none', () => {
    expect(ids(base({ branding: false }))).toEqual(['tool:claude-code', 'shell-environment'])
    expect(ids(base({ branding: false }))).not.toContain('user-script')
  })

  it('runs after every tool, clone and setup script, and before core\'s own finishing steps', () => {
    expect(
      ids(
        withScript({
          pack: { id: 'p', tools: ['claude-code'], requiresRdp: true },
          tools: [tool({ id: 'claude-code', installOrder: 40, runAs: 'rocky', setupScript: 'setup\n' })],
          repositories: ['https://github.com/example/thing.git'],
          branding: true,
          userSuppliedPublicKey: 'ssh-ed25519 AAAAuser me@laptop',
          managedPublicKey: 'ssh-ed25519 AAAAmanaged rockysurf',
        }),
      ),
    ).toEqual([
      'tool:claude-code',
      'repo:thing',
      'tool-setup:claude-code',
      'user-script',
      'shell-environment',
      'branding',
      'rdp',
      'supplied-key-only',
    ])
  })

  it('is OPTIONAL, so a script that fails leaves the user a running box to fix it on (ADR-0010)', () => {
    const step = resolveInstallPlan(withScript()).steps.find((s) => s.id === 'user-script')!
    expect(step.optional).toBe(true)
    // `finishing`, not `tool` — so even if the plan were failed by it, `terminatesInstance`
    // would keep the machine. Belt and braces, on purpose.
    expect(stepPhase(step.id)).toBe('finishing')
  })

  it('reports a word of its own, so the feed can say whose script is running', () => {
    const step = resolveInstallPlan(withScript()).steps.find((s) => s.id === 'user-script')!
    expect(step.reports).toBe('running_user_script')
    expect(isValidProvisioningStep(step.reports)).toBe(true)
    // It must NOT be the label that promotes a row to running: this step is not the end.
    expect(step.reports).not.toBe('ready')
  })

  it('honours the run-as the user chose — the freedom EC2 user data does not give', () => {
    expect(resolveInstallPlan(withScript()).steps.find((s) => s.id === 'user-script')!.runAs).toBe('rocky')
    expect(
      resolveInstallPlan(withScript({ userScript: { script: 'echo mine\n', runAs: 'root' } })).steps.find(
        (s) => s.id === 'user-script',
      )!.runAs,
    ).toBe('root')
  })

  it('gets the setup preamble — $REPOS and the clone step\'s git auth — and the script verbatim', () => {
    const step = resolveInstallPlan(
      withScript({ repositories: ['https://github.com/example/thing.git'], userScript: { script: 'cd "$REPOS"\n', runAs: 'rocky' } }),
    ).steps.find((s) => s.id === 'user-script')!

    expect(step.run).toContain("export REPOS='https://github.com/example/thing.git'")
    expect(step.run).toContain(SETUP_GIT_AUTH_PREAMBLE)
    expect(step.run.endsWith('cd "$REPOS"\n')).toBe(true)
    // NOT wrapped in `set -euo pipefail`: the script's own semantics are the user's to choose,
    // exactly as EC2 leaves user-data alone.
    expect(step.run).not.toContain('set -euo pipefail')
  })

  it('renders a valid plan and stays deterministic across two renders', () => {
    const input = withScript({ repositories: ['https://github.com/example/thing.git'] })
    expect(() => installPlanSchema.parse(resolveInstallPlan(input))).not.toThrow()
    expect(serializeInstallPlan(resolveInstallPlan(input))).toBe(serializeInstallPlan(resolveInstallPlan(input)))
  })
})

describe("phase 6: the creator's environment in rocky's shell (issue #244)", () => {
  const supplied = { packInputs: ['HEADLONG_API_KEY', 'HEADLONG_MODEL'], environment: ['MY_ENDPOINT', 'MY_TOKEN'] }
  const step = (over: Partial<ResolveInstallPlanInput> = {}) =>
    resolveInstallPlan(base({ shellEnvironment: supplied, ...over })).steps.find((s) => s.id === 'shell-environment')!

  it('is always rendered, as root, required, reporting ready — after the user script, before branding', () => {
    // Always: GITHUB_TOKEN is a candidate on every box, and presence is decided on the box.
    expect(ids(base({ branding: false }))).toContain('shell-environment')
    const s = step()
    expect(s.runAs).toBe('root')
    expect(s.optional).toBeUndefined()
    expect(s.reports).toBe('ready')
    expect(stepPhase(s.id)).toBe('finishing')
    const order = ids(base({ userScript: { script: 'echo mine\n', runAs: 'rocky' } }))
    expect(order.indexOf('shell-environment')).toBe(order.indexOf('user-script') + 1)
    expect(order.indexOf('shell-environment')).toBe(order.indexOf('branding') - 1)
  })

  it("carries the NAMES — the pack's inputs, then the Environment, then GITHUB_TOKEN — and nothing else of theirs", () => {
    expect(shellEnvironmentNames(supplied)).toEqual([
      'HEADLONG_API_KEY',
      'HEADLONG_MODEL',
      'MY_ENDPOINT',
      'MY_TOKEN',
      'GITHUB_TOKEN',
    ])
    expect(step().run).toContain("names=('HEADLONG_API_KEY' 'HEADLONG_MODEL' 'MY_ENDPOINT' 'MY_TOKEN' 'GITHUB_TOKEN')")
    // Rocky Surf's own mechanics stay out of the shell: the desktop password and the scoped
    // token set are read by nothing after setup, and are not the user's variables.
    expect(step().run).not.toContain('RDP_PASSWORD')
    expect(step().run).not.toContain('ROCKYSURF_GITHUB_TOKEN')
    expect(SHELL_ENVIRONMENT_PLATFORM_NAMES).toEqual(['GITHUB_TOKEN'])
  })

  it('renders with only the platform names when nothing was supplied, and deduplicates deterministically', () => {
    expect(shellEnvironmentNames(undefined)).toEqual(['GITHUB_TOKEN'])
    expect(step({ shellEnvironment: undefined }).run).toContain("names=('GITHUB_TOKEN')")
    expect(shellEnvironmentNames({ packInputs: ['A', 'GITHUB_TOKEN'], environment: ['A', 'B'] })).toEqual(['A', 'GITHUB_TOKEN', 'B'])
    const a = serializeInstallPlan(resolveInstallPlan(base({ shellEnvironment: supplied })))
    const b = serializeInstallPlan(resolveInstallPlan(base({ shellEnvironment: supplied })))
    expect(a).toBe(b)
  })

  it('writes the values file 0600 for rocky by whole-file replace, under umask 077, from the environment', () => {
    const run = step().run
    expect(run).toContain('umask 077')
    expect(run).toContain(`file="$home/${SHELL_ENVIRONMENT_FILE}"`)
    expect(run).toContain('install -d -m 0700 -o rocky -g rocky "$(dirname "$file")"')
    expect(run).toContain('chown rocky:rocky "$file.tmp"')
    expect(run).toContain('chmod 0600 "$file.tmp"')
    expect(run).toContain('mv -f "$file.tmp" "$file"')
    // The values are read off the step's own (inherited) environment — never argv, never the plan.
    expect(run).toContain('render_shell_environment "${names[@]}"')
    expect(run).toContain('${!name+x}')
  })

  it('installs a profile.d hook and a marker block at the top of /etc/bash.bashrc, both value-free', () => {
    const run = step().run
    expect(run).toContain(`mv -f ${SHELL_ENVIRONMENT_PROFILE_HOOK}.tmp ${SHELL_ENVIRONMENT_PROFILE_HOOK}`)
    expect(run).toContain(SHELL_ENVIRONMENT_BASHRC_MARKERS.start)
    expect(run).toContain(SHELL_ENVIRONMENT_BASHRC_MARKERS.end)
    // The previous block is stripped before the new one is prepended, so a re-run converges.
    expect(run).toContain(`sed '/^${SHELL_ENVIRONMENT_BASHRC_MARKERS.start}$/,/^${SHELL_ENVIRONMENT_BASHRC_MARKERS.end}$/d' /etc/bash.bashrc`)
    expect(run).toContain('mv -f /etc/bash.bashrc.tmp /etc/bash.bashrc')
    // Both hooks source the per-user file only when it is readable: inert for root and for
    // anyone without one, and the hook itself carries no value.
    expect(run).toContain(`if [ -r "\${HOME:-}/${SHELL_ENVIRONMENT_FILE}" ]; then . "\${HOME:-}/${SHELL_ENVIRONMENT_FILE}"; fi`)
  })

  /**
   * The renderer under a REAL bash, and its output under a real `sh`: the quoting is the one
   * part of this step where reading the script proves nothing. The values are the awkward
   * ones — quotes, `$(…)`, backticks, a backslash — and the file has to read back verbatim in
   * both shells, because xrdp's session script is `sh`.
   */
  const render = (env: Record<string, string>, names: string[]) =>
    spawnSync('bash', ['-c', `${SHELL_ENVIRONMENT_RENDER_FN}\nrender_shell_environment "$@"`, '_', ...names], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...env },
    })

  it('renders every SET name as a quoted export that bash and sh both read back verbatim', () => {
    const values = {
      HEADLONG_API_KEY: "it's $(not run) `nor this` \"quoted\" \\ done",
      MY_ENDPOINT: 'https://api.example.com/v1?x=1&y=2',
      MY_EMPTY: '',
    }
    const out = render(values, ['HEADLONG_API_KEY', 'MY_ENDPOINT', 'MY_EMPTY', 'MY_UNSET', 'GITHUB_TOKEN'])
    expect(out.status).toBe(0)
    const lines = out.stdout.trimEnd().split('\n')
    expect(lines.map((l) => l.split('=')[0])).toEqual(['export HEADLONG_API_KEY', 'export MY_ENDPOINT', 'export MY_EMPTY'])
    // Empty is KEPT (ADR-0014 §7: `FOO=` can only mean "set, empty"); unset is OMITTED.
    expect(lines[2]).toBe("export MY_EMPTY=''")
    expect(out.stdout).not.toContain('MY_UNSET')
    expect(out.stdout).not.toContain('GITHUB_TOKEN')

    for (const shell of ['bash', 'sh']) {
      const back = spawnSync(
        shell,
        ['-c', 'eval "$1"; printf "%s\\n%s\\n%s\\n" "$HEADLONG_API_KEY" "$MY_ENDPOINT" "[$MY_EMPTY]"', '_', out.stdout],
        { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' } },
      )
      expect(back.status, `${shell}: ${back.stderr}`).toBe(0)
      expect(back.stdout).toBe(`${values.HEADLONG_API_KEY}\n${values.MY_ENDPOINT}\n[]\n`)
    }
  })
})

describe('step content', () => {
  it('gives setup scripts $REPOS, which is where the contract says it comes from', () => {
    const plan = resolveInstallPlan(
      base({
        tools: [tool({ id: 'claude-code', runAs: 'rocky', setupScript: 'echo "$REPOS"\n' })],
        repositories: ['https://github.com/example/one.git', 'https://github.com/example/two'],
      }),
    )
    const setup = plan.steps.find((s) => s.id === 'tool-setup:claude-code')!
    expect(setup.run.startsWith("export REPOS='https://github.com/example/one.git,https://github.com/example/two'\n")).toBe(true)
    expect(setup.run.endsWith('\necho "$REPOS"\n')).toBe(true)
    expect(setup.runAs).toBe('rocky')
  })

  it('hands setup scripts the clone step\'s git credentials through the environment (issue #142)', () => {
    // A setup script exists to do per-repository work, and `gt rig add` does that work by
    // cloning the repository again on its own. The clone step's helper was wired with `-c`
    // for one invocation only, so git run from phase 4 had the tokens in its environment and
    // no way to use them — and died on a username prompt with no TTY.
    const plan = resolveInstallPlan(
      base({
        pack: { id: 'p', tools: ['gas-town'], requiresRdp: false },
        tools: [tool({ id: 'gas-town', runAs: 'rocky', setupScript: 'gt rig add x "$REPOS"\n' })],
        repositories: ['https://github.com/example/private.git'],
      }),
    )
    const setup = plan.steps.find((s) => s.id === 'tool-setup:gas-town')!
    expect(setup.run).toContain(SETUP_GIT_AUTH_PREAMBLE)
    // The clone step's own guard, verbatim: a box with no tokens gets anonymous git, and the
    // two steps can never disagree about when a helper is offered.
    expect(setup.run).toContain('if [ -n "${GITHUB_TOKEN:-}" ] || [ "${ROCKYSURF_GITHUB_TOKEN_COUNT:-0}" -gt 0 ]; then')
    // The environment form of `-c`, which reaches every git in the step's process tree — the
    // ones a tool starts included — not only the ones the script names.
    expect(setup.run).toContain('export GIT_CONFIG_COUNT=2')
    expect(setup.run).toContain('GIT_CONFIG_KEY_0=credential.useHttpPath GIT_CONFIG_VALUE_0=true')
    expect(setup.run).toContain(`GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1='${GIT_CREDENTIAL_HELPER}'`)
    // And the stable failure wording for the case that remains: no token for this repository.
    expect(setup.run).toContain('export GIT_TERMINAL_PROMPT=0')
    // Custody: the token is read by the helper at run time — never in argv, never persisted.
    expect(setup.run).not.toMatch(/\$GITHUB_TOKEN/)
    expect(setup.run).not.toContain('git config')
    // The preamble comes BEFORE the script, so the script's own `set -u` cannot trip on it and
    // a script that sets its own git configuration still wins.
    expect(setup.run.indexOf(SETUP_GIT_AUTH_PREAMBLE)).toBeLessThan(setup.run.indexOf('gt rig add'))
  })

  it('lets REAL git started by a CHILD process of a setup script authenticate (issue #142)', () => {
    // Text assertions cannot see whether git honours GIT_CONFIG_* from an inherited
    // environment, or whether the multi-line helper survives being an environment value. So:
    // the generated preamble, then a nested bash standing in for `gt`, asking git for
    // credentials the way a clone would. Per-repository selection must still work — that is
    // what `credential.useHttpPath` in the preamble is for.
    const home = mkdtempSync(join(tmpdir(), 'rockysurf-git-'))
    const ask = (url: string, env: Record<string, string>): { status: number | null; password: string | undefined; stderr: string } => {
      const result = spawnSync(
        'bash',
        ['-c', `${SETUP_GIT_AUTH_PREAMBLE}bash -c 'printf "url=%s\\n\\n" "$1" | git credential fill' bash "$1"`, 'bash', url],
        {
          encoding: 'utf8',
          env: {
            PATH: process.env['PATH'] ?? '/usr/bin:/bin',
            HOME: home,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
            ...env,
          },
        },
      )
      return { status: result.status, password: /^password=(.*)$/m.exec(result.stdout)?.[1], stderr: result.stderr }
    }
    const tokens = {
      GITHUB_TOKEN: 'ghp_fallback',
      ROCKYSURF_GITHUB_TOKEN_COUNT: '1',
      ROCKYSURF_GITHUB_TOKEN_1: 'ghp_acme',
      ROCKYSURF_GITHUB_TOKEN_1_SCOPE: 'github.com/acme/*',
    }
    let got = ask('https://github.com/acme/widgets.git', tokens)
    expect(got.status, got.stderr).toBe(0)
    expect(got.password).toBe('ghp_acme')
    got = ask('https://github.com/stranger/thing.git', tokens)
    expect(got.status, got.stderr).toBe(0)
    expect(got.password).toBe('ghp_fallback')

    // No tokens: no helper is wired at all, and with prompts disabled git says so and fails
    // instead of hanging on a username prompt that has no terminal to appear on.
    got = ask('https://github.com/stranger/thing.git', {})
    expect(got.status).not.toBe(0)
    expect(got.password).toBeUndefined()
    expect(got.stderr).toContain('terminal prompts disabled')
  })

  it('clones idempotently, because an interrupted step re-runs from the top', () => {
    const plan = resolveInstallPlan(base({ repositories: ['https://github.com/example/thing.git'] }))
    const clone = plan.steps.find((s) => s.id === 'repo:thing')!
    expect(clone.run).toContain('if [ -d "$dir/.git" ]; then')
    // The clone now carries an optional auth array, so match the command rather than a literal.
    expect(clone.run).toMatch(/git .*clone "\$url" "\$dir"/)
    expect(clone.runAs).toBe('rocky')
  })

  it('authenticates a clone with GITHUB_TOKEN when one is present, and anonymously when not', () => {
    // rockysurf-55fx.14: delivering a token nothing consumes would have left private-repo
    // cloning just as broken, only with a credential now sitting on the box.
    const plan = resolveInstallPlan(base({ repositories: ['https://github.com/example/thing.git'] }))
    const clone = plan.steps.find((s) => s.id === 'repo:thing')!

    expect(clone.run).toContain('if [ -n "${GITHUB_TOKEN:-}" ]')
    expect(clone.run).toContain('credential.helper=')
    // The token is read at run time inside the helper — never an argv value, which `ps` would
    // expose to every unprivileged step this agent runs next.
    expect(clone.run).not.toMatch(/clone .*\$GITHUB_TOKEN/)
    // And never written into the checkout's own config, where it would outlive the box.
    expect(clone.run).not.toMatch(/remote set-url .*GITHUB_TOKEN/)
  })

  it('wires the helper for a scoped token set even with no instance-wide token (ta7g)', () => {
    // A self-hoster who configures only `github.tokens` has no GITHUB_TOKEN at all. Guarding
    // on that variable alone would leave the helper unwired and every private clone anonymous
    // while `secrets.env` sat on the box full of usable tokens.
    const plan = resolveInstallPlan(base({ repositories: ['https://github.com/example/thing.git'] }))
    const clone = plan.steps.find((s) => s.id === 'repo:thing')!
    expect(clone.run).toContain('[ "${ROCKYSURF_GITHUB_TOKEN_COUNT:-0}" -gt 0 ]')
  })

  it('sets credential.useHttpPath, without which per-repo selection cannot work at all', () => {
    // git omits `path=` from the helper's stdin unless this is set, so every request would
    // look like "something on github.com" and only the fallback could ever be chosen. Asserted
    // because nothing else in the system would fail if the line were dropped — the clone would
    // still succeed, using the wrong token.
    const plan = resolveInstallPlan(base({ repositories: ['https://github.com/example/thing.git'] }))
    const clone = plan.steps.find((s) => s.id === 'repo:thing')!
    expect(clone.run).toContain('-c credential.useHttpPath=true')
  })

  it('embeds the helper with no single quote in it, because it lives inside a quoted word', () => {
    // The helper is interpolated into `credential.helper='…'` in the generated bash. One `'`
    // in its body ends that word, and the rest of the program becomes separate arguments to
    // git — a broken clone at best. Cheap to assert, invisible until it breaks.
    expect(GIT_CREDENTIAL_HELPER).not.toContain("'")
    const plan = resolveInstallPlan(base({ repositories: ['https://github.com/example/thing.git'] }))
    expect(plan.steps.find((s) => s.id === 'repo:thing')!.run).toContain(
      `credential.helper='${GIT_CREDENTIAL_HELPER}'`,
    )
  })

  it('lets REAL git select per repository, running the generated script (ta7g)', () => {
    // The one test in this file that runs git. Everything above asserts on the TEXT of the
    // clone step, and text assertions cannot see the two things most likely to break here:
    // whether git accepts a multi-line `-c credential.helper` value at all, and whether it
    // hands the helper a `path=` to match on. Dropping `credential.useHttpPath` breaks neither
    // the clone nor any string assertion — it just silently makes every repository resolve to
    // the instance-wide token. This fails when that happens.
    const plan = resolveInstallPlan(base({ repositories: ['https://github.com/example/thing.git'] }))
    const clone = plan.steps.find((s) => s.id === 'repo:thing')!

    // The real script, up to the point where it would start cloning — its `git_auth` array is
    // built by the code under test, quoting and all, and then used verbatim.
    const setup = clone.run.split('\nif [ -d ')[0]!
    const home = mkdtempSync(join(tmpdir(), 'rockysurf-git-'))
    const ask = (url: string): string | undefined => {
      const result = spawnSync(
        'bash',
        ['-c', `${setup}\nprintf 'url=%s\\n\\n' "$1" | git "\${git_auth[@]}" credential fill`, 'bash', url],
        {
          encoding: 'utf8',
          env: {
            PATH: process.env['PATH'] ?? '/usr/bin:/bin',
            HOME: home,
            // No developer's own gitconfig, and no osxkeychain: the only credential helper in
            // play must be the one this file generates.
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
            GITHUB_TOKEN: 'ghp_fallback',
            ROCKYSURF_GITHUB_TOKEN_COUNT: '2',
            ROCKYSURF_GITHUB_TOKEN_1: 'ghp_acme',
            ROCKYSURF_GITHUB_TOKEN_1_SCOPE: 'github.com/acme/*',
            ROCKYSURF_GITHUB_TOKEN_2: 'ghp_widgets',
            ROCKYSURF_GITHUB_TOKEN_2_SCOPE: 'github.com/acme/widgets',
          },
        },
      )
      expect(result.status, result.stderr).toBe(0)
      return /^password=(.*)$/m.exec(result.stdout)?.[1]
    }

    expect(ask('https://github.com/acme/widgets.git')).toBe('ghp_widgets')
    expect(ask('https://github.com/acme/other.git')).toBe('ghp_acme')
    expect(ask('https://github.com/stranger/thing.git')).toBe('ghp_fallback')
  })

  it('quotes a repository url that tries to escape the script', () => {
    const nasty = "https://example.com/x'; rm -rf /; echo '.git"
    const plan = resolveInstallPlan(base({ repositories: [nasty] }))
    const clone = plan.steps.find((s) => s.id.startsWith('repo:'))!
    // Single-quoted with embedded quotes escaped: the payload is data, not another command.
    expect(clone.run).toContain(`url='https://example.com/x'\\''; rm -rf /; echo '\\''.git'`)
    expect(clone.run).not.toMatch(/^rm -rf/m)
  })

  it('never puts the rdp password in argv', () => {
    const plan = resolveInstallPlan(base({ pack: { id: 'p', tools: [], requiresRdp: true } }))
    const rdp = plan.steps.find((s) => s.id === 'rdp')!
    // Everything in argv is readable through `ps` by the unprivileged steps this same agent
    // runs, so the password goes to chpasswd on stdin and comes from the environment.
    expect(rdp.run).toContain('| chpasswd')
    expect(rdp.run).toContain('"$RDP_PASSWORD"')
    expect(rdp.run).not.toMatch(/chpasswd\s+\S/)
    expect(rdp.runAs).toBe('root')
  })

  it('marks repository clones optional — a repo that does not clone is a warning, not a failed box (ADR-0010)', () => {
    const plan = resolveInstallPlan(base({ repositories: ['https://github.com/example/thing.git'] }))
    expect(plan.steps.find((s) => s.id === 'repo:thing')?.optional).toBe(true)
  })

  it('marks branding optional — a plain MOTD is not a failed bootstrap', () => {
    expect(resolveInstallPlan(base()).steps.find((s) => s.id === 'branding')?.optional).toBe(true)
  })

  it.each([
    ['https://github.com/a/b.git', 'b'],
    ['https://github.com/a/b', 'b'],
    ['https://github.com/a/b/', 'b'],
    ['git@github.com:a/b.git', 'b'],
  ])('derives the clone directory %s → %s', (url, expected) => {
    expect(repoDirName(url)).toBe(expected)
  })
})

describe('the plan document', () => {
  it('validates against the frozen schema', () => {
    expect(installPlanSchema.safeParse(resolveInstallPlan(base())).success).toBe(true)
  })

  it('renders identically for identical inputs', () => {
    // The conformance requirement: a snapshot that re-renders differently makes resume skip
    // the wrong work.
    const input = base({
      pack: { id: 'p', tools: ['claude-code', 'node'], requiresRdp: true },
      tools: [tool({ id: 'node', installOrder: 20 }), tool({ id: 'claude-code', installOrder: 40, runAs: 'rocky' })],
      repositories: ['https://github.com/example/thing.git'],
    })
    expect(serializeInstallPlan(resolveInstallPlan(input))).toBe(serializeInstallPlan(resolveInstallPlan(input)))
  })

  it('round-trips through serialize and parse', () => {
    const plan = resolveInstallPlan(base())
    expect(parseInstallPlan(serializeInstallPlan(plan))).toEqual(plan)
  })

  it('rejects a version other than 1', () => {
    expect(() => parseInstallPlan({ ...resolveInstallPlan(base()), version: 2 })).toThrow()
  })

  it('rejects duplicate step ids, which are the journal keys', () => {
    const plan = resolveInstallPlan(base())
    const dupe = { ...plan, steps: [...plan.steps, plan.steps[0]!] }
    expect(installPlanSchema.safeParse(dupe).success).toBe(false)
  })

  it('requires a callbackUrl in callback mode and allows its absence in push', () => {
    expect(installPlanSchema.safeParse(resolveInstallPlan(base({ mode: 'callback' }))).success).toBe(false)
    const withUrl = resolveInstallPlan(base({ mode: 'callback', callbackUrl: 'https://core.example/x' }))
    expect(installPlanSchema.safeParse(withUrl).success).toBe(true)
  })

  it('rejects a step id that is not namespaced', () => {
    const plan = resolveInstallPlan(base())
    const bad = { ...plan, steps: [{ ...plan.steps[0]!, id: 'claude-code' }] }
    expect(installPlanSchema.safeParse(bad).success).toBe(false)
  })
})

describe('snapshotting onto the server row', () => {
  it('survives the round trip through the database unchanged', () => {
    const opened = openTestDatabase()
    try {
      const user = upsertUserByGithubId(opened.db, { githubId: 'gh:1', githubUsername: 'someone' })
      const server = insertServer(opened.db, {
        userId: user.id,
        name: 'dev-box',
        provider: 'fake',
        offeringId: 'small',
        arch: 'arm64',
        size: 'small',
        region: 'x',
        idempotencyKey: 'k1',
      })

      const plan = resolveInstallPlan(base({ serverId: server.id }))
      setInstallPlan(opened.db, server.id, plan)

      const stored = getServer(opened.db, server.id)!.installPlan
      expect(parseInstallPlan(stored)).toEqual(plan)

      // The snapshot is what a re-push executes: rendering again from changed pack data must
      // not silently replace it.
      const drifted = resolveInstallPlan(base({ serverId: server.id, branding: false }))
      expect(parseInstallPlan(getServer(opened.db, server.id)!.installPlan)).not.toEqual(drifted)
    } finally {
      opened.close()
    }
  })
})

/**
 * The no-matching-token clone failure becomes a human sentence (rockysurf-ldo1).
 *
 * These tests run the WHOLE generated clone script under bash against a local forge that models
 * GitHub's real behaviour — a private repository answers 401 to an unauthenticated request, and
 * that 401 is what used to surface as `could not read Username for …: No such device or
 * address`, which the owner could diagnose only because they built the feature. The claim under
 * test has two halves and both matter:
 *
 *  1. when git failed auth-shaped AND no delivered token matched the URL, the LAST non-empty
 *     line the step prints is the honest sentence — last because `mark_failed` journals the log
 *     tail and the supervisor's `lastLineOf` takes the final non-empty line as the row's
 *     `errorMessage`;
 *  2. every OTHER clone failure — a token that matched and was rejected, a repository that is
 *     not there, a host that is not answering — keeps git's own last line, because translating
 *     those into "no token matched" would be a new lie replacing the old one.
 *
 * ASYNC SPAWN, DELIBERATELY: `spawnSync` would block the event loop the forge answers from,
 * and git would sit waiting on a response this same process can never send.
 */
describe('translating the no-matching-token clone failure (rockysurf-ldo1)', () => {
  const RIGHT_TOKEN = 'ghp_right'
  let forge: HttpServer
  let forgePort: number

  beforeAll(async () => {
    forge = createServer((req, res) => {
      // A repository that genuinely does not exist, on a forge that says so honestly.
      if (req.url?.startsWith('/gone/')) return void res.writeHead(404).end('not here')
      // Everything else is a PRIVATE repository: 401 without the right credential — to the
      // anonymous request AND to a wrong token, exactly as github.com answers both.
      const authorized =
        req.headers.authorization ===
        `Basic ${Buffer.from(`x-access-token:${RIGHT_TOKEN}`).toString('base64')}`
      if (!authorized) return void res.writeHead(401, { 'WWW-Authenticate': 'Basic realm=forge' }).end()
      // Authorized. Not a real git server, so the clone still fails — but not auth-shaped.
      res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => forge.listen(0, '127.0.0.1', resolve))
    forgePort = (forge.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      forge.closeAllConnections?.()
      forge.close(() => resolve())
    })
  })

  const repoUrl = (path: string) => `http://127.0.0.1:${forgePort}/${path}`

  /** The rendered clone step for one repository — the exact text a box would execute. */
  const cloneStepFor = (url: string): string => {
    const plan = resolveInstallPlan(base({ repositories: [url] }))
    return plan.steps.find((s) => s.id.startsWith('repo:'))!.run
  }

  /**
   * Run the generated script the way `agent.sh` does — `bash -c`, output merged — in a hermetic
   * environment: no developer gitconfig, no osxkeychain, only the variables `secrets.env` would
   * have delivered. Returns what the step log would hold, split the way `lastLineOf` reads it.
   */
  const runCloneScript = (
    url: string,
    env: Record<string, string>,
  ): Promise<{ status: number; lastLine: string; transcript: string }> =>
    new Promise((resolve) => {
      const home = mkdtempSync(join(tmpdir(), 'rockysurf-ldo1-'))
      execFile(
        'bash',
        ['-c', cloneStepFor(url)],
        {
          encoding: 'utf8',
          timeout: 60_000,
          env: {
            PATH: process.env['PATH'] ?? '/usr/bin:/bin',
            HOME: home,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
            ...env,
          },
        },
        (error, stdout, stderr) => {
          const transcript = `${stdout}${stderr}`
          const lines = stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
          resolve({
            status: error ? ((error as { code?: number }).code ?? 1) : 0,
            lastLine: lines.at(-1) ?? '',
            transcript,
          })
        },
      )
    })

  it('prints the honest sentence LAST when the delivered tokens cover other scopes', async () => {
    // The owner's live failure, post-narrowing: scoped tokens exist, none covers this URL, no
    // fallback. The helper offers nothing, git gets a 401, and the old last line was git's
    // baffling username error.
    const { status, lastLine } = await runCloneScript(repoUrl('acme/private-thing'), {
      ROCKYSURF_GITHUB_TOKEN_COUNT: '1',
      ROCKYSURF_GITHUB_TOKEN_1: 'ghp_other',
      ROCKYSURF_GITHUB_TOKEN_1_SCOPE: `127.0.0.1:${forgePort}/someone-else/*`,
    })

    expect(status).not.toBe(0)
    expect(lastLine.startsWith(NO_MATCHING_TOKEN_PREFIX)).toBe(true)
    // Names the repository and what the box actually carries — scope identities, never values.
    expect(lastLine).toContain(`127.0.0.1:${forgePort}/acme/private-thing`)
    expect(lastLine).toContain(`127.0.0.1:${forgePort}/someone-else/*`)
    // `lastLineOf` truncates at 200 characters; a sentence that overflows arrives maimed.
    expect(lastLine.length).toBeLessThanOrEqual(200)
  })

  it('says the box carries no tokens at all when none were delivered', async () => {
    const { status, lastLine } = await runCloneScript(repoUrl('acme/private-thing'), {})

    expect(status).not.toBe(0)
    expect(lastLine.startsWith(NO_MATCHING_TOKEN_PREFIX)).toBe(true)
    expect(lastLine).toContain('no GitHub tokens')
  })

  it('never prints a token value while diagnosing — the custody hazard, pinned', async () => {
    // The obvious implementation asks the helper and lets `password=<PAT>` hit stdout, whose
    // tail becomes the row's errorMessage and is broadcast to the SPA. This asserts the whole
    // transcript — everything the step log would hold — is clean of the secret.
    const { transcript } = await runCloneScript(repoUrl('acme/private-thing'), {
      ROCKYSURF_GITHUB_TOKEN_COUNT: '1',
      ROCKYSURF_GITHUB_TOKEN_1: 'ghp_must_never_surface',
      ROCKYSURF_GITHUB_TOKEN_1_SCOPE: `127.0.0.1:${forgePort}/someone-else/*`,
    })

    expect(transcript).not.toContain('ghp_must_never_surface')
  })

  it('does NOT translate a token that matched and was rejected — that is revocation', async () => {
    // A token WAS offered; the forge refused it. Saying "no token matched" here would be
    // false, and would send the user to add a token they already have.
    const { status, lastLine, transcript } = await runCloneScript(repoUrl('acme/private-thing'), {
      ROCKYSURF_GITHUB_TOKEN_COUNT: '1',
      ROCKYSURF_GITHUB_TOKEN_1: 'ghp_revoked',
      ROCKYSURF_GITHUB_TOKEN_1_SCOPE: `127.0.0.1:${forgePort}/acme/*`,
    })

    expect(status).not.toBe(0)
    expect(lastLine).toContain('Authentication failed')
    expect(transcript).not.toContain(NO_MATCHING_TOKEN_PREFIX)
  })

  it('does NOT translate a repository that is simply not there', async () => {
    const { status, lastLine, transcript } = await runCloneScript(repoUrl('gone/repo'), {})

    expect(status).not.toBe(0)
    expect(lastLine).toContain('not found')
    expect(transcript).not.toContain(NO_MATCHING_TOKEN_PREFIX)
  })

  it('does NOT translate a host that is not answering', async () => {
    // A port this suite just proved nothing is listening on: bind, read, release.
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const deadPort = (probe.address() as AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    const { status, transcript } = await runCloneScript(`http://127.0.0.1:${deadPort}/a/b`, {})

    expect(status).not.toBe(0)
    expect(transcript).not.toContain(NO_MATCHING_TOKEN_PREFIX)
  })

  it('still clones and re-fetches a URL that needs no credential, exiting 0', async () => {
    // The refactor wrapped the git calls to survive `set -e` long enough to diagnose them; the
    // happy path and the resume path must be exactly as boring as before.
    const src = mkdtempSync(join(tmpdir(), 'rockysurf-ldo1-src-'))
    const init = spawnSync(
      'bash',
      ['-c', 'git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m x'],
      { cwd: src, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: src } },
    )
    expect(init.status, init.stderr).toBe(0)

    const url = `file://${src}`
    const home = mkdtempSync(join(tmpdir(), 'rockysurf-ldo1-dst-'))
    const runTwice = (): Promise<number> =>
      new Promise((resolve) => {
        execFile(
          'bash',
          ['-c', cloneStepFor(url)],
          {
            encoding: 'utf8',
            timeout: 60_000,
            env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
          },
          (error) => resolve(error ? ((error as { code?: number }).code ?? 1) : 0),
        )
      })

    expect(await runTwice()).toBe(0) // the clone
    expect(await runTwice()).toBe(0) // the resume, through the fetch branch
  })
})
