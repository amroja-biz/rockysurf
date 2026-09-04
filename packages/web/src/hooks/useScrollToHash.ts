import { useLayoutEffect } from 'react'
import { useLocation } from 'react-router'

/**
 * Scrolls to the element named by the current URL's fragment, e.g. `/help#stale-servers`
 * (issue #344).
 *
 * Two paths land here and neither works without this hook:
 *
 *  - A `<Link to="/help#stale-servers">` clicked from elsewhere in the app (the stale-servers
 *    notice, the backup reminder, ...) is a client-side navigation. React Router updates the
 *    URL and swaps the page, but never scrolls for a hash — that is the browser's job, and the
 *    browser only does it on a real (non-SPA) navigation.
 *  - Typing `http://.../help#stale-servers` straight into the address bar IS a real navigation,
 *    so the browser tries — once, while the document is still loading. This app renders its
 *    content with React after that point, so the target element does not exist yet and the
 *    browser's attempt lands on nothing, i.e. the top of the page.
 *
 * Mounted once in `AppShell`, so every current and future `/page#anchor` link is fixed by the
 * same mechanism rather than each page (or each link) wiring its own effect.
 */
export function useScrollToHash(): void {
  const { pathname, hash } = useLocation()

  // Layout, not passive: scrolling after paint would show the top of the page for a frame
  // before jumping, on both a fresh load of a `#anchor` URL and an in-app navigation to one.
  useLayoutEffect(() => {
    // Defensive against `hash` being absent, not just empty: a couple of test suites mock
    // `useLocation` down to `{ pathname }` alone, which is a legitimate location value in
    // React Router's own type even though a real one always carries a (possibly empty) hash.
    if (!hash || hash === '#') return
    const id = hash.slice(1)

    let cancelled = false
    const scrollIfPresent = (): boolean => {
      const target = document.getElementById(id)
      if (!target) return false
      target.scrollIntoView?.({ block: 'start' })
      return true
    }

    if (scrollIfPresent()) return

    // The target section is normally already in the DOM by the time this effect runs — pages
    // here render their content synchronously — but one deferred retry covers a page that
    // hangs its content behind a render tick without turning this into a poll loop.
    const frame = requestAnimationFrame(() => {
      if (!cancelled) scrollIfPresent()
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
    // Re-run on every navigation that could change which section the hash names, including a
    // click from one hash straight to another on the same page.
  }, [pathname, hash])
}
