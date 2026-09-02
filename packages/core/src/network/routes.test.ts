import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
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
