import type { Db } from '../db/client.js'
import {
  deletePack,
  deleteTool,
  listFileBackedPackIds,
  listFileBackedToolIds,
  upsertPack,
  upsertTool,
} from '../db/repositories/packs.js'
import type { LoadResult } from './loader.js'

/**
 * Reconcile `packs/*.yaml` into the database.
 *
 * ADR-0004's split, made concrete: the files are the source of truth for SHIPPED packs, the
 * database is a cache and an edit layer. So this is a reconcile, not a wipe-and-reload:
 *
 *  - a row whose `sourceFile` is set is file-backed. The file wins on every boot, so an admin
 *    edit to a shipped pack is overwritten — which is the documented behaviour, and why the
 *    export/import path exists to turn such an edit into a pull request instead;
 *  - a row with a NULL `sourceFile` was created in the admin UI and is never touched here;
 *  - a file-backed row whose file has disappeared is deleted, because otherwise removing a
 *    pack from the repository would leave it installable forever on every existing
 *    installation.
 */

export interface SyncResult {
  toolsUpserted: number
  packsUpserted: number
  toolsRemoved: string[]
  packsRemoved: string[]
}

export function syncPacksToDb(db: Db, loaded: LoadResult): SyncResult {
  if (loaded.issues.length > 0) {
    // Refusing to sync a broken set is the whole point of validating first: a half-applied
    // pack directory is harder to reason about than one that plainly did not load.
    throw new PackValidationError(loaded.issues.map((i) => `${i.file}: ${i.message}`))
  }

  for (const tool of loaded.tools.values()) {
    upsertTool(db, {
      id: tool.toolId,
      name: tool.name,
      description: tool.description,
      category: tool.category,
      url: tool.url,
      installScript: tool.installScript,
      setupScript: tool.setupScript ?? null,
      enabled: tool.enabled,
      installOrder: tool.installOrder,
      bootstrap: tool.bootstrap,
      runAs: tool.runAs,
      sourceFile: tool.sourceFile,
    })
  }

  for (const pack of loaded.packs) {
    upsertPack(db, {
      id: pack.packId,
      name: pack.name,
      tools: pack.tools,
      displayOrder: pack.displayOrder,
      enabled: pack.enabled,
      imageUrl: pack.imageUrl ?? null,
      theme: pack.theme ?? null,
      requiresRepos: pack.requiresRepos,
      requiresRdp: pack.requiresRdp,
      desktop: pack.desktop ?? null,
      sourceFile: pack.sourceFile,
    })
  }

  const liveToolIds = new Set(loaded.tools.keys())
  const toolsRemoved = listFileBackedToolIds(db).filter((id) => !liveToolIds.has(id))
  for (const id of toolsRemoved) deleteTool(db, id)

  const livePackIds = new Set(loaded.packs.map((p) => p.packId))
  const packsRemoved = listFileBackedPackIds(db).filter((id) => !livePackIds.has(id))
  for (const id of packsRemoved) deletePack(db, id)

  return {
    toolsUpserted: loaded.tools.size,
    packsUpserted: loaded.packs.length,
    toolsRemoved,
    packsRemoved,
  }
}

export class PackValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`pack files failed validation:\n  ${issues.join('\n  ')}`)
    this.name = 'PackValidationError'
  }
}
