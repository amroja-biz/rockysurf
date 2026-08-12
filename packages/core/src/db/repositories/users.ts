import { and, eq, gt } from 'drizzle-orm'
import type { Db } from '../client.js'
import { newEventId, newSessionId, newUserId } from '../ids.js'
import { events, sessions, users, type EventRow, type Session, type User } from '../schema.js'

const nowIso = () => new Date().toISOString()

/* ------------------------------------------------------------------ users */

export interface UpsertUserInput {
  githubId: string
  githubUsername: string
  email?: string
  avatarUrl?: string
  isAdmin?: boolean
}

/**
 * Find-or-create by GitHub id, refreshing the mutable profile fields.
 *
 * Keyed on `githubId`, never on the username: GitHub usernames can be changed and reused, and
 * matching on one would hand a renamed account's servers to whoever claimed the name next.
 */
export function upsertUserByGithubId(db: Db, input: UpsertUserInput): User {
  const now = nowIso()
  const existing = db.select().from(users).where(eq(users.githubId, input.githubId)).get()

  if (existing) {
    const [updated] = db
      .update(users)
      .set({
        githubUsername: input.githubUsername,
        email: input.email ?? existing.email,
        avatarUrl: input.avatarUrl ?? existing.avatarUrl,
        updatedAt: now,
      })
      .where(eq(users.id, existing.id))
      .returning()
      .all()
    if (!updated) throw new Error(`upsertUserByGithubId wrote no row for ${existing.id}`)
    return updated
  }

  const [inserted] = db
    .insert(users)
    .values({
      id: newUserId(),
      githubId: input.githubId,
      githubUsername: input.githubUsername,
      email: input.email ?? null,
      avatarUrl: input.avatarUrl ?? null,
      isAdmin: input.isAdmin ?? false,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .all()
  if (!inserted) throw new Error('upsertUserByGithubId returned no row')
  return inserted
}

export function getUser(db: Db, id: string): User | undefined {
  return db.select().from(users).where(eq(users.id, id)).get()
}

export function getUserByGithubUsername(db: Db, githubUsername: string): User | undefined {
  return db.select().from(users).where(eq(users.githubUsername, githubUsername)).get()
}

/* ------------------------------------------------------------------ sessions */

/**
 * Create a session from the HASH of the cookie value.
 *
 * Callers hash before calling; the raw cookie never reaches this layer and is never stored,
 * so a database leak does not hand over live sessions.
 */
export function createSession(db: Db, input: { userId: string; tokenHash: string; expiresAt: string }): Session {
  const now = nowIso()
  const [inserted] = db
    .insert(sessions)
    .values({
      id: newSessionId(),
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      createdAt: now,
      lastSeenAt: now,
    })
    .returning()
    .all()
  if (!inserted) throw new Error('createSession returned no row')
  return inserted
}

/** Look up a live session. Expired rows are treated as absent. */
export function getLiveSessionByTokenHash(db: Db, tokenHash: string): Session | undefined {
  return db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, nowIso())))
    .get()
}

export function touchSession(db: Db, id: string): void {
  db.update(sessions).set({ lastSeenAt: nowIso() }).where(eq(sessions.id, id)).run()
}

export function deleteSession(db: Db, id: string): void {
  db.delete(sessions).where(eq(sessions.id, id)).run()
}

/** Housekeeping: drop everything already expired. Safe to call on a timer. */
export function deleteExpiredSessions(db: Db): number {
  return db.delete(sessions).where(gt(nowIso() as never, sessions.expiresAt as never)).run().changes
}

/* ------------------------------------------------------------------ events */

export interface AppendEventInput {
  type: string
  serverId?: string
  userId?: string
  runId?: string
  payload?: unknown
}

/**
 * Append to the audit log.
 *
 * Append-only by construction — there is no update or delete here. ADR-0002 requires that
 * reports from a SUPERSEDED bootstrap run are still recorded even though they must not move
 * the server row, and `runId` is what lets a reader tell those apart afterwards.
 */
export function appendEvent(db: Db, input: AppendEventInput): EventRow {
  const [inserted] = db
    .insert(events)
    .values({
      id: newEventId(),
      type: input.type,
      serverId: input.serverId ?? null,
      userId: input.userId ?? null,
      runId: input.runId ?? null,
      payload: input.payload === undefined ? null : JSON.stringify(input.payload),
      createdAt: nowIso(),
    })
    .returning()
    .all()
  if (!inserted) throw new Error('appendEvent returned no row')
  return inserted
}

export function listEventsForServer(db: Db, serverId: string): EventRow[] {
  return db.select().from(events).where(eq(events.serverId, serverId)).all()
}
