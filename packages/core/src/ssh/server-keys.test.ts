import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { getServer, insertServer } from '../db/repositories/servers.js'
import { upsertUserByGithubId } from '../db/repositories/users.js'
import { secrets as secretsTable } from '../db/schema.js'
import { KEY_BYTES, SecretDecryptionError } from '../secrets/crypto.js'
import { createSecretsStore, type SecretsStore } from '../secrets/store.js'
import { generateServerKeys } from './keys.js'
import {
  deleteServerKeys,
  ensureServerKeys,
  getServerKeyMaterial,
  InvalidPublicKeyError,
  normalizeUserPublicKey,
  privateKeyFilename,
  provisionServerKeys,
  retireManagedUserKey,
} from './server-keys.js'

const MASTER_KEY = randomBytes(KEY_BYTES)

let opened: OpenedDatabase
let store: SecretsStore
let userId: string

const makeServer = (name = 'dev-box') =>
  insertServer(opened.db, {
    userId,
    name,
    provider: 'fake',
    size: 'small',
    offeringId: 'fake-small',
    arch: 'arm64',
  }).id

beforeEach(() => {
  opened = openTestDatabase()
  store = createSecretsStore(opened.db, MASTER_KEY)
  userId = upsertUserByGithubId(opened.db, { githubId: '1', githubUsername: 'tester' }).id
})

afterEach(() => {
  opened.close()
})

