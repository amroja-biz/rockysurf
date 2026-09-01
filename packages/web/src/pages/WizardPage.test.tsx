import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '../contexts/AuthContext'
import { ApiError, type SetupState } from '../lib/api'
import { SetupGate, WizardPage } from './WizardPage'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ...actual,
    getCurrentUser: vi.fn(),
    getSetupState: vi.fn(),
    enableProvider: vi.fn(),
  }
})

const { getCurrentUser, getSetupState, enableProvider } = await import('../lib/api')

const USER = { id: 'u1', username: 'admin', email: null, avatarUrl: null, isAdmin: true }

const freshInstall: SetupState = {
  complete: false,
  needsProvider: true,
  providers: [
    { id: 'hetzner', displayName: 'Hetzner Cloud', enabled: false, configured: false, source: 'none', loaded: false },
    { id: 'aws', displayName: 'Amazon EC2', enabled: false, configured: false, source: 'none', loaded: false },
  ],
}

/** A token cloud switched on, waiting for its environment variable and a restart. */
const enabledWaiting: SetupState = {
  complete: false,
  needsProvider: false,
  providers: [
    {
      id: 'hetzner',
      displayName: 'Hetzner Cloud',
      enabled: true,
      configured: false,
      source: 'none',
      loaded: false,
      unavailableReason: 'no credential found — export HETZNER_TOKEN (or HCLOUD_TOKEN) and restart',
    },
    { id: 'aws', displayName: 'Amazon EC2', enabled: false, configured: false, source: 'none', loaded: false },
  ],
}

/** The return leg: the variable was exported, the process restarted, the provider loaded. */
const detectedAfterRestart: SetupState = {
  complete: true,
  needsProvider: false,
  providers: [
    {
      id: 'hetzner',
      displayName: 'Hetzner Cloud',
      enabled: true,
      configured: true,
      source: 'env',
      envVar: 'HETZNER_TOKEN',
      loaded: true,
    },
  ],
}

const ready: SetupState = {
  complete: true,
  needsProvider: false,
  providers: [
    { id: 'hetzner', displayName: 'Hetzner Cloud', enabled: true, configured: true, source: 'config', loaded: true },
  ],
}

