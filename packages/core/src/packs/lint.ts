import { loadPacksFromDir, type LoadResult, type LoadedTool } from './loader.js'

/**
 * The pack author contract, as a check somebody outside this repository can run.
 *
 * `docs/writing-a-pack.md` is normative and `packs.test.ts` has enforced its mechanical half
 * on the SHIPPED packs since ADR-0004. That was enough while every pack lived in `packs/`.
 * It stops being enough the moment packs arrive from a registry (rockysurf-arym): a rule that
 * only runs inside this repository's test suite cannot gate a pull request in
 * `amroja-biz/rockysurf-shop`, and a gate the registry does not actually run is decoration.
 *
 * So the rules move here, where the CLI, the shop's CI and `packs.test.ts` can all reach one
 * definition of them. There is deliberately no second copy anywhere.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. It proves a file is well-formed: it parses, it
 * matches the frozen schema, its ids resolve, and its scripts do not contain the handful of
 * shapes that are known to break a resumed install or a non-amd64 box. It proves NOTHING about
 * whether the shell is benign — an `installScript` is arbitrary root-privileged code and no
 * pattern match over it is a security control. `rockysurf pack check` (the smoke harness) adds
 * behavioural evidence for idempotency; the trust label and the pre-install disclosure carry
 * what neither of them can. Do not let this file be described as a security scan.
 */

/** One violation, addressed to whoever has to fix it. */
export interface LintFinding {
  /** The pack file, as the loader named it — repository-relative where possible. */
  file: string
  /**
   * Which rule fired. Stable strings, because the shop's CI annotates pull requests with
   * them and a renamed rule silently stops matching whatever keyed off it.
   */
  rule: LintRule
  message: string
}

export type LintRule =
  /** Anything the loader itself refused: YAML, schema, ids, cross-file references. */
  | 'format'
  /** A tool id this directory redefines that a base directory already owns. */
  | 'duplicate-tool'
  /** Rule 1: idempotent. */
  | 'idempotent'
  /** Rule 2: $ARCH-aware. */
  | 'arch-aware'
  /** Rule 3: non-interactive. */
  | 'non-interactive'
  /** Rule 4: runAs-honest. */
  | 'run-as-honest'
  /** "What you may not assume" — the base image, the cloud, the metadata service. */
  | 'assumes-too-much'
  /** `bootstrap: true` is reserved for the runtime's own steps. */
  | 'reserved-field'

export interface LintOptions {
  /** The directory under test. Every finding is charged to a file in here. */
  dir: string
  /**
   * Directories whose tools may be REFERENCED but which are not themselves under test.
   *
   * Without this the check is unusable for the thing it exists for. A community pack is
   * expected to reference the shared base toolchain by id rather than redefine it
   * (CONTRIBUTING.md), that toolchain is defined in this repository's
   * `packs/ai-coding-agents.yaml`, and a directory holding one community pack therefore
   * fails `references unknown tool "claude-code"` on every single tool it does not own.
   */
  basePacksDirs?: string[]
}

export interface LintReport {
  findings: LintFinding[]
  /** Pack ids the directory under test defines, in load order. */
  packs: string[]
  /** Candidate files the loader read, valid or not. Empty means nothing pack-shaped was there. */
  files: string[]
}

/** True when the report is clean. The CLI's exit code is this, negated. */
export const isClean = (report: LintReport): boolean => report.findings.length === 0

/* ------------------------------------------------------------------------ the rules */

interface ScriptUnderTest {
  file: string
  /** `<toolId>.installScript`, so a finding names the exact field. */
  id: string
  runAs: string
  body: string
  /**
   * `body` with whole-line `#` comments blanked out, for rules about what a script DOES.
   *
   * A rule that reads comments cannot tell an instruction from an explanation, and the
   * explanations in this repository are long: the `api.github.com` rule below would fire on the
   * three paragraphs in `packs/ai-coding-agents.yaml` that exist precisely to say why that
   * endpoint is not called (rockysurf-c6cm). A lint whose own documentation trips it is a lint
   * people learn to route around.
   *
   * Lines are blanked rather than removed so a future rule can still report a line number, and
   * only FULL-line comments go: `curl … # see rockysurf-x` keeps its command, and a `#` inside a
   * string is left alone rather than guessed at. Existing rules deliberately still read the raw
   * `body` — narrowing what they match is a change to what the gate catches, and belongs to
   * whoever is looking at those rules rather than riding along with this one.
   */
  commands: string
}

/** Blank out whole-line `#` comments, preserving line count. See `ScriptUnderTest.commands`. */
const commandsOnly = (body: string): string =>
  body
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n')

const scriptsOf = (tools: Iterable<LoadedTool>): ScriptUnderTest[] =>
  [...tools].flatMap((tool) =>
    (['installScript', 'setupScript'] as const)
      .filter((field) => tool[field])
      .map((field) => ({
        file: tool.sourceFile,
        id: `${tool.toolId}.${field}`,
        runAs: tool.runAs,
        body: tool[field]!,
        commands: commandsOnly(tool[field]!),
      })),
  )

