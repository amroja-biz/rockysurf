import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_SCRIPT_PATH,
  lintPacksDir,
  loadPacksFromDir,
  resolveInstallPlan,
  SHELL_ENVIRONMENT_FILE,
  type LoadedPack,
  type LoadedTool,
  type ToolRow,
} from '@rockysurf/core'

/**
 * The pack smoke harness, as a library any directory of packs can be pointed at.
 *
 * It was `scripts/pack-smoke.mjs` (rockysurf-ftl9.5) and the behaviour is unchanged — what
 * changed is who can run it. The old script hardcoded `<repoRoot>/packs` and deep-imported
 * `packages/core/dist/**`, so it could only ever certify THIS repository's packs. The registry
 * (rockysurf-arym) needs `amroja-biz/rockysurf-shop` to gate a community pull request with the
 * same harness, from the published package, and a gate that is a fork of the real one is not a
 * gate. So the logic moved here, `scripts/pack-smoke.mjs` became a thin caller, and
 * `rockysurf pack check` is the other caller.
 *
 * It lives in the composition root rather than in core because it drives Docker and is
 * tooling, not control plane. It uses core's own loader, core's own resolver and core's own
 * `agent.sh`: a harness that resolves its own plan or runs its own agent is testing itself.
 *
 * FOR ONE PACK, ON ONE ARCHITECTURE, IT:
 *
 *   1. starts a stock `ubuntu:24.04` container for that architecture — no convenience
 *      packages, empty apt lists, no sudo;
 *   2. creates the unprivileged `rocky` user and nothing else;
 *   3. resolves the pack into a real InstallPlan and runs it with the real agent;
 *   4. DELETES `/var/lib/rockysurf/state.json` and runs the whole plan again in the SAME
 *      container.
 *
 * STEP 4 IS THE ENTIRE TEST, and deleting the journal is what makes it one. The agent is
 * contracted to read that journal and skip every step already marked `done` — that is how an
 * interrupted install resumes. So a harness that merely re-invokes the agent gets the
 * contracted behaviour: a green run, in seconds, in which not one script body executed a
 * second time. The journal exists to PREVENT re-execution; a test of re-execution has to take
 * it away first. Both sides of the contract say so — `docs/writing-a-pack.md` § "The CI smoke
 * test", and `docs/bootstrap-contract.md` § "Step idempotency".
 *
 * The second run must exit 0, and `/home/rocky/.bashrc`, `/root/.bashrc` and
 * `/etc/apt/sources.list.d/` must be byte-identical across it. That is the check that catches
 * the duplicated `PATH` line, which is the single most common way a pack breaks a resumed
 * install.
 *
 * WHY THERE IS A `sudo` SHIM. The spec requires `sudo` to be absent, because rule 4
 * ("runAs-honest") is only enforced if a `runAs: rocky` script that reaches for root actually
 * fails. But the agent itself drops privilege with `sudo -u <user> -H env …`, so exactly one
 * caller needs it. `/usr/local/bin/sudo` here answers that one invocation with `runuser` — the
 * privilege drop the spec asks the harness to perform — and refuses every other form with a
 * message naming the rule. A pack script that calls `sudo apt-get install` fails, as it must,
 * and would fail the same way on a real box where `rocky` is not in `sudoers`.
 *
 * NOT A SUBSTITUTE FOR `scripts/agent-smoke.sh`. That one tests the AGENT (resume, kill
 * semantics, required-vs-optional failure). This one tests the PACKS, and uses the agent as
 * the executor because the pack contract is written against what the agent does.
 */

const IMAGE = 'ubuntu:24.04'
/** Only used by the `rdp` step, which the plan includes for any pack with `requiresRdp`. */
const RDP_PASSWORD = 'pack-smoke-not-a-real-password'
/**
 * One pack input and one Environment line, fed through the real delivery path — `secrets.env`
 * on the box, their NAMES in the plan — so the harness can prove they reach `rocky`'s shell
 * after setup (issue #244). Stand-ins rather than the pack's own declared inputs, because a
 * value the harness invents for a real input (an API key, say) would change what the pack's
 * scripts do, and this test is about delivery, not about the pack. The values carry the
 * characters the quoting has to survive.
 */
