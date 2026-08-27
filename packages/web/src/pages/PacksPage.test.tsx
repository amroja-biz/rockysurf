import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
 *
 * ISSUE #204 MADE THE THREE SECTIONS TABS, all three still mounted (`hidden`, not unmounted —
 * see the file's own docblock for why). A `getByTestId` query finds a card on any tab
 * regardless of which is active; a `getByRole` query does not, because `hidden` removes a
 * subtree from the accessibility tree the same way real browsers do. So a test that only checks
 * a card is IN THE DOM stays on the default tab; a test that CLICKS something, or that asserts a
 * button/link/heading/tab role, renders with the tab it needs already active via `renderList({
 * tab })` — the same `?tab=` the page itself reads.
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

/** What the export route renders for a file-backed pack (issue #192). */
const SHIPPED_YAML = `version: 1
pack:
  packId: ai-coding-agents
  name: Claude Code
tools:
  - toolId: claude-code
    installScript: |
      curl -fsSL https://claude.ai/install.sh | bash
`

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
  vi.mocked(api.exportSurgePackYaml).mockResolvedValue(SHIPPED_YAML)
})

afterEach(() => {
  vi.clearAllMocks()
  // The filter row remembers itself per browser (issue #199) — real `localStorage`, so one
  // test's click must not decide another test's default.
  localStorage.clear()
})

