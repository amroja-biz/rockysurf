import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminSurgePack, AdminTool, PackRegistry, RegistryPackDetail, SurgePack } from '../lib/api'
import { PacksPage } from './PacksPage'

/**
 * The consolidated Surge Packs page (rockysurf-4d8h, issue #51).
 *
 * Ports every still-meaningful assertion from the two pages this replaced —
 * `AdminSurgePacksPage.test.tsx` and `AdminPackShopPage.test.tsx` — onto the new vocabulary: a
 * card's badge reads core's own `provenance` (`official` / `registry` / `local`), never the
 * admin table's `file:`/`database` split or the old shop's `community`/`internal` trust label.
 * The admin-only origin sentence still names the real source underneath the badge.
 */

vi.mock('../contexts/EventsContext', () => ({
  useEvents: () => ({ subscribe: () => () => {}, connectionStatus: 'connected' }),
}))
const auth = vi.hoisted(() => ({ isAdmin: true }))
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'admin', isAdmin: auth.isAdmin }, logout: vi.fn() }),
}))
vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  Toaster: () => null,
}))
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ...actual,
    listSurgePacks: vi.fn(),
    listAdminSurgePacks: vi.fn(),
    listAdminTools: vi.fn(),
    getPackRegistry: vi.fn(),
    getRegistryPack: vi.fn(),
    installRegistryPack: vi.fn(),
    importSurgePack: vi.fn(),
    exportSurgePackYaml: vi.fn(),
    createAdminSurgePack: vi.fn(),
    updateAdminSurgePack: vi.fn(),
    deleteAdminSurgePack: vi.fn(),
  }
})

const api = await import('../lib/api')

const CLAUDE_TOOL = { toolId: 'claude-code', name: 'Claude Code', description: 'the agent', category: 'agent' as const, url: 'https://example.com/claude' }
const RUSTUP_TOOL = { toolId: 'rustup', name: 'rustup', description: 'the Rust toolchain installer', category: 'base' as const, url: 'https://rustup.rs' }

const officialPublic = (over: Partial<SurgePack> = {}): SurgePack => ({
  packId: 'ai-coding-agents',
  name: 'Claude Code',
  displayOrder: 10,
  enabled: true,
  tools: [CLAUDE_TOOL],
  requiresRepos: false,
  requiresRdp: false,
  provenance: 'official',
  ...over,
})

const registryPublic = (over: Partial<SurgePack> = {}): SurgePack => ({
  packId: 'rust-dev',
  name: 'Rust Dev',
  displayOrder: 20,
  enabled: true,
  tools: [RUSTUP_TOOL],
  requiresRepos: false,
  requiresRdp: false,
  provenance: 'registry',
  ...over,
})

const localPublic = (over: Partial<SurgePack> = {}): SurgePack => ({
  packId: 'mine',
  name: 'Mine',
  displayOrder: 30,
  enabled: true,
  tools: [],
  requiresRepos: false,
  requiresRdp: true,
  provenance: 'local',
  ...over,
})

const officialAdmin = (over: Partial<AdminSurgePack> = {}): AdminSurgePack => ({
  packId: 'ai-coding-agents',
  name: 'Claude Code',
  tools: ['claude-code'],
  displayOrder: 10,
  enabled: true,
  requiresRepos: false,
  requiresRdp: false,
  sourceFile: 'ai-coding-agents.yaml',
  registry: null,
  ...over,
})

const registryAdmin = (over: Partial<AdminSurgePack> = {}): AdminSurgePack => ({
  packId: 'rust-dev',
  name: 'Rust Dev',
  tools: ['rustup'],
  displayOrder: 20,
  enabled: true,
  requiresRepos: false,
  requiresRdp: false,
  sourceFile: null,
  registry: { source: 'Rocky Surf Pack Shop', url: 'https://example.com/shop', sha256: 'a'.repeat(64), trust: 'community', installedAt: null },
  ...over,
})

const localAdmin = (over: Partial<AdminSurgePack> = {}): AdminSurgePack => ({
  packId: 'mine',
  name: 'Mine',
  tools: [],
  displayOrder: 30,
  enabled: true,
  requiresRepos: false,
  requiresRdp: true,
  sourceFile: null,
  registry: null,
  ...over,
})

const TOOL: AdminTool = {
  toolId: 'claude-code',
  name: 'Claude Code',
  description: 'the agent',
  category: 'agent',
  url: 'https://example.com/claude',
  installScript: 'true',
  enabled: true,
  installOrder: 40,
  bootstrap: false,
  runAs: 'rocky',
}