/**
 * Each rule is a predicate over one script plus the message to print when it fires.
 *
 * Written as a table rather than as a function per rule so that the shop's CONTRIBUTING can
 * list exactly what runs, and so adding a rule is one row. Every `when` is a POSITIVE match on
 * the broken shape: a regex that matches the correct spelling too would fail open, which for a
 * merge gate is the worst of the available failure modes.
 */
const SCRIPT_RULES: Array<{
  rule: LintRule
  message: string
  when: (script: ScriptUnderTest) => boolean
}> = [
  {
    rule: 'arch-aware',
    message:
      'names a specific architecture but never reads $ARCH — on the other architecture this ' +
      'downloads a binary that cannot execute, and the failure surfaces much later as ' +
      '"cannot execute binary file" (rule 2)',
    when: (s) => /x86_64|aarch64|linux-x64|linux-arm64/.test(s.body) && !s.body.includes('$ARCH'),
  },
  {
    rule: 'non-interactive',
    message: 'runs `apt-get install` without -y, so it blocks forever on a box with no terminal (rule 3)',
    when: (s) => /apt-get install(?![^\n]*(-y|--yes))/.test(s.body),
  },
  {
    rule: 'non-interactive',
    message: 'runs `npx` without --yes, which prompts before installing a package (rule 3)',
    when: (s) => /\bnpx\b(?![^\n]*--yes)/.test(s.body),
  },
  {
    rule: 'non-interactive',
    message: 'uses `read -p`, which waits for input that will never arrive (rule 3)',
    when: (s) => /\bread -p\b/.test(s.body),
  },
  {
    rule: 'run-as-honest',
    message:
      'calls sudo from a `runAs: rocky` script. `rocky` is not in sudoers on a real box, so ' +
      'this fails there exactly as it fails in the smoke container — declare `runAs: root` for ' +
      'the step that genuinely needs it (rule 4)',
    when: (s) => s.runAs !== 'root' && /\bsudo\b/.test(s.body),
  },
  {
    rule: 'idempotent',
    message:
      'appends to a file without a `grep -q` guard. A resumed install replays this step, and ' +
      'the second append is how a PATH ends up containing the same entry twice (rule 1)',
    when: (s) => />>\s*\S/.test(s.body) && !s.body.includes('grep -q'),
  },
  {
    rule: 'idempotent',
    message:
      'cache-busts a download URL with `date +%s`, which guarantees the second run refetches ' +
      'rather than converging (rule 1)',
    when: (s) => /date \+%s/.test(s.body),
  },
  {
    rule: 'assumes-too-much',
    message:
      'calls the AWS CLI. The box holds no cloud credentials and may not be on AWS at all — ' +
      'fetch what you need over plain HTTPS instead',
    when: (s) => /\baws\s+(s3|ec2|configure)\b/.test(s.body),
  },
  {
    rule: 'assumes-too-much',
    message: 'reads from s3://. The box has no cloud credentials; use a public HTTPS URL',
    when: (s) => s.body.includes('s3://'),
  },
  {
    rule: 'assumes-too-much',
    message:
      'contacts the instance metadata service (169.254.169.254). The bootstrap has zero ' +
      'metadata coupling and a bring-your-own host has no metadata service at all — read $ARCH ' +
      'and the documented environment instead',
    when: (s) => s.body.includes('169.254.169.254'),
  },
  {
    rule: 'assumes-too-much',
    message:
      'installs with apt-get but never refreshes the package list. A stock ubuntu:24.04 has ' +
      'none, so the first install fails with "Unable to locate package" — use an ' +
      '`apt_update_once`-style stamp (docs/writing-a-pack.md § Rule 1)',
    when: (s) => s.body.includes('apt-get install') && !s.body.includes('apt-updated'),
  },
  {
    rule: 'assumes-too-much',
    message:
      'calls api.github.com. A bootstrapping box holds no GitHub token, so the call is ' +
      'unauthenticated and shares a 60-per-hour quota keyed on SOURCE IP — which on a shared CI ' +
      'runner or behind NAT is somebody else\'s quota too. Ask the releases/download endpoint ' +
      'for a pinned version instead: it is a CDN, it has no quota, and a digest can be checked ' +
      '(rockysurf-pcma, rockysurf-c6cm)',
    // Read against `commands` rather than `body`: the packs that were fixed carry paragraphs
    // naming this endpoint to explain why they no longer call it.
    //
    // WHAT THIS DOES NOT CATCH, and it is the shape that actually broke the trunk: a script that
    // pipes a VENDOR'S installer to bash, where the API call lives in the remote file. No regex
    // over our own text can see inside that. Several shipped packs still pipe installers
    // (nodesource, claude.ai, opencode), so a rule against the pipe itself would fail main on
    // day one and is a judgement about trusting vendors rather than about this bug. This rule
    // catches the direct call and the hand-rolled latest-release lookup, which is the form a new
    // pack is most likely to write.
    when: (s) => s.commands.includes('api.github.com'),
  },
]

