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
const GCP_PROVIDER = `@rockysurf/${'provider'}-gcp`
const GOOGLE_AUTH = `google-${'auth'}-library`
const AZURE_PROVIDER = `@rockysurf/${'provider'}-azure`
const AZURE_ARM = `@azure/${'arm'}-compute`

interface Node {
  version: string
  dependencies?: Record<string, Node>
}

interface Result {
  status: number
  stdout: string
  stderr: string
  report: {
    ok: boolean
    violations: Array<{ rule: string; package: string; via: string; detail: string }>
    // Per-rule tallies. `azureInCli` is the one that is expected to be zero — see the azure
    // fixtures below for why a rule matching nothing still has to be asserted.
    counts: { core: number; cli: number; awsInCli: number; gcpInCli: number; azureInCli: number }
  }
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

  // The failing default carries zeroed counts so a run that never produced JSON is a failure
  // rather than a type error, and so `counts` is always readable by an assertion.
  let report: Result['report'] = {
    ok: false,
    violations: [],
    counts: { core: 0, cli: 0, awsInCli: 0, gcpInCli: 0, azureInCli: 0 },
  }
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
    [GCP_PROVIDER]: {
      version: 'link:../provider-gcp',
      dependencies: { [GOOGLE_AUTH]: { version: '11.0.1' } },
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
   * The same two rules for the second cloud library (`rockysurf-ev41.6`).
   *
   * `provider-gcp` declines `@google-cloud/compute` — 110MB unpacked — and talks to the REST
   * API with plain `fetch`, but it does take `google-auth-library` for Application Default
   * Credentials. That is a vendor package in the shipped closure, and the argument for
   * containing it is the one this check was built on and never was AWS-specific: core is loaded
   * by every installation, including the operator who will never call Google.
   */
  it('fails when Google’s auth library is anywhere in core’s closure', () => {
    const result = check(
      project('@rockysurf/core', {
        'some-helper': { version: '1.0.0', dependencies: { [GOOGLE_AUTH]: { version: '11.0.1' } } },
      }),
      cleanCli(),
    )

    expect(result.status).toBe(1)
    expect(result.report.violations).toHaveLength(1)
    expect(result.report.violations[0]?.rule).toBe('core-closure')
    expect(result.report.violations[0]?.via).toContain('some-helper')
  })

  it('fails when Google’s auth library reaches the CLI without passing through the GCP provider', () => {
    const result = check(
      cleanCore(),
      project('rockysurf', {
        'some-other-provider': { version: '1.0.0', dependencies: { [GOOGLE_AUTH]: { version: '11.0.1' } } },
      }),
    )

    expect(result.status).toBe(1)
    expect(result.report.violations[0]?.rule).toBe('gcp-entry-point')
  })

  /**
   * THE THIRD RULE GUARDS A PROPERTY RATHER THAN A PACKAGE (`rockysurf-ihtq.9`).
   *
   * `provider-azure` takes NO vendor SDK — it talks to ARM with plain `fetch`, and its whole
   * production closure is `@rockysurf/provider-sdk` and `zod`, both already in the tree. So the
   * `azure` rule matches nothing in this workspace today, and both of these tests exist because
   * a rule that matches nothing is otherwise indistinguishable from a rule that does not work.
   *
   * The first pins that a vacuous rule stays green. The second pins that it is live: the way
   * `@azure/arm-network` (43MB unpacked) and `arm-compute` (19.5MB) arrive is not somebody
   * adding them to core deliberately, it is a later helper that happens to depend on one,
   * through a name nobody reviewed — the exact arrival this whole check was written for.
   */
  it('stays green while no @azure/* package exists anywhere, and reports zero', () => {
    const result = check(cleanCore(), cleanCli())

    expect(result.status).toBe(0)
    expect(result.report.ok).toBe(true)
    expect(result.report.counts.azureInCli).toBe(0)
  })

  it('fires the moment an @azure/* package appears in core’s closure', () => {
    const result = check(
      project('@rockysurf/core', {
        'some-helper': { version: '1.0.0', dependencies: { [AZURE_ARM]: { version: '22.0.0' } } },
      }),
      cleanCli(),
    )

    expect(result.status).toBe(1)
    expect(result.report.violations).toHaveLength(1)
    expect(result.report.violations[0]?.rule).toBe('core-closure')
    expect(result.report.violations[0]?.via).toContain('some-helper')
  })

  it('fires when an @azure/* package reaches the CLI without passing through the Azure provider', () => {
    const result = check(
      cleanCore(),
      project('rockysurf', {
        'some-other-provider': { version: '1.0.0', dependencies: { [AZURE_ARM]: { version: '22.0.0' } } },
      }),
    )

    expect(result.status).toBe(1)
    expect(result.report.violations[0]?.rule).toBe('azure-entry-point')
    expect(result.report.violations[0]?.detail).toContain(AZURE_PROVIDER)
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
    const report = JSON.parse(run.stdout) as Result['report'] & {
      counts: { core: number; awsInCli: number; gcpInCli: number; azureInCli: number }
    }
    expect(report.ok).toBe(true)
    // Sanity on the data itself: a closure this small would mean the walk found nothing.
    expect(report.counts.core).toBeGreaterThan(5)
    expect(report.counts.awsInCli).toBeGreaterThan(5)
    // Google's auth library is a handful of packages rather than a fleet, which is the whole
    // reason it was an acceptable dependency where the GAPIC client was not.
    expect(report.counts.gcpInCli).toBeGreaterThan(0)
    // ZERO, and asserted rather than assumed: provider-azure declined the vendor SDK entirely,
    // so any @azure/* package in this closure would mean that decision had been reversed by
    // something nobody reviewed.
    expect(report.counts.azureInCli).toBe(0)
  })
})
