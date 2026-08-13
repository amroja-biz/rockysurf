#!/usr/bin/env node
/**
 * The pack smoke test (rockysurf-ftl9.5) — the harness `docs/writing-a-pack.md` § "The CI smoke
 * test" specifies as NORMATIVE and merge-gating.
 *
 *   node scripts/pack-smoke.mjs [--pack <id>] [--arch amd64|arm64] [--keep] [--json]
 *
 * For one pack, on one architecture, it:
 *
 *   1. starts a stock `ubuntu:24.04` container for that architecture — no convenience packages,
 *      empty apt lists, no sudo;
 *   2. creates the unprivileged `rocky` user and nothing else;
 *   3. resolves the pack into a real InstallPlan with core's own resolver and runs it with
 *      core's own bootstrap agent;
 *   4. DELETES `/var/lib/rockysurf/state.json` and runs the whole plan again in the SAME
 *      container.
 *
 * STEP 4 IS THE ENTIRE TEST, and deleting the journal is what makes it one. The agent is
 * contracted to read that journal and skip every step already marked `done` — that is how an
 * interrupted install resumes. So a harness that merely re-invokes the agent gets the
 * contracted behaviour: a green run, in seconds, in which not one script body executed a second
 * time. The journal exists to PREVENT re-execution; a test of re-execution has to take it away
 * first. Both sides of the contract say so — this file's spec, and
 * `docs/bootstrap-contract.md` § "Step idempotency".
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
 * WHEN A STEP FAILS it prints that step's log — `/var/lib/rockysurf/steps/<id>.log`, read out of
 * the container before the container is removed — delimited, into its own output. CI is the only
 * machine most people ever run the amd64 leg on, so a harness that reports which step died and
 * nothing else leaves a real failure undiagnosable. See `dumpFailure` below.
 *
 * NOT A SUBSTITUTE FOR `scripts/agent-smoke.sh`. That one tests the AGENT (resume, kill
 * semantics, required-vs-optional failure). This one tests the PACKS, and uses the agent as the
 * executor because the pack contract is written against what the agent does.
 *
 * Exits 0 when every pack passes, 1 on any failure, 2 when the check could not be run.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const packsDir = join(repoRoot, 'packs')
const agentScript = join(repoRoot, 'packages/core/bootstrap/agent.sh')
const coreDist = join(repoRoot, 'packages/core/dist')

const IMAGE = 'ubuntu:24.04'
/** Only used by the `rdp` step, which the plan includes for any pack with `requiresRdp`. */
const RDP_PASSWORD = 'pack-smoke-not-a-real-password'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}
const ARCH = flag('--arch', process.arch === 'arm64' ? 'arm64' : 'amd64')
const ONLY = flag('--pack', null)
const KEEP = args.includes('--keep')
const JSON_OUT = args.includes('--json')

if (!['amd64', 'arm64'].includes(ARCH)) {
  console.error(`--arch must be amd64 or arm64, got "${ARCH}"`)
  process.exit(2)
}

const log = (...a) => {
  if (!JSON_OUT) console.log(...a)
}

/* ------------------------------------------------------------------ resolving the plan */

if (!existsSync(join(coreDist, 'packs/loader.js'))) {
  console.error(`@rockysurf/core is not built (${coreDist} has no packs/loader.js).\nRun: pnpm -r build`)
  process.exit(2)
}
// Deep imports into the built core rather than its public barrel: the loader and the resolver
// are internals, and this harness is in-repo tooling, not a consumer. Importing the BUILT
// artifact and not the sources is deliberate — the plan under test is the one a release
// renders, so a bug introduced by the build is in scope.
const { loadPacksFromDir } = await import(pathToFileURL(join(coreDist, 'packs/loader.js')).href)
const { resolveInstallPlan } = await import(pathToFileURL(join(coreDist, 'bootstrap/resolver.js')).href)

