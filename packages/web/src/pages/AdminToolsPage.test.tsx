import { startStubServer, type StubServer } from '../test-server'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AdminToolsPage } from './AdminToolsPage'
import { AuthProvider } from '../contexts/AuthContext'
import { EventsProvider } from '../contexts/EventsContext'
import { resolvePreview } from '../components/InstallPreview'
import type { AdminSurgePack, AdminTool } from '../lib/api'

/**
 * The tools admin page, against a real HTTP server.
 *
 * The headline assertion is the one the milestone asked for: a script edited in the browser
 * reaches the server byte for byte and comes back byte for byte. `CodeEditor.test.tsx` proves
 * the editor does not mangle content; this proves the whole save-and-reload path does not
 * either — the PUT body is captured and compared against the original bytes.
 */


const tool = (over: Partial<AdminTool> & { toolId: string }): AdminTool => ({
  name: over.toolId,
  description: 'a tool',
  alwaysInstall: false,
  category: 'base',
  url: 'https://example.com',
  installScript: 'echo hi\n',
  enabled: true,
  installOrder: 30,
  bootstrap: false,
  runAs: 'root',
  ...over,
})

const TRICKY_SCRIPT = 'set -euo pipefail\nif [ -f x ]; then\n\techo "  café ✓ $HOME  "\nfi\n\n'

const TOOLS: AdminTool[] = [
  tool({ toolId: 'claude-code', installOrder: 40, runAs: 'rocky', sourceFile: 'ai-coding-agents.yaml' }),
  tool({ toolId: 'curl', installOrder: 10, sourceFile: 'ai-coding-agents.yaml' }),
  tool({ toolId: 'git', installOrder: 10, sourceFile: 'ai-coding-agents.yaml' }),
  tool({ toolId: 'hand-rolled', installOrder: 30, installScript: TRICKY_SCRIPT }),
  tool({ toolId: 'switched-off', installOrder: 20, enabled: false }),
  tool({ toolId: 'always-on', installOrder: 50, alwaysInstall: true }),
  // A personal tool fetched from a URL (issue #299): sourceFile null, provenance in `registry`.
  tool({
    toolId: 'from-url',
    installOrder: 60,
    registry: {
      source: 'a URL import',
      url: 'https://tools.example.com/from-url.yaml',
      sha256: 'deadbeef',
      trust: 'unverified',
      installedAt: '2026-09-02T00:00:00.000Z',
    },
  }),
]

const PACKS: AdminSurgePack[] = [
  {
    packId: 'ai-coding-agents',
    name: 'Claude Code',
    tools: ['curl', 'git', 'claude-code', 'switched-off', 'ghost'],
    displayOrder: 1,
    enabled: true,
    requiresRepos: true,
    requiresRdp: false,
    // File-backed, so it can only be forked — the boot sync rewrites it from disk (issue #295).
    sourceFile: 'ai-coding-agents.yaml',
    imageUrl: '/images/surge-packs/claude-code.png',
  },
  {
    packId: 'mine',
    name: 'Mine',
    tools: ['git'],
    displayOrder: 2,
    enabled: true,
    requiresRepos: false,
    requiresRdp: false,
  },
]

let stub: StubServer
/** Bodies the page PUT or POSTed, so the test can inspect exactly what left the browser. */
let writes: Array<{ method: string; path: string; body: string }> = []

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <EventsProvider>
          <AdminToolsPage />
        </EventsProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

beforeEach(async () => {
  writes = []
  stub = await startStubServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      if (req.method !== 'GET') writes.push({ method: req.method ?? '', path: url.pathname, body })

      if (url.pathname === '/api/v1/auth/me') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ user: { id: 'u1', username: 'admin', isAdmin: true } }))
        return
      }
      if (url.pathname === '/api/v1/admin/tools' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(TOOLS))
        return
      }
      if (url.pathname === '/api/v1/admin/surge-packs' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(PACKS))
        return
      }
      if (url.pathname === '/api/v1/admin/tools/import' && req.method === 'POST') {
        // Import returns the list of rows it wrote (issue #299) — both the file and URL arms.
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify([TOOLS[3]]))
        return
      }
      if (url.pathname.startsWith('/api/v1/admin/tools/')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(TOOLS[3]))
        return
      }
      if (url.pathname === '/api/v1/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('event: connected\ndata: {}\n\n')
        return
      }
      res.writeHead(404).end()
    })
  })
})

