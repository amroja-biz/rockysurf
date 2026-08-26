import { startStubServer, type StubServer } from '../test-server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '../contexts/AuthContext'
import { EventsProvider } from '../contexts/EventsContext'
import { TRANSITION_STALLED_HINT, TRANSITION_WINDOW_MS } from '../hooks/useServerTransition'
import { setAuthToken } from '../lib/api'
import { STATUS_LABELS, STEP_ORDER } from '../lib/format'
import { ServerDetailPage } from './ServerDetailPage'

/**
 * The step timeline, driven the way core drives it (rockysurf-xinr).
 *
 * WHY THIS IS NOT A MOCK-FED COMPONENT TEST. The bug this file exists for was invisible to
 * every test in the suite: core emitted `bootstrap-progress` with a PLAN STEP ID in `step`
 * (`tool:beads`) where this page expects a PROVISIONING step (`installing_tools`), so on a
 * real AWS create the install log streamed to completion while the timeline sat at
 * "Requested". A test that pushed its own idea of an event into a component's props agreed
 * with the page, because both sides of the disagreement were on the same side of the mock.
 *
 * So nothing between the socket and the DOM is faked here: a real HTTP server, a real
 * `EventSource` (see `test-setup.ts`), the real `EventsProvider`, and the page itself. What is
 * pushed down the stream is the frame core builds — and the last test in this file is what
 * keeps that claim true, by checking this page's vocabulary against core's own source.
 */

const USER = { id: 'u1', username: 'admin', email: null, avatarUrl: null, isAdmin: true }
const SERVER_ID = 'srv-abc123'

/** Provisioning, at the first step — the state a browser lands on right after a create. */
const SERVER = {
  serverId: SERVER_ID,
  name: 'dev-box',
  provider: 'fake',
  packId: 'a-pack',
  status: 'provisioning',
  provisioningStep: 'requested',
  size: 'small',
  offeringId: 'fake-small',
  arch: 'arm64',
  sshUser: 'rocky',
  estimatedTotalCost: 0,
  tools: [],
  repositories: [],
  totalUptimeSeconds: 0,
  createdAt: '2026-08-12T00:00:00.000Z',
}

/**
 * The pack the server was built from, as the public list serves it. `guide` is the pack's own
 * post-boot instructions (rockysurf-7ckx); the `<script>` in it is not decoration — see the
 * escaping test below.
 */
const PACK = {
  packId: 'a-pack',
  name: 'A Pack',
  displayOrder: 1,
  enabled: true,
  tools: [],
  requiresRepos: false,
  requiresRdp: false,
  guide: 'Claude Code\n  claude setup-token\n<script>alert(1)</script>\n',
}

const CAPABILITIES = {
  stop: true,
  ipStableAcrossStop: true,
  canInjectHostKeys: true,
  userDataMaxBytes: 32768,
  generatesUserData: true,
}

/** Matches `environmentOptions.jsdom.url` in vitest.config.ts — see the note there. */

let stub: StubServer
let streams: Array<(chunk: string) => void> = []

/**
 * The row the stub serves, mutable so a test can start the page from the state it needs — a
 * stopped box, for the stop/start tests below. Everything else reads it as it always did.
 */
let row: Record<string, unknown>
/** The pack the stub serves, mutable the same way — the web-UI tests start from a pack that
    declares `webPort`, everything else from one that does not. */
let packRow: Record<string, unknown>
/** Every stop/start core accepted, and every read of the row, in order. */
let accepted: string[]
let reads: number
/** Every metadata PATCH body the stub received, in order (issue #46). */
let patched: Array<Record<string, unknown>>

beforeEach(async () => {
  streams = []
  row = { ...SERVER }
  packRow = { ...PACK }
  accepted = []
  reads = 0
  patched = []
  stub = await startStubServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (url.pathname === '/api/v1/auth/me') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ user: USER }))
      return
    }

    /**
     * Start and stop, answered the way core answers them (rockysurf-55fx.15): 200, and the row
     * UNCHANGED. A cloud that takes its time has accepted the request and reached nothing yet,
     * so the only fact in this response is that it was accepted — which is exactly the fact the
     * page had been throwing away.
     */
    if (req.method === 'POST' && /\/(start|stop)$/.test(url.pathname)) {
      accepted.push(url.pathname.split('/').pop()!)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(row))
      return
    }

    // Before the GET matcher below, which checks only the path: a PATCH is the metadata
    // edit, answered the way core answers it — the whole row, edited (issue #46).
    if (req.method === 'PATCH' && url.pathname === `/api/v1/servers/${SERVER_ID}`) {
      let raw = ''
      req.on('data', (chunk: string) => {
        raw += chunk
      })
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>
        patched.push(body)
        row = { ...row, ...body }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(row))
      })
      return
    }

    if (url.pathname === `/api/v1/servers/${SERVER_ID}`) {
      reads++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(row))
      return
    }

    if (url.pathname === '/api/v1/providers') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ id: 'fake', displayName: 'Fake', capabilities: CAPABILITIES }]))
      return
    }

    if (url.pathname === '/api/v1/surge-packs') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([packRow]))
      return
    }

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
    <MemoryRouter initialEntries={[`/servers/${SERVER_ID}`]}>
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

