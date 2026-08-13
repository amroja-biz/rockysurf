import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * Password hashing for the single-admin local mode. `node:crypto` only — no new dependency
 * for one password.
 *
 * scrypt with the parameters below costs ~16MB and tens of milliseconds per attempt, which is
 * the point: it makes an offline attack on a leaked `settings` row expensive, and it makes an
 * online guessing loop slow enough to be obvious.
 */

const N = 16_384
const R = 8
const P = 1
const KEY_LENGTH = 32
const SALT_LENGTH = 16
const PREFIX = 'scrypt'

/** `scrypt$N$r$p$salt$hash`, all base64. Self-describing so parameters can change later. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH)
  const hash = scryptSync(password.normalize('NFKC'), salt, KEY_LENGTH, { N, r: R, p: P })
  return [PREFIX, N, R, P, salt.toString('base64'), hash.toString('base64')].join('$')
}

/**
 * Constant-time verification.
 *
 * Every failure path costs the same scrypt work as a success: a malformed or absent stored
 * hash still runs a derivation against a dummy salt before returning false, so "no admin
 * password is set yet" and "wrong password" are not distinguishable by timing.
 */
export function verifyPassword(password: string, stored: string | undefined): boolean {
  const parsed = parse(stored)
  const normalized = password.normalize('NFKC')

  if (!parsed) {
    // Burn equivalent work so the absent-hash path is not measurably faster.
    scryptSync(normalized, randomBytes(SALT_LENGTH), KEY_LENGTH, { N, r: R, p: P })
    return false
  }

  const candidate = scryptSync(normalized, parsed.salt, parsed.hash.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
  })
  return timingSafeEqual(candidate, parsed.hash)
}

interface ParsedHash {
  n: number
  r: number
  p: number
  salt: Buffer
  hash: Buffer
}

function parse(stored: string | undefined): ParsedHash | undefined {
  if (!stored) return undefined
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== PREFIX) return undefined
  const [, n, r, p, salt, hash] = parts
  if (n === undefined || r === undefined || p === undefined || salt === undefined || hash === undefined) {
    return undefined
  }
  const parsed = {
    n: Number(n),
    r: Number(r),
    p: Number(p),
    salt: Buffer.from(salt, 'base64'),
    hash: Buffer.from(hash, 'base64'),
  }
  if (!Number.isInteger(parsed.n) || !Number.isInteger(parsed.r) || !Number.isInteger(parsed.p)) return undefined
  if (parsed.salt.length === 0 || parsed.hash.length === 0) return undefined
  return parsed
}

/**
 * A generated admin password: 20 characters from an unambiguous alphabet.
 *
 * No `0/O`, `1/l/I` — this string gets read off a terminal and typed into a browser, and a
 * password someone mistypes twice is a password they paste into a text file.
 */
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generatePassword(length = 20): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length]
  return out
}
