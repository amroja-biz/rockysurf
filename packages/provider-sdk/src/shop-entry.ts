/**
 * Reading a packed provider tarball and writing the shop listing entry that describes it
 * (issue #418).
 *
 * WHY THIS EXISTS. A `providers.json` entry has nine fields and seven of them are already inside
 * the artifact: the manifest holds `package` and `version`, the factory holds `providerId`, the
 * settings declaration holds the whole `settings` summary and the panel title, the constructed
 * provider holds `capabilities`, and the bytes on disk hold `sha256`. The shop's CONTRIBUTING
 * asked a contributor to transcribe all of that by hand. The owner did it once for
 * `@rockysurf/provider-digitalocean` and found it too many steps to get right — a settings summary
 * copied field-for-field out of a declaration, and a capability struct copied verbatim out of a
 * source file, are two transcriptions that drift from the artifact silently and are checked by
 * nobody. Only the tarball URL and the one-line description are facts the artifact does not know.
 *
 * WHY IT LIVES IN THE SDK. The author who needs it is out of tree. A script in the Rocky Surf
 * repository reaches nobody who has not cloned it; a bin in the SDK reaches everyone who already
 * depends on the SDK, which is every provider author by definition.
 *
 * WHY THERE IS A TAR READER IN HERE. The SDK's charter is ZERO DEPENDENCIES (ADR-0024) — anything
 * this package depends on is inherited by every provider and every consumer — so the tarball is
 * read with `node:zlib` and about a hundred lines of ustar. The reader below is the one core
 * carried for the in-app installer until #394 deleted it with its caller, restored here with its
 * refusals intact. They are worth keeping even though nothing hostile is expected: this code
 * unpacks a file into a temp directory and then `import()`s something out of it, so an archive
 * that names an absolute path, climbs out with `..`, or carries a symlink is refused rather than
 * handled.
 *
 * WHAT RUNS. The provider's own entry point, in this process, because `capabilities` is a property
 * of a CONSTRUCTED provider and there is no honest way to read it without calling
 * `createProvider()`. That is safe by contract — `createProvider` is required to be synchronous
 * and side-effect free, no network, no filesystem, no credential check — but it is still the
 * author's code running on the author's own package, which is the only place this is ever pointed.
 *
 * Nothing here is exported from the package index: it opens files and spawns nothing, but it
 * imports `node:fs`, and the SDK's index is bundled into the browser (`sizing.ts`, ADR-0024).
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import type { ProviderCapabilities } from './capabilities.js'
import type { ProviderConfig, ProviderFactory } from './provider.js'
import type { ProviderSettingKind } from './settings.js'

/* --------------------------------------------------------------------------- the ustar reader */

/** 512 bytes, the ustar block. */
const BLOCK = 512

/** The prefix every member of an npm tarball is under, and the only one accepted. */
const NPM_ROOT = 'package/'

export interface ExtractLimits {
  /** How many members the archive may have. A package with more is not a provider. */
  maxEntries: number
  /** Total UNCOMPRESSED bytes. The cap a gzip bomb runs into, since the wire cap cannot see it. */
  maxTotalBytes: number
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxEntries: 4_000,
  maxTotalBytes: 64 * 1024 * 1024,
}

export class TarballError extends Error {}

const field = (block: Buffer, offset: number, length: number): string => {
  const raw = block.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return (end === -1 ? raw : raw.subarray(0, end)).toString('utf8')
}

/** Octal, space-padded, occasionally empty. Base-256 sizes are a GNU extension npm never emits. */
function octal(block: Buffer, offset: number, length: number): number {
  const text = field(block, offset, length).trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  if (!Number.isFinite(value) || value < 0) throw new TarballError('the archive has a malformed header field')
  return value
}

/** A block of nothing but NULs — the end-of-archive marker, and the padding after it. */
const isZeroBlock = (block: Buffer): boolean => block.every((byte) => byte === 0)

/**
 * The path checks, applied to every member before it is ever a filename.
 *
 * Each refusal names what it refused rather than saying "invalid": whoever is looking at this
 * message is deciding whether a package is hostile or merely built oddly, and the difference is
 * the whole content of the answer.
 */
