import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRegistryView, RegistryProvider } from '../lib/api'
import { ProviderShop } from './ProviderShop'

/**
 * The Providers tab of the Shop (ADR-0028, issue #374).
 *
 * What is worth a component test here is what an operator reads BEFORE consenting to run
 * somebody else's code inside their control plane: the capability answers, the settings the
 * provider will ask for, and the trust sentence — rendered verbatim, exactly as core sent it,
 * with no chance for this component to soften or omit it.
 *
 * The other half is the two refusals that keep the tab honest: nothing is fetched until the tab
 * is opened, and a removal asks first.
 */

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  Toaster: () => null,
}))
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ...actual,
    getProviderRegistry: vi.fn(),
    installRegistryProvider: vi.fn(),
    removePersonalProvider: vi.fn(),
  }
})

const api = await import('../lib/api')

const TRUST = "a provider runs with Rocky Surf's full access — install ones you trust."

const NIMBUS: RegistryProvider = {
  providerId: 'nimbus',
  name: 'Nimbus Cloud',
  description: 'A fixture cloud with droplets that keep billing while stopped.',
  version: '1.2.0',
  package: '@fixture/rockysurf-provider-nimbus',
  tarball: 'https://example.test/nimbus-1.2.0.tgz',
  sha256: 'a'.repeat(64),
  settings: [
    { name: 'token', label: 'API token variable', kind: 'secret' },
    { name: 'region', label: 'Region', kind: 'string' },
  ],
  capabilities: {
    stop: true,
    ipStableAcrossStop: false,
    canInjectHostKeys: false,
    generatesUserData: false,
    userDataMaxBytes: 0,
    managesSshAccess: true,
    billsWhileStopped: true,
  },
  sourceName: 'Rocky Surf Pack Shop',
  trust: 'community',
  installed: false,
  installedVersion: null,
}

const view = (providers: RegistryProvider[] = [NIMBUS]): ProviderRegistryView => ({
  enabled: true,
  sources: [{ name: 'Rocky Surf Pack Shop', url: 'https://example.test/shop', trust: 'community' }],
  trustSentence: TRUST,
  shelves: [
    {
      source: { name: 'Rocky Surf Pack Shop', url: 'https://example.test/shop', trust: 'community' },
      providers,
      fetchedAt: '2026-09-04T00:00:00.000Z',
      failure: null,
    },
  ],
})