const emptyRegistry = (over: Partial<PackRegistry> = {}): PackRegistry => ({
  enabled: true,
  sources: [],
  shelves: [],
  ...over,
})

const registryPackEntry = (over: Record<string, unknown> = {}) => ({
  packId: 'aider',
  name: 'Aider',
  description: 'Installs 1 tool(s): aider',
  path: 'packs/aider.yaml',
  sha256: 'b'.repeat(64),
  definesTools: ['aider'],
  referencesTools: [],
  requiresRepos: false,
  requiresRdp: false,
  sourceName: 'Rocky Surf Pack Shop',
  trust: 'community' as const,
  installed: false,
  ...over,
})

const DISCLOSURE_DETAIL: RegistryPackDetail = {
  entry: registryPackEntry(),
  yaml: 'version: 1\npack:\n  packId: aider\n',
  disclosure: {
    packId: 'aider',
    name: 'Aider',
    tools: [
      {
        toolId: 'aider',
        name: 'Aider',
        description: 'The Aider CLI',
        url: 'https://aider.chat',
        runAs: 'rocky',
        installOrder: 40,
        installScript: 'pipx install aider-chat\n',
        fetchesUrls: ['https://pypi.org'],
      },
    ],
    referencesTools: [],
    rootStepCount: 0,
    fetchesUrls: ['https://pypi.org'],
    requiresRepos: false,
    requiresRdp: false,
    summaryIsComplete: false,
  },
}

beforeEach(() => {
  auth.isAdmin = true
  vi.mocked(api.listSurgePacks).mockResolvedValue([officialPublic(), registryPublic(), localPublic()])
  vi.mocked(api.listAdminSurgePacks).mockResolvedValue([officialAdmin(), registryAdmin(), localAdmin()])
  vi.mocked(api.listAdminTools).mockResolvedValue([TOOL])
  vi.mocked(api.getPackRegistry).mockResolvedValue(emptyRegistry())
  vi.mocked(api.getRegistryPack).mockResolvedValue(DISCLOSURE_DETAIL)
  vi.mocked(api.installRegistryPack).mockResolvedValue(registryAdmin({ packId: 'aider', name: 'Aider' }))
})

afterEach(() => {
  vi.clearAllMocks()
})

