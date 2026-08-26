import { useCallback, useEffect, useRef, useState } from 'react'
import type { Server } from '../lib/api'

/**
 * The affordance for a stop or a start the provider has accepted and not yet finished
 * (rockysurf-4t8y).
 *
 * WHY THIS IS A CLIENT-SIDE HOOK AND NOT A STATUS. Core's row statuses are provider-confirmed
 * facts (rockysurf-55fx.13/55fx.15): while EC2 is stopping the box is still up and still
 * billing, so the row says `running`, and while it is coming back up EC2 answers `pending` —
 * indistinguishable from a first boot — so the row says `stopped` until the provider says
 * otherwise. Both are honest. Neither says that a transition the USER asked for is in flight,
 * which is a fact about this browser tab, not about the machine: it is known here, it is not
 * known to core, and a persisted marker for it was costed and dropped in rockysurf-55fx.15.
 *
 * So the affordance lives exactly where the fact does. Nothing here writes a status, and the
 * lamp keeps rendering the row's true status in `data-status` throughout — see `Lamp` in
 * `components/etched.tsx`.
 *
 * Three rules, in the order they fire:
 *
 *  1. **The accepted response starts it.** A 200 from start/stop is the provider saying "I have
 *     the request". The row it carries is what a reload would show; while that is still the
 *     PRE-CLICK status, the page says "Starting…"/"Stopping…" instead of repeating it. On a
 *     cloud that settles inside the call (Hetzner, the fake provider) the response already
 *     shows the new status and nothing transitional is ever shown.
 *  2. **A status change ends it.** Whatever moves the row — an SSE `server-status` frame, a
 *     poll, a manual reload — the affordance goes the moment the row stops reading the status
 *     it was on when the request was accepted. Terminal outcomes end it too: `failed` is not
 *     the origin status either.
 *  3. **Silence ends it, honestly.** If no confirmation arrives inside the window, the pill
 *     decays back to the row's true status with a hint. An affordance that spins forever is a
 *     worse lie than the silence this bead exists to fix.
 */

export type TransitionAction = 'start' | 'stop'

/**
 * What the row still reads while each request is in flight, and what to call it meanwhile.
 *
 * `from` is the whole state machine: `start` is only ever offered on a `stopped` row and `stop`
 * only on a `running` one, so "the row still reads `from`" is exactly "the provider has not
 * finished", with no target-status table to keep in step with core's.
 */
export const TRANSITIONS: Record<TransitionAction, { from: Server['status']; label: string }> = {
  start: { from: 'stopped', label: 'Starting…' },
  stop: { from: 'running', label: 'Stopping…' },
}

/**
 * How often the page nudges core while it waits.
 *
 * THE POLL IS A NUDGE, NOT A FETCH. `GET /servers/:id` and `GET /servers` both run core's
 * `sync()` for the rows they touch, and a sync that changes a status broadcasts `server-status`
 * to every one of that user's open streams. So this poll drives core's own confirmation path:
 * a second tab, or the dashboard behind this page, learns of the transition from the stream
 * without polling anything itself.
 *
 * That is also why the poll lives here rather than as a short-lived sync burst inside core.
 * A burst would need server-side state, per-user timers and a decision about what happens when
 * core restarts mid-transition; this needs none of those, dies with the tab, and reaches every
 * viewer anyway through the broadcast the sync already emits. Nothing polls a stopped or
 * starting row otherwise — the provision ticker sweeps `requested`/`provisioning` only — so
 * without this the confirmation genuinely does not arrive until someone reloads.
 */
export const TRANSITION_POLL_MS = 5_000

/**
 * How long the affordance is allowed to outlive the click.
 *
 * Generous, and different per direction, because the clouds are: an EC2 start is usually
 * 30-90 seconds and a stop routinely takes longer, since the guest gets an ACPI shutdown and
 * its own time to take it. Past this the transition has not necessarily failed — it has stopped
 * being something this page can honestly claim to know about.
 */
export const TRANSITION_WINDOW_MS: Record<TransitionAction, number> = {
  start: 3 * 60_000,
  stop: 5 * 60_000,
}

/** Said out loud when the window closes, in place of a spinner that would never stop. */
export const TRANSITION_STALLED_HINT =
  'Still waiting for the provider to confirm this. Refresh the page, or try again.'

export interface ServerTransition {
  /** The action still waiting on the provider, or null. Drives the pill and the buttons. */
  pending: TransitionAction | null
  /** The action whose window closed with no confirmation. Null again once the row moves. */
  stalled: TransitionAction | null
  /** Call with the status carried by the accepted start/stop response. */
  begin: (action: TransitionAction, accepted: Server['status']) => void
}

/**
 * @param status the row's own status, as the page currently has it
 * @param poll   nudges core for this server; called on a fixed cadence while a transition is
 *               pending, and never otherwise
 */
export function useServerTransition(
  status: Server['status'] | undefined,
  poll: () => void | Promise<void>,
): ServerTransition {
  const [state, setState] = useState<{ action: TransitionAction; stalled: boolean } | null>(null)

  // Held in a ref so a page can pass an inline closure without restarting the poll every
  // render — the same reason `useServerUpdates` does it.
  const pollRef = useRef(poll)
  pollRef.current = poll

  const begin = useCallback((action: TransitionAction, accepted: Server['status']) => {
    // Already settled: a provider that stopped or started inside the request has nothing
    // pending to show, and pretending otherwise would put a "Starting…" pill on a running box.
    setState(accepted === TRANSITIONS[action].from ? { action, stalled: false } : null)
  }, [])

  // Rule 2. Deliberately also clears a stalled transition: a row that finally moved is a row
  // whose hint has stopped being true.
  useEffect(() => {
    if (!state || status === undefined) return
    if (status !== TRANSITIONS[state.action].from) setState(null)
  }, [state, status])

  // Rules 1 and 3, which share a lifetime: poll until the window closes, then decay.
  useEffect(() => {
    if (!state || state.stalled) return
    const { action } = state

    const ticker = setInterval(() => void pollRef.current(), TRANSITION_POLL_MS)
    const deadline = setTimeout(
      () => setState((current) => (current && !current.stalled ? { action: current.action, stalled: true } : current)),
      TRANSITION_WINDOW_MS[action],
    )

    return () => {
      clearInterval(ticker)
      clearTimeout(deadline)
    }
  }, [state])

  return {
    pending: state && !state.stalled ? state.action : null,
    stalled: state?.stalled ? state.action : null,
    begin,
  }
}
