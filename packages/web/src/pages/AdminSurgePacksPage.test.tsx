import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminSurgePack, AdminTool } from '../lib/api'
import { AdminSurgePacksPage } from './AdminSurgePacksPage'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ...actual,
    listAdminSurgePacks: vi.fn(),
    listAdminTools: vi.fn(),
    exportSurgePackYaml: vi.fn(),
    importSurgePack: vi.fn(),
    deleteAdminSurgePack: vi.fn(),
  }
})

const api = await import('../lib/api')

const tool: AdminTool = {
  toolId: 'claude-code',
  name: 'Claude Code',
  description: 'the agent',
  category: 'agent',
  url: 'https://example.com',
  installScript: 'true',
  enabled: true,
  installOrder: 40,
  bootstrap: false,
  runAs: 'rocky',
} as AdminTool

const filePack: AdminSurgePack = {
  packId: 'open-claw',
  name: 'OpenClaw',
  tools: ['claude-code'],
  displayOrder: 10,
  enabled: true,
  requiresRepos: true,
  requiresRdp: false,
  desktop: 'xfce',
  sourceFile: 'open-claw.yaml',
}

const dbPack: AdminSurgePack = {
  packId: 'mine',
  name: 'Mine',
  tools: [],
  displayOrder: 20,
  enabled: true,
  requiresRepos: false,
  requiresRdp: true,
  sourceFile: null,
}

const renderPage = (packs: AdminSurgePack[] = [filePack, dbPack]) => {
  vi.mocked(api.listAdminSurgePacks).mockResolvedValue(packs)
  vi.mocked(api.listAdminTools).mockResolvedValue([tool])
  return render(
    <MemoryRouter>
      <AdminSurgePacksPage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.mocked(api.listAdminSurgePacks).mockReset()
  vi.mocked(api.listAdminTools).mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('provenance (ADR-0004)', () => {
  it('shows a file-backed pack read-only, naming the file to edit', async () => {
    renderPage()

    // The boot sync rewrites this row from disk, so an edit offered here would vanish on the
    // next start — worse than not offering it.
    expect(await screen.findByTestId('file-backed-open-claw')).toBeDefined()
    const hint = screen.getByTestId('readonly-hint-open-claw')
    expect(hint.textContent).toContain('open-claw.yaml')

    const row = screen.getByTestId('pack-row-open-claw')
    expect(row.textContent).not.toContain('Delete')
  })

  it('leaves a database-created pack editable', async () => {
    renderPage()
    await screen.findByTestId('pack-row-mine')

    expect(screen.queryByTestId('file-backed-mine')).toBeNull()
    expect(screen.queryByTestId('readonly-hint-mine')).toBeNull()
    expect(screen.getByTestId('pack-row-mine').textContent).toContain('Delete')
  })

  it('offers export for both, since exporting never mutates anything', async () => {
    renderPage()
    await screen.findByTestId('pack-row-open-claw')
    expect(screen.getByTestId('pack-row-open-claw').textContent).toContain('Export')
    expect(screen.getByTestId('pack-row-mine').textContent).toContain('Export')
  })
})

describe('the three behaviour fields', () => {
  it('renders them per pack, so behaviour is described by the pack and not special-cased', async () => {
    renderPage()
    const fileRow = await screen.findByTestId('pack-row-open-claw')
    expect(fileRow.textContent).toContain('repos')
    expect(fileRow.textContent).toContain('xfce')
    expect(screen.getByTestId('pack-row-mine').textContent).toContain('rdp')
  })

  it('offers a control for each when creating a pack', async () => {
    renderPage([])
    ;(await screen.findByRole('button', { name: /new pack/i })).click()

    const form = await screen.findByTestId('pack-form')
    expect(form.textContent).toContain('Requires repositories')
    expect(form.textContent).toContain('Requires a remote-desktop password')
    expect(form.textContent).toContain('Desktop')
  })
})

describe('import', () => {
  it('imports YAML from a file and says the result is a database row', async () => {
    vi.mocked(api.importSurgePack).mockResolvedValue({ ...dbPack, packId: 'imported' })
    renderPage()
    await screen.findByTestId('pack-row-mine')

    const input = screen.getByTestId('import-file') as HTMLInputElement
    const file = new File(['version: 1\n'], 'pack.yaml', { type: 'application/yaml' })
    Object.defineProperty(input, 'files', { value: [file] })
    input.dispatchEvent(new Event('change', { bubbles: true }))

    await waitFor(() => expect(api.importSurgePack).toHaveBeenCalledWith({ yaml: 'version: 1\n' }))
    // The operator needs to know the import did NOT make it source-controlled.
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toContain('packs/'))
  })

  it('offers the URL path too, which is the one that carries the SSRF risk', async () => {
    // Core fetches that URL server-side (rockysurf-ftl9.9). The control exists because the
    // brief asks for it; the call site carries the reference in a comment.
    renderPage()
    expect(await screen.findByTestId('import-url')).toBeDefined()
  })
})

describe('export', () => {
  it('downloads the rendered YAML rather than showing it', async () => {
    vi.mocked(api.exportSurgePackYaml).mockResolvedValue('version: 1\npack: {}\n')
    const createObjectURL = vi.fn(() => 'blob:fake')
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })

    renderPage()
    await screen.findByTestId('pack-row-open-claw')
    ;(screen.getAllByRole('button', { name: /export/i })[0] as HTMLButtonElement).click()

    await waitFor(() => expect(api.exportSurgePackYaml).toHaveBeenCalledWith('open-claw'))
    // A file, so the operator can drop it into packs/ and make it the source of truth.
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled())
  })
})

describe('failures', () => {
  it('shows an error rather than an empty page', async () => {
    vi.mocked(api.listAdminSurgePacks).mockRejectedValue(new Error('nope'))
    vi.mocked(api.listAdminTools).mockResolvedValue([])
    render(
      <MemoryRouter>
        <AdminSurgePacksPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('nope'))
  })
})
