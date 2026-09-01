import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { secrets } from '../db/schema.js'
import { CURRENT_KEY_ID, KEY_BYTES, SecretDecryptionError } from './crypto.js'
import { createSecretsStore, SECRET_KINDS, type SecretsStore, type ServerKeyMaterial } from './store.js'

const MASTER_KEY = randomBytes(KEY_BYTES)
const SERVER_ID = 'srv-a1b2c3d4e5f6'

const KEY_MATERIAL: ServerKeyMaterial = {
  userPrivateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nuser-half\n-----END OPENSSH PRIVATE KEY-----\n',
  userPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIuser rockysurf-core',
  hostPrivateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nhost-half\n-----END OPENSSH PRIVATE KEY-----\n',
  hostPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIhost rockysurf-host',
  hostKeyFingerprint: 'SHA256:e9NPcRMc+NRfbfdHYBE1mr7IpNjHjdlp7v2EZc62q00',
}

let opened: OpenedDatabase
let store: SecretsStore

beforeEach(() => {
  opened = openTestDatabase()
  store = createSecretsStore(opened.db, MASTER_KEY)
})

afterEach(() => {
  opened.close()
})

describe('put, get, delete', () => {
  it('round-trips a value through the database', () => {
    const meta = store.putSecret({ kind: 'github-token', ownerId: 'usr-1' }, 'ghp_example')
    expect(meta.kind).toBe('github-token')
    expect(meta.keyId).toBe(CURRENT_KEY_ID)
    expect(store.getSecret({ kind: 'github-token', ownerId: 'usr-1' })).toBe('ghp_example')
  })

  it('returns undefined for a secret that was never stored', () => {
    expect(store.getSecret({ kind: 'github-token', ownerId: 'nobody' })).toBeUndefined()
    expect(() => store.requireSecret({ kind: 'github-token', ownerId: 'nobody' })).toThrow(/no secret stored/)
  })

  it('replaces rather than accumulating, keeping the row id stable for referrers', () => {
    // servers.managedKeySecretId points at this row, so re-keying must not orphan it.
    const first = store.putSecret({ kind: 'server-ssh-key', ownerId: SERVER_ID }, 'one')
    const second = store.putSecret({ kind: 'server-ssh-key', ownerId: SERVER_ID }, 'two')

    expect(second.id).toBe(first.id)
    expect(store.getSecret({ kind: 'server-ssh-key', ownerId: SERVER_ID })).toBe('two')
    expect(opened.db.select().from(secrets).all()).toHaveLength(1)
    expect(second.updatedAt >= first.updatedAt).toBe(true)
  })

  it('keeps secrets for different owners apart', () => {
    store.putSecret({ kind: 'rdp-password', ownerId: 'srv-aaa' }, 'alpha')
    store.putSecret({ kind: 'rdp-password', ownerId: 'srv-bbb' }, 'bravo')
    expect(store.getSecret({ kind: 'rdp-password', ownerId: 'srv-aaa' })).toBe('alpha')
    expect(store.getSecret({ kind: 'rdp-password', ownerId: 'srv-bbb' })).toBe('bravo')
  })

  it('supports instance-level secrets with no owner', () => {
    store.putSecret({ kind: 'session-signing-key' }, 'signing')
    expect(store.getSecret({ kind: 'session-signing-key' })).toBe('signing')
    // An owner-scoped lookup of the same kind must not find the instance-level row.
    expect(store.getSecret({ kind: 'session-signing-key', ownerId: 'usr-1' })).toBeUndefined()
  })

  it('deletes, and reports whether anything was deleted', () => {
    store.putSecret({ kind: 'github-token', ownerId: 'usr-1' }, 'ghp_example')
    expect(store.deleteSecret({ kind: 'github-token', ownerId: 'usr-1' })).toBe(true)
    expect(store.deleteSecret({ kind: 'github-token', ownerId: 'usr-1' })).toBe(false)
    expect(store.getSecret({ kind: 'github-token', ownerId: 'usr-1' })).toBeUndefined()
  })

  it('uses a fresh nonce for every write, including rewrites of the same value', () => {
    const nonces = new Set<string>()
    for (let i = 0; i < 50; i++) {
      store.putSecret({ kind: 'github-token', ownerId: `usr-${i}` }, 'the-same-token-every-time')
      store.putSecret({ kind: 'rdp-password', ownerId: 'srv-fixed' }, 'the-same-password-every-time')
    }
    for (const row of opened.db.select().from(secrets).all()) nonces.add(row.nonce)
    // 50 distinct owners plus the single rewritten row.
    expect(nonces.size).toBe(51)
  })
})