function safeRelativePath(name: string): string {
  if (name.includes('\0')) throw new TarballError('the archive names a path containing a NUL byte')
  if (name.startsWith('/')) throw new TarballError(`the archive names an absolute path (${name})`)
  if (/^[a-zA-Z]:[\\/]/.test(name)) throw new TarballError(`the archive names an absolute path (${name})`)
  if (name.includes('\\')) throw new TarballError(`the archive names a path with a backslash in it (${name})`)
  if (!name.startsWith(NPM_ROOT)) {
    throw new TarballError(
      `the archive has a member outside "${NPM_ROOT}" (${name}) — an npm package tarball roots everything under it`,
    )
  }
  const relative = name.slice(NPM_ROOT.length)
  if (relative.split('/').some((segment) => segment === '..')) {
    throw new TarballError(`the archive names a path that climbs out of the package (${name})`)
  }
  return relative
}

/** The member kinds this refuses, each with the word a reader would search for. */
const REFUSED_TYPES: Record<string, string> = {
  '1': 'a hard link',
  '2': 'a symbolic link',
  '3': 'a character device',
  '4': 'a block device',
  '6': 'a FIFO',
  '7': 'a contiguous file',
}

/** The `path=` record of a pax extended header, which is how a long member name arrives. */
function paxPathOf(data: Buffer): string | undefined {
  let found: string | undefined
  for (const line of data.toString('utf8').split('\n')) {
    // "%d path=%s" — the length prefix is redundant once the record is split on newlines.
    const match = /^\d+ path=(.*)$/.exec(line)
    if (match) found = match[1]
  }
  return found
}

/**
 * Every regular file in a gzipped npm tarball, keyed by its path WITHOUT the `package/` prefix.
 *
 * Directories are dropped: the writer creates whatever a file's path needs, so an archive that
 * omits its directory members (some do) and one that lists them produce the same tree.
 */
export function readNpmTarball(gzipped: Buffer, limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS): Map<string, Buffer> {
  let tar: Buffer
  try {
    tar = gunzipSync(gzipped)
  } catch (err) {
    throw new TarballError(`the archive is not gzip data: ${(err as Error).message}`)
  }
  if (tar.length % BLOCK !== 0) throw new TarballError('the archive is truncated (its length is not a multiple of 512)')

  const files = new Map<string, Buffer>()
  let total = 0
  /** A pax header's `path=` record applies to the NEXT member and nothing after it. */
  let paxPath: string | undefined

  for (let offset = 0; offset + BLOCK <= tar.length; ) {
    const header = tar.subarray(offset, offset + BLOCK)
    offset += BLOCK
    if (isZeroBlock(header)) break

    // POSIX writes "ustar\0", GNU writes "ustar " — both are read, nothing else is.
    if (field(header, 257, 6).trimEnd() !== 'ustar') {
      throw new TarballError('the archive is not a ustar tarball')
    }

    const size = octal(header, 124, 12)
    const dataBlocks = Math.ceil(size / BLOCK) * BLOCK
    if (offset + dataBlocks > tar.length) throw new TarballError('the archive is truncated')
    const data = tar.subarray(offset, offset + size)
    offset += dataBlocks

    const type = field(header, 156, 1)
    if (type === 'x' || type === 'X') {
      paxPath = paxPathOf(data) ?? paxPath
      continue
    }
    // A GLOBAL pax header applies to every following member, which is a thing npm does not emit
    // and a thing this parser will not guess at. Skipped, and any per-member override still wins.
    if (type === 'g') continue
    if (type === 'L' || type === 'K') {
      throw new TarballError('the archive uses GNU long-name headers, which this reader does not read')
    }

    const prefix = field(header, 345, 155)
    const name = paxPath ?? (prefix === '' ? field(header, 0, 100) : `${prefix}/${field(header, 0, 100)}`)
    paxPath = undefined

    if (type === '5') {
      safeRelativePath(name.endsWith('/') ? name : `${name}/`)
      continue
    }
    const refused = REFUSED_TYPES[type]
    if (refused) throw new TarballError(`the archive contains ${refused} (${name}), which this reader refuses`)
    if (type !== '' && type !== '0') {
      throw new TarballError(`the archive contains a member of an unknown kind (${name}, type "${type}")`)
    }

    const relative = safeRelativePath(name)
    if (relative === '') continue
    if (files.size + 1 > limits.maxEntries) {
      throw new TarballError(`the archive has more than ${limits.maxEntries} files`)
    }
    total += size
    if (total > limits.maxTotalBytes) {
      throw new TarballError(`the archive unpacks to more than ${limits.maxTotalBytes} bytes`)
    }
    files.set(relative, Buffer.from(data))
  }

  if (files.size === 0) throw new TarballError('the archive contains no files')
  return files
}

