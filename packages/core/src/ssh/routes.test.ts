import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type CreatedApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { DEFAULT_SESSION_TTL_MS, issueSession } from '../auth/sessions.js'
import { configSchema, type Config } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { insertServer, setKeyMaterial } from '../db/repositories/servers.js'
import { listEventsForServer, upsertUserByGithubId } from '../db/repositories/users.js'
import { KEY_BYTES } from '../secrets/crypto.js'
import { createSecretsStore, type SecretsStore } from '../secrets/store.js'
import { generateServerKeys } from './keys.js'
import { provisionServerKeys, retireManagedUserKey } from './server-keys.js'

const PASSWORD = 'correct-horse-battery-staple'
const MASTER_KEY = randomBytes(KEY_BYTES)
const config: Config = configSchema.parse({})

let opened: OpenedDatabase
let store: SecretsStore
let created: CreatedApp
let adminId: string
let token: string

async function login(app: CreatedApp['app']): Promise<string> {
  const res = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { token: string }).token
}

const auth = (t = token) => ({ authorization: `Bearer ${t}` })

beforeEach(async () => {
  opened = openTestDatabase()
  store = createSecretsStore(opened.db, MASTER_KEY)
  const secrets = new MemorySecretStore()
  const admin = await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })
  adminId = admin.user.id
  created = createApp({ db: opened.db, config, secrets, secretsStore: store })
  token = await login(created.app)
})

afterEach(() => {
  opened.close()
})

function makeServer(userId = adminId, name = 'dev-box'): string {
  return insertServer(opened.db, {
    userId,
    name,
    provider: 'fake',
    size: 'small',
    offeringId: 'fake-small',
    arch: 'arm64',
  }).id
}

describe('GET /api/v1/servers/:id/ssh-key', () => {
  it('returns the private key as a .pem attachment to the owner', async () => {
    const serverId = makeServer()
    provisionServerKeys(opened.db, store, { serverId })

    const res = await created.app.request(`/api/v1/servers/${serverId}/ssh-key`, { headers: auth() })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-pem-file')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="dev-box.pem"')
    expect(res.headers.get('cache-control')).toBe('no-store')

    const body = await res.text()
    expect(body).toContain('-----BEGIN OPENSSH PRIVATE KEY-----')
    expect(body.trimEnd().endsWith('-----END OPENSSH PRIVATE KEY-----')).toBe(true)
    // The USER key, never the host key: the host private half stays on the box and in the DB.
    expect(body).toBe(store.getServerKeyMaterial(serverId)!.userPrivateKey)
  })

  it('requires a session', async () => {
    const serverId = makeServer()
    provisionServerKeys(opened.db, store, { serverId })

    const res = await created.app.request(`/api/v1/servers/${serverId}/ssh-key`)
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain('BEGIN OPENSSH')
  })

  it("hides another user's server behind the same 404 as a missing one", async () => {
    // A stranger must not be able to enumerate server ids by watching 404 turn into 403.
    const stranger = upsertUserByGithubId(opened.db, { githubId: '99', githubUsername: 'stranger' }).id
    const strangerToken = issueSession(opened.db, stranger, DEFAULT_SESSION_TTL_MS).token
    const adminsServer = makeServer(adminId, 'not-yours')
    provisionServerKeys(opened.db, store, { serverId: adminsServer })

    const theirs = await created.app.request(`/api/v1/servers/${adminsServer}/ssh-key`, { headers: auth(strangerToken) })
    const missing = await created.app.request('/api/v1/servers/srv-does-not-exist/ssh-key', {
      headers: auth(strangerToken),
    })

    expect(theirs.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await theirs.text()).toBe(await missing.text())
  })

  it("lets an admin download another user's key, and records that it was an admin", async () => {
    // Single-admin self-hosting: the admin already owns the box core runs on and the database
    // the key sits in, so withholding it from them protects nothing. Recording it does.
    const owner = upsertUserByGithubId(opened.db, { githubId: '77', githubUsername: 'owner' }).id
    const theirServer = makeServer(owner, 'their-box')
    provisionServerKeys(opened.db, store, { serverId: theirServer })

    const res = await created.app.request(`/api/v1/servers/${theirServer}/ssh-key`, { headers: auth() })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('BEGIN OPENSSH PRIVATE KEY')

    const [event] = listEventsForServer(opened.db, theirServer).filter((e) => e.type === 'ssh_key.downloaded')
    expect(JSON.parse(event!.payload!)).toMatchObject({ byAdmin: true })
  })

  it('404s when the server has no stored key material', async () => {
    const serverId = makeServer()
    const res = await created.app.request(`/api/v1/servers/${serverId}/ssh-key`, { headers: auth() })
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('No SSH key material')
  })

  it('404s with a specific reason once the key has been retired (ADR-0008, issue #92)', async () => {
    const serverId = makeServer()
    provisionServerKeys(opened.db, store, { serverId })
    retireManagedUserKey(store, serverId)

    const res = await created.app.request(`/api/v1/servers/${serverId}/ssh-key`, { headers: auth() })
    expect(res.status).toBe(404)
    // Distinct from "no material stored" — the host half is still there, only the user half a
    // client could have downloaded is gone.
    expect(await res.text()).toContain('retired')
  })

  it('audits every download', async () => {
    const serverId = makeServer()
    provisionServerKeys(opened.db, store, { serverId })

    await created.app.request(`/api/v1/servers/${serverId}/ssh-key`, { headers: auth() })
    await created.app.request(`/api/v1/servers/${serverId}/ssh-key`, { headers: auth() })

    const downloads = listEventsForServer(opened.db, serverId).filter((e) => e.type === 'ssh_key.downloaded')
    // Re-downloads are allowed on purpose (see the route's header comment) — what matters is
    // that each one is recorded, with who did it.
    expect(downloads).toHaveLength(2)
    expect(downloads[0]!.userId).toBe(adminId)
    expect(JSON.stringify(downloads[0]!.payload)).not.toContain('BEGIN OPENSSH')
  })

  it('is not mounted at all when core has no secrets store', async () => {
    const secrets = new MemorySecretStore()
    await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })
    const bare = createApp({ db: opened.db, config, secrets })
    const bareToken = await login(bare.app)

    const serverId = makeServer()
    const res = await bare.app.request(`/api/v1/servers/${serverId}/ssh-key`, {
      headers: { authorization: `Bearer ${bareToken}` },
    })
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('BEGIN OPENSSH')
  })
})

