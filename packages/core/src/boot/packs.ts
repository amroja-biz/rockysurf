import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BUNDLED_PACKS_DIR } from '../packs/bundled.js'
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
  source: PacksDirSource
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

/** Where the pack files a boot loads came from. Reported in the boot notice. */
export type PacksDirSource = 'checkout' | 'data-dir' | 'bundled'

/**
 * Resolve which packs directory to use. First match wins:
 *
 *  - `./packs` relative to the working directory, when it exists — the checkout case, where
 *    someone is running the repository's own packs;
 *  - `<dataDir>/packs`, when it holds pack files — an operator running their own set;
 *  - the packs bundled in the installed package (rockysurf-io02) — the `npx` case, and what
 *    makes "official means shipped with the release you are running" true of a real install;
 *  - otherwise `<dataDir>/packs`, created empty. Still a legitimate state: the admin UI can
 *    create packs, and the pack shop can install them, and both live in the database with a
 *    null `sourceFile` that the reconcile never touches.
 *
 * ONE DIRECTORY WINS, which is the rule this has always had and not something the bundled tier
 * introduces. An operator with files in `<dataDir>/packs` is running their own catalog and does
 * not silently get the shipped one merged in underneath; merging several pack directories is a
 * bigger change than this — `sourceFile` is a bare filename and two directories can hold the
 * same one — and it is tracked separately.
 */
export function resolvePacksDir(
  dataDir: string,
  cwd: string = process.cwd(),
): { dir: string; source: PacksDirSource } {
  const checkout = resolve(cwd, 'packs')
  if (existsSync(checkout)) return { dir: checkout, source: 'checkout' }

  // An operator who has put pack files in their data directory is running their own set, and
  // takes over completely — the same either/or that has always applied between a checkout and
  // the data directory, extended by one tier rather than changed. An EMPTY data directory does
  // not count, because the branch below creates one on every non-checkout boot, so keying on its
  // existence would mean the bundle was never reachable after the first start.
  const dataDirPacks = join(dataDir, 'packs')
  if (hasPackFiles(dataDirPacks)) return { dir: dataDirPacks, source: 'data-dir' }

  // The packs this release ships (rockysurf-io02). Read in place rather than copied out, so that
  // "official" keeps meaning what the owner's ruling on issue #9 says it means: shipped with the
  // release you are RUNNING. Seeding a copy into the data directory would make that false the
  // first time somebody upgraded — their v0.2 installation would still be serving v0.1's packs,
  // and a pack retired upstream would live on forever with nothing to say where it came from.
  //
  // The cost is stated rather than hidden: these files sit inside the installed package and are
  // not editable in place. Editing a shipped pack is what the admin UI's export/import path is
  // for (ADR-0004), and the row's `sourceFile` already tells an operator the file wins on the
  // next boot.
  if (hasPackFiles(BUNDLED_PACKS_DIR)) return { dir: BUNDLED_PACKS_DIR, source: 'bundled' }

  return { dir: dataDirPacks, source: 'data-dir' }
}

/** True when the directory exists AND holds something the loader would read. */
function hasPackFiles(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
  } catch {
    return false
  }
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
