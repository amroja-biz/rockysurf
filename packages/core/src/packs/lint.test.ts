import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { formatFindings, lintPacksDir, type LintRule } from './lint.js'

/**
 * The author contract as a check, tested the way a merge gate has to be tested: mostly by
 * breaking things.
 *
 * A lint whose only test is "the shipped packs pass" is a lint that could be `return []`. Every
 * rule here gets a fixture that violates it, because the failure mode of a rule that has
 * stopped matching is SILENCE — a passing check looks exactly like a clean directory. That is
 * the same reasoning `scripts/gitleaks-selftest.mjs` is built on.
 */

const shippedPacksDir = fileURLToPath(new URL('../../../../packs/', import.meta.url))

const scratchDirs: string[] = []
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const TOOL = {
  toolId: 'a-tool',
  name: 'A tool',
  description: 'Does a thing',
  category: 'base',
  url: 'https://example.com',
  installScript: 'echo hi\n',
  enabled: true,
  installOrder: 30,
  bootstrap: false,
  runAs: 'root',
}

const PACK = { packId: 'a-pack', name: 'A pack', tools: ['a-tool'], displayOrder: 1, enabled: true }

/** JSON is valid YAML, so fixtures stay readable as objects rather than as indented text. */
function dirWith(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'rockysurf-lint-'))
  scratchDirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return dir
}

/**
 * One pack, one tool, with the tool's fields overridden. The usual fixture.
 *
 * `setupScript` is spelled out because the base fixture omits it — it is optional in the
 * format — and half these tests exist to prove the rules reach it.
 */
const withTool = (overrides: Partial<typeof TOOL> & { setupScript?: string }) =>
  dirWith({ 'a-pack.yaml': { version: 1, pack: PACK, tools: [{ ...TOOL, ...overrides }] } })

const rulesFired = (dir: string, basePacksDirs?: string[]): LintRule[] =>
  lintPacksDir({ dir, ...(basePacksDirs ? { basePacksDirs } : {}) }).findings.map((f) => f.rule)

describe('the reference implementation passes its own contract', () => {
  it('this repository’s packs/ lints clean', () => {
    // A contract the shipped packs violate is not a contract. `packs.test.ts` asserts the same
    // thing through the loader; this asserts it through the check contributors are told to run,
    // which is the one that has to agree with them.
    const report = lintPacksDir({ dir: shippedPacksDir })
    expect(formatFindings(report.findings)).toBe('')
    expect(report.packs.length).toBeGreaterThan(0)
  })
})

describe('format findings come through from the loader', () => {
  it('reports invalid YAML', () => {
    expect(rulesFired(dirWith({ 'a-pack.yaml': 'pack: [unclosed\n' }))).toContain('format')
  })

  it('reports a schema violation rather than ignoring an unknown key', () => {
    const dir = dirWith({ 'a-pack.yaml': { version: 1, pack: { ...PACK, requiresRDP: true }, tools: [TOOL] } })
    expect(lintPacksDir({ dir }).findings.some((f) => f.message.includes('requiresRDP'))).toBe(true)
  })

  it('reports a packId that disagrees with its filename', () => {
    const dir = dirWith({ 'something-else.yaml': { version: 1, pack: PACK, tools: [TOOL] } })
    expect(lintPacksDir({ dir }).findings.some((f) => f.message.includes('does not match the filename'))).toBe(true)
  })

  it('reports a duplicate toolId within one directory', () => {
    const dir = dirWith({
      'a-pack.yaml': { version: 1, pack: PACK, tools: [TOOL] },
      'b-pack.yaml': { version: 1, pack: { ...PACK, packId: 'b-pack' }, tools: [TOOL] },
    })
    expect(lintPacksDir({ dir }).findings.some((f) => f.message.includes('already defined'))).toBe(true)
  })

  it('reports a reference to a tool nothing defines', () => {
    const dir = dirWith({ 'a-pack.yaml': { version: 1, pack: { ...PACK, tools: ['nope'] }, tools: [] } })
    expect(lintPacksDir({ dir }).findings.some((f) => f.message.includes('unknown tool "nope"'))).toBe(true)
  })
})

