import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router'
import { describe, expect, it } from 'vitest'
import { ActivityFeed } from './ActivityFeed'
import type { ServerSummary } from '../lib/api'

/**
 * The recent-activity list is a way IN to a server's record, not a decoration (issue #125).
 *
 * The report, with a screenshot: the list shows boxes that have come and gone, each name
 * rendered in the link colour, and none of them clickable. A user watching their own history
 * had no way to ask what a terminated box actually was.
 *
 * These tests route the click rather than reading an `href`, because the bug was never a
 * missing attribute — it was that a name styled as a link went nowhere. What is pinned is that
 * the entry reaches the DETAIL ROUTE FOR THE RIGHT SERVER, including for a server whose machine
 * is long gone, which is the only kind of entry the issue is about.
 */

const BASE = {
  provider: 'fake',
  size: 'small' as const,
  offeringId: 'fake-small',
  arch: 'arm64' as const,
  status: 'terminated' as const,
  sshUser: 'rocky',
  bootstrapMode: 'push' as const,
  tools: [],
  repositories: [],
  totalUptimeSeconds: 0,
  estimatedTotalCost: 0,
}

/** A box that came and went: created, ran, and was terminated — three entries, one row. */
const GONE: ServerSummary = {
  ...BASE,
  serverId: 'srv-gone01',
  name: 'azure test1',
  createdAt: '2026-08-26T09:00:00.000Z',
  startedAt: '2026-08-26T09:02:00.000Z',
  terminatedAt: '2026-08-26T09:26:00.000Z',
}

/** A second row, so a click has to pick the right one rather than the only one. */
const LIVE: ServerSummary = {
  ...BASE,
  serverId: 'srv-live02',
  name: 'gcp rockysurf',
  status: 'running',
  createdAt: '2026-08-26T08:00:00.000Z',
}

/** Stands in for the detail page: it only has to prove which id the route received. */
function WhereAmI() {
  const { serverId = '' } = useParams()
  return <p>detail for {serverId}</p>
}

function renderFeed(servers: ServerSummary[]) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<ActivityFeed servers={servers} />} />
        <Route path="/servers/:serverId" element={<WhereAmI />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('a history entry', () => {
  it('opens the record of the server it names, terminated or not', () => {
    renderFeed([GONE, LIVE])

    // Three entries for the terminated box; each one is a link to the same record.
    const terminated = screen.getAllByRole('link', { name: 'azure test1' })
    expect(terminated).toHaveLength(3)
    for (const link of terminated) expect(link.getAttribute('href')).toBe('/servers/srv-gone01')

    fireEvent.click(terminated[0]!)
    expect(screen.getByText('detail for srv-gone01')).toBeTruthy()
  })

  it('sends each entry to its own server, not to whichever row was first', () => {
    renderFeed([GONE, LIVE])

    fireEvent.click(screen.getByRole('link', { name: 'gcp rockysurf' }))
    expect(screen.getByText('detail for srv-live02')).toBeTruthy()
  })

  it('still labels what happened and when, beside the link', () => {
    const { container } = renderFeed([GONE])
    // Newest first: the termination is the top entry.
    const first = container.querySelector('.activity-feed li')!
    expect(first.textContent).toContain('Terminated')
    expect(first.textContent).toContain('azure test1')
    expect(first.querySelector('time')?.getAttribute('datetime')).toBe(GONE.terminatedAt)
  })
})