const SHELL_ENVIRONMENT_PROBE = {
  packInput: { name: 'PACK_SMOKE_INPUT', value: "from the pack's inputs: $(not run) `nor this`" },
  environment: { name: 'PACK_SMOKE_ENVIRONMENT', value: 'from the Environment field, with "quotes" and \\ a backslash' },
} as const
/**
 * `env` arguments that strip what a transient root systemd unit never has. Exported so a test
 * can assert the harness keeps launching the agent this way — see `runAgent` below.
 */
export const AGENT_ENV_UNSET = ['-u', 'HOME', '-u', 'USER', '-u', 'LOGNAME'] as const

export const ARCHITECTURES = ['amd64', 'arm64'] as const
export type Arch = (typeof ARCHITECTURES)[number]

export interface PackCheckOptions {
  /** The directory of packs under test. */
  dir: string
  /**
   * Directories whose tools may be referenced but which are not themselves under test — the
   * shared base toolchain a community pack is expected to reference rather than redefine.
   * Their tools are loaded into the plan; their packs are not run.
   */
  basePacksDirs?: string[]
  arch: Arch
  /** Check only this pack id. Absent means every pack in `dir`. */
  only?: string
  /** Leave the container and the scratch directory behind for inspection. */
  keep?: boolean
  /** Human-readable progress. Silent when omitted, which is what `--json` wants. */
  log?: (line: string) => void
  /** Where a failure dump goes. Always called, even under `--json`, because it must be seen. */
  logFailure?: (text: string) => void
}

export interface PackCheckResult {
  pack: string
  arch: Arch
  steps?: number
  run1Seconds?: number
  run2Seconds?: number
  checks: Array<{ ok: boolean; what: string; detail: string }>
  failureLogs?: string[]
}

export interface PackCheckReport {
  ok: boolean
  arch: Arch
  results: PackCheckResult[]
}

/** Everything that stops the check being RUN at all, as distinct from a pack failing it. */
export class PackCheckSetupError extends Error {}

/* ------------------------------------------------------------------------------ docker */

