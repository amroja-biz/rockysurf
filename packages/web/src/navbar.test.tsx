import { render, screen, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ComponentType } from 'react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AdminSurgePacksPage } from './pages/AdminSurgePacksPage'
import { AdminToolsPage } from './pages/AdminToolsPage'
import { CostsPage } from './pages/CostsPage'
import { CreateServerPage } from './pages/CreateServerPage'
import { DashboardPage } from './pages/DashboardPage'
import { HelpPage } from './pages/HelpPage'
import { HomePage } from './pages/HomePage'
import { ServerDetailPage } from './pages/ServerDetailPage'
import { SettingsPage } from './pages/SettingsPage'

/**
 * EVERY AUTHENTICATED PAGE CARRIES THE NAVBAR — and a new page cannot quietly opt out.
 *
 * Three pages shipped without it (Costs, pack admin, create), which is what rockysurf-k72k
 * fixed. The interesting half of that bug is not the three pages: it is that nothing could
 * have told anyone. Each page rendered its own `<main>`, every unit test rendered that page
 * standalone and passed, and the missing navigation was only ever visible to a human in a
 * browser.
 *
 * So this file asserts two things, and the second is the one that lasts:
 *
 *  1. each authenticated page renders the shell's navigation — while it is still loading AND
 *     once its data has settled, because a page can be wrapped in one state and not the other
 *     (`CostsPage` returned a bare `<p>` while loading, inside the shell after);
 *  2. the list below covers every page `App.tsx` routes to. Add a route without adding it
 *     here and the coverage case fails by name, so the next page is checked by default rather
 *     than by memory.
 *
 * The scan reads route elements out of `App.tsx` source. It relies on the convention that page
 * components are named `*Page`, which every one of them is; a route element that names no
 * `*Page` component fails the last case rather than slipping past.
 */

/* --------------------------------------------------------------------------------- mocks */

vi.mock('./contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'admin', isAdmin: true }, logout: vi.fn() }),
}))
vi.mock('./contexts/EventsContext', () => ({
  useEvents: () => ({ subscribe: () => () => {}, connectionStatus: 'connected' }),
}))
vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  Toaster: () => null,
}))

vi.mock('./lib/api', async () => {
  const actual = await vi.importActual<typeof import('./lib/api')>('./lib/api')
  return {
    ...actual,
    listServers: vi.fn(),
    getServer: vi.fn(),
    getCosts: vi.fn(),
    listProviders: vi.fn(),
    listSurgePacks: vi.fn(),
    getSetupState: vi.fn(),
    listAdminTools: vi.fn(),
    listAdminSurgePacks: vi.fn(),
    getSettings: vi.fn(),
  }
})

const api = await import('./lib/api')

const COSTS = {
  monthToDate: { month: '2026-08', byCurrency: {}, unpricedServers: 0 },
  lifetime: { byCurrency: {} },
  limits: { maxServers: 5 },
  cap: { overCap: false },
  servers: [],
  pricedAtByProvider: {},
  estimateNote: 'Estimates only.',
} as unknown as Awaited<ReturnType<typeof api.getCosts>>

beforeEach(() => {
  vi.mocked(api.listServers).mockResolvedValue([])
  // The detail page has no server to show here; its error state is inside the shell too, which
  // is the point — a page must not shed its navigation exactly when something went wrong.
  vi.mocked(api.getServer).mockRejectedValue(new Error('no such server'))
  vi.mocked(api.getCosts).mockResolvedValue(COSTS)
  vi.mocked(api.listProviders).mockResolvedValue([])
  vi.mocked(api.listSurgePacks).mockResolvedValue([])
  vi.mocked(api.getSetupState).mockResolvedValue({ complete: true, needsProvider: false, providers: [] })
  vi.mocked(api.listAdminTools).mockResolvedValue([])
  vi.mocked(api.listAdminSurgePacks).mockResolvedValue([])
  // Settings fails to read here, which is the interesting state for this file: a page must not
  // shed its navigation exactly when it could not load.
  vi.mocked(api.getSettings).mockRejectedValue(new Error('no config file'))
})

/* ------------------------------------------------------------------------------- the pages */

