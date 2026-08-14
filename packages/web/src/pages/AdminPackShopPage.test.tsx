import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminPackShopPage } from './AdminPackShopPage'
import type { AdminSurgePack, PackRegistry, RegistryPackDetail } from '../lib/api'

/**
 * The pack shop page.
 *
 * The assertions that matter are about honesty rather than rendering: that provenance is shown
 * and comes from the right place, that a registry's outage does not read as an empty shop, and
 * that nothing can be installed without the disclosure having been on screen first.
 */

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'admin', isAdmin: true }, logout: vi.fn() }),
}))
vi.mock('../contexts/EventsContext', () => ({
  useEvents: () => ({ subscribe: () => () => {}, connectionStatus: 'connected' }),
}))
vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  Toaster: () => null,
}))
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ...actual,
    getPackRegistry: vi.fn(),
    getRegistryPack: vi.fn(),
    installRegistryPack: vi.fn(),
    listAdminSurgePacks: vi.fn(),
  }
})

const api = await import('../lib/api')

const pack = (over: Partial<AdminSurgePack> = {}): AdminSurgePack => ({
  packId: 'p',
  name: 'P',
  tools: ['a-tool'],
  displayOrder: 1,
  enabled: true,
  requiresRepos: false,
  requiresRdp: false,
  sourceFile: null,
  registry: null,
  ...over,
})

const registryPack = (over: Record<string, unknown> = {}) => ({
  packId: 'rust-dev',
  name: 'Rust Dev',
  description: 'Installs 1 tool(s): rustup',
  path: 'packs/rust-dev.yaml',
  sha256: 'a'.repeat(64),
  definesTools: ['rustup'],
  referencesTools: [],
  requiresRepos: false,
  requiresRdp: false,
  sourceName: 'Rocky Surf Pack Shop',
  trust: 'community' as const,
  installed: false,
  ...over,
})

const shop = (over: Partial<PackRegistry> = {}): PackRegistry => ({
  enabled: true,
  sources: [{ name: 'Rocky Surf Pack Shop', url: 'https://example.com/shop', trust: 'community' }],
  shelves: [
    {
      source: { name: 'Rocky Surf Pack Shop', url: 'https://example.com/shop', trust: 'community' },
      packs: [registryPack()],
      fetchedAt: '2026-08-14T00:00:00.000Z',
      failure: null,
    },
  ],
  ...over,
})

const DETAIL: RegistryPackDetail = {
  entry: registryPack(),
  yaml: 'version: 1\npack:\n  packId: rust-dev\n',
  disclosure: {
    packId: 'rust-dev',
    name: 'Rust Dev',
    tools: [
      {
        toolId: 'rustup',
        name: 'rustup',
        description: 'The Rust toolchain installer',
        url: 'https://rustup.rs',
        runAs: 'root',
        installOrder: 30,
        installScript: 'curl -fsSL https://sh.rustup.rs | sh\n',
        fetchesUrls: ['https://sh.rustup.rs'],
      },
    ],
    referencesTools: [],
    rootStepCount: 1,
    fetchesUrls: ['https://sh.rustup.rs'],
    requiresRepos: false,
    requiresRdp: false,
    summaryIsComplete: false,
  },
}

const show = async () => {
  render(
    <MemoryRouter>
      <AdminPackShopPage />
    </MemoryRouter>,
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.mocked(api.getPackRegistry).mockResolvedValue(shop())
  vi.mocked(api.listAdminSurgePacks).mockResolvedValue([])
  vi.mocked(api.getRegistryPack).mockResolvedValue(DETAIL)
  vi.mocked(api.installRegistryPack).mockResolvedValue(pack({ packId: 'rust-dev', name: 'Rust Dev' }))
})