const loaded = loadPacksFromDir(packsDir)
if (loaded.issues.length > 0) {
  console.error('packs/ does not validate — fix that before smoke-testing it:')
  for (const issue of loaded.issues) console.error(`  ${issue.file}: ${issue.message}`)
  process.exit(2)
}

/** The loader speaks the file format; the resolver speaks the database's. One mapping. */
const toolRows = [...loaded.tools.values()].map((t) => ({
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
}))

const packs = loaded.packs.filter((p) => !ONLY || p.packId === ONLY)
if (packs.length === 0) {
  console.error(ONLY ? `no pack called "${ONLY}" in packs/` : 'no packs found in packs/')
  process.exit(2)
}

/* ---------------------------------------------------------------------------- docker */

function docker(argv, { allowFailure = false, input } = {}) {
  const run = spawnSync('docker', argv, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  })
  if (run.error) throw new Error(`docker ${argv[0]} could not run: ${run.error.message}`)
  if (run.status !== 0 && !allowFailure) {
    throw new Error(`docker ${argv.slice(0, 3).join(' ')} failed (${run.status})\n${run.stderr ?? ''}`)
  }
  return run
}

/** Run a command in the container as root, streaming nothing; returns { status, stdout }. */
const exec = (name, script, opts = {}) =>
  docker(['exec', name, 'bash', '-lc', script], { allowFailure: true, ...opts })

/**
 * The privilege drop the spec asks for, and the reason `sudo` is otherwise absent. See the
 * header. `-H`'s job is `HOME`, which several pack scripts write into, so the shim sets it
 * explicitly — `runuser -u` would leave root's.
 */
const SUDO_SHIM = `#!/bin/bash
# Installed by scripts/pack-smoke.mjs. NOT a general-purpose sudo.
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
 * The three things the spec requires to be byte-identical across the second run, hashed inside
 * the container. `sources.list.d` is hashed per file with names included, so a pack that ADDS a
 * source list on the second run is caught as surely as one that appends to an existing one.
 */
const SNAPSHOT = `
  for f in /home/rocky/.bashrc /root/.bashrc; do
    if [ -f "$f" ]; then sha256sum "$f"; else echo "absent  $f"; fi
  done
  if [ -d /etc/apt/sources.list.d ]; then
    find /etc/apt/sources.list.d -type f | sort | xargs -r sha256sum
  fi
