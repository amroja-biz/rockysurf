import { createHash, randomBytes } from 'node:crypto'
import type { Db } from '../db/client.js'
import {
  createSession,
  deleteSession,
  getLiveSessionByTokenHash,
  getUser,
  touchSession,
} from '../db/repositories/users.js'
import type { Session, User } from '../db/schema.js'

/**
 * Sessions: an opaque random token, with only its SHA-256 stored.
 *
 * DESIGN NOTE — why not a signed cookie. A signed cookie proves the server issued the value,
 * but proving that is not the question core needs answered; "is this session still valid" is,
 * and logout has to revoke. Answering revocation means a database lookup on every request,
 * and once there is a lookup the signature adds no information — the row's existence is the
 * proof. So there is no signing key to generate, persist, rotate, or leak. Amendment by
 * subtraction: the simplest thing that satisfies "logout revokes" also removes a secret.
 *
 * The token is random, never derived, and never stored: a database leak yields hashes, not
 * live sessions. The lookup is by hash, so it is a single indexed equality test.
 */

export const SESSION_COOKIE = 'rockysurf_session'

/** 30 days. Long enough that a self-hoster is not retyping a password weekly. */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 32 bytes of randomness, hex. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface IssuedSession {
  /** The value that goes in the cookie or the Authorization header. Shown once, never stored. */
  token: string
  session: Session
}

export function issueSession(db: Db, userId: string, ttlMs: number = DEFAULT_SESSION_TTL_MS): IssuedSession {
  const token = generateSessionToken()
  const expiresAt = new Date(Date.now() + ttlMs).toISOString()
  const session = createSession(db, { userId, tokenHash: hashToken(token), expiresAt })
  return { token, session }
}

export interface ResolvedSession {
  session: Session
  user: User
}

/**
 * Resolve a presented token to a live session and its user.
 *
 * Returns undefined for absent, expired, and unknown alike — the caller must not be able to
 * tell them apart, and neither should an attacker. Touches `lastSeenAt` so an idle-session
 * sweep has something to read.
 */
export function resolveSession(db: Db, token: string | undefined): ResolvedSession | undefined {
  if (!token) return undefined
  const session = getLiveSessionByTokenHash(db, hashToken(token))
  if (!session) return undefined
  const user = getUser(db, session.userId)
  if (!user) return undefined
  touchSession(db, session.id)
  return { session, user }
}

/** Revoke by presented token. Returns whether a live session was actually removed. */
export function revokeSession(db: Db, token: string | undefined): boolean {
  if (!token) return false
  const session = getLiveSessionByTokenHash(db, hashToken(token))
  if (!session) return false
  deleteSession(db, session.id)
  return true
}
