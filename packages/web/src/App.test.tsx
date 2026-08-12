import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App, APP_NAME } from './App'
import { setAuthToken } from './lib/api'

/**
 * The integration test the milestone exit asks for: sign in, then receive a live event.
 *
 * IT RUNS AGAINST A REAL HTTP SERVER, not a mocked `fetch`. The server below is a stand-in for
 * core that implements its contract exactly — `POST /auth/login` returning `{ user, token }`
 * and setting a session cookie, `GET /auth/me`, and `GET /events` as an SSE stream that opens
 * with a `connected` frame. So this proves the SPA half end to end: real requests, a real
 * `EventSource`, real re-rendering when a message lands.
 *
 * WHERE THE SEAM IS, stated plainly: the server half is proven by core's own `app.test.ts`,
 * which drives the genuine routes. Wiring the real core into this suite would make the web
 * package build-depend on core's `dist`, which is a worse trade than two tests that meet in
 * the middle at a contract both are written against.
 */

const PASSWORD = 'correct-horse-battery-staple'
const USER = { id: 'u1', username: 'admin', email: null, avatarUrl: null, isAdmin: true }

const CAPABILITIES = {
  stop: true,
  ipStableAcrossStop: true,
  canInjectHostKeys: true,
  userDataMaxBytes: 32768,
  generatesUserData: true,
}

/** One provisioning server, so the dashboard has something whose status can visibly change. */
const SERVER = {
  serverId: 'srv-abc123',
  name: 'dev-box',
  provider: 'fake',
  status: 'provisioning',
  size: 'small',
  sshUser: 'rocky',
  estimatedTotalCost: 0,
  tools: [],
  repositories: [],
  totalUptimeSeconds: 0,
  createdAt: '2026-08-12T00:00:00.000Z',
}

/** Matches `environmentOptions.jsdom.url` in vitest.config.ts — see the note there. */
const STUB_PORT = 34567

let server: Server
/** Held so a test can push an event down the open stream at the moment it chooses. */
let streams: Array<(chunk: string) => void> = []

/**
 * Type a value into a controlled input.
 *
 * React tracks the input's value on the DOM node itself, so assigning `.value` directly is
 * invisible to its `onChange`. Going through the native setter is the standard way around it,
 * and is cheaper than a `user-event` dependency for two tests.
 */
function type(input: HTMLInputElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setValue.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(async () => {
  streams = []
  let signedIn = false

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (req.method === 'POST' && url.pathname === '/api/v1/auth/login') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const { password } = JSON.parse(body || '{}') as { password?: string }
        if (password !== PASSWORD) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid password', code: 'unauthorized' }))
          return
        }
        signedIn = true
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ user: USER, token: 'session-token' }))
      })
      return
    }

    if (url.pathname === '/api/v1/auth/me') {
      res.writeHead(signedIn ? 200 : 401, { 'content-type': 'application/json' })
      res.end(signedIn ? JSON.stringify({ user: USER }) : JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    if (url.pathname === '/api/v1/servers') {
      res.writeHead(signedIn ? 200 : 401, { 'content-type': 'application/json' })
      res.end(JSON.stringify(signedIn ? [SERVER] : { error: 'Unauthorized' }))
      return
    }

    if (url.pathname === '/api/v1/providers') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ id: 'fake', displayName: 'Fake', capabilities: CAPABILITIES }]))
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

  await new Promise<void>((resolve) => server.listen(STUB_PORT, '127.0.0.1', resolve))
  // No base-URL override: jsdom's document origin is this server, so the SPA's same-origin
  // default is what the requests actually use.
  expect((server.address() as AddressInfo).port).toBe(STUB_PORT)
})

afterEach(async () => {
  setAuthToken(null)
  streams = []
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
})

/** Push one message down every open stream, the way core's broadcast does. */
function broadcast(payload: object): void {
  const frame = `event: message\ndata: ${JSON.stringify(payload)}\n\n`
  streams.forEach((write) => write(frame))
}

/**
 * Push an event until the page reacts to it.
 *
 * The stream opens before the page that consumes it has finished mounting and subscribing, so
 * a single push can land in the gap and be dropped — the same as a real server emitting while
 * a tab is still loading. Re-pushing inside `waitFor` removes the race without weakening what
 * is being asserted: the assertion still has to pass on a real re-render.
 */
async function broadcastUntil(payload: object, assertion: () => void): Promise<void> {
  await waitFor(() => {
    broadcast(payload)
    assertion()
  })
}

describe('the app shell', () => {
  it('has a name the workspace can assert on', () => {
    expect(APP_NAME).toBe('Rocky Surf')
  })

  it('shows the login page when nobody is signed in', async () => {
    render(<App />)
    expect(await screen.findByLabelText(/admin password/i)).toBeDefined()
  })

  it('refuses a wrong password with a message rather than a stack trace', async () => {
    render(<App />)

    type((await screen.findByLabelText(/admin password/i)) as HTMLInputElement, 'wrong')
    ;(await screen.findByRole('button', { name: /sign in/i })).click()

    expect((await screen.findByRole('alert')).textContent).toContain('Incorrect password')
  })
})

describe('login, then a live event', () => {
  it('signs in and renders an event pushed down the stream, with no reload', async () => {
    render(<App />)

    type((await screen.findByLabelText(/admin password/i)) as HTMLInputElement, PASSWORD)
    ;(await screen.findByRole('button', { name: /sign in/i })).click()

    // Signed in: the dashboard replaced the login form, and it lists the server.
    expect(await screen.findByRole('heading', { name: /servers/i })).toBeDefined()
    // By role: the name also appears in the activity feed, and the card's link is the one
    // that means "this server is listed".
    expect(await screen.findByRole('link', { name: 'dev-box' })).toBeDefined()
    expect(await screen.findByText('Provisioning')).toBeDefined()

    // The stream opened and core greeted us.
    await waitFor(() => expect(screen.getByTestId('connection-status').textContent).toContain('connected'))

    // The thing the milestone actually asks for: an event arrives and the card changes,
    // with no refetch and no reload.
    await waitFor(() => expect(streams.length).toBeGreaterThan(0))
    await broadcastUntil({ type: 'server-status', serverId: 'srv-abc123', status: 'running', publicIp: '203.0.113.7' }, () =>
      expect(screen.getByText('Running')).toBeDefined(),
    )

    expect(await screen.findByText('203.0.113.7')).toBeDefined()
  })

  it('offers Stop only because the provider says it can stop', async () => {
    render(<App />)
    type((await screen.findByLabelText(/admin password/i)) as HTMLInputElement, PASSWORD)
    ;(await screen.findByRole('button', { name: /sign in/i })).click()

    await waitFor(() => expect(streams.length).toBeGreaterThan(0))
    await broadcastUntil({ type: 'server-status', serverId: 'srv-abc123', status: 'running' }, () =>
      expect(screen.getByText('Running')).toBeDefined(),
    )

    // The capability, not the provider's name, is what puts this button on screen.
    expect(await screen.findByRole('button', { name: /^stop$/i })).toBeDefined()
  })
})