describe('base pack directories', () => {
  // The reason this option exists: a directory holding one community pack is the normal case
  // in the shop, and every base tool it correctly references would otherwise be a finding.
  const community = () =>
    dirWith({
      'rust-dev.yaml': {
        version: 1,
        pack: { packId: 'rust-dev', name: 'Rust', tools: ['claude-code'], displayOrder: 9, enabled: true },
        tools: [],
      },
    })

  it('a reference the base satisfies is not a finding', () => {
    expect(rulesFired(community(), [shippedPacksDir])).toEqual([])
  })

  it('the same directory fails without the base, so the option is doing the work', () => {
    expect(rulesFired(community())).toContain('format')
  })

  it('redefining a tool the base owns is a finding the loader alone cannot see', () => {
    // It matters more than a style point: the loader rejects a toolId defined twice, so this
    // pack would break the operator's whole catalog on the next boot, not only itself.
    const dir = dirWith({
      'a-pack.yaml': { version: 1, pack: PACK, tools: [{ ...TOOL, toolId: 'claude-code' }] },
    })
    const findings = lintPacksDir({ dir, basePacksDirs: [shippedPacksDir] }).findings
    expect(findings.some((f) => f.rule === 'duplicate-tool')).toBe(true)
    expect(findings.some((f) => f.message.includes('ai-coding-agents.yaml'))).toBe(true)
  })

  it('a base directory that does not itself validate is reported, not swallowed', () => {
    // Otherwise the target is told it references an unknown tool, when the truth is that the
    // file defining it failed to parse — the cascade rockysurf-37pa measured at boot, arriving
    // here instead.
    const brokenBase = dirWith({ 'base.yaml': 'tools: [unclosed\n' })
    const findings = lintPacksDir({ dir: community(), basePacksDirs: [brokenBase] }).findings
    expect(findings.some((f) => f.message.includes('base pack directory does not validate'))).toBe(true)
  })
})

