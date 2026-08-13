import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ComputeProvider, ProvisionResult, ProvisionSpec } from '@rockysurf/provider-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN_PASSWORD_ENV } from '../auth/admin.js'
import { createApp } from '../app.js'
import { getServer } from '../db/repositories/servers.js'
import { boot } from '../server.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { configSchema, type Config } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { makeFakeProvider } from '../providers/fake.js'
import { ProviderRegistry } from '../providers/registry.js'
import { createSecretsStore, type SecretsStore } from '../secrets/store.js'

/**
 * THE SILENT-FALLBACK HOLE, closed at the boot path.
 *
 * `createLifecycleService` falls back to an EPHEMERAL keypair when it is handed no secrets
 * store — a reasonable default for a test that constructs the service directly, and a disaster
 * in production: the box authorizes a key nobody kept, so the operator can never SSH in and
 * nothing fails loudly at the time. Every service-level test still passes, because they build
 * the service themselves and never exercise the one line in `app.ts` that passes the store
 * through.
 *
 * So this test asserts at the APP level, through the real HTTP create path: the key the
 * provider is asked to authorize must be the key the secrets store actually holds. Delete the
 * `secretsStore` line from `createApp` and this goes red; nothing else in the suite does.
 */

const PASSWORD = 'correct-horse-battery-staple'
const CREATE = { size: 'small' as const, spotInstance: false, packId: 'ai-coding-agents' }
const config: Config = configSchema.parse({})

/** Wraps the fake so the test can see the spec, without touching the shared fake provider. */
function capturingProvider(): { provider: ComputeProvider; specs: ProvisionSpec[] } {
  const inner = makeFakeProvider()
  const specs: ProvisionSpec[] = []
  const provider: ComputeProvider = {
    ...inner,
    async provision(spec: ProvisionSpec): Promise<ProvisionResult> {
      specs.push(spec)
      return inner.provision(spec)
    },
  }
  return { provider, specs }
}

let opened: OpenedDatabase
let store: SecretsStore

async function buildApp(withSecretsStore: boolean) {
  const { provider, specs } = capturingProvider()
  const secrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })
  const app = createApp({
    db: opened.db,
    config,
    secrets,
    providers: new ProviderRegistry([provider]),
    ...(withSecretsStore ? { secretsStore: store } : {}),
  }).app

  const login = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''

  return { app, specs, cookie }
}

async function createServer(app: Awaited<ReturnType<typeof buildApp>>['app'], cookie: string): Promise<string> {
  const res = await app.request('/api/v1/servers', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(CREATE),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { serverId: string }).serverId
}

beforeEach(() => {
  opened = openTestDatabase()
  store = createSecretsStore(opened.db, randomBytes(32))
})

afterEach(() => opened.close())

describe('the booted app provisions with the keys it kept', () => {
  it('authorizes exactly the public key the secrets store holds for that server', async () => {
    const { app, specs, cookie } = await buildApp(true)
    const serverId = await createServer(app, cookie)

    const spec = specs.at(-1)
    expect(spec, 'the provider was never asked to provision').toBeDefined()

    const kept = store.getServerKeyMaterial(serverId)
    expect(kept, 'no key material was stored for this server').toBeDefined()

    // The assertion that matters: the box is told to trust the key core can actually produce.
    expect(spec!.sshPublicKeys).toContain(kept!.userPublicKey)
  })

  it('bakes that same key into the user-data the box boots with', async () => {
    const { app, specs, cookie } = await buildApp(true)
    const serverId = await createServer(app, cookie)

    const kept = store.getServerKeyMaterial(serverId)!
    // Keys reach a cloud-init box only through the rendered document, so agreeing with the
    // spec is not enough — the document itself has to carry the stored key.
    expect(specs.at(-1)!.userData).toContain(kept.userPublicKey)
  })

  it('pins the host key it stored, so the first connection is verified rather than trusted', async () => {
    const { app, specs, cookie } = await buildApp(true)
    const serverId = await createServer(app, cookie)

    const kept = store.getServerKeyMaterial(serverId)!
    expect(specs.at(-1)!.userData).toContain(kept.hostPublicKey)
  })

  it('NEGATIVE CONTROL: without the store wired in, the authorized key is one nobody kept', async () => {
    // This is what the regression looks like. It is asserted so the three tests above are
    // demonstrably capable of failing — a guard that cannot go red guards nothing.
    const { app, specs, cookie } = await buildApp(false)
    const serverId = await createServer(app, cookie)

    expect(store.getServerKeyMaterial(serverId)).toBeUndefined()
    expect(specs.at(-1)!.sshPublicKeys.length).toBeGreaterThan(0)
  })
})

