import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthProvider } from '../contexts/AuthContext'
import { EventsProvider } from '../contexts/EventsContext'
import { setAuthToken, type SettingsField, type SettingsSection, type SettingsView } from '../lib/api'
import { SettingsPage } from './SettingsPage'

/**
 * The settings editor, against a real server (rockysurf-m29b).
 *
 * WHAT THIS FILE IS FOR. The claims worth testing here are all about what crosses the wire:
 * that a blank secret box sends NOTHING, that clearing one sends an explicit `unset`, that a
 * `${VAR}` the operator did not touch is not resent as its expansion, and that a 409 or a
 * field-level rejection lands where an operator will see it. None of that is visible to a test
 * that stubs `lib/api` — the request body is exactly the thing being asserted — so this runs a
 * real HTTP server, captures the PUT bodies, and drives the page through the DOM.
 *
 * The core half of the contract (redaction, comment preservation, the mtime guard, the schema
 * as validator) is tested where it lives, in `packages/core/src/settings/settings.test.ts`.
 */

const USER = { id: 'u1', username: 'admin', email: null, avatarUrl: null, isAdmin: true }
/** Matches `environmentOptions.jsdom.url` in vitest.config.ts — see the note there. */
const STUB_PORT = 34567

/** A token nobody should be able to make this page display, or resend. */
const LITERAL_TOKEN = 'hcloud-LITERALtokenSHOULDneverLEAK'

/**
 * The inventory, as core serves it — with SYNTHETIC help text.
 *
 * The words themselves are core's business and are checked there (`fields.test.ts` requires a
 * sentence for every field, and `FieldSpec.help` is required by the type so one cannot be
 * omitted at all). What this file checks is the plumbing: that every control the page draws
 * carries whatever help it was handed. Deriving it from the path keeps that assertion honest
 * without pinning prose in two places.
 */
const FIELDS: SettingsField[] = (
  [
    { path: 'server.port', kind: 'number', writable: true, warning: 'Changing the port takes effect at the next restart.' },
    { path: 'server.host', kind: 'string', writable: true, warning: 'Loopback is the default because this process holds your credentials.' },
    // Missing from this stub until rockysurf-5qzg, and it was the help-text sweep that found it:
    // the page had been drawing a control the inventory said nothing about.
    { path: 'server.publicUrl', kind: 'string', writable: true },
    {
      path: 'server.dataDir',
      kind: 'string',
      writable: false,
      reason: 'The database and the encrypted secrets store are open from this directory right now.',
    },
    {
      path: 'auth.mode',
      kind: 'string',
      writable: false,
      hidden: true,
      reason: 'local is the only mode implemented in v0.1.',
    },
    { path: 'github.pat', kind: 'secret', writable: true },
    { path: 'github.tokens.*.owner', kind: 'string', writable: true },
    { path: 'github.tokens.*.repo', kind: 'string', writable: true },
    { path: 'github.tokens.*.host', kind: 'string', writable: true },
    { path: 'github.tokens.*.pat', kind: 'secret', writable: true },
    { path: 'providers.hetzner.enabled', kind: 'boolean', writable: true },
    { path: 'providers.hetzner.token', kind: 'secret', writable: true },
    { path: 'providers.hetzner.location', kind: 'string', writable: true },
    { path: 'providers.hetzner.consoleProjectId', kind: 'number', writable: true },
    { path: 'providers.aws.enabled', kind: 'boolean', writable: true },
    { path: 'providers.aws.region', kind: 'string', writable: true },
    { path: 'providers.aws.profile', kind: 'string', writable: true },
    { path: 'providers.aws.sshAllowedCidr', kind: 'string', writable: true },
    { path: 'providers.aws.sizes', kind: 'stringList', writable: false, reason: 'An allowlist of instance types, edited in the file.' },
    { path: 'providers.azure.enabled', kind: 'boolean', writable: true },
    { path: 'providers.azure.subscriptionId', kind: 'string', writable: true },
    { path: 'providers.azure.resourceGroup', kind: 'string', writable: true },
    { path: 'providers.azure.location', kind: 'string', writable: true },
    { path: 'providers.azure.sshAllowedCidr', kind: 'string', writable: true },
    { path: 'providers.azure.sizes', kind: 'stringList', writable: false, reason: 'An allowlist of VM sizes, edited in the file.' },
    { path: 'providers.gcp.enabled', kind: 'boolean', writable: true },
    { path: 'providers.gcp.projectId', kind: 'string', writable: true },
    { path: 'providers.gcp.zone', kind: 'string', writable: true },
    { path: 'providers.gcp.sshAllowedCidr', kind: 'string', writable: true },
    { path: 'providers.gcp.sizes', kind: 'stringList', writable: false, reason: 'An allowlist of machine types, edited in the file.' },
    { path: 'providers.byo.enabled', kind: 'boolean', writable: true },
    { path: 'providers.byo.identityFile', kind: 'string', writable: true },
    { path: 'providers.byo.hosts.*.name', kind: 'string', writable: true },
    { path: 'providers.byo.hosts.*.host', kind: 'string', writable: true },
    { path: 'providers.byo.hosts.*.user', kind: 'string', writable: true },
    { path: 'providers.byo.hosts.*.port', kind: 'number', writable: true },
    { path: 'providers.byo.hosts.*.fingerprint', kind: 'string', writable: true },
    { path: 'providers.byo.hosts.*.identityFile', kind: 'string', writable: true },
    { path: 'limits.maxServers', kind: 'number', writable: true },
    { path: 'limits.createRatePerHour', kind: 'number', writable: true },
    { path: 'limits.spendCap', kind: 'group', writable: true },
    { path: 'limits.spendCap.amount', kind: 'number', writable: true },
    { path: 'limits.spendCap.currency', kind: 'string', writable: true },
    { path: 'mcp.scopes', kind: 'stringList', writable: true, warning: 'create spends money and terminate destroys a box.' },
  ] satisfies Omit<SettingsField, 'help'>[]
).map((field) => ({ ...field, help: `What ${field.path} is for.` }))

