import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  fingerprintFromBlob,
  fingerprintPublicKey,
  generateServerKeys,
  generateSshKeyPair,
  makeHostKeyVerifier,
} from './keys.js'

function hasSshKeygen(): boolean {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' })
    return true
  } catch (err) {
    // `ssh-keygen -?` exits non-zero while printing usage, which is still proof it exists.
    return (err as { code?: string }).code !== 'ENOENT'
  }
}

describe('OpenSSH encoding', () => {
  it('produces the documented shapes', () => {
    const k = generateSshKeyPair('test@core')
    expect(k.privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n')).toBe(true)
    expect(k.privateKey.trimEnd().endsWith('-----END OPENSSH PRIVATE KEY-----')).toBe(true)
    expect(k.publicKey.startsWith('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5')).toBe(true)
    expect(k.publicKey.endsWith(' test@core')).toBe(true)
    expect(k.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
  })

  it('derives a fingerprint from the public line alone', () => {
    const k = generateSshKeyPair('test@core')
    expect(fingerprintPublicKey(k.publicKey)).toBe(k.fingerprint)
    expect(() => fingerprintPublicKey('not-a-key')).toThrow(/not an OpenSSH public key/)
  })

  it('gives every server four distinct keys', () => {
    const a = generateServerKeys('srv-aaa')
    const b = generateServerKeys('srv-bbb')
    const fingerprints = [a.user.fingerprint, a.host.fingerprint, b.user.fingerprint, b.host.fingerprint]
    expect(new Set(fingerprints).size).toBe(4)
    expect(a.user.publicKey).toContain('rockysurf-core@srv-aaa')
    expect(a.host.publicKey).toContain('rockysurf-host@srv-aaa')
  })
})

/**
 * The property this port exists to preserve: what we generate is what OpenSSH generates.
 *
 * Checked against the real binary rather than a golden file, because a golden file only proves
 * we still agree with our past selves. If `ssh-keygen` is genuinely unavailable the suite says
 * so loudly rather than passing quietly — a silent skip here would hide the one regression
 * this file is for.
 */
describe('agreement with ssh-keygen', () => {
  const available = hasSshKeygen()

  it('has ssh-keygen available to check against', () => {
    expect(
      available,
      'ssh-keygen not found: this check cannot run, and the OpenSSH-compatibility property is UNVERIFIED on this machine',
    ).toBe(true)
  })

  it.runIf(available)('agrees on the fingerprint and on the public key derived from the private half', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rockysurf-keys-'))
    try {
      for (const comment of ['rockysurf-core@srv-abc', 'rockysurf-host@srv-abc']) {
        const k = generateSshKeyPair(comment)
        const path = join(dir, 'id_ed25519')
        writeFileSync(path, k.privateKey)
        chmodSync(path, 0o600)

        // ssh-keygen reads our private key, and must agree about what it contains.
        const listed = execFileSync('ssh-keygen', ['-lf', path], { encoding: 'utf8' }).trim()
        expect(listed).toContain(k.fingerprint)
        expect(listed).toContain('(ED25519)')
        expect(listed).toContain(comment)

        // And the public key it derives must be byte-identical to the one we emitted. Compare
        // type and blob: ssh-keygen also echoes the comment it found, and how it spaces that
        // is not the property under test.
        const fields = (line: string) => line.trim().split(/\s+/).slice(0, 2).join(' ')
        const derived = execFileSync('ssh-keygen', ['-y', '-f', path], { encoding: 'utf8' })
        expect(fields(derived)).toBe(fields(k.publicKey))

        rmSync(path)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('host-key pinning', () => {
  /** The blob a host presents during a handshake: the raw public key, not the .pub line. */
  const blobOf = (publicKeyLine: string) => Buffer.from(publicKeyLine.split(/\s+/)[1]!, 'base64')

  it('accepts the pinned key and refuses any other', () => {
    const box = generateSshKeyPair('rockysurf-host@srv-abc')
    const impostor = generateSshKeyPair('rockysurf-host@srv-evil')
    const verify = makeHostKeyVerifier(box.fingerprint)

    expect(verify(blobOf(box.publicKey))).toBe(true)
    expect(verify(blobOf(impostor.publicKey))).toBe(false)
  })

  it('refuses a single flipped byte in the presented key', () => {
    const box = generateSshKeyPair('rockysurf-host@srv-abc')
    const verify = makeHostKeyVerifier(box.fingerprint)
    const blob = blobOf(box.publicKey)
    blob[10] = (blob[10] ?? 0) ^ 0x01
    expect(verify(blob)).toBe(false)
  })

  it('refuses to pin anything that is not a SHA256 fingerprint', () => {
    // An empty or legacy MD5 fingerprint must fail loudly at construction rather than
    // producing a verifier that says no to everything — or, worse, yes.
    expect(() => makeHostKeyVerifier('')).toThrow(/SHA256:/)
    expect(() => makeHostKeyVerifier('MD5:aa:bb:cc')).toThrow(/SHA256:/)
  })

  it('fingerprints a raw blob the same way it fingerprints a .pub line', () => {
    const k = generateSshKeyPair('test@core')
    expect(fingerprintFromBlob(blobOf(k.publicKey))).toBe(k.fingerprint)
  })
})
