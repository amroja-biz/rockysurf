import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { upsertUserByGithubId } from '../db/repositories/users.js'
import { insertServer } from '../db/repositories/servers.js'
import { upsertPack, upsertTool } from '../db/repositories/packs.js'
import { getSetting, setSetting } from '../db/repositories/settings.js'
import { secrets as secretsTable, servers as serversTable, serverRepositories, users as usersTable, tools as toolsTable } from '../db/schema.js'
import { open, seal, secretAad } from '../secrets/crypto.js'
import { newSecretId } from '../db/ids.js'
import { createBackup, serializeConfigForBackup } from './create.js'
import { BACKUP_FORMAT_VERSION, backupSchema, migrateBackup, type BackupArtifact } from './format.js'
import { restoreConfig, restoreDatabase } from './restore.js'

/**
 * Backup → Restore, the round trip and its refusals (issue #331, ADR-0023).
 *
 * The shape under test throughout: a SOURCE installation (the old laptop) seeded with real
 * state, `createBackup` producing the artifact, and a TARGET installation (the new laptop,
 * fresh, with its own local admin under a different row id) consuming it. Equivalence is
 * asserted at the level that matters — rows present, ownership remapped, ciphertext that
 * DECRYPTS under the traveling master key — not as a byte-for-byte diff.
 */

const MASTER_KEY = randomBytes(32)
const NOW = () => new Date('2026-09-02T12:00:00Z')
const LAST_MONTH = () => new Date('2026-08-15T12:00:00Z')

let source: OpenedDatabase
let target: OpenedDatabase

beforeEach(() => {
  source = openTestDatabase()
  target = openTestDatabase()
})

afterEach(() => {
  source.close()
  target.close()
})

/** The local admin, as `ensureLocalAdmin` creates it — same identity, per-install row id. */
const seedAdmin = (db: OpenedDatabase) =>
  upsertUserByGithubId(db.db, { githubId: 'local:admin', githubUsername: 'admin', isAdmin: true })

interface SeededSource {
  adminId: string
  serverId: string
  artifact: BackupArtifact
}

/** One of everything on the source, then the artifact it produces. */
function seedAndBackup(options: { configPath?: string; now?: () => Date } = {}): SeededSource {
  const admin = seedAdmin(source)

  const server = insertServer(source.db, {
    userId: admin.id,
    name: 'dev-box',
    provider: 'fake',
    size: 'small',
    offeringId: 'fake-small',
    arch: 'arm64',
  })
  source.db
    .update(serversTable)
    .set({ hourlyCostAmount: 0.05, hourlyCostCurrency: 'USD', estimatedTotalCost: 3.5, totalUptimeSeconds: 252000 })
    .where(eq(serversTable.id, server.id))
    .run()
  source.db.insert(serverRepositories).values({ serverId: server.id, repositoryUrl: 'https://github.com/acme/widgets' }).run()

  upsertTool(source.db, {
    id: 'my-linter',
    name: 'My linter',
    description: 'personal tool',
    category: 'base',
    url: 'https://example.invalid',
    installScript: 'echo install',
    enabled: true,
    installOrder: 10,
    bootstrap: false,
    runAs: 'rocky',
    sourceFile: null,
  })
  upsertTool(source.db, {
    id: 'shipped-tool',
    name: 'Shipped tool',
    description: 'from a pack file',
    category: 'base',
    url: 'https://example.invalid',
    installScript: 'echo shipped',
    enabled: false,
    installOrder: 20,
    bootstrap: false,
    runAs: 'rocky',
    alwaysInstall: true,
    sourceFile: 'packs/shipped.yaml',
  })
  upsertPack(source.db, {
    id: 'my-pack',
    name: 'My pack',
    tools: ['my-linter'],
    displayOrder: 5,
    enabled: true,
    requiresRepos: false,
    requiresRdp: false,
    sourceFile: null,
  })

  const putSecret = (kind: string, ownerId: string, plaintext: string) => {
    const sealed = seal(MASTER_KEY, plaintext, secretAad('v1', kind, ownerId))
    source.db
      .insert(secretsTable)
      .values({
        id: newSecretId(),
        kind,
        ownerId,
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        authTag: sealed.authTag,
        keyId: 'v1',
        createdAt: NOW().toISOString(),
        updatedAt: NOW().toISOString(),
      })
      .run()
  }
  putSecret('server-ssh-key', server.id, JSON.stringify({ userPrivateKey: 'PRIVATE MATERIAL' }))
  putSecret('rdp-password', server.id, 'hunter2hunter2')
  putSecret('github-token', admin.id, 'gho_connect_token')
  putSecret('session-signing-key', 'instance', 'signing-key-material')

  setSetting(source.db, 'jobs.spend.baseline.2026-09', JSON.stringify({ USD: 3.0 }))
  setSetting(source.db, 'auth.local.passwordHash', 'scrypt$16384$8$1$salt$hash')

  const artifact = createBackup({
    db: source.db,
    ...(options.configPath ? { configPath: options.configPath } : {}),
    now: options.now ?? NOW,
  })
  return { adminId: admin.id, serverId: server.id, artifact }
}

