import { startStubServer, type StubServer } from '../test-server'
import { render, screen, waitFor, within } from '@testing-library/react'
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
  it('lists tools in the order they install, not the order the API returned them', async () => {
    renderPage()
    const rows = await screen.findAllByRole('row')
    // Header first, then curl(10) git(10) switched-off(20) hand-rolled(30) claude-code(40).
    const ids = rows.slice(1).map((row) => within(row).getByText(/^[a-z-]+$/, { selector: 'code' }).textContent)
    expect(ids).toEqual(['curl', 'git', 'switched-off', 'hand-rolled', 'claude-code'])
  })

  it('badges file-backed tools with their source file, and database rows as such', async () => {
    renderPage()
    // Same wording as the packs page, so "file-backed" reads identically on both surfaces.
    expect(await screen.findByTestId('file-backed-claude-code')).toBeDefined()
    expect((await screen.findAllByText(/^file: ai-coding-agents\.yaml$/)).length).toBe(3)
    // `hand-rolled` and `switched-off` have no sourceFile.
    expect(await screen.findAllByText('database')).toHaveLength(2)
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
    const table = await screen.findByRole('table')
    const row = within(table).getByText('claude-code', { selector: 'code' }).closest('tr')!

    expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(within(row).queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(screen.getByTestId('readonly-hint-claude-code').textContent).toContain(
      'edit ai-coding-agents.yaml and restart',
    )
    expect(screen.getByTestId('file-backed-claude-code').textContent).toContain('ai-coding-agents.yaml')
  })

  it('still edits a row created in the database', async () => {
    renderPage()
    const table = await screen.findByRole('table')
    const row = within(table).getByText('hand-rolled', { selector: 'code' }).closest('tr')!
    expect(within(row).getByRole('button', { name: 'Edit' })).toBeDefined()
    expect(within(row).getByText('database')).toBeDefined()
  })
})
