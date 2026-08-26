import { useEffect, useState } from 'react'

/**
 * "Your server's address moved, update your SSH config."
 *
 * Ported unchanged. The dismissal key includes `changedAt`, which is the part worth keeping:
 * dismissing one move must not suppress the next one, and a key without the timestamp would
 * silence the alert forever after the first dismissal.
 */
const DISMISS_KEY_PREFIX = 'ip-change-dismissed-'

export function IpChangeAlert({
  serverId,
  previousIp,
  currentIp,
  changedAt,
}: {
  serverId: string
  previousIp: string
  currentIp: string
  changedAt: string
}) {
  const [isDismissed, setIsDismissed] = useState(false)
  const dismissKey = `${DISMISS_KEY_PREFIX}${serverId}-${changedAt}`

  useEffect(() => {
    setIsDismissed(localStorage.getItem(dismissKey) === 'true')
  }, [dismissKey])

  if (isDismissed) return null

  return (
    <div className="ip-change-alert" role="status">
      <div className="ip-change-content">
        <span className="ip-change-icon">⚠︎</span>
        <span>
          <strong>IP address changed:</strong> <code className="ip-old">{previousIp}</code> →{' '}
          <code className="ip-new">{currentIp}</code>
        </span>
      </div>
      <button
        className="dismiss-button"
        onClick={() => {
          localStorage.setItem(dismissKey, 'true')
          setIsDismissed(true)
        }}
        aria-label="Dismiss IP change notification"
      >
        ×
      </button>
    </div>
  )
}
