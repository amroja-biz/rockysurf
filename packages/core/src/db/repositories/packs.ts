import { eq, isNotNull } from 'drizzle-orm'
import type { Db } from '../client.js'
import type { PackInput } from '../../packs/schema.js'
import { packs, tools, type PackRow, type ToolRow } from '../schema.js'

/**
 * Tools and packs — the cache and edit layer over `packs/*.yaml` (ADR-0004).
 *
 * `packs.tools` is a JSON array in a text column, per the schema's rule that the application
 * parses JSON rather than the driver. Every function here returns it already parsed, so no
 * caller has to remember; `Pack` is the row with that one field widened.
 */

export interface Pack extends Omit<PackRow, 'tools' | 'inputs'> {
  tools: string[]
  /**
   * The pack's `inputs` declaration, already parsed (issue #189). Undefined for a pack that
   * asks for nothing, so every reader can write `pack.inputs?.length` and mean it.
   */
  inputs?: PackInput[]
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
  /**
   * "Install this on every box" (issue #295). Absent means LEAVE WHAT IS THERE, the same
   * contract `registry` has on `UpsertPackInput` below, and for the same reason: the boot
   * reconcile re-upserts every file-backed tool from its YAML on each start, and the file
   * cannot carry this field — it is installation state, not file content. Setting it
   * unconditionally would therefore reset an operator's choice on a shipped tool at every
   * restart, silently. Passing `false` explicitly still clears it.
   */
  alwaysInstall?: boolean
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
  webPort?: number | null
  /**
   * The pack's `inputs` declaration (issue #189), stored as JSON in a text column like
   * `tools`. Null clears it; undefined is the same as null on every write path here, because
   * unlike `registry` below there is no case where a caller legitimately does not know the
   * answer — every writer has the whole pack in hand.
   */
  inputs?: PackInput[] | null
  sourceFile?: string | null
  /**
   * The pack this one was forked from (issue #295). Absent means LEAVE WHAT IS THERE, the
   * same contract as `registry`.
   *
   * This is load-bearing rather than tidy. The admin pack PUT builds a whole row from the form
   * and passes it here, so an unconditional assignment would erase the parent the first time
   * someone added a tool to their own fork — and adding a tool to a fork is the entire point of
   * issue #295. It is the `sshPublicKey`/`rdpPassword` scar in `servers/routes.ts` again: a
   * full-row literal quietly dropping a column nobody remembered was on the row.
   */
  derivedFromPackId?: string | null
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

const hydrate = (row: PackRow): Pack => {
  const { inputs, ...rest } = row
  return {
    ...rest,
    tools: JSON.parse(row.tools) as string[],
    // Parsed, not validated: the row was written from a validated declaration and re-running
    // zod on every list of every pack would be a cost with no reader. A row corrupted by hand
    // fails at the form or the create route, both of which do validate.
    ...(inputs ? { inputs: JSON.parse(inputs) as PackInput[] } : {}),
  }
}

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
    // A fresh row needs a value; an upsert of an existing one leaves the column alone unless
    // the caller said otherwise (see the conditional spread below).
    alwaysInstall: input.alwaysInstall ?? false,
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
        // `alwaysInstall` OMITTED means "leave it alone" — the reason this is a conditional
        // spread and not a plain assignment. `syncPacksToDb` re-upserts every file-backed tool
        // from its YAML on every boot and passes no such field, because no file format has
        // one; assigning unconditionally would reset an operator's "install this everywhere"
        // on every shipped tool at the next restart, with nothing to show what happened.
        ...(input.alwaysInstall === undefined ? {} : { alwaysInstall: values.alwaysInstall }),
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
    webPort: input.webPort ?? null,
    inputs: input.inputs?.length ? JSON.stringify(input.inputs) : null,
    sourceFile: input.sourceFile ?? null,
    derivedFromPackId: input.derivedFromPackId ?? null,
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
        webPort: values.webPort,
        inputs: values.inputs,
        sourceFile: values.sourceFile,
        // Omitted means "leave the parent alone", for the reason spelled out on the field:
        // the admin PUT sends a whole row, and a fork gaining a tool must not lose where it
        // came from. Passing `null` explicitly still clears it.
        ...(input.derivedFromPackId === undefined
          ? {}
          : { derivedFromPackId: values.derivedFromPackId }),
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
