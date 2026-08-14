#!/usr/bin/env node
/**
 * The pack smoke test for THIS repository's `packs/` — `docs/writing-a-pack.md` § "The CI smoke
 * test" specifies it as NORMATIVE and merge-gating.
 *
 *   node scripts/pack-smoke.mjs [--pack <id>] [--arch amd64|arm64] [--keep] [--json]
 *
 * THE HARNESS ITSELF IS NO LONGER HERE. It moved to
 * `packages/rockysurf/src/cli/pack-smoke.ts` and is published as `rockysurf pack check`
 * (rockysurf-arym.2), because `amroja-biz/rockysurf-shop` has to gate community packs with the
 * same code and cannot import a script out of this repository. What is left is the caller that
 * points it at `packs/` and keeps the flags CI already passes.
 *
 * This file exists rather than CI calling the command directly for one reason worth stating:
 * it runs the harness from the BUILT `packages/rockysurf/dist`, so the thing gating a merge is
 * the artifact a release publishes. A bug introduced by the build is in scope, which was true
 * of the old deep-import version too and is the property most easily lost in a move like this.
 *
 * Exits 0 when every pack passes, 1 on any failure, 2 when the check could not be run.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const packsDir = join(repoRoot, 'packs')
const cliDist = join(repoRoot, 'packages/rockysurf/dist')

if (!existsSync(join(cliDist, 'cli/pack-smoke.js'))) {
  console.error(`rockysurf is not built (${cliDist} has no cli/pack-smoke.js).\nRun: pnpm -r build`)
  process.exit(2)
}

const { runPackCheck, PackCheckSetupError, ARCHITECTURES } = await import(
  pathToFileURL(join(cliDist, 'cli/pack-smoke.js')).href
)

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}
const arch = flag('--arch', process.arch === 'arm64' ? 'arm64' : 'amd64')
const only = flag('--pack', null)
const jsonOut = args.includes('--json')

if (!ARCHITECTURES.includes(arch)) {
  console.error(`--arch must be ${ARCHITECTURES.join(' or ')}, got "${arch}"`)
  process.exit(2)
}

try {
  const report = runPackCheck({
    dir: packsDir,
    arch,
    ...(only ? { only } : {}),
    keep: args.includes('--keep'),
    // Under --json stdout carries only the document, so progress goes to stderr.
    log: (line) => (jsonOut ? console.error(line) : console.log(line)),
    logFailure: (text) => console.error(text),
  })

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    const failed = report.results.flatMap((r) => r.checks).filter((c) => !c.ok).length
    console.log()
    console.log(
      report.ok ? `pack smoke (${report.arch}): all checks passed` : `pack smoke (${report.arch}): ${failed} check(s) failed`,
    )
  }
  process.exit(report.ok ? 0 : 1)
} catch (err) {
  console.error(err instanceof PackCheckSetupError ? err.message : err instanceof Error ? err.message : String(err))
  process.exit(2)
}