/**
 * The route exists so a client can write a REAL `known_hosts` entry (rockysurf-ftl9.2), which
 * is exactly why it has to be able to refuse (rockysurf-ftl9.13): on a provider that cannot
 * install the key core minted, the box presents its own forever, and answering with the minted
 * one hands out an entry guaranteed to fail verification.
 */
describe('GET /api/v1/servers/:id/ssh-host-key', () => {
  it('serves the minted key when core minted the key this box presents', async () => {
    const serverId = makeServer()
    // pinHostKey defaults to true: the provider can inject, so the row's pin IS the minted one.
    provisionServerKeys(opened.db, store, { serverId })

    const res = await created.app.request(`/api/v1/servers/${serverId}/ssh-host-key`, { headers: auth() })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { hostPublicKey: string; fingerprint: string }
    const material = store.getServerKeyMaterial(serverId)!
    expect(body.hostPublicKey).toBe(material.hostPublicKey)
    expect(body.fingerprint).toBe(material.hostKeyFingerprint)
  })

  it("serves the box's OWN key for a server core adopted, so it is pinned like any other", async () => {
    // The key a BYO provider observed during the handshake it pinned (ADR-0003, E14). Generating
    // a real pair here rather than inventing strings is the point: the route re-hashes what it
    // serves, so only a genuine key/fingerprint pair gets through.
    const observed = generateServerKeys('the-box').host
    const serverId = makeServer()
    provisionServerKeys(opened.db, store, { serverId, pinHostKey: false })
    setKeyMaterial(opened.db, serverId, {
      hostKeyFingerprint: observed.fingerprint,
      hostPublicKey: observed.publicKey,
    })

    const res = await created.app.request(`/api/v1/servers/${serverId}/ssh-host-key`, { headers: auth() })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { hostPublicKey: string; fingerprint: string; source: string }
    expect(body.hostPublicKey).toBe(observed.publicKey)
    expect(body.fingerprint).toBe(observed.fingerprint)
    // Labelled, so no caller has to infer which key it got from which provider it asked about.
    expect(body.source).toBe('observed')
    // And emphatically NOT the minted key, which is the bug this route had.
    expect(body.hostPublicKey).not.toBe(store.getServerKeyMaterial(serverId)!.hostPublicKey)
  })

  it('refuses a stored key that does not hash to the pin, rather than serving it', async () => {
    // The pin was verified during a real handshake; the key came out of a database row. If they
    // disagree, the row is not a second, softer way to change a server's host key.
    const observed = generateServerKeys('the-box').host
    const somebodyElse = generateServerKeys('not-the-box').host
    const serverId = makeServer()
    provisionServerKeys(opened.db, store, { serverId, pinHostKey: false })
    setKeyMaterial(opened.db, serverId, {
      hostKeyFingerprint: observed.fingerprint,
      hostPublicKey: somebodyElse.publicKey,
    })

    const res = await created.app.request(`/api/v1/servers/${serverId}/ssh-host-key`, { headers: auth() })
    expect(res.status).toBe(409)

    const body = (await res.json()) as { code: string; fingerprint?: string }
    expect(body.code).toBe('conflict')
    expect(body.fingerprint).toBe(observed.fingerprint)
    expect(JSON.stringify(body)).not.toContain(somebodyElse.publicKey)
  })

  it('refuses when nothing has been observed yet, rather than answering with the minted key', async () => {
    const serverId = makeServer()
    provisionServerKeys(opened.db, store, { serverId, pinHostKey: false })

    const res = await created.app.request(`/api/v1/servers/${serverId}/ssh-host-key`, { headers: auth() })
    expect(res.status).toBe(409)
    expect(await res.text()).not.toContain(store.getServerKeyMaterial(serverId)!.hostPublicKey)
  })

  it("hides another user's server behind the same 404 as a missing one", async () => {
    const stranger = upsertUserByGithubId(opened.db, { githubId: '98', githubUsername: 'nosy' }).id
    const strangerToken = issueSession(opened.db, stranger, DEFAULT_SESSION_TTL_MS).token
    const serverId = makeServer(adminId, 'not-yours')
    provisionServerKeys(opened.db, store, { serverId })

    const theirs = await created.app.request(`/api/v1/servers/${serverId}/ssh-host-key`, {
      headers: auth(strangerToken),
    })
    // Ownership is checked BEFORE the pin comparison, so a refusal cannot leak that a server
    // exists — the 409 is only ever an answer to someone entitled to an answer.
    expect(theirs.status).toBe(404)
  })
})