/** `tab` sets the initial `?tab=` — the same param the page itself reads (issue #204). */
function renderList(opts: { tab?: 'official' | 'community' | 'personal' } = {}) {
  const entry = opts.tab ? `/packs?tab=${opts.tab}` : '/packs'
  return render(
    <MemoryRouter initialEntries={[entry]}>
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
  /**
   * THE SENTENCE MOVED TO THE DETAIL PAGE (issue #192); the badge did not move.
   *
   * A card is a mark, a name and core's own three words. "Where did this come from, exactly" is
   * a question an admin asks about ONE pack, on that pack's page — not about twenty at once, in
   * a grid. So each assertion below reads the sentence where it now lives, and also asserts it
   * is gone from the card, because that removal is the issue, not a side effect of it.
   */
  it('reads a file-backed pack official, because that is what shipped with the release', async () => {
    renderList()
    const card = await screen.findByTestId('pack-card-ai-coding-agents')
    expect(card.querySelector('[data-testid="trust-official"]')).toBeTruthy()
    expect(card.textContent).not.toContain('shipped with this release')

    renderDetail('ai-coding-agents')
    expect(await screen.findByText(/shipped with this release · ai-coding-agents\.yaml/)).toBeTruthy()
  })

  it('labels a registry-installed pack "registry", never "official", and names the real source', async () => {
    renderList({ tab: 'community' })
    const card = await screen.findByTestId('pack-card-rust-dev')
    expect(card.querySelector('[data-testid="trust-registry"]')).toBeTruthy()
    expect(card.querySelector('[data-testid="trust-official"]')).toBeNull()
    expect(card.textContent).not.toContain('installed from')

    renderDetail('rust-dev')
    const origin = await screen.findByText(/installed from Rocky Surf Pack Shop/)
    // And the URL, since issue #88: which shelf was clicked is not the same question as what
    // this installation actually fetched, and with a personal source it is the second one that
    // an operator is asking. Admin-only, like the rest of this sentence.
    expect(origin.textContent).toContain('https://example.com/shop')
  })

  it('says an imported pack came from its URL, rather than calling it something made here', async () => {
    // Issue #88. `a URL import` is the exact string core stamps for a one-off fetch; the point
    // of the sentence is that a pack full of root shell fetched from somebody else's host does
    // not read as "created here, in this installation".
    vi.mocked(api.listAdminSurgePacks).mockResolvedValue([
      officialAdmin(),
      registryAdmin({
        packId: 'mine',
        name: 'Mine',
        registry: {
          source: 'a URL import',
          url: 'https://packs.example.com/my-pack.yaml',
          sha256: 'c'.repeat(64),
          trust: 'unverified',
          installedAt: '2026-08-26T00:00:00.000Z',
        },
      }),
    ])
    vi.mocked(api.listSurgePacks).mockResolvedValue([officialPublic(), localPublic({ provenance: 'registry' })])

    renderDetail('mine')
    const origin = await screen.findByText(/imported from https:\/\/packs\.example\.com\/my-pack\.yaml/)
    expect(origin.textContent).not.toContain('created here')
  })

  it('reads an admin-created pack "local" rather than guessing at a source', async () => {
    renderList({ tab: 'personal' })
    const card = await screen.findByTestId('pack-card-mine')
    expect(card.querySelector('[data-testid="trust-local"]')).toBeTruthy()
    expect(card.textContent).not.toContain('created here, in this installation')

    renderDetail('mine')
    expect(await screen.findByText('created here, in this installation')).toBeTruthy()
  })

  it('spends the card on the mark, the name and the badge — nothing else (#192)', async () => {
    renderList({ tab: 'community' })
    const card = await screen.findByTestId('pack-card-rust-dev')
    expect(card.textContent).toContain('Rust Dev')
    // The tool count went with the origin sentence: the popup and the detail page both list
    // the tools themselves, which is the answer the count was standing in for.
    expect(card.textContent).not.toMatch(/tool\(s\)/)
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
    renderList({ tab: 'community' })
    // The catalogue is `Not installed`'s job; Community defaults to `Installed` (issue #204).
    fireEvent.click(await screen.findByTestId('community-filter-not-installed'))
    expect((await screen.findByTestId('shelf-failure-Rocky Surf Pack Shop')).textContent).toContain('Could not fetch')
  })

  it('says so when the registry is switched off, which is not a failure', async () => {
    vi.mocked(api.getPackRegistry).mockResolvedValue(emptyRegistry({ enabled: false }))
    renderList({ tab: 'community' })
    fireEvent.click(await screen.findByTestId('community-filter-not-installed'))
    expect(await screen.findByTestId('registry-disabled')).toBeTruthy()
  })

  /**
   * NO PACK APPEARS TWICE (issue #199). The old shop card said "already installed" next to a
   * reinstall button for exactly this case; the new design drops that second card entirely —
   * once a registry pack is on this installation, the catalogue's own `installed` flag is what
   * keeps it out of `Not installed`, and it renders exactly once, as a normal card, under
   * Community's `Installed` read.
   */
  it("renders an installed catalogue pack once — as a normal card, never as a 'not installed' one", async () => {
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
    vi.mocked(api.listSurgePacks).mockResolvedValue([
      officialPublic(),
      registryPublic(),
      localPublic(),
      registryPublic({ packId: 'aider', name: 'Aider', tools: [] }),
    ])
    vi.mocked(api.listAdminSurgePacks).mockResolvedValue([
      officialAdmin(),
      registryAdmin(),
      localAdmin(),
      registryAdmin({
        packId: 'aider',
        name: 'Aider',
        registry: { source: 'Rocky Surf Pack Shop', url: 'https://example.com/shop', sha256: 'b'.repeat(64), trust: 'community', installedAt: '2026-08-27T00:00:00.000Z' },
      }),
    ])

    renderList({ tab: 'community' })
    await screen.findByTestId('pack-card-aider')
    expect(screen.queryByTestId('registry-aider')).toBeNull()
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

  /** Community defaults to `Installed` now (issue #204) — the catalogue needs `Not installed`. */
  async function openCatalogue() {
    renderList({ tab: 'community' })
    fireEvent.click(await screen.findByTestId('community-filter-not-installed'))
    return screen.findByTestId('shelf-Rocky Surf Pack Shop')
  }

  it('has no install control until the pack has been reviewed', async () => {
    withShelf()
    await openCatalogue()
    // `/^Install /` with the trailing space, not `/^Install/` — Community's own `Installed`
    // filter button matches the looser pattern too (issue #199).
    expect(screen.queryByRole('button', { name: /^Install / })).toBeNull()
    expect(api.installRegistryPack).not.toHaveBeenCalled()
  })

  it('reviewing shows the scripts, then installing sends only the address', async () => {
    withShelf()
    await openCatalogue()
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    expect(screen.getByTestId('disclosure-tool-aider').textContent).toContain('pipx install aider-chat')

    fireEvent.click(screen.getByRole('button', { name: /^Install / }))
    await waitFor(() => expect(api.installRegistryPack).toHaveBeenCalledWith('Rocky Surf Pack Shop', 'aider'))
    const [args] = vi.mocked(api.installRegistryPack).mock.calls
    expect(args).toHaveLength(2)
  })

  it('reloads the catalogue after installing, so the new pack appears without a refresh — once, not twice', async () => {
    withShelf()
    await openCatalogue()

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
    // Core's own answer to "is this installed" flips too — the same flag the catalogue read
    // used to decide `Not installed` in the first place, refetched by the `load()` after install.
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

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Install / }))

    // Installed is Community's default filter (issue #204) — switch there to see the result.
    fireEvent.click(screen.getByTestId('community-filter-installed'))
    await waitFor(() => expect(screen.getByTestId('pack-card-aider')).toBeTruthy())
    expect(screen.queryByTestId('registry-aider')).toBeNull()
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
    renderList({ tab: 'personal' })
    await screen.findByTestId('pack-card-mine')

    fireEvent.click(screen.getByRole('button', { name: 'New Surge Pack' }))
    fireEvent.click(screen.getByTestId('create-option-upload'))
    const input = (await screen.findByTestId('import-file')) as HTMLInputElement
    const file = new File(['version: 1\n'], 'pack.yaml', { type: 'application/yaml' })
    Object.defineProperty(input, 'files', { value: [file] })
    input.dispatchEvent(new Event('change', { bubbles: true }))

    await waitFor(() => expect(api.importSurgePack).toHaveBeenCalledWith({ yaml: 'version: 1\n' }))
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain('packs/'))
    // Back to the plain button — a successful import returns to the tab unchanged.
    expect(await screen.findByRole('button', { name: 'New Surge Pack' })).toBeTruthy()
  })

  it('renders the behaviour fields per pack, and offers a control for each when starting from scratch', async () => {
    renderDetail('mine')
    expect(await screen.findByText('remote desktop')).toBeTruthy()

    renderList({ tab: 'personal' })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'New Surge Pack' }))
    await user.click(screen.getByTestId('create-option-scratch'))
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
    renderList({ tab: 'community' })
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
    renderList({ tab: 'community' })
    await screen.findByTestId('pack-card-rust-dev')

    // Manage-pack controls: gone for a member, wherever they now live.
    expect(screen.queryByTestId('import-file')).toBeNull()
    expect(screen.queryByTestId('import-url')).toBeNull()
    expect(screen.queryByRole('button', { name: 'New Surge Pack' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
    expect(screen.queryByTestId('shelf-Rocky Surf Pack Shop')).toBeNull()
    expect(api.listAdminSurgePacks).not.toHaveBeenCalled()
    expect(api.getPackRegistry).not.toHaveBeenCalled()

    // Every tab is reachable by a member — the tabs themselves are not an admin region.
    expect(screen.getByRole('tab', { name: 'Official' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Community' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Personal' })).toBeTruthy()

    renderDetail('rust-dev')
    expect(await screen.findByRole('link', { name: /launch a server with this pack/i })).toBeTruthy()
  })

  it('renders "no such pack" and a link back for an unknown :packId, not a crash or a redirect', async () => {
    renderDetail('does-not-exist')
    expect(await screen.findByText(/no such pack/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: /all surge packs/i }).getAttribute('href')).toBe('/packs')
  })
})

