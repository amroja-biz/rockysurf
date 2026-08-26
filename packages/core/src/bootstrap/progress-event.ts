import type { ProvisioningStep, ServerRow, ServerStatus } from '../db/schema.js'

/**
 * The two events a bootstrap puts on the wire, built in one place (rockysurf-xinr).
 *
 * There are two topologies and therefore two emitters — the callback route, where the box
 * reports for itself, and the push runner, where core reads the box's journal — and they used
 * to build this payload independently. They diverged in the one field that matters: `step`
 * carried the PROVISIONING vocabulary from callback (`installing_tools`) and a PLAN STEP ID
 * from push (`tool:beads`). The SPA's timeline is a fixed list of provisioning steps, so
 * against push mode it recognised nothing and sat at "Requested" for the whole install while
 * the log streamed underneath it.
 *
 * Hence a builder rather than a shared interface: an interface is a description both sides can
 * ignore, and these two did. `step` is typed as the row's vocabulary, so a plan step id in that
 * position no longer compiles, and `stepId` is where the precise step goes — lossy label for
 * the timeline, exact id for anyone diagnosing which step actually ran.
 */

export interface BootstrapProgressEvent {
  type: 'bootstrap-progress'
  serverId: string
  /** The row's vocabulary — what the SPA timeline draws. Deliberately lossy. */
  step: ProvisioningStep
  /** The plan step id, when the reporter knows it. Never a substitute for `step`. */
  stepId?: string
  /** The SERVER's status, not the agent's: the SPA reads this as the row's state. */
  status?: ServerStatus
  publicIp?: string
  /**
   * Why the active step is taking longer than it looks, in one user-readable line — the
   * agent's bounded apt wait (#129) is the first. Absent when nothing is unusual, and absence
   * is meaningful: the SPA shows it under the active step and clears it on the next progress
   * event that does not carry one.
   */
  notice?: string
}

export interface ServerStatusEvent {
  type: 'server-status'
  serverId: string
  status: ServerStatus
  publicIp?: string
  error?: string
}

export function bootstrapProgressEvent(input: {
  serverId: string
  step: ProvisioningStep
  stepId?: string
  status?: ServerStatus
  publicIp?: string | null
  notice?: string
}): BootstrapProgressEvent {
  return {
    type: 'bootstrap-progress',
    serverId: input.serverId,
    step: input.step,
    ...(input.stepId ? { stepId: input.stepId } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.publicIp ? { publicIp: input.publicIp } : {}),
    ...(input.notice ? { notice: input.notice } : {}),
  }
}

/**
 * "This row's status changed", addressed to the open streams.
 *
 * Built from the row rather than from arguments because the row is what a refresh would show,
 * and the whole point of the live stream is to save the user that refresh.
 */
export function serverStatusEvent(row: ServerRow): ServerStatusEvent {
  return {
    type: 'server-status',
    serverId: row.id,
    status: row.status,
    ...(row.publicIp ? { publicIp: row.publicIp } : {}),
  }
}
