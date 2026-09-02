import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type CreatedApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { configSchema, type Config } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { upsertTool } from '../db/repositories/packs.js'
import { upsertUserByGithubId } from '../db/repositories/users.js'
import { BACKUP_FORMAT_VERSION, NEWER_BACKUP_REFUSAL, type BackupArtifact } from './format.js'
import type { RestoreResponse } from './routes.js'

/**
 * Backup and Restore over the real HTTP surface (issue #331): the same app a browser talks
 * to, a real login, and the artifact travelling as a request body — the whole round trip the
 * Settings page performs, one layer down from the browser suite.
 */

const PASSWORD = 'correct-horse-battery-staple'
const MASTER_KEY = randomBytes(32)

let opened: OpenedDatabase
let created: CreatedApp
let token: string
let dir: string
let configPath: string

const CONFIG: Config = configSchema.parse({})

async function build(): Promise<void> {
  const secrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })
  created = createApp({ db: opened.db, config: CONFIG, secrets, masterKey: MASTER_KEY, configPath, env: {} })
  const res = await created.app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  token = ((await res.json()) as { token: string }).token
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rockysurf-backup-routes-'))
  configPath = join(dir, 'config.yaml')
  writeFileSync(configPath, 'github:\n  pat: "ghp_literal_secret"\nlimits:\n  maxServers: 4\n')
  opened = openTestDatabase()
  await build()
})

afterEach(() => {
  opened.close()
  rmSync(dir, { recursive: true, force: true })
})

const get = () => created.app.request('/api/v1/backup', { headers: { authorization: `Bearer ${token}` } })
const post = (body: string) =>
  created.app.request('/api/v1/backup/restore', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body,
  })

describe('GET /api/v1/backup', () => {
  it('downloads the artifact as an attachment, with the config tokens redacted', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="rockysurf-backup-.*\.json"$/)

    const artifact = (await res.json()) as BackupArtifact
    expect(artifact.artifact).toBe('rockysurf-backup')
    expect(artifact.formatVersion).toBe(BACKUP_FORMAT_VERSION)
    expect(JSON.stringify(artifact)).not.toContain('ghp_literal_secret')
    expect(artifact.config.redactedTokens.map((t) => t.label)).toEqual(['instance-wide github.pat'])
    expect(artifact.config.text).toContain('maxServers: 4')
  })

  it('requires an admin', async () => {
    upsertUserByGithubId(opened.db, { githubId: 'github:777', githubUsername: 'visitor' })
    // No non-admin login path exists in local mode, so assert the guard directly: an
    // unauthenticated request never reaches the route at all.
    const res = await created.app.request('/api/v1/backup')
    expect(res.status).toBe(401)
  })
})

describe('POST /api/v1/backup/restore', () => {
  it('round-trips through HTTP and lists the tokens to re-enter', async () => {
    upsertTool(opened.db, {
      id: 'travelling-tool',
      name: 'Travelling tool',
      description: 'made on the old machine',
      category: 'base',
      url: 'https://example.invalid',
      installScript: 'echo hi',
      enabled: true,
      installOrder: 10,
      bootstrap: false,
      runAs: 'rocky',
      sourceFile: null,
    })
    const artifact = (await (await get()).json()) as BackupArtifact

    // A second, fresh installation — its own database, its own admin row, its own config.
    const other = openTestDatabase()
    const otherDir = mkdtempSync(join(tmpdir(), 'rockysurf-backup-target-'))
    const otherConfig = join(otherDir, 'config.yaml')
    writeFileSync(otherConfig, 'limits:\n  maxServers: 1\n')
    try {
      const secrets = new MemorySecretStore()
      await ensureLocalAdmin({ db: other.db, secrets, password: PASSWORD })
      const targetApp = createApp({
        db: other.db,
        config: CONFIG,
        secrets,
        masterKey: MASTER_KEY,
        configPath: otherConfig,
        env: {},
      })
      const login = await targetApp.app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      })
      const targetToken = ((await login.json()) as { token: string }).token

      const res = await targetApp.app.request('/api/v1/backup/restore', {
        method: 'POST',
        headers: { authorization: `Bearer ${targetToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(artifact),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as RestoreResponse
      expect(body.report.tools.restored).toBe(1)
      expect(body.tokensToReenter).toEqual(['instance-wide github.pat'])
      expect(body.config.written).toBe(true)
      // The restored file carries the SOURCE's limits and the placeholder, never the literal.
      const written = readFileSync(otherConfig, 'utf8')
      expect(written).toContain('maxServers: 4')
      expect(written).not.toContain('ghp_literal_secret')
    } finally {
      other.close()
      rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it('refuses a body that is not JSON, is not a backup, or is from a newer Rocky Surf', async () => {
    const notJson = await post('not json at all')
    expect(notJson.status).toBe(400)
    expect(((await notJson.json()) as { error: string }).error).toContain('not valid JSON')

    const notBackup = await post(JSON.stringify({ hello: 'world' }))
    expect(notBackup.status).toBe(400)
    expect(((await notBackup.json()) as { error: string }).error).toContain('not a Rocky Surf backup')

    const artifact = (await (await get()).json()) as BackupArtifact
    const future = await post(JSON.stringify({ ...artifact, formatVersion: BACKUP_FORMAT_VERSION + 1 }))
    expect(future.status).toBe(400)
    expect(((await future.json()) as { error: string }).error).toBe(NEWER_BACKUP_REFUSAL)
  })

  it('refuses a damaged artifact with field-level issues', async () => {
    const artifact = (await (await get()).json()) as BackupArtifact
    const damaged = { ...artifact, users: [{ id: 'usr-x' }] }
    const res = await post(JSON.stringify(damaged))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; issues?: { path: string }[] }
    expect(body.error).toContain('damaged')
    expect(body.issues?.some((i) => i.path.startsWith('users'))).toBe(true)
  })

  it('refuses a body larger than any real backup', async () => {
    const res = await created.app.request('/api/v1/backup/restore', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': String(64 * 1024 * 1024),
      },
      body: '{}',
    })
    expect(res.status).toBe(413)
  })
})
