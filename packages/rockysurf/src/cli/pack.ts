import { resolve } from 'node:path'
import { formatFindings, lintPacksDir, type LintReport } from '@rockysurf/core'
import { ARCHITECTURES, PackCheckSetupError, runPackCheck, type Arch } from './pack-smoke.js'

/**
 * `rockysurf pack lint` and `rockysurf pack check` — the pack contract, runnable anywhere.
 *
 * WHY THESE ARE COMMANDS AND NOT REPOSITORY SCRIPTS (rockysurf-arym.2). Surge Packs are meant
 * to be contributed by people who do not have this repository checked out, and issue #9 moves
 * community packs into `amroja-biz/rockysurf-shop`. That repository's CI has to gate a pull
 * request with the SAME checks `packs/` is gated by, and it can only do that if the checks are
 * something it can install. A shop that vendored a copy of the harness would be certifying
 * packs against a contract that had already drifted from the one core enforces.
 *
 * So the shop pins a version of this package and runs:
 *
 *   npx rockysurf@<version> pack lint  packs/community --base-packs packs/official
 *   npx rockysurf@<version> pack check packs/community --base-packs packs/official --pack <id>
 *
 * NEITHER COMMAND OPENS A DATABASE OR BOOTS CORE. They are pure functions of a directory of
 * files, which is what makes them safe to run in somebody else's CI and against a data
 * directory a control plane is currently serving.
 *
 * THE SPLIT BETWEEN THEM IS DOCKER, AND IT IS THE POINT:
 *
 *   `lint`  is static — schema, ids, cross-file references, and the mechanical half of the
 *           four author rules. Runs in a second, on every pull request, needs nothing.
 *   `check` runs the pack twice in a stock ubuntu:24.04 container with the resume journal
 *           discarded in between. It is the only thing that proves idempotency rather than
 *           inspecting for it, and it needs a Docker daemon.
 *
 * Neither is a security scan and the help text says so. An `installScript` is arbitrary
 * root-privileged shell; a pattern match over it cannot decide whether it is benign. What
 * carries that weight is the registry's trust label and the disclosure an operator reads
 * before installing — see ADR-0006 and `docs/writing-a-pack.md`.
 */

export interface PackCommandIo {
  out: (line: string) => void
  err: (line: string) => void
}

const USAGE = `usage: rockysurf pack <lint|check> <dir> [options]

  lint <dir>    Validate every pack file in <dir>: the frozen schema, ids, cross-file
                references, and the mechanical half of the four author rules. No Docker.

  check <dir>   Run each pack twice in a stock ubuntu:24.04 container, discarding the resume
                journal in between, and require the second run to change nothing. Proves
                idempotency. Needs a Docker daemon.

Options:
  --base-packs <dir>   A directory whose tools may be REFERENCED but which is not itself under
                       test — the shared base toolchain a pack is expected to reference rather
                       than redefine. Repeatable. Without it, a directory holding one pack
                       fails on every tool it does not define itself.
  --pack <id>          Check only this pack (check only).
  --arch <amd64|arm64> Architecture to run under (check only; defaults to this machine's).
  --keep               Leave the container and logs behind for inspection (check only).
  --json               Machine-readable output on stdout.

Neither command is a security scan: install scripts are arbitrary root-privileged shell and no
static check can decide whether they are benign. See docs/writing-a-pack.md.`

/* ------------------------------------------------------------------------ flag parsing */

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index >= 0 && argv[index + 1]) return argv[index + 1]
  return argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1)
}

/** Repeatable, so several base directories can be named. Same shape as `--repo` in commands.ts. */
function flagValues(argv: string[], flag: string): string[] {
  const values: string[] = []
  argv.forEach((arg, index) => {
    if (arg === flag) {
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('-')) values.push(next)
    } else if (arg.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1))
    }
  })
  return values
}

/** The first non-flag argument: the directory. `--flag value` pairs are stepped over. */
function positional(argv: string[]): string | undefined {
  const takesValue = new Set(['--base-packs', '--pack', '--arch'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith('-')) {
      if (takesValue.has(arg)) i++
      continue
    }
    return arg
  }
  return undefined
}

/* -------------------------------------------------------------------------- the commands */

export function runPackCommand(argv: string[], io: PackCommandIo): number {
  const [subcommand, ...rest] = argv
  if (subcommand === 'lint') return runLint(rest, io)
  if (subcommand === 'check') return runCheck(rest, io)
  io.err(USAGE)
  return 1
}

