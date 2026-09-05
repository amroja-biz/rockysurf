import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  PERSONAL_PROVIDERS_DIRNAME,
  resolvePackageEntry,
  type PersonalProviderManifest,
} from '../config/personal-providers.js'
import { fetchPublicBytes } from '../packs/safe-fetch.js'
import type { Change } from '../settings/document.js'
import { readNpmTarball, TarballError } from './tarball.js'
import type { ProviderRegistryEntry } from './shop-index.js'

/**
 * INSTALLING A PROVIDER FROM THE SHOP (ADR-0028).
 *
 * ADR-0026 made a personal provider an npm package named in the config file and installed under
 * `<dataDir>/providers` by hand — `npm install` in that directory, then a line in the file. This
 * module is the other way to get there: fetch the artifact a registry listed, verify it, unpack
 * it into the same place, and hand the caller the two config lines to write. What lands on disk
 * is byte-for-byte the same arrangement a hand `npm install` produces, which is the property
 * worth stating: the shop is a way of doing the manual thing, not a second mechanism with its
 * own loader.
 *
 * WHAT IT WILL NOT DO, in the order the risks matter:
 *
 *  1. **It never executes anything.** No npm, no lifecycle scripts, no code from the package at
 *     any point. `scripts` in a fetched `package.json` is data that is read and ignored. The
 *     package's code runs at the next RESTART, when the composition root's loader imports it —
 *     which is the moment the operator chose, and why the install says to restart rather than
 *     pretending the provider is live.
 *  2. **It never writes outside the destination.** `readNpmTarball` refuses absolute paths,
 *     `..`, symlinks, hard links and device nodes before a single byte reaches the filesystem,
 *     and everything is staged in a sibling directory and renamed into place.
 *  3. **It never fetches over http, from a private address, or without a size cap.** The URL is
 *     https-only at the schema, the fetch goes through the same SSRF guard pack import uses, and
 *     the body is capped on the wire and again after decompression.
 *  4. **It never installs an artifact the listing does not describe.** The digest is verified
 *     before the archive is opened; the manifest's `name` must be the package the listing named;
 *     and the manifest's entry must resolve through the SAME resolver the loader will use, so a
 *     package that installs cleanly is one that can actually be loaded.
 *  5. **It never installs something that cannot run here.** Nothing resolves a dependency for
 *     this package, so a declared runtime dependency that is not already under
 *     `<dataDir>/providers` would be an import failure at the next restart — reported as a
 *     provider that will not load, hours after the operator thought they had installed it. The
 *     check happens now, and the refusal names the missing packages.
 */

/** How big a provider tarball may be on the wire. Generous for code, tiny for a tarpit. */
export const MAX_PROVIDER_TARBALL_BYTES = 16 * 1024 * 1024

export interface ProviderInstallDeps {
  /** `<dataDir>/providers` — where names resolve from, and where the package lands. */
  providersDir: string
  /** The fetch seam. Defaults to the SSRF-guarded byte fetch; tests inject a stub. */
  fetchBytes?: typeof fetchPublicBytes
}

export interface InstalledProviderPackage {
  /** The package name, as its own manifest declares it. */
  name: string
  /** Its version, from the manifest on disk — the thing a later listing compares against. */
  version: string
  /** Where it now lives. */
  packageDir: string
  /** The file the loader will import, resolved by the loader's own rules. */
  entryFile: string
}

export type ProviderInstallResult =
  | { ok: true; installed: InstalledProviderPackage }
  | { ok: false; reason: string }

/** Where a package name lands under the providers directory — npm's own layout, not ours. */
export function providerPackageDir(providersDir: string, packageName: string): string {
  return join(providersDir, 'node_modules', ...packageName.split('/'))
}

/**
 * The manifest of an installed package, or undefined when nothing is installed there.
 *
 * Read from DISK rather than remembered in a database, deliberately. The question a listing asks
 * is "what version of this is on this machine", and the only honest answer is the one the files
 * give: a record kept elsewhere would go stale the moment somebody ran `npm install` in that
 * directory by hand, which is a thing ADR-0026 explicitly tells them they may do.
 */
