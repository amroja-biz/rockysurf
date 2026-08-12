import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../lib/api'
import { CreateServerPage } from './CreateServerPage'

vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }))
// The feed's subscription is exercised in the events tests; here it only has to exist, and
// mocking it keeps these cases free of an auth provider and a live EventSource.
vi.mock('../contexts/EventsContext', () => ({
  useEvents: () => ({ subscribe: () => () => {}, status: 'open' }),
}))
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }))

const price = (amount: number) => ({ amount, currency: 'USD', fetchedAt: '2026-08-11T00:00:00Z' })

const FAKE_PROVIDER: api.ProviderInfo = {
  id: 'fake',
  displayName: 'Fake Cloud',
  capabilities: {
    stop: true,
    ipStableAcrossStop: true,
    canInjectHostKeys: true,
    userDataMaxBytes: 32768,
    generatesUserData: true,
  },
  offerings: [
    { id: 'small-arm', cpu: 2, memoryGb: 2, diskGb: 40, arch: 'arm64', hourly: price(0.0168), available: true, region: 'fake-1' },
    { id: 'small-x86', cpu: 2, memoryGb: 2, diskGb: 40, arch: 'amd64', hourly: price(0.0208), available: true, region: 'fake-1' },
    { id: 'big-arm', cpu: 4, memoryGb: 8, diskGb: 80, arch: 'arm64', hourly: price(0.0672), available: true, region: 'fake-1' },
  ],
}

const packWith = (over: Partial<api.SurgePack>): api.SurgePack => ({
  packId: 'ai-agents',
  name: 'AI Agents',
  displayOrder: 1,
  enabled: true,
  tools: [{ toolId: 'claude-code', name: 'Claude Code', description: '', category: 'agent', url: '' }],
  requiresRepos: false,
  requiresRdp: false,
  ...over,
})

function renderPage() {
  return render(<CreateServerPage />)
}

beforeEach(() => {
  vi.spyOn(api, 'listProviders').mockResolvedValue([FAKE_PROVIDER])
  vi.spyOn(api, 'listSurgePacks').mockResolvedValue([packWith({})])
  vi.spyOn(api, 'createServer').mockResolvedValue({ serverId: 'srv-abc', name: 'dev-box', status: 'provisioning' })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolving a size to a concrete offering before submit', () => {
  it('shows the resolved machine, its price, and the date of that price', async () => {
    renderPage()

    // The cheapest offering meeting "small" — shown BEFORE anything is submitted.
    expect(await screen.findByRole('heading', { name: /small-arm/ })).toBeTruthy()
    expect(screen.getByText(/\$0\.0168\/hr/)).toBeTruthy()
    // Prices ship bundled, so they carry the date they were read.
    expect(screen.getByText(/prices as of/i)).toBeTruthy()
  })

  it('labels the architecture, with arm64 first-class', async () => {
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })
    expect(screen.getAllByText('ARM64').length).toBeGreaterThan(0)
  })

  it('re-resolves when the size changes', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })

    await user.click(screen.getByRole('radio', { name: /large/i }))
    expect(await screen.findByRole('heading', { name: /big-arm/ })).toBeTruthy()
  })

  it('re-resolves when the architecture changes', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })

    await user.click(screen.getByRole('radio', { name: /x86-64/i }))
    expect(await screen.findByRole('heading', { name: /small-x86/ })).toBeTruthy()
  })

  it('submits the offering the user was shown, not whatever core would pick', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })

    await user.click(screen.getByRole('button', { name: /create server/i }))

    await waitFor(() => expect(api.createServer).toHaveBeenCalled())
    expect(vi.mocked(api.createServer).mock.calls[0]?.[0]).toMatchObject({
      offeringId: 'small-arm',
      arch: 'arm64',
      provider: 'fake',
      size: 'small',
    })
  })

  it('says "sold out" rather than "unavailable" when stock is the problem', async () => {
    vi.mocked(api.listProviders).mockResolvedValue([
      { ...FAKE_PROVIDER, offerings: FAKE_PROVIDER.offerings.map((o) => ({ ...o, available: false })) },
    ])
    renderPage()

    expect(await screen.findByText(/sold out/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /create server/i })).toHaveProperty('disabled', true)
  })

  it('surfaces a catalogue read failure without breaking the page', async () => {
    vi.mocked(api.listProviders).mockResolvedValue([
      { ...FAKE_PROVIDER, offerings: [], offeringsError: 'rate limited' },
    ])
    renderPage()
    expect(await screen.findByText(/rate limited/)).toBeTruthy()
  })
})

