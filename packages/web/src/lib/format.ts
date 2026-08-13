import type { Price, ProvisioningStep, Server } from './api'

/**
 * Display helpers, ported from the copies that were duplicated across the old Dashboard and
 * ServerDetail pages. One home, because the two pages disagreeing about what "Provisioning"
 * is called is exactly the sort of drift nobody notices.
 */

export const STATUS_LABELS: Record<Server['status'], string> = {
  requested: 'Requested',
  provisioning: 'Provisioning',
  running: 'Running',
  stopped: 'Stopped',
  terminated: 'Terminated',
  failed: 'Failed',
}

/**
 * `stack_creating` is gone — there is no CloudFormation stack any more — and `requested` took
 * its place as the entry state. Every other label is carried over verbatim so the vocabulary
 * a user already knows does not shift under them.
 */
export const STEP_LABELS: Record<ProvisioningStep, string> = {
  requested: 'Requested',
  instance_launching: 'Launching server',
  instance_running: 'Server launched',
  installing_tools: 'Installing tools',
  tools_installed: 'Tools installed',
  cloning_repos: 'Cloning repositories',
  ready: 'Ready',
}

/** The order the timeline draws them in, which is the order core reports them. */
export const STEP_ORDER: ProvisioningStep[] = [
  'requested',
  'instance_launching',
  'instance_running',
  'installing_tools',
  'tools_installed',
  'cloning_repos',
  'ready',
]

/**
 * Is this a step the timeline can draw?
 *
 * `bootstrap-progress` types `step` loosely because it crosses a process boundary, and a value
 * from outside this list is not a step the UI knows how to place — a plan step id (`tool:beads`)
 * once travelled in that field, which is what left the timeline unlit for a whole install
 * (rockysurf-xinr). Every consumer folds events in through this guard, so an unrecognised value
 * leaves the timeline where it is instead of resetting it to before the beginning.
 */
export function isProvisioningStep(step: string): step is ProvisioningStep {
  return (STEP_ORDER as readonly string[]).includes(step)
}

/**
 * Accrued running time — the seconds the uptime ticker has credited, which is the number the
 * cost beside it is computed from. Deliberately NOT wall-clock-since-created: that would count
 * the hours a box spent stopped, disagreeing with both the cost on the same card and the /costs
 * table, and a stopped box is not up.
 *
 * A dash means ONLY "core did not tell us" (rockysurf-u6af, where it meant the field was being
 * read from a key core never sends). Zero is a fact — a box promoted to running a moment ago
 * has honestly accrued nothing yet — so it renders as a duration like every other value, in the
 * same shape /costs uses, seconds included below a minute.
 */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—'
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

/** The estimate caveat, attached to every number that is one. */
export const ESTIMATE_HINT =
  'Estimate. Rounds down: uptime accrues on a timer, so a running server has cost slightly more than shown.'

/**
 * Why a cost can be missing, in one sentence (rockysurf-dec8's snapshot doctrine).
 *
 * A row is priced once, when it is created, from the price its provider quoted then. A row
 * created before core priced anything, or on a provider that quotes no price, has no rate to
 * multiply — so its cost is unknown rather than zero, and nothing retro-prices it.
 */
export const UNPRICED_HINT =
  'No price was recorded for this server when it was created, so its cost is not tracked — here or against the spend cap.'

/**
 * Currency comes from the provider, not from us: Hetzner quotes in the project's billing
 * currency, so hard-coding a dollar sign would show a EUR customer the wrong symbol on a
 * number that is already only an estimate.
 */
export function formatCost(amount: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
  } catch {
    // An unknown currency code should not blank the card.
    return `${amount.toFixed(2)} ${currency}`
  }
}

/**
 * The cost cell, with the reason attached.
 *
 * The two zeros are different facts and used to render identically: a priced box that has
 * accrued nothing yet costs 0.00 of a known currency, while an unpriced box's cost is unknown.
 * Only the second one is a dash, and it carries the sentence that says why — the cell is the
 * one place a user asks the question.
 */
export function formatCostCell(server: { hourlyCost?: Price; estimatedTotalCost: number }): {
  text: string
  title: string
} {
  if (!server.hourlyCost) return { text: '—', title: UNPRICED_HINT }
  return { text: formatCost(server.estimatedTotalCost, server.hourlyCost.currency), title: ESTIMATE_HINT }
}

export function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * Date AND time of day, for a fact whose hour matters.
 *
 * `formatDate` is right for "created 12 Aug"; it is wrong for "billing confirmed from", where
 * the whole point is how many hours have been counted and how many have not (rockysurf-4byx).
 */
export function formatDateTime(isoString: string): string {
  return new Date(isoString).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
