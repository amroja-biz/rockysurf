import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { GITHUB_URL } from '../lib/links'
import { HomePage } from './HomePage'

/**
 * The home page (rockysurf-n0zr.2): the hero, the thesis, and the links that make it a front
 * door rather than a dead end. Content phrasing is free to change; what is pinned here is the
 * structure a reader relies on — one real heading, the hero pointing at a path the bundle
 * carries (bundle-assets.test.ts owns the other half of that claim), and the three ways out.
 */

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'admin', isAdmin: true }, logout: vi.fn() }),
}))
vi.mock('../contexts/EventsContext', () => ({
  useEvents: () => ({ subscribe: () => () => {}, connectionStatus: 'connected' }),
}))

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/home']}>
      <HomePage />
    </MemoryRouter>,
  )
}

describe('HomePage', () => {
  it('opens with the hero illustration, served from the bundle', () => {
    renderHome()
    const hero = screen.getByRole('img', { name: /rocky surf/i })
    expect(hero.getAttribute('src')).toBe('/images/logo.png')
  })

  it('has exactly one h1, and it is the thesis — not a blank shell heading', () => {
    // AppShell suppresses its <h1> for an empty title; if that regresses, this page grows a
    // contentless heading above the hero and this count catches it.
    renderHome()
    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0]!.textContent).toMatch(/persistent dev boxes for coding agents/i)
  })

  it('names the five claims by their lead-ins', () => {
    renderHome()
    for (const claim of ['Persistent.', 'Yours.', 'Your cloud.', 'Agents preloaded.', 'Budget-capped.']) {
      expect(screen.getByText(claim)).toBeTruthy()
    }
  })

  it('links out: GitHub, Help, and creating a server', () => {
    // Scoped to main: the shell's navbar carries its own Help and GitHub links, and this test
    // is about the page offering its own ways out, not about the chrome.
    renderHome()
    const main = within(screen.getByRole('main'))
    expect(main.getByRole('link', { name: 'GitHub' }).getAttribute('href')).toBe(GITHUB_URL)
    expect(main.getByRole('link', { name: 'Help' }).getAttribute('href')).toBe('/help')
    expect(main.getByRole('link', { name: 'Create a server' }).getAttribute('href')).toBe('/servers/new')
  })
})
