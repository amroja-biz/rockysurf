import { startStubServer, type StubServer } from '../test-server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthProvider } from '../contexts/AuthContext'
import { EventsProvider } from '../contexts/EventsContext'
import { setAuthToken } from '../lib/api'
import { ESTIMATE_HINT, UNPRICED_HINT } from '../lib/format'
import { DashboardPage } from './DashboardPage'
import { ServerDetailPage } from './ServerDetailPage'

/**
 * The list page's half of the stop/start affordance (rockysurf-4t8y).
 *
 * The pill and the buttons live on both pages, so the bug lived on both pages: a card whose
 * Start had been accepted sat reading "Stopped" for the length of an EC2 boot. The hook and the
 * badge are shared with `ServerDetailPage`, which is exactly why this file exists — shared
 * behaviour that is wired by hand into two components drifts in one of them, and the wiring is
 * what nothing else checks.
 *
 * Same construction as `ServerDetailPage.wiring.test.tsx` and for the same reason: a real HTTP
 * server, a real `EventSource`, the real providers, so nothing between the socket and the DOM
 * agrees with the test by construction. Deliberately narrow — the detail page's suite owns the
 * poll and the decay, which are the hook's behaviour and not this component's.
 */

const USER = { id: 'u1', username: 'admin', email: null, avatarUrl: null, isAdmin: true }
const SERVER_ID = 'srv-abc123'
const UNPRICED_ID = 'srv-def456'

/**
 * Every fixture below is written in CORE'S field names, checked against core's own `present()`
 * by the last test in this file.
 *
 * That is the whole of rockysurf-u6af: this fixture used to carry `uptime` and `estimatedCost`,
 * the old hosted API's names, because `ServerSummary` in `lib/api.ts` still declared them. Core
 * has never sent either. So the card read `undefined`, showed a dash for a box that had been
 * running for half an hour, and the test agreed with the page because both had been written
 * from the same wrong list.
 */
const BASE = {
  provider: 'fake',
  size: 'small',
  offeringId: 'fake-small',
  arch: 'arm64',
  sshUser: 'rocky',
  bootstrapMode: 'push',
  tools: [],
  repositories: [],
  createdAt: '2026-08-12T00:00:00.000Z',
}

/** One stopped box, which is the state a Start click starts from. */
const STOPPED = {
  ...BASE,
  serverId: SERVER_ID,
  name: 'dev-box',
  status: 'stopped',
  totalUptimeSeconds: 0,
  estimatedTotalCost: 0,
}

/** A running box with real accrual on it: 24m26s at 0.10 USD/hour, priced at create. */
const RUNNING = {
  ...BASE,
  serverId: SERVER_ID,
  name: 'dev-box',
  status: 'running',
  provisioningStep: 'ready',
  publicIp: '203.0.113.9',
  startedAt: '2026-08-12T00:00:00.000Z',
  hourlyCost: { amount: 0.1, currency: 'USD', fetchedAt: '2026-08-12T00:00:00Z' },
  totalUptimeSeconds: 1466,
  estimatedTotalCost: 0.0407,
}

/**
 * A running box core never priced — created before core priced anything, or on a provider that
 * quotes no rate. It accrues uptime exactly like any other running row (the uptime ticker does
 * not ask about price); only the cost is unknown.
 */
const UNPRICED = {
  ...RUNNING,
  serverId: UNPRICED_ID,
  name: 'hz-claw',
  hourlyCost: undefined,
  totalUptimeSeconds: 5400,
  estimatedTotalCost: 0,
}

/**
 * The owner's box, as core now serialises it (rockysurf-4byx): bootstrap failed on a repository
 * URL, so the row is `failed` — and the EC2 is still up, still metering, which is the design.
 * `billing` is core's own verdict, not a thing the card derives from a state string.
 */
const FAILED_BUT_BILLING = {
  ...RUNNING,
  status: 'failed',
  errorMessage: 'clone failed: repository not found',
  billing: {
    live: true,
    providerState: 'running',
    since: '2026-08-12T00:00:00.000Z',
    confirmedAt: '2026-08-12T00:24:26.000Z',
  },
}

const CAPABILITIES = {
  stop: true,
  ipStableAcrossStop: true,
  canInjectHostKeys: true,
  userDataMaxBytes: 32768,
  generatesUserData: true,
}

/** Matches `environmentOptions.jsdom.url` in vitest.config.ts. */

