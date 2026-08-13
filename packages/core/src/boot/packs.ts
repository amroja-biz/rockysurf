import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Db } from '../db/client.js'
import { listFileBackedPackIds } from '../db/repositories/packs.js'
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
  /**
   * Whether the reconcile ran at all. False means no pack files were found, so this boot
   * had no authority to decide anything about the database's packs and left them alone.
   */
  reconciled: boolean
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
 *
 * That deletion rule needs one boundary, and rockysurf-96ce is what happens without it. The
 * app boots from any directory now, so a boot from a non-checkout cwd finds no pack files,
 * and a reconcile against nothing deleted every file-backed pack in the database — an owner
 * opened the picker and it was empty. So: A BOOT THAT LOADED NO PACK AT ALL DELETES NOTHING.
 * The reconcile is skipped entirely and the database keeps what it has. "This one file went
 * away" (delete its rows) and "this boot has nothing to compare against" (touch nothing) are
 * different claims, and only the first one is evidence.
 *
 * Nothing loaded covers two ways of getting there, because the blast radius is identical and
 * so is the reasoning. One is no pack files: absent directory, empty directory, non-checkout
 * cwd. The other is files that all failed validation, which is not the exotic case it sounds
 * like — the shipped catalog has every pack referencing the base tools that
 * `ai-coding-agents.yaml` owns, so deleting or breaking that ONE file invalidates every other
 * pack by cascade and would otherwise empty the picker. Per-file deletion is untouched by
 * this: as long as one pack still validates, a file that went away still loses its rows,
 * which is the rule rockysurf-a0ss asked for and the case that actually has evidence behind
 * it. The narrow thing given up is emptying a catalog by deleting or breaking every file at
 * once; that is what the admin UI's per-pack delete is for, and it says what it is doing.
 *
 * An empty packs DIRECTORY counts as no source, the same as an absent one, even though an
 * operator who deleted the last yaml might have meant zero. Two reasons. The weaker one is
 * asymmetry: a stale pack is visible and removable in the admin UI, while a wrongly emptied
 * catalog is a support incident. The decisive one is that the states are not actually
 * distinguishable — the branch below CREATES `<dataDir>/packs` when it is missing, so every
 * installation that has ever booted outside a checkout has an empty packs directory sitting
 * there, and keying deletion on it would re-arm the exact trap this rule exists to disarm.
 * Emptying the catalog is done per-pack in the admin UI, which is explicit about it.
 *
 * This also settles the npx case in advance: a published install never has a checkout, so
 * pack sync there is a no-op rather than a mass delete. Docker is unaffected either way —
 * its WORKDIR is /app and the image copies the repository whole, so it is a checkout boot.
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
    files: loaded.files,
  }

  if (clean.packs.length === 0) {
    const kept = listFileBackedPackIds(options.db).length
    log(
      loaded.files.length === 0
        ? source === 'checkout'
          ? `packs: ${dir} holds no pack files — leaving ${kept} database pack(s) as they are`
          : `packs: no checkout detected (no packs/ in ${resolve(options.cwd ?? process.cwd())}, none in ${dir})` +
            ` — leaving ${kept} database pack(s) as they are`
        : `packs: not one of ${loaded.files.length} file(s) in ${dir} validated — leaving ${kept} database pack(s)` +
            ` as they are; fix the errors above and restart`,
    )
    return { dir, source, packsSynced: 0, toolsSynced: 0, skippedFiles, reconciled: false }
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
    reconciled: true,
  }
}
