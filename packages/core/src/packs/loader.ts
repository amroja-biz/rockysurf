import { readdirSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  packFileSchema,
  toolFileSchema,
  type PackDefinition,
  type PackFile,
  type ToolDefinition,
  type ToolFile,
} from './schema.js'

/**
 * Loading `packs/*.yaml`.
 *
 * The files are the source of truth for shipped packs and the database is a cache and edit
 * layer (ADR-0004), so this module's job is: parse, validate against the frozen format,
 * check the things a single file cannot check about itself, and hand the caller a resolved
 * view. Writing to the database is `sync.ts`; keeping the two apart means the validator can
 * run in CI with no database at all.
 *
 * Errors accumulate rather than throwing on the first one. A contributor fixing a pack wants
 * the whole list, not a fresh error per push.
 */

export interface PackIssue {
  /** Repository-relative where possible, so the message can be pasted into an editor. */
  file: string
  message: string
}

export interface LoadedTool extends ToolDefinition {
  /** Which file defined it, for round-tripping an edit back to YAML. */
  sourceFile: string
}

export interface LoadedPack extends PackDefinition {
  sourceFile: string
}

export interface LoadResult {
  packs: LoadedPack[]
  /** Every tool definition, keyed by id. One file owns each id. */
  tools: Map<string, LoadedTool>
  issues: PackIssue[]
  /**
   * The candidate pack files the loader actually read, valid or not. Empty means the directory
   * was absent or held nothing that looks like a pack — which the boot path treats as "no
   * source to reconcile against" rather than "the source says zero packs" (rockysurf-96ce).
   */
  files: string[]
  /**
   * Of those, the ones that were TOOL files rather than pack files — `packs/base.yaml` and
   * anything else shaped like it (issue #499, ADR-0018's format).
   *
   * Recorded because "this file defined no pack" and "this file failed to load" are different
   * facts, and a caller comparing two directories needs to tell them apart: `lint.ts` uses it
   * to recognise the same tool file seen twice, and it is how a reader of a report knows why a
   * file contributed no pack.
   */
  toolFiles: string[]
}

const PACK_EXTENSIONS = new Set(['.yaml', '.yml'])