function resolveDirs(argv: string[], io: PackCommandIo): { dir: string; basePacksDirs: string[] } | undefined {
  const dir = positional(argv)
  if (!dir) {
    io.err(USAGE)
    return undefined
  }
  // Absolute, so every message names a path the reader can paste, whatever the cwd was.
  return { dir: resolve(dir), basePacksDirs: flagValues(argv, '--base-packs').map((d) => resolve(d)) }
}

function runLint(argv: string[], io: PackCommandIo): number {
  const dirs = resolveDirs(argv, io)
  if (!dirs) return 1
  const json = argv.includes('--json')

  const report = lintPacksDir({
    dir: dirs.dir,
    ...(dirs.basePacksDirs.length > 0 ? { basePacksDirs: dirs.basePacksDirs } : {}),
  })

  if (json) {
    io.out(JSON.stringify({ ok: report.findings.length === 0, dir: dirs.dir, ...report }, null, 2))
    return report.findings.length === 0 ? 0 : 1
  }

  // A directory with nothing pack-shaped in it is a MISTAKE, not a pass. The commonest way to
  // get a green lint you have not earned is to point it at the wrong path, and a check that
  // congratulates you for that is worse than no check — the shop's CI would merge on it.
  if (report.files.length === 0) {
    io.err(`${dirs.dir} holds no pack files (*.yaml, *.yml). Nothing was checked.`)
    return 1
  }

  if (report.findings.length > 0) {
    io.err(formatFindings(report.findings))
    io.err('')
    io.err(summarize(report))
    return 1
  }

  io.out(`${report.files.length} file(s), ${report.packs.length} pack(s): ${report.packs.join(', ')}`)
  io.out('pack lint: no findings')
  return 0
}

/** Findings grouped by rule, so a contributor sees "three of these" rather than a wall. */
function summarize(report: LintReport): string {
  const byRule = new Map<string, number>()
  for (const finding of report.findings) byRule.set(finding.rule, (byRule.get(finding.rule) ?? 0) + 1)
  const counts = [...byRule].map(([rule, n]) => `${rule}: ${n}`).join(', ')
  return `pack lint: ${report.findings.length} finding(s) — ${counts}`
}

function runCheck(argv: string[], io: PackCommandIo): number {
  const dirs = resolveDirs(argv, io)
  if (!dirs) return 1
  const json = argv.includes('--json')

  const requested = flagValue(argv, '--arch') ?? (process.arch === 'arm64' ? 'arm64' : 'amd64')
  if (!(ARCHITECTURES as readonly string[]).includes(requested)) {
    io.err(`--arch must be one of ${ARCHITECTURES.join(', ')}, got "${requested}"`)
    return 2
  }

  try {
    const report = runPackCheck({
      dir: dirs.dir,
      ...(dirs.basePacksDirs.length > 0 ? { basePacksDirs: dirs.basePacksDirs } : {}),
      arch: requested as Arch,
      ...(flagValue(argv, '--pack') ? { only: flagValue(argv, '--pack')! } : {}),
      keep: argv.includes('--keep'),
      // Under --json, stdout is reserved for the machine-readable document; progress goes to
      // stderr so a caller can have both.
      log: (line) => (json ? io.err(line) : io.out(line)),
      // A failure dump must reach the run page under either mode. It is the only diagnosis a
      // contributor gets for an architecture they cannot run locally (rockysurf-pcma).
      logFailure: (text) => io.err(text),
    })

    if (json) {
      io.out(JSON.stringify(report, null, 2))
    } else {
      const failed = report.results.flatMap((r) => r.checks).filter((c) => !c.ok).length
      io.out('')
      io.out(
        report.ok
          ? `pack check (${report.arch}): all checks passed`
          : `pack check (${report.arch}): ${failed} check(s) failed`,
      )
    }
    return report.ok ? 0 : 1
  } catch (err) {
    // Exit 2 is "could not run the check", distinct from 1's "the pack failed it". The shop's
    // CI needs to tell a broken pack from a broken runner, and a single non-zero cannot.
    if (err instanceof PackCheckSetupError) {
      io.err(err.message)
      return 2
    }
    const message = err instanceof Error ? err.message : String(err)
    io.err(
      message.includes('docker')
        ? `${message}\n\npack check needs a running Docker daemon. Use \`rockysurf pack lint\` for the static checks.`
        : message,
    )
    return 2
  }
}
