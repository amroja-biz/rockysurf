import type { Server } from '../lib/api'
import { formatDateTime } from '../lib/format'

/**
 * "This machine is still running, and still billing" (rockysurf-4byx).
 *
 * The case it exists for is a bootstrap that failed — a repository-URL typo, an install script
 * that exited non-zero. The row goes to `failed` and the instance is deliberately LEFT UP, so
 * that a person can log in and find out what went wrong; the spend cap never stops a running
 * server either. Both of those are the design. What was missing is that nothing said so, and
 * the card's `Uptime 0s / $0.00` actively implied the opposite.
 *
 * NOT DISMISSIBLE, unlike `IpChangeAlert`. A changed IP is news that stops mattering once you
 * have read it; a machine that is charging money goes on charging money, and a dismiss button
 * would let the user hide the only thing on the page telling them why their bill is growing.
 * It disappears when the fact does — when the box is terminated, or the provider stops
 * reporting it up.
 *
 * The two ways out are given equal weight on purpose. "Terminate" is the cheap one and the one
 * a user reaches for; "diagnose" is why the box is still there at all, and a notice that only
 * said "terminate this" would quietly throw away the evidence the failure left behind.
 */
export function StillBillingNotice({ server, detailed = false }: { server: Server; detailed?: boolean }) {
  if (!server.billing) return null

  return (
    <div className="still-billing-notice" role="status">
      <span className="still-billing-icon" aria-hidden="true">
        💸
      </span>
      <div>
        <strong>
          {server.status === 'failed'
            ? 'Failed — but the machine is still running, and still billing.'
            : 'This machine is still running, and still billing.'}
        </strong>{' '}
        <span>
          Terminate it to stop the charge, or leave it up and SSH in to diagnose what went wrong.
          {server.status === 'failed' && ' The box is kept after a failure precisely so you can.'}
        </span>
        {detailed && server.billing.since && (
          <p className="hint">
            {/*
              Stated rather than glossed. `since` is when core CONFIRMED with the provider that
              this instance was metering — not when the provider started charging, which core did
              not observe and will not guess. On a box that was already up before core learned to
              watch failed rows, the estimate beside this starts from here and is therefore LOW.
            */}
            Counting from {formatDateTime(server.billing.since)} — the first moment Rocky Surf
            confirmed with {server.provider} that this instance was running. Anything it cost
            before then is not in the estimate.
          </p>
        )}
      </div>
    </div>
  )
}
