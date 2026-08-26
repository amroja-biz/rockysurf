import { startStubServer, type StubServer } from '../test-server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

/**
 * The other ending ADR-0010 gives a failed row, and the one this page got wrong (issue #154).
 *
 * A TOOL install failed, so core released the machine BEFORE failing the row: there is no
 * `billing` block, and the report says in words what happened to the instance. Nothing is left
 * to terminate — the click only clears the row — which is why the button reads Dismiss.
 */
const FAILED_AND_RELEASED = {
  ...RUNNING,
  status: 'failed',
  billing: undefined,
  errorMessage:
    'Deliberate apt failure could not be installed. Rocky Surf terminated the machine, so it is not billing.',
  bootstrapReport: {
    failure: {
      stepId: 'tool:deliberate-apt-failure',
      phase: 'tool',
      label: 'Deliberate apt failure',
      exitCode: 100,
      cause: 'apt',
      summary: 'Deliberate apt failure could not be installed.',
      keyLines: ['E: Unable to locate package rockysurf-deliberately-missing-package'],
      log: 'E: Unable to locate package rockysurf-deliberately-missing-package',
      logComplete: true,
      instance: 'terminated',
      instanceNote: 'Rocky Surf terminated the machine, so it is not billing.',
    },
    warnings: [],
  },
}

/**
 * A row whose provider could not be asked (rockysurf-gg9x): core served what it last knew and
 * put the provider's own message — remedy included — beside it. The status and address on this
 * row are last-known state, not fresh facts.
 */
const STALE = {
  ...RUNNING,
  syncError: 'could not obtain Google Cloud credentials. Run `gcloud auth application-default login`.',
}

/** A second cloud, so "grouped by provider" (issue #121) is a claim with two sides to it. */
const ON_ANOTHER_CLOUD = { ...RUNNING, serverId: 'srv-other', name: 'other-box', provider: 'other' }

/**
 * A box on a cloud the provider list does not carry — a bring-your-own machine, or a provider
 * the operator has since removed from their config. The row is still real and must still be on
 * the page; there is simply no display name to put over it.
 */
const ON_AN_UNLISTED_CLOUD = { ...RUNNING, serverId: 'srv-byo', name: 'byo-box', provider: 'byo' }

/** And the degenerate case: a row that names no provider at all. */
const ON_NO_CLOUD = { ...RUNNING, serverId: 'srv-none', name: 'nameless-box', provider: '' }

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
/** The public pack list — empty by default, like every other test in this file assumes. */
let packs: Array<Record<string, unknown>>

