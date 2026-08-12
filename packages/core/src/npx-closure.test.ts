import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Proves `scripts/check-npx-closure.mjs` fails when the AWS SDK gets into core's closure.
 *
 * Same argument as `dependency-lint.test.ts`: a check nobody has watched fail is a check
 * nobody knows works. This one is harder to trust than the edge lint, because it can only be
 * violated TRANSITIVELY — nobody puts `@aws-sdk/client-ec2` in core's package.json, it arrives
 * through some small helper — so "it passes on a clean tree" says nothing at all.
 *
 * The seam: the script reads the resolved tree by running `pnpm list --json`, and takes the
 * binary from `ROCKYSURF_PNPM`. Each case below points that at a stub which prints a tree with
 * one specific problem in it, so no fixture workspace has to be installed to test a dependency
 * graph.
 *
 * WHY THE PACKAGE NAMES ARE ASSEMBLED FROM FRAGMENTS: this file lives under
 * `packages/core/src`, which `check-core-deps.mjs` walks. The names below are only ever object
 * keys, never import specifiers, but the neighbouring test file established the habit for a
 * good reason and a future edit that turns one into an import should not be one keystroke away
 * from breaking the other lint.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const script = join(repoRoot, 'scripts', 'check-npx-closure.mjs')

const AWS_PROVIDER = `@rockysurf/${'provider'}-aws`
const AWS_EC2 = `@aws-sdk/${'client'}-ec2`

interface Node {
  version: string
  dependencies?: Record<string, Node>
}

interface Result {
  status: number
  stdout: string
  stderr: string
  report: { ok: boolean; violations: Array<{ rule: string; package: string; via: string; detail: string }> }
}

const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

function project(name: string, dependencies: Record<string, Node>): unknown {
  return [{ name, version: '0.1.0', path: `/fake/${name}`, private: true, dependencies }]
}

/**
 * Run the real script against two fixture trees.
 *
 * The stub stands in for pnpm: it looks at the `--filter` it was handed and prints the matching
 * fixture, which is exactly the contract the script depends on and nothing more.
 */
function check(coreTree: unknown, cliTree: unknown): Result {
  const root = mkdtempSync(join(tmpdir(), 'rockysurf-closure-'))
  tempRoots.push(root)
  mkdirSync(join(root, 'fixtures'), { recursive: true })
  writeFileSync(join(root, 'fixtures', 'core.json'), JSON.stringify(coreTree))
  writeFileSync(join(root, 'fixtures', 'cli.json'), JSON.stringify(cliTree))

  const stub = join(root, 'pnpm-stub.mjs')
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env node',
      "import { readFileSync } from 'node:fs'",
      "const filter = process.argv[process.argv.indexOf('--filter') + 1]",
      `const dir = ${JSON.stringify(join(root, 'fixtures'))}`,
      "process.stdout.write(readFileSync(`${dir}/${filter.includes('core') ? 'core' : 'cli'}.json`, 'utf8'))",
      '',
    ].join('\n'),
    { mode: 0o755 },
  )

  const run = spawnSync(process.execPath, [script, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, ROCKYSURF_PNPM: stub },
  })

  let report = { ok: false, violations: [] as Result['report']['violations'] }
  try {
    report = JSON.parse(run.stdout) as typeof report
  } catch {
    // Left as the failing default; the assertions on status and stderr say what happened.
  }
  return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr, report }
}

/** A closure with nothing objectionable in it. */
function cleanCore(): unknown {
  return project('@rockysurf/core', {
    hono: { version: '4.13.1' },
    zod: { version: '4.4.3' },
  })
}

function cleanCli(): unknown {
  return project('rockysurf', {
    '@rockysurf/core': { version: 'link:../core', dependencies: { hono: { version: '4.13.1' } } },
    [AWS_PROVIDER]: {
      version: 'link:../provider-aws',
      dependencies: { [AWS_EC2]: { version: '3.1108.0' } },
    },
  })
}

describe('check-npx-closure', () => {
  it('passes when the AWS SDK reaches the CLI only through the AWS provider', () => {
    const result = check(cleanCore(), cleanCli())
    expect(result.status).toBe(0)
    expect(result.report.ok).toBe(true)
  })

  it('fails when the AWS SDK is anywhere in core’s closure', () => {
    const result = check(
      project('@rockysurf/core', {
        'some-helper': { version: '1.0.0', dependencies: { [AWS_EC2]: { version: '3.1108.0' } } },
      }),
      cleanCli(),
    )

    expect(result.status).toBe(1)
    expect(result.report.violations).toHaveLength(1)
    expect(result.report.violations[0]?.rule).toBe('core-closure')
    // The path is the actionable half: it names the dependency that dragged it in.
    expect(result.report.violations[0]?.via).toContain('some-helper')
  })

  it('fails when the AWS SDK reaches the CLI without passing through the AWS provider', () => {
    const result = check(
      cleanCore(),
      project('rockysurf', {
        'some-other-provider': { version: '1.0.0', dependencies: { [AWS_EC2]: { version: '3.1108.0' } } },
      }),
    )

    expect(result.status).toBe(1)
    expect(result.report.violations[0]?.rule).toBe('aws-entry-point')
  })

  /**
   * THE REGRESSION THAT MADE THIS FILE WORTH WRITING.
   *
   * pnpm prints a package's subtree once and repeats it later as a bare entry with no
   * children — and the bare copy can come FIRST. A walk that marks `name@version` as seen on
   * sight therefore stops at the childless copy and never reaches what is underneath it. The
   * first version of this script did exactly that and lost 75 of the CLI's 138 packages,
   * including most of the AWS SDK, while reporting a clean run.
   */
  it('finds a package underneath a subtree pnpm printed bare the first time', () => {
    const result = check(
      project('@rockysurf/core', {
        // The bare copy, listed first.
        'helper-a': { version: '1.0.0', dependencies: { shared: { version: '2.0.0' } } },
        // The same package again, this time with its children.
        'helper-b': {
          version: '1.0.0',
          dependencies: {
            shared: { version: '2.0.0', dependencies: { [AWS_EC2]: { version: '3.1108.0' } } },
          },
        },
      }),
      cleanCli(),
    )

    expect(result.status).toBe(1)
    expect(result.report.violations[0]?.package).toBe(AWS_EC2)
  })

  /**
   * The real repository, through the real pnpm. Every case above proves the script can fail;
   * this one proves the thing it is guarding is currently true.
   */
  it('passes against this workspace', () => {
    const run = spawnSync(process.execPath, [script, '--json'], { encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    const report = JSON.parse(run.stdout) as Result['report'] & { counts: { core: number; awsInCli: number } }
    expect(report.ok).toBe(true)
    // Sanity on the data itself: a closure this small would mean the walk found nothing.
    expect(report.counts.core).toBeGreaterThan(5)
    expect(report.counts.awsInCli).toBeGreaterThan(5)
  })
})
