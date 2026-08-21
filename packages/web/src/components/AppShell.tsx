import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../contexts/AuthContext'
import { useEvents } from '../contexts/EventsContext'
import { GITHUB_URL } from '../lib/links'

/**
 * The chrome every signed-in page sits inside: navigation, who you are, and whether the live
 * stream is up.
 *
 * Extracted from the placeholder shell so the real pages and the remaining stubs stay
 * consistent while the rest of the milestone lands. Pages own their content and nothing else.
 *
 * EVERY AUTHENTICATED PAGE GOES THROUGH HERE. Three did not — Costs, pack admin and create —
 * and shipped with no navigation at all until rockysurf-k72k; `navbar.test.tsx` now walks the
 * route table and fails when a new page skips the shell, because "remember to wrap it" is not
 * a mechanism.
 *
 * `className` lands on the `<main>` so a page can still set its own measure (the create form
 * is `.page`, 760px, as it was before the port) without owning the element.
 *
 * An empty `title` suppresses the `<h1>` rather than rendering a blank one: the home page
 * opens with its own hero and thesis line, and a heading that says nothing helps nobody —
 * least of all a screen reader.
 */
export function AppShell({
  title,
  className,
  children,
}: {
  title: string
  className?: string
  children?: ReactNode
}) {
  const { user, logout } = useAuth()
  const { connectionStatus } = useEvents()

  return (
    <div className="app-shell">
      <header className="app-header">
        {/* Named because it is no longer the only <nav>: the help page carries its own
            table-of-contents nav, and an unnamed landmark is ambiguous the moment there
            are two. */}
        <nav aria-label="Primary">
          {/* The mark is the shipped favicon rather than the full illustration: the painting
              is the home page's hero, and 236KB is not a navbar asset. */}
          <Link to="/home" className="app-brand">
            <img src="/favicon-48x48.png" alt="" width={20} height={20} />
            <span>Rocky Surf</span>
          </Link>
          <Link to="/">Servers</Link>
          <Link to="/servers/new">New</Link>
          {/* Costs had no link here at all, so the page existed and could only be reached by
              typing the URL — the other half of a page that was outside the shell. */}
          <Link to="/costs">Costs</Link>
          <Link to="/admin/tools">Tools</Link>
          {/* One link where there used to be two (rockysurf-4d8h, issue #51): the consolidated
              page at /packs is reachable by every signed-in user, not only admins. */}
          <Link to="/packs">Surge Packs</Link>
          <Link to="/settings">Settings</Link>
          <Link to="/help">Help</Link>
        </nav>
        <div className="app-header-right">
          <a
            className="github-link"
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Rocky Surf on GitHub"
            title="Rocky Surf on GitHub"
          >
            {/* GitHub's mark, inline: the bundle stays self-contained and the icon follows
                `currentColor` like the rest of the header. */}
            <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </a>
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
      <main {...(className ? { className } : {})}>
        {title !== '' && <h1>{title}</h1>}
        {children}
      </main>
    </div>
  )
}