/* ------------------------------------------------------------- what the artifact contains */

describe('the backup artifact', () => {
  it('carries the state and never the master key, plaintext, signing key or password hash', () => {
    const { artifact } = seedAndBackup()

    expect(artifact.artifact).toBe('rockysurf-backup')
    expect(artifact.formatVersion).toBe(BACKUP_FORMAT_VERSION)
    expect(artifact.users).toHaveLength(1)
    expect(artifact.servers).toHaveLength(1)
    expect(artifact.serverRepositories).toHaveLength(1)
    // User-owned rows travel; the shipped tool travels only as its two switches.
    expect(artifact.tools.map((t) => t.id)).toEqual(['my-linter'])
    expect(artifact.fileBackedToolState).toEqual([{ toolId: 'shipped-tool', alwaysInstall: true, enabled: false }])
    expect(artifact.packs.map((p) => p.id)).toEqual(['my-pack'])

    const kinds = artifact.secrets.map((s) => s.kind).sort()
    expect(kinds).toEqual(['github-token', 'rdp-password', 'server-ssh-key'])
    expect(artifact.settings.map((s) => s.key)).toEqual(['jobs.spend.baseline.2026-09'])

    // Nothing anywhere in the artifact is plaintext secret material.
    const text = JSON.stringify(artifact)
    expect(text).not.toContain('PRIVATE MATERIAL')
    expect(text).not.toContain('hunter2hunter2')
    expect(text).not.toContain('gho_connect_token')
    expect(text).not.toContain('signing-key-material')
    expect(text).not.toContain('passwordHash')
    expect(text).not.toContain(MASTER_KEY.toString('base64'))
  })

  it('validates against its own schema, so what create writes is what restore reads', () => {
    const { artifact } = seedAndBackup()
    const parsed = backupSchema.safeParse(JSON.parse(JSON.stringify(artifact)))
    expect(parsed.success).toBe(true)
  })
})

/* ------------------------------------------------------------- config token redaction */

describe('serializeConfigForBackup', () => {
  it('redacts literal tokens to placeholders and keeps their identities', () => {
    const config = [
      'github:',
      '  pat: "ghp_instance_literal"',
      '  tokens:',
      '    - repo: acme/widgets',
      '      pat: "ghp_scoped_literal"',
      '    - host: ghe.corp',
      '      pat: "${GHE_PAT}"',
      '',
    ].join('\n')

    const { text, redactedTokens } = serializeConfigForBackup(config)

    expect(text).not.toContain('ghp_instance_literal')
    expect(text).not.toContain('ghp_scoped_literal')
    // A whole-`${VAR}` reference is the operator's own indirection and travels as written.
    expect(text).toContain('${GHE_PAT}')
    expect(redactedTokens).toHaveLength(2)
    expect(redactedTokens[0]).toMatchObject({ path: 'github.pat', label: 'instance-wide github.pat' })
    expect(redactedTokens[1]!.label).toBe('acme/widgets')
    // The placeholders are what the text now says, so restore's file remains coherent.
    for (const token of redactedTokens) expect(text).toContain(token.placeholder)
  })

  it('leaves a config with nothing to redact byte-identical', () => {
    const config = 'limits:\n  maxServers: 3\n'
    const { text, redactedTokens } = serializeConfigForBackup(config)
    expect(text).toBe(config)
    expect(redactedTokens).toEqual([])
  })

  it('redacts a mixed literal-with-variable value whole, the settings view line', () => {
    const { text, redactedTokens } = serializeConfigForBackup('github:\n  pat: "tok_${SUFFIX}"\n')
    expect(text).not.toContain('tok_')
    expect(redactedTokens).toHaveLength(1)
  })
})