describe('provisionServerKeys', () => {
  it('mints both keypairs, stores the private halves, and records the public identity', () => {
    const serverId = makeServer()
    const result = provisionServerKeys(opened.db, store, { serverId })

    expect(result.sshPublicKeys).toHaveLength(1)
    expect(result.sshPublicKeys[0]).toContain(`rockysurf-core@${serverId}`)
    expect(result.hostKeys.ed25519Public).toContain(`rockysurf-host@${serverId}`)
    expect(result.hostKeyFingerprint).toMatch(/^SHA256:/)

    // The server row learns its identity, so core can verify a connection before it has any
    // reason to decrypt anything.
    const row = getServer(opened.db, serverId)!
    expect(row.hostKeyFingerprint).toBe(result.hostKeyFingerprint)
    expect(row.managedKeySecretId).toBe(result.secretId)

    // Both private halves are stored — the host half is amendment E3's requirement.
    const material = getServerKeyMaterial(store, serverId)!
    expect(material.userPrivateKey).toContain('BEGIN OPENSSH PRIVATE KEY')
    expect(material.hostPrivateKey).toContain('BEGIN OPENSSH PRIVATE KEY')
    expect(material.hostKeyFingerprint).toBe(result.hostKeyFingerprint)
  })

  it('encrypts at rest: no private key is in the database rows', () => {
    const serverId = makeServer()
    const result = provisionServerKeys(opened.db, store, { serverId })
    const material = getServerKeyMaterial(store, serverId)!

    const rows = opened.db.select().from(secretsTable).all()
    expect(rows).toHaveLength(1)
    const dumped = JSON.stringify(rows)
    expect(dumped).not.toContain('BEGIN OPENSSH PRIVATE KEY')
    expect(dumped).not.toContain(material.userPrivateKey)
    expect(dumped).not.toContain(material.hostPrivateKey)
    expect(rows[0]!.keyId).toBe('v1')
    expect(rows[0]!.ownerId).toBe(serverId)

    // The host fingerprint is public and deliberately DOES sit in the clear on the row.
    expect(getServer(opened.db, serverId)!.hostKeyFingerprint).toBe(result.hostKeyFingerprint)
  })

  it('records the fingerprint the stored host key actually produces', () => {
    const serverId = makeServer()
    const fixed = generateServerKeys(serverId)
    const result = provisionServerKeys(opened.db, store, { serverId, generate: () => fixed })

    expect(result.hostKeyFingerprint).toBe(fixed.host.fingerprint)
    expect(getServerKeyMaterial(store, serverId)!.hostPrivateKey).toBe(fixed.host.privateKey)
    // Stable across reads: nothing re-derives a different answer later.
    expect(getServerKeyMaterial(store, serverId)!.hostKeyFingerprint).toBe(fixed.host.fingerprint)
    expect(getServer(opened.db, serverId)!.hostKeyFingerprint).toBe(fixed.host.fingerprint)
  })

  it('gives two servers unrelated identities', () => {
    const a = makeServer('box-a')
    const b = makeServer('box-b')
    const ka = provisionServerKeys(opened.db, store, { serverId: a })
    const kb = provisionServerKeys(opened.db, store, { serverId: b })

    expect(ka.hostKeyFingerprint).not.toBe(kb.hostKeyFingerprint)
    expect(ka.sshPublicKeys[0]).not.toBe(kb.sshPublicKeys[0])
    expect(ka.secretId).not.toBe(kb.secretId)
  })

  it("cannot decrypt one server's material under another server's identity", () => {
    // The store binds each row to its owner through the GCM AAD. Lifting the ciphertext onto
    // another server must fail rather than hand core the wrong private key for a box it is
    // about to trust.
    const a = makeServer('box-a')
    const b = makeServer('box-b')
    provisionServerKeys(opened.db, store, { serverId: a })
    provisionServerKeys(opened.db, store, { serverId: b })

    const rowA = opened.db.select().from(secretsTable).all().find((r) => r.ownerId === a)!
    opened.db
      .update(secretsTable)
      .set({ ciphertext: rowA.ciphertext, nonce: rowA.nonce, authTag: rowA.authTag })
      .where(eq(secretsTable.ownerId, b))
      .run()

    expect(() => getServerKeyMaterial(store, b)).toThrow(SecretDecryptionError)
    expect(getServerKeyMaterial(store, a)).toBeDefined() // A is untouched
  })

  it('ensureServerKeys mints once and then reuses, so two callers cannot disagree', () => {
    // The provision path reads the keys from more than one place — the authorized-keys list
    // and the rendered cloud-config. If each minted its own pair, the host key baked into
    // user-data would not be the one core stored, and the first SSH connection would fail
    // verification for no visible reason.
    const serverId = makeServer()
    const first = ensureServerKeys(opened.db, store, { serverId })
    const second = ensureServerKeys(opened.db, store, { serverId })

    expect(second.hostKeyFingerprint).toBe(first.hostKeyFingerprint)
    expect(second.sshPublicKeys).toEqual(first.sshPublicKeys)
    expect(second.hostKeys.ed25519Private).toBe(first.hostKeys.ed25519Private)
    expect(second.secretId).toBe(first.secretId)
    // One row, not two: a second mint would orphan the first identity.
    expect(opened.db.select().from(secretsTable).all()).toHaveLength(1)
    expect(getServer(opened.db, serverId)!.hostKeyFingerprint).toBe(first.hostKeyFingerprint)
  })

  it('ensureServerKeys appends a user key on reuse as well as on mint', () => {
    const serverId = makeServer()
    const userKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKPX6kWxlSdf7GU3Ve1I2dGGrKqdPBkR60OjKmHb9crV laptop'
    ensureServerKeys(opened.db, store, { serverId })

    const reused = ensureServerKeys(opened.db, store, { serverId, userSuppliedPublicKey: userKey })
    expect(reused.sshPublicKeys).toHaveLength(2)
    expect(reused.sshPublicKeys[0]).toContain('rockysurf-core@')
    expect(reused.sshPublicKeys[1]).toBe(userKey)
  })

  it('deletes key material on request', () => {
    const serverId = makeServer()
    provisionServerKeys(opened.db, store, { serverId })
    expect(deleteServerKeys(store, serverId)).toBe(true)
    expect(getServerKeyMaterial(store, serverId)).toBeUndefined()
    expect(deleteServerKeys(store, serverId)).toBe(false)
  })
})

