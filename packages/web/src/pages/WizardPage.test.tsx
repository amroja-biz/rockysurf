import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '../contexts/AuthContext'
import { ApiError, type SettingsView, type SetupState } from '../lib/api'
import { SetupGate, WizardPage } from './WizardPage'

/**
 * THE WIZARD, AFTER IT WAS MADE TO SET THINGS UP (issue #474).
 *
 * The old suite pinned a page that collected nothing: "renders no input anywhere" was a passing
 * test about a wizard that could not finish a setup. What is pinned here instead is the flow the
 * owner asked for — every step reachable forwards and backwards, one cloud's real Settings fields
 * drawn in place, a save that switches the Provider on through `PUT /api/v1/settings`, and a Check
 * whose answer lands on the same screen.
 */

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ...actual,
    getCurrentUser: vi.fn(),
    getSetupState: vi.fn(),
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
    checkProviderCredentials: vi.fn(),
  }
})

const { getCurrentUser, getSetupState, getSettings, saveSettings, checkProviderCredentials } = await import(
  '../lib/api'
)

const USER = { id: 'u1', username: 'admin', email: null, avatarUrl: null, isAdmin: true }

const freshInstall: SetupState = {
  complete: false,
  needsProvider: true,
  providers: [
    { id: 'hetzner', displayName: 'Hetzner Cloud', enabled: false, configured: false, source: 'none', loaded: false },
    { id: 'aws', displayName: 'AWS', enabled: false, configured: false, source: 'none', loaded: false },
    { id: 'azure', displayName: 'Azure', enabled: false, configured: false, source: 'none', loaded: false },
    { id: 'gcp', displayName: 'Google Cloud', enabled: false, configured: false, source: 'none', loaded: false },
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
    { id: 'aws', displayName: 'AWS', enabled: false, configured: false, source: 'none', loaded: false },
  ],
}

const ready: SetupState = {
  complete: true,
  needsProvider: false,
  providers: [
    { id: 'hetzner', displayName: 'Hetzner Cloud', enabled: true, configured: true, source: 'config', loaded: true },
    { id: 'aws', displayName: 'AWS', enabled: false, configured: false, source: 'none', loaded: false },
  ],
}

/**
 * The settings view the wizard draws a cloud's panel from — the same shape `GET /api/v1/settings`
 * returns, with each Provider's DECLARED fields in it (ADR-0027). The labels below are the labels
 * the Provider packages write, which is the point: the wizard invents none of them.
 */
const settingsView: SettingsView = {
  file: { path: '/tmp/config.yaml', exists: true, mtimeMs: 1000 },
  values: { providers: { hetzner: { token: { secret: true, state: 'unset' } }, aws: {} } },
  defaults: {},
  fields: [
    {
      path: 'providers.hetzner.enabled',
      kind: 'boolean',
      writable: true,
      appliesAt: 'save',
      help: 'Whether Rocky Surf may create servers with Hetzner Cloud.',
    },
    {
      path: 'providers.hetzner.token',
      kind: 'secret',
      label: 'Token Environment Variable',
      example: 'HETZNER_TOKEN',
      writable: true,
      appliesAt: 'save',
      help: 'The NAME of an environment variable holding a Hetzner Cloud API token.',
    },
    {
      path: 'providers.hetzner.location',
      kind: 'string',
      label: 'Location',
      example: 'fsn1',
      writable: true,
      appliesAt: 'save',
      help: 'Which Hetzner Cloud location new servers are created in.',
    },
    {
      path: 'providers.aws.enabled',
      kind: 'boolean',
      writable: true,
      appliesAt: 'save',
      help: 'Whether Rocky Surf may create servers with AWS.',
    },
    {
      path: 'providers.aws.region',
      kind: 'string',
      label: 'Region',
      example: 'us-east-1',
      writable: true,
      appliesAt: 'save',
      help: 'Which AWS region new instances are created in.',
    },
    {
      path: 'providers.aws.profile',
      kind: 'string',
      label: 'Profile',
      example: 'default',
      writable: true,
      appliesAt: 'save',
      help: 'A named profile from your shared AWS credentials file.',
    },
    {
      path: 'providers.aws.sshAllowedCidr',
      kind: 'sshCidrList',
      label: 'SSH allowed from',
      example: '203.0.113.7/32',
      writable: true,
      appliesAt: 'save',
      help: 'Which networks may reach SSH on the boxes AWS creates here.',
    },
    {
      path: 'providers.aws.allowAllCidr',
      kind: 'boolean',
      writable: true,
      appliesAt: 'save',
      help: 'Confirms that you mean 0.0.0.0/0 in the list above.',
    },
  ],
  sections: [
    { id: 'providers.hetzner', title: 'Hetzner Cloud', help: 'Servers at Hetzner Cloud.' },
    { id: 'providers.aws', title: 'AWS', help: 'EC2 instances in one region.' },
  ],
  lists: [],
  drifted: false,
  pendingRestart: [],
  restartHint: 'Stop Rocky Surf and start it again.',
  restartHintSegments: [{ text: 'Stop Rocky Surf and start it again.' }],
}