/**
 * The documented `installOrder` bands (docs/writing-a-pack.md § "gaps-of-10"). Outside them a
 * tool either runs before the base toolchain it depends on or after the setup that needed it.
 */
const MIN_INSTALL_ORDER = 10
const MAX_INSTALL_ORDER = 60

/** Run every rule over one already-loaded set. Exported so `packs.test.ts` can use it directly. */
export function lintLoaded(loaded: LoadResult): LintFinding[] {
  const findings: LintFinding[] = []

  for (const issue of loaded.issues) {
    findings.push({ file: issue.file, rule: 'format', message: issue.message })
  }

  for (const tool of loaded.tools.values()) {
    if (tool.bootstrap) {
      findings.push({
        file: tool.sourceFile,
        rule: 'reserved-field',
        message:
          `tool "${tool.toolId}" sets bootstrap: true, which is reserved for the tools the ` +
          'runtime guarantees before any plan runs. Set it to false',
      })
    }
    if (tool.installOrder < MIN_INSTALL_ORDER || tool.installOrder > MAX_INSTALL_ORDER) {
      findings.push({
        file: tool.sourceFile,
        rule: 'format',
        message:
          `tool "${tool.toolId}" has installOrder ${tool.installOrder}, outside the documented ` +
          `${MIN_INSTALL_ORDER}-${MAX_INSTALL_ORDER} bands`,
      })
    }
  }

  for (const script of scriptsOf(loaded.tools.values())) {
    for (const { rule, message, when } of SCRIPT_RULES) {
      if (when(script)) findings.push({ file: script.file, rule, message: `${script.id} ${message}` })
    }
  }

  return findings
}

/* ------------------------------------------------------------------ loading for a lint */

/**
 * Lint a directory of pack files, resolving references against directories it does not own.
 *
 * The loader charges "references unknown tool" to the file doing the referencing, which is the
 * right call for a repository where every definition is present and the wrong answer for one
 * pack in isolation. So base directories are loaded first, and a reference the base satisfies
 * is dropped from the target's findings rather than reported.
 *
 * A base directory that does not itself validate is reported, not swallowed. Its findings are
 * marked with the directory they came from, because "your pack references an unknown tool" is
 * a lie when the truth is "the file that defines it failed to parse" — the cascade
 * rockysurf-37pa measured, arriving here instead of at boot.
 */
export function lintPacksDir(options: LintOptions): LintReport {
  const baseTools = new Map<string, LoadedTool>()
  const baseFindings: LintFinding[] = []

  for (const baseDir of options.basePacksDirs ?? []) {
    const base = loadPacksFromDir(baseDir)
    for (const issue of base.issues) {
      baseFindings.push({
        file: `${baseDir}/${issue.file}`,
        rule: 'format',
        message: `base pack directory does not validate: ${issue.message}`,
      })
    }
    for (const [id, tool] of base.tools) if (!baseTools.has(id)) baseTools.set(id, tool)
  }

  const loaded = loadPacksFromDir(options.dir)

  // A reference the base satisfies is not the target's problem. Matched on the tool id the
  // loader quoted rather than on the whole sentence, so rewording that message does not
  // silently turn this filter off.
  const satisfiedByBase = (message: string): boolean => {
    const referenced = /references unknown tool "([^"]+)"/.exec(message)
    return referenced !== null && baseTools.has(referenced[1]!)
  }

  const scoped: LoadResult = {
    ...loaded,
    issues: loaded.issues.filter((issue) => !satisfiedByBase(issue.message)),
  }

  const findings = [...baseFindings, ...lintLoaded(scoped)]

  // Redefining a base tool is the one failure the loader cannot see, because it never read the
  // two directories together. It matters: the loader rejects a toolId defined twice, so a
  // community pack that redefines `claude-code` would break the operator's whole catalog on
  // the next boot rather than only itself.
  for (const [id, tool] of loaded.tools) {
    const owner = baseTools.get(id)
    if (owner) {
      findings.push({
        file: tool.sourceFile,
        rule: 'duplicate-tool',
        message:
          `toolId "${id}" is already defined by ${owner.sourceFile} — reference it by id ` +
          'instead of redefining it, or the two definitions collide wherever both are loaded',
      })
    }
  }

  return { findings, packs: loaded.packs.map((p) => p.packId), files: loaded.files }
}

/** One finding per line, in the shape editors and CI annotators already parse. */
export function formatFindings(findings: LintFinding[]): string {
  return findings.map((f) => `${f.file}: [${f.rule}] ${f.message}`).join('\n')
}
