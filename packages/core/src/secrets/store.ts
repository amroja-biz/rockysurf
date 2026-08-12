import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { newSecretId } from '../db/ids.js'
import { secrets, type SecretRow } from '../db/schema.js'
import { CURRENT_KEY_ID, open, seal, secretAad, type SealedSecret } from './crypto.js'

/**
 * The secrets store: the only code in core that turns ciphertext back into plaintext.
 *
 * CUSTODY RULE (ADR-0001, and the issue's risk list): **no HTTP route may return decrypted
 * secret material.** Plaintext leaves this module only towards the things that must hold it —
 * the SSH client, the git credential helper, the provider clients — never towards a response
 * body. `listSecretRefs` exists so that "what secrets exist" can be answered without
 * `getSecret`, and it is the only listing this module offers. A route that wants to show the
 * user their tokens is a bug in the route, and `secrets.route-inventory.test.ts` fails it.
 *
 * Scope naming: the shipped schema calls the two identifying columns `kind` and `ownerId`.
 * A "scope" in the task brief is a `kind`, and the "name" is the `ownerId` — the entity the
 * secret belongs to. One row per `(kind, ownerId)` pair; `putSecret` replaces rather than
 * accumulating, so `getSecret` is unambiguous. That invariant is enforced here rather than by
 * a unique index because `ownerId` is nullable and SQLite treats NULLs as distinct; a future
 * migration that gives instance-level secrets a sentinel owner should add the index too.
 */

export const SECRET_KINDS = [
  /** Core's SSH identity for one server: its private key, and the host key it pinned (E3). */
  'server-ssh-key',
  /** A git forge token used to clone private repositories onto boxes. */
  'github-token',
  /** The remote-desktop password for a pack that asked for one. */
  'rdp-password',
  /** A provider credential pasted into the UI. NEVER one that came from the environment. */
  'provider-token',
  /** Signs session cookies. Instance-level: one row, no owner. */
  'session-signing-key',
] as const

export type SecretKind = (typeof SECRET_KINDS)[number]

export interface SecretRef {
  kind: SecretKind
  /** The server or user the secret belongs to. Omit for instance-level secrets. */
  ownerId?: string | null
}

/**
 * A secret's existence and provenance, WITHOUT its value. This is the only shape that may
 * cross an API boundary, and the reason `listSecretRefs` is not called `listSecrets`.
 */
export interface SecretMetadata {
  id: string
  kind: SecretKind
  ownerId: string | null
  keyId: string
  createdAt: string
  updatedAt: string
}

/** Core's SSH identity for one server. The host private half is here per finding E3. */
export interface ServerKeyMaterial {
  userPrivateKey: string
  userPublicKey: string
  hostPrivateKey: string
  hostPublicKey: string
  /** `SHA256:...`, the value the server row also stores for first-contact verification. */
  hostKeyFingerprint: string
}

/**
 * Provider credentials that arrive through the environment are configuration, not data.
 *
 * They win at runtime, they are never written to the database, and `putProviderToken` refuses
 * to persist one while its variable is set. Persisting it would create a second copy with a
 * different lifetime: rotate the environment variable and the stale database row keeps being
 * offered to the provider, which fails in a way that looks like a credential problem at the
 * cloud rather than a stale row here.
 */
export const PROVIDER_CREDENTIAL_ENV: Readonly<Record<string, readonly string[]>> = {
  hetzner: ['HCLOUD_TOKEN', 'HETZNER_TOKEN'],
  aws: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE'],
}

export class EnvProvidedCredentialError extends Error {
  constructor(providerId: string, variable: string) {
    super(
      `refusing to persist a ${providerId} credential while ${variable} is set: ` +
        'environment-provided provider credentials are configuration and win at runtime',
    )
    this.name = 'EnvProvidedCredentialError'
  }
}

export interface SecretsStore {
  putSecret(ref: SecretRef, value: string): SecretMetadata
  /** PLAINTEXT. Never return this from an HTTP handler. */
  getSecret(ref: SecretRef): string | undefined
  /** PLAINTEXT, or throws when absent. Never return this from an HTTP handler. */
  requireSecret(ref: SecretRef): string
  deleteSecret(ref: SecretRef): boolean
  /** Metadata only, by design. */
  listSecretRefs(filter?: { kind?: SecretKind; ownerId?: string | null }): SecretMetadata[]

  putServerKeyMaterial(serverId: string, material: ServerKeyMaterial): SecretMetadata
  getServerKeyMaterial(serverId: string): ServerKeyMaterial | undefined
  putGithubToken(ownerId: string, token: string): SecretMetadata
  getGithubToken(ownerId: string): string | undefined
  putRdpPassword(serverId: string, password: string): SecretMetadata
  getRdpPassword(serverId: string): string | undefined
  putProviderToken(providerId: string, token: string, env?: NodeJS.ProcessEnv): SecretMetadata
  getProviderToken(providerId: string): string | undefined
  /** Returns the existing signing key, minting one on first call. */
  ensureSessionSigningKey(mint?: () => string): string
}

