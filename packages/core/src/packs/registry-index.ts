import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { loadPacksFromDir, type LoadedPack } from './loader.js'
import type { PackFile } from './schema.js'

/**
 * `index.json` — what a pack registry publishes and what core reads.
 *
 * The registry (rockysurf-arym, issue #9) is a git repository of pack YAML plus this one
 * generated file. Core never walks the registry's tree and never asks the GitHub API what is in
 * it: it fetches this document and then fetches the paths it names. Two reasons, and the second
 * is the load-bearing one.
 *
 * FIRST, THE GITHUB API IS NOT AN OPTION (rockysurf-c6cm). Unauthenticated `api.github.com` is
 * 60 requests per hour shared across everything on one source IP. A control plane behind a
 * corporate NAT would exhaust it before it had listed the shop once. `raw.githubusercontent.com`
 * is a CDN with no such quota, and it serves files by path — so a listing has to BE a file.
 *
 * SECOND, THERE IS NO TRUST LABEL IN THIS DOCUMENT, DELIBERATELY.
 *
 * An earlier draft gave each entry a `tier` of `official` or `community`. The owner's ruling on
 * issue #9 removed the reason for it — the shop is purely community, official packs ship in the
 * tarball and never appear here — and taking the field out is the sharper half of that decision
 * rather than a consequence of it. A trust label inside a registry's own index is a claim about
 * trustworthiness written by the party being trusted. It could only ever be as good as the
 * document containing it, which is the thing in question.
 *
 * So a pack's label comes from where the OPERATOR got it, and an operator can always answer
 * that: bundled packs are `official` because they arrived in the tarball, and a registry's packs
 * carry the label the operator wrote next to that registry in their own config file. Nothing a
 * registry publishes can promote itself.
 *
 * WHAT THE sha256 IS AND IS NOT. It pins a pack file to the index entry that describes it, so a
 * file swapped without regenerating the index fails closed rather than installing quietly. It is
 * NOT a signature: whoever can write the index can write both halves. The honest statement of
 * the trust chain is "the operator trusts this repository's main branch and GitHub's account
 * controls", and ADR-0006 says exactly that rather than implying more. Real detached signatures
 * are rockysurf-cqrm.
 */

/** Bumped when the document shape changes. Core refuses a version it does not know. */
export const REGISTRY_INDEX_VERSION = 1

const ID = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)

/**
 * A path INSIDE the registry, and the constraint is a security control rather than tidiness.
 * Core joins this onto a base URL, so `../` or a leading slash would let an index point the
 * fetch at an arbitrary path on the host — or, once the host is a CDN serving many
 * repositories, at somebody else's. Relative, forward slashes, no traversal, ends in the
 * extension the loader accepts.
 */
const REGISTRY_PATH = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._/-]*\.(ya?ml)$/i, { error: 'must be a relative path to a .yaml file' })
  .refine((p) => !p.includes('..') && !p.startsWith('/'), {
    error: 'must not be absolute or contain ".."',
  })

export const registryEntrySchema = z.strictObject({
  packId: ID,
  name: z.string().min(1),
  /** The pack has no description field, so this is the registry's own one-line summary. */
  description: z.string().min(1),
  path: REGISTRY_PATH,
  /** Lowercase hex, 64 chars. Verified after fetch; a mismatch is refused. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, { error: 'must be a lowercase hex sha256' }),
  /** Tool ids this file introduces. Shown before install so an operator sees what arrives. */
  definesTools: z.array(ID),
  /**
   * Tool ids the pack uses but does not define. An install has to resolve these against what
   * the installation already has, and a pack whose references cannot be satisfied is one the
   * UI should refuse rather than half-install.
   */
  referencesTools: z.array(ID),
  requiresRepos: z.boolean(),
  requiresRdp: z.boolean(),
})

export const registryIndexSchema = z.strictObject({
  version: z.literal(REGISTRY_INDEX_VERSION),
  /**
   * When the index was generated, ISO-8601. Displayed rather than enforced: a stale index is a
   * thing an operator should be able to SEE, and a client that refused one over a clock skew
   * would be a client that breaks when a registry's CI is quiet for a fortnight.
   */
  generatedAt: z.iso.datetime(),
  packs: z.array(registryEntrySchema),
})

