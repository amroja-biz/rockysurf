import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Proves `scripts/check-core-deps.mjs` actually fails when the boundary is crossed.
 *
 * A lint nobody has watched fail is a lint nobody knows works — and this one is the only
 * thing keeping core off the concrete providers, so "it passes on a clean tree" is not
 * evidence of anything. Every case below builds a throwaway repository in a temp directory,
 * injects one specific violation, and runs the real script against it.
 *
 * The trick that makes this cheap: the script derives its scan root from its own location
 * (`new URL('..', import.meta.url)`), so a copy placed at `<tmp>/scripts/` treats `<tmp>` as
 * the repository. Nothing about the script needs a test hook.
 *
 * WHY THE FORBIDDEN SPECIFIERS ARE ASSEMBLED FROM FRAGMENTS: this file lives under
 * `packages/core/src`, which the lint itself walks. Writing a forbidden package name inside a
 * literal `import … from '…'` here would make the real tree fail its own lint. Building the
 * specifier at run time keeps the raw source clean — and the last test in this file runs the
 * lint against the real repository, so a mistake here fails loudly rather than silently
 * disarming the check.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const realLint = join(repoRoot, 'scripts', 'check-core-deps.mjs')

const SDK = '@rockysurf/provider-sdk'
const CORE = '@rockysurf/core'
// Assembled, never written literally — see the note above.
const AWS = `@rockysurf/${'provider'}-aws`

interface LintResult {
  status: number
  stdout: string
  stderr: string
  violations: Array<{ package: string; file: string; line: number; kind: string; detail: string }>
}

const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

function write(root: string, relPath: string, contents: string): void {
  const full = join(root, relPath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, contents)
}

/** A miniature workspace that passes the lint, ready to have one violation injected. */
function makeCleanTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'rockysurf-lint-'))
  tempRoots.push(root)

  mkdirSync(join(root, 'scripts'), { recursive: true })
  copyFileSync(realLint, join(root, 'scripts', 'check-core-deps.mjs'))

  write(root, 'packages/provider-sdk/package.json', JSON.stringify({ name: SDK, version: '0.1.0' }))
  write(root, 'packages/provider-sdk/src/index.ts', 'export type ComputeProvider = { id: string }\n')

  write(
    root,
    'packages/core/package.json',
    JSON.stringify({ name: CORE, version: '0.1.0', dependencies: { [SDK]: 'workspace:*' } }),
  )
  write(root, 'packages/core/src/index.ts', `export { start } from './server.js'\n`)
  write(root, 'packages/core/src/server.ts', `import type { ComputeProvider } from '${SDK}'\nexport const start = (p: ComputeProvider) => p.id\n`)

  write(
    root,
    'packages/provider-aws/package.json',
    JSON.stringify({ name: AWS, version: '0.1.0', dependencies: { [SDK]: 'workspace:*' } }),
  )
  write(root, 'packages/provider-aws/src/index.ts', `import type { ComputeProvider } from '${SDK}'\nexport const make = (): ComputeProvider => ({ id: 'aws' })\n`)

  return root
}

function runLint(root: string): LintResult {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-core-deps.mjs'), '--json'], {
    encoding: 'utf8',
  })
  const stdout = result.stdout ?? ''
  let violations: LintResult['violations'] = []
  try {
    violations = (JSON.parse(stdout) as { violations: LintResult['violations'] }).violations
  } catch {
    // Left empty: a case that asserts on violations will fail on the empty array, and the
    // human-output test below reads stderr rather than JSON.
  }
  return { status: result.status ?? -1, stdout, stderr: result.stderr ?? '', violations }
}

/** `n` comment lines, then the statement — so the expected line number is `n + 1`. */
function fileWithStatementOnLine(line: number, statement: string): string {
  const padding = Array.from({ length: line - 1 }, (_, i) => `// filler ${i + 1}`)
  return [...padding, statement, 'export const used = true'].join('\n')
}

describe('the clean tree passes', () => {
  it('exits 0 and reports no violations', () => {
    const result = runLint(makeCleanTree())
    expect(result.status).toBe(0)
    expect(result.violations).toEqual([])
    expect(JSON.parse(result.stdout).ok).toBe(true)
  })
})