describe('the four author rules, each with a fixture that breaks it', () => {
  it.each([
    [
      'rule 2: an architecture named without branching on $ARCH',
      'arch-aware' as const,
      { installScript: 'curl -o t https://example.com/t-x86_64\n' },
    ],
    [
      'rule 3: apt-get install without -y',
      'non-interactive' as const,
      { installScript: 'apt-updated\napt-get install ripgrep\n' },
    ],
    ['rule 3: npx without --yes', 'non-interactive' as const, { installScript: 'npx some-tool\n' }],
    ['rule 3: read -p', 'non-interactive' as const, { installScript: 'read -p "which one? " answer\n' }],
    [
      'rule 4: sudo inside a runAs: rocky script',
      'run-as-honest' as const,
      { runAs: 'rocky', installScript: 'sudo apt-get install -y thing\n' },
    ],
    [
      'rule 1: an unguarded append',
      'idempotent' as const,
      { installScript: 'echo "export PATH=$PATH:/opt/bin" >> ~/.bashrc\n' },
    ],
    ['rule 1: a cache-busted download', 'idempotent' as const, { installScript: 'curl "https://x/y?$(date +%s)"\n' }],
    ['the AWS CLI', 'assumes-too-much' as const, { installScript: 'aws s3 cp thing .\n' }],
    ['an s3:// URL', 'assumes-too-much' as const, { installScript: 'curl s3://bucket/thing\n' }],
    ['the metadata service', 'assumes-too-much' as const, { installScript: 'curl http://169.254.169.254/x\n' }],
    [
      'apt-get install with no package-list refresh',
      'assumes-too-much' as const,
      { installScript: 'apt-get install -y ripgrep\n' },
    ],
    [
      'a latest-release lookup against api.github.com',
      'assumes-too-much' as const,
      { installScript: 'v=$(curl -fsSL https://api.github.com/repos/o/r/releases/latest)\n' },
    ],
    ['the reserved bootstrap flag', 'reserved-field' as const, { bootstrap: true }],
    ['an installOrder outside the documented bands', 'format' as const, { installOrder: 999 }],
  ])('fires on %s', (_label, rule, overrides) => {
    expect(rulesFired(withTool(overrides))).toContain(rule)
  })

  it('checks setupScript as well as installScript, naming which one', () => {
    // Half the contract would otherwise be unenforced: setupScript runs on the same box with
    // the same privileges and the same resume semantics.
    const findings = lintPacksDir({ dir: withTool({ setupScript: 'read -p "hi" x\n' }) }).findings
    expect(findings.some((f) => f.message.startsWith('a-tool.setupScript'))).toBe(true)
  })

  it('does not fire on the correct spelling of each rule', () => {
    // The failure mode that matters: a regex loose enough to match a compliant script makes the
    // gate unusable, and a regex that never matches makes it worthless. This is the first half.
    const compliant = withTool({
      runAs: 'rocky',
      installScript:
        'set -euo pipefail\n' +
        'case "$ARCH" in amd64) f=t-x86_64 ;; arm64) f=t-aarch64 ;; esac\n' +
        'curl -fsSL "https://example.com/$f" -o /tmp/t\n' +
        'grep -q "/opt/bin" ~/.bashrc || echo "export PATH=$PATH:/opt/bin" >> ~/.bashrc\n',
    })
    expect(rulesFired(compliant)).toEqual([])
  })

  /**
   * A rule that reads comments cannot tell an instruction from an explanation (rockysurf-c6cm).
   *
   * This is not hypothetical tidiness: the fix that removed the `api.github.com` calls from
   * `packs/ai-coding-agents.yaml` replaced them with paragraphs naming that endpoint, because a
   * pinned download with no explanation is a thing the next person quietly reverts. Firing on
   * those paragraphs would mean the rule's own documentation fails the rule.
   */
  it('reads what a script does, not what its comments say about it', () => {
    const explained = withTool({
      runAs: 'rocky',
      installScript:
        'set -euo pipefail\n' +
        '# PINNED rather than asking api.github.com, whose quota is keyed on source IP.\n' +
        'curl -fsSL "https://github.com/o/r/releases/download/v1/r_linux_$ARCH.tar.gz" -o /tmp/t\n',
    })
    expect(rulesFired(explained)).toEqual([])
  })

  it('still fires on a call that shares its line with a comment', () => {
    // Only WHOLE-line comments are blanked. Otherwise the blindness above becomes a way to hide
    // a real call by parking a `#` after it.
    const inline = withTool({
      installScript: 'curl https://api.github.com/repos/o/r/releases/latest  # just the tag\n',
    })
    expect(rulesFired(inline)).toContain('assumes-too-much')
  })
})

describe('formatFindings', () => {
  it('names the file and the rule on every line, so CI can annotate', () => {
    const findings = lintPacksDir({ dir: withTool({ bootstrap: true }) }).findings
    expect(formatFindings(findings)).toMatch(/^a-pack\.yaml: \[reserved-field\] /)
  })

  it('is empty for a clean report, so callers can test it directly', () => {
    expect(formatFindings([])).toBe('')
  })
})

describe('an empty or absent directory', () => {
  it('reports no files rather than pretending to have checked something', () => {
    // The commonest way to get a green lint you have not earned is to point it at the wrong
    // path. `files` is what lets the CLI refuse that; a bare findings count cannot tell the
    // difference between "clean" and "nothing was there".
    const report = lintPacksDir({ dir: join(dirWith({}), 'does-not-exist') })
    expect(report).toMatchObject({ findings: [], packs: [], files: [] })
  })
})