beforeEach(async () => {
  streams = []
  accepted = []
  rows = [STOPPED]
  packs = []
  stub = await startStubServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (url.pathname === '/api/v1/auth/me') return json({ user: USER })
    // Two configured clouds, because the grouping this page does (issue #121) is only a real
    // question once there is more than one — and because a display name is only demonstrably
    // looked up per group when the two names differ.
    if (url.pathname === '/api/v1/providers')
      return json([
        { id: 'fake', displayName: 'Fake', capabilities: CAPABILITIES },
        { id: 'other', displayName: 'Another Cloud', capabilities: CAPABILITIES },
      ])
    if (url.pathname === '/api/v1/surge-packs') return json(packs)
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

const pill = (container: HTMLElement) => container.querySelector('.lamp')!

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

  it('keeps the whole reason on the element it folds, so the truncation loses nothing (issue #128)', async () => {
    // A provider's refusal can be a page of prose — Azure's quota message is nine sentences and
    // three URLs — and the card shows its first lines so one bad row does not become a card
    // thirty times the height of the one beside it. The text itself stays in the DOM for a
    // screen reader, and in `title` for a hover; the detail page renders the account in full.
    const reason = 'quota: ' + 'https://aka.ms/ProdportalCRP/#blade/Microsoft_Azure_Capacity/'.repeat(6)
    rows = [{ ...FAILED_BUT_BILLING, errorMessage: reason }]
    const { container } = renderPage()

    await waitFor(() => expect(cardFor(container, 'dev-box')).toBeTruthy())
    const alert = cardFor(container, 'dev-box').querySelector('[role="alert"]')!
    expect(alert.textContent).toBe(reason)
    expect(alert.getAttribute('title')).toBe(reason)
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
 * A FAILED ROW WHOSE MACHINE CORE ALREADY RELEASED (ADR-0010, issue #154).
 *
 * The report: a box whose tool install failed offered **Dismiss** on the detail page and
 * **Terminate** on its card — for the same row, at the same moment. The rule lived only on the
 * detail page; the card switched on `status` alone and always said Terminate. Both halves are
 * pinned here, because "does this machine still exist" has two answers and a card that got the
 * second one right by accident would still be wrong on the first.
 */
describe('the destructive button a failed card offers', () => {
  /**
   * Scoped to the card, because `StaleServersNotice` above the list has a Dismiss of its own
   * (issue #149) and a page-wide query would answer with the wrong button.
   */
  const buttonOn = (card: HTMLElement, name: string) => within(card).queryByRole('button', { name })

  it('says Dismiss when core released the machine, because nothing is left to terminate', async () => {
    rows = [FAILED_AND_RELEASED]
    const { container } = renderPage()

    await waitFor(() => expect(cardFor(container, 'dev-box')).toBeTruthy())
    const card = cardFor(container, 'dev-box')
    expect(pill(container).textContent).toBe('Failed')
    // The row has no `billing` block, and the card says so by not showing the notice...
    expect(card.querySelector('.still-billing-notice')).toBeNull()
    // ...and by not offering to destroy a machine that is already gone.
    expect(buttonOn(card, 'Dismiss')).toBeTruthy()
    expect(buttonOn(card, 'Terminate')).toBeNull()
  })

  it('warns that the click only clears the row, rather than that it destroys a disk', async () => {
    rows = [FAILED_AND_RELEASED]
    const { container } = renderPage()

    await waitFor(() => expect(cardFor(container, 'dev-box')).toBeTruthy())
    fireEvent.click(buttonOn(cardFor(container, 'dev-box'), 'Dismiss')!)

    expect(screen.getByText('Dismiss dev-box?')).toBeTruthy()
    expect(screen.getByText(/clears the failed server and its report/)).toBeTruthy()
    // The terminate warning would be a lie here: there is no disk left to destroy.
    expect(screen.queryByText(/destroys the server and its disk/)).toBeNull()
  })

  it('still says Terminate when the failure KEPT the machine, which is still billing', async () => {
    // The #138 guard, from the other side: a non-tool failure (or `onFailure: keep`) leaves a
    // machine up and metering, and Dismiss on that row would hide a running bill behind a word
    // that means "this is over".
    rows = [FAILED_BUT_BILLING]
    const { container } = renderPage()

    await waitFor(() => expect(cardFor(container, 'dev-box')).toBeTruthy())
    const card = cardFor(container, 'dev-box')
    expect(buttonOn(card, 'Terminate')).toBeTruthy()
    expect(buttonOn(card, 'Dismiss')).toBeNull()
  })

  it('agrees with the detail page, which is served the same row', async () => {
    rows = [FAILED_AND_RELEASED]
    const list = renderPage()
    await waitFor(() => expect(buttonOn(cardFor(list.container, 'dev-box'), 'Dismiss')).toBeTruthy())
    list.unmount()

    // One rule in `lib/serverActions.ts`, asked by both pages, so this is one string in two
    // places rather than two implementations that happen to match today — which is exactly
    // what they did not do at HEAD.
    const detail = renderDetail(SERVER_ID)
    await waitFor(() => expect(detail.container.querySelector('.server-actions')).toBeTruthy())
    const actions = detail.container.querySelector('.server-actions') as HTMLElement
    expect(within(actions).getByRole('button', { name: 'Dismiss' })).toBeTruthy()
    expect(within(actions).queryByRole('button', { name: 'Terminate' })).toBeNull()
  })

  it('re-reads the row on the failed frame, so a card built while the box billed catches up', async () => {
    // While the box was building, core reported it as billing — the truth at the time.
    rows = [{ ...RUNNING, status: 'provisioning', billing: FAILED_BUT_BILLING.billing }]
    const { container } = renderPage()
    await waitFor(() => expect(cardFor(container, 'dev-box')).toBeTruthy())

    // Then the tool install failed, core released the machine, and the row lost its billing
    // block. The frame core broadcasts carries the status and nothing else.
    rows = [FAILED_AND_RELEASED]
    await waitFor(() => expect(streams.length).toBeGreaterThan(0))
    await waitFor(() => {
      streams.forEach((write) =>
        write(
          `event: message\ndata: ${JSON.stringify({
            type: 'server-status',
            serverId: SERVER_ID,
            status: 'failed',
          })}\n\n`,
        ),
      )
      // Patched from the frame alone the card would still hold the provisioning-time billing
      // block, keep the still-billing notice, and label the button "Terminate".
      expect(buttonOn(cardFor(container, 'dev-box'), 'Dismiss')).toBeTruthy()
    })
    const card = cardFor(container, 'dev-box')
    expect(card.querySelector('.still-billing-notice')).toBeNull()
    expect(buttonOn(card, 'Terminate')).toBeNull()
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
/**
 * The dashboard over a cloud that cannot be asked (rockysurf-gg9x).
 *
 * The report: expired GCP application-default credentials turned the whole page into "Could
 * not load your servers" — healthy rows hidden, and the one message naming the fix visible
 * only in a 500 body nobody rendered. Core now degrades the read; what these pin is the other
 * half, that the SPA actually SHOWS the remedy instead of filing it away.
 */
describe('a provider whose credentials expired (rockysurf-gg9x)', () => {
  it('shows one notice per provider with the remedy core relayed, and keeps the cards', async () => {
    // Two stale rows on the same cloud: the cause is per-provider, so the explanation is too.
    rows = [STALE, { ...STALE, ...UNPRICED, syncError: STALE.syncError }]
    const { container } = renderPage()

    await waitFor(() => expect(screen.queryAllByTestId('sync-error-fake')).toHaveLength(1))
    const notice = screen.getByTestId('sync-error-fake')
    // The provider's displayName, from the same source every other page uses...
    expect(notice.textContent).toContain('Fake')
    // ...and the remedy verbatim — for an expired login, the exact command to run.
    expect(notice.textContent).toContain('gcloud auth application-default login')
    // The rows still render as cards: stale is a caveat, not a blank page.
    expect(cardFor(container, 'dev-box')).toBeTruthy()
    expect(cardFor(container, 'hz-claw')).toBeTruthy()
  })

  it('says nothing of the kind when every row is fresh', async () => {
    rows = [RUNNING]
    const { container } = renderPage()
    await waitFor(() => expect(cardFor(container, 'dev-box')).toBeTruthy())
    expect(screen.queryByTestId('sync-error-fake')).toBeNull()
  })

  it('carries the same caveat on the detail page, above the facts it qualifies', async () => {
    rows = [STALE]
    renderDetail(SERVER_ID)
    const notice = await screen.findByTestId('sync-error')
    expect(notice.textContent).toContain('last known state')
    expect(notice.textContent).toContain('gcloud auth application-default login')
  })
})

/**
 * Which cloud a box is on, and when it was created (issue #121).
 *
 * The report: "the servers page lists running servers but doesn't say which cloud they are
 * on". The fact was on every row all along — `provider` — and the page put every card in one
 * undifferentiated grid. What these pin is the wiring between the row's `provider`, the
 * display name the provider list gives it, and the heading the group renders under; and the
 * shape of the created stamp, whose formatter has its own unit test in `lib/format.test.ts`.
 */
describe('the fleet, grouped by the cloud each box is on', () => {
  const groups = (container: HTMLElement) => [...container.querySelectorAll('.provider-group')] as HTMLElement[]
  const headings = (container: HTMLElement) =>
    groups(container).map((group) => group.querySelector('.provider-group-heading')!.firstChild!.textContent)

  it('gives each cloud its own heading, by the display name the provider list reports', async () => {
    rows = [RUNNING, ON_ANOTHER_CLOUD]
    const { container } = renderPage()

    await waitFor(() => expect(groups(container)).toHaveLength(2))
    // Alphabetical by name, so a create landing or a terminate emptying a cloud does not
    // reshuffle the page under the reader.
    expect(headings(container)).toEqual(['Another Cloud', 'Fake'])

    // And each card is inside its own cloud's group, which is the claim the heading makes.
    const [another, fake] = groups(container)
    expect(cardFor(another!, 'other-box')).toBeTruthy()
    expect(cardFor(fake!, 'dev-box')).toBeTruthy()
    expect(another!.querySelectorAll('.server-card')).toHaveLength(1)
  })

  it('counts the boxes in each group, singular and plural', async () => {
    rows = [RUNNING, UNPRICED, ON_ANOTHER_CLOUD]
    const { container } = renderPage()

    await waitFor(() => expect(groups(container)).toHaveLength(2))
    const counts = groups(container).map((group) => group.querySelector('.provider-group-count')!.textContent)
    expect(counts).toEqual(['1 server', '2 servers'])
  })

  it('still shows a box on a cloud the provider list has never heard of', async () => {
    // A bring-your-own machine, or a cloud the operator has removed from their config since
    // this row was created. There is no display name to look up, so the group wears the id —
    // which still answers the question — rather than swallowing the row.
    rows = [RUNNING, ON_AN_UNLISTED_CLOUD]
    const { container } = renderPage()

    await waitFor(() => expect(groups(container)).toHaveLength(2))
    expect(headings(container)).toContain('byo')
    const byo = groups(container).find((group) => group.textContent?.includes('byo-box'))!
    expect(cardFor(byo, 'byo-box')).toBeTruthy()
  })

  it('puts a row naming no cloud at all in one generic group, last', async () => {
    rows = [ON_NO_CLOUD, RUNNING]
    const { container } = renderPage()

    await waitFor(() => expect(groups(container)).toHaveLength(2))
    // Last, because a heading that says nothing should not be the first thing read.
    expect(headings(container)).toEqual(['Fake', 'Other'])
    expect(cardFor(groups(container)[1]!, 'nameless-box')).toBeTruthy()
  })

  it('stamps each card with when the box was created, as YYYY-MON-DD HH:MI', async () => {
    rows = [RUNNING]
    const { container } = renderPage()

    await waitFor(() => expect(cardFor(container, 'dev-box')).toBeTruthy())
    // Built from local parts so the expectation holds in CI's UTC and on a laptop alike —
    // the stamp is deliberately in the reader's own timezone.
    const created = new Date(BASE.createdAt)
    const pad = (value: number) => String(value).padStart(2, '0')
    const month = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][
      created.getMonth()
    ]
    const expected = `${created.getFullYear()}-${month}-${pad(created.getDate())} ${pad(created.getHours())}:${pad(created.getMinutes())}`

    expect(value(cardFor(container, 'dev-box'), 'Created').textContent).toBe(expected)
    expect(expected).toMatch(/^\d{4}-[A-Z]{3}-\d{2} \d{2}:\d{2}$/)
  })

  it('writes the same stamp on the detail page, which is served the same row', async () => {
    rows = [RUNNING]
    const list = renderPage()
    await waitFor(() => expect(cardFor(list.container, 'dev-box')).toBeTruthy())
    const onTheCard = value(cardFor(list.container, 'dev-box'), 'Created').textContent
    list.unmount()

    const detail = renderDetail(SERVER_ID)
    await waitFor(() => expect(detail.container.querySelector('.server-summary')).toBeTruthy())
    const summary = detail.container.querySelector('.server-summary') as HTMLElement
    expect(value(summary, 'Created').textContent).toBe(onTheCard)
  })
})

/**
 * The Surge Pack a box was built from, on the card itself (issue #137) — the owner's revision
 * of a request to put the pack's usage guide in the SSH login banner: no banner work, just the
 * pack's NAME where a user is already looking. `ServerDetailPage` has shown this since #46; the
 * card had shown nothing about the pack at all.
 */
describe('the Surge Pack name on a card (issue #137)', () => {
  it('shows the pack by name once the public list answers', async () => {
    rows = [{ ...RUNNING, packId: 'claude-code' }]
    packs = [{ packId: 'claude-code', name: 'Claude Code', tools: [], requiresRepos: false, requiresRdp: false, displayOrder: 0, enabled: true }]
    const { container } = renderPage()

    await waitFor(() => expect(cardFor(container, 'dev-box')).toBeTruthy())
    await waitFor(() => expect(value(cardFor(container, 'dev-box'), 'Pack').textContent).toBe('Claude Code'))
    // The slug rides along as a hover, the same as the detail page (issue #137).
    expect(value(cardFor(container, 'dev-box'), 'Pack').getAttribute('title')).toBe('claude-code')
  })

  it('falls back to the id when the pack that built this box has since been deleted', async () => {
    rows = [{ ...RUNNING, packId: 'a-pack-nobody-kept' }]
    packs = [] // deleted, or never synced — either way, absent from the list core still serves
    const { container } = renderPage()

    await waitFor(() => expect(cardFor(container, 'dev-box')).toBeTruthy())
    const cell = value(cardFor(container, 'dev-box'), 'Pack')
    expect(cell.textContent).toBe('a-pack-nobody-kept')
    // No name to explain, so no tooltip either — the id IS what's shown, not a second copy of it.
    expect(cell.getAttribute('title')).toBeNull()
  })

  it('renders no Pack row at all for a box with no pack on record', async () => {
    rows = [RUNNING] // BASE carries no packId
    const { container } = renderPage()

    await waitFor(() => expect(cardFor(container, 'dev-box')).toBeTruthy())
    const card = cardFor(container, 'dev-box')
    expect([...card.querySelectorAll('dt')].some((dt) => dt.textContent === 'Pack')).toBe(false)
  })
})

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
    for (const row of [
      STOPPED,
      RUNNING,
      UNPRICED,
      FAILED_BUT_BILLING,
      FAILED_AND_RELEASED,
      STALE,
      ON_ANOTHER_CLOUD,
      ON_AN_UNLISTED_CLOUD,
      ON_NO_CLOUD,
    ]) {
      expect(Object.keys(row).filter((key) => !sent.includes(key))).toEqual([])
    }
  })
})
