import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import * as nodeModule from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { personalProviderSections, type Config } from '@rockysurf/core'
import type { ProviderFactory } from '@rockysurf/provider-sdk'

/**
 * LOADING A PROVIDER ROCKY SURF DID NOT SHIP (ADR-0026, issue #294).
 *
 * The composition root's table of five factories is static, and until this file that was the
 * whole set: a provider existed by being imported here. A PERSONAL provider is one the operator
 * installed themselves and named in the config file —
 *
 * ```yaml
 * providers:
 *   digitalocean:
 *     package: "@someone/rockysurf-provider-digitalocean"
 *     enabled: true
 * ```
 *
 * — and this file turns that `package` into a `ProviderFactory` the ordinary composition can use.
 *
 * THE TRUST MODEL IS FULL TRUST, STATED PLAINLY. A provider is software, and installing one is
 * installing software that runs inside this process with everything this process can reach: its
 * database, its master key, every cloud credential in its environment. There is no sandbox, no
 * second process and no protocol fence, by the owner's decision, because a fence that a provider
 * could not do its job behind would be theatre. The obligation that replaces it is one sentence,
 * printed where a person decides: **a provider runs with Rocky Surf's full access — install ones
 * you trust.** `docs/self-hosting.md` carries it, `SECURITY.md` carries it, and the boot log
 * repeats it beside every personal provider it loads.
 *
 * WHERE PACKAGES COME FROM. An npm name resolves from `<dataDir>/providers` — `~/.rockysurf/providers`
 * by default, `/data/providers` in the container — where the operator ran `npm install`. That
 * directory is outside the application's own `node_modules`, which is the point: `npx
 * rockysurf@latest`, `git pull && pnpm -r build`, `./start.sh` and a Docker image rebuild all
 * replace the application and none of them touch the data directory, so a provider installed once
 * stays installed. A PATH (`/…`, `./…`, `../…`, `~/…`) is imported directly — the shape for
 * somebody developing a provider in a checkout beside this one.
 *
 * WHY RESOLUTION IS BY HAND. `createRequire(...).resolve(name)` was the obvious tool and it fails
 * on every provider package this repository ships: they declare import-only conditional `exports`
 * (`{ ".": { "types": …, "import": … } }`) and the `require` resolver answers
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. An author who copies Hetzner — which the skill tells them to —
 * produces a package that resolver cannot load by name. `module.findPackageJSON` finds the
 * manifest without taking a position on conditions (Node 24; stability 1.1, so it is guarded and
 * the fallback is the directory npm puts a direct dependency in), and the entry is read from the
 * manifest itself, honouring `exports` in the order `import`, `node`, `default`, `require` —
 * `require` LAST and never refused, because `import()` loads a CommonJS module perfectly well and
 * hands back `{ default: module.exports }`.
 *
 * LOADED ONCE, BEFORE BOOT. `import()` is asynchronous and `composeRegistry` is synchronous and
 * re-run on every config change (`server.ts`, issue #264), so the loading happens once, at CLI
 * start, and the composition closes over the result — see `runRockysurfCli`. Every personal
 * section in the file is loaded whether or not it is enabled, so an operator can switch one on
 * from the Settings page without a restart; a section that appears in the file AFTER boot is
 * reported "restart to load it", which is honest and cheap. Every failure — a package that cannot
 * be found, one that throws on import, one that is not a provider factory, one whose id disagrees
 * with the section key — is a `failures` entry, which composition turns into an unavailable
 * provider with that reason. Nothing here is fatal: the UI is where the operator fixes it.
 */

/** The subdirectory of the data directory personal providers are installed under. */
export const PERSONAL_PROVIDERS_DIRNAME = 'providers'

/** The one honest sentence. Quoted verbatim in the docs and the boot log; do not paraphrase it. */
export const PERSONAL_PROVIDER_TRUST_SENTENCE = "a provider runs with Rocky Surf's full access — install ones you trust."

export interface LoadedPersonalProviders {
  /** By provider id (the config key), every factory that loaded, enabled or not. */
  factories: Map<string, ProviderFactory>
  /** By provider id, why a section's package did not load — the sentence the operator sees. */
  failures: Map<string, string>
  /** By provider id, the file that was imported — for the boot log. */
  sources: Map<string, string>
}

export interface LoadPersonalProvidersOptions {
  config: Config
  /** Where names resolve from. Defaults to `<config.server.dataDir>/providers`. */
  providersDir?: string
  /** Test seam: what `import()` is. */
  importModule?: (url: string) => Promise<unknown>
  /** Test seam: the home directory `~` expands to. */
  home?: string
}

/** A `package:` value that is a path rather than an npm name. */
export function isPathSpecifier(spec: string): boolean {
  return spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../') || spec === '~' || spec.startsWith('~/')
}

/** Where personal providers resolve from for a given config. */
export function personalProvidersDir(config: Config): string {
  return join(config.server.dataDir, PERSONAL_PROVIDERS_DIRNAME)
}

interface Manifest {
  name?: unknown
  exports?: unknown
  module?: unknown
  main?: unknown
}

/**
 * Pick a target out of an `exports` value by condition, `require` last.
 *
 * Handles the shapes real published packages use: a string, an array of fallbacks (first one
 * that resolves wins), a conditions object, and conditions nested inside conditions
 * (`{ "node": { "import": "./x.js" } }`).
 */
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
 */