/**
 * The same guarantee, one level further out: through `boot()` — the real `npx rockysurf`
 * path — rather than through a hand-assembled `createApp`.
 *
 * The distinction is not pedantry. The tests above pass a secrets store into `createApp`
 * themselves, so they prove `app.ts` forwards it but say nothing about whether BOOT ever
 * supplies one. That gap was not hypothetical: `boot()` built a secrets store, returned it in
 * `BootedApp`, and never passed it to `createApp`. Every server created by a real installation
 * got a throwaway keypair nobody kept, and the private-key download route was never mounted.
 * Both failures are silent at the time they happen.
 */
describe('the real boot path', () => {
  let dataDir: string
  let booted: Awaited<ReturnType<typeof boot>> | undefined
  let savedPassword: string | undefined

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rockysurf-boot-'))
    savedPassword = process.env[ADMIN_PASSWORD_ENV]
  })

  afterEach(async () => {
    await booted?.close()
    booted = undefined
    // Restored rather than deleted: this is real process state, and leaving it set would
    // change how any later test's boot behaves.
    if (savedPassword === undefined) delete process.env[ADMIN_PASSWORD_ENV]
    else process.env[ADMIN_PASSWORD_ENV] = savedPassword
    rmSync(dataDir, { recursive: true, force: true })
  })

  async function bootApp() {
    writeFileSync(join(dataDir, 'rockysurf.config.yaml'), `server:\n  dataDir: "${join(dataDir, 'data')}"\n`)
    process.env[ADMIN_PASSWORD_ENV] = PASSWORD
    booted = await boot({ argv: [], cwd: dataDir, env: {}, listen: false, log: () => {}, announce: () => {} })
    const login = await booted.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    expect(login.status).toBe(200)
    return { booted, cookie: login.headers.get('set-cookie')?.split(';')[0] ?? '' }
  }

  it('keeps the private half of every key it hands to a provider', async () => {
    const { booted: app, cookie } = await bootApp()
    const serverId = await createServer(app.app, cookie)

    const kept = app.secretsStore.getServerKeyMaterial(serverId)
    expect(kept, 'boot did not wire its secrets store into the app').toBeDefined()
    expect(kept!.userPrivateKey).toContain('PRIVATE KEY')
    // The row and the store must agree about which host key was pinned; if they disagree the
    // box presents a key core cannot verify.
    expect(getServer(app.db.db, serverId)!.hostKeyFingerprint).toBe(kept!.hostKeyFingerprint)
  })

  it('mounts the private-key download route, which exists only when the store is wired', async () => {
    const { booted: app, cookie } = await bootApp()
    const serverId = await createServer(app.app, cookie)

    // A second, independent symptom of the same missing wiring: without a secrets store this
    // route is not registered at all and the operator gets a 404 forever.
    const res = await app.app.request(`/api/v1/servers/${serverId}/ssh-key`, { headers: { cookie } })
    expect(res.status).not.toBe(404)
  })
})

/**
 * The key the USER pasted, which the create route used to drop (rockysurf-z0wf).
 *
 * Found beside the RDP password and caused by the same line: `createBody` declared
 * `sshPublicKey`, `CreateServerInput` took one, `ensureServerKeys` appended it to the
 * authorized set — and the object literal in between named neither field, so a user who chose
 * "I'll bring my own key" got a box that authorized core's key alone.
 *
 * WHY NOBODY NOTICED, and why the assertion has to be about the SPEC rather than about
 * whether SSH works: core's own key is always authorized too, and the SPA offers it as a
 * download. So the box was reachable, the create succeeded, and the only symptom was that the
 * key in the user's own agent did not work on a box they had just asked to trust it.
 */
describe('a user-supplied public key', () => {
  const USER_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJIlzS/14t0FvaTZAibWcaUzqnpW22uoQk/Ye6Mi02fd someone@example.com'

  it('is authorized alongside core’s own, not instead of it and not dropped', async () => {
    const { app, specs, cookie } = await buildApp(true)
    const res = await app.request('/api/v1/servers', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ...CREATE, sshPublicKey: USER_KEY }),
    })
    expect(res.status).toBe(201)
    const { serverId } = (await res.json()) as { serverId: string }

    const spec = specs.at(-1)!
    // Both, and in that order: core needs its own key to bootstrap the box at all, and the
    // user needs theirs for the reason they pasted it.
    expect(spec.sshPublicKeys).toContain(store.getServerKeyMaterial(serverId)!.userPublicKey)
    expect(spec.sshPublicKeys).toContain(USER_KEY)
    // Keys reach a cloud-init box only through the rendered document.
    expect(spec.userData).toContain(USER_KEY)
  })

  it('leaves the authorized set untouched when the caller supplies none', async () => {
    const { app, specs, cookie } = await buildApp(true)
    const serverId = await createServer(app, cookie)

    expect(specs.at(-1)!.sshPublicKeys).toEqual([store.getServerKeyMaterial(serverId)!.userPublicKey])
  })
})