export type RegistryEntry = z.infer<typeof registryEntrySchema>
export type RegistryIndex = z.infer<typeof registryIndexSchema>

/* --------------------------------------------------------------------------- generating */

export interface IndexSourceDir {
  /** Directory on disk to read. */
  dir: string
  /** Path prefix recorded in the index, relative to the registry root — e.g. `packs`. */
  prefix: string
}

export interface BuildIndexOptions {
  sources: IndexSourceDir[]
  /**
   * Directories whose tools may be REFERENCED by an indexed pack but which are not themselves
   * indexed — the shared base toolchain.
   *
   * Necessary because the shop holds no official tier to resolve against. A community pack is
   * told to reference `claude-code`, `git` and the rest by id rather than redefine them, and
   * those live in the main repository's `packs/` and ship in the tarball. The shop's CI fetches
   * that directory and passes it here, so an index is only ever generated for packs whose
   * references resolved against the toolchain as it currently is. A tool upstream later removes
   * turns into a failed regeneration, which is a thing somebody should be told about.
   */
  basePacksDirs?: string[]
  /** Injectable so a test can assert a stable document. Defaults to now. */
  now?: () => Date
}

export class RegistryIndexError extends Error {}

/**
 * Read every pack file in each source directory and render the index.
 *
 * Refuses rather than skips when a file does not load. A registry index that quietly omits a
 * broken pack is a registry where deleting a pack and breaking it look identical to every
 * client — and the second one is a bug someone should be told about, not routed around. The
 * caller (`rockysurf pack index`) runs the lint first anyway; this is the backstop.
 *
 * Packs are sorted by id, and the whole document is written with sorted keys and a stable
 * shape, so regenerating an unchanged registry produces an unchanged file. That matters more
 * than it looks: the index is committed by CI, and an index that churns on every run buries the
 * one diff a reviewer needs to see under noise.
 */
export function buildRegistryIndex(options: BuildIndexOptions): RegistryIndex {
  const entries: RegistryEntry[] = []
  const seen = new Map<string, string>()

  // Every directory is loaded before any is judged, and the base directories are folded in
  // alongside them. A pack that correctly REFERENCES a tool rather than redefining it — which is
  // what the contract asks for — resolves against a definition in some other file, and judging
  // each directory in isolation reports every well-behaved pack as referencing unknown tools.
  const loadedBySource = options.sources.map((source) => ({ source, loaded: loadPacksFromDir(source.dir) }))
  // A base pack the registry itself also publishes is the same pack seen twice, not a second
  // definition — the same subtraction `lintPacksDir` makes, and for the same reason: the default
  // base directory is the bundled copy of a set a registry may legitimately contain.
  const indexedPackIds = new Set(loadedBySource.flatMap(({ loaded }) => loaded.packs.map((p) => p.packId)))
  const baseTools = (options.basePacksDirs ?? []).flatMap((dir) => {
    const base = loadPacksFromDir(dir)
    const shadowed = new Set(base.packs.filter((p) => indexedPackIds.has(p.packId)).map((p) => p.sourceFile))
    return [...base.tools.values()].filter((t) => !shadowed.has(t.sourceFile)).map((t) => t.toolId)
  })
  const knownTools = new Set([
    ...loadedBySource.flatMap(({ loaded }) => [...loaded.tools.keys()]),
    ...baseTools,
  ])
  const satisfiedElsewhere = (message: string): boolean => {
    const referenced = /references unknown tool "([^"]+)"/.exec(message)
    return referenced !== null && knownTools.has(referenced[1]!)
  }

  for (const { source, loaded } of loadedBySource) {
    const issues = loaded.issues.filter((issue) => !satisfiedElsewhere(issue.message))
    if (issues.length > 0) {
      throw new RegistryIndexError(
        `${source.dir} does not validate, so it cannot be indexed:\n` +
          issues.map((i) => `  ${i.file}: ${i.message}`).join('\n'),
      )
    }

    for (const pack of loaded.packs) {
      const previous = seen.get(pack.packId)
      if (previous) {
        // A client resolves a pack by id. Two files claiming one id means whichever the client
        // picks is arbitrary, and an operator who installed "the other one" has no way to tell.
        throw new RegistryIndexError(
          `packId "${pack.packId}" appears in both ${previous} and ${source.prefix} — ` +
            'one id, one home',
        )
      }
      seen.set(pack.packId, source.prefix)
      entries.push(entryFor(pack, loaded.tools, source))
    }
  }

  entries.sort((a, b) => a.packId.localeCompare(b.packId))
  const now = (options.now ?? (() => new Date()))()
  return { version: REGISTRY_INDEX_VERSION, generatedAt: now.toISOString(), packs: entries }
}