/**
 * ADR-0002 makes host-key pinning mandatory, which means the escape hatch must not exist
 * anywhere — not in a script, not in a comment someone will later uncomment, not in docs as a
 * suggested workaround.
 */
describe('StrictHostKeyChecking', () => {
  const REPO = fileURLToPath(new URL('../../../..', import.meta.url))
  /**
   * `dist.build` and `dist.prev` are in here for a different reason than the rest.
   *
   * The others are just noise — generated or vendored trees with no source rule to enforce. Those
   * two are TRANSIENT: `scripts/build-package.mjs` compiles into `dist.build/`, moves the old
   * `dist/` to `dist.prev/`, renames the new tree into place and deletes the leftovers. Both exist
   * only while a build is running, and both are then renamed or removed out from under anything
   * that happens to be reading them.
   *
   * So a walk that descends into them races the build: this test collected a path under
   * `packages/rockysurf/dist.build/` and threw ENOENT on `readFileSync` a moment later, because
   * another package's suite was rebuilding the binary at the time
   * (`packages/rockysurf/vitest.global-setup.ts` does exactly that). Nothing was wrong with the
   * repository — the file it wanted had been renamed into `dist/` while the walk was in flight.
   *
   * This is the residue of `docs/memories/2026-08-21-pnpm-sdk-build-race.md`. The atomic-rename
   * swap that memory describes protects READERS OF `dist/`, and completely: they see the whole old
   * tree or the whole new one. It cannot protect something enumerating the repository, because the
   * scratch directory is a real directory for the length of the compile and walking into it is a
   * race the rename does not narrow.
   */
  const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    'dist',
    'dist.build',
    'dist.prev',
    'build',
    '.data',
    'coverage',
    '.beads',
  ])

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (SKIP_DIRS.has(entry.name)) return []
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return walk(full)
      if (!/\.(ts|tsx|js|mjs|cjs|sh|yaml|yml|md|json)$/.test(entry.name)) return []
      return [full]
    })
  }

  /**
   * Two rules, because prose and code fail differently.
   *
   * In anything executable, ANY occurrence is a failure — there is no legitimate reason for
   * the string to be in a script or a config. In prose, only the copy-pasteable form is
   * (`-o StrictHostKeyChecking=no`), because a document is allowed — encouraged — to name the
   * thing it forbids, and `.plan` and the ADRs do exactly that. Banning the words in markdown
   * would mean the rule could not be written down.
   */
  const CODE = /\.(ts|tsx|js|mjs|cjs|sh|yaml|yml|json)$/
  const ANY_USE = /StrictHostKeyChecking\s*=?\s*no/i
  const COPY_PASTEABLE = /-o\s*["']?StrictHostKeyChecking\s*=\s*no/i

  it('never appears disabled in anything executable', () => {
    const offenders = walk(REPO)
      .filter((path) => CODE.test(path))
      // This test file necessarily contains the string it is looking for.
      .filter((path) => !path.endsWith(join('ssh', 'routes.test.ts')))
      .filter((path) => ANY_USE.test(readFileSync(path, 'utf8')))

    expect(
      offenders.map((p) => p.slice(REPO.length)),
      'host-key pinning is mandatory (ADR-0002): disabling StrictHostKeyChecking defeats it',
    ).toEqual([])
  })

  it('is never recommended in documentation as a runnable flag', () => {
    const offenders = walk(REPO)
      .filter((path) => path.endsWith('.md'))
      .filter((path) => COPY_PASTEABLE.test(readFileSync(path, 'utf8')))

    expect(
      offenders.map((p) => p.slice(REPO.length)),
      'a doc that shows the flag teaches users to disable pinning, which ADR-0002 forbids',
    ).toEqual([])
  })

  it('walks a real tree, so an empty result means something', () => {
    const files = walk(REPO)
    expect(files.length).toBeGreaterThan(50)
    expect(files.some((p) => p.endsWith(join('ssh', 'keys.ts')))).toBe(true)
  })
})
