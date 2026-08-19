import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, getGithubConnection, pollGithubConnect, startGithubConnect, type GithubConnection } from '../lib/api'
import { ConnectGitHubCard } from './ConnectGitHubCard'

/**
 * The Connect GitHub card's state machine (rockysurf-7fyf.2).
 *
 * MOCKED AT THE API-CLIENT BOUNDARY, which is the only boundary there is: the browser never
 * talks to github.com — core polls the device endpoints and hands back a status — so mocking
 * `lib/api` mocks the entire flow with no second network path left to leak into CI.
 *
 * DETERMINISM, AND THE REASON IT IS SPELLED OUT (rockysurf-zn33). The known flake in this suite
 * was `waitFor` around a mock's call count and around timeouts. Polling is time-driven, so this
 * file drives time itself: `vi.useFakeTimers()`, `advanceTimersByTimeAsync` inside `act`, then
 * SYNCHRONOUS assertions. There is no `waitFor` here, no arbitrary timeout, and no real sleep —
 * every wait in these cases is a number of milliseconds the test chose.
 */

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return {
    ...actual,
    getGithubConnection: vi.fn(),
    startGithubConnect: vi.fn(),
    pollGithubConnect: vi.fn(),
    disconnectGithub: vi.fn(),
  }
})

const DEVICE_CODE_NOBODY_SHOULD_SEE = 'dc-secret-device-code'

const START = {
  flowId: 'flow-1',
  userCode: 'WDJB-MJHT',
  verificationUri: 'https://github.com/login/device',
  expiresInSeconds: 900,
  intervalSeconds: 5,
}

const DISCONNECTED: GithubConnection = {
  clientIdConfigured: true,
  connected: false,
  configFallbackSet: false,
}

const CONNECTED: GithubConnection = {
  clientIdConfigured: true,
  connected: true,
  login: 'octocat',
  scopes: ['repo'],
  connectedAt: '2026-08-19T12:00:00.000Z',
  configFallbackSet: false,
}

const mocked = {
  connection: vi.mocked(getGithubConnection),
  start: vi.mocked(startGithubConnect),
  poll: vi.mocked(pollGithubConnect),
}

/**
 * The card as the Settings page holds it: the connection is the PARENT's state, and `onChanged`
 * re-reads it. Faithful on purpose — the card deliberately keeps no memory of its own about
 * whether an account is connected.
 */
function Harness({ initial }: { initial: GithubConnection }) {
  const [connection, setConnection] = useState<GithubConnection | null>(initial)
  return (
    <ConnectGitHubCard
      connection={connection}
      onChanged={async () => setConnection(await getGithubConnection())}
      onDisconnect={() => {}}
    />
  )
}