function entryFor(
  pack: LoadedPack,
  tools: Map<string, { toolId: string; sourceFile: string; description: string }>,
  source: IndexSourceDir,
): RegistryEntry {
  const defines = [...tools.values()]
    .filter((t) => t.sourceFile === pack.sourceFile)
    .map((t) => t.toolId)
    .sort()
  const definesSet = new Set(defines)

  return {
    packId: pack.packId,
    name: pack.name,
    // The frozen format gives a pack a name but no description, and inventing a field would be
    // a format change (ADR-0004). The honest summary available without one is what the pack
    // installs, which is also the thing a browser is actually choosing between.
    description: `Installs ${pack.tools.length} tool(s): ${pack.tools.join(', ')}`,
    path: `${source.prefix}/${pack.sourceFile}`,
    sha256: sha256File(join(source.dir, pack.sourceFile)),
    definesTools: defines,
    referencesTools: pack.tools.filter((id) => !definesSet.has(id)).sort(),
    requiresRepos: pack.requiresRepos,
    requiresRdp: pack.requiresRdp,
  }
}

/**
 * The index entry for a pack that arrived as ONE FILE, with no index describing it (issue #88).
 *
 * A personal source is a URL ending in `.yaml`: someone's own pack, published as the single file
 * they wrote, with no CI and no generated listing. Describing it with the same `RegistryEntry`
 * the shop's index publishes is what keeps that case from becoming a second code path — browse,
 * disclosure, install and provenance all take an entry, and they take this one unchanged.
 *
 * WHAT THE DIGEST MEANS HERE, because it means less than it does for an indexed pack and saying
 * so is the point. In an index it pins a file to a listing SOMEONE ELSE generated, so a file
 * swapped without regenerating the listing fails closed. Here both halves come from the same
 * fetch, so it cannot prove that. What it still does is pin the bytes an admin was SHOWN to the
 * bytes that get installed: the file is refetched at install and refused if it no longer matches
 * what browsing put on screen. That is a real check — it catches a source that changed under a
 * reader mid-decision — and it is the whole of what is claimed for it.
 *
 * The description names the file's own shape rather than inventing one, the same sentence
 * `entryFor` builds, because the frozen format still has no description field (ADR-0004).
 */
export function entryForFetchedPack(file: PackFile, path: string, yaml: string): RegistryEntry {
  const defines = file.tools.map((t) => t.toolId).sort()
  const definesSet = new Set(defines)
  return {
    packId: file.pack.packId,
    name: file.pack.name,
    description: `Installs ${file.pack.tools.length} tool(s): ${file.pack.tools.join(', ')}`,
    path,
    sha256: sha256Text(yaml),
    definesTools: defines,
    referencesTools: file.pack.tools.filter((id) => !definesSet.has(id)).sort(),
    requiresRepos: file.pack.requiresRepos,
    requiresRdp: file.pack.requiresRdp,
  }
}

/**
 * Hashed as BYTES, not as a decoded string.
 *
 * The verification on the other end reads what the CDN returned, and a normalisation applied on
 * one side and not the other — a trailing newline, a BOM, CRLF — would make every install fail
 * a check nothing was wrong with. Hash what is on the wire.
 */
export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** The same digest over content already in hand, for verifying a fetch. */
export function sha256Text(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

/** Two trailing spaces are not worth a diff; the file ends with one newline. */
export const renderRegistryIndex = (index: RegistryIndex): string => `${JSON.stringify(index, null, 2)}\n`