/** Push one message down every open stream, the way core's broadcast does. */
function broadcast(payload: object): void {
  const frame = `event: message\ndata: ${JSON.stringify(payload)}\n\n`
  streams.forEach((write) => write(frame))
}

/**
 * Push an event until the page reacts. The stream opens before the page has finished
 * subscribing, so a single push can land in that gap — the same as a real server emitting
 * while a tab is still loading. The assertion still has to pass on a real re-render.
 */
async function broadcastUntil(payload: object, assertion: () => void): Promise<void> {
  await waitFor(() => {
    broadcast(payload)
    assertion()
  })
}

/** The rendered state of one step, read off the DOM the way a user reads the colour. */
const stateOf = (label: string) => screen.getByText(label).getAttribute('data-state')

/** The status pill, which is the thing the owner was staring at when they filed this. */
const pill = (container: HTMLElement) => container.querySelector('.status-badge')!

describe('the step timeline, fed by the live stream', () => {
  it('advances when core reports a step, with no refetch and no reload', async () => {
    renderPage()

    // The starting picture: the first step is where the row says it is.
    await waitFor(() => expect(stateOf('Requested')).toBe('active'))
    expect(stateOf('Installing tools')).toBe('pending')
    await waitFor(() => expect(streams.length).toBeGreaterThan(0))

    // The frame core emits from BOTH bootstrap topologies: the row's vocabulary in `step`,
    // the plan's own step id alongside it.
    await broadcastUntil(
      { type: 'bootstrap-progress', serverId: SERVER_ID, step: 'installing_tools', stepId: 'tool:beads', status: 'provisioning' },
      () => expect(stateOf('Installing tools')).toBe('active'),
    )

    // Everything before it is behind us, everything after is still to come.
    expect(stateOf('Requested')).toBe('done')
    expect(stateOf('Launching server')).toBe('done')
    expect(stateOf('Ready')).toBe('pending')
  })

  it('leaves the timeline alone when a step it cannot place arrives', async () => {
    renderPage()

    await waitFor(() => expect(stateOf('Requested')).toBe('active'))
    await waitFor(() => expect(streams.length).toBeGreaterThan(0))
    await broadcastUntil({ type: 'bootstrap-progress', serverId: SERVER_ID, step: 'installing_tools' }, () =>
      expect(stateOf('Installing tools')).toBe('active'),
    )

    // A plan step id in the `step` field is what core used to send from push mode. It must
    // never move the timeline BACKWARDS to nothing, which is what an unguarded cast did:
    // `indexOf` answers -1 and every step goes pending.
    broadcast({ type: 'bootstrap-progress', serverId: SERVER_ID, step: 'tool:claude-code' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(stateOf('Installing tools')).toBe('active')
  })

  it('gives way to the connection details when the server reaches running', async () => {
    renderPage()

    await waitFor(() => expect(stateOf('Requested')).toBe('active'))
    await waitFor(() => expect(streams.length).toBeGreaterThan(0))

    // Core announces the promotion as `server-status`, which is the only event type this page
    // reads a status from — a bootstrap report that promoted the row and said nothing here is
    // how a finished box kept showing "Setting up" until the user reloaded.
    await broadcastUntil(
      { type: 'server-status', serverId: SERVER_ID, status: 'running', publicIp: '203.0.113.7' },
      () => expect(screen.getByRole('heading', { name: 'Connect' })).toBeTruthy(),
    )

    expect(screen.queryByText('Installing tools')).toBeNull()
    expect(screen.getByText('203.0.113.7')).toBeTruthy()
  })
})

describe('a failed row whose machine core released (ADR-0010)', () => {
  it('re-reads the row on the failed frame, so the button says Dismiss and not Terminate', async () => {
    // While the box was building, core reported it as billing — the truth at the time.
    row = { ...SERVER, billing: { live: true, providerState: 'running', since: '2026-08-26T11:42:42.509Z' } }
    renderPage()
    await screen.findByText('dev-box')

    // Then a tool install failed and core terminated the machine: the row now carries the
    // report and NO billing block. The frame core broadcasts says only `failed`.
    row = {
      ...SERVER,
      status: 'failed',
      errorMessage: 'Deliberate apt failure could not be installed. Rocky Surf terminated the machine, so it is not billing.',
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
    const readsBefore = reads
    await broadcastUntil({ type: 'server-status', serverId: SERVER_ID, status: 'failed' }, () =>
      expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy(),
    )
    // Patched from the frame alone, the page would still hold the provisioning-time billing
    // block and label the same button "Terminate" — for a machine that no longer exists.
    expect(reads).toBeGreaterThan(readsBefore)
    expect(screen.queryByRole('button', { name: 'Terminate' })).toBeNull()
  })
})

/**
 * A TERMINATED SERVER, READ BACK AS HISTORY (issue #125).
 *
 * The report: the recent-activity list names boxes that have come and gone, and clicking one
 * led nowhere. Making it lead HERE is only half the fix — the page a user lands on was built
 * to drive a live machine, and a control panel offering Terminate, an SSH command and a
 * download for a box whose disk is gone is worse than no page at all.
 *
 * So this is the other half: the same page, in a mode where it reports rather than controls.
 * The assertions are deliberately split in two — what the record MUST still say (placement,
 * size, pack, tools, repositories, what it cost, when it ended) and what must have gone (every
 * affordance that needs a machine to exist). A test that only checked the first half would pass
 * on a page that still offered to SSH into nothing.
 */
describe('a terminated server, read back as history (issue #125)', () => {
  /** The row core serves for a box that is gone: no address left to act on, totals frozen. */
  const TERMINATED = {
    ...SERVER,
    status: 'terminated',
    provisioningStep: 'ready',
    region: 'fake-1',
    description: 'the box that built the release',
    repositories: ['https://github.com/example/app'],
    publicIp: '203.0.113.9',
    consoleUrl: 'https://console.example.test/i/abc',
    hourlyCost: { amount: 0.1, currency: 'USD', fetchedAt: '2026-08-12T00:00:00Z' },
    totalUptimeSeconds: 5400,
    estimatedTotalCost: 0.15,
    startedAt: '2026-08-12T00:05:00.000Z',
    terminatedAt: '2026-08-12T01:35:00.000Z',
  }

  it('says plainly that the machine is gone, and dates it', async () => {
    row = { ...TERMINATED }
    renderPage()

    const notice = await screen.findByTestId('historical-notice')
    expect(notice.textContent).toContain('terminated')
    // Not "something went wrong": this is a record being read back, and the page says what it is.
    expect(notice.textContent).toContain('record of how it was configured')
  })

  it('still answers how the box was configured, which is the whole point of keeping the row', async () => {
    row = { ...TERMINATED }
    renderPage()

    // Placement: the cloud and the region. `region` had never been on the wire before this.
    await waitFor(() => expect(screen.getByTestId('server-placement').textContent).toContain('Fake'))
    expect(screen.getByTestId('server-placement').textContent).toContain('fake-1')
    // The machine that was bought, and the pack that was installed on it.
    expect(screen.getByText(/fake-small/)).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId('server-pack').textContent).toBe('A Pack'))
    // What it was built to work on.
    expect(screen.getByText('https://github.com/example/app')).toBeTruthy()
    // The user's own words about it, still shown — just no longer editable.
    expect(screen.getByTestId('server-description').textContent).toContain('the box that built the release')
    // The two ends of its life, and what the meter ended up at.
    expect(screen.getByTestId('server-terminated-at')).toBeTruthy()
    expect(screen.getByText('Total uptime')).toBeTruthy()
    expect(screen.getByText('Estimated cost, final')).toBeTruthy()
    expect(screen.getByText('$0.15')).toBeTruthy()
  })

  it('offers nothing that needs the machine to exist', async () => {
    row = { ...TERMINATED }
    renderPage()
    await screen.findByTestId('historical-notice')

    // Lifecycle actions: there is nothing left to stop, start, terminate or dismiss.
    for (const label of ['Stop', 'Start', 'Terminate', 'Dismiss']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
    // Connect: no SSH command, and no key to download for a disk that is gone.
    expect(screen.queryByText('Connect')).toBeNull()
    expect(screen.queryByRole('button', { name: /Download .*\.pem/ })).toBeNull()
    // The record is read-only — renaming a box that no longer exists rewrites history for nobody.
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    // And no link into a provider console for an instance the provider no longer has.
    expect(screen.queryByRole('link', { name: /console/ })).toBeNull()
  })

  it('keeps every one of those affordances on a running box', async () => {
    // The control half of the pair: the same page, the same fixtures, one field different.
    row = { ...TERMINATED, status: 'running', terminatedAt: undefined }
    renderPage()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Terminate' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
    expect(screen.getByText('Connect')).toBeTruthy()
    expect(screen.queryByTestId('historical-notice')).toBeNull()
    // Placement is not a historical-only fact — a live box says where it is too.
    expect(screen.getByTestId('server-placement').textContent).toContain('fake-1')
  })
})

describe("the pack's post-boot guide (rockysurf-7ckx)", () => {
  it('is hidden while the box is still building and appears when it is running', async () => {
    renderPage()

    // Nothing to act on yet: the tools it talks about are still being installed.
    await waitFor(() => expect(stateOf('Requested')).toBe('active'))
    expect(screen.queryByText(/claude setup-token/)).toBeNull()
    await waitFor(() => expect(streams.length).toBeGreaterThan(0))

    await broadcastUntil({ type: 'server-status', serverId: SERVER_ID, status: 'running' }, () =>
      expect(screen.getByRole('heading', { name: 'Getting started with A Pack' })).toBeTruthy(),
    )
    expect(screen.getByText(/claude setup-token/)).toBeTruthy()
  })

  it('renders the guide as text, so a pack cannot inject markup into this page', async () => {
    // A pack file arrives by pull request or by import-from-URL, which makes its prose
    // untrusted input. React escaping is the whole defence, and the way it stops being the
    // defence is somebody reaching for dangerouslySetInnerHTML to get bold text.
    const { container } = renderPage()
    await waitFor(() => expect(streams.length).toBeGreaterThan(0))
    await broadcastUntil({ type: 'server-status', serverId: SERVER_ID, status: 'running' }, () =>
      expect(screen.getByRole('heading', { name: 'Getting started with A Pack' })).toBeTruthy(),
    )

    expect(container.querySelector('script')).toBeNull()
    // Present as literal characters the user can read, not as an element.
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeTruthy()
  })
})

/**
 * The display fields (issue #46): the pack that built the box, and the two words the user may
 * rewrite. The report was a dashboard of `server-mt0nilwv`s — the auto-minted name is the only
 * label a card has, and it says nothing about what the box is for.
 */
describe('the display fields (issue #46)', () => {
  it('shows which Surge Pack built this box, by name, linked to the catalogue', async () => {
    renderPage()
    // The id shows first — the row needs no second fetch to say SOMETHING — and the name
    // replaces it when the pack list answers.
    await waitFor(() => expect(screen.getByTestId('server-pack').textContent).toBe('A Pack'))
    // Linked to the same page the nav offers (rockysurf-idxd).
    expect(screen.getByTestId('server-pack').querySelector('a')?.getAttribute('href')).toBe('/packs/a-pack')
    // The slug rides along as a hover once the name is known (issue #137).
    expect(screen.getByTestId('server-pack').querySelector('a')?.getAttribute('title')).toBe('a-pack')
  })

  /**
   * A pack since deleted — imported once, then removed from the catalogue — still built this
   * box, and the row still names it (issue #137). The public list core serves no longer has an
   * entry for it, so the id is the only honest label left; the page must keep showing that
   * rather than blanking the row or hanging on "a-pack" forever waiting for a name that will
   * never arrive.
   */
  it("falls back to the pack's id when the pack that built this box has since been deleted", async () => {
    // Same server, but the public list no longer carries an `a-pack` entry.
    packRow = { ...PACK, packId: 'some-other-pack' }
    renderPage()

    await screen.findByText('dev-box')
    // The list answered — it is just missing this id — so the row keeps its own id, not
    // whatever pack happens to be first in an unrelated list.
    await waitFor(() => expect(screen.getByTestId('server-pack').textContent).toBe('a-pack'))
    expect(screen.getByTestId('server-pack').querySelector('a')?.getAttribute('href')).toBe('/packs/a-pack')
    // No name to explain, so no tooltip either — the id IS what's on screen, not a duplicate of it.
    expect(screen.getByTestId('server-pack').querySelector('a')?.getAttribute('title')).toBeNull()
  })

  /** One pack tool, as the public list expands them — enough to pin name, link and caveat. */
  const CURSOR_TOOL = {
    toolId: 'cursor-cli',
    name: 'Cursor CLI',
    description: 'the agent this pack exists to deliver',
    category: 'agent',
    url: 'https://example.test/cursor',
  }

  it('fills the Installed card from the pack when the row recorded nothing (rockysurf-idxd)', async () => {
    // The owner's screenshot: every SPA create names only a pack, so `server.tools` is [] and
    // the card was a heading over nothing.
    packRow = { ...PACK, tools: [CURSOR_TOOL] }
    renderPage()

    await waitFor(() => expect(screen.getByTestId('installed-tools')).toBeTruthy())
    const link = screen.getByRole('link', { name: 'Cursor CLI' })
    expect(link.getAttribute('href')).toBe('https://example.test/cursor')
    // The fallback says where the list came from, and what that does and does not claim.
    expect(screen.getByText(/From the A Pack pack/)).toBeTruthy()
  })

  it("prefers the row's own record, named through the pack where it can be", async () => {
    row = { ...SERVER, tools: ['cursor-cli', 'mystery-tool'] }
    packRow = { ...PACK, tools: [CURSOR_TOOL] }
    renderPage()

    await waitFor(() => expect(screen.getByRole('link', { name: 'Cursor CLI' })).toBeTruthy())
    // A tool the pack no longer defines still shows, as its id — the row's record is the row's.
    expect(screen.getByText('mystery-tool')).toBeTruthy()
    // No provenance caveat: this list IS the box's own record.
    expect(screen.queryByText(/From the A Pack pack/)).toBeNull()
  })

  it('says nothing was recorded rather than rendering an empty card', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Nothing recorded for this box.')).toBeTruthy())
  })

  it('renames and describes the box in place, and the title follows the response', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByTestId('server-description')).toBeTruthy())
    // Absent is stated, not blank — and the affordance sits right beside it.
    expect(screen.getByTestId('server-description').textContent).toContain('No description.')

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'training-box' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'DeepSeek eval rig' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // One PATCH, carrying exactly what the form held.
    await waitFor(() => expect(patched).toHaveLength(1))
    expect(patched[0]).toEqual({ name: 'training-box', description: 'DeepSeek eval rig' })
    // The response replaced the row: title, description — no refetch, no stale heading.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'training-box' })).toBeTruthy())
    expect(screen.getByTestId('server-description').textContent).toContain('DeepSeek eval rig')
  })
})