const SECTIONS: SettingsSection[] = [
  { id: 'server', title: 'Server', help: 'Where Rocky Surf itself listens.' },
  { id: 'github', title: 'GitHub access tokens', help: 'Tokens for cloning private repositories.' },
  { id: 'providers.hetzner', title: 'Hetzner', help: 'Servers at Hetzner.' },
  { id: 'providers.aws', title: 'AWS', help: 'EC2 instances in one region.' },
  { id: 'providers.azure', title: 'Azure', help: 'Virtual machines in one Azure region.' },
  { id: 'providers.gcp', title: 'Google Cloud', help: 'Compute Engine instances in one zone.' },
  { id: 'providers.byo', title: 'Your own machines', help: 'Machines you already have.' },
  { id: 'providers.byo.hosts', title: 'Hosts', help: 'The machines Rocky Surf may claim.' },
  { id: 'limits', title: 'Limits', help: 'Guardrails, enforced server-side.' },
  { id: 'mcp', title: 'MCP', help: 'What an MCP client may do.' },
]

/** The redacted view, as core serves it: no literal anywhere, references intact. */
const VIEW: SettingsView = {
  file: { path: '/srv/rockysurf.config.yaml', exists: true, mtimeMs: 1_700_000_000_000 },
  values: {
    server: { port: 3000, dataDir: '/home/rocky/.rockysurf' },
    auth: { mode: 'local' },
    github: {
      pat: { secret: true, state: 'reference', reference: '${GITHUB_PAT}' },
      tokens: [{ owner: 'acme', repo: 'widgets', pat: { secret: true, state: 'reference', reference: '${ACME_PAT}' } }],
    },
    providers: {
      hetzner: { enabled: true, token: { secret: true, state: 'set' }, location: 'fsn1' },
      aws: { enabled: false, sizes: ['t4g.small', 't4g.medium'] },
      byo: { enabled: false, hosts: [{ name: 'workshop', host: '10.0.0.9' }] },
    },
    limits: { maxServers: 5 },
    mcp: { scopes: ['read', 'stop'] },
  },
  defaults: {
    server: { port: 3000, host: '127.0.0.1', dataDir: '/home/rocky/.rockysurf' },
    auth: { mode: 'local' },
    github: { tokens: [] },
    providers: { hetzner: { enabled: false, location: 'fsn1' }, aws: { enabled: false, region: 'us-east-1' }, byo: { enabled: false, hosts: [] } },
    limits: { maxServers: 5, createRatePerHour: 4 },
    mcp: { scopes: ['read', 'stop'] },
  },
  fields: FIELDS,
  sections: SECTIONS,
  lists: [
    { path: 'github.tokens', itemFields: ['host', 'owner', 'repo', 'pat'] },
    { path: 'providers.byo.hosts', itemFields: ['name', 'host', 'user', 'port', 'fingerprint', 'identityFile'] },
  ],
  drifted: false,
  restartHint: 'Changes apply after a restart: stop the process with Ctrl-C and run ./start.sh again.',
}

let server: HttpServer
/** Every PUT body the page sent, in order. */
let saves: { mtimeMs: number | null; changes: { path: (string | number)[]; value?: unknown; unset?: true }[] }[]
/** What the next PUT answers with. `null` means "accept it and echo the view back". */
let nextSaveFailure: { status: number; body: unknown } | null
/** What the next GET answers with, when the read itself is meant to fail. */
let getFailure: { status: number; body: unknown } | null
let served: SettingsView

beforeEach(async () => {
  saves = []
  nextSaveFailure = null
  getFailure = null
  served = structuredClone(VIEW)
  setAuthToken('test-token')

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (url.pathname === '/api/v1/auth/me') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ user: USER }))
      return
    }

    if (url.pathname === '/api/v1/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(`event: connected\ndata: ${JSON.stringify({ userId: USER.id })}\n\n`)
      return
    }

    if (url.pathname === '/api/v1/settings' && req.method === 'GET') {
      if (getFailure) {
        res.writeHead(getFailure.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(getFailure.body))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(served))
      return
    }

    if (url.pathname === '/api/v1/settings' && req.method === 'PUT') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        saves.push(JSON.parse(body))
        if (nextSaveFailure) {
          res.writeHead(nextSaveFailure.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(nextSaveFailure.body))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ saved: true, ...served, drifted: true }))
      })
      return
    }

    res.writeHead(404).end()
  })

  await new Promise<void>((resolve) => server.listen(STUB_PORT, '127.0.0.1', resolve))
  expect((server.address() as AddressInfo).port).toBe(STUB_PORT)
})

afterEach(async () => {
  setAuthToken(null)
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
})

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <EventsProvider>
          <SettingsPage />
        </EventsProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

/** Wait for the file's path to appear, which is the page having loaded the config. */
async function loaded(): Promise<void> {
  await waitFor(() => expect(screen.getByText(VIEW.file.path)).toBeTruthy())
}

/** The control for a dotted field path. */
const control = (path: string) => document.getElementById(path) as HTMLInputElement

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save to the file' }))