describe('provenance labelling', () => {
  it('calls a file-backed pack official, because that is what shipped with the release', async () => {
    // The split horizon (ADR-0006): official is not a claim any registry makes, it is the fact
    // that the pack arrived in the tarball — which in the API is a non-null sourceFile.
    vi.mocked(api.listAdminSurgePacks).mockResolvedValue([
      pack({ packId: 'ai-coding-agents', name: 'Claude Code', sourceFile: 'ai-coding-agents.yaml' }),
    ])
    await show()

    const card = screen.getByTestId('installed-ai-coding-agents')
    expect(card.textContent).toContain('official')
    expect(card.textContent).toContain('shipped with this release')
  })

  it('labels a registry-installed pack with the trust recorded at install', async () => {
    vi.mocked(api.listAdminSurgePacks).mockResolvedValue([
      pack({
        packId: 'rust-dev',
        name: 'Rust Dev',
        registry: { source: 'Acme internal', url: 'https://acme', sha256: 'x', trust: 'internal', installedAt: null },
      }),
    ])
    await show()

    const card = screen.getByTestId('installed-rust-dev')
    expect(card.textContent).toContain('internal')
    expect(card.textContent).toContain('installed from Acme internal')
  })

  it('never labels a registry pack official, whatever it is called', async () => {
    // The property the whole trust model rests on: `official` cannot be claimed from outside.
    vi.mocked(api.listAdminSurgePacks).mockResolvedValue([
      pack({
        packId: 'sneaky',
        name: 'Definitely Official',
        sourceFile: null,
        registry: { source: 'Official Packs', url: 'https://x', sha256: 'y', trust: 'community', installedAt: null },
      }),
    ])
    await show()
    expect(screen.getByTestId('installed-sneaky').textContent).not.toContain('official')
  })

  it('calls an admin-created pack local rather than guessing at a source', async () => {
    vi.mocked(api.listAdminSurgePacks).mockResolvedValue([pack({ packId: 'mine', name: 'Mine' })])
    await show()
    expect(screen.getByTestId('installed-mine').textContent).toContain('created here')
  })
})

describe('shelves', () => {
  it('shows a failing registry’s reason rather than an empty shop', async () => {
    // "This registry is down" and "this registry is empty" are different facts, and collapsing
    // them makes an outage invisible.
    vi.mocked(api.getPackRegistry).mockResolvedValue(
      shop({
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
    await show()
    expect(screen.getByTestId('shelf-failure-Rocky Surf Pack Shop').textContent).toContain('Could not fetch')
  })

  it('says so when the registry is switched off, which is not a failure', async () => {
    vi.mocked(api.getPackRegistry).mockResolvedValue(shop({ enabled: false, shelves: [] }))
    await show()
    expect(screen.getByTestId('registry-disabled')).toBeTruthy()
  })

  it('marks a pack already in the catalogue', async () => {
    vi.mocked(api.getPackRegistry).mockResolvedValue(
      shop({
        shelves: [
          {
            source: { name: 'Rocky Surf Pack Shop', url: 'https://example.com/shop', trust: 'community' },
            packs: [registryPack({ installed: true })],
            fetchedAt: null,
            failure: null,
          },
        ],
      }),
    )
    await show()
    expect(screen.getByTestId('registry-rust-dev').textContent).toContain('already installed')
  })
})

describe('installing goes through the disclosure', () => {
  it('has no install control until the pack has been reviewed', async () => {
    // The rule the whole stage exists for: consenting to a pack means having seen its scripts.
    await show()
    expect(screen.queryByRole('button', { name: /^Install/ })).toBeNull()
    expect(api.installRegistryPack).not.toHaveBeenCalled()
  })

  it('reviewing shows the scripts, then installing sends only the address', async () => {
    await show()
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())

    expect(screen.getByTestId('disclosure-tool-rustup').textContent).toContain('curl -fsSL https://sh.rustup.rs')

    fireEvent.click(screen.getByRole('button', { name: /^Install/ }))
    await waitFor(() => expect(api.installRegistryPack).toHaveBeenCalledWith('Rocky Surf Pack Shop', 'rust-dev'))

    // Not the YAML, not the disclosure — the address. Core refetches and re-verifies, so nothing
    // the browser holds can decide what runs as root.
    const [args] = vi.mocked(api.installRegistryPack).mock.calls
    expect(args).toHaveLength(2)
  })

  it('reloads the catalogue after installing, so the new pack appears without a refresh', async () => {
    await show()
    vi.mocked(api.listAdminSurgePacks).mockResolvedValue([
      pack({
        packId: 'rust-dev',
        name: 'Rust Dev',
        registry: { source: 'Rocky Surf Pack Shop', url: 'u', sha256: 's', trust: 'community', installedAt: null },
      }),
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Install/ }))

    await waitFor(() => expect(screen.getByTestId('installed-rust-dev')).toBeTruthy())
  })
})