/**
 * The tunnel for a pack that declares a web UI (rockysurf-bbmi).
 *
 * The report was the owner's own DeepSeek test: the pack's guide OPENS with the `ssh -L`
 * command, but Connect showed the plain one, the user ran that first, found nothing to open,
 * and concluded the pack needed a GUI. What these assert is that the one line that changes how
 * you connect is rendered where connecting is explained — from pack metadata, like the RDP
 * block, never from a pack's name.
 */
describe('the web-UI tunnel (rockysurf-bbmi)', () => {
  async function reachRunning() {
    renderPage()
    await waitFor(() => expect(streams.length).toBeGreaterThan(0))
    await broadcastUntil(
      { type: 'server-status', serverId: SERVER_ID, status: 'running', publicIp: '203.0.113.7' },
      () => expect(screen.getByRole('heading', { name: 'Connect' })).toBeTruthy(),
    )
  }

  it('renders the forwarded ssh command and the localhost URL when the pack declares a port', async () => {
    packRow = { ...PACK, webPort: 3080 }
    await reachRunning()

    expect(screen.getByRole('heading', { name: 'Web UI' })).toBeTruthy()
    // The command itself, exactly the shape the pack's own guide teaches — and beside it the
    // address to open, so neither lives only in guide prose.
    expect(screen.getByText('ssh -i dev-box.pem -L 3080:127.0.0.1:3080 rocky@203.0.113.7')).toBeTruthy()
    expect(screen.getByText(/localhost:3080/)).toBeTruthy()
  })

  it('renders nothing extra for a pack with no web UI', async () => {
    await reachRunning()
    expect(screen.queryByRole('heading', { name: 'Web UI' })).toBeNull()
    expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull()
  })
})

