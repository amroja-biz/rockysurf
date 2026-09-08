import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppEnv } from '../app.js'
import type { Config } from '../config/index.js'
import type { ProviderRegistry } from '../providers/registry.js'
import { createNetworkRoutes } from './routes.js'

/**
 * `POST /api/v1/network/ssh-access/sync` — the call that makes `appliesAt: 'save'` true for
 * `sshAllowedCidr` (issue #304).
 *
 * Driven through a stub registry rather than `createApp`, because everything worth pinning here
 * is about WHICH providers get called and what happens when one of them misbehaves — none of
 * which needs a database, a session or a real cloud.
 */

interface FakeProvider {
  capabilities: { managesSshAccess?: boolean }
  syncSshAccess?: () => Promise<unknown>
}

function harness(providers: Record<string, FakeProvider>, config: unknown, fileText: string) {
  const dir = mkdtempSync(join(tmpdir(), 'rockysurf-network-'))
  const configPath = join(dir, 'rockysurf.config.yaml')
  writeFileSync(configPath, fileText)

  const registry = {
    ids: () => Object.keys(providers),
    get: (id: string) => providers[id],
  } as unknown as ProviderRegistry

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('user', { isAdmin: true } as never)
    await next()
  })
  app.route('/', createNetworkRoutes({ registry, inForce: () => config as Config, configPath }))
  return app
}

const ok = (cidrs: string[]) => async () => ({
  status: 'updated' as const,
  applied: cidrs,
  reported: [],
  detail: 'done',
})

const syncing = (app: Hono<AppEnv>) =>
  app.request('/api/v1/network/ssh-access/sync', { method: 'POST' })

