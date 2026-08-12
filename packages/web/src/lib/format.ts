import type { ProvisioningStep, Server } from './api'

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

export function formatUptime(seconds: number): string {
  if (!seconds) return '—'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

/**
 * Currency comes from the provider, not from us: Hetzner quotes in the project's billing
 * currency, so hard-coding a dollar sign would show a EUR customer the wrong symbol on a
 * number that is already only an estimate.
 */
export function formatCost(amount: number, currency = 'USD'): string {
  if (!amount) return '—'
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
  } catch {
    // An unknown currency code should not blank the card.
    return `${amount.toFixed(2)} ${currency}`
  }
}

export function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