/** One card of the unified token list: `'fallback'`, an index, or `'new'` for the draft. */
const tokenCard = (id: string) => document.querySelector(`[data-token="${id}"]`) as HTMLElement

/** Click a button inside one token card, where several cards offer the same label. */
const clickIn = (id: string, name: string) =>
  fireEvent.click(within(tokenCard(id)).getByRole('button', { name }))

/** The one save this page made, once it has made it. */
async function onlySave(): Promise<(typeof saves)[number]> {
  await waitFor(() => expect(saves).toHaveLength(1))
  return saves[0]!
}

/* --------------------------------------------------------------------------- the read */

describe('what the page shows', () => {
  it('shows a ${VAR} reference as the reference, and never a literal', async () => {
    renderPage()
    await loaded()

    // The file holds `${GITHUB_PAT}`; the box holds the variable's name. The braces belong to the
    // file format (rockysurf-4o3o).
    expect(control('github.pat').value).toBe('GITHUB_PAT')
    expect(control('github.tokens.0.pat').value).toBe('ACME_PAT')
    // The stored literal is a state, not a value: the box is empty and says so.
    expect(control('providers.hetzner.token').value).toBe('')
    expect(document.body.textContent).not.toContain(LITERAL_TOKEN)
    expect(document.body.textContent).toContain('A literal token is stored in the configuration file')
  })

  it('renders a read-only field with the reason it is read-only', async () => {
    renderPage()
    await loaded()

    expect(control('server.dataDir')).toBeNull()
    expect(screen.getByText('/home/rocky/.rockysurf')).toBeTruthy()
    expect(document.body.textContent).toContain('open from this directory right now')
    // `providers.aws.sizes` is the other one: a working setting, whose value is worth reading and
    // whose reason names where the edit happens.
    expect(screen.getByText('t4g.small, t4g.medium')).toBeTruthy()
  })

  it('shows the server\'s warning next to the field it is about', async () => {
    renderPage()
    await loaded()

    const field = document.querySelector('[data-field="server.host"]')!
    expect(field.textContent).toContain('Loopback is the default')
  })

  it('offers a default as a placeholder rather than pre-filling it as a value', async () => {
    renderPage()
    await loaded()

    // `server.host` is absent from the file; the page must not send 127.0.0.1 as if it were set.
    expect(control('server.host').value).toBe('')
    expect(control('server.host').placeholder).toBe('default: 127.0.0.1')
  })
})

/* ----------------------------------------------------- directive 1: what is not drawn */

describe('a setting that does not exist yet is not drawn at all', () => {
  it('leaves out the hidden field, box and refusal together', async () => {
    renderPage()
    await loaded()

    // The old page rendered `auth.mode` and then a note saying the only other mode is not
    // implemented. A box you may not use is not honesty; the whole pair is gone.
    expect(document.querySelector('[data-field="auth.mode"]')).toBeNull()
    expect(document.body.textContent).not.toContain('local is the only mode implemented')
    expect(document.body.textContent).not.toContain('Sign-in mode')
  })

  it('takes the inventory\'s word for it, whichever field is marked', async () => {
    // The flag does the work, not a special case for `auth.mode`: marking a field the page
    // otherwise draws makes it disappear too.
    served = {
      ...structuredClone(VIEW),
      fields: FIELDS.map((f) => (f.path === 'providers.aws.sizes' ? { ...f, hidden: true as const } : f)),
    }
    renderPage()
    await loaded()

    expect(document.querySelector('[data-field="providers.aws.sizes"]')).toBeNull()
    expect(document.body.textContent).not.toContain('t4g.small')
    // And its neighbours in the same section are untouched.
    expect(control('providers.aws.region')).toBeTruthy()
  })
})

/* ------------------------------------------ directive 2: one list of GitHub access tokens */

