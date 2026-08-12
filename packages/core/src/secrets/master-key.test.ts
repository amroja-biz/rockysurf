import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KEY_BYTES } from './crypto.js'
import { assertPrivateMode, loadMasterKey, MasterKeyError, SECRET_KEY_ENV, secretKeyPath } from './master-key.js'

let dataDir: string
const logged: string[] = []
const log = (message: string) => logged.push(message)

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rockysurf-secrets-'))
  logged.length = 0
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('environment key', () => {
  it('is used when set, and nothing is written to disk', () => {
    const key = randomBytes(KEY_BYTES)
    const loaded = loadMasterKey({ dataDir, env: { [SECRET_KEY_ENV]: key.toString('base64') }, log })

    expect(loaded.origin).toBe('env')
    expect(loaded.key.equals(key)).toBe(true)
    expect(() => statSync(secretKeyPath(dataDir))).toThrow()
    expect(logged).toHaveLength(0)
  })

  it('wins over an existing key file', () => {
    const fileKey = randomBytes(KEY_BYTES)
    writeFileSync(secretKeyPath(dataDir), fileKey.toString('base64'), { mode: 0o600 })
    const envKey = randomBytes(KEY_BYTES)

    const loaded = loadMasterKey({ dataDir, env: { [SECRET_KEY_ENV]: envKey.toString('base64') }, log })
    expect(loaded.key.equals(envKey)).toBe(true)
  })

  it('is ignored when blank, falling through to the file path', () => {
    const loaded = loadMasterKey({ dataDir, env: { [SECRET_KEY_ENV]: '   ' }, log })
    expect(loaded.origin).toBe('generated')
  })

  it('refuses a key that is not 32 bytes, without echoing it', () => {
    const short = randomBytes(16).toString('base64')
    try {
      loadMasterKey({ dataDir, env: { [SECRET_KEY_ENV]: short }, log })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(MasterKeyError)
      expect(String(err)).toContain('exactly 32 bytes')
      expect(String(err)).not.toContain(short)
    }
  })

  it('refuses non-base64 junk (which decodes to the wrong length)', () => {
    expect(() => loadMasterKey({ dataDir, env: { [SECRET_KEY_ENV]: 'not a key!!!' }, log })).toThrow(MasterKeyError)
  })
})

describe('first boot', () => {
  it('generates a 32-byte key at 0600 and shouts about backing it up', () => {
    const loaded = loadMasterKey({ dataDir, env: {}, log })

    expect(loaded.origin).toBe('generated')
    expect(loaded.key).toHaveLength(KEY_BYTES)
    expect(loaded.path).toBe(secretKeyPath(dataDir))

    const mode = statSync(secretKeyPath(dataDir)).mode & 0o777
    expect(mode).toBe(0o600)

    const warning = logged.join('\n')
    expect(warning).toMatch(/BACK IT UP/i)
    expect(warning).toContain(secretKeyPath(dataDir))
    // The warning must never contain the key it is warning about.
    expect(warning).not.toContain(loaded.key.toString('base64'))
  })

  it('reloads the same key on the next boot without warning again', () => {
    const first = loadMasterKey({ dataDir, env: {}, log })
    logged.length = 0

    const second = loadMasterKey({ dataDir, env: {}, log })
    expect(second.origin).toBe('file')
    expect(second.key.equals(first.key)).toBe(true)
    expect(logged).toHaveLength(0)
  })

  it('writes the key base64-encoded and nothing else', () => {
    const loaded = loadMasterKey({ dataDir, env: {}, log })
    expect(readFileSync(secretKeyPath(dataDir), 'utf8').trim()).toBe(loaded.key.toString('base64'))
  })
})

describe('permissions', () => {
  it('refuses to start when the key file is readable by group or other', () => {
    const path = secretKeyPath(dataDir)
    writeFileSync(path, randomBytes(KEY_BYTES).toString('base64'), { mode: 0o600 })

    for (const loose of [0o640, 0o604, 0o644, 0o666, 0o777]) {
      chmodSync(path, loose)
      expect(() => loadMasterKey({ dataDir, env: {}, log })).toThrow(MasterKeyError)
      expect(() => loadMasterKey({ dataDir, env: {}, log })).toThrow(/chmod 600/)
    }

    chmodSync(path, 0o600)
    expect(loadMasterKey({ dataDir, env: {}, log }).origin).toBe('file')
  })

  it('accepts owner-only modes', () => {
    for (const ok of [0o600, 0o400, 0o700]) {
      expect(() => assertPrivateMode('/tmp/example', ok, 'linux')).not.toThrow()
    }
  })

  it('skips the check on Windows, where the mode bits do not describe the ACL', () => {
    expect(() => assertPrivateMode('C:\\example', 0o666, 'win32')).not.toThrow()
    expect(() => assertPrivateMode('/tmp/example', 0o666, 'linux')).toThrow(MasterKeyError)
  })

  it('rejects a directory where the key file should be', () => {
    mkdirSync(secretKeyPath(dataDir))
    expect(() => loadMasterKey({ dataDir, env: {}, log })).toThrow(/not a file/)
  })
})
