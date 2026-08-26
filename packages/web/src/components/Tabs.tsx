import { useRef, type ReactNode } from 'react'

/**
 * A tab list, written to the WAI-ARIA tabs pattern by hand (rockysurf-jn71, issue #122).
 *
 * WHY IT LIVES HERE NOW. It was written inside `CreateServerPage` with a note saying that moving
 * it into `components/` the day a second page needed tabs would be a cut and paste. Settings is
 * that second page (issue #122), and two hand-rolled tab lists would be two chances to get the
 * roving tabindex wrong — `role="tab"` without the arrow keys is a control that looks like tabs
 * and does not behave like them.
 *
 * NO DEPENDENCY. The repo has no UI kit, `App.css` is hand-written, and the one widget library
 * anybody has proposed is deferred to v0.2 (rockysurf-57zw); fifty lines is not worth a package.
 *
 * AUTOMATIC ACTIVATION — selection follows focus, so an arrow key both moves and switches. The
 * pattern recommends it when the panels are cheap, and both callers' panels are already in
 * memory: a list of radio cards on one page, a form whose state lives above this component on
 * the other.
 *
 * ONE PANEL OR MANY. The create page has genuinely one region whose contents change, so every
 * tab there points `aria-controls` at the same panel; settings has one panel per section, each
 * mounted and all but one `hidden`, so each tab names its own through `controls`. Either way no
 * tab carries an `aria-controls` that resolves to nothing.
 *
 * BOTH AXES OF ARROW KEY, because the settings list is a column on a wide screen and a row on a
 * narrow one — the same DOM, laid out by a media query. `aria-orientation` is left at its
 * default rather than asserting an orientation that a viewport change would make untrue.
 */
export interface TabSpec<K extends string> {
  key: K
  /** The tab's visible label. Anything beyond text becomes part of its accessible name. */
  label: ReactNode
  /** The panel this tab controls, when the caller renders one panel per tab. */
  controls?: string
}

export function Tabs<K extends string>({
  label,
  panelId,
  tabs,
  active,
  onSelect,
  className,
}: {
  label: string
  /**
   * The default `aria-controls` target, and the prefix of every tab's own `id` — a tab is
   * `${panelId}-tab-${key}`, which is what a panel points `aria-labelledby` back at.
   */
  panelId: string
  tabs: readonly TabSpec<K>[]
  active: K
  onSelect: (key: K) => void
  /** An extra class on the list, for a caller that lays its tabs out differently. */
  className?: string
}) {
  const buttons = useRef(new Map<K, HTMLButtonElement | null>())

  // Wraps, because the pattern says a tab list wraps: End-to-Home by arrowing off the edge is
  // the behaviour a keyboard user already has everywhere else.
  const moveTo = (index: number) => {
    const next = tabs[(index + tabs.length) % tabs.length]
    if (!next) return
    onSelect(next.key)
    buttons.current.get(next.key)?.focus()
  }

  return (
    <div className={`tablist ${className ?? ''}`.trim()} role="tablist" aria-label={label}>
      {tabs.map((tab, index) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          id={`${panelId}-tab-${tab.key}`}
          className={`tab ${tab.key === active ? 'selected' : ''}`}
          aria-selected={tab.key === active}
          aria-controls={tab.controls ?? panelId}
          // Roving tabindex: one stop for the whole list, so Tab moves past the control rather
          // than through every tab in it.
          tabIndex={tab.key === active ? 0 : -1}
          ref={(el) => {
            buttons.current.set(tab.key, el)
          }}
          onClick={() => onSelect(tab.key)}
          onKeyDown={(event) => {
            const to =
              event.key === 'ArrowRight' || event.key === 'ArrowDown'
                ? index + 1
                : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                  ? index - 1
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : null
            if (to === null) return
            event.preventDefault()
            moveTo(to)
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
