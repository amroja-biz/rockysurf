import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { configSchema, createConfigStore, parseConfig, type Config } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { makeFakeProvider } from '../providers/fake.js'
import { ProviderRegistry } from '../providers/registry.js'
import { computeSetupState } from './state.js'

/**
 * The first-run surface (issue #280). What is under test is that the wizard's one write is a
 * CONFIG EDIT — switching a cloud on — and that no credential can reach these routes at all:
 * the POST refuses a token by name, and the state it reports is honest about what remains
 * (enabled, loaded, and the environment variable a token cloud is waiting on).
 */

const PASSWORD = 'correct-horse-battery-staple'

let opened: OpenedDatabase
let app: ReturnType<typeof createApp>['app']
let cookie: string
let dir: string | undefined
let configPath: string

/** A fake provider wearing another provider's id, so routes can be exercised without one. */
function providerNamed(id: string) {
  const fake = makeFakeProvider()
  return { ...fake, id } as typeof fake
}

/**
 * Build the app over a REAL config file in a temp directory, wired the way `boot()` wires it:
 * a live config store over that file, so the enable POST's write-then-reload is exercised for
 * real rather than mocked. `env` is explicit so a developer's own HCLOUD_TOKEN cannot leak in.
 */
async function build(
  configText: string,
  providers = new ProviderRegistry([providerNamed('hetzner')]),
  env: NodeJS.ProcessEnv = {},
): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'rockysurf-setup-'))
  configPath = join(dir, 'rockysurf.config.yaml')
  writeFileSync(configPath, configText)

  opened = openTestDatabase()
  const adminSecrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets: adminSecrets, password: PASSWORD })

  const config = parseConfig(configText, configPath, env)
  const configStore = createConfigStore({ booted: config, configPath, env })

  app = createApp({ db: opened.db, config, configStore, configPath, env, secrets: adminSecrets, providers }).app

  const res = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
}