const savedView = { ...settingsView, saved: true as const, applied: [], restartRequired: [] }

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

/** Welcome → Your account → Choose your clouds, the way a first-time user walks it. */
async function reachCloudsStep() {
  renderWizard()
  await screen.findByTestId('next')
  click('next')
  await screen.findByRole('heading', { name: 'Your account' })
  click('next')
  await screen.findByRole('heading', { name: 'Choose your clouds' })
}

/** …and then pick one, which is what makes its panel appear in place. */
async function pickCloud(id: string) {
  await reachCloudsStep()
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(id === 'aws' ? 'AWS' : id, 'i') }))
  await screen.findByTestId('cloud-panel')
}

beforeEach(() => {
  window.localStorage.clear()
  vi.mocked(getCurrentUser).mockResolvedValue(USER)
  vi.mocked(getSetupState).mockResolvedValue(freshInstall)
  vi.mocked(getSettings).mockResolvedValue(settingsView)
  vi.mocked(saveSettings).mockResolvedValue(savedView)
  vi.mocked(checkProviderCredentials).mockResolvedValue({ checked: [] })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('the walkthrough, forwards and backwards', () => {
  it('goes welcome → account → clouds → done', async () => {
    renderWizard()

    expect(await screen.findByRole('heading', { name: 'Welcome' })).toBeTruthy()
    click('next')
    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeTruthy()
    expect(screen.getByText('admin')).toBeTruthy()
    click('next')
    expect(await screen.findByRole('heading', { name: 'Choose your clouds' })).toBeTruthy()
    click('continue')
    expect(await screen.findByRole('heading', { name: 'Not ready yet' })).toBeTruthy()
  })

  it('has a Back button on every step after Welcome, and it goes back', async () => {
    renderWizard()
    await screen.findByTestId('next')
    // Welcome is the first screen: there is nowhere behind it.
    expect(screen.queryByTestId('back')).toBeNull()

    click('next')
    await screen.findByRole('heading', { name: 'Your account' })
    click('back')
    expect(await screen.findByRole('heading', { name: 'Welcome' })).toBeTruthy()

    click('next')
    await screen.findByRole('heading', { name: 'Your account' })
    click('next')
    await screen.findByRole('heading', { name: 'Choose your clouds' })
    click('back')
    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeTruthy()
  })

  it('comes back from Done to the clouds step, so a fix is one click away', async () => {
    vi.mocked(getSetupState).mockResolvedValue(enabledWaiting)
    await reachCloudsStep()
    click('continue')
    await screen.findByRole('heading', { name: 'Not ready yet' })
    click('back')
    expect(await screen.findByRole('heading', { name: 'Choose your clouds' })).toBeTruthy()
  })

  it('sends an unauthenticated visitor to the login page', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new ApiError(401, 'Unauthorized'))
    renderWizard()
    expect(await screen.findByText('LOGIN')).toBeTruthy()
  })
})

