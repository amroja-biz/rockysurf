import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  RegistryIndexError,
  TRUST_TIERS,
  buildRegistryIndex,
  formatFindings,
  lintPacksDir,
  renderRegistryIndex,
  type IndexSourceDir,
  type LintReport,
  type TrustTier,
} from '@rockysurf/core'
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

const USAGE = `usage: rockysurf pack <lint|check|index> [options]

  lint <dir>    Validate every pack file in <dir>: the frozen schema, ids, cross-file
                references, and the mechanical half of the four author rules. No Docker.

  check <dir>   Run each pack twice in a stock ubuntu:24.04 container, discarding the resume
                journal in between, and require the second run to change nothing. Proves
                idempotency. Needs a Docker daemon.

  index         Generate a pack registry's index.json from its pack directories. Run by the
                registry's CI on merge, never by hand — the trust tier is written here, and a
                tier a contributor can set on their own pack is not a tier.

                  rockysurf pack index --source packs/official=official \\
                                       --source packs/community=community \\
                                       --out index.json

Options:
  --base-packs <dir>   A directory whose tools may be REFERENCED but which is not itself under
                       test — the shared base toolchain a pack is expected to reference rather
                       than redefine. Repeatable. Without it, a directory holding one pack
                       fails on every tool it does not define itself.
  --pack <id>          Check only this pack (check only).
  --arch <amd64|arm64> Architecture to run under (check only; defaults to this machine's).
  --keep               Leave the container and logs behind for inspection (check only).
  --source <dir>=<tier>  A directory to index and the trust tier its packs get: one of
                       ${TRUST_TIERS.join(', ')}. Repeatable (index only).
  --out <path>         Where to write the index. Omit to print it (index only).
  --allow-empty        Treat a directory with no pack files as clean rather than as a mistyped
                       path. For a registry tier that is legitimately empty (lint only).
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
  const takesValue = new Set(['--base-packs', '--pack', '--arch', '--source', '--out'])
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
  if (subcommand === 'index') return runIndex(rest, io)
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
  // congratulates you for that is worse than no check — a registry's CI would merge on it.
  //
  // `--allow-empty` is for the one caller that legitimately expects nothing: a registry whose
  // community tier is empty until its first contribution. It is a FLAG rather than a default
  // because the two situations are indistinguishable from inside this function, and only the
  // caller knows which one it is in. A registry says so once, in its workflow; a pack author who
  // mistyped a path still gets told.
  if (report.files.length === 0 && !argv.includes('--allow-empty')) {
    io.err(
      `${dirs.dir} holds no pack files (*.yaml, *.yml). Nothing was checked.\n` +
        'If an empty directory is expected here, pass --allow-empty.',
    )
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

/**
 * `rockysurf pack index` — render a registry's `index.json`.
 *
 * A `--source` is a directory and the tier its packs get: `packs/community=community`. The
 * DIRECTORY PATH ON DISK AND THE PATH RECORDED IN THE INDEX ARE THE SAME STRING, deliberately.
 * Core fetches `<registry base URL>/<path>`, so the index only describes a fetchable file if
 * the generator was run from the registry's root — and letting the two diverge would produce an
 * index that validates, commits cleanly, and 404s for every operator.
 */
function runIndex(argv: string[], io: PackCommandIo): number {
  const specs = flagValues(argv, '--source')
  if (specs.length === 0) {
    io.err('pack index needs at least one --source <dir>=<tier>')
    io.err(USAGE)
    return 1
  }

  const sources: IndexSourceDir[] = []
  for (const spec of specs) {
    const separator = spec.lastIndexOf('=')
    if (separator < 1) {
      io.err(`--source must be <dir>=<tier>, got "${spec}"`)
      return 1
    }
    const prefix = spec.slice(0, separator).replace(/\/+$/, '')
    const tier = spec.slice(separator + 1)
    if (!(TRUST_TIERS as readonly string[]).includes(tier)) {
      io.err(`--source tier must be one of ${TRUST_TIERS.join(', ')}, got "${tier}"`)
      return 1
    }
    // A source that is not there is a mistake, not an empty tier. The way this command fails
    // silently is a CI job that renames a directory and publishes an index missing half the
    // registry — every operator's shop quietly loses its community packs and nothing errors.
    if (!existsSync(prefix)) {
      io.err(`--source directory "${prefix}" does not exist (run this from the registry root)`)
      return 2
    }
    sources.push({ dir: resolve(prefix), prefix, tier: tier as TrustTier })
  }

  let rendered: string
  try {
    rendered = renderRegistryIndex(buildRegistryIndex({ sources }))
  } catch (err) {
    if (err instanceof RegistryIndexError) {
      io.err(err.message)
      return 1
    }
    throw err
  }

  const out = flagValue(argv, '--out')
  if (!out) {
    io.out(rendered.trimEnd())
    return 0
  }
  writeFileSync(resolve(out), rendered)
  io.err(`wrote ${out}`)
  return 0
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