/** Every page `App.tsx` mounts behind authentication, by the name it has in that file. */
const AUTHENTICATED_PAGES: Record<string, ComponentType> = {
  DashboardPage,
  CreateServerPage,
  ServerDetailPage,
  SettingsPage,
  AdminToolsPage,
  AdminSurgePacksPage,
  CostsPage,
  HomePage,
  HelpPage,
}

/**
 * Pages that are routed but deliberately outside the shell, each with its reason.
 *
 * Listing them here rather than omitting them is what keeps the exception honest: an exception
 * nobody wrote down becomes the next page's precedent.
 */
const OUTSIDE_THE_SHELL: Record<string, string> = {
  LoginPage: 'nobody is signed in, so there is nothing to navigate to and no user to name',
  WizardPage: 'first run — the shell links to pages that cannot work until setup finishes',
}

/** Let every mocked request settle, so the page's loaded state is what is on screen. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('the navbar is on every authenticated page', () => {
  for (const [pageName, Page] of Object.entries(AUTHENTICATED_PAGES)) {
    it(`${pageName} renders the shell navigation, loading and loaded`, async () => {
      render(
        <MemoryRouter initialEntries={['/servers/srv-abc']}>
          <Page />
        </MemoryRouter>,
      )

      // While the page is still fetching.
      expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy()
      expect(screen.getByRole('link', { name: 'Servers' })).toBeTruthy()

      await settle()

      // And once it has whatever it was waiting for — or failed to get it.
      expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy()
      expect(screen.getByRole('link', { name: 'Servers' })).toBeTruthy()
    })
  }

  it('links to every authenticated destination, including Costs', async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    )
    await settle()

    for (const [name, href] of [
      ['Servers', '/'],
      ['New', '/servers/new'],
      // Costs was reachable only by typing the URL until rockysurf-k72k.
      ['Costs', '/costs'],
      ['Tools', '/admin/tools'],
      ['Surge Packs', '/admin/surge-packs'],
      ['Settings', '/settings'],
      ['Help', '/help'],
      // The brand mark, whose accessible name is its wordmark.
      ['Rocky Surf', '/home'],
    ] as const) {
      expect(screen.getByRole('link', { name }).getAttribute('href')).toBe(href)
    }
  })
})

describe('the list above covers what App.tsx actually routes to', () => {
  // Through a variable, not a literal: Vite statically rewrites `new URL('./literal',
  // import.meta.url)` into an asset URL, which is an http one under jsdom and not a file to
  // read. The same dodge is in `CreateServerPage.test.tsx`.
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  const source = read('./App.tsx')
  /** Route elements only — the `<Routes>` block, so imports and prose do not count. */
  const routes = source.slice(source.indexOf('<Routes>'), source.indexOf('</Routes>'))
  const routed = new Set([...routes.matchAll(/<([A-Z][A-Za-z0-9]*Page)\b/g)].map((m) => m[1]!))

  it('checks every routed page, or names it as a deliberate exception', () => {
    const accounted = new Set([...Object.keys(AUTHENTICATED_PAGES), ...Object.keys(OUTSIDE_THE_SHELL)])
    const unaccounted = [...routed].filter((name) => !accounted.has(name))
    expect(
      unaccounted,
      `App.tsx routes to ${unaccounted.join(', ')}, which this file neither checks for a navbar ` +
        'nor lists in OUTSIDE_THE_SHELL. Add it to one of them.',
    ).toEqual([])
  })

  it('carries no page in its list that App.tsx stopped routing to', () => {
    const stale = Object.keys(AUTHENTICATED_PAGES).filter((name) => !routed.has(name))
    expect(stale, `${stale.join(', ')} is checked here but no longer routed`).toEqual([])
  })

  it('finds a page component in every route element, so none escapes the scan by naming', () => {
    const elements = [...routes.matchAll(/element=\{([\s\S]*?)\}\s*\/>/g)].map((m) => m[1]!)
    expect(elements.length).toBeGreaterThan(0)
    for (const element of elements) {
      expect(element, `no *Page component in route element: ${element.trim()}`).toMatch(/[A-Z][A-Za-z0-9]*Page/)
    }
  })
})
