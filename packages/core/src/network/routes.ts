import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { parse as parseYaml } from 'yaml'
import type { AppEnv } from '../app.js'
import { forbidden, success } from '../http/responses.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { Config } from '../config/index.js'

/**
 * `/api/v1/network` — pushing the operator's SSH whitelist at the clouds that enforce it.
 *
 * ISSUE #304. `sshAllowedCidr` has always been `appliesAt: 'save'`, and until this route existed
 * that was only half true: the value was in force in this process the moment it was saved, and
 * the security group, the NSG rule and the firewall rule went on enforcing whatever the last
 * LAUNCH had written. So an operator who moved from home to a cafe could edit the setting, be
 * told it applied, and still be locked out of every box they owned — with no way to fix it short
 * of starting a server they did not want. On GCP there was no way at all: `sourceRanges` was
 * written at create time and never again.
 *
 * ADR-0017's own risk note calls that shape exactly what it is — "a field marked `'save'` whose
 * consumer still reads a value captured at boot is a bug in that consumer, and the honest fix is
 * to make the consumer live rather than to re-label the field". This route is that fix. The
 * label does not move.
 *
 * WHY IT IS ITS OWN ROUTE rather than a step inside the settings save: a save is local, cheap and
 * atomic, and ADR-0017 leans on all three (adoption is all-or-nothing; nothing may become
 * half-applied). Three cloud APIs inside it would make a file write fail on a network timeout and
 * turn one transaction into a partial one. Here, a cloud that cannot be reached is one entry in a
 * per-cloud report and nothing else — which is also the only shape that can honestly describe
 * "AWS updated, Azure updated, GCP refused".
 */
export interface NetworkRoutesDeps {
  /** The live provider registry — rebuilt in place on a config change (ADR-0017). */
  registry: ProviderRegistry
  /** The configuration this process currently has in force. */
  inForce: () => Config
  /** The config file on disk, to detect a save this process has NOT adopted. */
  configPath: string
}

/** One cloud's outcome, as the page and the CLI both render it. */
interface SyncReport {
  provider: string
  status: 'updated' | 'unchanged' | 'skipped' | 'failed'
  applied: readonly string[]
  reported: readonly string[]
  detail: string
}

/**
 * CIDR lists as the FILE currently states them, per provider.
 *
 * Read fresh rather than taken from the in-force config, because the whole point is to compare
 * the two. A file that cannot be read or parsed yields an empty map, which makes the comparison
 * below vacuously agree — the right failure direction: an unreadable file is not evidence that
 * the process is out of date, and refusing to sync because of it would strand the operator.
 */
function cidrsInFile(configPath: string): Map<string, string> {
  const out = new Map<string, string>()
  try {
    const raw = parseYaml(readFileSync(configPath, 'utf8')) as
      | { providers?: Record<string, { sshAllowedCidr?: unknown }> }
      | undefined
    for (const [id, section] of Object.entries(raw?.providers ?? {})) {
      const value = section?.sshAllowedCidr
      if (value !== undefined) out.set(id, JSON.stringify(value))
    }
  } catch {
    return new Map()
  }
  return out
}

/** The same, from the configuration actually in force. */
function cidrsInForce(config: Config): Map<string, string> {
  const out = new Map<string, string>()
  const providers = (config as { providers?: Record<string, { sshAllowedCidr?: unknown }> }).providers ?? {}
  for (const [id, section] of Object.entries(providers)) {
    const value = section?.sshAllowedCidr
    if (value !== undefined) out.set(id, JSON.stringify(value))
  }
  return out
}

export function createNetworkRoutes(deps: NetworkRoutesDeps) {
  const routes = new Hono<AppEnv>()

  /** Admin, ahead of everything — this route changes a firewall. */
  routes.use('/api/v1/network/*', async (c, next) => {
    if (!c.get('user').isAdmin) return forbidden(c, 'Admin access required')
    await next()
  })

  routes.post('/api/v1/network/ssh-access/sync', async (c) => {
    const onDisk = cidrsInFile(deps.configPath)
    const running = cidrsInForce(deps.inForce())

    /**
     * Only the clouds that maintain a whitelist, and only via the capability flag.
     *
     * `capabilities.managesSshAccess`, never `typeof provider.syncSshAccess === 'function'`:
     * `provider-sdk/src/capabilities.ts` exists precisely so core never learns a cloud's name or
     * sniffs its shape. Hetzner declares nothing and creates no firewall object, so it is absent
     * from this report rather than reported as a failure — there is nothing there to be wrong.
     */
    const targets = deps.registry.ids().filter((id) => deps.registry.get(id).capabilities.managesSshAccess)

    const reports = await Promise.all(
      targets.map(async (provider): Promise<SyncReport> => {
        /**
         * NEVER PUSH A CIDR THE RUNNING PROCESS HAS NOT ADOPTED.
         *
         * If the file says one thing and this process is running another, the provider in the
         * registry was built from the OLD value — so syncing now would write the CIDRs the
         * operator had BEFORE their last save, quietly undoing it at the firewall while the page
         * showed the new ones. That is the silent widening this whole feature exists to avoid, so
         * it is a skip with an explanation rather than a best effort.
         */
        const fileValue = onDisk.get(provider)
        const runningValue = running.get(provider)
        if (fileValue !== undefined && fileValue !== runningValue) {
          return {
            provider,
            status: 'skipped',
            applied: [],
            reported: [],
            detail:
              `${deps.configPath} names different networks than this process is running, so ` +
              'nothing was pushed — syncing now would send the older list. Restart Rocky Surf to ' +
              'adopt the file, then sync again.',
          }
        }

        try {
          const result = await deps.registry.get(provider).syncSshAccess!()
          return { provider, ...result }
        } catch (err) {
          /**
           * ONE CLOUD'S FAILURE IS ONE CLOUD'S FAILURE. `Promise.all` over handlers that each
           * catch their own error, rather than `allSettled` over throwing ones, so the report is
           * total by construction: every targeted cloud has a row whatever happened to it.
           */
          return {
            provider,
            status: 'failed',
            applied: [],
            reported: [],
            detail: err instanceof Error ? err.message : String(err),
          }
        }
      }),
    )

    return success(c, { synced: reports })
  })

  return routes
}