/* ------------------------------------------------------ the entry a manifest points at, again */

/** The parts of a `package.json` this reads. Mirrors core's `PersonalProviderManifest`. */
export interface ProviderPackageManifest {
  name?: unknown
  version?: unknown
  exports?: unknown
  module?: unknown
  main?: unknown
  dependencies?: unknown
}

/** Pick a target out of an `exports` value by condition, `require` last. */
function resolveExportTarget(target: unknown): string | undefined {
  if (typeof target === 'string') return target
  if (Array.isArray(target)) {
    for (const entry of target) {
      const found = resolveExportTarget(entry)
      if (found) return found
    }
    return undefined
  }
  if (target !== null && typeof target === 'object') {
    const conditions = target as Record<string, unknown>
    for (const condition of ['import', 'node', 'default', 'require']) {
      if (condition in conditions) {
        const found = resolveExportTarget(conditions[condition])
        if (found) return found
      }
    }
  }
  return undefined
}

/**
 * The file a package's manifest says to load: `exports` (the `.` entry, or the sugar form with
 * conditions at the top level), then `module`, then `main`, then `index.js`.
 *
 * A DELIBERATE SECOND COPY of `resolvePackageEntry` in `packages/core/src/config/
 * personal-providers.ts`, and the two must stay in step. It is copied rather than imported
 * because the SDK cannot depend on core — core depends on the SDK — and because the whole point
 * of running this is to learn, before publishing, whether the loader that will import this
 * package at an operator's next restart is going to find its entry point. A generator that
 * resolved the entry more leniently than the loader would happily describe an artifact nobody can
 * load. `packages/rockysurf/src/shop-entry.test.ts` packs a real provider and runs both, which is
 * what keeps the copy honest.
 */
export function resolvePackageEntry(
  packageDir: string,
  manifest: ProviderPackageManifest,
  existsAt: (path: string) => boolean = existsSync,
): string {
  const manifestPath = join(packageDir, 'package.json')
  const relative = (() => {
    const exports = manifest.exports
    if (typeof exports === 'string') return exports
    if (exports !== null && typeof exports === 'object' && !Array.isArray(exports)) {
      const record = exports as Record<string, unknown>
      const keys = Object.keys(record)
      const subpaths = keys.some((key) => key.startsWith('.'))
      const target = subpaths ? record['.'] : record
      if (subpaths && target === undefined) {
        throw new Error(`${manifestPath} declares "exports" with no "." entry, so the package has no main entry to load`)
      }
      const found = resolveExportTarget(target)
      if (found) return found
      throw new Error(`${manifestPath} declares "exports" with no import, node, default or require target for "."`)
    }
    if (Array.isArray(exports)) {
      const found = resolveExportTarget(exports)
      if (found) return found
    }
    if (typeof manifest.module === 'string') return manifest.module
    if (typeof manifest.main === 'string') return manifest.main
    return './index.js'
  })()
  const entry = resolve(packageDir, relative)
  if (!existsAt(entry)) {
    throw new Error(`${manifestPath} points at ${relative}, which does not exist — is the package built?`)
  }
  return entry
}

/**
 * Is this module's export a provider factory, structurally?
 *
 * The same checks core's `asProviderFactory` makes, minus the config-section id comparison —
 * there is no config section here, and the id is what this is reading OUT of the package.
 */
export function asProviderFactory(candidate: unknown): ProviderFactory {
  const factory = ((candidate as { default?: unknown } | null)?.default ?? candidate) as Partial<ProviderFactory> | null
  if (factory === null || typeof factory !== 'object') {
    throw new Error(
      'the package does not export a provider factory (expected a default export with id, displayName, configSchema and createProvider)',
    )
  }
  if (typeof factory.id !== 'string' || factory.id.length === 0) throw new Error('the factory has no id')
  if (typeof factory.displayName !== 'string') throw new Error('the factory has no displayName')
  if (typeof factory.configSchema?.parse !== 'function') throw new Error('the factory has no configSchema.parse()')
  if (typeof factory.createProvider !== 'function') throw new Error('the factory has no createProvider()')
  if (factory.credentialEnv !== undefined) {
    if (!Array.isArray(factory.credentialEnv) || factory.credentialEnv.some((v) => typeof v !== 'string')) {
      throw new Error('the factory declares credentialEnv, which must be an array of variable names')
    }
  }
  if (factory.credentialField !== undefined && typeof factory.credentialField !== 'string') {
    throw new Error('the factory declares credentialField, which must be a string')
  }
  return factory as ProviderFactory
}