describe('listSecretRefs', () => {
  it('returns metadata and never a value', () => {
    store.putServerKeyMaterial(SERVER_ID, KEY_MATERIAL)
    store.putGithubToken('usr-1', 'ghp_example')

    const refs = store.listSecretRefs()
    expect(refs).toHaveLength(2)

    const serialized = JSON.stringify(refs)
    expect(serialized).not.toContain('ghp_example')
    expect(serialized).not.toContain('BEGIN OPENSSH')
    for (const ref of refs) {
      expect(Object.keys(ref).sort()).toEqual(['createdAt', 'id', 'keyId', 'kind', 'ownerId', 'updatedAt'])
    }
  })

  it('filters by kind and owner', () => {
    store.putGithubToken('usr-1', 'a')
    store.putGithubToken('usr-2', 'b')
    store.putRdpPassword('srv-1', 'c')

    expect(store.listSecretRefs({ kind: 'github-token' })).toHaveLength(2)
    expect(store.listSecretRefs({ kind: 'github-token', ownerId: 'usr-2' })).toHaveLength(1)
    expect(store.listSecretRefs({ ownerId: 'srv-1' })).toHaveLength(1)
  })
})

describe('typed helpers', () => {
  it('round-trips server key material including the host private half', () => {
    // Amendment E3: losing the host private half means core cannot verify its own box.
    store.putServerKeyMaterial(SERVER_ID, KEY_MATERIAL)
    expect(store.getServerKeyMaterial(SERVER_ID)).toEqual(KEY_MATERIAL)
    expect(store.getServerKeyMaterial('srv-unknown')).toBeUndefined()
  })

  it('round-trips git tokens and rdp passwords', () => {
    store.putGithubToken('usr-1', 'ghp_example')
    store.putRdpPassword(SERVER_ID, 'hunter2')
    expect(store.getGithubToken('usr-1')).toBe('ghp_example')
    expect(store.getRdpPassword(SERVER_ID)).toBe('hunter2')
  })

  it('mints a session signing key once and reuses it', () => {
    const first = store.ensureSessionSigningKey()
    const second = store.ensureSessionSigningKey()
    expect(second).toBe(first)
    expect(store.listSecretRefs({ kind: 'session-signing-key' })).toHaveLength(1)
  })

  it('covers every declared kind', () => {
    expect(new Set(SECRET_KINDS).size).toBe(SECRET_KINDS.length)
    for (const kind of SECRET_KINDS) {
      store.putSecret({ kind, ownerId: 'owner' }, `value-for-${kind}`)
      expect(store.getSecret({ kind, ownerId: 'owner' })).toBe(`value-for-${kind}`)
    }
  })
})

/*
 * There is deliberately no provider-credential test here (issue #280): the `provider-token`
 * kind was removed with the wizard's credential box, so the store has nothing to refuse and
 * nothing to persist. Cloud credentials come from the environment or the config file's
 * `${VAR}` reference and never reach this module.
 */

describe('a database written with one key cannot be read with another', () => {
  it('fails authentication rather than returning garbage', () => {
    store.putGithubToken('usr-1', 'ghp_example')
    const impostor = createSecretsStore(opened.db, randomBytes(KEY_BYTES))
    expect(() => impostor.getGithubToken('usr-1')).toThrow(SecretDecryptionError)
  })

  it('fails when a row is moved to another owner behind the store back', () => {
    store.putGithubToken('usr-1', 'ghp_example')
    opened.db.update(secrets).set({ ownerId: 'usr-2' }).run()
    expect(() => store.getGithubToken('usr-2')).toThrow(SecretDecryptionError)
  })
})

describe('the database file itself', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rockysurf-db-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('contains no plaintext secret anywhere in its bytes', () => {
    const path = join(dir, 'rockysurf.db')
    const onDisk = openDatabase({ url: path })
    const diskStore = createSecretsStore(onDisk.db, MASTER_KEY)

    // Distinctive values, so a hit in the file is unambiguous rather than a coincidence.
    const canaries = {
      token: 'ghp_CANARY_github_token_2f4a',
      password: 'CANARY-rdp-password-9c1e',
      signing: 'CANARY-session-signing-key-77b3',
    }
    diskStore.putGithubToken('usr-1', canaries.token)
    diskStore.putRdpPassword(SERVER_ID, canaries.password)
    diskStore.putSecret({ kind: 'session-signing-key' }, canaries.signing)
    diskStore.putServerKeyMaterial(SERVER_ID, KEY_MATERIAL)

    // Checkpoint the WAL so everything written is in the file we are about to read.
    onDisk.sqlite.pragma('wal_checkpoint(TRUNCATE)')
    onDisk.close()

    const bytes = readFileSync(path)
    const haystack = bytes.toString('binary')
    for (const canary of Object.values(canaries)) {
      expect(haystack).not.toContain(canary)
    }
    expect(haystack).not.toContain('BEGIN OPENSSH PRIVATE KEY')
    expect(haystack).not.toContain(KEY_MATERIAL.userPrivateKey)
    expect(haystack).not.toContain(KEY_MATERIAL.hostPrivateKey)

    // The master key must not be sitting in the database either.
    expect(haystack).not.toContain(MASTER_KEY.toString('base64'))

    // Sanity: the rows really are there, so this test cannot pass by writing nothing.
    expect(haystack).toContain('secrets')
    const reopened = openDatabase({ url: path })
    expect(createSecretsStore(reopened.db, MASTER_KEY).getGithubToken('usr-1')).toBe(canaries.token)
    reopened.close()
  })
})