describe('pushing the SSH whitelist', () => {
  it('asks every cloud that declares the capability, and no others', async () => {
    const calls: string[] = []
    const app = harness(
      {
        aws: {
          capabilities: { managesSshAccess: true },
          syncSshAccess: async () => (calls.push('aws'), { status: 'updated', applied: [], reported: [], detail: '' }),
        },
        // No capability, no firewall object, no call — Hetzner is absent from the report rather
        // than reported as a failure, because there is nothing there to be wrong.
        hetzner: { capabilities: {} },
      },
      { providers: { aws: { sshAllowedCidr: ['203.0.113.7/32'] } } },
      'providers:\n  aws:\n    sshAllowedCidr:\n      - 203.0.113.7/32\n',
    )

    const body = (await (await syncing(app)).json()) as { synced: { provider: string }[] }
    expect(calls).toEqual(['aws'])
    expect(body.synced.map((entry) => entry.provider)).toEqual(['aws'])
  })

  it('reports one cloud failing without losing the others', async () => {
    const app = harness(
      {
        aws: { capabilities: { managesSshAccess: true }, syncSshAccess: ok(['203.0.113.7/32']) },
        gcp: {
          capabilities: { managesSshAccess: true },
          syncSshAccess: async () => {
            throw new Error('compute.firewalls.update is missing')
          },
        },
      },
      {
        providers: {
          aws: { sshAllowedCidr: ['203.0.113.7/32'] },
          gcp: { sshAllowedCidr: ['203.0.113.7/32'] },
        },
      },
      'providers:\n  aws:\n    sshAllowedCidr:\n      - 203.0.113.7/32\n  gcp:\n    sshAllowedCidr:\n      - 203.0.113.7/32\n',
    )

    const body = (await (await syncing(app)).json()) as {
      synced: { provider: string; status: string; detail: string }[]
    }
    expect(body.synced.find((entry) => entry.provider === 'aws')?.status).toBe('updated')
    const failed = body.synced.find((entry) => entry.provider === 'gcp')
    expect(failed?.status).toBe('failed')
    expect(failed?.detail).toContain('compute.firewalls.update')
  })

  /**
   * The guard that keeps this feature from doing the opposite of its job. If the process never
   * adopted the operator's last save, the provider in the registry still holds the PREVIOUS
   * list — so pushing now would quietly reinstate the CIDRs they just replaced.
   */
  it('refuses to push when the file and the running process disagree', async () => {
    let called = false
    const app = harness(
      {
        aws: {
          capabilities: { managesSshAccess: true },
          syncSshAccess: async () => (called = true, { status: 'updated', applied: [], reported: [], detail: '' }),
        },
      },
      { providers: { aws: { sshAllowedCidr: ['198.51.100.0/24'] } } },
      'providers:\n  aws:\n    sshAllowedCidr:\n      - 203.0.113.7/32\n',
    )

    const body = (await (await syncing(app)).json()) as { synced: { status: string; detail: string }[] }
    expect(called).toBe(false)
    expect(body.synced[0]?.status).toBe('skipped')
    expect(body.synced[0]?.detail).toMatch(/different networks/)
  })

  /**
   * Issue #309. The keep-or-remove prompt sends the extras the operator confirmed for removal, per
   * cloud. The route forwards each cloud ONLY its own set, and a plain push (no body) forwards
   * nothing — the provider then syncs additively and revokes nothing.
   */
  it('forwards each cloud only its own confirmed removals', async () => {
    const seen: Record<string, unknown> = {}
    const app = harness(
      {
        aws: {
          capabilities: { managesSshAccess: true },
          syncSshAccess: async (options?: unknown) => {
            seen['aws'] = options
            return { status: 'updated', applied: [], reported: [], removable: [], detail: '' }
          },
        },
        gcp: {
          capabilities: { managesSshAccess: true },
          syncSshAccess: async (options?: unknown) => {
            seen['gcp'] = options
            return { status: 'unchanged', applied: [], reported: [], removable: [], detail: '' }
          },
        },
      } as never,
      {
        providers: {
          aws: { sshAllowedCidr: ['203.0.113.7/32'] },
          gcp: { sshAllowedCidr: ['203.0.113.7/32'] },
        },
      },
      'providers:\n  aws:\n    sshAllowedCidr:\n      - 203.0.113.7/32\n  gcp:\n    sshAllowedCidr:\n      - 203.0.113.7/32\n',
    )

    await app.request('/api/v1/network/ssh-access/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revoke: { aws: ['192.0.2.0/24'] } }),
    })

    expect(seen['aws']).toEqual({ revoke: ['192.0.2.0/24'] })
    // gcp had no confirmed removals, so it is called additively — no options at all.
    expect(seen['gcp']).toBeUndefined()
  })

  it('syncs additively when the push carries no body', async () => {
    let received: unknown = 'unset'
    const app = harness(
      {
        aws: {
          capabilities: { managesSshAccess: true },
          syncSshAccess: async (options?: unknown) => {
            received = options
            return { status: 'updated', applied: [], reported: [], removable: [], detail: '' }
          },
        },
      } as never,
      { providers: { aws: { sshAllowedCidr: ['203.0.113.7/32'] } } },
      'providers:\n  aws:\n    sshAllowedCidr:\n      - 203.0.113.7/32\n',
    )

    await syncing(app)
    expect(received).toBeUndefined()
  })

  it('turns a non-admin away', async () => {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('user', { isAdmin: false } as never)
      await next()
    })
    app.route(
      '/',
      createNetworkRoutes({
        registry: { ids: () => [], get: () => undefined } as unknown as ProviderRegistry,
        inForce: () => ({}) as Config,
        configPath: '/nonexistent',
      }),
    )
    expect((await syncing(app)).status).toBe(403)
  })
})

/**
 * `GET /api/v1/network/my-ip` — the address behind the "Use my current IP" button.
 *
 * Two branches and they are genuinely different answers, so both are pinned here: the socket knew
 * (a browser on another machine, reaching this one over the internet) and the socket did not (the
 * ordinary installation, where the page is open on the machine running Rocky Surf and the
 * connection comes from loopback). The outbound call is mocked — a test that reached
 * checkip.amazonaws.com would be a test of somebody's network.
 */
