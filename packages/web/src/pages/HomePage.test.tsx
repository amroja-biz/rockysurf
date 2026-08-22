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
 *
 * The page also carries the README verbatim, so the section spine is pinned too: an editor who
 * drops a section here has dropped it from one of the two copies that are meant to be the same
 * document, and that is the failure worth catching early.
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

  it('has exactly one h1, and it is the tagline — not a blank shell heading', () => {
    // AppShell suppresses its <h1> for an empty title; if that regresses, this page grows a
    // contentless heading above the hero and this count catches it.
    renderHome()
    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0]!.textContent).toMatch(/need their own space\?/i)
  })

  it('names the BYO trio by their lead-ins', () => {
    renderHome()
    for (const claim of [
      'BYOC — bring your own cloud.',
      'BYOK — bring your own keys.',
      'BYOR — bring your own repos.',
    ]) {
      expect(screen.getByText(claim)).toBeTruthy()
    }
  })

  it('carries the README spine, in order', () => {
    renderHome()
    const sections = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(sections).toEqual([
      'Bring your own cloud, keys and repos',
      'Five principles',
      'Install',
      'Creating a server',
      'Where your servers and settings are kept',
      'Put a safety net under your cloud account',
      'More',
      'License',
    ])
  })

  it('states all five principles', () => {
    renderHome()
    for (const principle of [
      /create and manage cloud servers for agentic coding/i,
      /add a new cloud provider/i,
      /create Surge Packs/i,
      /extend via modular components/i,
      /combine components without coding/i,
    ]) {
      expect(screen.getByText(principle)).toBeTruthy()
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
