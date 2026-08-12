import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { KEY_BYTES } from './crypto.js'

/**
 * Where the master key comes from, in priority order:
 *
 *  1. `ROCKYSURF_SECRET_KEY` — base64, exactly 32 bytes decoded. For containers and for
 *     anyone who keeps key material in their own secret manager.
 *  2. `<dataDir>/secret.key` — the same encoding, created on first boot.
 *
 * The environment wins so that a deployment can hold the key outside the data directory
 * entirely; nothing is written to disk in that case.
 */

export const SECRET_KEY_ENV = 'ROCKYSURF_SECRET_KEY'
export const SECRET_KEY_FILENAME = 'secret.key'

export type MasterKeyOrigin = 'env' | 'file' | 'generated'

export interface MasterKey {
  key: Buffer
  origin: MasterKeyOrigin
  /** Present for the file origins. Never the key itself. */
  path?: string
}

export interface LoadMasterKeyOptions {
  /** Config's resolved data directory. `<dataDir>/secret.key` is the fallback location. */
  dataDir: string
  env?: NodeJS.ProcessEnv
  /** Where the back-it-up warning goes. Defaults to stderr. */
  log?: (message: string) => void
}

export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MasterKeyError'
  }
}

export function secretKeyPath(dataDir: string): string {
  return join(dataDir, SECRET_KEY_FILENAME)
}

/**
 * Load the master key, generating one on first boot.
 *
 * REFUSES TO START on loose permissions. A key file readable by other users on the box is
 * not a warning-level problem: every secret in the database — SSH private keys, git tokens,
 * RDP passwords — is decryptable by anyone who can read it, and the database sits right next
 * to it. Better a failed boot with an actionable message than a quiet downgrade.
 */
export function loadMasterKey(options: LoadMasterKeyOptions): MasterKey {
  const env = options.env ?? process.env
  const log = options.log ?? ((message: string) => console.warn(message))

  const fromEnv = env[SECRET_KEY_ENV]
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return { key: decodeKey(fromEnv.trim(), `${SECRET_KEY_ENV} environment variable`), origin: 'env' }
  }

  const path = secretKeyPath(options.dataDir)
  const existing = readKeyFile(path)
  if (existing) return { key: existing, origin: 'file', path }

  return { key: generateKeyFile(path, log), origin: 'generated', path }
}

function decodeKey(encoded: string, source: string): Buffer {
  // Buffer.from(_, 'base64') never throws — it silently drops characters outside the
  // alphabet — so malformed input shows up here as a wrong length, which is the check that
  // actually matters and the one message worth writing well.
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== KEY_BYTES) {
    // The length is safe to report; the value is not, and is never included.
    throw new MasterKeyError(
      `${source} must decode to exactly ${KEY_BYTES} bytes, got ${key.length}. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(${KEY_BYTES}).toString('base64'))"`,
    )
  }
  return key
}

function readKeyFile(path: string): Buffer | undefined {
  let stats
  try {
    stats = statSync(path)
  } catch {
    return undefined // first boot
  }

  if (!stats.isFile()) throw new MasterKeyError(`${path} exists but is not a file`)
  assertPrivateMode(path, stats.mode)

  return decodeKey(readFileSync(path, 'utf8').trim(), path)
}

/**
 * The key file must not be readable or writable by group or other.
 *
 * Skipped on Windows, where the POSIX mode bits reported by Node do not describe the real
 * ACL and checking them would fail honest installs while proving nothing.
 */
export function assertPrivateMode(path: string, mode: number, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') return
  const loose = mode & 0o077
  if (loose !== 0) {
    throw new MasterKeyError(
      `${path} has permissions ${(mode & 0o777).toString(8).padStart(3, '0')}; it must not be readable by ` +
        `group or other. Every secret in the database is decryptable with this file. Fix it with: chmod 600 ${path}`,
    )
  }
}

function generateKeyFile(path: string, log: (message: string) => void): Buffer {
  const key = randomBytes(KEY_BYTES)
  mkdirSync(dirname(path), { recursive: true })

  // 'wx' fails if the file appeared between the stat above and now, so a race cannot clobber
  // an existing key — which would render every stored secret permanently undecryptable.
  writeFileSync(path, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' })
  // writeFileSync's mode is masked by the process umask, so set it explicitly afterwards
  // rather than trusting the default.
  chmodSync(path, 0o600)

  log(
    [
      '',
      '  ┌─────────────────────────────────────────────────────────────────────────┐',
      '  │  A NEW ENCRYPTION KEY WAS GENERATED — BACK IT UP NOW                    │',
      '  └─────────────────────────────────────────────────────────────────────────┘',
      `  Location: ${path}`,
      '',
      '  Every secret Rocky Surf stores is encrypted with this key: SSH private keys for',
      '  your servers, git tokens, remote-desktop passwords, provider credentials.',
      '',
      '  If you lose this file, those secrets are unrecoverable — you will have to recreate',
      '  every server. If someone else obtains it, they can decrypt all of them.',
      '',
      `  Back it up somewhere safe, or set ${SECRET_KEY_ENV} instead and keep the key in your`,
      '  own secret manager.',
      '',
    ].join('\n'),
  )

  return key
}