/**
 * The Connect panel when a key was supplied at create time (issue #41).
 *
 * The report was the owner pasting their own public key and Connect still handing back a
 * generated `.pem` as if it were the only way in. Both keys are authorized either way — core
 * appends, never substitutes (ADR-0002) — so what changes here is which one the page leads
 * with, not which ones work.
 */
describe('the connect panel when a key was supplied (issue #41)', () => {
  async function reachRunning() {
    renderPage()
    await waitFor(() => expect(streams.length).toBeGreaterThan(0))
    await broadcastUntil(
      { type: 'server-status', serverId: SERVER_ID, status: 'running', publicIp: '203.0.113.7' },
      () => expect(screen.getByRole('heading', { name: 'Connect' })).toBeTruthy(),
    )
  }

  it('leads with the plain ssh command and demotes the .pem into a disclosure', async () => {
    row = { ...SERVER, suppliedSshKey: { fingerprint: 'SHA256:abc123', comment: 'me@laptop' } }
    await reachRunning()

    // The user's own key, behind a placeholder path — only they know where it lives
    // (rockysurf-hky6). No .pem in the primary command; it is not nested in the disclosure.
    const primary = screen.getByText('ssh -i <path to your key> rocky@203.0.113.7')
    expect(primary.closest('details')).toBeNull()
    // The fingerprint of the key that command actually uses is named.
    expect(screen.getByText(/SHA256:abc123/)).toBeTruthy()
    expect(screen.getByText(/me@laptop/)).toBeTruthy()

    // The generated-key command still works and is still shown — demoted, not removed —
    // but only inside the labelled disclosure, not as the primary command.
    const demoted = screen.getByText('ssh -i dev-box.pem rocky@203.0.113.7')
    expect(demoted.closest('details')).toBeTruthy()

    // The download is still reachable, but only inside that same disclosure — not a
    // top-level button a user would mistake for the way in.
    const downloadButton = screen.getByRole('button', { name: /Download dev-box\.pem/ })
    expect(downloadButton.closest('details')).toBeTruthy()
    expect(screen.getByText("Rocky Surf's own key")).toBeTruthy()

    expect(screen.queryByText(/the only copy you get/)).toBeNull()
  })

  it("renders today's generated-key command and top-level button when no key was supplied", async () => {
    await reachRunning()

    expect(screen.getByText('ssh -i dev-box.pem rocky@203.0.113.7')).toBeTruthy()
    const downloadButton = screen.getByRole('button', { name: /Download dev-box\.pem/ })
    expect(downloadButton.closest('details')).toBeNull()

    expect(screen.queryByText(/the only copy you get/)).toBeNull()
  })
})