/* ------------------------------------------------------------- the round trip */

describe('restoreDatabase', () => {
  it('round-trips: identity remapped, secrets decrypt under the traveling key, spend adjusted', () => {
    const { adminId: oldAdminId, serverId, artifact } = seedAndBackup()

    // The new machine: same identity, different row id — `ensureLocalAdmin` has already run,
    // and the spend tracker has already primed this month's baseline (jobs/limits.ts).
    const newAdmin = seedAdmin(target)
    expect(newAdmin.id).not.toBe(oldAdminId)
    setSetting(target.db, 'jobs.spend.baseline.2026-09', JSON.stringify({}))

    const report = restoreDatabase({ db: target.db, masterKey: MASTER_KEY, now: NOW }, artifact)

    // Identity: matched by githubId, nothing inserted, everything remapped.
    expect(report.users).toEqual({ restored: 0, skipped: 1, refused: [] })
    const restoredServer = target.db.select().from(serversTable).where(eq(serversTable.id, serverId)).get()
    expect(restoredServer?.userId).toBe(newAdmin.id)
    expect(report.servers.restored).toBe(1)
    expect(report.repositories.restored).toBe(1)
    expect(report.tools.restored).toBe(1)
    expect(report.packs.restored).toBe(1)

    // The server-scoped secrets decrypt in place, owner ids untouched.
    const sshRow = target.db
      .select()
      .from(secretsTable)
      .where(and(eq(secretsTable.kind, 'server-ssh-key'), eq(secretsTable.ownerId, serverId)))
      .get()
    expect(sshRow).toBeDefined()
    expect(open(MASTER_KEY, sshRow!, secretAad('v1', 'server-ssh-key', serverId))).toContain('PRIVATE MATERIAL')

    // The github-token was re-sealed under the NEW owner id — the AAD-bound remap.
    const tokenRow = target.db
      .select()
      .from(secretsTable)
      .where(and(eq(secretsTable.kind, 'github-token'), eq(secretsTable.ownerId, newAdmin.id)))
      .get()
    expect(tokenRow).toBeDefined()
    expect(open(MASTER_KEY, tokenRow!, secretAad('v1', 'github-token', newAdmin.id))).toBe('gho_connect_token')
    expect(report.secrets).toMatchObject({ restored: 3, readable: 3, unreadable: 0, dropped: [] })

    // Same-month restore: the backup's own baseline travels into this month's, so the
    // restored history reads as it did on the old machine (3.5 lifetime − 3.0 baseline).
    expect(report.spend.adjustedMonth).toBe('2026-09')
    expect(JSON.parse(getSetting(target.db, 'jobs.spend.baseline.2026-09')!)).toEqual({ USD: 3.0 })
  })

  it('restoring the same artifact twice changes nothing the second time', () => {
    const { artifact } = seedAndBackup()
    seedAdmin(target)

    restoreDatabase({ db: target.db, masterKey: MASTER_KEY, now: NOW }, artifact)
    const report = restoreDatabase({ db: target.db, masterKey: MASTER_KEY, now: NOW }, artifact)

    expect(report.servers).toEqual({ restored: 0, skipped: 1, refused: [] })
    expect(report.tools.restored).toBe(0)
    expect(report.packs.restored).toBe(0)
    expect(report.secrets.restored).toBe(0)
    expect(report.secrets.skipped).toBe(3)
    // No servers inserted, so the baseline is NOT adjusted a second time.
    expect(report.spend.adjustedMonth).toBeUndefined()
  })

  it('a backup from an earlier month puts its whole restored cost into this month baseline', () => {
    const { artifact } = seedAndBackup({ now: LAST_MONTH })
    seedAdmin(target)

    const report = restoreDatabase({ db: target.db, masterKey: MASTER_KEY, now: NOW }, artifact)

    // All 3.5 of lifetime cost predates September, so none of it reads as September spend.
    expect(report.spend.adjustedMonth).toBe('2026-09')
    expect(JSON.parse(getSetting(target.db, 'jobs.spend.baseline.2026-09')!)).toEqual({ USD: 3.5 })
  })

  it('with the wrong master key: server secrets restore unreadable, the github-token is dropped', () => {
    const { adminId: oldAdminId, serverId, artifact } = seedAndBackup()
    seedAdmin(target)

    const report = restoreDatabase({ db: target.db, masterKey: randomBytes(32), now: NOW }, artifact)

    // The server-scoped rows are inserted — the right key arriving later heals them in
    // place — but every probe honestly fails today.
    expect(report.secrets.restored).toBe(2)
    expect(report.secrets.unreadable).toBe(2)
    expect(report.secrets.readable).toBe(0)
    // The github-token cannot be re-sealed without the key that sealed it: dropped, with the
    // instruction that actually helps.
    expect(report.secrets.dropped).toHaveLength(1)
    expect(report.secrets.dropped[0]!.reason).toContain('Reconnect GitHub')
    const tokenRows = target.db.select().from(secretsTable).where(eq(secretsTable.kind, 'github-token')).all()
    expect(tokenRows).toHaveLength(0)
    // And nothing was restored under the OLD owner id either.
    expect(
      target.db.select().from(usersTable).where(eq(usersTable.id, oldAdminId)).get(),
    ).toBeUndefined()
    expect(target.db.select().from(serversTable).where(eq(serversTable.id, serverId)).get()).toBeDefined()
  })

  it('refuses a tool or pack id that is file-backed here, the ADR-0018 rule', () => {
    const { artifact } = seedAndBackup()
    seedAdmin(target)
    upsertTool(target.db, {
      id: 'my-linter',
      name: 'Now shipped',
      description: 'this release ships a tool by that id',
      category: 'base',
      url: 'https://example.invalid',
      installScript: 'echo shipped',
      enabled: true,
      installOrder: 10,
      bootstrap: false,
      runAs: 'rocky',
      sourceFile: 'packs/new.yaml',
    })

    const report = restoreDatabase({ db: target.db, masterKey: MASTER_KEY, now: NOW }, artifact)

    expect(report.tools.refused).toHaveLength(1)
    expect(report.tools.refused[0]!.reason).toContain('pack file')
    const row = target.db.select().from(toolsTable).where(eq(toolsTable.id, 'my-linter')).get()
    expect(row?.name).toBe('Now shipped')
  })

  it('applies the switches on a shipped tool this release has, and skips one it does not', () => {
    const { artifact } = seedAndBackup()
    seedAdmin(target)
    upsertTool(target.db, {
      id: 'shipped-tool',
      name: 'Shipped tool',
      description: 'from a pack file',
      category: 'base',
      url: 'https://example.invalid',
      installScript: 'echo shipped',
      enabled: true,
      installOrder: 20,
      bootstrap: false,
      runAs: 'rocky',
      sourceFile: 'packs/shipped.yaml',
    })

    const report = restoreDatabase({ db: target.db, masterKey: MASTER_KEY, now: NOW }, artifact)

    expect(report.toolState).toEqual({ applied: 1, skipped: 0 })
    const row = target.db.select().from(toolsTable).where(eq(toolsTable.id, 'shipped-tool')).get()
    expect(row?.alwaysInstall).toBe(true)
    expect(row?.enabled).toBe(false)
  })

  it('refuses a user whose username belongs to a different account here, and their servers with them', () => {
    const admin = seedAdmin(source)
    const other = upsertUserByGithubId(source.db, { githubId: 'github:12345', githubUsername: 'octocat' })
    insertServer(source.db, {
      userId: other.id,
      name: 'their-box',
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
    })
    const artifact = createBackup({ db: source.db, now: NOW })
    void admin

    seedAdmin(target)
    // Same username, DIFFERENT identity — the collision that cannot be merged honestly.
    upsertUserByGithubId(target.db, { githubId: 'github:99999', githubUsername: 'octocat' })

    const report = restoreDatabase({ db: target.db, masterKey: MASTER_KEY, now: NOW }, artifact)

    expect(report.users.refused).toHaveLength(1)
    expect(report.users.refused[0]!.reason).toContain('octocat')
    expect(report.servers.refused).toHaveLength(1)
    expect(report.servers.refused[0]!.reason).toContain('owner')
  })

  it('never lets a session-signing-key row in, even from a hand-edited artifact', () => {
    const { artifact } = seedAndBackup()
    seedAdmin(target)
    const sealed = seal(MASTER_KEY, 'smuggled', secretAad('v1', 'session-signing-key', null))
    const edited = {
      ...artifact,
      secrets: [...artifact.secrets, { id: newSecretId(), kind: 'session-signing-key', ownerId: null, ...sealed }],
    }

    restoreDatabase({ db: target.db, masterKey: MASTER_KEY, now: NOW }, edited)

    expect(target.db.select().from(secretsTable).where(eq(secretsTable.kind, 'session-signing-key')).all()).toHaveLength(0)
  })
})

