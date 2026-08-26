/**
 * What happens when a bootstrap fails — the one path both topologies take (ADR-0010, #119).
 *
 * Push mode reaches this from the provision ticker, with the journal core read over SSH and the
 * logs it pulled off the box before the connection closed. Callback mode reaches it from the
 * box's own status POST, with the tail the agent sent. Either way the decision is made here and
 * nowhere else, which is what keeps "a failed tool install terminates the box" one rule rather
 * than two implementations that drift.
 *
 * The rule, from the owner (2026-08-26):
 *
 *   * A failed TOOL install terminates the instance. Nothing the user made exists on a box
 *     before `ready`; a half-installed toolchain is a machine nobody can use and everybody is
 *     paying for. `bootstrap.onFailure: keep` is the escape hatch for a pack author who needs
 *     to SSH in.
 *   * Every other failure keeps the box, as before — a repository that did not clone, a branding
 *     step, the remote-desktop password — and the still-billing notice does its job.
 *   * Whatever happened to the machine, the report says so in one sentence, next to the
 *     complete explanation of what failed. The explanation is the diagnosis now; it has to be
 *     good enough that nobody needs the machine.
 *
 * Order of operations matters and is the same as the timeout path in `provision-ticker.ts`: the
 * instance is released FIRST, then the row is failed, so a crash between the two leaves a
 * provisioning row the next tick retries rather than a failed row beside an instance still
 * billing. If the provider refuses, the row is failed anyway with `terminate-failed` on the
 * report — the user is told the machine may still be billing and where to go to stop it.
 */

import type { BootstrapOnFailure } from '../config/schema.js'
import type { Db } from '../db/client.js'
import { getTool } from '../db/repositories/packs.js'
import { appendEvent } from '../db/repositories/users.js'
import {
  getBootstrapReport,
  getProviderData,
  getServerRepositories,
  recordProviderState,
  setBootstrapReport,
  updateServerStatus,
} from '../db/repositories/servers.js'
import type { ServerRow } from '../db/schema.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { EventsService } from '../services/events.js'
import {
  describeInstance,
  type BootstrapReport,
  type InstanceOutcome,
  type LabelSources,
  type StepReport,
} from './failure-report.js'
import { repoDirName } from './resolver.js'

/**
 * Names for the report: a tool's display name from the tools table, a repository's URL from
 * the row. Both fall back to the step id inside `stepLabel`, so a tool that has since been
 * deleted from the catalogue still gets an honest label.
 */
export function labelSourcesFor(db: Db, row: ServerRow): LabelSources {
  const repositories = getServerRepositories(row)
  return {
    toolName: (toolId) => getTool(db, toolId)?.name,
    repoUrl: (dirName) => repositories.find((url) => repoDirName(url) === dirName),
  }
}

export interface FailBootstrapDeps {
  db: Db
  events: EventsService
  registry: Pick<ProviderRegistry, 'get' | 'has'>
  /** `bootstrap.onFailure` from config. Absent means the default, `terminate`. */
  onFailure?: BootstrapOnFailure
  log?: (message: string) => void
}

export interface BootstrapFailureInput {
  failure: StepReport
  warnings?: StepReport[]
  agentLogTail?: string
}

/** The rule, as a predicate, so a test can state it in one line. */
export function terminatesInstance(failure: Pick<StepReport, 'phase'>, policy: BootstrapOnFailure = 'terminate'): boolean {
  return failure.phase === 'tool' && policy === 'terminate'
}

function phaseNoun(failure: StepReport): string {
  switch (failure.phase) {
    case 'repo':
      return 'a repository clone'
    case 'setup':
      return 'a setup script'
    case 'finishing':
      return 'a finishing step'
    default:
      return 'a tool install'
  }
}

/**
 * Fail the row, with the complete report and — for a tool failure under the default policy —
 * without the machine. Returns the failed row.
 */