describe('choosing a cloud sets it up in place', () => {
  it('lists every cloud core reports, with what each one’s state is', async () => {
    await reachCloudsStep()
    const list = screen.getByTestId('cloud-list')
    for (const name of ['Hetzner Cloud', 'AWS', 'Azure', 'Google Cloud']) {
      expect(list.textContent).toContain(name)
    }
    // Nothing is chosen until the user chooses, so no panel is open.
    expect(screen.queryByTestId('cloud-panel')).toBeNull()
  })

  it('shows the terminal steps for the chosen cloud, with the command to copy', async () => {
    await pickCloud('hetzner')
    const steps = screen.getByTestId('cloud-instructions')
    expect(steps.textContent).toContain('HETZNER_TOKEN')
    expect(steps.textContent).toContain('Read & Write')
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
  })

  it('draws that cloud’s own Settings fields, by the labels the Provider wrote', async () => {
    await pickCloud('aws')
    // The Provider's labels, from the server's inventory — not invented here.
    expect(screen.getByLabelText('Region')).toBeTruthy()
    expect(screen.getByLabelText('Profile')).toBeTruthy()
    // The two-act SSH whitelist gets its own control, exactly as on the Settings page.
    expect(screen.getByRole('group', { name: /SSH allowed from/ })).toBeTruthy()
    // A field of a DIFFERENT cloud is not on this panel.
    expect(screen.queryByLabelText('Location')).toBeNull()
  })

  it('does not draw the enabled checkbox — saving is what turns the cloud on', async () => {
    await pickCloud('aws')
    expect(document.querySelector('[data-field="providers.aws.enabled"]')).toBeNull()
    expect(screen.getByTestId('save-cloud').textContent).toContain('Save and turn on AWS')
  })

  it('saves the fields and the enabled flag in one PUT, then asks the cloud', async () => {
    vi.mocked(checkProviderCredentials).mockResolvedValue({
      checked: [{ provider: 'aws', displayName: 'AWS', status: 'verified', detail: '' }],
    })
    await pickCloud('aws')

    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'eu-west-1' } })
    click('save-cloud')

    await waitFor(() => expect(vi.mocked(saveSettings)).toHaveBeenCalled())
    const [mtime, changes] = vi.mocked(saveSettings).mock.calls[0]!
    expect(mtime).toBe(1000)
    expect(changes).toEqual(
      expect.arrayContaining([
        { path: ['providers', 'aws', 'region'], value: 'eu-west-1' },
        { path: ['providers', 'aws', 'enabled'], value: true },
      ]),
    )
    // A save is not finished until the reader knows whether it worked.
    await waitFor(() => expect(vi.mocked(checkProviderCredentials)).toHaveBeenCalledWith(['aws']))
    expect((await screen.findByTestId('check-result-aws')).textContent).toContain('AWS is ready')
  })

  it('shows a refused save VERBATIM, against the field that carries it', async () => {
    vi.mocked(saveSettings).mockRejectedValue(
      new ApiError(400, 'Bad Request', {
        error: 'providers.aws.region: unknown region',
        issues: [{ path: 'providers.aws.region', message: 'unknown region' }],
      }),
    )
    await pickCloud('aws')
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'nowhere-1' } })
    click('save-cloud')

    expect((await screen.findByTestId('save-error')).textContent).toContain('providers.aws.region: unknown region')
    expect(document.querySelector('[data-field="providers.aws.region"] .settings-field-error')?.textContent).toBe(
      'unknown region',
    )
  })

  it('refuses a pasted token in a credential box before anything is sent', async () => {
    await pickCloud('hetzner')
    fireEvent.change(screen.getByLabelText('Token Environment Variable'), {
      target: { value: 'abc123-a-real-looking-token' },
    })
    click('save-cloud')

    expect((await screen.findByTestId('save-error')).textContent).toContain('must name an environment variable')
    expect(vi.mocked(saveSettings)).not.toHaveBeenCalled()
  })
})