beforeEach(() => {
  vi.mocked(api.getProviderRegistry).mockResolvedValue(view())
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('the provider listing', () => {
  it('fetches nothing until the tab is the active one', async () => {
    render(<ProviderShop active={false} isAdmin />)
    await waitFor(() => expect(api.getProviderRegistry).not.toHaveBeenCalled())

    render(<ProviderShop active isAdmin />)
    await waitFor(() => expect(api.getProviderRegistry).toHaveBeenCalledTimes(1))
  })

  it('shows the name, the package, the description and the version on the button', async () => {
    render(<ProviderShop active isAdmin />)
    const card = await screen.findByTestId('provider-nimbus')
    expect(within(card).getByRole('heading', { name: 'Nimbus Cloud' })).toBeTruthy()
    expect(within(card).getByText('@fixture/rockysurf-provider-nimbus')).toBeTruthy()
    expect(within(card).getByText(/keep billing while stopped/)).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Install 1.2.0' })).toBeTruthy()
  })

  it('answers the capability questions before anybody installs', async () => {
    render(<ProviderShop active isAdmin />)
    const answers = await screen.findByTestId('provider-capabilities-nimbus')
    expect(answers.textContent).toContain('Still billed at the running rate')
    expect(answers.textContent).toContain('Changes')
    expect(answers.textContent).toContain('Pushed to the cloud on save')
    expect(answers.textContent).toContain('Recorded on first connection')
  })

  it('names the settings it will ask for, including which one is a credential', async () => {
    render(<ProviderShop active isAdmin />)
    const settings = await screen.findByTestId('provider-settings-nimbus')
    expect(settings.textContent).toContain('API token variable (a credential)')
    expect(settings.textContent).toContain('Region')
  })

  it('renders the trust sentence verbatim, on the entry, exactly as core sent it', async () => {
    render(<ProviderShop active isAdmin />)
    expect((await screen.findByTestId('provider-trust-nimbus')).textContent).toBe(TRUST)
    expect(screen.getByTestId('providers-trust-sentence').textContent).toBe(TRUST)
  })

  it('renders a shelf that could not be read as its own reason, not as an empty tab', async () => {
    vi.mocked(api.getProviderRegistry).mockResolvedValue({
      ...view([]),
      shelves: [
        {
          source: { name: 'Rocky Surf Pack Shop', url: 'https://example.test/shop', trust: 'community' },
          providers: [],
          fetchedAt: null,
          failure: { kind: 'unreachable', reason: 'Could not fetch https://example.test/shop/providers.json' },
        },
      ],
    })
    render(<ProviderShop active isAdmin />)
    expect((await screen.findByTestId('provider-shelf-failure-Rocky Surf Pack Shop')).textContent).toContain(
      'Could not fetch',
    )
  })

  it('says so when the registry is switched off', async () => {
    vi.mocked(api.getProviderRegistry).mockResolvedValue({ ...view([]), enabled: false })
    render(<ProviderShop active isAdmin />)
    expect(await screen.findByTestId('providers-registry-disabled')).toBeTruthy()
  })

  it('tells a member who installs providers, and asks the control plane nothing', async () => {
    render(<ProviderShop active isAdmin={false} />)
    expect(screen.getByText(/installed by an administrator/)).toBeTruthy()
    expect(api.getProviderRegistry).not.toHaveBeenCalled()
  })
})

describe('installing and removing', () => {
  it('installs by address and then says what has to happen next', async () => {
    vi.mocked(api.installRegistryProvider).mockResolvedValue({
      providerId: 'nimbus',
      package: '@fixture/rockysurf-provider-nimbus',
      version: '1.2.0',
      trustSentence: TRUST,
      restartRequired: true,
      restartReason: 'A provider package is loaded when Rocky Surf starts. Restart it to load nimbus.',
    })
    render(<ProviderShop active isAdmin />)

    await userEvent.click(await screen.findByRole('button', { name: 'Install 1.2.0' }))

    expect(api.installRegistryProvider).toHaveBeenCalledWith('Rocky Surf Pack Shop', 'nimbus')
    expect((await screen.findByTestId('providers-restart-notice')).textContent).toContain('Restart it to load nimbus')
  })

  it('offers an update when the version on disk is behind the one listed', async () => {
    vi.mocked(api.getProviderRegistry).mockResolvedValue(
      view([{ ...NIMBUS, installed: true, installedVersion: '1.0.0' }]),
    )
    render(<ProviderShop active isAdmin />)
    expect(await screen.findByRole('button', { name: 'Update to 1.2.0' })).toBeTruthy()
    expect((await screen.findByTestId('provider-installed-nimbus')).textContent).toContain('version 1.0.0')
  })

  it('offers a reinstall when the installed version is the listed one', async () => {
    vi.mocked(api.getProviderRegistry).mockResolvedValue(
      view([{ ...NIMBUS, installed: true, installedVersion: '1.2.0' }]),
    )
    render(<ProviderShop active isAdmin />)
    expect(await screen.findByRole('button', { name: 'Reinstall' })).toBeTruthy()
  })

  it('has no Remove button until the provider is installed here', async () => {
    render(<ProviderShop active isAdmin />)
    await screen.findByTestId('provider-nimbus')
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it('asks before removing, and names both the package and the config section', async () => {
    vi.mocked(api.getProviderRegistry).mockResolvedValue(
      view([{ ...NIMBUS, installed: true, installedVersion: '1.2.0' }]),
    )
    const confirmed = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<ProviderShop active isAdmin />)

    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }))

    expect(confirmed).toHaveBeenCalledOnce()
    expect(confirmed.mock.calls[0]![0]).toContain('@fixture/rockysurf-provider-nimbus')
    expect(confirmed.mock.calls[0]![0]).toContain('providers.nimbus')
    expect(api.removePersonalProvider).not.toHaveBeenCalled()
  })

  it('removes once the question is answered, and says the process still has it loaded', async () => {
    vi.mocked(api.getProviderRegistry).mockResolvedValue(
      view([{ ...NIMBUS, installed: true, installedVersion: '1.2.0' }]),
    )
    vi.mocked(api.removePersonalProvider).mockResolvedValue({
      providerId: 'nimbus',
      removed: '@fixture/rockysurf-provider-nimbus',
      restartRequired: true,
      restartReason: 'nimbus is still loaded in this running process. Restart Rocky Surf to unload it.',
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ProviderShop active isAdmin />)

    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }))

    expect(api.removePersonalProvider).toHaveBeenCalledWith('nimbus')
    expect((await screen.findByTestId('providers-restart-notice')).textContent).toContain('Restart Rocky Surf')
  })
})