let stub: StubServer
let streams: Array<(chunk: string) => void> = []
let accepted: string[]
/** The rows the stub serves, so a test can start from the fleet it needs. */
let rows: Array<Record<string, unknown>>

beforeEach(async () => {
  streams = []
  accepted = []
  rows = [STOPPED]
  stub = await startStubServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (url.pathname === '/api/v1/auth/me') return json({ user: USER })
    if (url.pathname === '/api/v1/providers')
      return json([{ id: 'fake', displayName: 'Fake', capabilities: CAPABILITIES }])
    if (url.pathname === '/api/v1/surge-packs') return json([])
    if (url.pathname === '/api/v1/servers') return json(rows)

    // A slow cloud's answer: accepted, and the row still reads `stopped` because that is what
    // the provider still says (rockysurf-55fx.15).
    if (req.method === 'POST' && url.pathname === `/api/v1/servers/${SERVER_ID}/start`) {
      accepted.push('start')
      return json(rows[0])
    }

    // The list and the detail page are served the SAME row, which is what makes "both pages
    // agree" a fact about the pages rather than about two fixtures.
    const detail = rows.find((candidate) => url.pathname === `/api/v1/servers/${candidate['serverId'] as string}`)
    if (detail) return json(detail)

    if (url.pathname === '/api/v1/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(`event: connected\ndata: ${JSON.stringify({ userId: USER.id })}\n\n`)
      streams.push((chunk) => res.write(chunk))
      return
    }

    res.writeHead(404).end()
  })

})

afterEach(async () => {
  setAuthToken(null)
  streams = []
  await stub.close()
})

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <EventsProvider>
          <DashboardPage />
        </EventsProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

function renderDetail(serverId: string) {
  return render(
    <MemoryRouter initialEntries={[`/servers/${serverId}`]}>
      <AuthProvider>
        <EventsProvider>
          <Routes>
            <Route path="/servers/:serverId" element={<ServerDetailPage />} />
          </Routes>
        </EventsProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

const pill = (container: HTMLElement) => container.querySelector('.status-badge')!

/** The card for a named server, and one labelled value out of its `dl`. */
function cardFor(container: HTMLElement, name: string): HTMLElement {
  const card = [...container.querySelectorAll('.server-card')].find(
    (candidate) => candidate.querySelector('h3')?.textContent === name,
  )
  expect(card, `no card for ${name}`).toBeTruthy()
  return card as HTMLElement
}

function value(scope: HTMLElement, label: string): HTMLElement {
  const term = [...scope.querySelectorAll('dt')].find((dt) => dt.textContent === label)
  expect(term, `no "${label}" on this card`).toBeTruthy()
  return term!.nextElementSibling as HTMLElement
}

describe('a card whose start the provider has not finished', () => {
  it('reads Starting… from the accepted response, and Running when core confirms it', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(accepted).toEqual(['start']))
    await waitFor(() => expect(pill(container).textContent).toBe('Starting…'))

    // The row is untouched underneath: `data-status` is what core reported and nothing else.
    expect(pill(container).getAttribute('data-status')).toBe('stopped')
    expect(screen.getByRole('button', { name: 'Terminate' }).hasAttribute('disabled')).toBe(true)

    await waitFor(() => expect(streams.length).toBeGreaterThan(0))
    await waitFor(() => {
      streams.forEach((write) =>
        write(
          `event: message\ndata: ${JSON.stringify({
            type: 'server-status',
            serverId: SERVER_ID,
            status: 'running',
            publicIp: '203.0.113.7',
          })}\n\n`,
        ),
      )
      expect(pill(container).textContent).toBe('Running')
    })
    expect(pill(container).getAttribute('data-transition')).toBeNull()
  })
})

/**
 * What the card says about a box that is up and costing money (rockysurf-u6af).
 *
 * The owner's dashboard showed "Uptime —" for two running servers, one of them 24 minutes old,
 * while the detail page for the same box read its uptime correctly. Nothing was wrong on the
 * server: the row had the seconds, `GET /api/v1/servers` serialised them, and the ticker had
 * been accruing them all along — the card was reading a field name core does not send.
 */