describe('pack metadata drives the conditional fields', () => {
  it('hides repositories and RDP when the pack asks for neither', async () => {
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })

    expect(screen.queryByLabelText(/repositories/i)).toBeNull()
    expect(screen.queryByLabelText(/remote desktop password/i)).toBeNull()
  })

  it('shows the repository field only when the pack declares requiresRepos', async () => {
    vi.mocked(api.listSurgePacks).mockResolvedValue([packWith({ requiresRepos: true })])
    renderPage()
    expect(await screen.findByLabelText(/repositories/i)).toBeTruthy()
  })

  it('shows the RDP fields only when the pack declares requiresRdp', async () => {
    vi.mocked(api.listSurgePacks).mockResolvedValue([packWith({ requiresRdp: true })])
    renderPage()
    expect(await screen.findByLabelText(/^remote desktop password$/i)).toBeTruthy()
  })

  it('refuses to submit a repos-requiring pack with no repositories', async () => {
    const user = userEvent.setup()
    vi.mocked(api.listSurgePacks).mockResolvedValue([packWith({ requiresRepos: true })])
    renderPage()
    await screen.findByLabelText(/repositories/i)

    await user.click(screen.getByRole('button', { name: /create server/i }))
    expect(await screen.findByText(/at least one repository/i)).toBeTruthy()
    expect(api.createServer).not.toHaveBeenCalled()
  })

  it('sends repositories as a parsed list', async () => {
    const user = userEvent.setup()
    vi.mocked(api.listSurgePacks).mockResolvedValue([packWith({ requiresRepos: true })])
    renderPage()

    const field = await screen.findByLabelText(/repositories/i)
    await user.type(field, 'https://github.com/a/b.git\nhttps://github.com/c/d.git')
    await user.click(screen.getByRole('button', { name: /create server/i }))

    await waitFor(() => expect(api.createServer).toHaveBeenCalled())
    expect(vi.mocked(api.createServer).mock.calls[0]?.[0].repositories).toEqual([
      'https://github.com/a/b.git',
      'https://github.com/c/d.git',
    ])
  })

  it('refuses a short or mismatched RDP password', async () => {
    const user = userEvent.setup()
    vi.mocked(api.listSurgePacks).mockResolvedValue([packWith({ requiresRdp: true })])
    renderPage()

    const password = await screen.findByLabelText(/^remote desktop password$/i)
    await user.type(password, 'short')
    await user.click(screen.getByRole('button', { name: /create server/i }))
    expect(await screen.findByText(/^Remote desktop password must be at least 8 characters$/)).toBeTruthy()

    await user.clear(password)
    await user.type(password, 'long-enough-password')
    await user.type(screen.getByLabelText(/confirm password/i), 'different-password')
    await user.click(screen.getByRole('button', { name: /create server/i }))
    expect(await screen.findByText(/do not match/i)).toBeTruthy()
  })
})

describe('capability flags drive provider-specific controls', () => {
  it('warns about trust-on-first-use when the provider cannot inject host keys', async () => {
    vi.mocked(api.listProviders).mockResolvedValue([
      { ...FAKE_PROVIDER, capabilities: { ...FAKE_PROVIDER.capabilities, canInjectHostKeys: false } },
    ])
    renderPage()
    expect(await screen.findByText(/trusted on sight/i)).toBeTruthy()
  })

  it('says nothing about host keys when the provider can inject them', async () => {
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })
    expect(screen.queryByText(/trusted on sight/i)).toBeNull()
  })

  it('warns when the provider cannot stop servers', async () => {
    vi.mocked(api.listProviders).mockResolvedValue([
      { ...FAKE_PROVIDER, capabilities: { ...FAKE_PROVIDER.capabilities, stop: false } },
    ])
    renderPage()
    expect(await screen.findByText(/cannot be stopped/i)).toBeTruthy()
  })

  it('hides the provider picker when there is only one', async () => {
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })
    expect(screen.queryByRole('radio', { name: 'Fake Cloud' })).toBeNull()
  })
})

describe('the live provisioning feed replaces the form after create', () => {
  it('shows the step list once the server exists', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('heading', { name: /small-arm/ })

    await user.click(screen.getByRole('button', { name: /create server/i }))

    expect(await screen.findByText(/launching the machine/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /create server/i })).toBeNull()
  })
})

describe('acceptance criteria a reviewer can grep for', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  const sources = [
    read('./CreateServerPage.tsx'),
    read('../components/ProvisioningFeed.tsx'),
    read('../lib/requirements.ts'),
  ].join('\n')
  // Comments explain at length WHY there are no provider-id conditionals; prose is not code.
  const code = sources.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('contains no provider-id conditionals', () => {
    for (const literal of ['aws', 'hetzner', 'byo']) {
      expect(code).not.toMatch(new RegExp(`['"\`]${literal}['"\`]`))
    }
    expect(code).not.toMatch(/provider\.id\s*===/)
    expect(code).not.toMatch(/providerId\s*===\s*['"]/)
  })

  it('contains no pack-id hardcodes, which is what it replaced', () => {
    expect(code).not.toContain('open-claw')
    expect(code).not.toMatch(/packId\s*===\s*['"]/)
  })

  it('carries neither the spot radio nor the billing gate', () => {
    expect(code).not.toMatch(/spotInstance|canCreateServer|billingGate/)
  })

  it('drives provider-specific UI from capabilities only', () => {
    expect(code).toMatch(/capabilities\.canInjectHostKeys/)
    expect(code).toMatch(/capabilities\.stop/)
  })
})
