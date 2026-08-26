import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StaleServersNotice } from './StaleServersNotice'

/**
 * The "check your cloud console" reminder (issue #126).
 *
 * What matters is the persistence contract, not the prose: shown by default, a plain Dismiss
 * snoozes it, "Don't show this again" hides it for good, and both survive a remount — a page
 * navigation must not re-show a notice the user just dismissed.
 */

function renderNotice() {
  return render(
    <MemoryRouter>
      <StaleServersNotice />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a browser that has not seen the notice', () => {
  it('shows the notice, names the trade-off, and links the help section', () => {
    renderNotice()
    const notice = screen.getByRole('status')
    expect(notice.textContent).toContain('can’t guarantee this list matches your cloud account')
    expect(screen.getByRole('link', { name: 'Why, and how to check' }).getAttribute('href')).toBe(
      '/help#stale-servers',
    )
  })
})

describe('Dismiss', () => {
  it('hides the notice immediately', () => {
    renderNotice()
    expect(screen.getByRole('status')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('stays hidden across a remount, within the snooze window', () => {
    const { unmount } = renderNotice()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    unmount()

    renderNotice()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('reappears once the snooze window has passed', () => {
    vi.useFakeTimers()
    const { unmount } = renderNotice()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    unmount()

    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000)
    renderNotice()
    expect(screen.getByRole('status')).toBeTruthy()
  })
})

describe("Don't show this again", () => {
  it('hides the notice immediately', () => {
    renderNotice()
    fireEvent.click(screen.getByRole('button', { name: "Don’t show again" }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('stays hidden across a remount, even well past the snooze window', () => {
    vi.useFakeTimers()
    const { unmount } = renderNotice()
    fireEvent.click(screen.getByRole('button', { name: "Don’t show again" }))
    unmount()

    vi.setSystemTime(Date.now() + 365 * 24 * 60 * 60 * 1000)
    renderNotice()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
