import { Hono } from 'hono'
import { ProviderError } from '@rockysurf/provider-sdk'
import { describe, expect, it } from 'vitest'
import type { AppEnv } from '../app.js'
import { createProviderCredentialRoutes } from './credential-routes.js'
import { ProviderRegistry, type UnavailableProvider } from './registry.js'

/**
 * `POST /api/v1/providers/credentials/check` — proving a Provider's credentials (issue #450).
 *
 * Driven through a real `ProviderRegistry` holding stub Providers, because everything worth
 * pinning here is about WHICH Providers get dialled and what each answer turns into — none of
 * which needs a database, a session, or a cloud.
 */

interface StubProvider {
  id: string
  displayName: string
  validateCredentials: () => Promise<void>
}

function harness(providers: StubProvider[], unavailable: UnavailableProvider[] = [], isAdmin = true) {
  const registry = new ProviderRegistry(
    providers as never,
    unavailable,
    providers.map((p) => ({ id: p.id, displayName: p.displayName })),
  )
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('user', { isAdmin } as never)
    await next()
  })
  app.route('/', createProviderCredentialRoutes({ registry }))
  return app
}

const check = (app: Hono<AppEnv>, providers?: string[]) =>
  app.request('/api/v1/providers/credentials/check', {
    method: 'POST',
    ...(providers ? { body: JSON.stringify({ providers }), headers: { 'content-type': 'application/json' } } : {}),
  })

interface CheckedRow {
  provider: string
  displayName: string
  status: string
  code?: string
  providerCode?: string
  detail: string
}

const rows = async (res: Response): Promise<CheckedRow[]> => ((await res.json()) as { checked: CheckedRow[] }).checked

const working = (id: string, displayName: string, calls?: string[]): StubProvider => ({
  id,
  displayName,
  validateCredentials: async () => void calls?.push(id),
})

describe('checking Provider credentials', () => {
  it('reports a Provider whose cheapest authenticated call succeeds as verified', async () => {
    const calls: string[] = []
    const app = harness([working('aws', 'Amazon EC2', calls)])

    expect(await rows(await check(app, ['aws']))).toEqual([
      { provider: 'aws', displayName: 'Amazon EC2', status: 'verified', detail: '' },
    ])
    expect(calls).toEqual(['aws'])
  })

  it("hands back the Provider's own error verbatim, with the taxonomy code and the cloud's code", async () => {
    const app = harness([
      {
        id: 'aws',
        displayName: 'Amazon EC2',
        validateCredentials: async () => {
          throw new ProviderError('auth', 'The security token included in the request is invalid.', {
            providerCode: 'UnauthorizedOperation',
          })
        },
      },
    ])

    expect(await rows(await check(app, ['aws']))).toEqual([
      {
        provider: 'aws',
        displayName: 'Amazon EC2',
        status: 'failed',
        code: 'auth',
        providerCode: 'UnauthorizedOperation',
        // Verbatim: this is the sentence the page prints, and paraphrasing it here would make
        // the one text an operator can search for ungreppable.
        detail: 'The security token included in the request is invalid.',
      },
    ])
  })

  it('carries a plain thrown error through without inventing a taxonomy code for it', async () => {
    const app = harness([
      {
        id: 'metalcloud',
        displayName: 'Metal Cloud',
        validateCredentials: async () => {
          throw new Error('metalcloud: no private key path is configured')
        },
      },
    ])

    expect(await rows(await check(app, ['metalcloud']))).toEqual([
      {
        provider: 'metalcloud',
        displayName: 'Metal Cloud',
        status: 'failed',
        detail: 'metalcloud: no private key path is configured',
      },
    ])
  })

  it('never dials a Provider that is not loaded — a disabled section has no row', async () => {
    const calls: string[] = []
    const app = harness([working('aws', 'Amazon EC2', calls)])

    // `gcp` is switched off, so it is not in the registry at all. Asking about it is not an error
    // and is not a failure: there is no cloud there to be wrong about.
    expect(await rows(await check(app, ['aws', 'gcp']))).toEqual([
      { provider: 'aws', displayName: 'Amazon EC2', status: 'verified', detail: '' },
    ])
    expect(calls).toEqual(['aws'])
  })

  it('reports a Provider that is enabled but did not load with the reason it did not', async () => {
    const app = harness([], [{ id: 'gcp', reason: 'gcp: projectId is required' }])

    expect(await rows(await check(app, ['gcp']))).toEqual([
      { provider: 'gcp', displayName: 'gcp', status: 'failed', detail: 'gcp: projectId is required' },
    ])
  })

  it('one cloud failing does not lose the others', async () => {
    const app = harness([
      working('aws', 'Amazon EC2'),
      {
        id: 'azure',
        displayName: 'Microsoft Azure',
        validateCredentials: async () => {
          throw new ProviderError('network', 'fetch failed')
        },
      },
      working('hetzner', 'Hetzner Cloud'),
    ])

    const checked = await rows(await check(app, ['aws', 'azure', 'hetzner']))
    expect(checked.map((row) => `${row.provider}:${row.status}`)).toEqual([
      'aws:verified',
      'azure:failed',
      'hetzner:verified',
    ])
  })

  it('checks every loaded Provider when the request names none', async () => {
    const calls: string[] = []
    const app = harness([working('aws', 'Amazon EC2', calls), working('hetzner', 'Hetzner Cloud', calls)])

    expect((await rows(await check(app))).map((row) => row.provider)).toEqual(['aws', 'hetzner'])
    expect(calls.sort()).toEqual(['aws', 'hetzner'])
  })

  it('is admin-only, like every route that reaches a cloud', async () => {
    const calls: string[] = []
    const app = harness([working('aws', 'Amazon EC2', calls)], [], false)

    expect((await check(app, ['aws'])).status).toBe(403)
    expect(calls).toEqual([])
  })
})
