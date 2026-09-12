#!/usr/bin/env node
/**
 * Print the rendered InstallPlan of every pack in `packs/`, as a diffable document.
 *
 *   node scripts/pack-plans.mjs > before.txt   # on the old tree
 *   node scripts/pack-plans.mjs > after.txt    # on the new one
 *   diff before.txt after.txt                  # must be empty for a refactor
 *
 * WHY THIS EXISTS. Moving Tool definitions between files (issue #499 moved the shared base
 * toolchain out of `packs/claude-code.yaml` into `packs/base.yaml`) is supposed to change
 * nothing about what any box installs. Nothing in the test suite could say that: the suite
 * checks that every reference resolves and that every file lints, both of which stay true if a
 * script's body or a step's order changed on the way across. "The same tools in the same order
 * with the same scripts" is a property of the RENDERED PLAN, so this renders it.
 *
 * It uses core's own loader and core's own resolver — the same two `rockysurf pack check` uses
 * — because a comparison against a plan this script rendered its own way would prove nothing
 * about the plan a real create runs. Every per-attempt input (serverId, runId) is a fixed
 * literal so two runs of this script differ only where the packs differ; scripts are reported
 * as sha256 so the document stays readable and still catches a one-character edit.
 *
 * Exits 0 on success, 2 when the workspace is not built.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const packsDir = join(repoRoot, 'packs')
const coreDist = join(repoRoot, 'packages/core/dist/index.js')

if (!existsSync(coreDist)) {
  console.error(`@rockysurf/core is not built (${coreDist} is missing).\nRun: pnpm -r build`)
  process.exit(2)
}

const { loadPacksFromDir, resolveInstallPlan } = await import(pathToFileURL(coreDist).href)

const loaded = loadPacksFromDir(packsDir)
if (loaded.issues.length > 0) {
  console.error(`${packsDir} does not validate, so no plan can be rendered:`)
  for (const issue of loaded.issues) console.error(`  ${issue.file}: ${issue.message}`)
  process.exit(2)
}

/** The loader speaks the file format; the resolver speaks the database's. Same mapping as the smoke harness. */
const toToolRow = (t) => ({
  id: t.toolId,
  name: t.name,
  description: t.description,
  category: t.category,
  url: t.url,
  installScript: t.installScript,
  setupScript: t.setupScript ?? null,
  enabled: t.enabled,
  installOrder: t.installOrder,
  bootstrap: t.bootstrap,
  runAs: t.runAs,
  sourceFile: t.sourceFile,
})

const tools = [...loaded.tools.values()].map(toToolRow)
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

const lines = []
for (const pack of [...loaded.packs].sort((a, b) => a.packId.localeCompare(b.packId))) {
  const plan = resolveInstallPlan({
    // Fixed literals: a plan that differed run to run would make every diff unreadable.
    serverId: 'srv-plan',
    runId: 'run-1',
    mode: 'push',
    pack: {
      id: pack.packId,
      tools: pack.tools,
      requiresRdp: pack.requiresRdp,
      ...(pack.desktop ? { desktop: pack.desktop } : {}),
    },
    tools,
    repositories: [],
  })
  lines.push(`pack ${pack.packId}: ${plan.steps.length} step(s)`)
  for (const [i, step] of plan.steps.entries()) {
    lines.push(
      `  ${String(i + 1).padStart(2, '0')} ${step.id}  runAs=${step.runAs}  reports=${step.reports}` +
        `  timeout=${step.timeoutSeconds}  sha256=${sha(step.run)}`,
    )
  }
}

// A single digest of the whole document, so "identical" is one line to check rather than a
// hundred to read.
const document = `${lines.join('\n')}\n`
process.stdout.write(document)
process.stdout.write(`\nall packs: ${loaded.packs.length}, document sha256=${sha(document)}\n`)