/* ------------------------------------------------------------------------------- the entry */

/** One row of a listing's `settings` summary: what an operator will be asked for, and nothing else. */
export interface ShopEntrySettingSummary {
  name: string
  label: string
  kind: ProviderSettingKind
}

/**
 * One object of the shop's `providers.json` array, in the key order the shop's file uses.
 *
 * The order is not cosmetic: the generated object is pasted into a reviewed JSON file, and an
 * entry whose keys arrive in a different order than its neighbours' makes every diff of that file
 * harder to read than it needs to be.
 */
export interface ShopEntry {
  providerId: string
  name: string
  description: string
  version: string
  package: string
  tarball: string
  sha256: string
  settings: ShopEntrySettingSummary[]
  capabilities: Record<string, boolean | number>
}

/** The five every provider answers, in the order the shop's validator lists them. */
const REQUIRED_CAPABILITIES = ['stop', 'ipStableAcrossStop', 'canInjectHostKeys', 'generatesUserData', 'userDataMaxBytes'] as const

/** The three a provider may set, in the order the shop's validator lists them. */
const OPTIONAL_CAPABILITIES = ['managesSshAccess', 'billsWhileStopped', 'simulatedInstances'] as const

/**
 * A configuration built from the declared fields' own examples, so the provider can be constructed.
 *
 * `capabilities` belongs to a CONSTRUCTED provider, and `createProvider` takes a parsed config, so
 * something has to stand in for the operator's file. The declaration already carries the answer:
 * ADR-0027 requires every declared field's `example` to parse through `configSchema`, and
 * conformance asserts it, so the examples together are a config the schema accepts. The
 * conversions below are the ones `assertSettingsShape` makes, deliberately identical — a secret
 * becomes a placeholder rather than the name of a variable nobody exported, a list becomes a
 * one-element list.
 */
export function probeConfigFor(factory: ProviderFactory): ProviderConfig {
  const candidate: Record<string, unknown> = {}
  for (const declared of factory.settings?.fields ?? []) {
    if (declared.example === undefined) continue
    candidate[declared.name] =
      declared.kind === 'secret' && declared.accepts !== 'literal'
        ? 'shop-entry-placeholder-credential'
        : declared.kind === 'number'
          ? Number(declared.example)
          : declared.kind === 'boolean'
            ? declared.example === 'true'
            : declared.kind === 'stringList' || declared.kind === 'sshCidrList'
              ? [declared.example]
              : declared.example
  }
  try {
    return factory.configSchema.parse(candidate)
  } catch (err) {
    throw new Error(
      `the package's configSchema refuses a configuration built from its own declared examples, so its capabilities ` +
        `cannot be read: ${(err as Error).message}. Every field in settings.fields needs an example that parses — ` +
        'that is what `assertSettingsShape` checks, so run conformance before publishing.',
    )
  }
}

/** The capability struct as a listing carries it: the required five, then whichever optionals are set. */
export function capabilitiesOf(capabilities: ProviderCapabilities): Record<string, boolean | number> {
  const out: Record<string, boolean | number> = {}
  for (const key of REQUIRED_CAPABILITIES) {
    const value = capabilities[key]
    if (typeof value !== (key === 'userDataMaxBytes' ? 'number' : 'boolean')) {
      throw new Error(`the provider's capabilities.${key} is ${JSON.stringify(value)}, which the shop's listing refuses`)
    }
    out[key] = value
  }
  for (const key of OPTIONAL_CAPABILITIES) {
    const value = capabilities[key]
    if (value === undefined) continue
    if (typeof value !== 'boolean') {
      throw new Error(`the provider's capabilities.${key} is ${JSON.stringify(value)}, which must be a boolean when set`)
    }
    out[key] = value
  }
  return out
}

