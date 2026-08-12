import type { Db } from '../db/client.js'
import { setKeyMaterial } from '../db/repositories/servers.js'
import type { SecretsStore, ServerKeyMaterial } from '../secrets/store.js'
import { generateServerKeys, type ServerKeys } from './keys.js'

/**
 * The per-server SSH key lifecycle: mint at create time, encrypt at rest, hand the public
 * halves to the provider, and keep the private halves reachable by exactly two callers — the
 * SSH client, and the one sanctioned download route.
 *
 * WHERE THE HALVES LIVE
 *
 *  - Both PRIVATE halves go into a single `server-ssh-key` secret row, encrypted with
 *    AES-256-GCM by the secrets store (rockysurf-gonw.6). One row rather than two because they
 *    are written together, read together, and deleted together; splitting them buys nothing and
 *    adds a state where a server has half an identity. The store binds the row's identity into
 *    the GCM AAD, so a row lifted from server A cannot be decrypted for server B — that is
 *    asserted in `server-keys.test.ts`.
 *  - The host PUBLIC fingerprint goes on the server row (`hostKeyFingerprint`), because core
 *    needs it to verify a connection before it has any reason to decrypt anything.
 *  - The secret's id goes on the server row (`managedKeySecretId`), so the row points at its
 *    key material rather than the store having to guess the convention.
 *  - The user PUBLIC half goes to the provider in `ProvisionSpec.sshPublicKeys`.
 *
 * Amendment E3 is the reason the host PRIVATE half is stored at all: without it, a core
 * restart between provision and bootstrap permanently loses the ability to authenticate to its
 * own box.
 */

export interface ProvisionKeys {
  /** Everything the provider needs, in the order it should appear in authorized_keys. */
  sshPublicKeys: string[]
  /** Injected via cloud-init so the box presents a key core already knows. */
  hostKeys: { ed25519Private: string; ed25519Public: string }
  /** `SHA256:...`, also persisted on the server row. */
  hostKeyFingerprint: string
  /** The secrets row holding both private halves. */
  secretId: string
}

export interface ProvisionKeysInput {
  serverId: string
  /**
   * An extra public key the user pasted at create time. APPENDED, never substituted.
   *
   * The pre-rewrite product treated this as an either/or — a user-provided key meant no
   * core-generated one — which is incompatible with push-mode bootstrap: core installs the
   * software over its own SSH connection, so a server whose only authorized key belongs to the
   * user is a server core cannot bootstrap, cannot resume, and cannot recover. Core's key is
   * therefore always first in the list and always present; the user's key is additional access,
   * not alternative access.
   */
  userSuppliedPublicKey?: string | null
  /** Injected in tests so a fixed keypair can be asserted against. */
  generate?: (serverId: string) => ServerKeys
  /**
   * Whether the MINTED host key becomes the row's pin. Defaults to true.
   *
   * False for a provider with `canInjectHostKeys: false` — BYO — where the box was running long
   * before core existed and will present its OWN host key, not one core generated. Writing the
   * minted fingerprint onto the row there would pin a key the machine can never present, and
   * every bootstrap connection would fail host-key verification with nothing on the row
   * explaining why. The keypair is still minted and still stored (the user half is how core logs
   * in at all); only the ROW's pin is withheld, so that the fingerprint the provider reports
   * from its own first connection is the only value ever written there.
   */
  pinHostKey?: boolean
}

export class InvalidPublicKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidPublicKeyError'
  }
}

/**
 * A conservative parse of an authorized_keys line. Rejects anything with a newline, so a
 * pasted "key" cannot smuggle a second entry — or an `authorized_keys` option like
 * `command=` — into the file cloud-init writes.
 */
export function normalizeUserPublicKey(raw: string): string {
  const value = raw.trim()
  if (value === '') throw new InvalidPublicKeyError('public key is empty')
  if (/[\r\n]/.test(value)) {
    throw new InvalidPublicKeyError('public key must be a single line; multiple keys are not accepted here')
  }

  const [type, blob] = value.split(/\s+/)
  const SUPPORTED = ['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521']
  if (!type || !SUPPORTED.includes(type)) {
    throw new InvalidPublicKeyError(`unsupported key type "${type ?? ''}"; expected one of ${SUPPORTED.join(', ')}`)
  }
  if (!blob || !/^[A-Za-z0-9+/]+=*$/.test(blob)) {
    throw new InvalidPublicKeyError('public key body is not base64; paste the contents of a .pub file')
  }
  // The type must match what the blob declares, or sshd silently ignores the entry.
  const declared = Buffer.from(blob, 'base64').subarray(4, 4 + type.length).toString('utf8')
  if (declared !== type) {
    throw new InvalidPublicKeyError('public key body does not match its declared type')
  }
  return value
}

