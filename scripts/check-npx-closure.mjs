#!/usr/bin/env node
/**
 * npx closure analysis (rockysurf-ftl9.4).
 *
 * `scripts/check-core-deps.mjs` guards the workspace EDGES: which package may name which. This
 * one guards the CLOSURE — everything that actually lands in `node_modules` once those edges
 * are resolved transitively — and asserts the one property the edge lint cannot see:
 *
 *   THE AWS SDK IS NOT IN `@rockysurf/core`'s PRODUCTION DEPENDENCY CLOSURE.
 *
 * Why that is worth its own check. `@aws-sdk/client-ec2` and `@aws-sdk/client-ssm` are the two
 * heaviest things this project installs, by a wide margin. Core is the package every
 * installation loads on every start, so anything in its closure is paid for by everyone,
 * including the operator who runs Hetzner or BYO and will never call an AWS API. The edge lint
 * would not notice: nobody adds `@aws-sdk/client-ec2` to core's package.json, they add a small
 * helper that happens to depend on it, and the cost arrives through a name nobody reviewed.
 *
 * WHAT THIS CHECK DOES NOT CLAIM. `npx rockysurf` installs `rockysurf`, not core, and rockysurf
 * IS the composition root — it imports `@rockysurf/provider-aws` statically, so an npx install
 * does download the AWS SDK and does load it at startup. The property enforced here is
 * narrower and honest about it: the SDK enters that closure ONLY through `provider-aws`, so it
 * remains removable by dropping one provider, and core stays deployable without it. Second
 * assertion below, `--json` reports both.
 *
 * Data source is `pnpm list --prod --depth Infinity --json`: the resolved tree, not the
 * manifests, so a transitive arrival is visible. `ROCKYSURF_PNPM` overrides the binary, which
 * is the seam the test uses to feed it a tree with a violation in it.
 *
 * Usage: node scripts/check-npx-closure.mjs [--json]
 * Exits 0 when clean, 1 on any violation, 2 when the dependency tree could not be read.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const PNPM = process.env['ROCKYSURF_PNPM'] ?? 'pnpm'

/**
 * The vendor closures this check guards, one row per cloud SDK.
 *
 * THE RULE GENERALIZED WHEN THE SECOND CLOUD LIBRARY ARRIVED. It was written for the AWS SDK
 * alone, but its argument never was AWS-specific: core is loaded by every installation,
 * including the operator who runs Hetzner and will never call the other cloud's API, and the
 * cost arrives through a name nobody reviewed because nobody adds a vendor SDK to core's
 * package.json — they add a small helper that happens to depend on one.
 *
 * `provider-gcp` deliberately does NOT take `@google-cloud/compute` (110MB unpacked, a
 * generated GAPIC client) and talks to the REST API with plain `fetch` instead. What it does
 * take is `google-auth-library` for Application Default Credentials, which is the entry named
 * below along with the transitive packages that only ever arrive with it.
 *
 * Package names are assembled from fragments for the same reason `dependency-lint.test.ts`
 * does it: this repo greps itself, and a bare literal is one careless copy away from being read
 * as an import.
 */
const VENDOR_RULES = [
  {
    id: 'aws',
    pattern: /^@aws-sdk\/|^aws-sdk$/,
    provider: `@rockysurf/${'provider'}-aws`,
    label: 'the AWS SDK',
  },
  {
    id: 'gcp',
    pattern: /^google-auth-library$|^gcp-metadata$|^gtoken$|^gaxios$/,
    provider: `@rockysurf/${'provider'}-gcp`,
    label: "Google's auth library",
  },
  {
    /**
     * A rule that currently matches NOTHING, and is here for exactly that reason.
     *
     * `provider-azure` takes no vendor SDK at all — it talks to ARM with plain `fetch`, and its
     * whole production closure is `@rockysurf/provider-sdk` and `zod`, both of which were in the
     * tree already. So unlike the two rules above, this one guards a property rather than
     * policing a package that exists: `@azure/arm-network` alone is 43 MB unpacked and
     * `arm-compute` another 19.5 MB, and the way that arrives is not somebody adding it to core
     * on purpose — it is a later helper that happens to depend on it, through a name nobody
     * reviewed.
     *
     * `azureInCli` is therefore expected to be ZERO, and the fixtures assert both halves: that a
     * rule matching nothing keeps the check green, and that it fires the moment an @azure/*
     * package appears anywhere it should not.
     */
    id: 'azure',
    pattern: /^@azure\//,
    provider: `@rockysurf/${'provider'}-azure`,
    label: 'the Azure SDK',
  },
]

/** Anything matching any rule must not be in core's closure. */
const FORBIDDEN_IN_CORE = (name) => VENDOR_RULES.some((rule) => rule.pattern.test(name))

/** Workspace path filters, so the root package — which is also called `rockysurf` — cannot match. */
const CORE = './packages/core'
const CLI = './packages/rockysurf'

