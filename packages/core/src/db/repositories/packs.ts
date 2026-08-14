import { eq, isNotNull } from 'drizzle-orm'
import type { Db } from '../client.js'
import { packs, tools, type PackRow, type ToolRow } from '../schema.js'

/**
 * Tools and packs — the cache and edit layer over `packs/*.yaml` (ADR-0004).
 *
 * `packs.tools` is a JSON array in a text column, per the schema's rule that the application
 * parses JSON rather than the driver. Every function here returns it already parsed, so no
 * caller has to remember; `Pack` is the row with that one field widened.
 */

export interface Pack extends Omit<PackRow, 'tools'> {
  tools: string[]
}

export interface UpsertToolInput {
  id: string
  name: string
  description: string
  category: string
  url: string
  installScript: string
  setupScript?: string | null
  enabled: boolean
  installOrder: number
  bootstrap: boolean
  runAs: string
  /** Null for a row created in the admin UI; a filename for one loaded from `packs/`. */
  sourceFile?: string | null
}

export interface UpsertPackInput {
  id: string
  name: string
  tools: string[]
  displayOrder: number
  enabled: boolean
  imageUrl?: string | null
  theme?: string | null
  guide?: string | null
  requiresRepos: boolean
  requiresRdp: boolean
  desktop?: string | null
  sourceFile?: string | null
  /**
   * Registry provenance (rockysurf-arym.4), and note what it is NOT: `sourceFile`.
   *
   * Writing provenance there would make the boot reconcile delete the pack, because it removes
   * every non-null-`sourceFile` row whose file it no longer finds. A registry pack keeps
   * `sourceFile` null and carries its origin in these columns instead.
   *
   * Absent on every other write path, and absent means "leave what is there": a plain admin
   * edit to an installed registry pack must not quietly erase where it came from.
   */
  registry?: RegistryProvenance | null
}

/** Where an installed pack came from, as the operator understood it at the time. */
export interface RegistryProvenance {
  /** The configured source's name — what the operator wrote and what the UI shows. */
  source: string
  /** Kept beside the name so an install still says where it came from after a rename. */
  url: string
  /** The digest verified at install, so the UI can say which bytes were accepted. */
  sha256: string
  /** Snapshotted at install: what the operator believed when they consented. */
  trust: string
  installedAt: string
}

const hydrate = (row: PackRow): Pack => ({ ...row, tools: JSON.parse(row.tools) as string[] })

/* ------------------------------------------------------------------------------- tools */

export function listTools(db: Db): ToolRow[] {
  return db.select().from(tools).all()
}

export function getTool(db: Db, id: string): ToolRow | undefined {
  return db.select().from(tools).where(eq(tools.id, id)).get()
}

export function upsertTool(db: Db, input: UpsertToolInput): ToolRow {
  const now = new Date().toISOString()
  const values = {
    ...input,
    setupScript: input.setupScript ?? null,
    sourceFile: input.sourceFile ?? null,
    createdAt: now,
    updatedAt: now,
  }
  const [row] = db
    .insert(tools)
    .values(values)
    .onConflictDoUpdate({
      target: tools.id,
      // createdAt is deliberately absent: an upsert of an existing tool is an edit, and an
      // edit must not rewrite when the row first appeared.
      set: {
        name: values.name,
        description: values.description,
        category: values.category,
        url: values.url,
        installScript: values.installScript,
        setupScript: values.setupScript,
        enabled: values.enabled,
        installOrder: values.installOrder,
        bootstrap: values.bootstrap,
        runAs: values.runAs,
        sourceFile: values.sourceFile,
        updatedAt: now,
      },
    })
    .returning()
    .all()
  if (!row) throw new Error(`upsertTool wrote no row for ${input.id}`)
  return row
}

export function deleteTool(db: Db, id: string): void {
  db.delete(tools).where(eq(tools.id, id)).run()
}

/** File-backed tools only. Rows created in the admin UI have a null `sourceFile` and survive. */
export function listFileBackedToolIds(db: Db): string[] {
  return db
    .select({ id: tools.id })
    .from(tools)
    .where(isNotNull(tools.sourceFile))
    .all()
    .map((r) => r.id)
}

/* ------------------------------------------------------------------------------- packs */

export function listPacks(db: Db): Pack[] {
  return db.select().from(packs).all().map(hydrate)
}

export function getPack(db: Db, id: string): Pack | undefined {
  const row = db.select().from(packs).where(eq(packs.id, id)).get()
  return row ? hydrate(row) : undefined
}

export function upsertPack(db: Db, input: UpsertPackInput): Pack {
  const now = new Date().toISOString()
  const values = {
    ...input,
    tools: JSON.stringify(input.tools),
    imageUrl: input.imageUrl ?? null,
    theme: input.theme ?? null,
    guide: input.guide ?? null,
    desktop: input.desktop ?? null,
    sourceFile: input.sourceFile ?? null,
    registrySource: input.registry?.source ?? null,
    registryUrl: input.registry?.url ?? null,
    registrySha256: input.registry?.sha256 ?? null,
    registryTrust: input.registry?.trust ?? null,
    registryInstalledAt: input.registry?.installedAt ?? null,
    createdAt: now,
    updatedAt: now,
  }
  const [row] = db
    .insert(packs)
    .values(values)
    .onConflictDoUpdate({
      target: packs.id,
      set: {
        name: values.name,
        tools: values.tools,
        displayOrder: values.displayOrder,
        enabled: values.enabled,
        imageUrl: values.imageUrl,
        theme: values.theme,
        guide: values.guide,
        requiresRepos: values.requiresRepos,
        requiresRdp: values.requiresRdp,
        desktop: values.desktop,
        sourceFile: values.sourceFile,
        // `registry` OMITTED means "leave the provenance alone", which is why these are spread
        // conditionally rather than always set. Every existing write path — the boot reconcile,
        // the admin editor, the YAML import — passes no `registry`, and an ordinary edit to an
        // installed registry pack must not quietly erase where it came from. Passing `null`
        // explicitly still clears it, which is what an install onto a different source needs.
        ...(input.registry === undefined
          ? {}
          : {
              registrySource: values.registrySource,
              registryUrl: values.registryUrl,
              registrySha256: values.registrySha256,
              registryTrust: values.registryTrust,
              registryInstalledAt: values.registryInstalledAt,
            }),
        updatedAt: now,
      },
    })
    .returning()
    .all()
  if (!row) throw new Error(`upsertPack wrote no row for ${input.id}`)
  return hydrate(row)
}

export function deletePack(db: Db, id: string): void {
  db.delete(packs).where(eq(packs.id, id)).run()
}

export function listFileBackedPackIds(db: Db): string[] {
  return db
    .select({ id: packs.id })
    .from(packs)
    .where(isNotNull(packs.sourceFile))
    .all()
    .map((r) => r.id)
}