/**
 * Mint both keypairs, store the private halves encrypted, and record the public identity on
 * the server row. Called once, at create time, BEFORE the provider is asked for an instance —
 * the host key has to exist before cloud-init can be handed it.
 */
export function provisionServerKeys(
  db: Db,
  secrets: SecretsStore,
  input: ProvisionKeysInput,
): ProvisionKeys {
  const keys = (input.generate ?? generateServerKeys)(input.serverId)

  const material: ServerKeyMaterial = {
    userPrivateKey: keys.user.privateKey,
    userPublicKey: keys.user.publicKey,
    hostPrivateKey: keys.host.privateKey,
    hostPublicKey: keys.host.publicKey,
    hostKeyFingerprint: keys.host.fingerprint,
  }
  const stored = secrets.putServerKeyMaterial(input.serverId, material)

  setKeyMaterial(db, input.serverId, {
    ...(input.pinHostKey === false ? {} : { hostKeyFingerprint: keys.host.fingerprint }),
    managedKeySecretId: stored.id,
  })

  const sshPublicKeys = [keys.user.publicKey]
  if (input.userSuppliedPublicKey) sshPublicKeys.push(normalizeUserPublicKey(input.userSuppliedPublicKey))

  return {
    sshPublicKeys,
    hostKeys: { ed25519Private: keys.host.privateKey, ed25519Public: keys.host.publicKey },
    hostKeyFingerprint: keys.host.fingerprint,
    secretId: stored.id,
  }
}

/**
 * Get-or-mint. Idempotent, and that is the point.
 *
 * The provision path reads a server's keys from more than one place — the authorized-keys
 * list and the rendered cloud-config both need them, and they are built independently. If
 * each minted its own pair, the host key baked into user-data would not be the one core
 * stored, and the first SSH connection would fail host-key verification with no obvious
 * cause. Minting once and reusing is also what makes a RETRIED create safe: the box may
 * already be running with the first pair authorized.
 *
 * Call this anywhere in the create path; the first call mints, the rest read.
 */
export function ensureServerKeys(db: Db, secrets: SecretsStore, input: ProvisionKeysInput): ProvisionKeys {
  const existing = secrets.getServerKeyMaterial(input.serverId)
  if (!existing) return provisionServerKeys(db, secrets, input)

  const sshPublicKeys = [existing.userPublicKey]
  if (input.userSuppliedPublicKey) sshPublicKeys.push(normalizeUserPublicKey(input.userSuppliedPublicKey))

  return {
    sshPublicKeys,
    hostKeys: { ed25519Private: existing.hostPrivateKey, ed25519Public: existing.hostPublicKey },
    hostKeyFingerprint: existing.hostKeyFingerprint,
    // The row already points at the secret; re-reading it here keeps the return shape whole
    // for callers that do not care whether this call minted or reused.
    secretId: secrets.listSecretRefs({ kind: 'server-ssh-key', ownerId: input.serverId })[0]?.id ?? '',
  }
}

/**
 * PLAINTEXT. The private halves, for the SSH client and for the download route — and for
 * nothing else. Returns undefined when the server has no stored key material.
 */
export function getServerKeyMaterial(secrets: SecretsStore, serverId: string): ServerKeyMaterial | undefined {
  return secrets.getServerKeyMaterial(serverId)
}

/** Remove a server's key material. Call when the server row is deleted, not when it stops. */
export function deleteServerKeys(secrets: SecretsStore, serverId: string): boolean {
  return secrets.deleteSecret({ kind: 'server-ssh-key', ownerId: serverId })
}

/** Filename for the downloaded private key. Server ids are hostname-safe, so this is too. */
export function privateKeyFilename(serverName: string, serverId: string): string {
  const safe = serverName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return `${safe || serverId}.pem`
}
