import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  RegistryIndexError,
  buildRegistryIndex,
  bundledPacksDir,
  describePack,
  formatFindings,
  lintPacksDir,
  loadPacksFromDir,
  renderRegistryIndex,
  type IndexSourceDir,
  type LintReport,
  type PackDisclosure,
  type ToolDefinition,
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
 *   npx rockysurf@<version> pack lint  packs --base-packs <the Rocky Surf tarball's packs/>
 *   npx rockysurf@<version> pack check packs --base-packs <same> --pack <id>
 *
 * `--base-packs` is not optional there. The shop is purely community (owner's ruling on issue
 * #9): the shared base toolchain a pack is told to REFERENCE rather than redefine ships in the
 * Rocky Surf tarball and does not exist in the registry, so without it every well-behaved
 * contribution fails on every tool it correctly did not define.
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
 * carries that weight is the label the OPERATOR's own configuration puts on a registry, and the
 * disclosure they read before installing — see ADR-0006 and `docs/writing-a-pack.md`.
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

  describe <dir> Say what a pack DOES: every script it runs, which of them run as root, and
                every URL those scripts fetch. The same derivation the control plane shows an
                operator before they consent to an install, so a reviewer of a community pull
                request sees what the person installing it will see.

                  rockysurf pack describe packs --pack my-pack
                  rockysurf pack describe packs --pack my-pack --json

  index         Generate a pack registry's index.json from its pack directories. Run by the
                registry's CI on merge, never by hand: it records a sha256 per pack, and a
                hand-written index describes files it no longer matches.

                  rockysurf pack index --source packs --base-packs upstream/packs \\
                                       --out index.json

                There is no trust label in the index. A pack's label comes from where the
                OPERATOR got it — the tarball, or the registry entry in their own config —
                never from a document the registry itself wrote.

Options:
  --base-packs <dir>   A directory whose tools may be REFERENCED but which is not itself under
                       test — the shared base toolchain a pack is expected to reference rather
                       than redefine. Repeatable. DEFAULTS to the packs bundled in this
                       rockysurf, so a community pack referencing them needs no flag at all;
                       naming one replaces that default rather than adding to it.
  --pack <id>          Check only this pack (check only).
  --arch <amd64|arm64> Architecture to run under (check only; defaults to this machine's).
  --keep               Leave the container and logs behind for inspection (check only).
  --markdown           Render the description as markdown, for posting into a pull request
                       (describe only). --json gives the raw derivation instead.
  --source <dir>       A directory whose packs go into the index, recorded under that path.
                       Repeatable (index only).
  --out <path>         Where to write the index. Omit to print it (index only).
  --allow-empty        Treat a directory with no pack files as clean rather than as a mistyped
                       path. For a registry that is legitimately empty (lint only).
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
  if (subcommand === 'describe') return runDescribe(rest, io)
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
  return { dir: resolve(dir), basePacksDirs: baseDirs(argv) }
}

/**
 * `--base-packs`, defaulting to the packs bundled in THIS `rockysurf` (rockysurf-io02).
 *
 * The default is what makes the registry's CI a one-liner. A community pack references the
 * shared base toolchain by tool id rather than redefining it, and a purely-community registry
 * does not contain those definitions — so before the packs shipped in the tarball, a shop had to
 * clone this repository just to point the flag somewhere. Now `npx rockysurf@0.1.0 pack lint
 * packs` resolves them out of the version it already pinned, which is both simpler and more
 * precisely pinned than tracking a branch.
 *
 * An explicit `--base-packs` still wins outright rather than adding to the default: somebody who
 * names a directory means that directory, and quietly unioning it with a set they did not ask
 * for is how a check passes against tools the target installation will not have.
 */
function baseDirs(argv: string[]): string[] {
  const explicit = flagValues(argv, '--base-packs').map((d) => resolve(d))
  if (explicit.length > 0) return explicit
  const bundled = bundledPacksDir()
  return bundled ? [bundled] : []
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
  // `--allow-empty` is for the one caller that legitimately expects nothing: a registry with no
  // contributions in it yet. It is a FLAG rather than a default
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
 * THE DIRECTORY PATH ON DISK AND THE PATH RECORDED IN THE INDEX ARE THE SAME STRING,
 * deliberately. Core fetches `<registry base URL>/<path>`, so the index only describes a
 * fetchable file if the generator was run from the registry's root — and letting the two diverge
 * would produce an index that validates, commits cleanly, and 404s for every operator.
 *
 * `--base-packs` names the shared base toolchain, which a registry does not itself contain: the
 * shop is purely community, and the tools its packs reference ship in the Rocky Surf tarball.
 */
function runIndex(argv: string[], io: PackCommandIo): number {
  const specs = flagValues(argv, '--source')
  if (specs.length === 0) {
    io.err('pack index needs at least one --source <dir>')
    io.err(USAGE)
    return 1
  }

  const sources: IndexSourceDir[] = []
  for (const spec of specs) {
    const prefix = spec.replace(/\/+$/, '')
    // A source that is not there is a mistake, not an empty one. The way this command fails
    // silently is a CI job that renames a directory and publishes an index missing half the
    // registry — every operator's shop quietly loses those packs and nothing errors.
    if (!existsSync(prefix)) {
      io.err(`--source directory "${prefix}" does not exist (run this from the registry root)`)
      return 2
    }
    sources.push({ dir: resolve(prefix), prefix })
  }
  const basePacksDirs = baseDirs(argv)

  let rendered: string
  try {
    rendered = renderRegistryIndex(
      buildRegistryIndex({ sources, ...(basePacksDirs.length > 0 ? { basePacksDirs } : {}) }),
    )
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

/**
 * `rockysurf pack describe` — what a pack does to a box, derived rather than asserted.
 *
 * THE POINT IS THAT A REVIEWER SEES WHAT AN OPERATOR SEES. The control plane shows every script
 * verbatim before an install, plus which steps run as root and every URL the scripts fetch
 * (packs/disclosure.ts, ADR-0006). A maintainer reading a community pull request is making a
 * related judgement with worse tooling — a raw YAML diff — and maintainer review is one of the
 * three things the trust model actually leans on. This is the same derivation, on the command
 * line, so a registry's CI can put it in front of them.
 *
 * THE SPLIT BETWEEN DEFINED AND REFERENCED TOOLS is what makes the markdown readable. A pack
 * that borrows nine base tools would otherwise bury its own twenty lines under six hundred that
 * a reviewer has read a hundred times. So the scripts shown in full are the ones the pack FILE
 * introduces, and the borrowed ones are named and counted. `--json` carries the whole thing, and
 * is what an operator's own page is built from — nothing is hidden, only ordered.
 *
 * NEITHER FORM IS A VERDICT. It reports what the scripts say they do; deciding whether that is
 * acceptable is the reader's job, and the caveat travels with the output because a URL list
 * derived from shell cannot be complete.
 */
function runDescribe(argv: string[], io: PackCommandIo): number {
  const dirs = resolveDirs(argv, io)
  if (!dirs) return 1

  // Validated through `lintPacksDir` rather than the raw loader, so "does not validate" means
  // exactly what `pack lint` means — including resolving the shared base toolchain, without
  // which every well-behaved pack looks broken for referencing tools it correctly did not
  // define. A pack the runtime would refuse cannot be described honestly.
  const report = lintPacksDir({
    dir: dirs.dir,
    ...(dirs.basePacksDirs.length > 0 ? { basePacksDirs: dirs.basePacksDirs } : {}),
  })
  if (report.findings.length > 0) {
    io.err(`${dirs.dir} does not validate, so it cannot be described:`)
    io.err(formatFindings(report.findings))
    return 2
  }

  const loaded = loadPacksFromDir(dirs.dir)

  const only = flagValue(argv, '--pack')
  const packs = loaded.packs.filter((p) => !only || p.packId === only)
  if (packs.length === 0) {
    io.err(only ? `no pack called "${only}" in ${dirs.dir}` : `no packs found in ${dirs.dir}`)
    return 2
  }

  // Base tools are resolvable but not defined here, exactly as at install time: a pack
  // referencing `claude-code` runs that tool's script too, and a description that omitted it
  // would show a reviewer less than will actually happen.
  const known = new Map<string, ToolDefinition>()
  for (const dir of dirs.basePacksDirs) {
    for (const tool of loadPacksFromDir(dir).tools.values()) if (!known.has(tool.toolId)) known.set(tool.toolId, strip(tool))
  }
  for (const tool of loaded.tools.values()) known.set(tool.toolId, strip(tool))

  const described = packs.map((pack) => {
    const own = [...loaded.tools.values()].filter((t) => t.sourceFile === pack.sourceFile).map(strip)
    const { sourceFile: _dropped, ...packFields } = pack
    return {
      packId: pack.packId,
      definesTools: own.map((t) => t.toolId),
      disclosure: describePack({ file: { version: 1, pack: packFields, tools: own }, knownTools: known }),
    }
  })

  if (argv.includes('--json')) {
    io.out(JSON.stringify(described.length === 1 ? described[0] : described, null, 2))
    return 0
  }
  for (const entry of described) io.out(render(entry, argv.includes('--markdown')))
  return 0
}

/** `sourceFile` is provenance the loader attaches, not part of the frozen format. */
function strip(tool: ToolDefinition & { sourceFile?: string }): ToolDefinition {
  const { sourceFile: _dropped, ...rest } = tool
  return rest
}

function render(
  entry: { packId: string; definesTools: string[]; disclosure: PackDisclosure },
  markdown: boolean,
): string {
  const { disclosure } = entry
  const defines = new Set(entry.definesTools)
  const borrowed = disclosure.tools.filter((t) => !defines.has(t.toolId))
  const own = disclosure.tools.filter((t) => defines.has(t.toolId))
  const h = (text: string) => (markdown ? `## ${text}` : text)
  const code = (text: string) => (markdown ? ['```bash', text.trimEnd(), '```'].join('\n') : indent(text))

  const lines: string[] = []
  lines.push(markdown ? `# What \`${disclosure.name}\` does` : `${disclosure.name} (${disclosure.packId})`)
  lines.push('')
  lines.push(
    `Runs **${disclosure.tools.length}** install step(s), of which **${disclosure.rootStepCount}** run as root.`
      .replace(/\*\*/g, markdown ? '**' : ''),
  )
  lines.push('')

  lines.push(h('URLs these scripts fetch'))
  lines.push('')
  if (disclosure.fetchesUrls.length === 0) lines.push('No download URL appears literally in them.')
  else for (const url of disclosure.fetchesUrls) lines.push(markdown ? `- \`${url}\`` : `  ${url}`)
  lines.push('')
  // Carried in EVERY form. A list of URLs without this sentence tells a reader they have seen
  // every download, and a script that builds a URL from a variable makes that false.
  lines.push(
    markdown
      ? '> This list is derived by reading the scripts and **cannot be complete** — a script that'
        + ' builds a URL from a variable will not appear above. The scripts themselves are what runs.'
        // Same words in both forms, deliberately. The caveat is the load-bearing sentence of
        // the whole derivation; a plain-text rendering that softened it would be a second,
        // weaker promise for whoever happens to read that one.
      : '  NOTE: this list is derived by reading the scripts and cannot be complete — a script'
        + '\n  that builds a URL from a variable will not appear. The scripts themselves are'
        + '\n  what runs.',
  )
  lines.push('')

  if (own.length > 0) {
    lines.push(h(`Scripts this pack introduces (${own.length})`))
    lines.push('')
    for (const tool of own) {
      lines.push(markdown ? `### \`${tool.toolId}\` — runs as \`${tool.runAs}\`` : `${tool.toolId} (runs as ${tool.runAs})`)
      lines.push(tool.description)
      lines.push('')
      lines.push(code(tool.installScript))
      if (tool.setupScript) {
        lines.push('')
        lines.push(markdown ? '_setup, after any repositories are cloned:_' : '  setup, after any repositories are cloned:')
        lines.push(code(tool.setupScript))
      }
      lines.push('')
    }
  }

  if (borrowed.length > 0) {
    // Named and counted rather than dumped: a reviewer has read these before, and burying the
    // twenty lines under review beneath six hundred they have not changed is how a review
    // becomes a scroll.
    lines.push(h(`Tools it borrows, defined elsewhere (${borrowed.length})`))
    lines.push('')
    lines.push(borrowed.map((t) => (markdown ? `\`${t.toolId}\`` : t.toolId)).join(', '))
    lines.push('')
    lines.push(
      markdown
        ? '_Their scripts run too. `--json` carries them in full._'
        : '  Their scripts run too. --json carries them in full.',
    )
    lines.push('')
  }

  if (disclosure.referencesTools.length > 0) {
    lines.push(
      `${markdown ? '**Unresolved:** ' : 'UNRESOLVED: '}${disclosure.referencesTools.join(', ')}` +
        ' — nothing here defines these, so an installation without them would leave those steps out.',
    )
    lines.push('')
  }
  return lines.join('\n')
}

const indent = (text: string) => text.trimEnd().split('\n').map((l) => `    ${l}`).join('\n')

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