const getSetup = () => app.request('/api/v1/setup', { headers: { cookie } })
const postEnable = (id: string, body?: unknown) =>
  app.request(`/api/v1/setup/providers/${id}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

afterEach(() => {
  opened.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('GET /api/v1/setup', () => {
  it('requires a session — first-run state is not public', async () => {
    await build('')
    expect((await app.request('/api/v1/setup')).status).toBe(401)
  })

  it('reports a fresh install as needing a provider', async () => {
    await build('')
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

  it('is complete only when a provider is enabled AND loaded', () => {
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

  it('is NOT complete when the provider is enabled but not loaded in this process', () => {
    // Core cannot construct a provider — the dependency lint forbids importing one — so a
    // cloud switched on is live only once the composition root has loaded that provider.
    const config = configSchema.parse({ providers: { aws: { enabled: true } } })
    const state = computeSetupState({ config, registry, env: {} })

    expect(state.needsProvider).toBe(false)
    expect(state.complete).toBe(false)
    expect(state.providers.find((p) => p.id === 'aws')?.loaded).toBe(false)
  })

  it('is complete for a chain-auth cloud with nothing detectable in the environment', () => {
    // An AWS instance role, an Azure managed identity or a GCP ADC session sets no variable
    // this process can see — `configured` is false and the installation still works. Requiring
    // a detectable credential would call it incomplete forever (issue #280).
    const config = configSchema.parse({ providers: { aws: { enabled: true, sshAllowedCidr: '203.0.113.4/32' } } })
    const loadedAws = new ProviderRegistry([providerNamed('aws')])
    const state = computeSetupState({ config, registry: loadedAws, env: {} })

    expect(state.providers.find((p) => p.id === 'aws')).toMatchObject({ configured: false, loaded: true })
    expect(state.complete).toBe(true)
  })

  it('names the environment variable supplying a credential, so the wizard can say so', () => {
    const config = configSchema.parse({ providers: { hetzner: { enabled: true } } })
    const state = computeSetupState({ config, registry, env: { HETZNER_TOKEN: 'from-env' } })

    const hetzner = state.providers.find((p) => p.id === 'hetzner')!
    expect(hetzner.source).toBe('env')
    expect(hetzner.envVar).toBe('HETZNER_TOKEN')
    expect(hetzner.configured).toBe(true)
  })

  it('reports the config file as the source when the file names the token', () => {
    // The `${HETZNER_TOKEN}` reference arrives here already interpolated, so the common
    // Hetzner setup — variable name in the file, value in the environment — reads as 'config':
    // the same order the composition root resolves in.
    const config = configSchema.parse({ providers: { hetzner: { enabled: true, token: 'hz_x' } } })
    const state = computeSetupState({ config, registry, env: { HCLOUD_TOKEN: 'from-env' } })

    const hetzner = state.providers.find((p) => p.id === 'hetzner')!
    expect(hetzner.source).toBe('config')
    expect(hetzner.envVar).toBeUndefined()
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

  it('counts byo as configured by its host list rather than a credential', () => {
    const config = configSchema.parse({
      providers: { byo: { enabled: true, hosts: [{ name: 'a', host: '10.0.0.1' }] } },
    })
    const state = computeSetupState({ config, registry, env: {} })
    expect(state.providers.find((p) => p.id === 'byo')).toMatchObject({ configured: true, source: 'config' })
  })
})

describe('POST /api/v1/setup/providers/:id', () => {
  it('switches the cloud on in the config file, and this process adopts it', async () => {
    await build('')
    const res = await postEnable('hetzner', {})

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; setup: { providers: { id: string; enabled: boolean }[] } }
    expect(body.ok).toBe(true)
    // The response already reflects the write (#264): no restart between save and report.
    expect(body.setup.providers.find((p) => p.id === 'hetzner')?.enabled).toBe(true)
    // And the write went to the FILE — config is configuration, never data.
    expect(readFileSync(configPath, 'utf8')).toContain('enabled: true')
  })

  it('REFUSES a credential, by name and in as many words', async () => {
    // The one request this route must never half-serve: the old wizard's, or any client that
    // still believes pasting a token here stores it. Nothing may persist a provider credential.
    await build('')
    const res = await postEnable('hetzner', { token: 'hz_secret_value' })

    expect(res.status).toBe(400)
    const message = JSON.stringify(await res.json())
    expect(message).toContain('no longer accepts credentials')
    // The refusal must not echo the credential itself.
    expect(message).not.toContain('hz_secret_value')
    // And nothing was enabled as a side effect of a refused request.
    expect(readFileSync(configPath, 'utf8')).not.toContain('enabled: true')
  })

  it('accepts an empty body and no body alike — there is nothing to send', async () => {
    await build('')
    expect((await postEnable('hetzner')).status).toBe(200)
  })

  it('is idempotent: enabling an enabled cloud writes nothing and reports the same state', async () => {
    await build('providers:\n  hetzner:\n    enabled: true\n    token: "hz_x"\n')
    const before = readFileSync(configPath, 'utf8')

    const res = await postEnable('hetzner', {})
    expect(res.status).toBe(200)
    expect(readFileSync(configPath, 'utf8')).toBe(before)
  })

  it('preserves the rest of the file, comments included', async () => {
    await build('# my notes about this install\nserver:\n  port: 3000\n')
    await postEnable('aws', {})

    const text = readFileSync(configPath, 'utf8')
    expect(text).toContain('# my notes about this install')
    expect(text).toContain('port: 3000')
  })

  it('reports what remains for a token cloud: enabled, not loaded, and the variable to set', async () => {
    // The Hetzner first-run loop (issue #280): enable, export the variable, restart, return.
    // On this first leg nothing is loaded yet — the registry here is what the composition
    // root builds with no credential anywhere — and the state must say so rather than claim
    // success: the wizard renders exactly this into its set-the-variable instructions.
    await build(
      '',
      new ProviderRegistry([makeFakeProvider()], [{ id: 'hetzner', reason: 'no credential found — export HETZNER_TOKEN' }]),
    )
    const body = (await (await postEnable('hetzner', {})).json()) as {
      setup: { complete: boolean; providers: { id: string; enabled: boolean; loaded: boolean; configured: boolean }[] }
    }

    const hetzner = body.setup.providers.find((p) => p.id === 'hetzner')!
    expect(hetzner.enabled).toBe(true)
    expect(hetzner.configured).toBe(false)
    expect(body.setup.complete).toBe(false)
  })

  it('detects the variable on return, which is what continues the wizard flow', async () => {
    // The second leg of the loop: the process restarted with HETZNER_TOKEN exported, the
    // composition root loaded the provider from it, and the wizard's re-read finds a complete
    // installation. The registry stands in for the composition root here — its env fallback
    // has its own tests in packages/rockysurf.
    await build(
      'providers:\n  hetzner:\n    enabled: true\n',
      new ProviderRegistry([providerNamed('hetzner')]),
      { HETZNER_TOKEN: 'hz_now_set' },
    )

    const state = (await (await getSetup()).json()) as {
      complete: boolean
      providers: { id: string; envVar?: string; loaded: boolean }[]
    }
    expect(state.complete).toBe(true)
    expect(state.providers.find((p) => p.id === 'hetzner')).toMatchObject({
      loaded: true,
      envVar: 'HETZNER_TOKEN',
    })
  })

  it('rejects an unknown provider and an unexpected field', async () => {
    await build('')
    // `nimbus` is deliberately a name no cloud has.
    expect((await postEnable('nimbus', {})).status).toBe(400)
    expect((await postEnable('hetzner', { verbose: true })).status).toBe(400)
  })

  it('requires a session', async () => {
    await build('')
    const res = await app.request('/api/v1/setup/providers/hetzner', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(401)
  })
})
