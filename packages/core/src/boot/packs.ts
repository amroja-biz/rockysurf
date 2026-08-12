import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Db } from '../db/client.js'
import { loadPacksFromDir, syncPacksToDb, type LoadResult } from '../packs/index.js'

/**
 * Load `packs/*.yaml` into the database at boot — the seam between the pack loader
 * (rockysurf-gonw.8) and the boot path (rockysurf-gonw.9).
 */

export interface SyncPacksAtBootOptions {
  db: Db
  dataDir: string
  /** Where to look for a checkout-relative packs directory. Defaults to the process cwd. */
  cwd?: string
  log?: (message: string) => void
}

export interface PacksAtBootResult {
  /** The directory that was used. */
  dir: string
  source: 'checkout' | 'data-dir'
  packsSynced: number
  toolsSynced: number
  /** Files that failed validation and were therefore skipped. */
  skippedFiles: string[]
}

/**
 * Resolve which packs directory to use. Deliberately dumb for v0.1:
 *
 *  - `./packs` relative to the working directory, when it exists — the checkout case, where
 *    someone is running the repository's own packs;
 *  - otherwise `<dataDir>/packs`, created empty if absent — the installed case, where
 *    `npx rockysurf` has no repository around it. An empty directory is a legitimate state:
 *    the admin UI can still create packs, and they live in the database with a null
 *    `sourceFile` that the reconcile never touches.
 */
export function resolvePacksDir(dataDir: string, cwd: string = process.cwd()): { dir: string; source: 'checkout' | 'data-dir' } {
  const checkout = resolve(cwd, 'packs')
  if (existsSync(checkout)) return { dir: checkout, source: 'checkout' }
  return { dir: join(dataDir, 'packs'), source: 'data-dir' }
}

/**
 * Load and reconcile, without letting a bad file stop the server from starting.
 *
 * `syncPacksToDb` is all-or-nothing by design: it refuses a set with ANY validation issue,
 * because a half-applied pack directory is harder to reason about than one that plainly did
 * not load. That is the right contract for the sync function and the wrong outcome for boot —
 * one typo in one community pack would otherwise leave an installation with no packs at all.
 *
 * So the reconcile is given only the entities from files that validated cleanly, and the
 * issues are printed verbatim (they already name the file and the tool). The loader has
 * already done cross-file duplicate detection, so a pack excluded here is excluded for a
 * reason it stated.
 *
 * The consequence, stated plainly because it is not obvious: a pack whose file is currently
 * broken is REMOVED from the database rather than left stale, since the reconcile deletes
 * file-backed rows it no longer sees. That is recoverable — fix the file, restart, and the
 * pack returns — and it is preferable to leaving a definition installable that nothing can
 * validate.
 */
export function syncPacksAtBoot(options: SyncPacksAtBootOptions): PacksAtBootResult {
  const log = options.log ?? ((message: string) => console.error(message))
  const { dir, source } = resolvePacksDir(options.dataDir, options.cwd)

  if (source === 'data-dir') mkdirSync(dir, { recursive: true })

  const loaded = loadPacksFromDir(dir)
  const skippedFiles = [...new Set(loaded.issues.map((issue) => issue.file))]

  if (loaded.issues.length > 0) {
    log(`pack validation failed in ${skippedFiles.length} file(s) — skipping them and loading the rest:`)
    for (const issue of loaded.issues) log(`  ${issue.file}: ${issue.message}`)
  }

  const clean: LoadResult = {
    packs: loaded.packs.filter((pack) => !skippedFiles.includes(pack.sourceFile)),
    tools: new Map([...loaded.tools].filter(([, tool]) => !skippedFiles.includes(tool.sourceFile))),
    issues: [],
  }

  const result = syncPacksToDb(options.db, clean)
  log(
    `packs: ${result.packsUpserted} pack(s), ${result.toolsUpserted} tool(s) from ${dir}` +
      ` (${source})${skippedFiles.length ? `, ${skippedFiles.length} file(s) skipped` : ''}`,
  )

  return {
    dir,
    source,
    packsSynced: result.packsUpserted,
    toolsSynced: result.toolsUpserted,
    skippedFiles,
  }
}
