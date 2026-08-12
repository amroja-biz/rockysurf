import { and, desc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../client.js'
import { buildIdempotencyKey, newServerId } from '../ids.js'
import {
  servers,
  type Architecture,
  type BootstrapMode,
  type ProvisioningStep,
  type ServerRow,
  type ServerSize,
  type ServerStatus,
} from '../schema.js'
import {
  acceptsProgressReports,
  assertTransition,
  assertValidProvisioningStep,
  resolveIpChange,
  statusForStep,
} from '../transitions.js'

/**
 * Typed data access for servers. Thin on purpose: these functions own the RULES (transitions,
 * timestamps, uptime accrual) and nothing else. Business logic lives above them.
 */

const nowIso = () => new Date().toISOString()

export interface CreateServerInput {
  userId: string
  name: string
  provider: string
  size: ServerSize
  offeringId: string
  arch: Architecture
  region?: string
  packId?: string
  tools?: string[]
  repositories?: string[]
  bootstrapMode?: BootstrapMode
  sshUser?: string
  hourlyCost?: { amount: number; currency: string; fetchedAt: string } | null
  /** Test seam. Production always mints a fresh one. */
  id?: string
  idempotencyKey?: string
}

/**
 * Write the row FIRST, in `requested`, before the provider is called (ADR-0001).
 *
 * This is the inverted create ordering, and it is the whole reason `requested` exists. The old
 * `createServer.ts` provisioned first and wrote the row after, so a crash in between left a
 * running, billing instance that nothing in the database referenced — an orphan nobody could
 * find, let alone bill or terminate. Writing first means the worst case is a row with no
 * instance, which the startup recovery pass can resolve.
 *
 * The idempotency key is minted here and stored, so a retry of the same create attempt reads
 * the key off the row rather than recomputing one.
 */
export function insertServer(db: Db, input: CreateServerInput): ServerRow {
  const now = nowIso()
  const id = input.id ?? newServerId()
  const row = {
    id,
    userId: input.userId,
    name: input.name,
    provider: input.provider,
    size: input.size,
    offeringId: input.offeringId,
    arch: input.arch,
    region: input.region ?? null,
    status: 'requested' as const,
    provisioningStep: 'requested' as const,
    bootstrapMode: input.bootstrapMode ?? ('push' as const),
    sshUser: input.sshUser ?? 'rocky',
    packId: input.packId ?? null,
    tools: JSON.stringify(input.tools ?? []),
    repositories: JSON.stringify(input.repositories ?? []),
    idempotencyKey:
      input.idempotencyKey ??
      buildIdempotencyKey({
        userId: input.userId,
        name: input.name,
        provider: input.provider,
        offeringId: input.offeringId,
      }),
    hourlyCostAmount: input.hourlyCost?.amount ?? null,
    hourlyCostCurrency: input.hourlyCost?.currency ?? null,
    hourlyCostFetchedAt: input.hourlyCost?.fetchedAt ?? null,
    totalUptimeSeconds: 0,
    estimatedTotalCost: 0,
    createdAt: now,
    updatedAt: now,
  }

  const [inserted] = db.insert(servers).values(row).returning().all()
  if (!inserted) throw new Error('insertServer returned no row')
  return inserted
}

export function getServer(db: Db, id: string): ServerRow | undefined {
  return db.select().from(servers).where(eq(servers.id, id)).get()
}

export function getServerByIdempotencyKey(db: Db, key: string): ServerRow | undefined {
  return db.select().from(servers).where(eq(servers.idempotencyKey, key)).get()
}

export function listServersByUser(db: Db, userId: string): ServerRow[] {
  return db.select().from(servers).where(eq(servers.userId, userId)).orderBy(desc(servers.createdAt)).all()
}

export function listServersByStatus(db: Db, statuses: ServerStatus[]): ServerRow[] {
  return db.select().from(servers).where(inArray(servers.status, statuses)).all()
}

/**
 * Everything the startup recovery pass must look at (ADR-0001, decision 6): a server left in
 * `requested` or `provisioning` when the process died is either re-attached or failed cleanly.
 */
export function listServersNeedingRecovery(db: Db): ServerRow[] {
  return listServersByStatus(db, ['requested', 'provisioning'])
}

function requireServer(db: Db, id: string): ServerRow {
  const row = getServer(db, id)
  if (!row) throw new Error(`no such server: ${id}`)
  return row
}

/**
 * Move a server to a new status, enforcing the state machine.
 *
 * Timestamps are stamped here rather than by callers, because "when did this stop" is a
 * property of the transition and callers forget.
 *
 * THIS FUNCTION DOES NOT ACCRUE UPTIME, deliberately. `jobs/uptime-ticker.ts` is the single
 * writer of `totalUptimeSeconds` and `estimatedTotalCost`, accruing incrementally against a
 * persisted watermark. It used to accrue here as well, and two writers produced two bugs:
 *
 *  - **Double counting.** The ticker had already credited the time from the last tick, and
 *    this path then credited the whole span again from `startedAt`. Every stop inflated the
 *    total by roughly the server's entire lifetime.
 *  - **Off-time counted as uptime.** `startedAt` is stamped once, on the FIRST run, so across
 *    a stop → start → stop cycle the second accrual measured from the first `stoppedAt` and
 *    swept up the entire period the server was switched off — the opposite of what an uptime
 *    counter is for.
 *
 * The fix is one writer, not a smarter formula: a second path can always drift from the
 * first. The residual cost is bounded and stated plainly — the slice between the last tick
 * and the stop is never credited, so totals under-count by at most one tick interval per
 * stop, always in the user's favour. Exactness would need a per-row `uptimeAccruedThrough`
 * watermark that both paths respect, which is a schema change worth making only if that
 * bounded gap ever matters.
 */
export function updateServerStatus(
  db: Db,
  id: string,
  to: ServerStatus,
  options: { errorMessage?: string } = {},
): ServerRow {
  const current = requireServer(db, id)
  assertTransition(current.status, to)

  const now = nowIso()
  const patch: Partial<ServerRow> = { status: to, updatedAt: now }

  if (to === 'running' && !current.startedAt) patch.startedAt = now
  if (to === 'stopped') patch.stoppedAt = now
  if (to === 'terminated') patch.terminatedAt = now
  if (to === 'failed' && options.errorMessage) patch.errorMessage = options.errorMessage

  const [updated] = db.update(servers).set(patch).where(eq(servers.id, id)).returning().all()
  if (!updated) throw new Error(`updateServerStatus wrote no row for ${id}`)
  return updated
}

export interface ProgressReport {
  step: string
  publicIp?: string
  publicDns?: string
}

/**
 * Record a bootstrap progress report.
 *
 * Ported verbatim in RULES from `backend/src/servers/updateServerStatus.ts`:
 *
 *  1. the step must be one of the known steps, else reject;
 *  2. reports are accepted ONLY while the server is `provisioning` — a late or replayed
 *     report must not move a row that has already finished or been terminated;
 *  3. reaching `ready` flips the status to `running` and stamps `startedAt`; every other step
 *     only advances `provisioningStep`;
 *  4. an address that CHANGES records `previousIp` and `ipChangedAt`; an address set for the
 *     first time does not, because that is not a change and must not fire the user-facing
 *     "your IP moved" notification.
 *
 * Returns the updated row, or `undefined` when the report was ignored under rule 2 — ignoring
 * is not an error, and the caller records the report for forensics either way.
 */
export function recordProgress(db: Db, id: string, report: ProgressReport): ServerRow | undefined {
  assertValidProvisioningStep(report.step)
  const current = requireServer(db, id)
  if (!acceptsProgressReports(current.status)) return undefined

  const now = nowIso()
  const step: ProvisioningStep = report.step
  const patch: Partial<ServerRow> = { provisioningStep: step, updatedAt: now }

  const nextStatus = statusForStep(step)
  if (nextStatus) {
    assertTransition(current.status, nextStatus)
    patch.status = nextStatus
    if (!current.startedAt) patch.startedAt = now
  }

  const ipChange = resolveIpChange(current.publicIp, report.publicIp, now)
  if (ipChange) {
    patch.publicIp = ipChange.publicIp
    if (ipChange.previousIp !== undefined) patch.previousIp = ipChange.previousIp
    if (ipChange.ipChangedAt !== undefined) patch.ipChangedAt = ipChange.ipChangedAt
  }
  if (report.publicDns) patch.publicDns = report.publicDns

  const [updated] = db.update(servers).set(patch).where(eq(servers.id, id)).returning().all()
  return updated
}

/**
 * Attach the provider's opaque handle once `provision()` has returned.
 *
 * Stored as JSON text and never interpreted by core — that opacity is what keeps the row
 * provider-agnostic, and it is why the old `stackName`/`instanceId`/`keyPairName` columns are
 * gone rather than renamed.
 */
export function setProviderData(db: Db, id: string, data: Record<string, unknown>): ServerRow {
  const [updated] = db
    .update(servers)
    .set({ providerData: JSON.stringify(data), updatedAt: nowIso() })
    .where(eq(servers.id, id))
    .returning()
    .all()
  if (!updated) throw new Error(`setProviderData wrote no row for ${id}`)
  return updated
}

/** Parse the opaque handle back out. Returns undefined when unset or unparseable. */
export function getProviderData(row: ServerRow): Record<string, unknown> | undefined {
  if (!row.providerData) return undefined
  try {
    const parsed: unknown = JSON.parse(row.providerData)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export function setInstallPlan(db: Db, id: string, plan: unknown): ServerRow {
  const [updated] = db
    .update(servers)
    .set({ installPlan: JSON.stringify(plan), updatedAt: nowIso() })
    .where(eq(servers.id, id))
    .returning()
    .all()
  if (!updated) throw new Error(`setInstallPlan wrote no row for ${id}`)
  return updated
}

/** Record the SSH identity: the pinned host key and the secret holding core's private key. */
export function setKeyMaterial(
  db: Db,
  id: string,
  input: { hostKeyFingerprint?: string; hostPublicKey?: string; managedKeySecretId?: string },
): ServerRow {
  const patch: Partial<ServerRow> = { updatedAt: nowIso() }
  if (input.hostKeyFingerprint !== undefined) patch.hostKeyFingerprint = input.hostKeyFingerprint
  if (input.hostPublicKey !== undefined) patch.hostPublicKey = input.hostPublicKey
  if (input.managedKeySecretId !== undefined) patch.managedKeySecretId = input.managedKeySecretId

  const [updated] = db.update(servers).set(patch).where(eq(servers.id, id)).returning().all()
  if (!updated) throw new Error(`setKeyMaterial wrote no row for ${id}`)
  return updated
}

export interface NetworkAddressPatch {
  publicIp?: string
  publicDns?: string
  /** The provider's sshd port, when it is not 22 (ADR-0003, E13). Part of the address. */
  sshPort?: number
  /** Set together with `ipChangedAt` when the address MOVED, never on first assignment. */
  previousIp?: string
  ipChangedAt?: string
}

/**
 * Record the addresses a provider reported.
 *
 * A repository function rather than an inline update from the service layer, because
 * `src/db/index.ts` states the rule that nothing above this directory imports drizzle
 * directly — repositories are the seam that makes the eventual Postgres move a change here
 * instead of everywhere.
 */
export function setNetworkAddress(db: Db, id: string, patch: NetworkAddressPatch): ServerRow {
  const [updated] = db
    .update(servers)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(servers.id, id))
    .returning()
    .all()
  if (!updated) throw new Error(`setNetworkAddress wrote no row for ${id}`)
  return updated
}

/** JSON list accessors, so callers never parse these columns by hand. */
export function getServerTools(row: ServerRow): string[] {
  return parseStringArray(row.tools)
}

export function getServerRepositories(row: ServerRow): string[] {
  return parseStringArray(row.repositories)
}

function parseStringArray(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** Servers a user currently has that count against their concurrency limit. */
export function countActiveServersForUser(db: Db, userId: string): number {
  return db
    .select()
    .from(servers)
    .where(and(eq(servers.userId, userId), inArray(servers.status, ['requested', 'provisioning', 'running', 'stopped'])))
    .all().length
}