describe('the uptime and cost a running card reports', () => {
  it('renders the seconds core accrued, and the cost with its estimate caveat', async () => {
    rows = [RUNNING]
    const { container } = renderPage()

    await waitFor(() => expect(cardFor(container, 'dev-box')).toBeTruthy())
    const card = cardFor(container, 'dev-box')

    // 1466s. Not a dash, which is what a real box's card showed for its whole life.
    expect(value(card, 'Uptime').textContent).toBe('24m')
    expect(value(card, 'Cost').textContent).toBe('$0.04')
    expect(value(card, 'Cost').getAttribute('title')).toBe(ESTIMATE_HINT)
  })

  it('agrees with the detail page, which is served the same row', async () => {
    rows = [RUNNING]
    const list = renderPage()
    await waitFor(() => expect(cardFor(list.container, 'dev-box')).toBeTruthy())
    const onTheCard = value(cardFor(list.container, 'dev-box'), 'Uptime').textContent
    list.unmount()

    const detail = renderDetail(SERVER_ID)
    await waitFor(() => expect(detail.container.querySelector('.server-summary')).toBeTruthy())
    const summary = detail.container.querySelector('.server-summary') as HTMLElement

    // The two pages read the same field through the same formatter, so this is one string in
    // two places rather than two implementations that happen to match today.
    expect(value(summary, 'Uptime').textContent).toBe(onTheCard)
    expect(value(summary, 'Estimated cost').textContent).toBe('$0.04')
  })

  it('says 0s for a box promoted a moment ago, because zero accrued is a fact', async () => {
    rows = [{ ...RUNNING, totalUptimeSeconds: 0, estimatedTotalCost: 0 }]
    const { container } = renderPage()

    await waitFor(() => expect(cardFor(container, 'dev-box')).toBeTruthy())
    const card = cardFor(container, 'dev-box')
    // A dash would mean "core did not tell us", and it did. The cost is a known 0.00 of a known
    // currency, not an unknown — the row carries a price.
    expect(value(card, 'Uptime').textContent).toBe('0s')
    expect(value(card, 'Cost').textContent).toBe('$0.00')
  })

  it('explains the dash on a row core never priced, and still shows its uptime', async () => {
    rows = [UNPRICED]
    const { container } = renderPage()

    await waitFor(() => expect(cardFor(container, 'hz-claw')).toBeTruthy())
    const card = cardFor(container, 'hz-claw')

    // Uptime accrues whether or not there is a rate to multiply it by, so an unpriced box is
    // still visibly up — only its cost is unknown, and the cell now says why.
    expect(value(card, 'Uptime').textContent).toBe('1h 30m')
    expect(value(card, 'Cost').textContent).toBe('—')
    expect(value(card, 'Cost').getAttribute('title')).toBe(UNPRICED_HINT)
  })
})

/**
 * A failed box that is still costing money says so, on both pages (rockysurf-4byx).
 *
 * The owner's live test: a repository-URL typo failed the clone, the row went `failed`, and the
 * instance stayed up — by design, so the box can be logged into and diagnosed. What the card
 * then showed was `Uptime 0s / Estimated cost $0.00`, because the uptime ticker only ever walked
 * `status = 'running'`. The numbers below are the fix's whole point: they are non-zero, and the
 * sentence beside them explains why a FAILED server has them.
 */
