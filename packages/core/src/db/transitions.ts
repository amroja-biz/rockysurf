import { PROVISIONING_STEPS, type ProvisioningStep, type ServerStatus } from './schema.js'

/**
 * The server state machine, ported rule for rule from the status-update handler of the
 * legacy Lambda backend this project replaced (see `docs/history/`).
 *
 * The old implementation encoded these rules as DynamoDB update expressions built inline in a
 * Lambda handler, so they were real but unstated and untestable. The verbatim-port promise
 * means the RULES carry over unchanged; only their form changes.
 */

/** Thrown for a transition the machine forbids. Callers turn this into a 409. */
export class InvalidTransitionError extends Error {
  override readonly name = 'InvalidTransitionError'
  constructor(
    readonly from: ServerStatus,
    readonly to: ServerStatus,
  ) {
    super(`illegal server status transition: ${from} → ${to}`)
  }
}

export class InvalidProvisioningStepError extends Error {
  override readonly name = 'InvalidProvisioningStepError'
  constructor(readonly step: string) {
    super(`invalid provisioning step: ${step}. Must be one of: ${PROVISIONING_STEPS.join(', ')}`)
  }
}

/**
 * Legal status transitions.
 *
 * `requested` is the new entry state (ADR-0001): the row is written before the provider is
 * called, so every server begins here. It exists so a crash mid-create leaves a findable row
 * instead of an orphan, and so the startup recovery pass has something to sweep.
 *
 * `terminated` is absorbing. `failed` may still go to `terminated` because cleaning up a
 * failed server is a legitimate action — the reverse is not: a terminated server cannot fail.
 */
export const SERVER_STATUS_TRANSITIONS: Readonly<Record<ServerStatus, readonly ServerStatus[]>> = {
  requested: ['provisioning', 'failed', 'terminated'],
  provisioning: ['running', 'failed', 'terminated'],
  running: ['stopped', 'terminated', 'failed'],
  stopped: ['running', 'terminated', 'failed'],
  failed: ['terminated'],
  terminated: [],
}

export function canTransition(from: ServerStatus, to: ServerStatus): boolean {
  return SERVER_STATUS_TRANSITIONS[from].includes(to)
}

export function assertTransition(from: ServerStatus, to: ServerStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to)
}

/** No further transitions are possible. */
export function isTerminalStatus(status: ServerStatus): boolean {
  return SERVER_STATUS_TRANSITIONS[status].length === 0
}

export function isValidProvisioningStep(step: string): step is ProvisioningStep {
  return (PROVISIONING_STEPS as readonly string[]).includes(step)
}

export function assertValidProvisioningStep(step: string): asserts step is ProvisioningStep {
  if (!isValidProvisioningStep(step)) throw new InvalidProvisioningStepError(step)
}

/**
 * Ported rule: progress reports are accepted ONLY while the server is provisioning.
 *
 * The original said `if (server.status !== 'provisioning') return badRequest(...)`. It matters
 * for more than tidiness — without it, a late or replayed report from a superseded bootstrap
 * run can move a row that has already finished, stopped, or been terminated.
 */
export function acceptsProgressReports(status: ServerStatus): boolean {
  return status === 'provisioning'
}

/**
 * Ported rule: reaching `ready` is what flips the server to `running` and stamps `startedAt`.
 * Every other step only advances `provisioningStep`.
 */
export function statusForStep(step: ProvisioningStep): ServerStatus | undefined {
  return step === 'ready' ? 'running' : undefined
}

/**
 * Does `to` move a row FORWARD along `PROVISIONING_STEPS`? (rockysurf-ljxi)
 *
 * `recordProgress` writes whatever valid step it is handed, and that is right for a bootstrap
 * report: an agent journal only ever moves forward, so the question never came up. Core's own
 * OBSERVATIONS are different. The provision ticker re-reads the provider every ten seconds and
 * it keeps answering `running` for the entire install, so a milestone reported straight from a
 * sync would drag a row that had reached `installing_tools` back to `instance_running` on the
 * next tick — and the timeline with it, which is worse than the silence it was meant to fix.
 *
 * A caller reporting a fact it will keep observing asks this first; the answer also gives it
 * report-once for free, which is why there is no separate "have we said this already" flag.
 *
 * A row with no step yet is before all of them, so any step advances it.
 */
export function advancesProvisioning(from: ProvisioningStep | null | undefined, to: ProvisioningStep): boolean {
  return PROVISIONING_STEPS.indexOf(to) > (from ? PROVISIONING_STEPS.indexOf(from) : -1)
}

export interface IpChange {
  publicIp: string
  previousIp?: string
  ipChangedAt?: string
}

/**
 * Ported rule, and the subtle one: setting an address for the FIRST time is not a change.
 *
 * The original distinguished three cases, and the distinction is load-bearing because
 * `previousIp`/`ipChangedAt` drive a user-facing "your IP moved, update your SSH config"
 * notification. Stamping that on first assignment would fire the notification on every
 * successful boot.
 *
 * Returns `undefined` when nothing should be written.
 */
export function resolveIpChange(currentIp: string | null | undefined, reportedIp: string | undefined, now: string): IpChange | undefined {
  if (!reportedIp) return undefined
  if (currentIp && reportedIp !== currentIp) {
    return { publicIp: reportedIp, previousIp: currentIp, ipChangedAt: now }
  }
  if (!currentIp) {
    return { publicIp: reportedIp } // first assignment — not a change
  }
  return undefined // unchanged
}