export function createSecretsStore(db: Db, masterKey: Buffer): SecretsStore {
  function findRow(ref: SecretRef): SecretRow | undefined {
    const ownerId = ref.ownerId ?? null
    const where =
      ownerId === null
        ? and(eq(secrets.kind, ref.kind), isNull(secrets.ownerId))
        : and(eq(secrets.kind, ref.kind), eq(secrets.ownerId, ownerId))
    return db.select().from(secrets).where(where).limit(1).get()
  }

  function toMetadata(row: SecretRow): SecretMetadata {
    return {
      id: row.id,
      kind: row.kind as SecretKind,
      ownerId: row.ownerId,
      keyId: row.keyId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  const store: SecretsStore = {
    putSecret(ref, value) {
      const ownerId = ref.ownerId ?? null
      const sealed: SealedSecret = seal(masterKey, value, secretAad(CURRENT_KEY_ID, ref.kind, ownerId))
      const now = new Date().toISOString()
      const existing = findRow(ref)

      if (existing) {
        // Replace in place: the id is referenced by other rows (servers.managedKeySecretId),
        // so re-keying a secret must not invalidate those pointers.
        const [updated] = db
          .update(secrets)
          .set({
            ciphertext: sealed.ciphertext,
            nonce: sealed.nonce,
            authTag: sealed.authTag,
            keyId: sealed.keyId,
            updatedAt: now,
          })
          .where(eq(secrets.id, existing.id))
          .returning()
          .all()
        if (!updated) throw new Error(`putSecret wrote no row for ${ref.kind}`)
        return toMetadata(updated)
      }

      const [inserted] = db
        .insert(secrets)
        .values({
          id: newSecretId(),
          kind: ref.kind,
          ownerId,
          ciphertext: sealed.ciphertext,
          nonce: sealed.nonce,
          authTag: sealed.authTag,
          keyId: sealed.keyId,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all()
      if (!inserted) throw new Error(`putSecret inserted no row for ${ref.kind}`)
      return toMetadata(inserted)
    },

    getSecret(ref) {
      const row = findRow(ref)
      if (!row) return undefined
      return open(
        masterKey,
        { ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.authTag, keyId: row.keyId },
        secretAad(row.keyId, row.kind, row.ownerId),
      )
    },

    requireSecret(ref) {
      const value = store.getSecret(ref)
      if (value === undefined) throw new Error(`no secret stored for ${ref.kind}/${ref.ownerId ?? 'instance'}`)
      return value
    },

    deleteSecret(ref) {
      const row = findRow(ref)
      if (!row) return false
      db.delete(secrets).where(eq(secrets.id, row.id)).run()
      return true
    },

    listSecretRefs(filter) {
      const rows = db.select().from(secrets).all()
      return rows
        .filter((row) => (filter?.kind ? row.kind === filter.kind : true))
        .filter((row) => (filter?.ownerId !== undefined ? row.ownerId === (filter.ownerId ?? null) : true))
        .map(toMetadata)
    },

    putServerKeyMaterial(serverId, material) {
      return store.putSecret({ kind: 'server-ssh-key', ownerId: serverId }, JSON.stringify(material))
    },

    getServerKeyMaterial(serverId) {
      const raw = store.getSecret({ kind: 'server-ssh-key', ownerId: serverId })
      if (raw === undefined) return undefined
      return JSON.parse(raw) as ServerKeyMaterial
    },

    putGithubToken(ownerId, token) {
      return store.putSecret({ kind: 'github-token', ownerId }, token)
    },

    getGithubToken(ownerId) {
      return store.getSecret({ kind: 'github-token', ownerId })
    },

    putRdpPassword(serverId, password) {
      return store.putSecret({ kind: 'rdp-password', ownerId: serverId }, password)
    },

    getRdpPassword(serverId) {
      return store.getSecret({ kind: 'rdp-password', ownerId: serverId })
    },

    putProviderToken(providerId, token, env = process.env) {
      assertNotEnvProvided(providerId, env)
      return store.putSecret({ kind: 'provider-token', ownerId: providerId }, token)
    },

    getProviderToken(providerId) {
      return store.getSecret({ kind: 'provider-token', ownerId: providerId })
    },

    ensureSessionSigningKey(mint = defaultSigningKey) {
      const existing = store.getSecret({ kind: 'session-signing-key' })
      if (existing !== undefined) return existing
      const minted = mint()
      store.putSecret({ kind: 'session-signing-key' }, minted)
      return minted
    },
  }

  return store
}

/** Throws when the environment already provides this provider's credential. */
export function assertNotEnvProvided(providerId: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const variable of PROVIDER_CREDENTIAL_ENV[providerId] ?? []) {
    const value = env[variable]
    if (value !== undefined && value.trim() !== '') throw new EnvProvidedCredentialError(providerId, variable)
  }
}

function defaultSigningKey(): string {
  // Imported lazily so this module has no crypto import beyond what sealing needs.
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64')
}
