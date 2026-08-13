import { ProviderError } from '@rockysurf/provider-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { configSchema, type Config } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { makeFakeProvider } from '../providers/fake.js'
import { ProviderRegistry } from '../providers/registry.js'
import { createSecretsStore, type SecretsStore } from '../secrets/index.js'
import { computeSetupState } from './state.js'

/**
 * The first-run surface. What is under test is the ORDER of operations — validate, then store
 * — and the honesty of the state it reports, because the wizard's whole value is that a
 * stranger who finishes it has an installation that actually works.
 */

const PASSWORD = 'correct-horse-battery-staple'

let opened: OpenedDatabase
let secretsStore: SecretsStore
let app: ReturnType<typeof createApp>['app']
let cookie: string

/** A fake provider wearing another provider's id, so routes can be exercised without one. */
function providerNamed(id: string, overrides: Partial<{ validateCredentials: () => Promise<void> }> = {}) {
  const fake = makeFakeProvider()
  return { ...fake, id, ...overrides } as typeof fake
}

async function build(config: Config, providers = new ProviderRegistry([providerNamed('hetzner')])): Promise<void> {
  opened = openTestDatabase()
  const adminSecrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets: adminSecrets, password: PASSWORD })
  secretsStore = createSecretsStore(opened.db, Buffer.alloc(32, 7))

  app = createApp({ db: opened.db, config, secrets: adminSecrets, providers, secretsStore }).app

  const res = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
}

