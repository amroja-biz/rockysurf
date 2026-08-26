import type { Server } from './api'

/**
 * The destructive button's verdict, for every page that renders one (issue #154).
 *
 * ADR-0010 gave a failed row two possible endings and one button for both: a tool install that
 * failed released the machine before failing the row, so the click has nothing left to destroy
 * and only clears the row — it is labelled **Dismiss**. Every other failure (a non-tool phase,
 * `bootstrap.onFailure: keep`, a terminate the provider refused) KEPT the machine, which is
 * still up and still billing, and that click really does destroy something — **Terminate**.
 *
 * IT LIVES HERE BECAUSE IT IS ASKED IN TWO PLACES. The detail page implemented the rule and the
 * dashboard card did not, so a failed box read `Dismiss` on one page and `Terminate` on the
 * other for the same row (issue #154) — the same class of divergence `ServerSummary = Server`
 * was collapsed to fix. One function means the two surfaces cannot disagree again.
 *
 * `billing` is CORE'S verdict, computed in `present()` from the provider state, and not
 * something a front end derives from a status string: a `failed` row whose machine is gone has
 * no `billing` block, and one whose machine was kept does. Deriving "the machine is gone" from
 * `status === 'failed'` alone would put Dismiss on a box that is quietly costing money.
 */
export interface DestructiveAction {
  /** What the button says at rest. */
  label: 'Terminate' | 'Dismiss'
  /** What it says while the request is in flight. */
  pendingLabel: 'Terminating…' | 'Dismissing…'
  /** The confirmation's heading. */
  confirmTitle: string
  /** What the confirmation warns, which is a different warning in each case. */
  confirmMessage: string
}

/**
 * Is there still a machine behind this row for a destructive click to act on?
 *
 * `terminated` is not covered here: that row has left the fleet entirely — the dashboard filters
 * it out and the detail page renders it as history — so nothing asks it this question.
 */
export function machineIsGone(server: Pick<Server, 'status' | 'billing'>): boolean {
  return server.status === 'failed' && !server.billing
}

/** The button, its confirmation, and the warning that goes with them. */
export function destructiveAction(server: Pick<Server, 'status' | 'billing' | 'name'>): DestructiveAction {
  return machineIsGone(server)
    ? {
        label: 'Dismiss',
        pendingLabel: 'Dismissing…',
        confirmTitle: `Dismiss ${server.name}?`,
        confirmMessage:
          'The machine is already gone. This clears the failed server and its report from your list.',
      }
    : {
        label: 'Terminate',
        pendingLabel: 'Terminating…',
        confirmTitle: `Terminate ${server.name}?`,
        confirmMessage: 'This destroys the server and its disk. It cannot be undone.',
      }
}