export async function failBootstrap(deps: FailBootstrapDeps, row: ServerRow, input: BootstrapFailureInput): Promise<ServerRow> {
  const policy = deps.onFailure ?? 'terminate'
  const log = deps.log ?? ((message: string) => console.error(message))

  let instance: InstanceOutcome = 'kept'
  let detail: string | undefined
  const data = getProviderData(row)

  if (terminatesInstance(input.failure, policy) && data && deps.registry.has(row.provider)) {
    try {
      await deps.registry.get(row.provider).terminate(data)
      // Recorded now rather than on the next sync: cost accrual reads the provider state, and
      // a machine core just released must stop metering on this tick, not the next.
      recordProviderState(deps.db, row.id, 'terminated')
      instance = 'terminated'
    } catch (err) {
      instance = 'terminate-failed'
      detail = String(err instanceof Error ? err.message : err)
      log(`[bootstrap] could not terminate ${row.id} after its tool install failed: ${detail}`)
    }
  } else if (input.failure.phase === 'tool' && policy === 'keep') {
    detail = 'The machine was kept because `bootstrap.onFailure` is `keep`; it is still billing. SSH in to look, then terminate it.'
  } else if (input.failure.phase !== 'tool') {
    detail = `The machine was kept: only a failed tool install releases it, and this was ${phaseNoun(input.failure)}. It is still billing until you terminate it; you can SSH in and finish by hand.`
  } else {
    // A tool failure with nothing to terminate — no provider handle, or a provider this config
    // no longer enables. The row is failed like any other; there is no machine to speak of.
    detail = 'There was no machine to release.'
  }

  // Push mode hands over the journal's warnings whole. Callback mode has been merging them onto
  // the row one POST at a time, so when the failure arrives the row already holds them — keep
  // those, minus any entry for the step that has now failed for real.
  const earlier = input.warnings ?? getBootstrapReport<BootstrapReport>(row)?.warnings ?? []
  const report: BootstrapReport = {
    failure: { ...input.failure, instance, instanceNote: describeInstance(instance, detail) },
    warnings: earlier.filter((w) => w.stepId !== input.failure.stepId),
    ...(input.agentLogTail ? { agentLogTail: input.agentLogTail } : {}),
  }
  setBootstrapReport(deps.db, row.id, report)
  appendEvent(deps.db, {
    type: 'bootstrap.failed',
    serverId: row.id,
    userId: row.userId,
    payload: {
      stepId: input.failure.stepId,
      phase: input.failure.phase,
      cause: input.failure.cause,
      instance,
      summary: input.failure.summary,
    },
  })

  // The row's one-paragraph version: what failed and what happened to the machine. The report
  // carries the evidence; this is what the dashboard card and the CLI print.
  const message = `${report.failure!.summary} ${report.failure!.instanceNote}`
  const failed = updateServerStatus(deps.db, row.id, 'failed', { errorMessage: message })
  await deps.events.broadcastToUser(failed.userId, {
    type: 'server-status',
    serverId: failed.id,
    status: failed.status,
    error: message,
  })
  return failed
}

/**
 * A plan that completed with optional steps failed — repositories that did not clone, a login
 * banner that did not render. The box is coming up; the row just has to say what is not on it.
 *
 * Push mode has the whole journal at once and REPLACES: an empty list clears any report from
 * an earlier attempt, so a re-push that fixed things does not keep advertising the failure it
 * fixed. Callback mode hears about each failed step as it happens and MERGES, one warning per
 * POST, keyed by step id so a re-run of the same step updates rather than duplicates.
 */
export function recordWarnings(
  deps: Pick<FailBootstrapDeps, 'db'>,
  row: ServerRow,
  input: { warnings: StepReport[]; agentLogTail?: string; mode?: 'replace' | 'merge' },
): ServerRow {
  const existing = input.mode === 'merge' ? (getBootstrapReport<BootstrapReport>(row)?.warnings ?? []) : []
  const incoming = new Set(input.warnings.map((w) => w.stepId))
  const warnings = [...existing.filter((w) => !incoming.has(w.stepId)), ...input.warnings]

  if (warnings.length === 0) {
    return row.bootstrapReport ? setBootstrapReport(deps.db, row.id, null) : row
  }
  const report: BootstrapReport = {
    warnings,
    ...(input.agentLogTail ? { agentLogTail: input.agentLogTail } : {}),
  }
  for (const warning of input.warnings) {
    appendEvent(deps.db, {
      type: 'bootstrap.warning',
      serverId: row.id,
      userId: row.userId,
      payload: { stepId: warning.stepId, phase: warning.phase, cause: warning.cause, summary: warning.summary },
    })
  }
  return setBootstrapReport(deps.db, row.id, report)
}