const getSetup = () => app.request('/api/v1/setup', { headers: { cookie } })
const postCredential = (id: string, token: string) =>
  app.request(`/api/v1/setup/providers/${id}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })

afterEach(() => {
  opened.close()
})

describe('GET /api/v1/setup', () => {
  beforeEach(async () => {
    await build(configSchema.parse({}))
  })

  it('requires a session — first-run state is not public', async () => {
    expect((await app.request('/api/v1/setup')).status).toBe(401)
  })

  it('reports a fresh install as needing a provider', async () => {
    const body = (await (await getSetup()).json()) as {
      complete: boolean
      needsProvider: boolean
      providers: { id: string; enabled: boolean; configured: boolean }[]
    }

    expect(body.needsProvider).toBe(true)
    expect(body.complete).toBe(false)
    expect(body.providers.map((p) => p.id).sort()).toEqual(['aws', 'azure', 'byo', 'gcp', 'hetzner'])
    expect(body.providers.every((p) => !p.enabled)).toBe(true)
  })
})

describe('setup state', () => {
  const registry = new ProviderRegistry([providerNamed('hetzner')])

  it('is complete only when a provider is enabled, credentialed AND loaded', async () => {
    const config = configSchema.parse({ providers: { hetzner: { enabled: true, token: 'hz_x' } } })
    const state = computeSetupState({ config, registry, env: {} })

    expect(state.needsProvider).toBe(false)
    expect(state.complete).toBe(true)
    expect(state.providers.find((p) => p.id === 'hetzner')).toMatchObject({
      enabled: true,
      configured: true,
      source: 'config',
      loaded: true,
    })
  })

  it('is NOT complete when the provider is configured but not loaded in this process', async () => {
    // Core cannot construct a provider — the dependency lint forbids importing one — so a
    // credential is live only once something else has loaded that provider.
    const config = configSchema.parse({ providers: { aws: { enabled: true } } })
    const state = computeSetupState({ config, registry, env: {} })

    expect(state.needsProvider).toBe(false)
    expect(state.complete).toBe(false)
    expect(state.providers.find((p) => p.id === 'aws')?.loaded).toBe(false)
  })

  it('marks an env-supplied credential read-only, naming the variable', async () => {
    const config = configSchema.parse({ providers: { hetzner: { enabled: true, token: 'hz_x' } } })
    const state = computeSetupState({ config, registry, env: { HCLOUD_TOKEN: 'from-env' } })

    const hetzner = state.providers.find((p) => p.id === 'hetzner')!
    expect(hetzner.source).toBe('env')
    expect(hetzner.readOnlyReason).toContain('HCLOUD_TOKEN')
    expect(hetzner.readOnlyReason).toContain('wins at runtime')
  })

  it('marks a config-file credential read-only, pointing at the file', async () => {
    const config = configSchema.parse({ providers: { hetzner: { enabled: true, token: 'hz_x' } } })
    const state = computeSetupState({ config, registry, env: {} })
    expect(state.providers.find((p) => p.id === 'hetzner')?.readOnlyReason).toContain('rockysurf.config.yaml')
  })

  /**
   * The reason an enabled provider is missing (rockysurf-va2l).
   *
   * `loaded: false` alone was not enough to act on: an operator who enabled AWS without
   * `sshAllowedCidr` got a working Hetzner-only app, and the one sentence explaining it went
   * to the boot log. The composition root now hands the rejection to the registry, and it
   * comes out here in the provider's own words — which name the field to fix.
   */
  it('says why an enabled provider did not load', () => {
    const config = configSchema.parse({ providers: { aws: { enabled: true } } })
    const withReason = new ProviderRegistry(
      [providerNamed('hetzner')],
      [{ id: 'aws', reason: 'sshAllowedCidr is required: state which network may reach SSH' }],
    )

    const aws = computeSetupState({ config, registry: withReason, env: {} }).providers.find((p) => p.id === 'aws')!
    expect(aws.loaded).toBe(false)
    expect(aws.unavailableReason).toContain('sshAllowedCidr')
  })

  it('leaves the reason off a provider that loaded fine', () => {
    const config = configSchema.parse({ providers: { hetzner: { enabled: true, token: 'hz_x' } } })
    const state = computeSetupState({ config, registry, env: {} })
    expect(state.providers.find((p) => p.id === 'hetzner')?.unavailableReason).toBeUndefined()
  })

  it('counts byo as configured by its host list rather than a credential', async () => {
    const config = configSchema.parse({
      providers: { byo: { enabled: true, hosts: [{ name: 'a', host: '10.0.0.1' }] } },
    })
    const state = computeSetupState({ config, registry, env: {} })
    expect(state.providers.find((p) => p.id === 'byo')).toMatchObject({ configured: true, source: 'config' })
  })
})

describe('POST /api/v1/setup/providers/:id', () => {
  /**
   * The REAL first-run config: nothing enabled, nothing credentialed.
   *
   * Note what cannot be expressed here — `hetzner: { enabled: true }` with no token is
   * REJECTED by the config schema, so there is no valid config in which a provider is enabled
   * and waiting for a credential the wizard will supply. That gap is reported with
   * rockysurf-hzi7.2; it is why the wizard stores and explains rather than storing and
   * declaring victory.
   */
  const freshInstall = () => configSchema.parse({})

  it('validates the credential BEFORE storing it', async () => {
    const validateCredentials = vi.fn(async () => {
      throw new ProviderError('auth', 'hetzner GET /servers: unauthorized: unable to authenticate', {
        providerCode: 'unauthorized',
      })
    })
    await build(freshInstall(), new ProviderRegistry([providerNamed('hetzner', { validateCredentials })]))

    const res = await postCredential('hetzner', 'wrong-token')

    expect(res.status).toBe(401)
    // Verbatim: the provider's message names the cloud's own code, which is the one string
    // that distinguishes a read-only token from a wrong one.
    expect(((await res.json()) as { error: string }).error).toBe(
      'hetzner GET /servers: unauthorized: unable to authenticate',
    )
    // Nothing was written — an installation that looks configured and fails at the first
    // create is exactly what the wizard exists to prevent.
    expect(secretsStore.getProviderToken('hetzner')).toBeUndefined()
    expect(validateCredentials).toHaveBeenCalledOnce()
  })

  it('stores the credential once it is proven', async () => {
    await build(freshInstall())

    const res = await postCredential('hetzner', 'hz_good_token')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
    expect(secretsStore.getProviderToken('hetzner')).toBe('hz_good_token')
  })

  it('does not claim setup is complete just because a credential was stored', async () => {
    // Completeness needs the provider ENABLED and LOADED too. Saying "you are done" here
    // would send a stranger to a dashboard that cannot create a server — the precise failure
    // the wizard exists to prevent.
    await build(freshInstall())
    const body = (await (await postCredential('hetzner', 'hz_good_token')).json()) as {
      setup: { complete: boolean }
    }
    expect(body.setup.complete).toBe(false)
  })

  it('refuses to persist over an environment-supplied credential', async () => {
    await build(freshInstall())
    // The route reads the process env; the refuse-persist rule is the secrets store's, and
    // this is the seam where a user meets it.
    const previous = process.env['HCLOUD_TOKEN']
    process.env['HCLOUD_TOKEN'] = 'from-env'
    try {
      const res = await postCredential('hetzner', 'pasted')
      expect(res.status).toBe(409)
      expect(JSON.stringify(await res.json())).toContain('HCLOUD_TOKEN')
      expect(secretsStore.getProviderToken('hetzner')).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env['HCLOUD_TOKEN']
      else process.env['HCLOUD_TOKEN'] = previous
    }
  })

  it('stores unverified when the provider is not loaded, and says so', async () => {
    // The deadlock this replaces: a provider is only loaded once it HAS a credential, so the
    // one a user needs to configure is exactly the one that cannot be verified. Refusing here
    // meant the wizard could never configure anything — while the boot log told people to use
    // it (rockysurf-55fx.12).
    await build(configSchema.parse({ providers: { aws: { enabled: true } } }))
    const res = await postCredential('aws', 'AKIA-something')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { verified: boolean; message: string }
    expect(body.verified).toBe(false)
    expect(body.message).toContain('restart')
    // Stored, encrypted, ready for the composition root to pick up on the next boot.
    expect(secretsStore.getProviderToken('aws')).toBe('AKIA-something')
  })

  it('marks a credential verified when the provider was loaded to check it', async () => {
    await build(freshInstall())
    const body = (await (await postCredential('hetzner', 'hz_good_token')).json()) as { verified: boolean }
    expect(body.verified).toBe(true)
  })

  it('rejects an unknown provider and an empty credential', async () => {
    await build(freshInstall())
    // `nimbus` is deliberately a name no cloud has. This asserted on `gcp` until
    // `@rockysurf/provider-gcp` landed (rockysurf-ev41.6), at which point it started asserting
    // the opposite of what it meant.
    expect((await postCredential('nimbus', 'x')).status).toBe(400)
    expect((await postCredential('hetzner', '')).status).toBe(400)
  })

  it('requires a session', async () => {
    await build(freshInstall())
    const res = await app.request('/api/v1/setup/providers/hetzner', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'x' }),
    })
    expect(res.status).toBe(401)
  })
})