describe('a user-supplied public key', () => {
  const USER_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKPX6kWxlSdf7GU3Ve1I2dGGrKqdPBkR60OjKmHb9crV laptop'

  it('is APPENDED, never substituted — core must keep its own access', () => {
    const serverId = makeServer()
    const result = provisionServerKeys(opened.db, store, { serverId, userSuppliedPublicKey: USER_KEY })

    expect(result.sshPublicKeys).toHaveLength(2)
    expect(result.sshPublicKeys[0]).toContain(`rockysurf-core@${serverId}`)
    expect(result.sshPublicKeys[1]).toBe(USER_KEY)
  })

  it('is optional', () => {
    expect(provisionServerKeys(opened.db, store, { serverId: makeServer('a') }).sshPublicKeys).toHaveLength(1)
    expect(
      provisionServerKeys(opened.db, store, { serverId: makeServer('b'), userSuppliedPublicKey: null }).sshPublicKeys,
    ).toHaveLength(1)
  })

  it('is trimmed and validated', () => {
    expect(normalizeUserPublicKey(`  ${USER_KEY}  `)).toBe(USER_KEY)
    expect(() => normalizeUserPublicKey('')).toThrow(InvalidPublicKeyError)
    expect(() => normalizeUserPublicKey('ssh-dss AAAAB3NzaC1kc3M= old')).toThrow(/unsupported key type/)
    expect(() => normalizeUserPublicKey('ssh-ed25519 not-base64! x')).toThrow(/not base64/)
  })

  it('refuses a multi-line paste, so a second entry cannot ride along', () => {
    // authorized_keys is line-oriented: a newline would smuggle in an extra key, or an option
    // like command=, that nobody reviewed.
    expect(() => normalizeUserPublicKey(`${USER_KEY}\n${USER_KEY}`)).toThrow(/single line/)
    expect(() => normalizeUserPublicKey(`${USER_KEY}\r\nssh-ed25519 AAAA evil`)).toThrow(/single line/)
  })

  it('refuses a key whose body disagrees with its declared type', () => {
    // An RSA blob wearing an ed25519 label: sshd would silently ignore the entry, so the user
    // would believe they had access and discover otherwise at the worst moment.
    expect(() => normalizeUserPublicKey('ssh-ed25519 AAAAB3NzaC1yc2EAAAADAQABAAABgQ== mismatch')).toThrow(
      /does not match its declared type/,
    )
  })
})

describe('retireManagedUserKey (ADR-0008, issue #92)', () => {
  it('clears the user half and keeps the host half', () => {
    const serverId = makeServer()
    provisionServerKeys(opened.db, store, { serverId })
    const before = getServerKeyMaterial(store, serverId)!

    retireManagedUserKey(store, serverId)

    const after = getServerKeyMaterial(store, serverId)!
    expect(after.userPrivateKey).toBe('')
    expect(after.userPublicKey).toBe('')
    // Untouched: `GET /servers/:id/ssh-host-key` still needs these, independent of which user
    // key is authorized.
    expect(after.hostPrivateKey).toBe(before.hostPrivateKey)
    expect(after.hostPublicKey).toBe(before.hostPublicKey)
    expect(after.hostKeyFingerprint).toBe(before.hostKeyFingerprint)
  })

  it('is idempotent — calling it again on an already-retired row changes nothing', () => {
    const serverId = makeServer()
    provisionServerKeys(opened.db, store, { serverId })
    retireManagedUserKey(store, serverId)
    const once = getServerKeyMaterial(store, serverId)!

    retireManagedUserKey(store, serverId)
    expect(getServerKeyMaterial(store, serverId)).toEqual(once)
  })

  it('is a no-op when the server has no key material at all', () => {
    const serverId = makeServer()
    expect(() => retireManagedUserKey(store, serverId)).not.toThrow()
    expect(getServerKeyMaterial(store, serverId)).toBeUndefined()
  })
})

describe('privateKeyFilename', () => {
  it('is derived from the server name, safely', () => {
    expect(privateKeyFilename('dev-box', 'srv-abc')).toBe('dev-box.pem')
    expect(privateKeyFilename('My Dev Box!', 'srv-abc')).toBe('my-dev-box.pem')
    // A name is user input and ends up in a Content-Disposition header.
    expect(privateKeyFilename('../../etc/passwd', 'srv-abc')).toBe('etc-passwd.pem')
    expect(privateKeyFilename('!!!', 'srv-abc')).toBe('srv-abc.pem')
    expect(privateKeyFilename('a"b', 'srv-abc')).toBe('a-b.pem')
  })
})