export function resolvePackageEntry(packageDir: string, manifest: Manifest): string {
  const relative = (() => {
    const exports = manifest.exports
    if (typeof exports === 'string') return exports
    if (exports !== null && typeof exports === 'object' && !Array.isArray(exports)) {
      const record = exports as Record<string, unknown>
      const keys = Object.keys(record)
      const subpaths = keys.some((key) => key.startsWith('.'))
      const target = subpaths ? record['.'] : record
      if (subpaths && target === undefined) {
        throw new Error(
          `${join(packageDir, 'package.json')} declares "exports" with no "." entry, so the package has no main entry to load`,
        )
      }
      const found = resolveExportTarget(target)
      if (found) return found
      throw new Error(
        `${join(packageDir, 'package.json')} declares "exports" with no import, node, default or require target for "."`,
      )
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
  if (!existsSync(entry)) {
    throw new Error(`${join(packageDir, 'package.json')} points at ${relative}, which does not exist — is the package built?`)
  }
  return entry
}

/** `module.findPackageJSON`, when this Node has it (stability 1.1 — guarded, with a fallback). */
function findManifestByName(name: string, providersDir: string): string | undefined {
  const finder = (nodeModule as { findPackageJSON?: (specifier: string, base: string) => string | undefined })
    .findPackageJSON
  if (typeof finder === 'function') {
    try {
      const found = finder(name, join(providersDir, 'package.json'))
      if (found) return found
    } catch {
      // Fall through to the directory npm puts a direct dependency in.
    }
  }
  const candidate = join(providersDir, 'node_modules', ...name.split('/'), 'package.json')
  return existsSync(candidate) ? candidate : undefined
}

/**
 * The file to `import()` for a `package:` value.
 *
 * A path names either a package directory (its manifest decides the entry) or a file (imported as
 * is). A name is looked up under `providersDir`.
 */
export function resolveProviderPackage(spec: string, providersDir: string, home: string = homedir()): string {
  if (isPathSpecifier(spec)) {
    const expanded = spec === '~' ? home : spec.startsWith('~/') ? join(home, spec.slice(2)) : spec
    const absolute = isAbsolute(expanded) ? expanded : resolve(providersDir, expanded)
    if (!existsSync(absolute)) throw new Error(`${absolute} does not exist`)
    if (statSync(absolute).isDirectory()) {
      const manifestPath = join(absolute, 'package.json')
      if (!existsSync(manifestPath)) throw new Error(`${absolute} is a directory with no package.json`)
      return resolvePackageEntry(absolute, JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest)
    }
    return absolute
  }

  const manifestPath = findManifestByName(spec, providersDir)
  if (!manifestPath) {
    throw new Error(
      `${spec} is not installed under ${providersDir}. Install it there — ` +
        `mkdir -p ${providersDir} && cd ${providersDir} && npm init -y && npm install ${spec} — ` +
        'or name a path to a built package instead.',
    )
  }
  return resolvePackageEntry(dirname(manifestPath), JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest)
}

/**
 * Is this a provider factory, structurally? The same checks `assertFactoryShape` makes minus the
 * I/O probe, because a personal package carries its own copy of the SDK and no `instanceof` can
 * be trusted across the two.
 */
export function asProviderFactory(candidate: unknown, expectedId: string): ProviderFactory {
  const factory = ((candidate as { default?: unknown } | null)?.default ?? candidate) as Partial<ProviderFactory> | null
  if (factory === null || typeof factory !== 'object') {
    throw new Error('the package does not export a provider factory (expected a default export with id, displayName, configSchema and createProvider)')
  }
  if (typeof factory.id !== 'string' || factory.id.length === 0) throw new Error('the factory has no id')
  if (factory.id !== expectedId) {
    throw new Error(
      `the package's factory id is '${factory.id}' but the config section is providers.${expectedId} — ` +
        `rename the section to providers.${factory.id}`,
    )
  }
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

/**
 * Load every personal provider the config names. Never throws; every problem is a `failures`
 * entry that composition reports as an unavailable provider.
 */
export async function loadPersonalProviders(options: LoadPersonalProvidersOptions): Promise<LoadedPersonalProviders> {
  const providersDir = options.providersDir ?? personalProvidersDir(options.config)
  const importModule = options.importModule ?? ((url: string) => import(url))
  const factories = new Map<string, ProviderFactory>()
  const failures = new Map<string, string>()
  const sources = new Map<string, string>()

  for (const [id, section] of Object.entries(personalProviderSections(options.config))) {
    let entry: string
    try {
      entry = resolveProviderPackage(section.package, providersDir, options.home)
    } catch (err) {
      failures.set(id, `package "${section.package}" could not be found: ${(err as Error).message}`)
      continue
    }
    let loaded: unknown
    try {
      loaded = await importModule(pathToFileURL(entry).href)
    } catch (err) {
      failures.set(id, `package "${section.package}" failed to load from ${entry}: ${(err as Error).message}`)
      continue
    }
    try {
      factories.set(id, asProviderFactory(loaded, id))
      sources.set(id, entry)
    } catch (err) {
      failures.set(id, `package "${section.package}" (${entry}) is not a Rocky Surf provider: ${(err as Error).message}`)
    }
  }

  return { factories, failures, sources }
}

/** An empty result, for a composition with nothing personal to load — tests, and the fallback. */
export function noPersonalProviders(): LoadedPersonalProviders {
  return { factories: new Map(), failures: new Map(), sources: new Map() }
}
