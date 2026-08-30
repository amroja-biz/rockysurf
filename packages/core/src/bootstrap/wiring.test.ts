import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { configSchema, type Config } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { getServer } from '../db/repositories/servers.js'
import { makeFakeProvider } from '../providers/fake.js'
import { ProviderRegistry } from '../providers/registry.js'
import { createSecretsStore } from '../secrets/store.js'
import { parseInstallPlan } from './plan.js'

/**
 * The create path and the job loop, wired the way `boot()` wires them (rockysurf-55fx.13).
 *
 * THIS IS THE TEST THAT WAS MISSING. Every module involved in bootstrap had its own passing
 * unit tests — the resolver rendered plans, the push runner drove agents, the ticker polled a
 * `BootstrapPoller` — and the production stack still could not bootstrap anything, because
 * nothing connected them. Each unit test built the wiring it needed and then asserted the
 * behaviour, which is exactly the shape of test that cannot see a missing composition.
 *
 * So these assertions are deliberately made against a whole app: create a server the way the
 * SPA does, tick the job loop the way `boot()` does, and watch what actually happens to the
 * row. Nothing here reaches the network — the push fails on missing key material, which is
 * enough to prove the ticker reached the push runner at all.
 */

const PASSWORD = 'correct-horse-battery-staple'
const config: Config = configSchema.parse({})

let opened: OpenedDatabase
let created: ReturnType<typeof createApp>
let cookie: string

const post = (path: string, body?: unknown) =>
  created.app.request(path, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

async function createServer(): Promise<string> {
  const res = await post('/api/v1/servers', { size: 'small', packId: 'ai-coding-agents' })
  expect(res.status).toBe(201)
  return ((await res.json()) as { serverId: string }).serverId
}

beforeEach(async () => {
  opened = openTestDatabase()
  const secrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })
  created = createApp({
    db: opened.db,
    config,
    secrets,
    // Present in every real boot. Without it there is no per-server key to push with, so the
    // supervisor is not built at all.
    secretsStore: createSecretsStore(opened.db, randomBytes(32)),
    providers: new ProviderRegistry([makeFakeProvider()]),
  })
  const login = await created.app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
})

afterEach(async () => {
  await created.jobs.stop()
  opened.close()
})

describe('the create path', () => {
  it('snapshots an install plan onto every new server', async () => {
    const serverId = await createServer()

    const plan = getServer(opened.db, serverId)?.installPlan
    // Null here — the state every server shipped in before 55fx.13 — is a server that cannot
    // bootstrap in either topology: push refuses to start and callback 404s the box.
    expect(plan).toBeTruthy()
    expect(parseInstallPlan(plan!).serverId).toBe(serverId)
  })

  it('gives a supplied-key server the removal step, carrying the key core actually minted (ADR-0008, issue #92)', async () => {
    // The real regression this guards: `snapshotInstallPlan` moved to AFTER `provisionKeys` in
    // `lifecycle.ts` precisely so `managedPublicKey` could be core's own just-minted key rather
    // than nothing — a unit test calling `resolveInstallPlan` or `snapshotInstallPlan` directly
    // cannot see that ordering bug, because it hands the key in by construction. Only the whole
    // create path, wired the way `boot()` wires it, can.
    const res = await post('/api/v1/servers', {
      size: 'small',
      packId: 'ai-coding-agents',
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKPX6kWxlSdf7GU3Ve1I2dGGrKqdPBkR60OjKmHb9crV laptop',
    })
    expect(res.status).toBe(201)
    const serverId = ((await res.json()) as { serverId: string }).serverId

    const plan = parseInstallPlan(getServer(opened.db, serverId)!.installPlan!)
    const step = plan.steps.at(-1)!
    expect(step.id).toBe('supplied-key-only')
    expect(step.reports).toBe('ready')
    expect(step.run).toContain("user_line='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKPX6kWxlSdf7GU3Ve1I2dGGrKqdPBkR60OjKmHb9crV laptop'")
    // Core's own key line, not a placeholder or an empty string — the whole point of moving the
    // snapshot past `provisionKeys`.
    expect(step.run).toMatch(/managed_line='ssh-ed25519 \S+ rockysurf-core@/)
  })

  it("names the creator's Environment — the secret half included — in the shell-environment step (issue #244)", async () => {
    // The secret half never reaches the row, so its NAMES travel from the create handler into
    // the snapshot by a separate argument; only the whole path, wired as `boot()` wires it, can
    // show that argument is actually threaded through. The value must not be in the plan.
    const res = await post('/api/v1/servers', {
      size: 'small',
      packId: 'ai-coding-agents',
      environment: { MY_ENDPOINT: { value: 'https://api.example.com' }, MY_TOKEN: { value: 'tok-secret-value', secret: true } },
    })
    expect(res.status).toBe(201)
    const serverId = ((await res.json()) as { serverId: string }).serverId

    const plan = parseInstallPlan(getServer(opened.db, serverId)!.installPlan!)
    const step = plan.steps.find((s) => s.id === 'shell-environment')!
    expect(step.run).toContain("names=('MY_ENDPOINT' 'MY_TOKEN' 'GITHUB_TOKEN')")
    expect(JSON.stringify(plan)).not.toContain('tok-secret-value')
    expect(JSON.stringify(plan)).not.toContain('https://api.example.com')
  })
})

describe('the job loop', () => {
  it('drives bootstrap for a provisioning push-mode row', async () => {
    const serverId = await createServer()
    // Take away the key material so the push fails immediately instead of dialling an address
    // that does not exist. What is under test is that the push was ATTEMPTED at all.
    opened.sqlite.prepare('delete from secrets').run()

    await vi.waitFor(
      async () => {
        await created.jobs.runAllNow()
        const row = getServer(opened.db, serverId)!
        expect(row.status).toBe('failed')
        expect(row.errorMessage).toContain('key material')
      },
      { timeout: 5000 },
    )
  })

  it('leaves the row provisioning while the provider merely reports a booted VM', async () => {
    const serverId = await createServer()
    await created.jobs.runAllNow()

    // The ticker synced: the address is here. The status is not, and that is the fix — the
    // window in which bootstrap reports are accepted stays open until bootstrap closes it.
    const row = getServer(opened.db, serverId)!
    expect(row.publicIp).toBeTruthy()
    expect(row.status).toBe('provisioning')
  })
})
