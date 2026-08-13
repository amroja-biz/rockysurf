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
    saveProviderCredential: vi.fn(),
  }
})

const { getCurrentUser, getSetupState, saveProviderCredential } = await import('../lib/api')

const USER = { id: 'u1', username: 'admin', email: null, avatarUrl: null, isAdmin: true }

const freshInstall: SetupState = {
  complete: false,
  needsProvider: true,
  providers: [
    { id: 'hetzner', displayName: 'Hetzner Cloud', enabled: false, configured: false, source: 'none', loaded: true },
    { id: 'aws', displayName: 'Amazon EC2', enabled: false, configured: false, source: 'none', loaded: false },
  ],
}

const ready: SetupState = {
  complete: true,
  needsProvider: false,
  providers: [
    { id: 'hetzner', displayName: 'Hetzner Cloud', enabled: true, configured: true, source: 'config', loaded: true },
  ],
}

function type(input: HTMLInputElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setValue.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
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
  vi.mocked(saveProviderCredential).mockResolvedValue(freshInstall)
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

    expect(await screen.findByRole('heading', { name: 'Add a cloud' })).toBeTruthy()
  })

  it('sends an unauthenticated visitor to the login page', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new ApiError(401, 'Unauthorized'))
    renderWizard()
    expect(await screen.findByText('LOGIN')).toBeTruthy()
  })
})

describe('the provider step', () => {
  async function reachProviderStep() {
    renderWizard()
    await screen.findByTestId('next')
    click('next')
    await screen.findByRole('heading', { name: 'Your account' })
    click('next')
    await screen.findByRole('heading', { name: 'Add a cloud' })
  }

  it('surfaces the provider error VERBATIM and does not advance', async () => {
    // The provider's own message is the one string that distinguishes a read-only token from
    // a wrong one. Replacing it with house prose would throw that away.
    const message = 'hetzner GET /servers: unauthorized: unable to authenticate'
    vi.mocked(saveProviderCredential).mockRejectedValue(new ApiError(401, 'Unauthorized', { error: message }))

    await reachProviderStep()
    type(screen.getByLabelText('API token') as HTMLInputElement, 'wrong-token')
    click('save-credential')

    expect(await screen.findByTestId('provider-error')).toHaveProperty('textContent', message)
    // Still on the same step: a failed credential must not look like progress.
    expect(screen.getByRole('heading', { name: 'Add a cloud' })).toBeTruthy()
  })

  it('saves a credential and moves on', async () => {
    await reachProviderStep()
    type(screen.getByLabelText('API token') as HTMLInputElement, 'hz_good_token')
    click('save-credential')

    await waitFor(() => expect(vi.mocked(saveProviderCredential)).toHaveBeenCalledWith('hetzner', 'hz_good_token'))
    expect(await screen.findByRole('heading', { name: /Almost there|You are ready/ })).toBeTruthy()
  })

  it('will not submit an empty credential', async () => {
    await reachProviderStep()
    expect((screen.getByTestId('save-credential') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a read-only provider as already configured, with no input to fill', async () => {
    vi.mocked(getSetupState).mockResolvedValue({
      complete: false,
      needsProvider: true,
      providers: [
        {
          id: 'hetzner',
          displayName: 'Hetzner Cloud',
          enabled: false,
          configured: true,
          source: 'env',
          loaded: true,
          readOnlyReason: 'HCLOUD_TOKEN is set in the environment, which wins at runtime.',
        },
      ],
    })

    await reachProviderStep()
    expect(screen.getByTestId('read-only').textContent).toContain('HCLOUD_TOKEN')
    expect(screen.queryByLabelText('API token')).toBeNull()
  })
})

describe('the done step is honest about what is left', () => {
  it('says almost there, and names what to enable, when the credential is stored but not live', async () => {
    // Storing a token does not make a provider usable: it has to be enabled and loaded too.
    // Claiming success here would send a stranger to a dashboard that fails at their first click.
    vi.mocked(saveProviderCredential).mockResolvedValue({
      complete: false,
      needsProvider: false,
      providers: [
        {
          id: 'hetzner',
          displayName: 'Hetzner Cloud',
          enabled: false,
          configured: true,
          source: 'stored',
          loaded: false,
        },
      ],
    })
    vi.mocked(getSetupState)
      .mockResolvedValueOnce(freshInstall)
      .mockResolvedValue({
        complete: false,
        needsProvider: false,
        providers: [
          {
            id: 'hetzner',
            displayName: 'Hetzner Cloud',
            enabled: false,
            configured: true,
            source: 'stored',
            loaded: false,
          },
        ],
      })

    renderWizard()
    await screen.findByTestId('next')
    click('next')
    await screen.findByRole('heading', { name: 'Your account' })
    click('next')
    await screen.findByRole('heading', { name: 'Add a cloud' })
    type(screen.getByLabelText('API token') as HTMLInputElement, 'hz_good')
    click('save-credential')

    expect(await screen.findByRole('heading', { name: 'Almost there' })).toBeTruthy()
    const note = await screen.findByTestId('pending-note')
    expect(note.textContent).toContain('Hetzner Cloud')
    expect(note.textContent).toContain('rockysurf.config.yaml')
  })

  it('says you are ready when a provider really is usable', async () => {
    vi.mocked(getSetupState).mockResolvedValue(ready)
    vi.mocked(saveProviderCredential).mockResolvedValue(ready)

    renderWizard()
    await screen.findByTestId('next')
    click('next')
    await screen.findByRole('heading', { name: 'Your account' })
    click('next')
    await screen.findByRole('heading', { name: 'Add a cloud' })
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
   * The zero-conditionals rule stands everywhere except this file's copy helpers
   * (ruling on rockysurf-hzi7.2 — see the comment above them). An exception nobody polices
   * is an exception that widens, so this pins where it ends.
   */
  // Resolved from the package root, not `import.meta.url`: under jsdom that is an http URL,
  // not a file one, and `fileURLToPath` rejects it.
  const source = readFileSync(join(process.cwd(), 'src/pages/WizardPage.tsx'), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  /** Everything above the three copy helpers — the part the rule still governs. */
  const logic = code.split('function tokenLabel')[0]!

  it('never branches on a provider id in the wizard logic', () => {
    expect(logic).not.toMatch(/provider\.id\s*===/)
    expect(logic).not.toMatch(/providerId\s*===\s*['"]/)
    expect(logic).not.toMatch(/selected\s*===\s*['"]/)
  })

  it('keeps every provider literal inside the copy helpers', () => {
    for (const literal of ['aws', 'hetzner', 'byo']) {
      expect(logic).not.toMatch(new RegExp(`['"\`]${literal}['"\`]`))
    }
  })

  it('drives the flow from SetupState rather than from ids', () => {
    // readOnlyReason and loaded/configured come from core; the wizard renders what it is told.
    expect(logic).toContain('readOnlyReason')
    expect(logic).toContain('setup?.complete')
  })

  it('records the ruling and the fix that retires it, so the exception is not folklore', () => {
    expect(source).toContain('SANCTIONED')
    expect(source).toContain('rockysurf-hzi7.2')
    expect(source).toContain('registration-time handoff')
  })
})