describe('the Check button says what it does and shows what it found', () => {
  it('explains itself next to the button', async () => {
    await pickCloud('aws')
    expect(screen.getByTestId('cloud-panel').textContent).toContain(
      'Check asks AWS whether the credentials this Rocky Surf can see actually work',
    )
  })

  it('prints the cloud’s own refusal, word for word, in place', async () => {
    vi.mocked(checkProviderCredentials).mockResolvedValue({
      checked: [
        {
          provider: 'aws',
          displayName: 'AWS',
          status: 'failed',
          code: 'auth',
          providerCode: 'UnrecognizedClientException',
          detail: 'The security token included in the request is invalid.',
        },
      ],
    })
    await pickCloud('aws')
    click('check-aws')

    const result = await screen.findByTestId('check-result-aws')
    expect(result.getAttribute('data-check-status')).toBe('failed')
    expect(result.textContent).toContain('AWS is not ready yet')
    expect(result.textContent).toContain('The security token included in the request is invalid.')
    expect(result.textContent).toContain('UnrecognizedClientException')
  })

  it('says a cloud is not switched on rather than inventing a refusal for it', async () => {
    // Core reports no row for a Provider that is switched off — the honest reading of that is
    // "nobody to ask yet", not "the cloud said no".
    vi.mocked(checkProviderCredentials).mockResolvedValue({ checked: [] })
    await pickCloud('aws')
    click('check-aws')

    const result = await screen.findByTestId('check-result-aws')
    expect(result.getAttribute('data-check-status')).toBe('not-enabled')
    expect(result.textContent).toContain('AWS is not switched on yet')
  })

  it('says so when the check itself could not run', async () => {
    vi.mocked(checkProviderCredentials).mockRejectedValue(new ApiError(500, 'Server Error', { error: 'core is down' }))
    await pickCloud('aws')
    click('check-aws')

    const result = await screen.findByTestId('check-result-aws')
    expect(result.getAttribute('data-check-status')).toBe('unreachable')
    expect(result.textContent).toContain('core is down')
  })
})

