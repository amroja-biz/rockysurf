import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureSelfSignedCert, selfSignedCertNames, selfSignedCertPaths } from './self-signed.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rockysurf-tls-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('selfSignedCertNames', () => {
  it('always includes localhost and both loopback addresses', () => {
    expect(selfSignedCertNames('127.0.0.1')).toEqual(expect.arrayContaining(['localhost', '127.0.0.1', '::1']))
  })

  it('prefers the publicUrl hostname when one is configured', () => {
    const names = selfSignedCertNames('0.0.0.0', 'https://rocky.example.com:8443')
    expect(names).toContain('rocky.example.com')
  })

  it('falls back to the bind host when it is a real, specific address', () => {
    const names = selfSignedCertNames('192.168.1.50')
    expect(names).toContain('192.168.1.50')
  })

  it('does not name every-interface addresses — nobody navigates a browser to 0.0.0.0', () => {
    expect(selfSignedCertNames('0.0.0.0')).not.toContain('0.0.0.0')
    expect(selfSignedCertNames('::')).not.toContain('::')
  })

  it('ignores an unparseable publicUrl rather than throwing', () => {
    expect(() => selfSignedCertNames('192.168.1.50', 'not a url')).not.toThrow()
  })
})

describe('ensureSelfSignedCert', () => {
  it('generates a certificate and private key under dataDir/tls', async () => {
    const credentials = await ensureSelfSignedCert(dir, '192.168.1.50')
    expect(credentials.key).toContain('PRIVATE KEY')
    expect(credentials.cert).toContain('CERTIFICATE')

    const { keyPath, certPath } = selfSignedCertPaths(dir)
    expect(readFileSync(keyPath, 'utf8')).toBe(credentials.key)
    expect(readFileSync(certPath, 'utf8')).toBe(credentials.cert)
  })

  it('the private key is written owner-only, the same mode a secret key gets elsewhere in this codebase', async () => {
    await ensureSelfSignedCert(dir, '192.168.1.50')
    const { keyPath } = selfSignedCertPaths(dir)
    const mode = statSync(keyPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('the generated certificate actually carries the names it was asked for', async () => {
    const credentials = await ensureSelfSignedCert(dir, '192.168.1.50', 'https://rocky.example.com')
    const cert = new X509Certificate(credentials.cert)
    expect(cert.subjectAltName).toContain('DNS:rocky.example.com')
    expect(cert.subjectAltName).toContain('DNS:localhost')
    expect(cert.subjectAltName).toContain('IP Address:127.0.0.1')
  })

  it('reuses the cached certificate on a second call instead of generating a new one', async () => {
    const first = await ensureSelfSignedCert(dir, '192.168.1.50')
    const second = await ensureSelfSignedCert(dir, '192.168.1.50')
    expect(second).toEqual(first)
  })

  it('reuses the cached certificate even if the bind host changes on a later boot', async () => {
    // Regenerating on every host change would mean widening `server.host` twice (once to add
    // a new address, once more later) invalidates a browser's trust exception each time. The
    // cache is deliberately keyed on dataDir alone, not on the host that requested it.
    const first = await ensureSelfSignedCert(dir, '192.168.1.50')
    const second = await ensureSelfSignedCert(dir, '10.0.0.9')
    expect(second).toEqual(first)
  })
})