/** Advance the clock and let React settle, with no `waitFor` anywhere. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** Press Connect and let the start request settle. */
async function connect(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Connect GitHub' }))
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  mocked.connection.mockReset().mockResolvedValue(CONNECTED)
  mocked.start.mockReset().mockResolvedValue(START)
  mocked.poll.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('with no OAuth App configured', () => {
  it('renders, disabled, with the two setup steps — it does not hide', () => {
    render(<Harness initial={{ ...DISCONNECTED, clientIdConfigured: false }} />)

    // VISIBLE is the assertion. A control whose edit has a destination must show the way there.
    const button = screen.getByRole('button', { name: 'Connect GitHub' })
    expect(button).toBeTruthy()
    expect((button as HTMLButtonElement).disabled).toBe(true)

    const setup = document.querySelector('[data-github-setup]')!
    expect(setup.textContent).toContain('Enable Device Flow')
    expect(setup.textContent).toContain('github.oauth.clientId')
    expect(document.querySelector('a[href="https://github.com/settings/applications/new"]')).toBeTruthy()
  })

  it('says there is no catch-all key rather than implying one', () => {
    render(<Harness initial={{ ...DISCONNECTED, clientIdConfigured: false }} />)
    expect(document.querySelector('[data-broad-credential]')!.textContent).toBe(
      'Everything else: no catch-all key',
    )
  })
})

describe('starting a flow', () => {
  it('shows the code and the URL, and never the device code', async () => {
    mocked.poll.mockResolvedValue({ status: 'pending', intervalSeconds: 5, message: 'Waiting.' })
    render(<Harness initial={DISCONNECTED} />)

    await connect()

    expect(document.querySelector('[data-user-code]')!.textContent).toBe('WDJB-MJHT')
    expect(document.querySelector(`a[href="${START.verificationUri}"]`)).toBeTruthy()
    // The bearer half of the pair stays on the server, so it cannot be in the DOM at all.
    expect(document.body.textContent).not.toContain(DEVICE_CODE_NOBODY_SHOULD_SEE)
    expect(document.body.textContent).not.toContain('flow-1')
  })

  it('states the scope breadth before the operator reaches GitHub', () => {
    render(<Harness initial={DISCONNECTED} />)
    expect(document.querySelector('[data-scope-note]')!.textContent).toContain('repo scope')
    expect(document.querySelector('[data-scope-note]')!.textContent).toContain('per-repository token')
  })
})

describe('polling', () => {
  it('walks pending → pending → connected, then stops', async () => {
    mocked.poll
      .mockResolvedValueOnce({ status: 'pending', intervalSeconds: 5, message: 'Waiting.' })
      .mockResolvedValueOnce({ status: 'pending', intervalSeconds: 5, message: 'Waiting.' })
      .mockResolvedValueOnce({
        status: 'connected',
        login: 'octocat',
        scopes: ['repo'],
        connectedAt: CONNECTED.connectedAt!,
      })
    render(<Harness initial={DISCONNECTED} />)
    await connect()

    await tick(5000)
    expect(mocked.poll).toHaveBeenCalledTimes(1)
    await tick(5000)
    expect(mocked.poll).toHaveBeenCalledTimes(2)
    await tick(5000)
    expect(mocked.poll).toHaveBeenCalledTimes(3)

    expect(document.querySelector('[data-github-connected]')!.textContent).toBe('Connected as @octocat')
    expect(document.body.textContent).toContain('Granted scopes: repo.')
    expect(document.querySelector('[data-broad-credential]')!.textContent).toBe(
      'Everything else: connected as @octocat',
    )

    // A poll still running after a terminal state is a leak, and the leak is what makes a
    // suite flaky. A whole minute of clock, and the count does not move.
    await tick(60_000)
    expect(mocked.poll).toHaveBeenCalledTimes(3)
  })

  it('lengthens the gap on slow_down and keeps it lengthened', async () => {
    mocked.poll
      .mockResolvedValueOnce({ status: 'pending', intervalSeconds: 10, slowDown: true, message: 'Slower.' })
      .mockResolvedValue({ status: 'pending', intervalSeconds: 10, message: 'Waiting.' })
    render(<Harness initial={DISCONNECTED} />)
    await connect()

    await tick(5000)
    expect(mocked.poll).toHaveBeenCalledTimes(1)

    // Five seconds was enough before and is not enough now.
    await tick(5000)
    expect(mocked.poll).toHaveBeenCalledTimes(1)
    await tick(5000)
    expect(mocked.poll).toHaveBeenCalledTimes(2)
  })

  it('stops on Cancel', async () => {
    mocked.poll.mockResolvedValue({ status: 'pending', intervalSeconds: 5, message: 'Waiting.' })
    render(<Harness initial={DISCONNECTED} />)
    await connect()
    await tick(5000)
    expect(mocked.poll).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })

    await tick(60_000)
    expect(mocked.poll).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeTruthy()
  })

  it('stops on unmount, so a navigated-away page polls nothing', async () => {
    mocked.poll.mockResolvedValue({ status: 'pending', intervalSeconds: 5, message: 'Waiting.' })
    const view = render(<Harness initial={DISCONNECTED} />)
    await connect()
    await tick(5000)
    expect(mocked.poll).toHaveBeenCalledTimes(1)

    view.unmount()

    await tick(60_000)
    expect(mocked.poll).toHaveBeenCalledTimes(1)
  })
})

describe('the states that are not success', () => {
  it('expires without restarting itself, and offers a new code', async () => {
    mocked.start.mockResolvedValue({ ...START, expiresInSeconds: 3 })
    mocked.poll.mockResolvedValue({ status: 'pending', intervalSeconds: 5, message: 'Waiting.' })
    render(<Harness initial={DISCONNECTED} />)
    await connect()

    await tick(3000)

    expect(document.querySelector('[data-github-message]')!.textContent).toContain('The code expired')
    expect(screen.getByRole('button', { name: 'Get a new code' })).toBeTruthy()

    // NO AUTO-RESTART. A misconfigured app would otherwise loop against a wall forever without
    // ever saying why, so the next code is asked for.
    await tick(60_000)
    expect(mocked.start).toHaveBeenCalledTimes(1)
    expect(mocked.poll).not.toHaveBeenCalled()
  })

  it('renders a denial in the server’s own words', async () => {
    mocked.poll.mockResolvedValue({ status: 'denied', message: 'The authorization was declined on github.com.' })
    render(<Harness initial={DISCONNECTED} />)
    await connect()

    await tick(5000)

    expect(document.querySelector('[data-github-message]')!.textContent).toContain('declined on github.com')
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeTruthy()
  })

  /**
   * THE LIKELIEST SETUP MISTAKE. The cure is a checkbox the operator can reach in ten seconds,
   * so the card has to hand them the checkbox rather than "something went wrong".
   */
  it('renders device_flow_disabled as the checkbox to tick', async () => {
    mocked.start.mockRejectedValue(
      new ApiError(400, 'Bad Request', {
        error:
          'This OAuth App does not have the device flow enabled. Open it at ' +
          'github.com/settings/developers, tick "Enable Device Flow" in its settings, and try again.',
        code: 'bad_request',
        githubCode: 'device_flow_disabled',
      }),
    )
    render(<Harness initial={DISCONNECTED} />)

    await connect()

    const message = document.querySelector('[data-github-message]')!
    expect(message.textContent).toContain('Enable Device Flow')
    expect(message.textContent).not.toContain('something went wrong')
  })
})