describe('the Done step reports the real state, and never points backwards in prose', () => {
  it('lists each cloud that is on, with its state and core’s reason, and a Check for each', async () => {
    vi.mocked(getSetupState).mockResolvedValue(enabledWaiting)
    vi.mocked(checkProviderCredentials).mockResolvedValue({
      checked: [
        {
          provider: 'hetzner',
          displayName: 'Hetzner Cloud',
          status: 'failed',
          detail: 'no credential found — export HETZNER_TOKEN and restart',
        },
      ],
    })
    await reachCloudsStep()
    click('continue')

    const summary = await screen.findByTestId('cloud-summary')
    expect(summary.textContent).toContain('Hetzner Cloud')
    await waitFor(() => expect(summary.textContent).toContain('not ready'))
    // The composition root's own sentence — it names the variable to export.
    expect(summary.textContent).toContain('export HETZNER_TOKEN')
    expect(screen.getByTestId('check-done-hetzner')).toBeTruthy()
    // A cloud nobody turned on is not on this list.
    expect(summary.textContent).not.toContain('AWS')
  })

  it('asks the cloud on arrival rather than telling the reader to come back later', async () => {
    vi.mocked(getSetupState).mockResolvedValue(enabledWaiting)
    vi.mocked(checkProviderCredentials).mockResolvedValue({
      checked: [
        {
          provider: 'hetzner',
          displayName: 'Hetzner Cloud',
          status: 'failed',
          detail: 'no credential found — export HETZNER_TOKEN and restart',
        },
      ],
    })
    await reachCloudsStep()
    click('continue')

    // No button was pressed: the step verifies for the reader, which is the defect it was
    // reported for ("this page will say ready the next time you open it").
    await waitFor(() => expect(vi.mocked(checkProviderCredentials)).toHaveBeenCalledWith(['hetzner']))
    expect((await screen.findByTestId('check-result-done-hetzner')).textContent).toContain('export HETZNER_TOKEN')
  })

  it('says you are ready only once a cloud has said so itself', async () => {
    vi.mocked(getSetupState).mockResolvedValue(ready)
    vi.mocked(checkProviderCredentials).mockResolvedValue({
      checked: [{ provider: 'hetzner', displayName: 'Hetzner Cloud', status: 'verified', detail: '' }],
    })
    await reachCloudsStep()
    click('continue')
    expect(await screen.findByRole('heading', { name: 'You are ready' })).toBeTruthy()
    expect(document.querySelector('[data-summary-cloud="hetzner"]')?.getAttribute('data-summary-ready')).toBe('true')
  })

  it('does not claim readiness core built but no cloud has confirmed', async () => {
    // `loaded` is "this process constructed the Provider", which for a chain-auth cloud is true
    // before any credential has been proved. The published wizard's headline came from that, so it
    // could say "You are ready" over a cloud that rejects every call.
    vi.mocked(getSetupState).mockResolvedValue(ready)
    vi.mocked(checkProviderCredentials).mockResolvedValue({
      checked: [
        {
          provider: 'hetzner',
          displayName: 'Hetzner Cloud',
          status: 'failed',
          code: 'auth',
          detail: 'token rejected',
        },
      ],
    })
    await reachCloudsStep()
    click('continue')
    expect(await screen.findByRole('heading', { name: 'Not ready yet' })).toBeTruthy()
    expect(screen.getByTestId('cloud-summary').textContent).toContain('token rejected')
  })

  it('offers the way back and the way out, and no instruction to come back later', async () => {
    vi.mocked(getSetupState).mockResolvedValue(enabledWaiting)
    await reachCloudsStep()
    click('continue')
    await screen.findByRole('heading', { name: 'Not ready yet' })
    expect(screen.getByTestId('back')).toBeTruthy()
    click('finish')
    expect(await screen.findByText('DASHBOARD')).toBeTruthy()
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

  it('clears the cloud it was in the middle of — a skip is a skip, not a snooze', async () => {
    window.localStorage.setItem('rockysurf.wizard.pending', 'hetzner')
    vi.mocked(getSetupState).mockResolvedValue(enabledWaiting)
    renderWizard()
    await screen.findByTestId('skip-all')
    click('skip-all')
    await screen.findByText('DASHBOARD')
    expect(window.localStorage.getItem('rockysurf.wizard.pending')).toBeNull()
  })
})

describe('the export-and-restart return leg', () => {
  it('reopens on the cloud that was being set up, not back at Welcome', async () => {
    window.localStorage.setItem('rockysurf.wizard.pending', 'hetzner')
    vi.mocked(getSetupState).mockResolvedValue(enabledWaiting)

    renderWizard()

    expect(await screen.findByRole('heading', { name: 'Choose your clouds' })).toBeTruthy()
    const panel = await screen.findByTestId('cloud-panel')
    expect(panel.getAttribute('data-cloud-panel')).toBe('hetzner')
  })

  it('falls back to the list when the remembered cloud is no longer configured', async () => {
    window.localStorage.setItem('rockysurf.wizard.pending', 'nowhere')
    renderWizard()
    await screen.findByRole('heading', { name: 'Choose your clouds' })
    await waitFor(() => expect(screen.queryByTestId('cloud-panel')).toBeNull())
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

describe('acceptance criteria a reviewer can grep for (issue #474)', () => {
  // Resolved from the package root, not `import.meta.url`: under jsdom that is an http URL, not a
  // file one, and `fileURLToPath` rejects it.
  const source = readFileSync(join(process.cwd(), 'src/pages/WizardPage.tsx'), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  /** Everything above the copy helper — the part the zero-conditionals rule still governs. */
  const logic = code.split('function cloudGuide')[0]!

  it('names no configuration file and no repository path anywhere', () => {
    // The two defects that made the published wizard useless on an npm install: it pointed at a
    // file the user does not have and at docs that are not installed.
    expect(code).not.toContain('rockysurf.config.yaml')
    expect(code).not.toMatch(/docs\/[a-z]/)
    expect(code).not.toMatch(/\.md\b/)
  })

  it('never branches on a provider id in the wizard logic', () => {
    expect(logic).not.toMatch(/provider\.id\s*===\s*['"]/)
    expect(logic).not.toMatch(/providerId\s*===\s*['"]/)
    expect(logic).not.toMatch(/selected\s*===\s*['"]/)
  })

  it('keeps every provider literal inside the copy helper', () => {
    for (const literal of ['aws', 'azure', 'gcp', 'hetzner', 'digitalocean']) {
      expect(logic).not.toMatch(new RegExp(`['"\`]${literal}['"\`]`))
    }
  })

  it('draws the fields with the SETTINGS page’s own controls rather than its own', () => {
    // The whole point of the rebuild: one implementation of a settings control, used twice.
    expect(source).toContain("from '../components/settingsFields'")
    expect(source).toContain('genericField')
    expect(source).toContain('asReferences')
  })

  it('saves through the settings route and proves the result at the cloud', () => {
    expect(source).toContain('saveSettings')
    expect(source).toContain('checkProviderCredentials')
  })

  it('records the sanctioned-literal ruling, so the exception is not folklore', () => {
    expect(source).toContain('SANCTIONED')
    expect(source).toContain('rockysurf-hzi7.2')
  })
})