function docker(argv: string[], { allowFailure = false }: { allowFailure?: boolean } = {}) {
  const run = spawnSync('docker', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (run.error) throw new Error(`docker ${argv[0]} could not run: ${run.error.message}`)
  if (run.status !== 0 && !allowFailure) {
    throw new Error(`docker ${argv.slice(0, 3).join(' ')} failed (${run.status})\n${run.stderr ?? ''}`)
  }
  return run
}

/** Run a command in the container as root; returns { status, stdout }. */
const exec = (name: string, script: string) => docker(['exec', name, 'bash', '-lc', script], { allowFailure: true })

/** Single-quote for the shell — the same total escape core's `shellQuote` applies to `secrets.env`. */
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/**
 * The privilege drop the spec asks for, and the reason `sudo` is otherwise absent. See the
 * header. `-H`'s job is `HOME`, which several pack scripts write into, so the shim sets it
 * explicitly — `runuser -u` would leave root's.
 */
const SUDO_SHIM = `#!/bin/bash
# Installed by the rockysurf pack smoke harness. NOT a general-purpose sudo.
set -u
if [ "\${1:-}" = '-u' ] && [ "\${3:-}" = '-H' ] && [ "\${4:-}" = 'env' ]; then
  user="\$2"; shift 4
  home=\$(getent passwd "\$user" | cut -d: -f6)
  exec runuser -u "\$user" -- env "HOME=\$home" "USER=\$user" "LOGNAME=\$user" "\$@"
fi
echo "sudo: not available to install scripts on a Rocky Surf box." >&2
echo "  A 'runAs: rocky' script must not need root. See docs/writing-a-pack.md rule 4." >&2
echo "  (called as: sudo \$*)" >&2
exit 127
`

/**
 * The files the spec requires to be byte-identical across the second run, hashed inside the
 * container. `sources.list.d` is hashed per file with names included, so a pack that ADDS a
 * source list on the second run is caught as surely as one that appends to an existing one.
 * The last three are the shell-environment step's own (issue #244): the values file and its
 * two hooks are regenerated whole on every run, and this is where that is proven.
 */
const SNAPSHOT = `
  for f in /home/rocky/.bashrc /root/.bashrc /etc/bash.bashrc /etc/profile.d/rockysurf-environment.sh /home/rocky/${SHELL_ENVIRONMENT_FILE}; do
    if [ -f "$f" ]; then sha256sum "$f"; else echo "absent  $f"; fi
  done
  if [ -d /etc/apt/sources.list.d ]; then
    find /etc/apt/sources.list.d -type f | sort | xargs -r sha256sum
  fi
`

/**
 * Every way a person reaches the box, reproduced inside the container as `rocky` (issue #244):
 *
 *   - `login`: an interactive SSH login and a tmux pane — bash reads `/etc/profile`;
 *   - `sshcmd`: `ssh box 'command'` — bash started by sshd with a command reads
 *     `/etc/bash.bashrc` and `~/.bashrc` and NO profile. Debian's bash decides "started by
 *     sshd" from `SSH_CLIENT` in the environment, and only for a top-level shell, so `SHLVL`
 *     is unset the way it is under sshd; with it inherited from `docker exec`'s shell, the
 *     bashrc path is skipped and this check would pass for the wrong reason;
 *   - `desktop`: the xrdp session — `startwm.sh` is `sh`, and sources `/etc/profile`.
 *
 * Each prints the two probe names and, as a negative, the desktop password's — which is Rocky
 * Surf's own and must NOT be in the shell.
 */
const SHELL_PROBE = `printenv ${SHELL_ENVIRONMENT_PROBE.packInput.name}; printenv ${SHELL_ENVIRONMENT_PROBE.environment.name}; printenv RDP_PASSWORD || true`
const SHELL_WAYS_IN: Record<string, string> = {
  login: `runuser -u rocky -- env -u SHLVL bash -lc '${SHELL_PROBE}'`,
  sshcmd: `runuser -u rocky -- env -u SHLVL SSH_CLIENT='203.0.113.1 51000 22' bash -c '${SHELL_PROBE}'`,
  desktop: `runuser -u rocky -- env -u SHLVL sh -c '. /etc/profile; ${SHELL_PROBE}'`,
}

/* ---------------------------------------------------------------------- loading packs */

/** The loader speaks the file format; the resolver speaks the database's. One mapping. */
const toToolRow = (t: LoadedTool): ToolRow =>
  ({
    id: t.toolId,
    name: t.name,
    description: t.description,
    category: t.category,
    url: t.url,
    installScript: t.installScript,
    setupScript: t.setupScript ?? null,
    enabled: t.enabled,
    installOrder: t.installOrder,
    bootstrap: t.bootstrap,
    runAs: t.runAs,
    sourceFile: t.sourceFile,
  }) as ToolRow

interface Resolved {
  packs: LoadedPack[]
  tools: ToolRow[]
}

/**
 * Load the directory under test, plus any base directories it references.
 *
 * Refuses to smoke-test a directory that does not lint, and says so with the findings rather
 * than with a container failure twenty minutes later — the fast check has to come first or it
 * is not worth having. Base packs contribute TOOLS to the plan but never appear as packs to
 * run: a shop CI job checking one community pack must not also spend ten minutes re-running
 * the six official ones.
 */
function resolvePacks(options: PackCheckOptions): Resolved {
  const report = lintPacksDir({
    dir: options.dir,
    ...(options.basePacksDirs ? { basePacksDirs: options.basePacksDirs } : {}),
  })
  if (report.findings.length > 0) {
    throw new PackCheckSetupError(
      `${options.dir} does not validate — fix that before smoke-testing it:\n` +
        report.findings.map((f) => `  ${f.file}: [${f.rule}] ${f.message}`).join('\n'),
    )
  }

  const tools = new Map<string, ToolRow>()
  for (const baseDir of options.basePacksDirs ?? []) {
    for (const tool of loadPacksFromDir(baseDir).tools.values()) {
      if (!tools.has(tool.toolId)) tools.set(tool.toolId, toToolRow(tool))
    }
  }
  const loaded = loadPacksFromDir(options.dir)
  for (const tool of loaded.tools.values()) tools.set(tool.toolId, toToolRow(tool))

  const packs = loaded.packs.filter((p) => !options.only || p.packId === options.only)
  if (packs.length === 0) {
    throw new PackCheckSetupError(
      options.only ? `no pack called "${options.only}" in ${options.dir}` : `no packs found in ${options.dir}`,
    )
  }
  return { packs, tools: [...tools.values()] }
}

/* --------------------------------------------------------------------------- the run */

export function runPackCheck(options: PackCheckOptions): PackCheckReport {
  const log = options.log ?? (() => {})
  const logFailure = options.logFailure ?? log
  const { packs, tools } = resolvePacks(options)

  const results: PackCheckResult[] = []
  let failures = 0

  for (const pack of packs) {
    const name = `rockysurf-pack-smoke-${pack.packId}-${options.arch}-${Date.now().toString(36)}`
    const work = mkdtempSync(join(tmpdir(), 'rockysurf-pack-smoke-'))
    const checks: PackCheckResult['checks'] = []
    const dumps: string[] = []
    const record = (ok: boolean, what: string, detail = '') => {
      checks.push({ ok, what, detail })
      if (!ok) failures++
      log(`  ${ok ? '[32mok[0m  ' : '[31mFAIL[0m'} ${what}${detail ? ` — ${detail}` : ''}`)
    }

    log(`\n==> ${pack.packId} on linux/${options.arch} (${IMAGE})`)

    const plan = resolveInstallPlan({
      serverId: `srv-smoke-${pack.packId}`,
      runId: 'run-1',
      mode: 'push',
      pack: {
        id: pack.packId,
        tools: pack.tools,
        requiresRdp: pack.requiresRdp,
        ...(pack.desktop ? { desktop: pack.desktop } : {}),
      },
      tools,
      // No repository clones: which repositories to clone is the user's choice at create time,
      // not a property of the pack, and a clone step would put this test on the network for a
      // reason that has nothing to do with the pack's scripts.
      repositories: [],
      // The two probe NAMES, exactly as `snapshotInstallPlan` would hand them over (#244).
      shellEnvironment: {
        packInputs: [SHELL_ENVIRONMENT_PROBE.packInput.name],
        environment: [SHELL_ENVIRONMENT_PROBE.environment.name],
      },
    })
    writeFileSync(join(work, 'plan.json'), JSON.stringify(plan, null, 2))
    writeFileSync(join(work, 'sudo'), SUDO_SHIM)
    // Single-quoted, the way `renderSecretsEnv` writes the real file (issue #189).
    writeFileSync(
      join(work, 'secrets.env'),
      [
        `RDP_PASSWORD=${quote(RDP_PASSWORD)}`,
        `${SHELL_ENVIRONMENT_PROBE.packInput.name}=${quote(SHELL_ENVIRONMENT_PROBE.packInput.value)}`,
        `${SHELL_ENVIRONMENT_PROBE.environment.name}=${quote(SHELL_ENVIRONMENT_PROBE.environment.value)}`,
        '',
      ].join('\n'),
    )
    log(`    plan: ${plan.steps.length} step(s)`)

    try {
      docker(['pull', '--quiet', '--platform', `linux/${options.arch}`, IMAGE])
      docker(['run', '-d', '--name', name, '--platform', `linux/${options.arch}`, IMAGE, 'sleep', 'infinity'])

      // The whole of the box's preparation. Anything a pack needs beyond this, the pack installs.
      const prepared = exec(
        name,
        [
          'set -euo pipefail',
          'useradd -m -s /bin/bash rocky',
          'command -v runuser >/dev/null || { echo "runuser missing from the image" >&2; exit 1; }',
          '! command -v sudo >/dev/null || { echo "the base image already has sudo — rule 4 is unenforceable here" >&2; exit 1; }',
          'mkdir -p /var/lib/rockysurf',
        ].join('\n'),
      )
      record(prepared.status === 0, 'stock container prepared (rocky user, no sudo)', prepared.stderr?.trim() ?? '')
      if (prepared.status !== 0) throw new Error('container preparation failed')

      docker(['cp', join(work, 'plan.json'), `${name}:/var/lib/rockysurf/plan.json`])
      docker(['cp', join(work, 'secrets.env'), `${name}:/var/lib/rockysurf/secrets.env`])
      docker(['cp', AGENT_SCRIPT_PATH, `${name}:/agent.sh`])
      docker(['cp', join(work, 'sudo'), `${name}:/usr/local/bin/sudo`])
      exec(name, 'chmod 0755 /usr/local/bin/sudo && chmod 0600 /var/lib/rockysurf/secrets.env')

      /**
       * The agent is started the way the transient systemd unit starts it on a real box: with
       * NO `HOME`, `USER` or `LOGNAME` in its environment. systemd sets those only for units
       * with `User=`, and `rockysurf-bootstrap` runs as root without one. `docker exec` fills
       * all three in by default, which is how a root step that read `$HOME` under `set -u`
       * passed here on every architecture and died on Hetzner (issue #158). The agent is
       * contracted to establish them itself; this is where that contract gets exercised.
       */
      const runAgent = (label: string) => {
        const started = Date.now()
        const out = docker(['exec', name, 'env', ...AGENT_ENV_UNSET, 'bash', '/agent.sh'], { allowFailure: true })
        const seconds = Math.round((Date.now() - started) / 1000)
        const text = `${out.stdout ?? ''}${out.stderr ?? ''}`
        writeFileSync(join(work, `${label}.log`), text)
        return { status: out.status, seconds, text }
      }
      const journal = (): { status: string; failedStep?: string; steps: Array<{ id: string; status: string }> } => {
        const out = exec(name, 'cat /var/lib/rockysurf/state.json')
        if (out.status !== 0) throw new Error('/var/lib/rockysurf/state.json is missing')
        try {
          return JSON.parse(out.stdout)
        } catch {
          throw new Error('/var/lib/rockysurf/state.json is not JSON')
        }
      }
      const snapshot = () => exec(name, SNAPSHOT).stdout

      /**
       * WHY THIS EXISTS. Without it the harness's output says only WHICH step died, and for
       * the architectures nobody has on their desk CI is the only machine that runs them at
       * all — so a step that fails there and nowhere else cannot be diagnosed from the run
       * page, only guessed at. That is how rockysurf-pcma sat undiagnosable. The agent already
       * keeps a per-step log at /var/lib/rockysurf/steps/<id>.log; this reads it out of the
       * container while the container still exists (the `finally` below removes it) and prints
       * it, delimited, into the run's own output. The agent's surrounding lines follow because
       * they carry the framing the step log cannot: which step, run as whom, and the exit code.
       */
      const dumpFailure = (label: string, run: { text: string }, state: { failedStep?: string }) => {
        const step = state.failedStep ?? null
        const stepLog = step === null ? null : exec(name, `tail -n 80 '/var/lib/rockysurf/steps/${step}.log' 2>&1`)
        const stepText = stepLog?.status === 0 ? (stepLog.stdout ?? '').trimEnd() : ''
        const haveStep = stepText.length > 0
        const agentText = (run.text ?? '')
          .trimEnd()
          .split('\n')
          .slice(haveStep ? -20 : -80)
          .join('\n')

        const lines = [
          '',
          `┌─ ${pack.packId} on linux/${options.arch} — ${label} failed. The failing step's log follows.`,
          step === null
            ? '│  The journal names no failed step: the agent died before or outside the plan.'
            : `│  step: ${step}   log: /var/lib/rockysurf/steps/${step}.log (last 80 lines; the` +
              " agent APPENDS, so run 2's tail still holds run 1's output)",
          '├─────────────────────────────────────────────────────────────────────────────',
          haveStep ? stepText : '│  (no step log — the step produced no output, or never started)',
          "├─ the agent's own output around it ──────────────────────────────────────────",
          agentText,
          '└─────────────────────────────────────────────────────────────────────────────',
          '',
        ]
        dumps.push(lines.join('\n'))
        logFailure(lines.join('\n'))
      }

      /* --- run 1 --------------------------------------------------------------------- */
      const first = runAgent('run1')
      record(first.status === 0, 'run 1: agent exited 0', `${first.seconds}s`)
      let state = journal()
      record(
        state.status === 'done',
        'run 1: plan reached done',
        `status=${state.status}${state.failedStep ? ` failedStep=${state.failedStep}` : ''}`,
      )
      if (first.status !== 0 || state.status !== 'done') dumpFailure('run 1', first, state)
      const notDone = state.steps.filter((s) => s.status !== 'done').map((s) => `${s.id}=${s.status}`)
      record(notDone.length === 0, 'run 1: every step done', notDone.join(', '))
      const before = snapshot()

      /* --- the journal discard ---------------------------------------------------------- */
      // Without this the second run is the resume path, which is contracted to skip everything.
      const removed = exec(name, 'rm -f /var/lib/rockysurf/state.json && test ! -e /var/lib/rockysurf/state.json')
      record(removed.status === 0, 'resume journal discarded', '/var/lib/rockysurf/state.json')

      /* --- run 2, same container -------------------------------------------------------- */
      const second = runAgent('run2')
      record(second.status === 0, 'run 2: agent exited 0', `${second.seconds}s`)
      // Belt and braces, and worth knowing which is which. The load-bearing pair is the discard
      // assertion above plus "every step done" below: with no state.json to read, the agent
      // rebuilds the journal with every step `pending`, and a step can only reach `done` by
      // actually executing — so those two together prove re-execution outright. This log check
      // is the cheaper, more legible signal, and it is the one that names the failure if the
      // discard ever regresses.
      record(
        !second.text.includes('already done, skipping (resume)'),
        'run 2: nothing was skipped as already-done',
        'a skip here means the journal was not discarded and the run is meaningless',
      )
      state = journal()
      record(
        state.status === 'done',
        'run 2: plan reached done',
        `status=${state.status}${state.failedStep ? ` failedStep=${state.failedStep}` : ''}`,
      )
      if (second.status !== 0 || state.status !== 'done') dumpFailure('run 2', second, state)
      const notDone2 = state.steps.filter((s) => s.status !== 'done').map((s) => `${s.id}=${s.status}`)
      record(notDone2.length === 0, 'run 2: every step re-executed to done', notDone2.join(', '))

      /* --- the idempotency evidence ----------------------------------------------------- */
      const after = snapshot()
      if (before === after) {
        record(true, 'run 2 changed nothing: .bashrc x2, sources.list.d and the shell environment byte-identical')
      } else {
        const b = before.split('\n')
        const a = after.split('\n')
        const diff = [...new Set([...b.filter((l) => !a.includes(l)), ...a.filter((l) => !b.includes(l))])]
        record(false, 'run 2 changed nothing: .bashrc x2, sources.list.d and the shell environment byte-identical', diff.join(' | '))
      }

      /* --- the shell environment, every way in (issue #244) ----------------------------- */
      // After the second run, so what is checked is the regenerated file and not the first
      // write of it. Each way in must print the pack input, then the Environment value, then
      // nothing for RDP_PASSWORD — the platform's own name, which stays out of the shell.
      const expected = `${SHELL_ENVIRONMENT_PROBE.packInput.value}\n${SHELL_ENVIRONMENT_PROBE.environment.value}\n`
      for (const [way, command] of Object.entries(SHELL_WAYS_IN)) {
        const out = exec(name, command)
        const got = out.stdout ?? ''
        record(
          out.status === 0 && got === expected,
          `rocky's shell carries the pack input and the Environment value, not RDP_PASSWORD (${way})`,
          out.status === 0 && got === expected ? '' : `got ${JSON.stringify(got)} ${(out.stderr ?? '').trim()}`,
        )
      }
      const mode = exec(name, `stat -c '%U %a' /home/rocky/${SHELL_ENVIRONMENT_FILE}`)
      record(
        mode.status === 0 && mode.stdout.trim() === 'rocky 600',
        'the values file is owned by rocky, mode 0600',
        mode.stdout.trim() || (mode.stderr ?? '').trim(),
      )
      if (pack.requiresRdp) {
        // The desktop pack's own session script has to read `/etc/profile`, as the stock xrdp
        // one does, or the GUI session — unlike a terminal inside it — sees none of this.
        const wm = exec(name, "grep -q '/etc/profile' /etc/xrdp/startwm.sh")
        record(wm.status === 0, "the pack's /etc/xrdp/startwm.sh sources /etc/profile, so the desktop session gets the environment")
      }

      // Not a failure — the spec calls it a warning sign. A second run that re-downloads and
      // re-compiles everything exits 0 and is still a pack that will hurt somebody's resume.
      const ratio = first.seconds > 0 ? second.seconds / first.seconds : 0
      if (ratio > 0.5 && first.seconds > 30) {
        log(
          `  [33mwarn[0m run 2 took ${second.seconds}s against run 1's ${first.seconds}s` +
            ' — a no-op should be much faster',
        )
      }

      results.push({
        pack: pack.packId,
        arch: options.arch,
        steps: plan.steps.length,
        run1Seconds: first.seconds,
        run2Seconds: second.seconds,
        checks,
        ...(dumps.length > 0 ? { failureLogs: dumps } : {}),
      })
    } catch (err) {
      record(false, 'harness completed', err instanceof Error ? err.message : String(err))
      results.push({
        pack: pack.packId,
        arch: options.arch,
        checks,
        ...(dumps.length > 0 ? { failureLogs: dumps } : {}),
      })
    } finally {
      if (options.keep) {
        log(`  (--keep) container ${name}, logs in ${work}`)
      } else {
        docker(['rm', '-f', name], { allowFailure: true })
        rmSync(work, { recursive: true, force: true })
      }
    }
  }

  return { ok: failures === 0, arch: options.arch, results }
}