/**
 * The hover popup, on every pack's card now (issue #192; issue #199 drops the official-only
 * gate).
 *
 * FAKE TIMERS ONLY AROUND THE DELAY: the page loads under real timers so `findBy*` works
 * normally, and the clock is faked just long enough to walk through the one second the popup
 * waits. `mouseOver`/`mouseOut` rather than `mouseEnter`/`mouseLeave` because React derives
 * enter and leave from the delegated over/out pair.
 */
describe("a pack's card popup", () => {
  const slot = (packId: string) => screen.getByTestId(`pack-card-slot-${packId}`)

  it('opens only after a second of hovering, and lists what the pack installs', async () => {
    renderList()
    await screen.findByTestId('pack-card-ai-coding-agents')

    vi.useFakeTimers()
    try {
      fireEvent.mouseOver(slot('ai-coding-agents'))
      // Crossing the grid on the way somewhere else must not open anything.
      act(() => void vi.advanceTimersByTime(999))
      expect(screen.queryByTestId('pack-popup-ai-coding-agents')).toBeNull()

      act(() => void vi.advanceTimersByTime(1))
      const popup = screen.getByTestId('pack-popup-ai-coding-agents')
      expect(within(popup).getByTestId('pack-popup-tools-ai-coding-agents').textContent).toContain('Claude Code')
      expect(within(popup).getByRole('link', { name: /new server/i }).getAttribute('href')).toBe(
        '/servers/new?pack=ai-coding-agents',
      )
      expect(within(popup).getByRole('button', { name: 'Export' })).toBeTruthy()

      fireEvent.mouseOut(slot('ai-coding-agents'))
      expect(screen.queryByTestId('pack-popup-ai-coding-agents')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens on keyboard focus too, and Escape dismisses it without trapping focus', async () => {
    renderList()
    const card = await screen.findByTestId('pack-card-ai-coding-agents')

    vi.useFakeTimers()
    try {
      act(() => (card as HTMLElement).focus())
      act(() => void vi.advanceTimersByTime(1000))
      expect(screen.getByTestId('pack-popup-ai-coding-agents')).toBeTruthy()

      fireEvent.keyDown(card, { key: 'Escape' })
      expect(screen.queryByTestId('pack-popup-ai-coding-agents')).toBeNull()
      // Escape hands the card back, rather than dropping the user at the top of the document.
      expect(document.activeElement).toBe(card)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens for a community pack too, not only an official one', async () => {
    renderList({ tab: 'community' })
    await screen.findByTestId('pack-card-rust-dev')

    vi.useFakeTimers()
    try {
      fireEvent.mouseOver(slot('rust-dev'))
      act(() => void vi.advanceTimersByTime(1000))
      const popup = screen.getByTestId('pack-popup-rust-dev')
      expect(within(popup).getByTestId('pack-popup-tools-rust-dev').textContent).toContain('rustup')
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens for a personal pack too', async () => {
    renderList({ tab: 'personal' })
    await screen.findByTestId('pack-card-mine')

    vi.useFakeTimers()
    try {
      fireEvent.mouseOver(slot('mine'))
      act(() => void vi.advanceTimersByTime(1000))
      expect(screen.getByTestId('pack-popup-mine')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('downloads the pack file from the popup, over the export route the page already used', async () => {
    const createObjectURL = vi.fn(() => 'blob:pack')
    const revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })

    try {
      renderList()
      await screen.findByTestId('pack-card-ai-coding-agents')

      vi.useFakeTimers()
      fireEvent.mouseOver(slot('ai-coding-agents'))
      act(() => void vi.advanceTimersByTime(1000))
      vi.useRealTimers()

      fireEvent.click(within(screen.getByTestId('pack-popup-ai-coding-agents')).getByRole('button', { name: 'Export' }))

      await waitFor(() => expect(api.exportSurgePackYaml).toHaveBeenCalledWith('ai-coding-agents'))
      await waitFor(() => expect(createObjectURL).toHaveBeenCalled())
      expect(click).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      click.mockRestore()
    }
  })
})

/**
 * A pack's own file, on its detail page — every pack now (issue #192; issue #199 drops the
 * official-only gate). It reads over the export route that was already there; the alternative,
 * a second non-admin read route for a pack's file, was ruled out because a Rocky Surf
 * installation has no non-admin to serve it to.
 */
describe("a pack's file on the detail page", () => {
  it('shows an official pack its own YAML, read over the export route', async () => {
    renderDetail('ai-coding-agents')

    const file = await screen.findByTestId('pack-file-text')
    expect(file.textContent).toContain('packId: ai-coding-agents')
    expect(file.textContent).toContain('curl -fsSL https://claude.ai/install.sh')
    expect(api.exportSurgePackYaml).toHaveBeenCalledWith('ai-coding-agents')
    // Only an official pack's file shipped WITH THE RELEASE — the sentence above it says so.
    expect(screen.getByText(/shipped with this Rocky Surf release/)).toBeTruthy()
  })

  it('shows a personal pack its own YAML too, without claiming it shipped with the release', async () => {
    renderDetail('mine')

    const file = await screen.findByTestId('pack-file-text')
    expect(api.exportSurgePackYaml).toHaveBeenCalledWith('mine')
    expect(screen.queryByText(/shipped with this Rocky Surf release/)).toBeNull()
    // Still exactly one Export button — the pack file section's, not a second one below it.
    expect(screen.getAllByRole('button', { name: 'Export' })).toHaveLength(1)
    expect(file).toBeTruthy()
  })

  it("shows a community pack's own YAML too", async () => {
    renderDetail('rust-dev')

    expect(await screen.findByTestId('pack-file-text')).toBeTruthy()
    expect(api.exportSurgePackYaml).toHaveBeenCalledWith('rust-dev')
  })

  it('keeps the rest of the page when the file cannot be read', async () => {
    vi.mocked(api.exportSurgePackYaml).mockRejectedValue(new Error('nope'))
    renderDetail('ai-coding-agents')

    expect(await screen.findByTestId('pack-file-unavailable')).toBeTruthy()
    expect(screen.getByTestId('pack-tools')).toBeTruthy()
  })
})

/**
 * A pack that asks the user for something says so on its card (issue #189, ADR-0013).
 *
 * A COUNT rather than the names, and deliberately: this is a list somebody is browsing, and the
 * names belong where a decision is being made — the create form's fields and the pre-install
 * disclosure. What the chip carries is the one bit a browser needs, "this one will ask you
 * something", which is the same job `remote desktop` and `needs a repository` do.
 */
describe('a pack that asks for settings (issue #189)', () => {
  it('says how many on the pack’s own page', async () => {
    vi.mocked(api.listSurgePacks).mockResolvedValue([
      localPublic({
        inputs: [
          { name: 'HEADLONG_HEADLESS', label: 'Headless install', required: true, secret: false },
          { name: 'HEADLONG_API_KEY', label: 'Headlong API key', required: false, secret: true },
        ],
      }),
    ])
    renderDetail('mine')
    expect(await screen.findByText('asks for 2 settings')).toBeTruthy()
  })

  it('says it in the singular for one', async () => {
    vi.mocked(api.listSurgePacks).mockResolvedValue([
      localPublic({ inputs: [{ name: 'A', label: 'A', required: false, secret: false }] }),
    ])
    renderDetail('mine')
    expect(await screen.findByText('asks for 1 setting')).toBeTruthy()
  })

  it('says nothing at all for a pack that asks for none, which is every shipped pack today', async () => {
    vi.mocked(api.listSurgePacks).mockResolvedValue([localPublic()])
    renderDetail('mine')
    // Anchored on a chip that IS there, so the absence below is a real absence rather than a
    // page that had not finished loading.
    expect(await screen.findByText('remote desktop')).toBeTruthy()
    expect(screen.queryByText(/asks for \d+ setting/)).toBeNull()
  })
})

/**
 * Three sections, named by the same word their badge uses (issue #199). The wire values
 * (`official`/`registry`/`local`) are untouched — `TrustBadge`'s `data-testid` still keys off
 * them, asserted below alongside the word a person actually reads.
 */
describe('three sections, one vocabulary (issue #199)', () => {
  it('groups official, registry and local packs under the Official, Community and Personal panels', async () => {
    renderList()
    await screen.findByTestId('pack-card-ai-coding-agents')

    // All three panels are mounted at once (issue #204); which one a card lives under is a
    // question about its ancestor `tabpanel`, not about which is currently visible.
    const officialPanel = screen.getByTestId('pack-card-ai-coding-agents').closest('[role="tabpanel"]')
    const communityPanel = screen.getByTestId('pack-card-rust-dev').closest('[role="tabpanel"]')
    const personalPanel = screen.getByTestId('pack-card-mine').closest('[role="tabpanel"]')

    expect(officialPanel?.id).toBe('packs-panel-official')
    expect(communityPanel?.id).toBe('packs-panel-community')
    expect(personalPanel?.id).toBe('packs-panel-personal')
  })

  it('badges a registry pack COMMUNITY and a local pack PERSONAL, never their wire words', async () => {
    renderList()
    const registryBadge = (await screen.findByTestId('pack-card-rust-dev')).querySelector(
      '[data-testid="trust-registry"]',
    )!
    const localBadge = screen.getByTestId('pack-card-mine').querySelector('[data-testid="trust-local"]')!

    // The testid still keys off the wire value — the badge word is the only thing that changed.
    expect(registryBadge.textContent).toBe('community')
    expect(localBadge.textContent).toBe('personal')
  })

  it("badges a not-yet-installed catalogue pack COMMUNITY too, matching the section it's in", async () => {
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
    renderList({ tab: 'community' })
    fireEvent.click(await screen.findByTestId('community-filter-not-installed'))
    const card = await screen.findByTestId('registry-aider')
    expect(card.querySelector('[data-testid="trust-registry"]')?.textContent).toBe('community')
  })
})

/**
 * The three sections as tabs (issue #204), routed like Settings' own (issue #122): `?tab=` in
 * the URL, Official shown first.
 */
describe('tabs (issue #204)', () => {
  it('defaults to the Official tab', async () => {
    renderList()
    await screen.findByTestId('pack-card-ai-coding-agents')

    expect(screen.getByRole('tab', { name: 'Official' }).getAttribute('aria-selected')).toBe('true')
    expect((screen.getByTestId('pack-card-ai-coding-agents').closest('[role="tabpanel"]') as HTMLElement).hidden).toBe(
      false,
    )
    expect((screen.getByTestId('pack-card-rust-dev').closest('[role="tabpanel"]') as HTMLElement).hidden).toBe(true)
  })

  it('?tab=community lands on Community with Installed selected', async () => {
    renderList({ tab: 'community' })
    await screen.findByTestId('pack-card-rust-dev')

    expect(screen.getByRole('tab', { name: 'Community' }).getAttribute('aria-selected')).toBe('true')
    expect((screen.getByTestId('pack-card-rust-dev').closest('[role="tabpanel"]') as HTMLElement).hidden).toBe(false)
    expect(screen.getByTestId('community-filter-installed').getAttribute('aria-pressed')).toBe('true')
  })

  it('clicking a tab switches which panel is visible', async () => {
    renderList()
    await screen.findByTestId('pack-card-ai-coding-agents')

    fireEvent.click(screen.getByRole('tab', { name: 'Personal' }))

    expect(screen.getByRole('tab', { name: 'Personal' }).getAttribute('aria-selected')).toBe('true')
    expect((screen.getByTestId('pack-card-mine').closest('[role="tabpanel"]') as HTMLElement).hidden).toBe(false)
    expect((screen.getByTestId('pack-card-ai-coding-agents').closest('[role="tabpanel"]') as HTMLElement).hidden).toBe(
      true,
    )
  })

  it('shows the fixed Community caption, linking to Rocky Surf Shop', async () => {
    renderList({ tab: 'community' })
    await screen.findByTestId('pack-card-rust-dev')

    const caption = screen.getByTestId('community-caption')
    expect(caption.textContent).toContain('Community packs from')
    const link = within(caption).getByRole('link', { name: 'Rocky Surf Shop' })
    expect(link.getAttribute('href')).toBe('https://github.com/amroja-biz/rockysurf-shop')
  })
})

/**
 * Community's All / Installed / Not installed filter (issue #199), modelled on Claude's
 * Connectors page. Default flipped to `Installed` by issue #204.
 */
describe("Community's All / Installed / Not installed filter", () => {
  const withCatalogue = (installed = false) =>
    vi.mocked(api.getPackRegistry).mockResolvedValue(
      emptyRegistry({
        sources: [{ name: 'Rocky Surf Pack Shop', url: 'https://example.com/shop', trust: 'community' }],
        shelves: [
          {
            source: { name: 'Rocky Surf Pack Shop', url: 'https://example.com/shop', trust: 'community' },
            packs: [registryPackEntry({ installed })],
            fetchedAt: null,
            failure: null,
          },
        ],
      }),
    )

  it('defaults to Installed: shows the installed pack, not the catalogue (issue #204)', async () => {
    withCatalogue()
    renderList({ tab: 'community' })
    expect(await screen.findByTestId('pack-card-rust-dev')).toBeTruthy()
    expect(screen.queryByTestId('registry-aider')).toBeNull()
    expect(screen.getByTestId('community-filter-installed').getAttribute('aria-pressed')).toBe('true')
  })

  it('All shows the installed pack and the catalogue pack together', async () => {
    withCatalogue()
    renderList({ tab: 'community' })
    await screen.findByTestId('pack-card-rust-dev')

    fireEvent.click(screen.getByTestId('community-filter-all'))

    expect(screen.getByTestId('pack-card-rust-dev')).toBeTruthy()
    expect(await screen.findByTestId('registry-aider')).toBeTruthy()
  })

  it('Not installed hides the installed card and keeps the catalogue', async () => {
    withCatalogue()
    renderList({ tab: 'community' })
    await screen.findByTestId('pack-card-rust-dev')

    fireEvent.click(screen.getByTestId('community-filter-not-installed'))

    expect(screen.queryByTestId('pack-card-rust-dev')).toBeNull()
    expect(await screen.findByTestId('registry-aider')).toBeTruthy()
  })

  it('remembers the chosen filter per browser, and applies it on the next visit', async () => {
    withCatalogue()
    const first = renderList({ tab: 'community' })
    await screen.findByTestId('pack-card-rust-dev')
    fireEvent.click(screen.getByTestId('community-filter-all'))
    expect(await screen.findByTestId('registry-aider')).toBeTruthy()
    first.unmount()

    renderList({ tab: 'community' })
    await screen.findByTestId('pack-card-rust-dev')
    expect(screen.getByTestId('community-filter-all').getAttribute('aria-pressed')).toBe('true')
    expect(await screen.findByTestId('registry-aider')).toBeTruthy()
  })
})

/**
 * Personal's `New Surge Pack` (issue #204): one cyan `new-action` button, opening a chooser
 * between uploading a file, starting from an existing pack, and starting from scratch — rather
 * than the bare file input, the "…or from a URL" field and the plain button this replaces.
 */
describe("Personal's New Surge Pack flow (issue #204)", () => {
  it('the URL field and its Import button are gone', async () => {
    renderList({ tab: 'personal' })
    await screen.findByTestId('pack-card-mine')

    expect(screen.queryByTestId('import-url')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Import from URL' })).toBeNull()
  })

  it('New Surge Pack is the cyan new-action button, and Choose File is hidden until it is clicked', async () => {
    renderList({ tab: 'personal' })
    await screen.findByTestId('pack-card-mine')

    const button = screen.getByRole('button', { name: 'New Surge Pack' })
    expect(button.className).toContain('new-action')
    expect(screen.queryByTestId('import-file')).toBeNull()

    fireEvent.click(button)
    fireEvent.click(screen.getByTestId('create-option-upload'))
    expect(await screen.findByTestId('import-file')).toBeTruthy()
  })

  it('offers three ways to start: upload, an existing pack, or from scratch', async () => {
    renderList({ tab: 'personal' })
    await screen.findByTestId('pack-card-mine')

    fireEvent.click(screen.getByRole('button', { name: 'New Surge Pack' }))
    const chooser = await screen.findByTestId('pack-create-chooser')
    expect(within(chooser).getByTestId('create-option-upload')).toBeTruthy()
    expect(within(chooser).getByTestId('create-option-existing')).toBeTruthy()
    expect(within(chooser).getByTestId('create-option-scratch')).toBeTruthy()
  })

  it('Cancel from the chooser returns to the tab unchanged', async () => {
    renderList({ tab: 'personal' })
    await screen.findByTestId('pack-card-mine')

    fireEvent.click(screen.getByRole('button', { name: 'New Surge Pack' }))
    await screen.findByTestId('pack-create-chooser')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByTestId('pack-create-chooser')).toBeNull()
    expect(screen.getByRole('button', { name: 'New Surge Pack' })).toBeTruthy()
  })

  it('says so in one sentence, and still offers New Surge Pack, when there are no personal packs yet', async () => {
    vi.mocked(api.listSurgePacks).mockResolvedValue([officialPublic(), registryPublic()])
    vi.mocked(api.listAdminSurgePacks).mockResolvedValue([officialAdmin(), registryAdmin()])
    renderList({ tab: 'personal' })

    expect(await screen.findByText('No personal packs yet.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New Surge Pack' })).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  /**
   * Seeded from the source's own tool IDS, not from Export (`StartFromExistingPanel`'s own
   * docblock explains why Export would be the wrong source here) — so this asserts the create
   * form comes up pre-filled with a new id and the source's tools already checked, and that
   * saving goes through `createAdminSurgePack`, never `importSurgePack`.
   */
  it("start from an existing pack seeds the create form with the source pack's tools, under a new id", async () => {
    renderList({ tab: 'personal' })
    await screen.findByTestId('pack-card-mine')

    fireEvent.click(screen.getByRole('button', { name: 'New Surge Pack' }))
    fireEvent.click(screen.getByTestId('create-option-existing'))

    // Defaults to the first pack in `displayOrder` — `ai-coding-agents`.
    const form = await screen.findByTestId('pack-form')
    const packIdInput = within(form).getByLabelText(/Pack ID/i) as HTMLInputElement
    const nameInput = within(form).getByLabelText('Name') as HTMLInputElement
    expect(packIdInput.value).toBe('ai-coding-agents-copy')
    expect(nameInput.value).toBe('Claude Code (copy)')
    // Referenced, not redefined: the source's own tool comes up checked, nothing about it is
    // ever sent as a new tool definition — the form only ever submits ids.
    expect((within(form).getByRole('checkbox', { name: /Claude Code/ }) as HTMLInputElement).checked).toBe(true)

    fireEvent.change(packIdInput, { target: { value: 'my-claude-fork' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.createAdminSurgePack).toHaveBeenCalled())
    expect(api.importSurgePack).not.toHaveBeenCalled()
    const call = vi.mocked(api.createAdminSurgePack).mock.calls[0]!
    expect(call[0]).toMatchObject({ packId: 'my-claude-fork', tools: ['claude-code'] })
  })

  it('offers every installed pack as a source, official, community and personal alike', async () => {
    renderList({ tab: 'personal' })
    await screen.findByTestId('pack-card-mine')

    fireEvent.click(screen.getByRole('button', { name: 'New Surge Pack' }))
    fireEvent.click(screen.getByTestId('create-option-existing'))

    const select = (await screen.findByTestId('from-existing-source')) as HTMLSelectElement
    const optionValues = [...select.options].map((o) => o.value)
    expect(optionValues).toEqual(expect.arrayContaining(['ai-coding-agents', 'rust-dev', 'mine']))
  })
})
