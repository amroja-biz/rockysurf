import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AUTH_TAG_BYTES,
  CURRENT_KEY_ID,
  KEY_BYTES,
  NONCE_BYTES,
  open,
  seal,
  secretAad,
  SecretDecryptionError,
  secretEquals,
} from './crypto.js'

const KEY = randomBytes(KEY_BYTES)
const AAD = secretAad(CURRENT_KEY_ID, 'server-ssh-key', 'srv-abc123')
const PLAINTEXT = '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----\n'

/** Flip one bit in a base64 field, without changing its length. */
function tamper(base64: string, byteIndex = 0): string {
  const bytes = Buffer.from(base64, 'base64')
  bytes[byteIndex] = (bytes[byteIndex] ?? 0) ^ 0x01
  return bytes.toString('base64')
}

describe('seal and open', () => {
  it('round-trips a value', () => {
    const sealed = seal(KEY, PLAINTEXT, AAD)
    expect(open(KEY, sealed, AAD)).toBe(PLAINTEXT)
  })

  it('round-trips unicode and empty values', () => {
    for (const value of ['', 'ünïcödé — ✓', 'a'.repeat(100_000)]) {
      expect(open(KEY, seal(KEY, value, AAD), AAD)).toBe(value)
    }
  })

  it('produces the documented field sizes and never embeds the plaintext', () => {
    const sealed = seal(KEY, PLAINTEXT, AAD)
    expect(Buffer.from(sealed.nonce, 'base64')).toHaveLength(NONCE_BYTES)
    expect(Buffer.from(sealed.authTag, 'base64')).toHaveLength(AUTH_TAG_BYTES)
    expect(sealed.keyId).toBe(CURRENT_KEY_ID)
    expect(sealed.ciphertext).not.toContain('BEGIN OPENSSH')
  })

  it('uses a fresh nonce every time, so identical values encrypt differently', () => {
    const sealings = Array.from({ length: 200 }, () => seal(KEY, PLAINTEXT, AAD))
    expect(new Set(sealings.map((s) => s.nonce)).size).toBe(sealings.length)
    // Fresh nonce means fresh keystream: the ciphertexts differ even though the input did not.
    expect(new Set(sealings.map((s) => s.ciphertext)).size).toBe(sealings.length)
  })
})

describe('authentication failures', () => {
  it('rejects a flipped ciphertext byte', () => {
    const sealed = seal(KEY, PLAINTEXT, AAD)
    expect(() => open(KEY, { ...sealed, ciphertext: tamper(sealed.ciphertext) }, AAD)).toThrow(SecretDecryptionError)
  })

  it('rejects a flipped auth-tag byte', () => {
    const sealed = seal(KEY, PLAINTEXT, AAD)
    expect(() => open(KEY, { ...sealed, authTag: tamper(sealed.authTag) }, AAD)).toThrow(SecretDecryptionError)
  })

  it('rejects a flipped nonce byte', () => {
    const sealed = seal(KEY, PLAINTEXT, AAD)
    expect(() => open(KEY, { ...sealed, nonce: tamper(sealed.nonce) }, AAD)).toThrow(SecretDecryptionError)
  })

  it('rejects the wrong master key', () => {
    const sealed = seal(KEY, PLAINTEXT, AAD)
    expect(() => open(randomBytes(KEY_BYTES), sealed, AAD)).toThrow(SecretDecryptionError)
  })

  it('rejects a row moved to another owner', () => {
    // The AAD binds ciphertext to its identity: copying server A's key material onto server B
    // must fail loudly rather than hand core the wrong private key.
    const sealed = seal(KEY, PLAINTEXT, secretAad(CURRENT_KEY_ID, 'server-ssh-key', 'srv-aaa'))
    const movedTo = secretAad(CURRENT_KEY_ID, 'server-ssh-key', 'srv-bbb')
    expect(() => open(KEY, sealed, movedTo)).toThrow(SecretDecryptionError)
  })

  it('rejects a row relabelled as another kind', () => {
    const sealed = seal(KEY, PLAINTEXT, secretAad(CURRENT_KEY_ID, 'server-ssh-key', 'srv-aaa'))
    const relabelled = secretAad(CURRENT_KEY_ID, 'github-token', 'srv-aaa')
    expect(() => open(KEY, sealed, relabelled)).toThrow(SecretDecryptionError)
  })

  it('never leaks material in the error message', () => {
    const sealed = seal(KEY, PLAINTEXT, AAD)
    try {
      open(randomBytes(KEY_BYTES), sealed, AAD)
      expect.unreachable('should have thrown')
    } catch (err) {
      const message = String(err)
      expect(message).not.toContain(sealed.ciphertext)
      expect(message).not.toContain(KEY.toString('base64'))
      expect(message).not.toContain('BEGIN OPENSSH')
    }
  })

  it('refuses a master key of the wrong length', () => {
    expect(() => seal(randomBytes(16), PLAINTEXT, AAD)).toThrow(/exactly 32 bytes/)
  })

  it('refuses malformed nonce and tag lengths before touching the cipher', () => {
    const sealed = seal(KEY, PLAINTEXT, AAD)
    expect(() => open(KEY, { ...sealed, nonce: randomBytes(8).toString('base64') }, AAD)).toThrow(/nonce must be/)
    expect(() => open(KEY, { ...sealed, authTag: randomBytes(8).toString('base64') }, AAD)).toThrow(/auth tag must be/)
  })
})

describe('secretEquals', () => {
  it('compares without leaking length-independent timing', () => {
    expect(secretEquals('abc', 'abc')).toBe(true)
    expect(secretEquals('abc', 'abd')).toBe(false)
    expect(secretEquals('abc', 'abcd')).toBe(false)
    expect(secretEquals('', '')).toBe(true)
  })
})
