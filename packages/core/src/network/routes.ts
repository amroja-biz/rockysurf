import { readFileSync } from 'node:fs'
import { getConnInfo } from '@hono/node-server/conninfo'
import { Hono } from 'hono'
import { parse as parseYaml } from 'yaml'
import type { AppEnv } from '../app.js'
import { forbidden, serverError, success } from '../http/responses.js'
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
/**
 * Where `GET /api/v1/network/my-ip` looks the address up when the socket cannot answer.
 *
 * PLAIN TEXT, ONE LINE, and Amazon's because it is the one this product's own docs and the
 * Server detail page already tell people to curl (`curl -4 https://checkip.amazonaws.com`) — the
 * button is doing for the reader exactly what those pages ask them to do by hand, so it should
 * get the same answer from the same place.
 */
const PUBLIC_IP_URL = 'https://checkip.amazonaws.com'

/** Three seconds. A box the reader is waiting in front of, not a background job. */
const PUBLIC_IP_TIMEOUT_MS = 3000

/** `::ffff:203.0.113.7` is how a v4 client reaches a dual-stack listener. */
function unmapped(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  return mapped ? mapped[1]! : address
}

/**
 * Whether a /32 of this address would mean anything to a cloud firewall.
 *
 * LOOPBACK IS THE COMMON CASE and the reason this exists: the browser is nearly always on the
 * same machine as the server, so the socket says `127.0.0.1` and a firewall rule for that would
 * allow SSH from nowhere at all. The private ranges are here for the same reason and not a
 * different one — a laptop opening the page across the house reaches the server from
 * `192.168.1.x`, which is just as useless in a security group. Both fall through to the public
 * lookup below, which answers with the address the internet actually sees.
 */
function isRoutableOnTheInternet(address: string): boolean {
  const ip = unmapped(address)
  if (ip === '::1' || ip === '::') return false
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip)) return false
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!v4) return ip.includes(':')
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  if (a === 127 || a === 0 || a === 10) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 169 && b === 254) return false
  // 100.64.0.0/10, the carrier-grade NAT range some home routers hand out.
  if (a === 100 && b >= 64 && b <= 127) return false
  return true
}

/** What the outbound service is allowed to have said. Anything else is a failed lookup. */
function asAddress(text: string): string | null {
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(line) && line.split('.').every((part) => Number(part) <= 255)) return line
  if (/^[0-9a-f:]{3,45}$/i.test(line) && line.includes(':')) return line
  return null
}

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
  /** The stamped extras a keep-or-remove prompt may offer removing (issue #309). */
  removable?: readonly string[]
  detail: string
}

/**
 * The optional request body: which stamped extras the operator confirmed for removal, per cloud.
 *
 * Absent on the plain push (the save, and the footer button) — that carries no removals and syncs
 * additively. Present only after the operator has stood in front of the keep-or-remove prompt and
 * picked REMOVE, and it names ONLY the extras that prompt surfaced. The provider is the gate: it
 * revokes a named range solely when it can prove authorship and the range is a genuine extra
 * (`SshAccessSyncOptions`), so a malformed or hostile body can only ever narrow a cloud toward the
 * config it already runs, never past it and never onto a CIDR the operator did not confirm.
 */
interface SyncRequestBody {
  revoke?: Record<string, readonly string[]>
}

/** Read the body if there is one; a plain push sends none, and that must not error. */
async function readRevokeMap(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, readonly string[]>> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return {}
  }
  const revoke = (body as SyncRequestBody | undefined)?.revoke
  if (!revoke || typeof revoke !== 'object') return {}
  const out: Record<string, readonly string[]> = {}
  for (const [id, cidrs] of Object.entries(revoke)) {
    if (Array.isArray(cidrs)) out[id] = cidrs.filter((cidr): cidr is string => typeof cidr === 'string')
  }
  return out
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

  /**
   * `GET /api/v1/network/my-ip` — the address to put in the SSH allow-list, so nobody has to
   * leave the browser to find it.
   *
   * WHY THE SOCKET AND NOTHING ELSE. The address is taken from the TCP connection this request
   * arrived on and from no header — not `X-Forwarded-For`, not `X-Real-IP`, not `Forwarded`.
   * Rocky Surf is a local tool with no reverse proxy in front of it, so those headers would carry
   * no truth here; what they WOULD carry is a value any caller can type, into a box whose next
   * stop is a cloud firewall rule. Trusting a header would let a request name its own allow-list
   * entry. The socket cannot be talked into lying.
   *
   * WHY THERE IS A SECOND ANSWER AT ALL. On the ordinary installation the browser and the server
   * are the same machine, so the socket says `127.0.0.1` — true, and worthless as a firewall
   * rule. Rather than hand back a loopback /32 for somebody to paste into a security group, the
   * SERVER asks a public what-is-my-address service and says plainly which of the two answers it
   * is giving (`source`), so the page can label it. The browser never makes that call itself: a
   * page that reaches a third party directly is a page that leaks who is reading it.
   *
   * THIS IS NOT THE `sshAllowedCidr` AUTO-DISCOVERY `provider-aws/src/config.ts` REJECTED, and
   * the difference is who decides. That spike scoped a firewall to whatever address the process
   * happened to observe at runtime, silently, every launch. This fills in a box a person then
   * reads, edits and saves — the security-relevant choice stays written down in the file, made
   * once, by a human.
   */
  routes.get('/api/v1/network/my-ip', async (c) => {
    let socketAddress: string | undefined
    try {
      socketAddress = getConnInfo(c).remote.address
    } catch {
      // No node-server bindings on this context. Not an error: it means the socket has nothing
      // to say, which is the same situation as loopback and takes the same road.
      socketAddress = undefined
    }

    if (socketAddress !== undefined && isRoutableOnTheInternet(socketAddress)) {
      return success(c, { ip: unmapped(socketAddress), source: 'socket' as const })
    }

    try {
      const response = await fetch(PUBLIC_IP_URL, { signal: AbortSignal.timeout(PUBLIC_IP_TIMEOUT_MS) })
      if (!response.ok) throw new Error(`${PUBLIC_IP_URL} answered ${response.status}`)
      const ip = asAddress(await response.text())
      if (ip === null) throw new Error(`${PUBLIC_IP_URL} did not answer with an address`)
      return success(c, { ip, source: 'public' as const })
    } catch (err) {
      /*
        SAY WHICH LOOKUP FAILED AND WHY, because the reader's next move depends on it: this
        machine has no way out to the internet, or the service is down, and either way the
        remedy is to find the address by hand. A blank box with no sentence would look like the
        button had simply not worked.
      */
      return serverError(
        c,
        `Rocky Surf could not work out your address. This computer reached the browser on ` +
          `${socketAddress === undefined ? 'an address it cannot see' : unmapped(socketAddress)}, which is not ` +
          `an internet address, and asking ${PUBLIC_IP_URL} failed: ` +
          `${err instanceof Error ? err.message : String(err)}. Type the network in yourself.`,
      )
    }
  })

  routes.post('/api/v1/network/ssh-access/sync', async (c) => {
    const onDisk = cidrsInFile(deps.configPath)
    const running = cidrsInForce(deps.inForce())
    const revokeMap = await readRevokeMap(c)

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
          // Only this provider's confirmed removals reach it, and only when the body named any.
          // The provider is the authority on whether a named range is actually removable; the
          // route just forwards the operator's confirmation (issue #309).
          const revoke = revokeMap[provider]
          const result = await deps.registry
            .get(provider)
            .syncSshAccess!(revoke && revoke.length > 0 ? { revoke } : undefined)
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
