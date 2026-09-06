import { readFileSync, statSync } from 'node:fs'
import { Hono, type MiddlewareHandler } from 'hono'
import type { AppEnv } from '../app.js'
import { checkConfigText, PERSONAL_PROVIDER_TRUST_SENTENCE, type ReloadOutcome } from '../config/index.js'
import type { Db } from '../db/client.js'
import { badRequest, conflict, forbidden, notFound, success } from '../http/responses.js'
import { applyChanges, parseTree } from '../settings/document.js'
import { writeAtomically } from '../settings/routes.js'
import {
  installProviderPackage,
  installedProviderManifest,
  providerInstallChanges,
  providerRemovalChanges,
  removeProviderPackage,
} from './install.js'
import type { ProviderShopClient } from './shop.js'

/**
 * `/api/v1/admin/provider-registry` — browsing and installing providers from the shop (ADR-0028).
 *
 * FOUR PROPERTIES, each of which is a way this could have gone wrong:
 *
 *  1. **Nothing is fetched at boot.** These routes are the only thing that reads a provider
 *     listing, and they read it when an admin opens the tab. A control plane behind a proxy or
 *     off the internet entirely starts exactly as it does now — the rule `docs/self-hosting.md`
 *     states for the pack shelves, applied to this one without an exception.
 *  2. **The trust sentence is served by Rocky Surf, not by the registry.** It is on the response
 *     as one constant field, so an interface renders it once per listing and cannot get a
 *     softened version from a shop. See `PERSONAL_PROVIDER_TRUST_SENTENCE`.
 *  3. **The config write is the settings write.** Install and remove edit the file through the
 *     Document API, validate the candidate with `checkConfigText`, write atomically with the
 *     file's own mode, and then ask this process to adopt it — the same four steps, in the same
 *     order, as `PUT /api/v1/settings` (ADR-0017). Adoption puts the section in force; it does
 *     NOT load the package, which happens once before boot, so every install answers with the
 *     restart it needs rather than implying the provider is already there.
 *  4. **A removal that would strand machines is refused.** Servers carry the id of the provider
 *     that made them, and a provider whose package is gone cannot describe, stop or terminate
 *     one. So the count is checked first and the refusal names it, rather than leaving an
 *     operator with rows nothing can act on.
 *
 * Admin-only, all of it: installing a provider is installing software that runs with this
 * process's access, which is a strictly larger authority than installing a pack.
 */

export interface ProviderShopRoutesDeps {
  db: Db
  /** The listing client. Absent means the shop is unconfigured, which answers as switched off. */
  shop?: ProviderShopClient
  /** `<dataDir>/providers`, read at call time so a data directory is never captured stale. */
  providersDir: () => string
  /** The config file to write. Absent — an embedded core — makes install and remove refuse. */
  configPath?: string
  env?: NodeJS.ProcessEnv
  /** What makes a save take effect (issue #264). `createApp` supplies `configStore.reload`. */
  reload?: () => ReloadOutcome
  /** Which provider ids the config file currently names, so a listing can say "installed". */
  configuredProviderIds: () => string[]
  /** How many live servers a provider has, so a removal that would strand them is refused. */
  countServers: (providerId: string) => number
  /** Test seam: the installer. Defaults to the real fetch-verify-unpack. */
  install?: typeof installProviderPackage
}

/** One answer for "no shop", whether it is unconfigured or switched off. */
const noShop = () => ({ enabled: false, sources: [], shelves: [], trustSentence: PERSONAL_PROVIDER_TRUST_SENTENCE })

const NO_CONFIG_FILE =
  'This Rocky Surf has no config file, so there is nowhere to record a provider. Start it with ' +
  '--config <path>, or create ~/.rockysurf/config.yaml, and try again.'

