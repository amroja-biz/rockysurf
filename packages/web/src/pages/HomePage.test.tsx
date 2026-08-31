import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { GITHUB_URL, SHOP_URL, repoDocUrl } from '../lib/links'
import { HomePage } from './HomePage'

/**
 * The home page (issue #266): the hero, the thesis, and the links that make it a front door
 * rather than a dead end. Content phrasing is free to change; what is pinned here is the
 * structure a reader relies on — one real heading, the hero pointing at a path the bundle
 * carries (bundle-assets.test.ts owns the other half of that claim), the BYO trio, the two
 * stories, and the three ways out.
 *
 * Issue #16 made this page a verbatim README. #266 split them: this is the pitch, the README
 * is the operator document. The section spine is pinned so an editor who drops BYOC or the
 * shop story has dropped what the issue asked the front door to say.
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
    // By its subject, not the brand name: the nav's brand lockup is also an image named
    // "Rocky Surf".
    const hero = screen.getByRole('img', { name: /lighthouse/i })
    expect(hero.getAttribute('src')).toBe('/images/logo.png')
  })

  it('has exactly one h1, and it says what the product is — not a blank shell heading', () => {
    // AppShell suppresses its <h1> for an empty title; if that regresses, this page grows a
    // contentless heading above the hero and this count catches it.
    renderHome()
    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0]!.textContent).toMatch(/coding agents to move off your laptop/i)
  })

  it('calls itself an open-source personal tool, not a hosted service', () => {
    renderHome()
    const main = screen.getByRole('main')
    expect(main.textContent).toMatch(/open-source personal productivity tool/i)
    expect(main.textContent).toMatch(/No accounts, no telemetry, no SaaS/)
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

  it('carries the pitch spine, in order', () => {
    renderHome()
    const sections = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(sections).toEqual([
      'Bring your own cloud, keys and repos',
      'Creating a server',
      'A pack of your own',
      'Room to work',
    ])
  })

  it('names the four clouds a create can use, a Surge Pack, and a GitHub repo', () => {
    renderHome()
    const create = screen.getByRole('heading', { name: 'Creating a server' }).closest('section')
    expect(create).toBeTruthy()
    const text = create!.textContent ?? ''
    for (const cloud of ['AWS', 'GCP', 'Azure', 'Hetzner']) {
      expect(text).toContain(cloud)
    }
    expect(text).toMatch(/Surge Pack/)
    expect(text).toMatch(/public or private/)
    expect(text).toMatch(/Create, stop, start, and terminate/)
  })

  it('points at the pack skill and the shop', () => {
    renderHome()
    expect(
      screen.getByRole('link', { name: 'create-surge-pack' }).getAttribute('href'),
    ).toBe(repoDocUrl('.claude/skills/create-surge-pack/SKILL.md'))
    expect(screen.getByRole('link', { name: 'Rocky Surf Shop' }).getAttribute('href')).toBe(
      SHOP_URL,
    )
  })

  it('links out: GitHub, Help, and creating a server', () => {
    // Scoped to main: the shell's navbar carries its own Help and GitHub links, and this test
    // is about the page offering its own ways out, not about the chrome.
    renderHome()
    const main = within(screen.getByRole('main'))
    expect(main.getByRole('link', { name: 'GitHub' }).getAttribute('href')).toBe(GITHUB_URL)
    expect(main.getByRole('link', { name: /^Help$/ }).getAttribute('href')).toBe('/help')
    expect(main.getByRole('link', { name: 'Create a server' }).getAttribute('href')).toBe(
      '/servers/new',
    )
  })
})