/* ------------------------------------------------------------- format versioning */

describe('format versioning', () => {
  it('migrateBackup is the identity for the current version', () => {
    const { artifact } = seedAndBackup()
    expect(migrateBackup(artifact)).toBe(artifact)
  })
})

/* ------------------------------------------------------------- the config file step */

describe('restoreConfig', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rockysurf-backup-test-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const artifactWithConfig = (text: string): BackupArtifact => {
    const { artifact } = seedAndBackup()
    return { ...artifact, config: { text, redactedTokens: [] } }
  }

  it('writes the backup config but keeps this machine pinned paths', () => {
    const configPath = join(dir, 'config.yaml')
    writeFileSync(configPath, 'server:\n  port: 3100\nlimits:\n  maxServers: 1\n')
    const artifact = artifactWithConfig('server:\n  port: 4200\n  dataDir: "/old/laptop/data"\nlimits:\n  maxServers: 7\n')

    const outcome = restoreConfig({ configPath, env: {} }, artifact)

    expect(outcome.written).toBe(true)
    expect(outcome.pinnedKept).toContain('server.port')
    expect(outcome.pinnedKept).toContain('server.dataDir')
    const written = readFileSync(configPath, 'utf8')
    expect(written).toContain('port: 3100')
    expect(written).not.toContain('4200')
    expect(written).not.toContain('/old/laptop/data')
    expect(written).toContain('maxServers: 7')
  })

  it('refuses an invalid backup config and leaves the file untouched', () => {
    const configPath = join(dir, 'config.yaml')
    writeFileSync(configPath, 'limits:\n  maxServers: 1\n')
    const artifact = artifactWithConfig('limits:\n  maxServers: "many"\n')

    const outcome = restoreConfig({ configPath, env: {} }, artifact)

    expect(outcome.written).toBe(false)
    expect(outcome.refused?.length).toBeGreaterThan(0)
    expect(readFileSync(configPath, 'utf8')).toContain('maxServers: 1')
  })

  it('a redacted placeholder is a warning, not a refusal — the file applies and says so', () => {
    const configPath = join(dir, 'config.yaml')
    writeFileSync(configPath, 'limits:\n  maxServers: 1\n')
    const artifact = artifactWithConfig('github:\n  pat: "${GITHUB_PAT}"\n')

    const outcome = restoreConfig({ configPath, env: {} }, artifact)

    expect(outcome.written).toBe(true)
    expect(outcome.warnings?.some((w) => w.message.includes('GITHUB_PAT'))).toBe(true)
  })
})