/** Parse and validate one pack file's text. Pure — no filesystem, so tests can call it. */
export function parsePackFile(fileName: string, text: string): { file?: PackFile; issues: PackIssue[] } {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (err) {
    return { issues: [{ file: fileName, message: `not valid YAML: ${(err as Error).message}` }] }
  }

  const parsed = packFileSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => ({
        file: fileName,
        message: `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
      })),
    }
  }

  const issues: PackIssue[] = []
  const expected = basename(fileName, extname(fileName))
  if (parsed.data.pack.packId !== expected) {
    issues.push({
      file: fileName,
      message: `packId "${parsed.data.pack.packId}" does not match the filename — rename one so they agree`,
    })
  }

  // Within one file: a tool may not be defined twice.
  const seen = new Set<string>()
  for (const tool of parsed.data.tools) {
    if (seen.has(tool.toolId)) issues.push({ file: fileName, message: `duplicate toolId "${tool.toolId}"` })
    seen.add(tool.toolId)
  }

  return { file: parsed.data, issues }
}

/**
 * True when a document is the TOOL FILE shape: an object with no `pack` key (ADR-0018).
 *
 * The two formats are siblings and this is the only thing that tells them apart — a tool file
 * has no `packId` to key on, and its name carries no signal because, unlike a pack file, it is
 * not named after anything. So the rule is the absence of the `pack` block, which is also what
 * `parseToolFile` already keys on from the other direction when someone pastes a pack file into
 * the tool importer.
 *
 * The cost, stated because it is the one thing this trades away: a pack file whose `pack:` block
 * is deleted outright is now read as a tool file, so instead of "pack: required" the author sees
 * their pack silently absent from the picker. Every other way of breaking a pack file — a
 * missing field, a bad id, a filename that disagrees — still names itself, and a whole missing
 * block is the one case where "this file introduces tools and no pack" is a true reading of it.
 *
 * Unparseable YAML is not decided here: it goes down the pack-file path, which reports it as
 * invalid YAML, so the error a broken file gets does not depend on a shape nobody could read.
 */
function looksLikeToolFile(text: string): boolean {
  try {
    const raw = parseYaml(text)
    return raw !== null && typeof raw === 'object' && !('pack' in raw)
  } catch {
    return false
  }
}

/**
 * Read every file in a directory and resolve them against each other.
 *
 * Both formats are read: a file with a `pack:` block is a pack file, and one without is a TOOL
 * FILE contributing definitions and no pack (issue #499 — `packs/base.yaml` holds the shared
 * base toolchain that every pack references by id). ADR-0018 froze that format for imports and
 * exports; nothing about it needed changing to be loaded from disk, which is why it is the shape
 * a base file takes rather than a pack with `enabled: false` pretending not to be one.
 */
export function loadPacksFromDir(dir: string): LoadResult {
  const result: LoadResult = { packs: [], tools: new Map(), issues: [], files: [], toolFiles: [] }

  let entries: string[]
  try {
    entries = readdirSync(dir)
      .filter((name) => PACK_EXTENSIONS.has(extname(name)))
      .sort()
  } catch {
    // An absent packs/ directory is not an error: a fresh installation with no shipped packs
    // is a legitimate state, and the admin UI can still create packs in the database.
    return result
  }
  result.files = entries

  const definedIn = new Map<string, string>()

  /** One id, one home — whichever of the two formats the definition arrived in. */
  const register = (name: string, tools: readonly ToolDefinition[]): void => {
    for (const tool of tools) {
      const owner = definedIn.get(tool.toolId)
      if (owner) {
        result.issues.push({
          file: name,
          message: `toolId "${tool.toolId}" is already defined in ${owner} — reference it by id instead of redefining it`,
        })
        continue
      }
      definedIn.set(tool.toolId, name)
      result.tools.set(tool.toolId, { ...tool, sourceFile: name })
    }
  }

  for (const name of entries) {
    const text = readFileSync(join(dir, name), 'utf8')

    if (looksLikeToolFile(text)) {
      const { file, issues } = parseToolFile(name, text)
      result.issues.push(...issues)
      result.toolFiles.push(name)
      if (file) register(name, file.tools)
      continue
    }

    const { file, issues } = parsePackFile(name, text)
    result.issues.push(...issues)
    if (!file) continue

    if (result.packs.some((p) => p.packId === file.pack.packId)) {
      result.issues.push({ file: name, message: `packId "${file.pack.packId}" is already defined in another file` })
      continue
    }
    result.packs.push({ ...file.pack, sourceFile: name })

    register(name, file.tools)
  }

  // Cross-file references resolve only once every file has been read, so this runs last.
  for (const pack of result.packs) {
    for (const toolId of pack.tools) {
      if (!result.tools.has(toolId)) {
        result.issues.push({
          file: pack.sourceFile,
          message: `pack "${pack.packId}" references unknown tool "${toolId}"`,
        })
      }
    }
  }

  return result
}

/**
 * Render a pack and its owned tools back to the file format.
 *
 * Round-trip contract: `parse(render(x))` equals `x`, and `render(parse(render(x)))` is
 * byte-identical to `render(x)`. It is NOT byte-identical to a hand-written source file,
 * because comments are not part of the data model and YAML has many spellings for the same
 * value — a promise of that kind would be a promise to preserve formatting we never parsed.
 */
export function renderPackFile(pack: PackDefinition, tools: ToolDefinition[]): string {
  // `sourceFile` is provenance the loader attaches, not part of the format — and the schema
  // is strict, so leaving it in produces a file that will not load.
  const strip = <T extends object>(v: T) => {
    const { sourceFile: _dropped, ...rest } = v as T & { sourceFile?: string }
    return stripUndefined(rest) as T
  }

  const file: PackFile = {
    version: 1,
    pack: strip(pack),
    // Ordered by installOrder then toolId, matching the executor's ordering, so a rendered
    // file reads in the order its steps actually run.
    tools: [...tools]
      .sort((a, b) => a.installOrder - b.installOrder || a.toolId.localeCompare(b.toolId))
      .map(strip),
  }
  return stringifyYaml(file, { lineWidth: 100, blockQuote: 'literal' })
}

/**
 * Parse and validate one TOOL file's text (issue #289, ADR-0018). Pure — no filesystem.
 *
 * Deliberately not a variant of `parsePackFile`. A tool file has no `packId`, so the filename
 * check does not apply, and it has no cross-file references to resolve — standing alone is the
 * whole point of the format.
 */
export function parseToolFile(fileName: string, text: string): { file?: ToolFile; issues: PackIssue[] } {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (err) {
    return { issues: [{ file: fileName, message: `not valid YAML: ${(err as Error).message}` }] }
  }

  /**
   * A PACK FILE PASTED INTO THE TOOL IMPORT IS THE LIKELIEST MISTAKE HERE, and `strictObject`
   * would answer it with `Unrecognized key: "pack"` — true, and useless. The two formats are
   * siblings that look alike; the person has the right file and the wrong door, and the only
   * thing they need told is which door.
   */
  if (raw !== null && typeof raw === 'object' && 'pack' in raw) {
    return {
      issues: [
        {
          file: fileName,
          message: 'this is a pack file, not a Tool file — import it under Surge Packs instead',
        },
      ],
    }
  }

  const parsed = toolFileSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => ({
        file: fileName,
        message: `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
      })),
    }
  }

  const issues: PackIssue[] = []
  const seen = new Set<string>()
  for (const tool of parsed.data.tools) {
    if (seen.has(tool.toolId)) issues.push({ file: fileName, message: `duplicate toolId "${tool.toolId}"` })
    seen.add(tool.toolId)
    /**
     * The one field the shared format CARRIES but a tool file may not USE. It stays in the
     * schema so a tool moves between the two formats unchanged; `true` is refused here because
     * those steps belong to the runtime, not to anything a person imports. Same words as
     * `lint.ts`'s reserved-field rule, so a pack author and an importer are told the same thing.
     */
    if (tool.bootstrap) {
      issues.push({
        file: fileName,
        message:
          `tool "${tool.toolId}" sets bootstrap: true, which is reserved for the tools the ` +
          'runtime guarantees before any plan runs. Set it to false',
      })
    }
  }

  return issues.length > 0 ? { issues } : { file: parsed.data, issues }
}

/**
 * Render tool definitions to a shareable tool file.
 *
 * Same round-trip contract as `renderPackFile`, and `sourceFile` is stripped for the same
 * reason: it is provenance THIS installation attached, it means nothing on anybody else's
 * machine, and the strict schema rejects a file carrying it.
 */
export function renderToolFile(tools: ToolDefinition[]): string {
  const file: ToolFile = {
    version: 1,
    tools: [...tools]
      .sort((a, b) => a.installOrder - b.installOrder || a.toolId.localeCompare(b.toolId))
      .map((tool) => {
        const { sourceFile: _dropped, ...rest } = tool as ToolDefinition & { sourceFile?: string }
        return stripUndefined(rest) as ToolDefinition
      }),
  }
  return stringifyYaml(file, { lineWidth: 100, blockQuote: 'literal' })
}

/** Drop optional keys that are `undefined` so they do not serialize as `null`. */
function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}