describe('the unified token list', () => {
  it('shows both shapes in the file as entries of one list', async () => {
    renderPage()
    await loaded()

    // The instance-wide token is an entry, identified by the scope it does not have.
    expect(tokenCard('fallback').textContent).toContain('All repositories (fallback)')
    expect(control('github.pat').value).toBe('GITHUB_PAT')
    // And a scoped entry is an entry of the same list, named the way an operator names a repo.
    expect(tokenCard('0').textContent).toContain('acme/widgets')
    expect(control('github.tokens.0.repo').value).toBe('acme/widgets')
    expect(control('github.tokens.0.pat').value).toBe('ACME_PAT')
    // There is no second section for per-repository tokens any more.
    expect(document.body.textContent).not.toContain('Per-repository tokens')
  })

  it('states whether each entry holds a token, without ever showing one', async () => {
    served = structuredClone(VIEW)
    served.values.github = {
      pat: { secret: true, state: 'set' },
      tokens: [{ owner: 'acme', pat: { secret: true, state: 'unset' } }],
    }
    renderPage()
    await loaded()

    expect(tokenCard('fallback').textContent).toContain('A literal token is stored in the configuration file')
    expect(tokenCard('0').textContent).toContain('Not set in the configuration file')
    expect(tokenCard('0').textContent).toContain('acme')
    expect(document.body.textContent).not.toContain(LITERAL_TOKEN)
  })

  it('saves one entry at a time, so an index cannot move under a pending edit', async () => {
    renderPage()
    await loaded()

    fireEvent.change(control('server.port'), { target: { value: '8080' } })
    fireEvent.change(control('github.tokens.0.pat'), { target: { value: 'NEW_ACME_PAT' } })

    // The page-wide Save carries the port and nothing from the list.
    save()
    expect((await onlySave()).changes).toEqual([{ path: ['server', 'port'], value: 8080 }])

    // And the token edit survived that save rather than being swept up by it.
    expect(control('github.tokens.0.pat').value).toBe('NEW_ACME_PAT')
    clickIn('0', 'Save this token')
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1]!.changes).toEqual([
      { path: ['github', 'tokens', 0, 'pat'], value: '${NEW_ACME_PAT}' },
    ])
  })

  it('writes a retyped instance-wide token to github.pat, not to the list', async () => {
    renderPage()
    await loaded()

    fireEvent.change(control('github.pat'), { target: { value: 'OTHER_PAT' } })
    clickIn('fallback', 'Save this token')

    expect((await onlySave()).changes).toEqual([{ path: ['github', 'pat'], value: '${OTHER_PAT}' }])
  })

  it('rewrites a scope as one change set, never leaving two spellings of the owner', async () => {
    renderPage()
    await loaded()

    fireEvent.change(control('github.tokens.0.repo'), { target: { value: 'acme' } })
    clickIn('0', 'Save this token')

    // `owner: acme` with the old `repo: widgets` still there would be a different entry, and
    // `acme/widgets` alongside `owner:` is refused by the schema. Both keys move together.
    expect((await onlySave()).changes).toEqual([
      { path: ['github', 'tokens', 0, 'owner'], value: 'acme' },
      { path: ['github', 'tokens', 0, 'repo'], unset: true },
    ])
  })

  it('adds a scoped entry as a whole entry, after it has been filled in', async () => {
    renderPage()
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Add a token' }))
    // Nothing is written by pressing Add: the entry is drafted first.
    expect(saves).toHaveLength(0)

    fireEvent.change(control('github.tokens.new.repo'), { target: { value: 'acme/other' } })
    fireEvent.change(control('github.tokens.new.pat'), { target: { value: 'OTHER_PAT' } })
    clickIn('new', 'Add this token')

    expect((await onlySave()).changes).toEqual([
      { path: ['github', 'tokens', 1], value: { repo: 'acme/other', pat: '${OTHER_PAT}' } },
    ])
  })

  it('adds an entry with no scope to github.pat, which is what an unscoped entry means', async () => {
    served = structuredClone(VIEW)
    served.values.github = { tokens: [] }
    renderPage()
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Add a token' }))
    fireEvent.change(control('github.tokens.new.pat'), { target: { value: 'FALLBACK_PAT' } })
    clickIn('new', 'Add this token')

    expect((await onlySave()).changes).toEqual([{ path: ['github', 'pat'], value: '${FALLBACK_PAT}' }])
  })

  it('refuses a second unscoped entry in a sentence, rather than as a schema error', async () => {
    renderPage()
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Add a token' }))
    fireEvent.change(control('github.tokens.new.pat'), { target: { value: 'SECOND_PAT' } })
    clickIn('new', 'Add this token')

    // There is one `github.pat` key, so a second entry with no scope has nowhere to go. The page
    // says so; nothing is sent, and what was typed stays in the box.
    expect(tokenCard('new').textContent).toContain('already a token with no scope')
    expect(saves).toHaveLength(0)
    expect(control('github.tokens.new.pat').value).toBe('SECOND_PAT')
  })

  it('refuses an entry with no token at all', async () => {
    renderPage()
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Add a token' }))
    fireEvent.change(control('github.tokens.new.repo'), { target: { value: 'acme/other' } })
    clickIn('new', 'Add this token')

    expect(tokenCard('new').textContent).toContain('A token is required')
    expect(saves).toHaveLength(0)
  })

  it('removes a scoped entry as a list entry, after a confirmation naming it', async () => {
    renderPage()
    await loaded()

    clickIn('0', 'Remove this entry')
    expect(screen.getByRole('dialog').textContent).toContain('acme/widgets')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }))

    expect((await onlySave()).changes).toEqual([{ path: ['github', 'tokens', 0], unset: true }])
  })

  it('removes the instance-wide entry by clearing github.pat, and says what that costs', async () => {
    renderPage()
    await loaded()

    clickIn('fallback', 'Remove this token')
    expect(screen.getByRole('dialog').textContent).toContain('fine for public repositories')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }))

    expect((await onlySave()).changes).toEqual([{ path: ['github', 'pat'], unset: true }])
  })

  it('will not add or remove while this list has an unsaved edit, and does not care about the rest', async () => {
    renderPage()
    await loaded()

    // THE HAZARD m29b GUARDED: removing entry 1 renumbers entry 2, so a pending edit naming an
    // index would land on whichever entry moved into it. Narrowed to the list it is about
    // instead of the whole page — an unsaved port cannot renumber anything.
    fireEvent.change(control('server.port'), { target: { value: '8080' } })
    expect(screen.getByRole('button', { name: 'Add a token' }).hasAttribute('disabled')).toBe(false)
    expect(within(tokenCard('0')).getByRole('button', { name: 'Remove this entry' }).hasAttribute('disabled')).toBe(
      false,
    )

    fireEvent.change(control('github.tokens.0.repo'), { target: { value: 'acme/other' } })
    const add = screen.getByRole('button', { name: 'Add a token' })
    expect(add.hasAttribute('disabled')).toBe(true)
    expect(add.getAttribute('title')).toContain('Save or discard')
    expect(within(tokenCard('0')).getByRole('button', { name: 'Remove this entry' }).hasAttribute('disabled')).toBe(
      true,
    )
    expect(saves).toHaveLength(0)
  })

  it('puts an error about a key the entry has no box for on the entry it belongs to', async () => {
    // `owner` is written by the scope box and has no control of its own, so the schema's
    // refinement — whose path is `owner` — would otherwise have nowhere to be shown.
    nextSaveFailure = {
      status: 400,
      body: {
        error: 'github.tokens.0.owner: repo requires owner',
        code: 'bad_request',
        issues: [{ path: 'github.tokens.0.owner', message: 'repo requires owner — a repository name alone matches nothing' }],
      },
    }

    renderPage()
    await loaded()
    fireEvent.change(control('github.tokens.0.repo'), { target: { value: 'widgets' } })
    clickIn('0', 'Save this token')

    await waitFor(() => expect(tokenCard('0').textContent).toContain('a repository name alone matches nothing'))
    expect(control('github.tokens.0.repo').value).toBe('widgets')
  })
})