describe('a failed row whose machine is still running', () => {
  it('shows the accrued uptime and cost, and says why a failed box has any', async () => {
    rows = [FAILED_BUT_BILLING]
    const { container } = renderPage()

    await waitFor(() => expect(cardFor(container, 'dev-box')).toBeTruthy())
    const card = cardFor(container, 'dev-box')

    expect(pill(container).textContent).toBe('Failed')
    expect(value(card, 'Uptime').textContent).toBe('24m')
    expect(value(card, 'Cost').textContent).toBe('$0.04')

    const notice = card.querySelector('.still-billing-notice')!
    expect(notice, 'the card must say the machine is still billing').toBeTruthy()
    expect(notice.textContent).toContain('still running, and still billing')
    // Both ways out, because the box is kept for the second one.
    expect(notice.textContent).toContain('Terminate')
    expect(notice.textContent).toContain('diagnose')
    // And the action it names is actually on the card.
    expect(screen.getByRole('button', { name: 'Terminate' })).toBeTruthy()
  })

  it('shows the failure reason on the card itself, not only on the detail page', async () => {
    rows = [FAILED_BUT_BILLING]
    const { container } = renderPage()

    await waitFor(() => expect(cardFor(container, 'dev-box')).toBeTruthy())
    const card = cardFor(container, 'dev-box')

    // The row carried `errorMessage` all along — `present()` sends it to list and detail alike —
    // and only the detail page rendered it (rockysurf-edbf). The card is the page the user is on
    // when the pill goes red, and "diagnose" beside a reasonless red pill is a weak instruction.
    const reason = card.querySelector('[role="alert"]')
    expect(reason, 'the failed card must render the failure reason').toBeTruthy()
    expect(reason!.textContent).toBe('clone failed: repository not found')
  })

  it('says nothing of the kind on a healthy running box', async () => {
    rows = [RUNNING]
    const { container } = renderPage()

    await waitFor(() => expect(cardFor(container, 'dev-box')).toBeTruthy())
    const card = cardFor(container, 'dev-box')
    // `status: running` already tells the user the machine is up. A second banner saying so on
    // every card is noise, and noise is what stops the real one being read.
    expect(card.querySelector('.still-billing-notice')).toBeNull()
    // And a row with no `errorMessage` grows no alert — the reason line is for failed boxes only.
    expect(card.querySelector('[role="alert"]')).toBeNull()
  })

  it('adds the anchor caveat on the detail page, where there is room to be exact', async () => {
    rows = [FAILED_BUT_BILLING]
    const detail = renderDetail(SERVER_ID)
    await waitFor(() => expect(detail.container.querySelector('.server-summary')).toBeTruthy())

    const notice = detail.container.querySelector('.still-billing-notice')!
    expect(notice).toBeTruthy()
    // The honesty the column's own comment promises: the estimate counts from when core
    // CONFIRMED the machine was billing, not from when the provider started charging.
    expect(notice.textContent).toContain('Counting from')
    expect(notice.textContent).toContain('not in the estimate')
    // The failure reason is on the same page, which is what makes "diagnose" an option.
    expect(detail.container.textContent).toContain('clone failed: repository not found')
  })
})

/**
 * The guard that would have caught this at HEAD, in the shape `ServerDetailPage.wiring.test.tsx`
 * already uses for the status and step vocabularies: read core's own source rather than restate
 * it here.
 *
 * `request<Server[]>` ASSERTS a shape over a socket; it does not check one. So a field the SPA
 * declares and core does not send is `undefined` at runtime with nothing — not the compiler, not
 * a test — objecting, all the way to a dash on a card. Reading the key list out of `present()`
 * makes that a failure in the package that would otherwise render it.
 */
describe("the row shape the SPA declares", () => {
  function corePresentKeys(): string[] {
    const relative = '../../../core/src/servers/routes.ts'
    const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
    // Everything before the `return` is matched loosely on purpose: `present()` grew a second
    // argument and a local when it started reporting the box's token scopes (rockysurf-18lq),
    // and this guard is about the KEYS it returns. Pinning its signature or its body would make
    // it fail for reasons it does not check — which is what happened.
    const body = /function present\(row: ServerRow[\s\S]*?\n {2}return \{([\s\S]*?)\n {2}\}\n\}/.exec(source)
    expect(body, 'could not find present() in core/src/servers/routes.ts').toBeTruthy()
    // Exactly four spaces: the nested `hourlyCost` object's own keys are deeper and are not
    // fields of the row.
    const keys = [...body![1]!.matchAll(/^ {4}(\w+):/gm)].map((match) => match[1]!)
    expect(keys.length).toBeGreaterThan(10)
    return keys
  }

  function declaredFields(): string[] {
    // Path through a variable, not a literal: Vite rewrites a literal `new URL(..., import.meta
    // .url)` into an asset URL, which is an http one under jsdom and not a file to read. Same
    // dodge as the core path above and as `ServerDetailPage.wiring.test.tsx`.
    const relative = '../lib/api.ts'
    const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
    const block = /export interface Server \{([\s\S]*?)\n\}/.exec(source)
    expect(block, 'could not find the Server interface in lib/api.ts').toBeTruthy()
    const fields = [...block![1]!.matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1]!)
    expect(fields.length).toBeGreaterThan(10)
    return fields
  }

  it('is only fields core actually sends', () => {
    const sent = corePresentKeys()
    expect(declaredFields().filter((field) => !sent.includes(field))).toEqual([])
  })

  it('and so are the fixtures in this file', () => {
    const sent = corePresentKeys()
    for (const row of [STOPPED, RUNNING, UNPRICED, FAILED_BUT_BILLING]) {
      expect(Object.keys(row).filter((key) => !sent.includes(key))).toEqual([])
    }
  })
})