export function createProviderShopRoutes(deps: ProviderShopRoutesDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  const { shop } = deps

  const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (!c.get('user').isAdmin) return forbidden(c, 'Admin access required')
    await next()
  }
  routes.use('/api/v1/admin/provider-registry', requireAdmin)
  routes.use('/api/v1/admin/provider-registry/*', requireAdmin)
  routes.use('/api/v1/admin/personal-providers/*', requireAdmin)

  routes.get('/api/v1/admin/provider-registry', async (c) => {
    if (!shop) return success(c, noShop())
    const providersDir = deps.providersDir()
    const configured = new Set(deps.configuredProviderIds())
    const shelves = await shop.browse({ force: c.req.query('refresh') === '1' })

    return success(c, {
      ...shop.describe(),
      /**
       * VERBATIM, ONCE, FROM HERE. The listing renderer prints this string beside every entry.
       * It is not a per-entry field because it is not a fact about any particular provider — it
       * is the bargain the whole mechanism makes, and a per-entry field is a field a shop could
       * one day be asked to fill in.
       */
      trustSentence: PERSONAL_PROVIDER_TRUST_SENTENCE,
      shelves: shelves.map((shelf) => ({
        source: shelf.source,
        fetchedAt: shelf.fetchedAt?.toISOString() ?? null,
        failure: shelf.failure ? { kind: shelf.failure.kind, reason: shelf.failure.reason } : null,
        providers: shelf.providers.map((entry) => {
          const onDisk = installedProviderManifest(providersDir, entry.package)
          return {
            ...entry,
            /** True when this installation has the package AND names it in the config file. */
            installed: onDisk !== undefined && configured.has(entry.providerId),
            /** What is on disk, which is how "Update" knows there is something to update to. */
            installedVersion: onDisk?.version ?? null,
          }
        }),
      })),
    })
  })

  /**
   * Install (or re-install, which is how an update happens).
   *
   * The entry is REFETCHED here rather than taken from whatever the browser sends back from the
   * listing. An install that trusted the client's copy would let whatever reached the page decide
   * which artifact gets written into this process's own module graph.
   */
  routes.post('/api/v1/admin/provider-registry/:sourceName/:providerId/install', async (c) => {
    if (!shop) return notFound(c, 'No registry is configured')
    if (!deps.configPath) return badRequest(c, NO_CONFIG_FILE)

    const found = await shop.getEntry(c.req.param('sourceName'), c.req.param('providerId'))
    if (!found.ok) {
      return found.kind === 'not-found' ? notFound(c, found.reason) : badRequest(c, found.reason)
    }
    const entry = found.entry

    const install = deps.install ?? installProviderPackage
    const result = await install(entry, { providersDir: deps.providersDir() })
    if (!result.ok) return badRequest(c, result.reason)

    const written = writeConfig(deps, providerInstallChanges(entry.providerId, entry.package))
    if (!written.ok) {
      // The package is on disk and the file is not, which is the recoverable half of the two:
      // nothing loads a package the config does not name, so the installation is inert. Removing
      // it keeps the two in step rather than leaving a directory nobody can see or delete.
      removeProviderPackage(deps.providersDir(), entry.package)
      return badRequest(c, written.reason)
    }

    return success(c, {
      providerId: entry.providerId,
      package: result.installed.name,
      version: result.installed.version,
      trustSentence: PERSONAL_PROVIDER_TRUST_SENTENCE,
      /**
       * Always true, and said plainly rather than left for the operator to infer. A personal
       * provider's package is imported once, before boot (ADR-0026), so no amount of config
       * adoption makes a newly installed one appear in this running process.
       */
      restartRequired: true,
      restartReason:
        'A provider package is loaded when Rocky Surf starts. Restart it to load ' +
        `${result.installed.name}, then configure ${entry.providerId} on the Settings page.`,
      ...(written.blocked ? { reloadBlocked: written.blocked } : {}),
    })
  })

  /**
   * Remove an installed personal provider: the package, and the config section that names it.
   *
   * Keyed by the PROVIDER ID rather than by a source and a listing entry, because a removal is
   * about this installation rather than about a shop — a provider whose registry has since gone
   * away must still be removable.
   */
  routes.delete('/api/v1/admin/personal-providers/:providerId', (c) => {
    if (!deps.configPath) return badRequest(c, NO_CONFIG_FILE)
    const providerId = c.req.param('providerId')

    const section = readSection(deps.configPath, providerId)
    if (!section) return notFound(c, `The config file has no providers.${providerId} section.`)

    const live = deps.countServers(providerId)
    if (live > 0) {
      return conflict(
        c,
        `${live} server(s) on this installation were created with ${providerId}. Removing the provider ` +
          'would leave nothing able to describe, stop or terminate them. Terminate them first, then ' +
          'remove the provider.',
      )
    }

    const written = writeConfig(deps, providerRemovalChanges(providerId))
    if (!written.ok) return badRequest(c, written.reason)

    // The package goes AFTER the config file no longer names it, so a failure between the two
    // leaves an unused directory rather than a config file pointing at nothing.
    if (section.package) removeProviderPackage(deps.providersDir(), section.package)

    return success(c, {
      providerId,
      removed: section.package ?? null,
      restartRequired: true,
      restartReason:
        `${providerId} is still loaded in this running process. Restart Rocky Surf to unload it.`,
      ...(written.blocked ? { reloadBlocked: written.blocked } : {}),
    })
  })

  return routes
}

/** What the file says about one provider section, without validating the whole document. */
function readSection(configPath: string, providerId: string): { package?: string } | undefined {
  let tree: unknown
  try {
    tree = parseTree(readFileSync(configPath, 'utf8'))
  } catch {
    return undefined
  }
  const providers = (tree as { providers?: Record<string, unknown> } | null)?.providers
  const section = providers?.[providerId]
  if (section === undefined) return undefined
  const pkg = (section as { package?: unknown } | null)?.package
  return typeof pkg === 'string' ? { package: pkg } : {}
}

/**
 * The settings save, minus the page: apply, validate, write, adopt (ADR-0017).
 *
 * Not routed through `PUT /api/v1/settings` itself, because that route's contract is "every path
 * you name must already be in the field inventory" — and the whole point of an install is that
 * `providers.<id>` is a section the inventory has never seen. The four steps are the same ones,
 * in the same order, using the same functions.
 */
function writeConfig(
  deps: ProviderShopRoutesDeps,
  changes: ReturnType<typeof providerInstallChanges>,
): { ok: true; blocked?: string } | { ok: false; reason: string } {
  const configPath = deps.configPath!
  let before: { text: string; mode: number | null }
  try {
    const stats = statSync(configPath)
    before = { text: readFileSync(configPath, 'utf8'), mode: stats.mode & 0o777 }
  } catch (err) {
    return { ok: false, reason: `could not read ${configPath}: ${(err as Error).message}` }
  }

  let text: string
  try {
    text = applyChanges(before.text, changes)
  } catch (err) {
    return { ok: false, reason: `could not apply the change to ${configPath}: ${(err as Error).message}` }
  }

  const checked = checkConfigText(text, deps.env)
  if (!checked.ok) {
    return { ok: false, reason: checked.issues.map((i) => `${i.path}: ${i.message}`).join('; ') }
  }

  try {
    writeAtomically(configPath, text, before.mode)
  } catch (err) {
    return { ok: false, reason: `could not write ${configPath}: ${(err as Error).message}` }
  }

  const outcome: ReloadOutcome = deps.reload?.() ?? { applied: false }
  return outcome.blocked ? { ok: true, blocked: outcome.blocked } : { ok: true }
}