/* ------------------------------------------ rockysurf-4o3o: token boxes name a variable */

/**
 * ENV-VAR-ONLY INPUT, and the 5qzg assertions it deliberately replaces.
 *
 * 5qzg tested that a credential box was `type=password` except while showing a `${VAR}` the file
 * already held. An owner directive has since decided the box is for a variable NAME and nothing
 * else, which makes the masking theatre over text that is not key material — so those assertions
 * are REPLACED here rather than dropped: the same boxes are checked, for the opposite property,
 * plus the refusal that is what now keeps a token out of the file.
 *
 * Every credential box on the page is covered, because the policy is one policy: the two shapes
 * of the token list and the Hetzner token.
 */
describe('a token box takes the name of an environment variable', () => {
  const CREDENTIAL_BOXES = ['github.pat', 'github.tokens.0.pat', 'providers.hetzner.token']

  it('is plain text, and stays plain text while a name is being typed', async () => {
    renderPage()
    await loaded()

    for (const path of CREDENTIAL_BOXES) {
      expect(control(path).type, `${path} should not be masked — its content is a variable name`).toBe('text')
    }
    fireEvent.change(control('github.pat'), { target: { value: 'WIDGETS_PAT' } })
    expect(control('github.pat').type).toBe('text')
  })

  it('says what it is a box for, in its label, wherever it appears', async () => {
    renderPage()
    await loaded()

    for (const path of CREDENTIAL_BOXES) {
      const label = document.querySelector(`label[for="${path}"]`)
      expect(label?.textContent, `${path} is not labelled as a variable`).toBe('Token Environment Variable')
    }
  })

  it('round-trips a reference: the file keeps its braces, the box does not', async () => {
    renderPage()
    await loaded()

    expect(control('github.pat').value).toBe('GITHUB_PAT')
    fireEvent.change(control('github.pat'), { target: { value: 'WIDGETS_PAT' } })
    clickIn('fallback', 'Save this token')

    expect((await onlySave()).changes).toEqual([{ path: ['github', 'pat'], value: '${WIDGETS_PAT}' }])
  })

  it('normalises the ${...} form, because copying the line out of the file is the obvious move', async () => {
    renderPage()
    await loaded()

    fireEvent.change(control('github.pat'), { target: { value: '${WIDGETS_PAT}' } })
    clickIn('fallback', 'Save this token')

    // Not `${${WIDGETS_PAT}}` — one normalisation, at one seam.
    expect((await onlySave()).changes).toEqual([{ path: ['github', 'pat'], value: '${WIDGETS_PAT}' }])
  })

  it('refuses anything that is not a variable name, with the policy and the reason', async () => {
    renderPage()
    await loaded()

    fireEvent.change(control('github.pat'), { target: { value: 'ghp-live-abcdef' } })

    // Live, rather than after the Save button: the point is not to let a whole token be typed.
    const refusal = document.querySelector('[data-refusal="github.pat"]')!
    expect(refusal.textContent).toContain('NAME of an environment variable')
    expect(refusal.textContent).toContain('holds only the reference')

    clickIn('fallback', 'Save this token')
    await waitFor(() => expect(document.body.textContent).toContain('Nothing was saved'))
    expect(saves).toHaveLength(0)
    // And what was typed is still there to be corrected rather than retyped.
    expect(control('github.pat').value).toBe('ghp-live-abcdef')
  })

  it('refuses a literal in the bulk form too, and sends none of the save it was part of', async () => {
    renderPage()
    await loaded()

    fireEvent.change(control('server.port'), { target: { value: '8080' } })
    fireEvent.change(control('providers.hetzner.token'), { target: { value: 'tok-live-abcdef' } })
    save()

    // Named, because the refused box may be off screen in a form this long.
    await waitFor(() =>
      expect(document.querySelector('.error')!.textContent).toContain(
        'Nothing was saved: providers.hetzner.token must name an environment variable',
      ),
    )
    // Nothing at all: a save that dropped the refused field and wrote the port would be a save
    // whose result the operator did not ask for.
    expect(saves).toHaveLength(0)
  })

  it('refuses one in a new entry before it can be added', async () => {
    renderPage()
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Add a token' }))
    fireEvent.change(control('github.tokens.new.repo'), { target: { value: 'acme/other' } })
    fireEvent.change(control('github.tokens.new.pat'), { target: { value: 'ghp-live-abcdef' } })
    expect(document.querySelector('[data-refusal="github.tokens.new.pat"]')).toBeTruthy()

    clickIn('new', 'Add this token')
    expect(tokenCard('new').textContent).toContain('NAME of an environment variable')

    // NOTHING WAS SENT, proved by sending something that IS allowed and finding it is the first
    // request to arrive. Asserting an empty array straight after the click would pass while a
    // PUT was still in flight, which is how this case was green against a page that wrote the
    // entry — a real hole, found by mutating the guard away.
    fireEvent.change(control('server.port'), { target: { value: '8080' } })
    save()
    expect((await onlySave()).changes).toEqual([{ path: ['server', 'port'], value: 8080 }])
  })

  /**
   * A new entry is ONE change carrying `{ repo, pat }`, so the credential in it is not at the
   * change's own path. This is the case that makes `asReferences` descend rather than look only
   * at the path it was handed.
   */
  it('normalises the credential inside a whole new entry, not just a change that is one', async () => {
    renderPage()
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Add a token' }))
    fireEvent.change(control('github.tokens.new.repo'), { target: { value: 'acme/other' } })
    fireEvent.change(control('github.tokens.new.pat'), { target: { value: 'OTHER_PAT' } })
    clickIn('new', 'Add this token')

    expect((await onlySave()).changes).toEqual([
      { path: ['github', 'tokens', 1], value: { repo: 'acme/other', pat: '${OTHER_PAT}' } },
    ])
  })

  /**
   * THE LITERAL ALREADY IN THE FILE. m29b's custody rule is untouched by any of this: the value
   * never leaves core, so the page has a state and not a value to show. What 4o3o adds is the way
   * out of it, said where an operator will read it.
   */
  it('shows a literal the file holds as a state, with the way out of it', async () => {
    renderPage()
    await loaded()

    const field = document.querySelector('[data-field="providers.hetzner.token"]')!
    expect(control('providers.hetzner.token').value).toBe('')
    expect(control('providers.hetzner.token').placeholder).toContain('name a variable to replace it')
    expect(field.textContent).toContain('A literal token is stored in the configuration file')
    expect(field.textContent).toContain('Move it into an environment variable')
    expect(document.body.textContent).not.toContain(LITERAL_TOKEN)
  })

  it('replaces a stored literal with the reference to the variable that was named', async () => {
    renderPage()
    await loaded()

    fireEvent.change(control('providers.hetzner.token'), { target: { value: 'HETZNER_TOKEN' } })
    save()

    expect((await onlySave()).changes).toEqual([
      { path: ['providers', 'hetzner', 'token'], value: '${HETZNER_TOKEN}' },
    ])
  })
})

