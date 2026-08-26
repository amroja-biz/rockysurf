import { useEffect, useState } from 'react'
import { Link } from 'react-router'

/**
 * "Rocky Surf is not a guaranteed source of truth for your cloud" (issue #126).
 *
 * The dashboard shows what core last learned from each provider's `describe()` — polled and
 * pushed over events, but never a live view. A server terminated from the cloud console between
 * polls, a box someone else created directly on the account, a stop that raced a webhook: none
 * of these are things core is guaranteed to have caught up on by the time this page renders.
 * The list is core's best record, not a promise, and this notice exists to say so before a user
 * takes an empty dashboard as proof their cloud account is clean.
 *
 * TWO WAYS OUT, ON PURPOSE. "Dismiss" snoozes for a week — long enough not to nag on every
 * visit, short enough that the reminder still does its job for someone who does not act on it
 * immediately. "Don't show this again" is the permanent opt-out the issue asked for by name.
 * Both are remembered in `localStorage`: Rocky Surf has no server-side per-user preference store
 * (`docs/self-hosting.md`'s data directory holds servers and secrets, not UI state), and this
 * installation is typically one browser per operator, so a browser-local flag is the honest
 * match for what is actually being remembered — unlike `IpChangeAlert`'s per-event key, there is
 * only one of these to dismiss, so one pair of keys covers it.
 *
 * The advice itself is NOT only here — dismissing (either way) must not make it unfindable, so
 * `HelpPage`'s "Checking for stale servers" section carries the same paragraph permanently.
 */

/** How long a plain "Dismiss" snoozes the notice before it reappears. */
export const SNOOZE_DAYS = 7

const HIDDEN_FOREVER_KEY = 'rockysurf.stale-servers-notice.hidden-forever'
const SNOOZED_UNTIL_KEY = 'rockysurf.stale-servers-notice.snoozed-until'

function isHiddenForever(): boolean {
  try {
    return window.localStorage.getItem(HIDDEN_FOREVER_KEY) === '1'
  } catch {
    // Private mode, or storage disabled. Fail open — showing the notice again is a nuisance,
    // not a correctness problem — rather than throwing and blanking the dashboard.
    return false
  }
}

function isSnoozed(): boolean {
  try {
    const until = window.localStorage.getItem(SNOOZED_UNTIL_KEY)
    if (!until) return false
    const untilMs = Date.parse(until)
    if (Number.isNaN(untilMs)) return false
    return Date.now() < untilMs
  } catch {
    return false
  }
}

function snooze(): void {
  try {
    const until = new Date(Date.now() + SNOOZE_DAYS * 24 * 60 * 60 * 1000)
    window.localStorage.setItem(SNOOZED_UNTIL_KEY, until.toISOString())
  } catch {
    /* ignore */
  }
}

function hideForever(): void {
  try {
    window.localStorage.setItem(HIDDEN_FOREVER_KEY, '1')
  } catch {
    /* ignore */
  }
}

export function StaleServersNotice() {
  // Undecided until the effect below reads storage, so a server-rendered or very first paint
  // never flashes the notice for someone who already said "don't show this again".
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    setVisible(!isHiddenForever() && !isSnoozed())
  }, [])

  if (!visible) return null

  return (
    <div className="stale-servers-notice" role="status">
      <div className="stale-servers-notice-content">
        <span className="stale-servers-notice-icon" aria-hidden="true">
          🔍
        </span>
        <span>
          Rocky Surf can&rsquo;t guarantee this list matches your cloud account. Check your cloud
          provider&rsquo;s console periodically for stale resources it may not know about.{' '}
          <Link to="/help#stale-servers">Why, and how to check</Link>.
        </span>
      </div>
      <div className="stale-servers-notice-actions">
        <button
          type="button"
          className="stale-servers-notice-action"
          onClick={() => {
            snooze()
            setVisible(false)
          }}
        >
          Dismiss
        </button>
        <button
          type="button"
          className="stale-servers-notice-action"
          onClick={() => {
            hideForever()
            setVisible(false)
          }}
        >
          Don&rsquo;t show again
        </button>
      </div>
    </div>
  )
}
