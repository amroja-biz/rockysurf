import { useEffect, useState } from 'react'
import { Link } from 'react-router'

/**
 * "Rocky Surf is local-first, and nobody is backing it up but you" (issue #89).
 *
 * There is no hosted copy of anything Rocky Surf knows — the whole control plane is one
 * process and one data directory (`docs/self-hosting.md`). A lost or corrupted data directory
 * is not recoverable from this installation, so the reminder exists to be read before that
 * happens rather than after.
 *
 * `sessionStorage`, not `localStorage`: the issue asks for a reminder "every time you start
 * Rocky Surf", and a dismissal that survived closing the tab would defeat that. The flag is
 * set the moment the reminder renders, not only when it is dismissed, so it shows once on the
 * first page a session lands on and stays gone through every navigation after that — "once per
 * app load," not once per page. A fresh session (new tab, or a real reload) clears
 * `sessionStorage` and shows it again.
 */
const SESSION_KEY = 'rockysurf-backup-reminder-shown'

export function BackupReminder() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (sessionStorage.getItem(SESSION_KEY) === 'true') return
    sessionStorage.setItem(SESSION_KEY, 'true')
    setVisible(true)
  }, [])

  if (!visible) return null

  return (
    <div className="backup-reminder" role="status">
      <div className="backup-reminder-content">
        <span className="backup-reminder-icon" aria-hidden="true">
          ⚠︎
        </span>
        <span>
          <strong>Rocky Surf keeps everything on this machine.</strong> Servers, per-server SSH
          private keys, remote-desktop passwords and your Connect-GitHub token live only in
          this installation&rsquo;s data directory — there is no cloud copy, and your cloud
          credentials are never stored here at all. Back it up from{' '}
          <Link to="/settings?section=backup">Settings&nbsp;→&nbsp;Backup</Link>, or copy the
          whole directory: <Link to="/help#backup">Backing up your data</Link>.
        </span>
      </div>
      <button
        className="dismiss-button"
        onClick={() => setVisible(false)}
        aria-label="Dismiss backup reminder"
      >
        ×
      </button>
    </div>
  )
}
