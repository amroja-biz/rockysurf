import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../contexts/AuthContext'
import { useEvents } from '../contexts/EventsContext'

/**
 * The chrome every signed-in page sits inside: navigation, who you are, and whether the live
 * stream is up.
 *
 * Extracted from the placeholder shell so the real pages and the remaining stubs stay
 * consistent while the rest of the milestone lands. Pages own their content and nothing else.
 */
export function AppShell({ title, children }: { title: string; children?: ReactNode }) {
  const { user, logout } = useAuth()
  const { connectionStatus } = useEvents()

  return (
    <div className="app-shell">
      <header className="app-header">
        <nav>
          <Link to="/">Servers</Link>
          <Link to="/servers/new">New</Link>
          <Link to="/admin/tools">Tools</Link>
          <Link to="/admin/surge-packs">Packs</Link>
          <Link to="/settings">Settings</Link>
        </nav>
        <div className="app-header-right">
          {/* Visible on purpose: when updates stop arriving, the first question is whether
              the stream is still up, and the answer should not require the console. */}
          <span className="connection-status" data-status={connectionStatus} data-testid="connection-status">
            events: {connectionStatus}
          </span>
          {user && (
            <>
              <span>{user.username}</span>
              <button onClick={() => void logout()}>Sign out</button>
            </>
          )}
        </div>
      </header>
      <main>
        <h1>{title}</h1>
        {children}
      </main>
    </div>
  )
}