describe('core reaching a concrete provider fails the lint', () => {
  it('exits non-zero and names the file and line of the import', () => {
    const root = makeCleanTree()
    // The import lands on line 12 of the file.
    write(root, 'packages/core/src/registry.ts', fileWithStatementOnLine(12, `import { make } from '${AWS}'`))

    const result = runLint(root)

    expect(result.status).toBe(1)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toEqual({
      package: CORE,
      file: 'packages/core/src/registry.ts',
      line: 12,
      kind: 'import',
      detail: `imports ${AWS}`,
    })
  })

  it('reports the line of the statement, not the newline before it', () => {
    // Regression: every pattern opens with `(?:^|\s)`, and `^` only matches index 0 without
    // the `m` flag, so the engine used to match the newline ENDING the previous line and
    // report every import one line early. An off-by-one here sends a developer to the wrong
    // line of someone else's file, which is worse than no line at all.
    const root = makeCleanTree()
    for (const line of [1, 2, 9, 40]) {
      write(root, `packages/core/src/at-${line}.ts`, fileWithStatementOnLine(line, `import { make } from '${AWS}'`))
    }

    const byFile = new Map(runLint(root).violations.map((v) => [v.file, v.line]))

    expect(byFile.get('packages/core/src/at-1.ts')).toBe(1)
    expect(byFile.get('packages/core/src/at-2.ts')).toBe(2)
    expect(byFile.get('packages/core/src/at-9.ts')).toBe(9)
    expect(byFile.get('packages/core/src/at-40.ts')).toBe(40)
  })

  it('prints file:line to stderr in human mode', () => {
    const root = makeCleanTree()
    write(root, 'packages/core/src/registry.ts', fileWithStatementOnLine(7, `import { make } from '${AWS}'`))

    const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-core-deps.mjs')], { encoding: 'utf8' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('packages/core/src/registry.ts:7')
    expect(result.stderr).toContain('1 violation(s)')
  })

  it('catches a deep import, not just the bare package name', () => {
    const root = makeCleanTree()
    write(root, 'packages/core/src/deep.ts', `import { thing } from '${AWS}/dist/internal.js'\n`)

    const result = runLint(root)

    expect(result.status).toBe(1)
    expect(result.violations[0]?.detail).toBe(`imports ${AWS}/dist/internal.js`)
  })

  it('catches dynamic import() and require(), not only static imports', () => {
    const root = makeCleanTree()
    write(root, 'packages/core/src/lazy.ts', `export const load = async () => import('${AWS}')\n`)
    write(root, 'packages/core/src/legacy.cjs', `const aws = require('${AWS}')\nmodule.exports = aws\n`)

    const result = runLint(root)

    expect(result.status).toBe(1)
    expect(result.violations.map((v) => v.file).sort()).toEqual([
      'packages/core/src/lazy.ts',
      'packages/core/src/legacy.cjs',
    ])
  })

  it('catches a declared dependency even with no import anywhere', () => {
    const root = makeCleanTree()
    write(
      root,
      'packages/core/package.json',
      JSON.stringify({ name: CORE, version: '0.1.0', dependencies: { [SDK]: 'workspace:*', [AWS]: 'workspace:*' } }),
    )

    const result = runLint(root)

    expect(result.status).toBe(1)
    expect(result.violations[0]).toMatchObject({
      package: CORE,
      file: 'packages/core/package.json',
      kind: 'dependency',
      detail: `dependencies contains ${AWS}`,
    })
  })

  it('catches a provider hidden in devDependencies', () => {
    const root = makeCleanTree()
    write(
      root,
      'packages/core/package.json',
      JSON.stringify({ name: CORE, version: '0.1.0', devDependencies: { [AWS]: 'workspace:*' } }),
    )

    expect(runLint(root).violations[0]?.detail).toBe(`devDependencies contains ${AWS}`)
  })
})

describe('a provider reaching core fails the lint', () => {
  it('flags the provider, not core', () => {
    const root = makeCleanTree()
    write(root, 'packages/provider-aws/src/wrong.ts', fileWithStatementOnLine(3, `import { start } from '${CORE}'`))

    const result = runLint(root)

    expect(result.status).toBe(1)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toMatchObject({
      package: AWS,
      file: 'packages/provider-aws/src/wrong.ts',
      line: 3,
      kind: 'import',
    })
  })
})

describe('the real repository', () => {
  it('passes its own dependency lint', () => {
    // Also the guard on this file: if the fixtures above ever leave a literal forbidden
    // specifier in real source, this is what fails.
    const result = spawnSync(process.execPath, [realLint, '--json'], { encoding: 'utf8' })
    const parsed = JSON.parse(result.stdout ?? '{}') as { ok: boolean; violations: unknown[] }

    expect(parsed.violations).toEqual([])
    expect(parsed.ok).toBe(true)
    expect(result.status).toBe(0)
  })
})
