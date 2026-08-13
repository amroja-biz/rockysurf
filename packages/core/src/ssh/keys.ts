import { createHash, generateKeyPairSync } from 'node:crypto'

/**
 * ed25519 keypairs in OpenSSH format, with no dependencies.
 *
 * Ported from the spike (`spike/src/keys.ts`, rockysurf-d0no.5), where the output was checked
 * byte-for-byte against `ssh-keygen`: same fingerprint, same derived public key. That property
 * is the whole point of hand-rolling this, and `keys.test.ts` re-checks it against the real
 * binary rather than trusting the port.
 *
 * Node's crypto exports PKCS#8/SPKI, which neither sshd nor an SSH client will accept for
 * ed25519, so the OpenSSH encodings are built here. They are small: a public key is two
 * length-prefixed strings, and an unencrypted private key is those fields wrapped in the
 * "openssh-key-v1" container with cipher and kdf set to "none".
 *
 * Core mints TWO keypairs per server (ADR-0002):
 *
 *  - the USER keypair, whose public half cloud-config authorizes and whose private half core
 *    authenticates with — and which the operator can download;
 *  - the HOST keypair, whose private half cloud-init installs so the box comes up already
 *    presenting a key core generated. That is what makes strict host-key verification possible
 *    on the very first connection, the one that carries the secrets file.
 */

export interface SshKeyPair {
  /** OpenSSH private key file contents ("-----BEGIN OPENSSH PRIVATE KEY-----"). */
  privateKey: string
  /** authorized_keys / *.pub line: "ssh-ed25519 <base64> <comment>". */
  publicKey: string
  /** "SHA256:..." over the public key blob — the value `ssh-keygen -lf` prints. */
  fingerprint: string
}

const KEY_TYPE = 'ssh-ed25519'

function u32(n: number): Buffer {
  const b = Buffer.allocUnsafe(4)
  b.writeUInt32BE(n, 0)
  return b
}

/** SSH "string": a big-endian uint32 length followed by that many bytes. */
function sshString(value: Buffer | string): Buffer {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  return Buffer.concat([u32(buf.length), buf])
}

/** The public key blob: what gets base64'd into a .pub line and hashed for a fingerprint. */
function publicKeyBlob(pub: Buffer): Buffer {
  return Buffer.concat([sshString(KEY_TYPE), sshString(pub)])
}

function encodePublicKey(pub: Buffer, comment: string): string {
  return `${KEY_TYPE} ${publicKeyBlob(pub).toString('base64')} ${comment}`
}

/**
 * openssh-key-v1, unencrypted. The private section is padded to the cipher block size — 8 for
 * cipher "none" — with the bytes 1,2,3,… sshd rejects the key if that padding is wrong, which
 * is the one detail worth getting exactly right here.
 */
function encodePrivateKey(seed: Buffer, pub: Buffer, comment: string): string {
  const check = createHash('sha256').update(pub).digest().subarray(0, 4)
  const priv = Buffer.concat([
    check,
    check,
    sshString(KEY_TYPE),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])), // ed25519 private half is seed || public
    sshString(comment),
  ])
  const padLen = (8 - (priv.length % 8)) % 8
  const padded = Buffer.concat([priv, Buffer.from(Array.from({ length: padLen }, (_, i) => i + 1))])

  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'utf8'),
    sshString('none'), // cipher
    sshString('none'), // kdf
    sshString(''), // kdf options
    u32(1), // key count
    sshString(publicKeyBlob(pub)),
    sshString(padded),
  ])

  const b64 = body.toString('base64').replace(/(.{70})/g, '$1\n')
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`
}

/** `SHA256:...` over a raw public key blob — the form a host presents during a handshake. */
export function fingerprintFromBlob(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

/** Fingerprint an authorized_keys-style line, for comparing against what a host presents. */
export function fingerprintPublicKey(publicKeyLine: string): string {
  const b64 = publicKeyLine.trim().split(/\s+/)[1]
  if (!b64) throw new Error('not an OpenSSH public key line')
  return fingerprintFromBlob(Buffer.from(b64, 'base64'))
}

export function generateSshKeyPair(comment: string): SshKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')

  // JWK is the only export format that hands over the raw 32-byte halves without DER slicing:
  // d is the seed, x is the public key, both base64url.
  const jwkPriv = privateKey.export({ format: 'jwk' }) as { d?: string }
  const jwkPub = publicKey.export({ format: 'jwk' }) as { x?: string }
  if (!jwkPriv.d || !jwkPub.x) throw new Error('ed25519 JWK export did not contain d/x')

  const seed = Buffer.from(jwkPriv.d, 'base64url')
  const pub = Buffer.from(jwkPub.x, 'base64url')

  return {
    privateKey: encodePrivateKey(seed, pub, comment),
    publicKey: encodePublicKey(pub, comment),
    fingerprint: fingerprintFromBlob(publicKeyBlob(pub)),
  }
}

export interface ServerKeys {
  user: SshKeyPair
  host: SshKeyPair
}

/** One call per server: the key core logs in with, and the key the box must prove it holds. */
export function generateServerKeys(serverId: string): ServerKeys {
  return {
    user: generateSshKeyPair(`rockysurf-core@${serverId}`),
    host: generateSshKeyPair(`rockysurf-host@${serverId}`),
  }
}

/**
 * Host-key verification, as a decision rather than a transport.
 *
 * PINNING IS MANDATORY (ADR-0002, bead 55fx.2): every SSH connection verifies the key the box
 * presents against the one core minted, and there is deliberately no trust-on-first-use path
 * and no "skip verification" option — the first connection is the one carrying the secrets
 * file. The SSH client that will call this lands with the connection work; keeping the
 * decision here means it is unit-testable against a wrong key without opening a socket, and
 * that there is exactly one implementation of "is this the right host".
 */
export function makeHostKeyVerifier(expectedFingerprint: string): (presentedKeyBlob: Buffer) => boolean {
  if (!expectedFingerprint.startsWith('SHA256:')) {
    throw new Error(`expected a SHA256: fingerprint to pin, got "${expectedFingerprint.slice(0, 12)}…"`)
  }
  return (presentedKeyBlob: Buffer) => fingerprintFromBlob(presentedKeyBlob) === expectedFingerprint
}