/**
 * The Connect panel once the supplied key is the ONLY key (issue #92).
 *
 * `suppliedKeyOnly: true` means core's own bootstrap step already removed its key from the box
 * and retired the stored private half — there is nothing left to disclose, download, or build a
 * `.pem`-based tunnel command from. `suppliedKeyOnly: false`/absent (the previous describe block)
 * is unchanged on purpose: a box mid-bootstrap, or one that shipped before this feature, still
 * has both keys and still gets the disclosure.
 */
describe('the connect panel once the managed key has been retired (issue #92)', () => {
  async function reachRunning() {
    renderPage()
    await waitFor(() => expect(streams.length).toBeGreaterThan(0))
    await broadcastUntil(
      { type: 'server-status', serverId: SERVER_ID, status: 'running', publicIp: '203.0.113.7' },
      () => expect(screen.getByRole('heading', { name: 'Connect' })).toBeTruthy(),
    )
  }

  it('drops the disclosure and the top-level download entirely', async () => {
    row = {
      ...SERVER,
      suppliedSshKey: { fingerprint: 'SHA256:abc123', comment: 'me@laptop' },
      suppliedKeyOnly: true,
    }
    await reachRunning()

    // The primary command is unchanged — it already used the placeholder before this feature.
    expect(screen.getByText('ssh -i <path to your key> rocky@203.0.113.7')).toBeTruthy()

    // Nothing `.pem`-shaped is left anywhere on the page: no disclosure, no demoted command, no
    // download button.
    expect(screen.queryByText("Rocky Surf's own key")).toBeNull()
    expect(screen.queryByText(/dev-box\.pem/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull()
  })

  it('uses the placeholder path, not the .pem, in the web-UI tunnel command', async () => {
    row = {
      ...SERVER,
      suppliedSshKey: { fingerprint: 'SHA256:abc123', comment: 'me@laptop' },
      suppliedKeyOnly: true,
    }
    packRow = { ...PACK, webPort: 3080 }
    await reachRunning()

    expect(screen.getByText('ssh -i <path to your key> -L 3080:127.0.0.1:3080 rocky@203.0.113.7')).toBeTruthy()
    expect(screen.queryByText(/dev-box\.pem/)).toBeNull()
  })
})

/**
 * The stop/start affordance (rockysurf-4t8y).
 *
 * The report was the owner clicking Start on a stopped t4g.medium, watching the AWS console
 * show it starting, and watching this page say "Stopped" and nothing else for a minute and a
 * half. Same reason the timeline bug above was invisible: core is behaving correctly and every
 * unit test agrees with it, because the missing thing is not a fact core has.
 *
 * These drive the real request and the real stream. The stub answers start the way a slow cloud
 * does — 200, row unchanged — because a stub that returned `running` would test a Hetzner and
 * leave the EC2 case exactly as unobserved as it was.
 */
describe('a stop or start the provider has not finished', () => {
  /** Land on the page with the box stopped, and click Start. */
  async function clickStart() {
    row['status'] = 'stopped'
    const rendered = renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(accepted).toEqual(['start']))
    return rendered
  }

  it('says so from the accepted response, without claiming a status core never reported', async () => {
    const { container } = await clickStart()

    await waitFor(() => expect(pill(container).textContent).toBe('Starting…'))

    // The load-bearing half of this bead's design: the ROW is still stopped, and says so where
    // anything downstream would read it. The transition is presentation beside it, not a status.
    expect(pill(container).getAttribute('data-status')).toBe('stopped')
    expect(pill(container).getAttribute('data-transition')).toBe('start')

    // And nothing offers an action that core would refuse with a 409 while it is in flight.
    expect(screen.getByRole('button', { name: 'Starting…' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Terminate' }).hasAttribute('disabled')).toBe(true)
  })

  it('resolves on the frame core broadcasts when the provider confirms, with no refresh', async () => {
    const { container } = await clickStart()
    await waitFor(() => expect(pill(container).textContent).toBe('Starting…'))
    await waitFor(() => expect(streams.length).toBeGreaterThan(0))

    // What core emits from `transition()` when a sync sees the box up — the same event type the
    // bootstrap promotion uses, through the same constructor.
    await broadcastUntil({ type: 'server-status', serverId: SERVER_ID, status: 'running', publicIp: '203.0.113.7' }, () =>
      expect(pill(container).textContent).toBe('Running'),
    )

    expect(pill(container).getAttribute('data-transition')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Connect' })).toBeTruthy()
  })

  it('nudges core while it waits, which is what makes that frame arrive at all', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { container } = await clickStart()
      await waitFor(() => expect(pill(container).textContent).toBe('Starting…'))

      // Nothing in core sweeps a stopped row: the provision ticker walks `requested` and
      // `provisioning` only. This GET is what makes core ask the provider — and core's own
      // broadcast on the answer is what tells every other tab.
      const before = reads
      await act(async () => {
        await vi.advanceTimersByTimeAsync(11_000)
      })
      // `waitFor` rather than a bare assertion: advancing the clock ISSUES the requests, and
      // the round trip to the stub is real I/O that a fake clock does not wait for.
      await waitFor(() => expect(reads).toBeGreaterThan(before))
    } finally {
      vi.useRealTimers()
    }
  })

  it('decays to the truth rather than spinning forever when nothing ever confirms', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { container } = await clickStart()
      await waitFor(() => expect(pill(container).textContent).toBe('Starting…'))

      await act(async () => {
        await vi.advanceTimersByTimeAsync(TRANSITION_WINDOW_MS.start + 1_000)
      })

      // Back to what the row actually says, plus the reason it is saying it.
      await waitFor(() => expect(pill(container).textContent).toBe('Stopped'))
      expect(pill(container).getAttribute('data-transition')).toBeNull()
      expect(screen.getByText(TRANSITION_STALLED_HINT)).toBeTruthy()
      // Offerable again: the user's next move is to try again, and this is the button for it.
      expect(screen.getByRole('button', { name: 'Start' }).hasAttribute('disabled')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * The link out to the provider's own console (rockysurf-imj1, ADR-0003 E16).
 *
 * Rendered from what core SENT and from nothing else. The page has no idea what an EC2 or a
 * Hetzner console URL looks like, and the two tests below are the pair that keeps it that way:
 * a row core linked gets an anchor, and a row core did not gets no anchor at all — not a
 * disabled one, not a guess assembled from `server.provider`.
 */
describe('the provider console link', () => {
  const CONSOLE_URL = 'https://console.example.test/projects/1234567/servers/42/overview'
  const link = () => screen.queryByRole('link', { name: /console/i })

  it('renders nothing when core reported no console URL', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('dev-box')).toBeTruthy())
    expect(link()).toBeNull()
  })

  it('opens the provider console in a new tab, named after the provider core named', async () => {
    row = { ...SERVER, consoleUrl: CONSOLE_URL }
    renderPage()

    await waitFor(() => expect(link()).toBeTruthy())
    const anchor = link()!
    expect(anchor.getAttribute('href')).toBe(CONSOLE_URL)
    expect(anchor.getAttribute('target')).toBe('_blank')
    // Both halves: `noopener` keeps the opened tab off `window.opener`, `noreferrer` keeps this
    // installation's address out of the provider's referer log.
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer')
    // `Fake` is the displayName from GET /providers — the same source the create page uses, so
    // a provider this build has never heard of still gets a real name in the label.
    expect(anchor.textContent).toContain('Fake')
  })
})

describe('the vocabulary this timeline draws', () => {
  /**
   * The seam the bug crossed, checked directly.
   *
   * The two halves of this system are tested in two packages and meet at a contract neither
   * of them owns. Reading core's list rather than restating it means a step added, renamed or
   * reordered on the server fails HERE, in the package that would otherwise render an empty
   * timeline for it and say nothing.
   */
  /**
   * Through a variable, not a literal: Vite statically rewrites `new URL('./literal',
   * import.meta.url)` into an asset URL, which is an http one under jsdom and not a file to
   * read. The same dodge is in `navbar.test.tsx` and `CreateServerPage.test.tsx`.
   */
  function coreVocabulary(name: string): string[] {
    const relative = '../../../core/src/db/schema.ts'
    const schema = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
    const declaration = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(schema)
    expect(declaration).toBeTruthy()
    const values = [...declaration![1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!)
    expect(values.length).toBeGreaterThan(0)
    return values
  }

  it('is exactly the list core promotes rows through', () => {
    // Reading core's list rather than restating it means a step added, renamed or reordered on
    // the server fails HERE, in the package that would otherwise render an empty timeline for
    // it and say nothing.
    expect(STEP_ORDER).toEqual(coreVocabulary('PROVISIONING_STEPS'))
  })

  /**
   * The other half of the same hand-mirroring, guarded for the first time (rockysurf-xinr's
   * note on rockysurf-4t8y).
   *
   * `STATUS_LABELS` is a `Record<Server['status'], string>`, so this checks the union in
   * `lib/api.ts` as much as the labels: a status core adds and web does not is a pill with
   * `undefined` in it, and a status web keeps after core drops it is dead code that reads as
   * supported. Order is not asserted — a Record is not a sequence, unlike the timeline above.
   *
   * Note what this does NOT guard, deliberately: `stopping`/`starting` are not in either list
   * and must not be. rockysurf-55fx.15 ruled that out — EC2 reports `pending` for a restart
   * identically to a first boot, so core would be asserting a status from its own request
   * having been accepted. The in-flight affordance is client-side presentation instead, and
   * `useServerTransition` is where it lives.
   */
  it('and the status labels are exactly the statuses core can put on a row', () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual(coreVocabulary('SERVER_STATUSES').sort())
  })
})

/**
 * WHICH GIT TOKENS THIS BOX CARRIES (rockysurf-18lq).
 *
 * Narrowing made this a real question with a per-box answer, and made its cost worth stating in
 * the same place: there is no way to push a token to a running machine, so a repository nobody
 * declared at create is one this box may simply not be able to clone. A user who learns that
 * from a failed clone on the box has already paid for the boot.
 */
describe('the git tokens a box was built with', () => {
  it('names the scopes it carries, and the fallback alongside them', async () => {
    row = {
      ...SERVER,
      repositories: ['https://github.com/acme/widgets'],
      githubTokenScopes: ['github.com/acme/widgets'],
      carriesFallbackToken: true,
    }
    renderPage()

    const block = await screen.findByTestId('github-token-scopes')
    expect(block.textContent).toContain('github.com/acme/widgets')
    expect(block.textContent).toContain('github.pat')
    // The trade, in the same breath as the fact.
    expect(block.textContent).toContain('no way to add one to a running box')
  })

  it('says so plainly when narrowing left it with only the fallback', async () => {
    row = { ...SERVER, repositories: ['https://github.com/public/thing'], githubTokenScopes: [], carriesFallbackToken: true }
    renderPage()

    const block = await screen.findByTestId('github-token-scopes')
    expect(block.textContent).toContain('only the instance-wide')
  })

  it('says nothing at all when core has no git configuration to answer from', async () => {
    // Absent is not `[]`. "This installation configures no tokens" and "this box was given none
    // of them" are different claims, and a page that rendered them identically would be
    // inventing one of them.
    row = { ...SERVER, repositories: ['https://github.com/acme/widgets'] }
    renderPage()

    await screen.findByRole('heading', { name: /repositories/i })
    expect(screen.queryByTestId('github-token-scopes')).toBeNull()
  })
})