export function installedProviderManifest(
  providersDir: string,
  packageName: string,
): { name: string; version: string } | undefined {
  const manifestPath = join(providerPackageDir(providersDir, packageName), 'package.json')
  if (!existsSync(manifestPath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as PersonalProviderManifest
    return {
      name: typeof parsed.name === 'string' ? parsed.name : packageName,
      version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
    }
  } catch {
    // A package.json that will not parse is a broken installation, not a version. Say nothing.
    return undefined
  }
}

/** `<dataDir>/providers` for a data directory. One definition, used by routes and by the loader. */
export const providersDirFor = (dataDir: string): string => join(dataDir, PERSONAL_PROVIDERS_DIRNAME)

/**
 * The marker file that makes `<dataDir>/providers` a place npm names resolve from.
 *
 * Written only if absent, and deliberately minimal. Node resolves a bare specifier from a base
 * path by walking up looking for `node_modules`, and `module.findPackageJSON` is given
 * `<providersDir>/package.json` as that base; an operator who followed ADR-0026's instructions
 * (`npm init -y && npm install …`) already has one, and this is the same file for an operator
 * who installed from the shop instead. It declares nothing about dependencies, so a later `npm
 * install` by hand in that directory is unaffected by it.
 */
function ensureProvidersDir(providersDir: string): void {
  mkdirSync(join(providersDir, 'node_modules'), { recursive: true })
  const manifestPath = join(providersDir, 'package.json')
  if (existsSync(manifestPath)) return
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ name: 'rockysurf-personal-providers', private: true, version: '0.0.0' }, null, 2)}\n`,
    'utf8',
  )
}

/** Every runtime dependency the manifest declares that is not already resolvable from here. */
function missingDependencies(manifest: PersonalProviderManifest, providersDir: string, packageDir: string): string[] {
  const declared = manifest.dependencies
  if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) return []
  return Object.keys(declared as Record<string, unknown>).filter((name) => {
    const segments = name.split('/')
    return (
      !existsSync(join(packageDir, 'node_modules', ...segments)) &&
      !existsSync(join(providersDir, 'node_modules', ...segments))
    )
  })
}

/** Write an extracted tree, creating whatever directories the paths imply. */
function writeTree(files: Map<string, Buffer>, destination: string): void {
  for (const [relative, bytes] of files) {
    const target = join(destination, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes, { mode: 0o644 })
  }
}

/**
 * Fetch, verify and unpack one listed provider. Never throws; every problem is a `reason`.
 *
 * REPLACES rather than merges, which is what makes an update the same operation as an install.
 * The new tree is staged beside the destination and swapped in only once every check has passed,
 * so a refusal — a bad digest, a manifest naming a different package, a missing dependency —
 * leaves whatever was installed before exactly as it was. There is no half-updated state to be
 * in, and no rollback to get wrong.
 */
export async function installProviderPackage(
  entry: ProviderRegistryEntry,
  deps: ProviderInstallDeps,
): Promise<ProviderInstallResult> {
  const fetchBytes = deps.fetchBytes ?? fetchPublicBytes
  const { providersDir } = deps

  let url: URL
  try {
    url = new URL(entry.tarball)
  } catch {
    return { ok: false, reason: `${entry.tarball} is not a valid URL.` }
  }
  if (url.protocol !== 'https:') {
    // The schema already refuses this; checked again here because this function is the one that
    // writes code to disk and it must not depend on having been called through the schema.
    return { ok: false, reason: `${entry.tarball} is not an https URL. A provider artifact is code; http is refused.` }
  }

  const fetched = await fetchBytes(entry.tarball, { maxBytes: MAX_PROVIDER_TARBALL_BYTES })
  if (!fetched.ok) return { ok: false, reason: fetched.reason }

  const digest = createHash('sha256').update(fetched.bytes).digest('hex')
  if (digest !== entry.sha256) {
    return {
      ok: false,
      reason:
        `${entry.tarball} does not match the digest the listing published for it ` +
        `(the listing says ${entry.sha256}, the file is ${digest}). Refusing to install it.`,
    }
  }

  let files: Map<string, Buffer>
  try {
    files = readNpmTarball(fetched.bytes)
  } catch (err) {
    const message = err instanceof TarballError ? err.message : (err as Error).message
    return { ok: false, reason: `${entry.tarball} could not be unpacked: ${message}` }
  }

  const manifestBytes = files.get('package.json')
  if (!manifestBytes) return { ok: false, reason: `${entry.tarball} has no package.json, so it is not a package.` }
  let manifest: PersonalProviderManifest
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8')) as PersonalProviderManifest
  } catch (err) {
    return { ok: false, reason: `${entry.tarball} has a package.json that is not valid JSON: ${(err as Error).message}` }
  }
  if (manifest.name !== entry.package) {
    return {
      ok: false,
      reason:
        `${entry.tarball} contains the package "${String(manifest.name)}" but the listing says it is ` +
        `"${entry.package}". The listing disagrees with the artifact it points at.`,
    }
  }

  ensureProvidersDir(providersDir)
  const destination = providerPackageDir(providersDir, entry.package)
  const staging = `${destination}.rockysurf-installing`
  rmSync(staging, { recursive: true, force: true })

  try {
    mkdirSync(staging, { recursive: true })
    writeTree(files, staging)

    let entryFile: string
    try {
      // THE LOADER'S OWN RESOLVER, run against the staged tree. A package whose `exports` point
      // at a file the tarball does not carry — a build that shipped its manifest and not its
      // `dist` — is refused here rather than at the next restart.
      entryFile = resolvePackageEntry(staging, manifest)
    } catch (err) {
      return { ok: false, reason: `${entry.tarball} is not loadable: ${(err as Error).message}` }
    }

    const missing = missingDependencies(manifest, providersDir, staging)
    if (missing.length > 0) {
      return {
        ok: false,
        reason:
          `${entry.package} declares runtime dependencies that are not installed here: ${missing.join(', ')}. ` +
          'Rocky Surf never runs npm, so a provider published to the shop has to carry everything it ' +
          'needs — see docs/writing-a-provider.md, "Publishing to the shop".',
      }
    }

    // The swap. `rm` then `rename` rather than a rename of the old tree aside, because a
    // half-removed previous install and a half-renamed new one are the same recovery problem and
    // this way there is only one directory to think about.
    rmSync(destination, { recursive: true, force: true })
    mkdirSync(dirname(destination), { recursive: true })
    renameSync(staging, destination)

    return {
      ok: true,
      installed: {
        name: entry.package,
        version: typeof manifest.version === 'string' ? manifest.version : entry.version,
        packageDir: destination,
        entryFile: join(destination, entryFile.slice(staging.length + 1)),
      },
    }
  } catch (err) {
    return { ok: false, reason: `${entry.package} could not be written to ${destination}: ${(err as Error).message}` }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Delete an installed provider package, and any now-empty scope directory above it.
 *
 * The scope tidy-up matters more than it looks: `@someone/provider` leaves `node_modules/@someone`
 * behind, and a directory of nothing is a thing an operator later reads as "something is still
 * installed". Removed only when it is empty, so a second package from the same author survives.
 */
export function removeProviderPackage(providersDir: string, packageName: string): void {
  const packageDir = providerPackageDir(providersDir, packageName)
  rmSync(packageDir, { recursive: true, force: true })
  if (!packageName.startsWith('@')) return
  const scopeDir = dirname(packageDir)
  try {
    if (readdirSync(scopeDir).length === 0) rmSync(scopeDir, { recursive: true, force: true })
  } catch {
    // The scope directory is already gone, which is the outcome this wanted anyway.
  }
}

/**
 * The config-file edits an install makes: which package implements this provider, and on.
 *
 * Returned rather than applied, so the route writes them through the SAME path the Settings page
 * writes every other setting through (ADR-0017): apply to the document, validate the candidate
 * text with the schema, write atomically, then ask this process to adopt it. An installer that
 * wrote YAML by itself would be a second way for the config file to change, and the first thing
 * that would drift is the comment preservation the Document API exists for.
 *
 * `enabled: true` because the operator who just installed a provider asked for it, and a section
 * that arrived switched off would need a second, unexplained visit to Settings. It costs nothing
 * if the provider is not configured yet: an enabled provider that cannot construct is reported as
 * unavailable with its own reason, which is the state ADR-0026 already handles.
 */
export function providerInstallChanges(providerId: string, packageName: string): Change[] {
  return [
    { path: ['providers', providerId, 'package'], value: packageName },
    { path: ['providers', providerId, 'enabled'], value: true },
  ]
}

/** The config-file edit a removal makes: the whole section goes, package line and all. */
export function providerRemovalChanges(providerId: string): Change[] {
  return [{ path: ['providers', providerId], unset: true }]
}
