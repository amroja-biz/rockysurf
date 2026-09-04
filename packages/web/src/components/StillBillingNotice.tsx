import type { Server } from '../lib/api'
import { formatDateTime } from '../lib/format'

/**
 * "This machine is still running, and still billing" (rockysurf-4byx).
 *
 * The case it exists for is a bootstrap that failed and LEFT THE MACHINE UP: a failure outside
 * a tool install (a finishing step), a tool failure under `bootstrap.onFailure: keep`, or a
 * tool failure where the provider refused to release the instance (ADR-0010 — a failed tool
 * install otherwise terminates the box, and this notice then has nothing to say). The spend cap
 * never stops a running server either. What was missing before this notice is that nothing
 * said so, and the card's `Uptime 0s / $0.00` actively implied the opposite.
 *
 * NOT DISMISSIBLE, unlike `IpChangeAlert`. A changed IP is news that stops mattering once you
 * have read it; a machine that is charging money goes on charging money, and a dismiss button
 * would let the user hide the only thing on the page telling them why their bill is growing.
 * It disappears when the fact does — when the box is terminated, or the provider stops
 * reporting it up.
 *
 * The two ways out are given equal weight on purpose. "Terminate" is the cheap one and the one
 * a user reaches for; "diagnose" is why the box is still there at all, and a notice that only
 * said "terminate this" would quietly throw away the evidence the failure left behind. The
 * report above this notice says WHY the machine was kept.
 *
 * GATED ON `failed`, NOT ON `billing` ALONE (issue #218). Core sends the `billing` block for any
 * row whose provider says the instance is metering and whose STATUS does not already say so —
 * `isBillingRow(row) && row.status !== 'running'`, with `pending`, `running` and `stopping` the
 * metering states on every cloud — plus `stopped` on a cloud whose provider declared
 * `billsWhileStopped` (ADR-0025), which the server page reports with its own one-line notice
 * rather than through this one. That is a wider set than this notice has anything to say about:
 *
 *  - `requested` / `provisioning` — a box coming up on purpose. The instance meters from the
 *    moment it is asked for, so a first launch carried this notice while the "Launching server"
 *    step was still running: nothing has failed, there is nothing to diagnose, and the sentence
 *    reads as an instruction to terminate a healthy machine (compare issue #205).
 *  - `stopped` with a live instance — a start core has issued that the cloud has not finished
 *    (`state === 'pending'`, the case `start()` refuses with "already starting"), or a stop it
 *    has not finished. Transient and expected, and "still running" is not what a stopped row
 *    means to its reader.
 *  - `running` never gets the block at all: the status carries the whole truth.
 *
 * That leaves `failed`, which is the case the notice was written for and the only one where a
 * live machine is a surprise the user is being charged for.
 */
export function StillBillingNotice({ server, detailed = false }: { server: Server; detailed?: boolean }) {
  if (!server.billing || server.status !== 'failed') return null

  return (
    <div className="still-billing-notice" role="status">
      <span className="still-billing-icon" aria-hidden="true">
        ●
      </span>
      <div>
        {/* One sentence now, where there used to be a fork on status: with the gate above,
            `failed` is the only status that reaches here. */}
        <strong>Failed — but the machine is still running, and still billing.</strong>{' '}
        <span>Terminate it to stop the charge, or leave it up and SSH in to diagnose what went wrong.</span>
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