`

/* ------------------------------------------------------------------------- the run */

const results = []
let failures = 0

for (const pack of packs) {
  const name = `rockysurf-pack-smoke-${pack.packId}-${ARCH}-${Date.now().toString(36)}`
  const work = mkdtempSync(join(tmpdir(), 'rockysurf-pack-smoke-'))
  const checks = []
  const dumps = []
  const record = (ok, what, detail = '') => {
    checks.push({ ok, what, detail })
    if (!ok) failures++
    log(`  ${ok ? '[32mok[0m  ' : '[31mFAIL[0m'} ${what}${detail ? ` — ${detail}` : ''}`)
  }

  log(`\n==> ${pack.packId} on linux/${ARCH} (${IMAGE})`)

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
    tools: toolRows,
    // No repository clones: which repositories to clone is the user's choice at create time,
    // not a property of the pack, and a clone step would put this test on the network for a
    // reason that has nothing to do with the pack's scripts.
    repositories: [],
  })
  writeFileSync(join(work, 'plan.json'), JSON.stringify(plan, null, 2))
  writeFileSync(join(work, 'sudo'), SUDO_SHIM)
  writeFileSync(join(work, 'secrets.env'), `RDP_PASSWORD=${RDP_PASSWORD}\n`)
  log(`    plan: ${plan.steps.length} step(s)`)

  try {
    docker(['pull', '--quiet', '--platform', `linux/${ARCH}`, IMAGE])
    docker(['run', '-d', '--name', name, '--platform', `linux/${ARCH}`, IMAGE, 'sleep', 'infinity'])

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
    docker(['cp', agentScript, `${name}:/agent.sh`])
    docker(['cp', join(work, 'sudo'), `${name}:/usr/local/bin/sudo`])
    exec(name, 'chmod 0755 /usr/local/bin/sudo && chmod 0600 /var/lib/rockysurf/secrets.env')

    const runAgent = (label) => {
      const started = Date.now()
      const out = docker(['exec', name, 'bash', '/agent.sh'], { allowFailure: true })
      const seconds = Math.round((Date.now() - started) / 1000)
      const text = `${out.stdout ?? ''}${out.stderr ?? ''}`
      writeFileSync(join(work, `${label}.log`), text)
      return { status: out.status, seconds, text }
    }
    const readJournal = () => {
      const out = exec(name, 'cat /var/lib/rockysurf/state.json')
      if (out.status !== 0) return null
      try {
        return JSON.parse(out.stdout)
      } catch {
        return null
      }
    }
    const journal = () => {
      const state = readJournal()
      if (state === null) throw new Error('/var/lib/rockysurf/state.json is missing or is not JSON')
      return state
    }
    const snapshot = () => exec(name, SNAPSHOT).stdout

    /**
     * WHY THIS EXISTS. Without it the harness's output says only WHICH step died, and for the
     * architectures nobody has on their desk CI is the only machine that runs them at all — so a
     * step that fails there and nowhere else cannot be diagnosed from the run page, only guessed
     * at. That is how rockysurf-pcma sat undiagnosable. The agent already keeps a per-step log at
     * /var/lib/rockysurf/steps/<id>.log; this reads it out of the container while the container
     * still exists (the `finally` below removes it) and prints it, delimited, into the run's own
     * output. The agent's surrounding lines follow because they carry the framing the step log
     * cannot: which step, run as whom, and the exit code.
     */
    const dumpFailure = (label, run, state) => {
      const step = state?.failedStep ?? null
      const stepLog = step === null ? null : exec(name, `tail -n 80 '/var/lib/rockysurf/steps/${step}.log' 2>&1`)
      const stepText = stepLog?.status === 0 ? (stepLog.stdout ?? '').trimEnd() : ''
      const haveStep = stepText.length > 0
      const agentText = (run.text ?? '').trimEnd().split('\n').slice(haveStep ? -20 : -80).join('\n')

      const lines = [
        '',
        `┌─ ${pack.packId} on linux/${ARCH} — ${label} failed. The failing step's log follows.`,
        step === null
          ? '│  The journal names no failed step: the agent died before or outside the plan.'
          : `│  step: ${step}   log: /var/lib/rockysurf/steps/${step}.log (last 80 lines; the`
            + ' agent APPENDS, so run 2\'s tail still holds run 1\'s output)',
        '├─────────────────────────────────────────────────────────────────────────────',
        haveStep ? stepText : '│  (no step log — the step produced no output, or never started)',
        '├─ the agent\'s own output around it ──────────────────────────────────────────',
        agentText,
        '└─────────────────────────────────────────────────────────────────────────────',
        '',
      ]
      dumps.push(lines.join('\n'))
      // console.error, not log(): this must reach the run page even under --json, where stdout
      // is reserved for the machine-readable document.
      if (JSON_OUT) console.error(lines.join('\n'))
      else log(lines.join('\n'))
    }

    /* --- run 1 ------------------------------------------------------------------------- */
    const first = runAgent('run1')
    record(first.status === 0, 'run 1: agent exited 0', `${first.seconds}s`)
    let state = journal()
    record(state.status === 'done', 'run 1: plan reached done', `status=${state.status}${state.failedStep ? ` failedStep=${state.failedStep}` : ''}`)
    if (first.status !== 0 || state.status !== 'done') dumpFailure('run 1', first, state)
    const notDone = state.steps.filter((s) => s.status !== 'done').map((s) => `${s.id}=${s.status}`)
    record(notDone.length === 0, 'run 1: every step done', notDone.join(', '))
    const before = snapshot()

    /* --- the journal discard ------------------------------------------------------------ */
    // Without this the second run is the resume path, which is contracted to skip everything.
    const removed = exec(name, 'rm -f /var/lib/rockysurf/state.json && test ! -e /var/lib/rockysurf/state.json')
    record(removed.status === 0, 'resume journal discarded', '/var/lib/rockysurf/state.json')

    /* --- run 2, same container ---------------------------------------------------------- */
    const second = runAgent('run2')
    record(second.status === 0, 'run 2: agent exited 0', `${second.seconds}s`)
    // Belt and braces, and worth knowing which is which. The load-bearing pair is the discard
    // assertion above plus "every step done" below: with no state.json to read, the agent
    // rebuilds the journal with every step `pending`, and a step can only reach `done` by
    // actually executing — so those two together prove re-execution outright. This log check is
    // the cheaper, more legible signal, and it is the one that names the failure if the discard
    // ever regresses. It is not relied on alone: the agent's output goes through a process
    // substitution, so a truncated capture would fail it OPEN.
    record(
      !second.text.includes('already done, skipping (resume)'),
      'run 2: nothing was skipped as already-done',
      'a skip here means the journal was not discarded and the run is meaningless',
    )
    state = journal()
    record(state.status === 'done', 'run 2: plan reached done', `status=${state.status}${state.failedStep ? ` failedStep=${state.failedStep}` : ''}`)
    if (second.status !== 0 || state.status !== 'done') dumpFailure('run 2', second, state)
    const notDone2 = state.steps.filter((s) => s.status !== 'done').map((s) => `${s.id}=${s.status}`)
    record(notDone2.length === 0, 'run 2: every step re-executed to done', notDone2.join(', '))

    /* --- the idempotency evidence ------------------------------------------------------- */
    const after = snapshot()
    if (before === after) {
      record(true, 'run 2 changed nothing: .bashrc x2 and sources.list.d byte-identical')
    } else {
      const b = before.split('\n')
      const a = after.split('\n')
      const diff = [...new Set([...b.filter((l) => !a.includes(l)), ...a.filter((l) => !b.includes(l))])]
      record(false, 'run 2 changed nothing: .bashrc x2 and sources.list.d byte-identical', diff.join(' | '))
    }

    // Not a failure — the spec calls it a warning sign. A second run that re-downloads and
    // re-compiles everything exits 0 and is still a pack that will hurt somebody's resume.
    const ratio = first.seconds > 0 ? second.seconds / first.seconds : 0
    if (ratio > 0.5 && first.seconds > 30) {
      log(`  [33mwarn[0m run 2 took ${second.seconds}s against run 1's ${first.seconds}s — a no-op should be much faster`)
    }

    results.push({
      pack: pack.packId,
      arch: ARCH,
      steps: plan.steps.length,
      run1Seconds: first.seconds,
      run2Seconds: second.seconds,
      checks,
      ...(dumps.length > 0 ? { failureLogs: dumps } : {}),
    })
  } catch (err) {
    record(false, 'harness completed', err instanceof Error ? err.message : String(err))
    results.push({ pack: pack.packId, arch: ARCH, checks, ...(dumps.length > 0 ? { failureLogs: dumps } : {}) })
  } finally {
    if (KEEP) {
      log(`  (--keep) container ${name}, logs in ${work}`)
    } else {
      docker(['rm', '-f', name], { allowFailure: true })
      rmSync(work, { recursive: true, force: true })
    }
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failures === 0, arch: ARCH, results }, null, 2))
} else {
  console.log()
  console.log(failures === 0 ? `pack smoke (${ARCH}): all checks passed` : `pack smoke (${ARCH}): ${failures} check(s) failed`)
}
process.exit(failures === 0 ? 0 : 1)
