import { TRANSITIONS, type TransitionAction } from '../hooks/useServerTransition'
import type { Server } from '../lib/api'
import { STATUS_LABELS } from '../lib/format'

/**
 * The status pill, in one place because two pages draw it and both needed the same new
 * behaviour (rockysurf-4t8y).
 *
 * `data-status` IS ALWAYS THE ROW'S OWN STATUS, whatever the pill happens to read. A transition
 * this browser asked for and the provider has not confirmed is presentation — it hangs off a
 * separate `data-transition` attribute, so nothing downstream (the stylesheet, a test, anyone
 * reading the DOM) can mistake it for a status core reported. The two attributes disagreeing is
 * precisely the state this component exists to render: "stopped, and on its way up".
 */
export function StatusBadge({
  status,
  transition,
}: {
  status: Server['status']
  transition?: TransitionAction | null
}) {
  return (
    <span
      className="status-badge"
      data-status={status}
      {...(transition ? { 'data-transition': transition } : {})}
    >
      {transition ? TRANSITIONS[transition].label : STATUS_LABELS[status]}
    </span>
  )
}
