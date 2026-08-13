import { readdirSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { packFileSchema, type PackDefinition, type PackFile, type ToolDefinition } from './schema.js'

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

/** Read every pack file in a directory and resolve them against each other. */
export function loadPacksFromDir(dir: string): LoadResult {
  const result: LoadResult = { packs: [], tools: new Map(), issues: [], files: [] }

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

  for (const name of entries) {
    const { file, issues } = parsePackFile(name, readFileSync(join(dir, name), 'utf8'))
    result.issues.push(...issues)
    if (!file) continue

    if (result.packs.some((p) => p.packId === file.pack.packId)) {
      result.issues.push({ file: name, message: `packId "${file.pack.packId}" is already defined in another file` })
      continue
    }
    result.packs.push({ ...file.pack, sourceFile: name })

    for (const tool of file.tools) {
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

/** Drop optional keys that are `undefined` so they do not serialize as `null`. */
function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}
