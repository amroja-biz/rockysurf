import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Db } from '../client.js'
import { servers, type ServerRow } from '../schema.js'

/**
 * Callback-mode credentials: minting, verification, and the budget.
 *
 * TWO TOKENS, TWO LIFETIMES (ADR-0002 Decision 5, amendments E8/E9). The plan token ships in
 * user-data, which every process on the box can read from the instance metadata service for
 * the life of the server, so its exposure window has to be short. The status token
 * authenticates per-step progress POSTs and therefore cannot be single-use. Collapse them and
 * single-use loses: a metadata-readable credential stays valid forever.
 *
 * WHY A BUDGET AND NOT STRICT SINGLE-USE (finding #40). Strict single-use and at-least-once
 * delivery do not compose. Core spends the token, the response is lost in transit, the box
 * retries, gets 410, and is bricked: no plan, no way to ask for another. One dropped packet,
 * one dead server. A small budget inside a short window shrinks the exposure just as
 * effectively and cannot brick a box.
 *
 * Only hashes are stored, the way session cookies are handled — a database dump does not hand
 * over working credentials.
 */

/**
 * Fifteen minutes. Long enough for a slow cloud-init on a cold image plus a retry or two;
 * short enough that a token scraped from metadata an hour later is already dead. cloud-init
 * on both clouds reached the fetch inside a minute during the spike, so this is roughly an
 * order of magnitude of headroom rather than a guess.
 */
export const PLAN_TOKEN_TTL_MS = 15 * 60 * 1000

/**
 * Four uses. The box legitimately spends two — one for the plan, one for the secrets — and
 * the remaining two are the retry budget that keeps a lost response from bricking the box.
 * Anything above the first use is recorded as a leak signal regardless.
 */
export const PLAN_TOKEN_USE_BUDGET = 4

const TOKEN_BYTES = 32

const hash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')

/**
 * Constant-time comparison.
 *
 * Both sides are hashed to a fixed 32 bytes first, so `timingSafeEqual` never throws on a
 * length mismatch and the comparison cannot leak the token's length either.
 */
export function tokenMatches(presented: string, storedHash: string | null | undefined): boolean {
  if (!storedHash) return false
  const presentedDigest = createHash('sha256').update(presented, 'utf8').digest()
  const storedDigest = Buffer.from(storedHash, 'hex')
  // The length guard reads the STORED hash, which is ours and always 32 bytes — it can only
  // fail on a corrupt row, never on attacker-controlled input, so it leaks nothing about the
  // presented token. The comparison itself is constant-time over fixed-width digests.
  if (storedDigest.length !== presentedDigest.length) return false
  return timingSafeEqual(presentedDigest, storedDigest)
}

export interface MintedCallbackTokens {
  /** Returned ONCE. Only the hash is persisted. */
  planToken: string
  callbackToken: string
  planTokenExpiresAt: string
}

/**
 * Mint both tokens for a server and store their hashes.
 *
 * SEAM: the create path in the lifecycle service calls this once it knows the server is going
 * to bootstrap in callback mode. It is safe to call again — a re-mint rotates both tokens and
 * resets the budget, which is what a re-push of a callback-mode box needs.
 */
export function mintCallbackTokens(db: Db, serverId: string, now: Date = new Date()): MintedCallbackTokens {
  const planToken = randomBytes(TOKEN_BYTES).toString('base64url')
  const callbackToken = randomBytes(TOKEN_BYTES).toString('base64url')
  const planTokenExpiresAt = new Date(now.getTime() + PLAN_TOKEN_TTL_MS).toISOString()

  const [updated] = db
    .update(servers)
    .set({
      planTokenHash: hash(planToken),
      callbackTokenHash: hash(callbackToken),
      planTokenExpiresAt,
      planTokenUses: 0,
      planTokenReplayedAt: null,
      updatedAt: now.toISOString(),
    })
    .where(eq(servers.id, serverId))
    .returning()
    .all()
  if (!updated) throw new Error(`mintCallbackTokens wrote no row for ${serverId}`)

  return { planToken, callbackToken, planTokenExpiresAt }
}

/** Verify a status-report token. Recurring by design: no budget, no expiry, no side effects. */
export function verifyCallbackToken(server: ServerRow, presented: string): boolean {
  return tokenMatches(presented, server.callbackTokenHash)
}

export type PlanTokenOutcome =
  | { ok: true; uses: number; replay: boolean }
  | { ok: false; reason: 'invalid' | 'expired' | 'exhausted' }

/**
 * Spend one use of the plan token.
 *
 * A valid token beyond its first use is still honoured — that is the budget doing its job —
 * but the replay is stamped on the row, because it is the only evidence core will ever get
 * that the credential leaked.
 */
export function consumePlanToken(
  db: Db,
  server: ServerRow,
  presented: string,
  now: Date = new Date(),
): PlanTokenOutcome {
  if (!tokenMatches(presented, server.planTokenHash)) return { ok: false, reason: 'invalid' }

  if (!server.planTokenExpiresAt || new Date(server.planTokenExpiresAt).getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' }
  }

  const uses = server.planTokenUses + 1
  if (uses > PLAN_TOKEN_USE_BUDGET) {
    // Record the attempt even though it is refused: an exhausted-budget hit is the loudest
    // leak signal available, and losing it would defeat the point of counting.
    stampReplay(db, server, now)
    return { ok: false, reason: 'exhausted' }
  }

  const replay = uses > 1
  db.update(servers)
    .set({
      planTokenUses: uses,
      // Keep the FIRST replay rather than the latest: this marks when the leak began, and
      // overwriting it on every subsequent hit would smear exactly the fact worth knowing.
      ...(replay && !server.planTokenReplayedAt ? { planTokenReplayedAt: now.toISOString() } : {}),
      updatedAt: now.toISOString(),
    })
    .where(eq(servers.id, server.id))
    .run()

  return { ok: true, uses, replay }
}

function stampReplay(db: Db, server: ServerRow, now: Date): void {
  if (server.planTokenReplayedAt) return
  db.update(servers)
    .set({ planTokenReplayedAt: now.toISOString(), updatedAt: now.toISOString() })
    .where(eq(servers.id, server.id))
    .run()
}

/**
 * Retire the plan token once bootstrap is over.
 *
 * The acceptance criterion is that the secrets endpoint stops serving after provisioning
 * completes: expiring the credential is how, rather than a status check bolted onto each
 * route, so there is one rule and one place it lives.
 */
export function retirePlanToken(db: Db, serverId: string, now: Date = new Date()): void {
  db.update(servers)
    .set({ planTokenHash: null, planTokenExpiresAt: null, updatedAt: now.toISOString() })
    .where(eq(servers.id, serverId))
    .run()
}