function renderList() {
  return render(
    <MemoryRouter initialEntries={['/packs']}>
      <Routes>
        <Route path="/packs" element={<PacksPage />} />
        <Route path="/packs/:packId" element={<PacksPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

function renderDetail(packId: string) {
  return render(
    <MemoryRouter initialEntries={[`/packs/${packId}`]}>
      <Routes>
        <Route path="/packs" element={<PacksPage />} />
        <Route path="/packs/:packId" element={<PacksPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('provenance labelling', () => {
  it('reads a file-backed pack official, because that is what shipped with the release', async () => {
    renderList()
    const card = await screen.findByTestId('pack-card-ai-coding-agents')
    expect(card.querySelector('[data-testid="trust-official"]')).toBeTruthy()
    expect(card.textContent).toContain('shipped with this release')
  })

  it('labels a registry-installed pack "registry", never "official", and names the real source', async () => {
    renderList()
    const card = await screen.findByTestId('pack-card-rust-dev')
    expect(card.querySelector('[data-testid="trust-registry"]')).toBeTruthy()
    expect(card.querySelector('[data-testid="trust-official"]')).toBeNull()
    expect(card.textContent).toContain('installed from Rocky Surf Pack Shop')
  })

  it('reads an admin-created pack "local" rather than guessing at a source', async () => {
    renderList()
    const card = await screen.findByTestId('pack-card-mine')
    expect(card.querySelector('[data-testid="trust-local"]')).toBeTruthy()
    expect(card.textContent).toContain('created here, in this installation')
  })
})

describe('shelves', () => {
  it("shows a failing registry's reason rather than an empty shop", async () => {
    vi.mocked(api.getPackRegistry).mockResolvedValue(
      emptyRegistry({
        sources: [{ name: 'Rocky Surf Pack Shop', url: 'https://example.com/shop', trust: 'community' }],
        shelves: [
          {
            source: { name: 'Rocky Surf Pack Shop', url: 'https://example.com/shop', trust: 'community' },
            packs: [],
            fetchedAt: null,
            failure: { kind: 'unreachable', reason: 'Could not fetch https://example.com/shop/index.json' },
          },
        ],
      }),
    )
    renderList()
    expect((await screen.findByTestId('shelf-failure-Rocky Surf Pack Shop')).textContent).toContain('Could not fetch')
  })

  it('says so when the registry is switched off, which is not a failure', async () => {
    vi.mocked(api.getPackRegistry).mockResolvedValue(emptyRegistry({ enabled: false }))
    renderList()
    expect(await screen.findByTestId('registry-disabled')).toBeTruthy()
  })

  it('marks a pack already in the catalogue', async () => {
    vi.mocked(api.getPackRegistry).mockResolvedValue(
      emptyRegistry({
        sources: [{ name: 'Rocky Surf Pack Shop', url: 'https://example.com/shop', trust: 'community' }],
        shelves: [
          {
            source: { name: 'Rocky Surf Pack Shop', url: 'https://example.com/shop', trust: 'community' },
            packs: [registryPackEntry({ installed: true })],
            fetchedAt: null,
            failure: null,
          },
        ],
      }),
    )
    renderList()
    expect((await screen.findByTestId('registry-aider')).textContent).toContain('already installed')
  })
})

describe('installing goes through the disclosure', () => {
  const withShelf = () =>
    vi.mocked(api.getPackRegistry).mockResolvedValue(
      emptyRegistry({
        sources: [{ name: 'Rocky Surf Pack Shop', url: 'https://example.com/shop', trust: 'community' }],
        shelves: [
          {
            source: { name: 'Rocky Surf Pack Shop', url: 'https://example.com/shop', trust: 'community' },
            packs: [registryPackEntry()],
            fetchedAt: null,
            failure: null,
          },
        ],
      }),
    )

  it('has no install control until the pack has been reviewed', async () => {
    withShelf()
    renderList()
    await screen.findByTestId('shelf-Rocky Surf Pack Shop')
    expect(screen.queryByRole('button', { name: /^Install/ })).toBeNull()
    expect(api.installRegistryPack).not.toHaveBeenCalled()
  })

  it('reviewing shows the scripts, then installing sends only the address', async () => {
    withShelf()
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    expect(screen.getByTestId('disclosure-tool-aider').textContent).toContain('pipx install aider-chat')

    fireEvent.click(screen.getByRole('button', { name: /^Install/ }))
    await waitFor(() => expect(api.installRegistryPack).toHaveBeenCalledWith('Rocky Surf Pack Shop', 'aider'))
    const [args] = vi.mocked(api.installRegistryPack).mock.calls
    expect(args).toHaveLength(2)
  })

  it('reloads the catalogue after installing, so the new pack appears without a refresh', async () => {
    withShelf()
    renderList()
    await screen.findByTestId('shelf-Rocky Surf Pack Shop')

    vi.mocked(api.listAdminSurgePacks).mockResolvedValue([
      officialAdmin(),
      registryAdmin(),
      localAdmin(),
      registryAdmin({ packId: 'aider', name: 'Aider', registry: { source: 'Rocky Surf Pack Shop', url: 'u', sha256: 's', trust: 'community', installedAt: null } }),
    ])
    vi.mocked(api.listSurgePacks).mockResolvedValue([
      officialPublic(),
      registryPublic(),
      localPublic(),
      registryPublic({ packId: 'aider', name: 'Aider', tools: [] }),
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Install/ }))

    await waitFor(() => expect(screen.getByTestId('pack-card-aider')).toBeTruthy())
  })
})

describe('ported from the admin surge-packs page', () => {
  it('shows a file-backed pack read-only in its detail view, naming the file to edit', async () => {
    renderDetail('ai-coding-agents')
    expect(await screen.findByTestId('file-backed-ai-coding-agents')).toBeTruthy()
    const hint = screen.getByTestId('readonly-hint-ai-coding-agents')
    expect(hint.textContent).toContain('ai-coding-agents.yaml')
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('leaves a database-created pack editable', async () => {
    renderDetail('mine')
    await screen.findByRole('button', { name: 'Edit' })
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy()
    expect(screen.queryByTestId('file-backed-mine')).toBeNull()
  })

  it('offers export for both file-backed and database packs', async () => {
    renderDetail('ai-coding-agents')
    expect(await screen.findByRole('button', { name: 'Export' })).toBeTruthy()

    renderDetail('mine')
    expect((await screen.findAllByRole('button', { name: 'Export' })).length).toBeGreaterThan(0)
  })

  it('imports YAML from a file and says the result is a database row', async () => {
    vi.mocked(api.importSurgePack).mockResolvedValue(localAdmin({ packId: 'imported' }))
    renderList()
    await screen.findByTestId('import-file')

    const input = screen.getByTestId('import-file') as HTMLInputElement
    const file = new File(['version: 1\n'], 'pack.yaml', { type: 'application/yaml' })
    Object.defineProperty(input, 'files', { value: [file] })
    input.dispatchEvent(new Event('change', { bubbles: true }))

    await waitFor(() => expect(api.importSurgePack).toHaveBeenCalledWith({ yaml: 'version: 1\n' }))
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain('packs/'))
  })

  it('offers the URL import path too', async () => {
    renderList()
    expect(await screen.findByTestId('import-url')).toBeTruthy()
  })

  it('renders the behaviour fields per pack, and offers a control for each when creating', async () => {
    renderDetail('mine')
    expect(await screen.findByText('remote desktop')).toBeTruthy()

    renderList()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'New Surge Pack' }))
    const form = await screen.findByTestId('pack-form')
    expect(form.textContent).toContain('Requires repositories')
    expect(form.textContent).toContain('Requires a remote-desktop password')
    expect(form.textContent).toContain('Desktop')
  })

  it('shows an error rather than an empty page when the load fails', async () => {
    vi.mocked(api.listSurgePacks).mockRejectedValue(new Error('nope'))
    renderList()
    expect((await screen.findByRole('alert')).textContent).toContain('nope')
  })
})

describe("the issue's own acceptance", () => {
  it('renders an <img> for a pack with imageUrl, and a monogram for one without', async () => {
    vi.mocked(api.listSurgePacks).mockResolvedValue([
      officialPublic({ imageUrl: '/images/surge-packs/ai-coding-agents.png' }),
      localPublic(),
    ])
    const { container } = renderList()
    await screen.findByTestId('pack-card-ai-coding-agents')

    expect(container.querySelector('[data-testid="pack-card-ai-coding-agents"] img')).toBeTruthy()
    expect(screen.getByTestId('pack-monogram-mine')).toBeTruthy()
  })

  it("clicking a pack's card shows its tools, with names, descriptions and links", async () => {
    const user = userEvent.setup()
    renderList()
    await user.click(await screen.findByTestId('pack-card-rust-dev'))

    const tools = await screen.findByTestId('pack-tools')
    expect(tools.textContent).toContain('rustup')
    expect(tools.textContent).toContain('the Rust toolchain installer')
    expect(within(tools).getByRole('link', { name: 'rustup' }).getAttribute('href')).toBe('https://rustup.rs')
  })

  it('points the Launch button at /servers/new?pack=<packId>', async () => {
    renderDetail('rust-dev')
    const link = await screen.findByRole('link', { name: /launch a server with this pack/i })
    expect(link.getAttribute('href')).toBe('/servers/new?pack=rust-dev')
  })

  it('hides the Launch button, with a hint, for a disabled pack', async () => {
    vi.mocked(api.listSurgePacks).mockResolvedValue([officialPublic(), registryPublic(), localPublic()])
    vi.mocked(api.listAdminSurgePacks).mockResolvedValue([
      officialAdmin(),
      registryAdmin(),
      localAdmin(),
      { ...localAdmin(), packId: 'disabled-pack', name: 'Disabled Pack', enabled: false, tools: ['claude-code'] },
    ])
    renderDetail('disabled-pack')

    expect(await screen.findByTestId('launch-unavailable')).toBeTruthy()
    expect(screen.queryByRole('link', { name: /launch a server with this pack/i })).toBeNull()
  })

  it('shows a member the grid, the detail view and the Launch button, and no admin regions', async () => {
    auth.isAdmin = false
    renderList()
    await screen.findByTestId('pack-card-rust-dev')

    expect(screen.queryByText('Manage packs')).toBeNull()
    expect(screen.queryByTestId('import-file')).toBeNull()
    expect(screen.queryByTestId('import-url')).toBeNull()
    expect(screen.queryByRole('button', { name: 'New Surge Pack' })).toBeNull()
    expect(screen.queryByTestId('shelf-Rocky Surf Pack Shop')).toBeNull()
    expect(api.listAdminSurgePacks).not.toHaveBeenCalled()
    expect(api.getPackRegistry).not.toHaveBeenCalled()

    renderDetail('rust-dev')
    expect(await screen.findByRole('link', { name: /launch a server with this pack/i })).toBeTruthy()
  })

  it('renders "no such pack" and a link back for an unknown :packId, not a crash or a redirect', async () => {
    renderDetail('does-not-exist')
    expect(await screen.findByText(/no such pack/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: /all surge packs/i }).getAttribute('href')).toBe('/packs')
  })
})
