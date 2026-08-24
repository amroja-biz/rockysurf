import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it } from 'vitest'
import { BackupReminder } from './BackupReminder'

/**
 * The dashboard backup reminder (rockysurf-prqc, issue #89).
 *
 * What matters here is the "once per app load" behaviour, not the prose: a reminder that
 * reappeared on every navigation would train people to stop reading it before it ever mattered,
 * and one that never came back would defeat the issue's "every time you start Rocky Surf" ask.
 * `sessionStorage` is the mechanism for both halves at once, so the tests exercise it directly
 * rather than mocking it away.
 */

function renderReminder() {
  return render(
    <MemoryRouter>
      <BackupReminder />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  sessionStorage.clear()
})

describe('a fresh session', () => {
  it('shows the reminder, names what is sensitive, and links the help section', () => {
    renderReminder()
    const notice = screen.getByRole('status')
    expect(notice.textContent).toContain('no cloud copy')
    // The facts the DB actually holds (packages/core/src/secrets/store.ts), not a vague "keys".
    expect(notice.textContent).toContain('SSH private keys')
    expect(notice.textContent).toContain('remote-desktop passwords')
    expect(screen.getByRole('link', { name: 'Backing up your data' }).getAttribute('href')).toBe('/help#backup')
  })

  it('marks the session as shown the moment it renders, not only on dismiss', () => {
    renderReminder()
    expect(sessionStorage.getItem('rockysurf-backup-reminder-shown')).toBe('true')
  })
})

describe('a session that has already seen it', () => {
  it('renders nothing on a second mount in the same session — e.g. a page navigation', () => {
    sessionStorage.setItem('rockysurf-backup-reminder-shown', 'true')
    renderReminder()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('dismissing', () => {
  it('hides the reminder immediately', () => {
    renderReminder()
    expect(screen.getByRole('status')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss backup reminder' }))
    expect(screen.queryByRole('status')).toBeNull()
  })
})
