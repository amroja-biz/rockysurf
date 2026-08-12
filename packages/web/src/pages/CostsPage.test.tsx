import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '../contexts/AuthContext'
import { EventsProvider } from '../contexts/EventsContext'
import type { CostsResponse } from '../lib/api'
import { CostsPage } from './CostsPage'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, getCosts: vi.fn() }
})

const { getCosts } = await import('../lib/api')

const base: CostsResponse = {
  monthToDate: { month: '2026-08', byCurrency: { USD: 12.5 }, unpricedServers: 0 },
  lifetime: { byCurrency: { USD: 40 } },
  limits: { maxServers: 5, spendCap: { amount: 50, currency: 'USD' } },
  cap: { overCap: false, amount: 50, currency: 'USD', fraction: 0.25 },
  servers: [
    {
      id: 'srv-a1b2c3',
      name: 'dev-box',
      provider: 'hetzner',
      status: 'running',
      totalUptimeSeconds: 7200,
      hourlyCost: { amount: 0.0216, currency: 'USD' },
      estimatedTotalCost: 12.5,
      currency: 'USD',
      pricedAt: '2026-08-12T00:00:00Z',
    },
  ],
  pricedAtByProvider: { hetzner: '2026-08-12T00:00:00Z' },
  estimateNote: 'Estimates only, and they round down.',
}

const renderPage = (costs: CostsResponse = base) => {
  vi.mocked(getCosts).mockResolvedValue(costs)
  return render(
    <MemoryRouter>
      <AuthProvider>
        <EventsProvider>
          <CostsPage />
        </EventsProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.mocked(getCosts).mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('CostsPage', () => {
  it('renders month-to-date, the cap and per-server costs', async () => {
    renderPage()

    expect(await screen.findByText('Costs')).toBeDefined()
    expect((screen.getByTestId('cap-summary')).textContent).toContain('$12.50')
    expect((screen.getByTestId('cap-summary')).textContent).toContain('$50.00')
    expect((screen.getByTestId('cost-row-srv-a1b2c3')).textContent).toContain('dev-box')
    expect((screen.getByTestId('cost-row-srv-a1b2c3')).textContent).toContain('2h 0m')
  })

  it('never shows a single cross-currency total', async () => {
    // A EUR project and a USD account cannot be added without inventing an exchange rate.
    renderPage({ ...base, monthToDate: { month: '2026-08', byCurrency: { USD: 10, EUR: 5 }, unpricedServers: 0 } })

    const list = await screen.findByTestId('mtd-by-currency')
    expect(list.children).toHaveLength(2)
    expect(list.textContent).toContain('$10.00')
    expect(list.textContent).toContain('€5.00')
    expect(list.textContent).not.toContain('15')
  })

  it('warns as the cap approaches and explains what being at it blocks', async () => {
    const { unmount } = renderPage({ ...base, cap: { ...base.cap, fraction: 0.85 } })
    expect(await screen.findByTestId('spend-cap-near')).toBeDefined()
    unmount()

    renderPage({ ...base, cap: { ...base.cap, fraction: 1.2, overCap: true } })
    const reached = await screen.findByTestId('spend-cap-reached')
    // The important half: running servers are NOT stopped, so the bill keeps growing.
    expect(reached.textContent).toMatch(/new servers are blocked/i)
    expect(reached.textContent).toMatch(/keep running/i)
  })

  it('says nothing about the cap when spend is comfortably under it', async () => {
    renderPage()
    await screen.findByTestId('cap-summary')
    expect(screen.queryByTestId('spend-cap-near')).toBeNull()
    expect(screen.queryByTestId('spend-cap-reached')).toBeNull()
  })

  it('explains how to set a cap when none is configured', async () => {
    renderPage({ ...base, limits: { maxServers: 5, spendCap: null }, cap: { overCap: false } })
    expect((await screen.findByTestId('no-cap')).textContent).toContain('limits.spendCap')
  })

  it('surfaces servers the provider quoted no price for', async () => {
    // A cap that silently ignores part of the fleet is worse than no cap.
    renderPage({ ...base, monthToDate: { ...base.monthToDate, unpricedServers: 2 } })
    expect((await screen.findByTestId('unpriced-warning')).textContent).toMatch(/not counted above, or against the cap/i)
  })

  it('states that estimates round down, and what they are based on', async () => {
    renderPage()
    expect((await screen.findByTestId('estimate-note')).textContent).toMatch(/round down/i)
    expect((screen.getByTestId('price-provenance')).textContent).toContain('2026-08-12')
    expect((screen.getByTestId('price-provenance')).textContent).toContain('hetzner')
  })

  it('carries no payment surface of any kind', async () => {
    // The acceptance criterion, asserted rather than eyeballed.
    const { container } = renderPage()
    await screen.findByText('Costs')
    const text = container.textContent?.toLowerCase() ?? ''
    for (const word of ['stripe', 'payment', 'card', 'invoice', 'subscription', 'billing', 'checkout']) {
      expect(text).not.toContain(word)
    }
  })

  it('shows an error rather than an empty page when the request fails', async () => {
    vi.mocked(getCosts).mockRejectedValue(new Error('nope'))
    render(
      <MemoryRouter>
        <AuthProvider>
          <EventsProvider>
            <CostsPage />
          </EventsProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('nope'))
  })

  /**
   * The shell's rule is that a new page appends its <Route> at the very END of <Routes>, after
   * the `path="*"` catch-all, so three concurrent additions never contend for a line. That
   * looks wrong — a catch-all above a specific path — so this pins the behaviour it relies on:
   * React Router ranks routes by specificity, not by source order.
   */
  it('resolves /costs even though its route is declared after the catch-all', async () => {
    vi.mocked(getCosts).mockResolvedValue(base)
    render(
      <MemoryRouter initialEntries={['/costs']}>
        <AuthProvider>
          <EventsProvider>
            <Routes>
              <Route path="*" element={<p>catch-all</p>} />
              <Route path="/costs" element={<CostsPage />} />
            </Routes>
          </EventsProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText('Costs')).toBeDefined()
    expect(screen.queryByText('catch-all')).toBeNull()
  })
})