export interface ShopEntryOptions {
  /** The packed `.tgz`, as bytes. Its digest is the listing's `sha256`. */
  tarball: Buffer
  /** Where the same bytes will be downloaded from. https only. */
  tarballUrl: string
  /** The one line a person reads before installing. The one field no artifact can supply. */
  description: string
  /** Where to unpack while reading. Defaults to a fresh directory under the system temp dir. */
  workDir?: string
  /** Seam for the test: how the extracted entry point is loaded. */
  importModule?: (url: string) => Promise<unknown>
}

/**
 * Read a packed provider and describe it as a shop listing entry.
 *
 * The two refusals are here rather than in the bin because they are facts about the artifact and
 * the listing, not about the command line:
 *
 * - **A non-empty `dependencies` is refused, naming them.** The documented install is `tar -xzf`
 *   into `<dataDir>/providers` and nothing resolves a dependency for it, so a listing for a
 *   package with one describes an artifact that will fail to import at the operator's next
 *   restart. That is a publishing bug, and the moment to catch it is before the pull request.
 * - **A non-https tarball URL is refused.** A provider artifact is code; the shop's own validator
 *   refuses `http`, and so does this, so the answer arrives before the pull request rather than
 *   from CI.
 */
export async function shopEntryFor(options: ShopEntryOptions): Promise<ShopEntry> {
  let url: URL
  try {
    url = new URL(options.tarballUrl)
  } catch {
    throw new Error(`--tarball-url ${options.tarballUrl} is not a URL`)
  }
  if (url.protocol !== 'https:') {
    throw new Error(`--tarball-url must be https — a provider artifact is code, and ${url.protocol} is refused`)
  }
  const description = options.description.trim()
  if (description === '') throw new Error('--description is the one line a person reads before installing; it cannot be empty')

  const files = readNpmTarball(options.tarball)
  const manifestBytes = files.get('package.json')
  if (!manifestBytes) throw new Error('the archive has no package/package.json, so it is not an npm package tarball')
  let manifest: ProviderPackageManifest
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8')) as ProviderPackageManifest
  } catch (err) {
    throw new Error(`the archive's package.json is not valid JSON: ${(err as Error).message}`)
  }
  if (typeof manifest.name !== 'string' || manifest.name === '') throw new Error("the archive's package.json has no name")
  if (typeof manifest.version !== 'string' || manifest.version === '') throw new Error("the archive's package.json has no version")

  const dependencies = Object.keys((manifest.dependencies as Record<string, string> | undefined) ?? {})
  if (dependencies.length > 0) {
    throw new Error(
      `${manifest.name} declares runtime dependencies (${dependencies.join(', ')}) and a provider is installed by ` +
        'unpacking a tarball, which resolves none of them — bundle them into your dist/ or drop them, then pack again.',
    )
  }

  const workDir = options.workDir ?? mkdtempSync(join(tmpdir(), 'rockysurf-shop-entry-'))
  const ownsWorkDir = options.workDir === undefined
  try {
    for (const [relative, bytes] of files) {
      const target = join(workDir, relative)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes)
    }
    const entry = resolvePackageEntry(workDir, manifest)
    const importModule = options.importModule ?? ((href: string) => import(href))
    const factory = asProviderFactory(await importModule(pathToFileURL(entry).href))
    const capabilities = capabilitiesOf(factory.createProvider(probeConfigFor(factory)).capabilities)

    return {
      providerId: factory.id,
      // The panel's title is what the operator will see over these very fields once it is
      // installed, so a listing that says something else is a second name for one thing.
      name: factory.settings?.title ?? factory.displayName ?? factory.id,
      description,
      version: manifest.version,
      package: manifest.name,
      tarball: options.tarballUrl,
      sha256: createHash('sha256').update(options.tarball).digest('hex'),
      settings: (factory.settings?.fields ?? []).map((declared) => ({
        name: declared.name,
        label: declared.label,
        kind: declared.kind,
      })),
      capabilities,
    }
  } finally {
    if (ownsWorkDir) rmSync(workDir, { recursive: true, force: true })
  }
}

/** The bytes of a `.tgz` on disk, with a message naming the path when it is not there. */
export function readTarballFile(path: string): Buffer {
  try {
    return readFileSync(path)
  } catch (err) {
    throw new Error(`${path} could not be read: ${(err as Error).message}`)
  }
}