afterEach(async () => {
  await stub.close()
})

describe('the tools table', () => {
  /**
   * Two tables since issue #289 — Personal first, then Official — so the ordering assertion is
   * per section. Install order still governs WITHIN a section; the split is about provenance,
   * which is the one thing that decides whether the next boot rewrites the row.
   */
  const idsIn = (table: HTMLElement) =>
    within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getByText(/^[a-z-]+$/, { selector: 'code' }).textContent)

  it('lists tools in the order they install, within each section', async () => {
    renderPage()
    const [personal, official] = await screen.findAllByRole('table')
    // Personal: switched-off(20), hand-rolled(30), always-on(50), from-url(60).
    expect(idsIn(personal!)).toEqual(['switched-off', 'hand-rolled', 'always-on', 'from-url'])
    // Official: curl(10) git(10) claude-code(40).
    expect(idsIn(official!)).toEqual(['curl', 'git', 'claude-code'])
  })

  it('separates tools registered here from tools loaded out of pack files', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Personal' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Official' })).toBeDefined()
  })

  it('badges file-backed tools with their source file, and database rows as such', async () => {
    renderPage()
    // Same wording as the packs page, so "file-backed" reads identically on both surfaces.
    expect(await screen.findByTestId('file-backed-claude-code')).toBeDefined()
    // The filename is a <code> inside the cell now (#222), so the cell's own text nodes read
    // "file: " on their own — assert on the cell rather than on a text match.
    const sources = (await screen.findAllByTestId(/^file-backed-/)).map((el) => el.textContent)
    expect(sources).toEqual(Array(3).fill('file: ai-coding-agents.yaml'))
    // `hand-rolled`, `switched-off` and `always-on` are plain database rows; `from-url` also
    // has no sourceFile but shows its URL origin instead, so it is not counted here.
    expect(await screen.findAllByText('database')).toHaveLength(3)
  })

  it('shows where a URL-imported tool came from, in full (issue #299)', async () => {
    renderPage()
    const cell = await screen.findByTestId('url-import-from-url')
    expect(cell.textContent).toContain('imported from')
    expect(cell.textContent).toContain('https://tools.example.com/from-url.yaml')
  })

  it('marks a disabled tool', async () => {
    renderPage()
    expect(await screen.findByText('disabled')).toBeDefined()
  })
})

describe('the install preview', () => {
  it('resolves the documented order and flags the ties', () => {
    // Pinned here rather than only through the DOM: this is the one place the ordering rule
    // is duplicated outside core, so it is asserted directly against the rule.
    const steps = resolvePreview(PACKS[0]!, TOOLS)
    expect(steps.map((s) => s.tool.toolId)).toEqual(['curl', 'git', 'claude-code'])
    // curl and git share installOrder 10, so their order came from the toolId tie-break.
    expect(steps.filter((s) => s.tied).map((s) => s.tool.toolId)).toEqual(['curl', 'git'])
  })

  it('renders the preview and names tools the pack references but that do not exist', async () => {
    renderPage()
    const preview = await screen.findByTestId('install-preview')
    expect(within(preview).getByText('claude-code')).toBeDefined()
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('ghost'))
  })
})