describe('working out the address for the SSH allow-list', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** The bindings `@hono/node-server` puts on `c.env`, which is where the socket address lives. */
  const from = (address: string | undefined) => ({
    incoming: { socket: { remoteAddress: address, remotePort: 51234, remoteFamily: address?.includes(':') ? 'IPv6' : 'IPv4' } },
  })

  function ipApp(address: string | undefined) {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('user', { isAdmin: true } as never)
      await next()
    })
    app.route(
      '/',
      createNetworkRoutes({
        registry: { ids: () => [], get: () => undefined } as unknown as ProviderRegistry,
        inForce: () => ({}) as Config,
        configPath: '/nonexistent',
      }),
    )
    return () => app.request('/api/v1/network/my-ip', {}, from(address) as never)
  }

  it('answers with the socket’s own address when the browser is somewhere else', async () => {
    const outbound = vi.fn()
    vi.stubGlobal('fetch', outbound)

    const response = await ipApp('203.0.113.7')()
    expect(await response.json()).toEqual({ ip: '203.0.113.7', source: 'socket' })
    // Nothing left this machine: the connection already carried the answer.
    expect(outbound).not.toHaveBeenCalled()
  })

  it('unwraps the v4-mapped v6 form a dual-stack listener reports', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const response = await ipApp('::ffff:203.0.113.7')()
    expect(await response.json()).toEqual({ ip: '203.0.113.7', source: 'socket' })
  })

  /**
   * THE ORDINARY CASE. The page is open on the machine running Rocky Surf, so the socket says
   * loopback — true, and a /32 of it would allow SSH from nowhere. Core asks a public service
   * instead and LABELS the answer, so the page can say which of the two questions it answered.
   */
  it('asks a public service when the connection is loopback, and says that is what it did', async () => {
    const outbound = vi.fn(async (_url: string) => new Response('198.51.100.4\n', { status: 200 }))
    vi.stubGlobal('fetch', outbound)

    const response = await ipApp('127.0.0.1')()
    expect(await response.json()).toEqual({ ip: '198.51.100.4', source: 'public' })
    expect(outbound.mock.calls[0]?.[0]).toBe('https://checkip.amazonaws.com')
  })

  it('does the same for a private address, which is just as useless in a cloud firewall', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('198.51.100.4', { status: 200 })))
    const response = await ipApp('192.168.1.20')()
    expect(await response.json()).toEqual({ ip: '198.51.100.4', source: 'public' })
  })

  it('says so, in a sentence, when neither answer could be had', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND checkip.amazonaws.com')
      }),
    )

    const response = await ipApp('::1')()
    expect(response.status).toBe(500)
    const body = (await response.json()) as { error: string }
    // Never a blank answer: it names what it tried and what to do instead.
    expect(body.error).toContain('checkip.amazonaws.com')
    expect(body.error).toContain('ENOTFOUND')
    expect(body.error).toContain('Type the network in yourself')
  })

  it('treats a service that answers with something other than an address as a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>captive portal</html>', { status: 200 })))
    const response = await ipApp('127.0.0.1')()
    expect(response.status).toBe(500)
    expect(((await response.json()) as { error: string }).error).toContain('did not answer with an address')
  })

  /**
   * THE HEADER IS NOT EVIDENCE. This is a local tool with no proxy in front of it, so
   * `X-Forwarded-For` carries nothing true — but it would carry whatever a caller typed, into a
   * box whose next stop is a cloud firewall rule.
   */
  it('ignores X-Forwarded-For entirely — the socket is the only witness', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('user', { isAdmin: true } as never)
      await next()
    })
    app.route(
      '/',
      createNetworkRoutes({
        registry: { ids: () => [], get: () => undefined } as unknown as ProviderRegistry,
        inForce: () => ({}) as Config,
        configPath: '/nonexistent',
      }),
    )

    const response = await app.request(
      '/api/v1/network/my-ip',
      { headers: { 'x-forwarded-for': '198.51.100.66', 'x-real-ip': '198.51.100.66' } },
      from('203.0.113.7') as never,
    )
    expect(await response.json()).toEqual({ ip: '203.0.113.7', source: 'socket' })
  })

  it('turns a non-admin away, like everything else under /network', async () => {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('user', { isAdmin: false } as never)
      await next()
    })
    app.route(
      '/',
      createNetworkRoutes({
        registry: { ids: () => [], get: () => undefined } as unknown as ProviderRegistry,
        inForce: () => ({}) as Config,
        configPath: '/nonexistent',
      }),
    )
    expect((await app.request('/api/v1/network/my-ip')).status).toBe(403)
  })
})