/**
 * The resolved production tree for one workspace package.
 *
 * `--depth Infinity` expands workspace links too, so a dependency reached through
 * `@rockysurf/provider-sdk` is as visible as a direct one.
 */
function readTree(filter) {
  let raw
  try {
    raw = execFileSync(PNPM, ['list', '--filter', filter, '--prod', '--depth', 'Infinity', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(
      `could not read the dependency tree for ${filter}: ${detail}\n` +
        'This check reads the INSTALLED tree, so it needs `pnpm install` to have run.',
    )
  }

  const parsed = JSON.parse(raw)
  const roots = Array.isArray(parsed) ? parsed : [parsed]
  if (roots.length !== 1) {
    throw new Error(`expected exactly one project for ${filter}, got ${roots.length}`)
  }
  return roots[0]
}

/**
 * Walk the tree, returning every package name in it and the first path found to each.
 *
 * Cycles are real in npm trees, so a node is expanded once. The first path to a name is kept
 * because it is the one a reader can act on — a violation report is only useful if it says
 * which dependency dragged the package in.
 *
 * ONLY NODES THAT CARRY CHILDREN COUNT AS EXPANDED. pnpm prints a package's subtree once and
 * repeats it later as a bare entry, and the bare copy is not always the second one: marking
 * `name@version` done on sight made the walk stop at whichever copy came first and silently
 * lost 75 of the CLI's 138 packages — including most of the AWS SDK, which is the exact thing
 * this check exists to find.
 */
export function walkClosure(root) {
  /** @type {Map<string, string[]>} name → the chain that reached it, root first. */
  const paths = new Map()
  const expanded = new Set()

  const visit = (deps, trail) => {
    for (const [name, node] of Object.entries(deps ?? {})) {
      if (!paths.has(name)) paths.set(name, [...trail, name])

      const children = node?.dependencies
      if (!children || Object.keys(children).length === 0) continue

      const key = `${name}@${node?.version ?? '?'}`
      if (expanded.has(key)) continue
      expanded.add(key)

      visit(children, [...trail, name])
    }
  }

  visit(root.dependencies, [root.name])
  return paths
}

/**
 * Both rules, against two already-walked closures.
 *
 * Kept a pure function of its inputs so the test can hand it a tree with a violation in it
 * without needing a workspace that has one.
 */
export function analyze(coreClosure, cliClosure) {
  const violations = []

  for (const [name, path] of coreClosure) {
    if (FORBIDDEN_IN_CORE(name)) {
      violations.push({
        rule: 'core-closure',
        package: name,
        via: path.join(' → '),
        detail: `${name} is in @rockysurf/core's production closure`,
      })
    }
  }

  /** Per rule: which of its packages are in the CLI, and whether each arrived legitimately. */
  const inCli = Object.fromEntries(VENDOR_RULES.map((rule) => [rule.id, []]))

  for (const [name, path] of cliClosure) {
    const rule = VENDOR_RULES.find((candidate) => candidate.pattern.test(name))
    if (!rule) continue
    inCli[rule.id].push(name)
    if (!path.includes(rule.provider)) {
      violations.push({
        rule: `${rule.id}-entry-point`,
        package: name,
        via: path.join(' → '),
        detail: `${name} reaches the shipped CLI without passing through ${rule.provider}`,
      })
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    counts: {
      core: coreClosure.size,
      cli: cliClosure.size,
      // Kept under this name because it is the shape this check has always reported.
      awsInCli: inCli['aws'].length,
      gcpInCli: inCli['gcp'].length,
      // Expected to be 0: provider-azure takes no vendor SDK. See the rule's own note.
      azureInCli: inCli['azure'].length,
    },
  }
}

function main() {
  let result
  try {
    result = analyze(walkClosure(readTree(CORE)), walkClosure(readTree(CLI)))
  } catch (err) {
    console.error(`npx closure check: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2))
  } else if (result.ok) {
    console.log('npx closure check: OK')
    console.log(`  @rockysurf/core: ${result.counts.core} production packages, no vendor cloud SDK among them.`)
    console.log(`  rockysurf: ${result.counts.cli} packages, of which ${result.counts.awsInCli} are the AWS SDK`)
    console.log(`  and ${result.counts.gcpInCli} are Google's auth library. Each arrives only through its own`)
    console.log('  provider package, so core stays deployable without any of them.')
    console.log(`  @azure/*: ${result.counts.azureInCli} — provider-azure takes no vendor SDK, and the rule is here to`)
    console.log('  keep it that way.')
  } else {
    console.error(`npx closure check: ${result.violations.length} violation(s)\n`)
    for (const v of result.violations) {
      console.error(`  ${v.detail}\n    via ${v.via}`)
    }
    console.error('\nA vendor cloud SDK is among the heaviest things this project installs, and core is')
    console.error('loaded by every installation — including the ones that will never call that cloud.')
    console.error('Keep each one behind its own provider package, which only the composition root imports.')
  }

  process.exit(result.ok ? 0 : 1)
}

// Importable for tests; runs only when executed directly.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