/* --------------------------------------------------- directive 3: help on everything */

describe('every setting on the page says what it is for', () => {
  it('draws a help line for every control, from the inventory the server sent', async () => {
    renderPage()
    await loaded()

    const drawn = [...document.querySelectorAll('[data-field]')]
    expect(drawn.length).toBeGreaterThan(15)
    for (const group of drawn) {
      const help = group.querySelector('.field-help')
      expect(help?.textContent, `${group.getAttribute('data-field')} was drawn with no help text`).toBeTruthy()
    }
  })

  it('ties the help to its control, so it is announced rather than merely nearby', async () => {
    renderPage()
    await loaded()

    expect(control('server.port').getAttribute('aria-describedby')).toBe('server.port-help')
    expect(document.getElementById('server.port-help')!.textContent).toBe('What server.port is for.')
  })

  it('heads every section with its title and what the whole section is about', async () => {
    renderPage()
    await loaded()

    for (const section of SECTIONS) {
      const header = document.querySelector(`[data-section="${section.id}"]`)
      expect(header, `no header drawn for the ${section.id} section`).toBeTruthy()
      expect(header!.querySelector('h2')!.textContent).toBe(section.title)
      expect(header!.querySelector('.field-help')!.textContent).toBe(section.help)
    }
  })
})

/* -------------------------------------------------------------------------- the writes */