describe('editing a script', () => {
  it('sends the script back byte for byte, whitespace and unicode intact', async () => {
    renderPage()

    // Open the locally-created tool, whose script has tabs, unicode, a trailing blank line
    // and internal padding that a careless save would normalise.
    const row = (await screen.findByText('hand-rolled', { selector: 'code' })).closest('tr')!
    within(row).getByRole('button', { name: 'Edit' }).click()

    const editor = await screen.findByRole('textbox', { name: 'Install script' })
    expect(editor).toBeDefined()

    // Save without touching anything: an unchanged round trip must still be byte-identical.
    ;(await screen.findByRole('button', { name: /^save$/i })).click()

    await waitFor(() => expect(writes.length).toBeGreaterThan(0))
    const put = writes.find((w) => w.method === 'PUT')
    expect(put, 'no PUT reached the server').toBeDefined()

    const sent = JSON.parse(put!.body) as { installScript: string }
    // The assertion this whole page exists to keep honest.
    expect(sent.installScript).toBe(TRICKY_SCRIPT)
  })

  it('does not offer to edit a file-backed tool, and says why', async () => {
    // Matches the packs half: the boot sync rewrites these rows from disk, so an edit offered
    // here would vanish on the next restart. Read-only with the file named beats an editor
    // that discards what someone typed.
    renderPage()
    const tables = await screen.findAllByRole('table')
    const row = within(tables[1]!).getByText('claude-code', { selector: 'code' }).closest('tr')!

    expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(within(row).queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(screen.getByTestId('readonly-hint-claude-code').textContent).toContain(
      'edit ai-coding-agents.yaml and restart',
    )
    expect(screen.getByTestId('file-backed-claude-code').textContent).toContain('ai-coding-agents.yaml')
  })

  it('still edits a row created in the database', async () => {
    renderPage()
    const tables = await screen.findAllByRole('table')
    const row = within(tables[0]!).getByText('hand-rolled', { selector: 'code' }).closest('tr')!
    expect(within(row).getByRole('button', { name: 'Edit' })).toBeDefined()
    expect(within(row).getByText('database')).toBeDefined()
  })

  /**
   * Sharing one tool (issue #289). Export is on EVERY row — a shipped tool is exactly what an
   * operator wants to send to somebody not running this installation — while Edit and Delete
   * stay off the file-backed ones, because those the next boot rewrites.
   */
  it('offers Export on personal and file-backed rows alike', async () => {
    renderPage()
    expect(await screen.findByTestId('export-hand-rolled')).toBeDefined()
    expect(screen.getByTestId('export-claude-code')).toBeDefined()
  })

  it('offers an import control that takes a file and one that takes a URL (issue #299)', async () => {
    renderPage()
    expect(await screen.findByLabelText('Import a tool file')).toBeDefined()
    // The URL arm exists now that the tools table records provenance (ADR-0018, issue #299).
    expect(screen.getByLabelText('Tool file URL')).toBeDefined()
  })

  it('imports from a URL by sending the address to core, which does the guarded fetch', async () => {
    renderPage()
    const box = await screen.findByLabelText('Tool file URL')
    fireEvent.change(box, { target: { value: 'https://tools.example.com/acme.yaml' } })
    fireEvent.click(screen.getByRole('button', { name: 'Import from URL' }))

    await waitFor(() => expect(writes.some((w) => w.path === '/api/v1/admin/tools/import')).toBe(true))
    const post = writes.find((w) => w.path === '/api/v1/admin/tools/import')!
    expect(post.method).toBe('POST')
    // Only the address crosses — the browser never fetches the URL itself.
    expect(JSON.parse(post.body)).toEqual({ url: 'https://tools.example.com/acme.yaml' })
  })

  /**
   * Getting a registered tool onto a box (issue #295).
   *
   * A tool reaches a box only through a pack, so registering one deploys nothing — this is the
   * step that closes that gap, and it is offered on every row for the same reason Export is:
   * where a tool installs is not part of its file.
   */
  describe('Add to a pack…', () => {
    it('is offered on personal and file-backed rows alike', async () => {
      renderPage()
      expect(await screen.findByTestId('add-to-pack-hand-rolled')).toBeDefined()
      expect(screen.getByTestId('add-to-pack-claude-code')).toBeDefined()
    })

    it('says a file-backed tool is read-only about its DEFINITION, not about where it installs', async () => {
      renderPage()
      const hint = await screen.findByTestId('readonly-hint-claude-code')
      expect(hint.textContent).toContain('definition is read-only')
      expect(hint.textContent).toContain('Where it installs is still yours to set')
    })

    it('adds the tool to a pack of your own in one call', async () => {
      renderPage()
      fireEvent.click(await screen.findByTestId('add-to-pack-hand-rolled'))
      // `mine` is the only pack without a sourceFile, so it is the only editable one.
      fireEvent.click(await screen.findByTestId('add-to-mine'))

      await waitFor(() => expect(writes.some((w) => w.method === 'PUT')).toBe(true))
      const put = writes.find((w) => w.method === 'PUT')!
      expect(put.path).toBe('/api/v1/admin/surge-packs/mine')
      expect(JSON.parse(put.body).tools).toContain('hand-rolled')
    })

    /**
     * An official pack is not edited — it is forked, recording where the fork came from. That
     * record is what puts the delta on the official pack's own card afterwards.
     */
    it('forks an official pack rather than editing it, recording the parent', async () => {
      renderPage()
      fireEvent.click(await screen.findByTestId('add-to-pack-hand-rolled'))
      fireEvent.click(await screen.findByTestId('fork-ai-coding-agents'))

      await waitFor(() => expect(writes.some((w) => w.method === 'POST')).toBe(true))
      const post = writes.find((w) => w.method === 'POST')!
      expect(post.path).toBe('/api/v1/admin/surge-packs')
      const body = JSON.parse(post.body)
      expect(body.derivedFromPackId).toBe('ai-coding-agents')
      expect(body.tools).toContain('hand-rolled')
      // The fork wears its parent's face, which is how it is recognisable on the Personal tab.
      expect(body.imageUrl).toBe('/images/surge-packs/claude-code.png')
      // Nothing was written to the official pack itself.
      expect(writes.some((w) => w.path === '/api/v1/admin/surge-packs/ai-coding-agents')).toBe(false)
    })

    /**
     * "Add to all packs" is one flag, not a loop that forks all ten official packs — and
     * because its blast radius is every server created from now on, it asks first.
     */
    it('confirms before setting a tool to install on every box', async () => {
      renderPage()
      fireEvent.click(await screen.findByTestId('add-to-pack-hand-rolled'))
      fireEvent.click(await screen.findByTestId('always-install-on-start'))

      const warning = await screen.findByTestId('always-install-confirm')
      expect(warning.textContent).toContain('terminates the box')
      expect(writes.some((w) => w.method === 'PUT')).toBe(false)

      fireEvent.click(screen.getByTestId('always-install-yes'))
      await waitFor(() => expect(writes.some((w) => w.method === 'PUT')).toBe(true))
      const put = writes.find((w) => w.method === 'PUT')!
      expect(put.path).toBe('/api/v1/admin/tools/hand-rolled')
      expect(JSON.parse(put.body).alwaysInstall).toBe(true)
    })
  })

  /**
   * The delete guard core enforces scans `packs.tools`, and an always-install tool is on every
   * box precisely WITHOUT any pack listing it — so core's 409 never fires and this warning is
   * the only thing between the operator and quietly ending an install they set up.
   */
  it('warns that deleting an always-install tool stops it reaching new boxes', async () => {
    renderPage()
    const row = (await screen.findByText('always-on', { selector: 'code' })).closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }))
    expect((await screen.findByRole('dialog')).textContent).toContain('installed on every box you create')
  })

  it('badges a tool that installs on every box', async () => {
    renderPage()
    expect(await screen.findByTestId('always-install-badge-always-on')).toBeDefined()
  })

  /**
   * The disclosure has to carry the blast radius, not just the behaviour. An always-install
   * tool runs on every box regardless of pack, so it cannot lean on anything a pack might not
   * have — and under ADR-0010 a failed tool install terminates the machine, which turns one
   * mis-ordered tool here into every new server failing.
   */
  it('discloses what "install on every box" costs, in the tool form', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'New tool' }))
    const form = await screen.findByRole('dialog')

    expect(within(form).getByTestId('tool-always-install')).toBeDefined()
    expect(form.textContent).toContain('Install on every box you create from now on')
    // Snapshotted plans: a running box does not change under it.
    expect(form.textContent).toContain('servers already running keep the plan they were built with')
    expect(form.textContent).toContain('a failed tool install terminates the machine')
  })
})