function renderWizard() {
  return render(
    <MemoryRouter initialEntries={['/setup']}>
      <AuthProvider>
        <Routes>
          <Route path="/setup" element={<WizardPage />} />
          <Route path="/" element={<p>DASHBOARD</p>} />
          <Route path="/login" element={<p>LOGIN</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

const click = (testId: string) => fireEvent.click(screen.getByTestId(testId))

beforeEach(() => {
  window.localStorage.clear()
  vi.mocked(getCurrentUser).mockResolvedValue(USER)
  vi.mocked(getSetupState).mockResolvedValue(freshInstall)
  vi.mocked(enableProvider).mockResolvedValue(enabledWaiting)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('the wizard walkthrough', () => {
  it('goes welcome → account → provider → done', async () => {
    renderWizard()

    expect(await screen.findByRole('heading', { name: 'Welcome' })).toBeTruthy()
    click('next')

    // The account step's whole job is to point out that signing in already PROVED the
    // password works, rather than asking the user to set one they have.
    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeTruthy()
    expect(screen.getByText('admin')).toBeTruthy()
    click('next')

    expect(await screen.findByRole('heading', { name: 'Choose your clouds' })).toBeTruthy()
  })

  it('sends an unauthenticated visitor to the login page', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new ApiError(401, 'Unauthorized'))
    renderWizard()
    expect(await screen.findByText('LOGIN')).toBeTruthy()
  })
})

describe('the provider step collects no credentials', () => {
  async function reachProviderStep() {
    renderWizard()
    await screen.findByTestId('next')
    click('next')
    await screen.findByRole('heading', { name: 'Your account' })
    click('next')
    await screen.findByRole('heading', { name: 'Choose your clouds' })
  }

  it('renders no password or text input anywhere — there is nothing to paste', async () => {
    // The owner ruling this page implements (issue #280): the wizard selects clouds, and every
    // credential comes from the user's own auth path. A single input here is a regression.
    await reachProviderStep()
    expect(document.querySelector('input')).toBeNull()
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('shows the selected cloud’s auth-path instructions inline', async () => {
    await reachProviderStep()
    const instructions = screen.getByTestId('cloud-instructions')
    // Hetzner is selected first: its path is an environment variable and a restart.
    expect(instructions.textContent).toContain('HETZNER_TOKEN')
    expect(instructions.textContent).toContain('never stores')
  })

  it('switches a cloud on and remembers that it is waiting on a restart', async () => {
    await reachProviderStep()
    click('turn-on')

    await waitFor(() => expect(vi.mocked(enableProvider)).toHaveBeenCalledWith('hetzner'))
    // Enabled but not loaded: the walkthrough records the wait, so a restart returns here.
    await waitFor(() => expect(window.localStorage.getItem('rockysurf.wizard.pending')).toBe('hetzner'))
  })

  it('shows the waiting state with core’s own reason, and offers a re-check', async () => {
    vi.mocked(getSetupState).mockResolvedValueOnce(freshInstall).mockResolvedValue(enabledWaiting)

    await reachProviderStep()
    click('turn-on')

    const waiting = await screen.findByTestId('cloud-waiting')
    expect(waiting.textContent).toContain('switched on')
    // The composition root's words, verbatim — they name the variable to export.
    expect((await screen.findByTestId('cloud-reason')).textContent).toContain('HETZNER_TOKEN')
    expect(screen.getByTestId('check-again')).toBeTruthy()
  })

  it('surfaces an enable failure VERBATIM and does not advance', async () => {
    const message = 'providers.hetzner.enabled: could not write rockysurf.config.yaml'
    vi.mocked(enableProvider).mockRejectedValue(new ApiError(400, 'Bad Request', { error: message }))

    await reachProviderStep()
    click('turn-on')

    expect(await screen.findByTestId('provider-error')).toHaveProperty('textContent', message)
    expect(screen.getByRole('heading', { name: 'Choose your clouds' })).toBeTruthy()
  })

  it('shows a cloud that is already on and ready, with nothing left to do', async () => {
    vi.mocked(getSetupState).mockResolvedValue(ready)
    await reachProviderStep()
    expect((await screen.findByTestId('cloud-ready')).textContent).toContain('on and ready')
    expect(screen.queryByTestId('turn-on')).toBeNull()
  })
})

describe('the set-variable-and-restart return leg (issue #280)', () => {
  it('reopens on the provider step and announces the detected variable', async () => {
    // The user enabled Hetzner, exported HETZNER_TOKEN, restarted Rocky Surf and came back.
    window.localStorage.setItem('rockysurf.wizard.pending', 'hetzner')
    vi.mocked(getSetupState).mockResolvedValue(detectedAfterRestart)

    renderWizard()

    // Straight to the step that was waiting — not back to Welcome.
    expect(await screen.findByRole('heading', { name: 'Choose your clouds' })).toBeTruthy()
    const detected = await screen.findByTestId('detected')
    expect(detected.textContent).toContain('Hetzner Cloud is on and ready')
    expect(detected.textContent).toContain('HETZNER_TOKEN')
    // The wait is over, so a later navigation must not drag the user back here.
    await waitFor(() => expect(window.localStorage.getItem('rockysurf.wizard.pending')).toBeNull())
  })

  it('keeps waiting, with instructions still visible, when the variable is not set yet', async () => {
    window.localStorage.setItem('rockysurf.wizard.pending', 'hetzner')
    vi.mocked(getSetupState).mockResolvedValue(enabledWaiting)

    renderWizard()

    expect(await screen.findByRole('heading', { name: 'Choose your clouds' })).toBeTruthy()
    expect(screen.queryByTestId('detected')).toBeNull()
    expect((await screen.findByTestId('cloud-reason')).textContent).toContain('HETZNER_TOKEN')
    expect(window.localStorage.getItem('rockysurf.wizard.pending')).toBe('hetzner')
  })
})

describe('the done step is honest about what is left', () => {
  it('says almost there, and names the cloud still waiting on its credentials', async () => {
    vi.mocked(getSetupState).mockResolvedValue(enabledWaiting)

    renderWizard()
    await screen.findByTestId('next')
    click('next')
    await screen.findByRole('heading', { name: 'Your account' })
    click('next')
    await screen.findByRole('heading', { name: 'Choose your clouds' })
    click('skip-step')

    expect(await screen.findByRole('heading', { name: 'Almost there' })).toBeTruthy()
    const note = await screen.findByTestId('pending-note')
    expect(note.textContent).toContain('Hetzner Cloud')
    expect(note.textContent).toContain('environment variable')
  })

  it('says you are ready when a provider really is usable', async () => {
    vi.mocked(getSetupState).mockResolvedValue(ready)

    renderWizard()
    await screen.findByTestId('next')
    click('next')
    await screen.findByRole('heading', { name: 'Your account' })
    click('next')
    await screen.findByRole('heading', { name: 'Choose your clouds' })
    click('skip-step')

    expect(await screen.findByRole('heading', { name: 'You are ready' })).toBeTruthy()
  })
})

describe('skipping', () => {
  it('can be skipped from any step, landing on the dashboard', async () => {
    renderWizard()
    await screen.findByTestId('skip-all')
    click('skip-all')
    expect(await screen.findByText('DASHBOARD')).toBeTruthy()
  })

  it('remembers the skip, so it does not nag on every navigation', async () => {
    renderWizard()
    await screen.findByTestId('skip-all')
    click('skip-all')
    await screen.findByText('DASHBOARD')
    expect(window.localStorage.getItem('rockysurf.wizard.dismissed')).toBe('1')
  })

  it('clears the pending wait too — a skip is a skip, not a snooze', async () => {
    window.localStorage.setItem('rockysurf.wizard.pending', 'hetzner')
    vi.mocked(getSetupState).mockResolvedValue(enabledWaiting)
    renderWizard()
    await screen.findByTestId('skip-all')
    click('skip-all')
    await screen.findByText('DASHBOARD')
    expect(window.localStorage.getItem('rockysurf.wizard.pending')).toBeNull()
  })
})

describe('SetupGate', () => {
  function renderGate() {
    return render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              <SetupGate>
                <p>DASHBOARD</p>
              </SetupGate>
            }
          />
          <Route path="/setup" element={<p>WIZARD</p>} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('sends a fresh install to the wizard', async () => {
    renderGate()
    expect(await screen.findByText('WIZARD')).toBeTruthy()
  })

  it('brings back a walkthrough that is waiting on a restart, even with a cloud enabled', async () => {
    // The return leg: `needsProvider` is false the moment a cloud is enabled, but the user was
    // told to restart and come back — the wizard is where "detected" or "not yet" is said.
    window.localStorage.setItem('rockysurf.wizard.pending', 'hetzner')
    vi.mocked(getSetupState).mockResolvedValue(enabledWaiting)
    renderGate()
    expect(await screen.findByText('WIZARD')).toBeTruthy()
  })

  it('leaves a configured installation alone — a config-file user never sees the wizard', async () => {
    vi.mocked(getSetupState).mockResolvedValue(ready)
    renderGate()
    expect(await screen.findByText('DASHBOARD')).toBeTruthy()
  })

  it('respects a previous skip', async () => {
    window.localStorage.setItem('rockysurf.wizard.dismissed', '1')
    renderGate()
    expect(await screen.findByText('DASHBOARD')).toBeTruthy()
  })

  it('does not redirect when core cannot be reached, rather than trapping the user', async () => {
    vi.mocked(getSetupState).mockRejectedValue(new ApiError(500, 'Server Error'))
    renderGate()
    expect(await screen.findByText('DASHBOARD')).toBeTruthy()
  })
})

describe('the sanctioned provider-literal boundary', () => {
  /**
   * The zero-conditionals rule stands everywhere except this file's copy helper
   * (ruling on rockysurf-hzi7.2 — see the comment above it). An exception nobody polices
   * is an exception that widens, so this pins where it ends.
   */
  // Resolved from the package root, not `import.meta.url`: under jsdom that is an http URL,
  // not a file one, and `fileURLToPath` rejects it.
  const source = readFileSync(join(process.cwd(), 'src/pages/WizardPage.tsx'), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  /** Everything above the copy helper — the part the rule still governs. */
  const logic = code.split('function cloudSetupSteps')[0]!

  it('never branches on a provider id in the wizard logic', () => {
    expect(logic).not.toMatch(/provider\.id\s*===\s*['"]/)
    expect(logic).not.toMatch(/providerId\s*===\s*['"]/)
    expect(logic).not.toMatch(/selected\s*===\s*['"]/)
  })

  it('keeps every provider literal inside the copy helper', () => {
    for (const literal of ['aws', 'azure', 'gcp', 'hetzner', 'byo']) {
      expect(logic).not.toMatch(new RegExp(`['"\`]${literal}['"\`]`))
    }
  })

  it('drives the flow from SetupState rather than from ids', () => {
    // loaded/enabled/unavailableReason come from core; the wizard renders what it is told.
    expect(logic).toContain('unavailableReason')
    expect(logic).toContain('setup?.complete')
  })

  it('collects no credentials anywhere in the file — issue #280 is a standing ruling', () => {
    // No input of any kind renders on this page, and nothing here may reintroduce one. The
    // strings below are the shapes a credential box would need.
    expect(code).not.toMatch(/type=["']password["']/)
    expect(code).not.toMatch(/<input/)
    expect(code).not.toMatch(/<textarea/)
  })

  it('records the ruling and the fix that retires it, so the exception is not folklore', () => {
    expect(source).toContain('SANCTIONED')
    expect(source).toContain('rockysurf-hzi7.2')
    expect(source).toContain('registration-time handoff')
  })
})