describe('what the page sends', () => {
  it('sends only the fields that were touched', async () => {
    renderPage()
    await loaded()

    fireEvent.change(control('server.port'), { target: { value: '8080' } })
    save()

    const body = await onlySave()
    expect(body.mtimeMs).toBe(VIEW.file.mtimeMs)
    expect(body.changes).toEqual([{ path: ['server', 'port'], value: 8080 }])
  })

  it('sends nothing for a secret box left alone — a blank means keep', async () => {
    renderPage()
    await loaded()

    fireEvent.change(control('limits.maxServers'), { target: { value: '9' } })
    save()

    const body = await onlySave()
    expect(body.changes).toEqual([{ path: ['limits', 'maxServers'], value: 9 }])
    // The token that was in the file is not mentioned, so it cannot be overwritten.
    expect(JSON.stringify(body)).not.toContain('hetzner')
  })

  it('does not resend an untouched ${VAR}, even though it is on screen', async () => {
    renderPage()
    await loaded()

    fireEvent.change(control('server.port'), { target: { value: '8080' } })
    save()

    expect(JSON.stringify(await onlySave())).not.toContain('GITHUB_PAT')
  })

  it('sends a retyped reference as the reference, not as a value it looked up', async () => {
    renderPage()
    await loaded()

    fireEvent.change(control('providers.hetzner.token'), { target: { value: 'OTHER_TOKEN' } })
    save()

    expect((await onlySave()).changes).toEqual([
      { path: ['providers', 'hetzner', 'token'], value: '${OTHER_TOKEN}' },
    ])
  })

  it('sends an explicit unset only when the operator asks to remove a credential', async () => {
    renderPage()
    await loaded()

    const field = document.querySelector('[data-field="providers.hetzner.token"]')!
    fireEvent.click(field.querySelector('button')!)
    expect(control('providers.hetzner.token').disabled).toBe(true)
    save()

    expect((await onlySave()).changes).toEqual([{ path: ['providers', 'hetzner', 'token'], unset: true }])
  })

  it('lets a pending removal be taken back before it is saved', async () => {
    renderPage()
    await loaded()

    const field = document.querySelector('[data-field="providers.hetzner.token"]')!
    fireEvent.click(field.querySelector('button')!)
    fireEvent.click(screen.getByRole('button', { name: 'Keep it after all' }))

    expect(screen.getByRole('button', { name: 'Save to the file' }).hasAttribute('disabled')).toBe(true)
    expect(saves).toHaveLength(0)
  })

  it('unsets a field whose box is emptied, so the file falls back to the default', async () => {
    renderPage()
    await loaded()

    fireEvent.change(control('providers.hetzner.location'), { target: { value: '' } })
    save()

    expect((await onlySave()).changes).toEqual([{ path: ['providers', 'hetzner', 'location'], unset: true }])
  })

  it('writes a spend cap as one whole block, and removes it as one', async () => {
    renderPage()
    await loaded()

    fireEvent.click(control('limits.spendCap'))
    save()

    expect((await onlySave()).changes).toEqual([
      { path: ['limits', 'spendCap'], value: { amount: 50, currency: 'USD' } },
    ])
  })

  it('lets a new cap be filled in before it is saved, rather than in a second round trip', async () => {
    renderPage()
    await loaded()

    fireEvent.click(control('limits.spendCap'))
    fireEvent.change(control('limits.spendCap.amount'), { target: { value: '250' } })
    fireEvent.change(control('limits.spendCap.currency'), { target: { value: 'EUR' } })
    save()

    expect((await onlySave()).changes).toEqual([
      { path: ['limits', 'spendCap'], value: { amount: 250, currency: 'EUR' } },
    ])
  })

  it('removes the whole cap block when it is turned off', async () => {
    served = {
      ...structuredClone(VIEW),
      values: { ...structuredClone(VIEW.values), limits: { maxServers: 5, spendCap: { amount: 50, currency: 'USD' } } },
    }
    renderPage()
    await loaded()

    expect(control('limits.spendCap').checked).toBe(true)
    fireEvent.click(control('limits.spendCap'))
    save()

    expect((await onlySave()).changes).toEqual([{ path: ['limits', 'spendCap'], unset: true }])
  })

  it('saves a list removal on its own, after a confirmation', async () => {
    renderPage()
    await loaded()

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.getByRole('dialog').textContent).toContain('workshop')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }))

    expect((await onlySave()).changes).toEqual([{ path: ['providers', 'byo', 'hosts', 0], unset: true }])
  })

  it('will not add or remove a list entry while THAT list has unsaved edits', async () => {
    renderPage()
    await loaded()

    // An edit somewhere else cannot renumber this list, so it does not block it — m29b blocked
    // on any pending edit at all, which made adding a host mean saving the port first.
    fireEvent.change(control('server.port'), { target: { value: '8080' } })
    expect(screen.getByRole('button', { name: 'Add' }).hasAttribute('disabled')).toBe(false)

    // An edit to an entry IS the hazard: a removal renumbers its successors.
    fireEvent.change(control('providers.byo.hosts.0.name'), { target: { value: 'renamed' } })
    for (const name of ['Add', 'Remove']) {
      const button = screen.getByRole('button', { name })
      expect(button.hasAttribute('disabled'), `${name} should be disabled while this list has edits`).toBe(true)
    }
    expect(saves).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ failures & honesty */

describe('when the save is refused', () => {
  it('puts a field-path error next to the field that caused it', async () => {
    nextSaveFailure = {
      status: 400,
      body: {
        error: 'server.port: Too big: expected number to be <=65535',
        code: 'bad_request',
        issues: [{ path: 'server.port', message: 'Too big: expected number to be <=65535' }],
      },
    }

    renderPage()
    await loaded()
    fireEvent.change(control('server.port'), { target: { value: '70000' } })
    save()

    await waitFor(() => {
      const field = document.querySelector('[data-field="server.port"]')!
      expect(field.textContent).toContain('Too big')
    })
    // And the edit is still in the form, so the fix is one keystroke rather than a retype.
    expect(control('server.port').value).toBe('70000')
  })

  /**
   * THE ENTRY BEING ADDED HAD NOWHERE TO SHOW A REFUSAL (rockysurf-1z5q, third finding).
   *
   * A draft has no index of its own — the server answers about `github.tokens.<length>`, the
   * slot the Add button is writing to — and the draft card read none of it. So the only place a
   * rejected Add appeared was the form-level line at the very top of a long page, while the card
   * the operator was looking at, at the bottom of the GitHub section, said nothing whatever.
   * That is what "the UI shows no useful error" was.
   */
  it('puts a rejected Add on the card being added, not only at the top of the page', async () => {
    nextSaveFailure = {
      status: 400,
      body: {
        error: 'github.tokens.1.owner: owner may contain only letters, digits, dot, underscore and dash',
        code: 'bad_request',
        issues: [
          { path: 'github.tokens.1.owner', message: 'owner may contain only letters, digits, dot, underscore and dash' },
        ],
      },
    }

    renderPage()
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Add a token' }))
    fireEvent.change(control('github.tokens.new.repo'), { target: { value: 'not an owner/widgets' } })
    fireEvent.change(control('github.tokens.new.pat'), { target: { value: 'PRIVATE_THING_PAT' } })
    clickIn('new', 'Add this token')

    await waitFor(() => expect(tokenCard('new').textContent).toContain('only letters, digits, dot'))
    // And nothing typed is thrown away by the refusal.
    expect(control('github.tokens.new.pat').value).toBe('PRIVATE_THING_PAT')
  })

  it('reports a conflict in the server\'s own words and re-reads the file', async () => {
    nextSaveFailure = {
      status: 409,
      body: {
        error: '/srv/rockysurf.config.yaml changed on disk after this page read it. Nothing was written.',
        code: 'conflict',
      },
    }

    renderPage()
    await loaded()
    fireEvent.change(control('server.port'), { target: { value: '8080' } })
    // The hand edit that caused the conflict, visible on the re-read.
    served = { ...structuredClone(VIEW), file: { ...VIEW.file, mtimeMs: 1_700_000_009_999 } }
    save()

    await waitFor(() => expect(document.body.textContent).toContain('Nothing was written'))
    // Nothing typed is thrown away by someone else's save.
    expect(control('server.port').value).toBe('8080')
  })
})

/* -------------------------------- rockysurf-1z5q: a reference saved ahead of its variable */

/**
 * SAVED, AND STILL NOT STARTABLE.
 *
 * The token boxes take a variable NAME (rockysurf-4o3o), and a variable cannot be exported into
 * a process that is already running — so the ordinary way to use this page is to write the
 * reference now and export the variable before the next restart. Core saves it and warns
 * (rockysurf-1z5q); what the page owes in return is a notice the operator cannot miss and
 * cannot lose: at the entry, where the fix is, and at the top, next to the restart banner it
 * amends.
 */
describe('a reference to a variable the running core cannot see', () => {
  const WITH_WARNING: SettingsView = {
    ...structuredClone(VIEW),
    warnings: [
      {
        path: 'github.tokens.0.pat',
        variable: 'PRIVATE_THING_PAT',
        message:
          '${PRIVATE_THING_PAT} is not set in the environment Rocky Surf was started from. The reference ' +
          'is saved either way; export the variable before the next restart, or that start will refuse.',
      },
    ],
  }

  it('names the variable at the entry that references it', async () => {
    served = structuredClone(WITH_WARNING)
    renderPage()
    await loaded()

    expect(tokenCard('0').textContent).toContain('PRIVATE_THING_PAT')
    expect(tokenCard('0').textContent).toContain('before the next restart')
  })

  it('amends the restart banner at the top: this restart will FAIL, not merely be pending', async () => {
    served = structuredClone(WITH_WARNING)
    renderPage()
    await loaded()

    const banner = document.querySelector('[data-unset-vars]')!
    expect(banner.textContent).toContain('PRIVATE_THING_PAT')
    expect(banner.textContent).toContain('the next start will refuse')
  })

  /**
   * THE SAVE SUCCEEDED, so none of this may render as a rejection: no field error, and the edit
   * is cleared from the form the way any accepted save clears it. The whole bug was a save that
   * refused what the page had asked for; a page that showed the warning as an error would be the
   * same lie in a different colour.
   */
  it('shows it after a save without calling the save a failure', async () => {
    renderPage()
    await loaded()
    expect(document.querySelector('[data-unset-vars]')).toBeNull()

    served = structuredClone(WITH_WARNING)
    fireEvent.change(control('github.tokens.0.pat'), { target: { value: 'PRIVATE_THING_PAT' } })
    clickIn('0', 'Save this token')

    await waitFor(() => expect(document.querySelector('[data-unset-vars]')).not.toBeNull())
    expect(document.querySelector('.settings-field-error')).toBeNull()
    // The pending edit is cleared, so the box is back to showing the file's own value — which is
    // what every ACCEPTED save does here, and what a rejected one does not.
    expect(control('github.tokens.0.pat').value).toBe('ACME_PAT')
  })

  /** A reload is what loses a toast. This comes back with the file, so it comes back. */
  it('is still there after the page reads the file again', async () => {
    served = structuredClone(WITH_WARNING)
    const { unmount } = renderPage()
    await loaded()
    unmount()

    renderPage()
    await loaded()
    expect(document.querySelector('[data-unset-vars]')!.textContent).toContain('PRIVATE_THING_PAT')
  })

  it('says nothing at all when every variable the file names is set', async () => {
    renderPage()
    await loaded()
    expect(document.querySelector('[data-unset-vars]')).toBeNull()
    expect(document.querySelector('.settings-field-warning')).toBeNull()
  })
})

describe('restart honesty', () => {
  it('says nothing about restarting a process that matches its file', async () => {
    renderPage()
    await loaded()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps a standing notice once the file and the running process differ', async () => {
    served = { ...structuredClone(VIEW), drifted: true }
    renderPage()
    await loaded()

    const banner = screen.getByRole('status')
    expect(banner.textContent).toContain('still using the old settings')
    expect(banner.textContent).toContain('./start.sh')
  })

  it('raises that notice after a save, because a save is exactly when it becomes true', async () => {
    renderPage()
    await loaded()
    expect(screen.queryByRole('status')).toBeNull()

    fireEvent.change(control('server.port'), { target: { value: '8080' } })
    save()

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('./start.sh'))
  })

  it('always states the restart requirement beside the save button, drift or no drift', async () => {
    renderPage()
    await loaded()
    expect(document.querySelector('.settings-actions')!.textContent).toContain('./start.sh')
  })
})

describe('when the file cannot be read', () => {
  it('says so inside the shell, rather than rendering an empty form over nothing', async () => {
    // A 500, not a 401 — a 401 would send the page to the login screen instead.
    getFailure = { status: 500, body: { error: 'cannot read /srv/rockysurf.config.yaml: EACCES', code: 'server_error' } }

    renderPage()

    await waitFor(() => expect(document.body.textContent).toContain('EACCES'))
    // Still inside the shell: a page must not shed its navigation exactly when something failed.
    expect(screen.getByRole('navigation')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Save to the file' })).toBeNull()
  })
})
