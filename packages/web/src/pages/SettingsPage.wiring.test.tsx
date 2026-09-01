import { startStubServer, type StubServer } from '../test-server'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
/** Core's five, as `settings/fields.ts` classifies them. */
const RESTART_REQUIRED = new Set(['server.port', 'server.host', 'server.dataDir', 'auth.mode', 'mcp.scopes'])

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
    { path: 'github.oauth.clientId', kind: 'string', writable: true },
    // The two paste boxes, and the only two: `accepts: 'literal'` is what rockysurf-7fyf.2
    // narrowed rockysurf-4o3o to, and Hetzner below still has no `accepts` at all.
    { path: 'github.pat', kind: 'secret', writable: true, accepts: 'literal' },
    { path: 'github.tokens.*.owner', kind: 'string', writable: true },
    { path: 'github.tokens.*.repo', kind: 'string', writable: true },
    { path: 'github.tokens.*.host', kind: 'string', writable: true },
    { path: 'github.tokens.*.pat', kind: 'secret', writable: true, accepts: 'literal' },
    { path: 'providers.hetzner.enabled', kind: 'boolean', writable: true },
    { path: 'providers.hetzner.token', kind: 'secret', writable: true },
    { path: 'providers.hetzner.location', kind: 'string', writable: true },
    { path: 'providers.hetzner.consoleProjectId', kind: 'number', writable: true },
    { path: 'providers.aws.enabled', kind: 'boolean', writable: true },
    { path: 'providers.aws.region', kind: 'string', writable: true },
    { path: 'providers.aws.profile', kind: 'string', writable: true },
    {
      path: 'providers.aws.sshAllowedCidr',
      kind: 'stringList',
      writable: true,
      warning: 'Removing a CIDR immediately ends new SSH connections from that network; existing sessions survive.',
    },
    { path: 'providers.aws.allowAllCidr', kind: 'boolean', writable: true },
    { path: 'providers.aws.sizes', kind: 'stringList', writable: false, reason: 'An allowlist of instance types, edited in the file.' },
    { path: 'providers.azure.enabled', kind: 'boolean', writable: true },
    { path: 'providers.azure.subscriptionId', kind: 'string', writable: true },
    { path: 'providers.azure.resourceGroup', kind: 'string', writable: true },
    { path: 'providers.azure.location', kind: 'string', writable: true },
    {
      path: 'providers.azure.sshAllowedCidr',
      kind: 'stringList',
      writable: true,
      warning: 'Removing a CIDR immediately ends new SSH connections from that network; existing sessions survive.',
    },
    { path: 'providers.azure.allowAllCidr', kind: 'boolean', writable: true },
    { path: 'providers.azure.sizes', kind: 'stringList', writable: false, reason: 'An allowlist of VM sizes, edited in the file.' },
    { path: 'providers.gcp.enabled', kind: 'boolean', writable: true },
    { path: 'providers.gcp.projectId', kind: 'string', writable: true },
    { path: 'providers.gcp.zone', kind: 'string', writable: true },
    {
      path: 'providers.gcp.sshAllowedCidr',
      kind: 'stringList',
      writable: true,
      warning: 'Removing a CIDR immediately ends new SSH connections from that network; existing sessions survive.',
    },
    { path: 'providers.gcp.allowAllCidr', kind: 'boolean', writable: true },
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
    // Your own public keys, saved by name (issue #302). Plain strings, key included: masking a
    // public key would hide the one value the operator has to be able to proof-read.
    { path: 'ssh.keys.*.name', kind: 'string', writable: true },
    {
      path: 'ssh.keys.*.publicKey',
      kind: 'string',
      writable: true,
      warning: 'The PUBLIC half only. Never paste a private key here.',
    },
    { path: 'limits.spendCap', kind: 'group', writable: true },
    { path: 'limits.spendCap.amount', kind: 'number', writable: true },
    { path: 'limits.spendCap.currency', kind: 'string', writable: true },
    // Where packs may come from (issue #88). The URL box carries a warning for the same reason
    // the MCP scopes do: what is behind it runs as root on every box created with the pack.
    { path: 'registry.enabled', kind: 'boolean', writable: true },
    { path: 'registry.sources.*.name', kind: 'string', writable: true },
    {
      path: 'registry.sources.*.url',
      kind: 'string',
      writable: true,
      warning: 'A pack is install scripts, and they run as ROOT on every box you create with it.',
    },
    { path: 'registry.sources.*.trust', kind: 'string', writable: true },
    { path: 'registry.cacheTtlSeconds', kind: 'number', writable: true },
    { path: 'mcp.scopes', kind: 'stringList', writable: true, warning: 'create spends money and terminate destroys a box.' },
  ] satisfies Omit<SettingsField, 'help' | 'appliesAt'>[]
).map((field) => ({
  ...field,
  help: `What ${field.path} is for.`,
  /**
   * The restart classification, mirrored from core's own five (issue #264).
   *
   * Derived rather than written per row for the reason `help` is: the WORDS are core's business
   * and are checked there; what this file checks is that the page renders whatever it was
   * handed. The list is spelled out so a stub that quietly stopped marking anything would fail
   * the page's own "names them" assertions rather than pass by omission.
   */
  ...(RESTART_REQUIRED.has(field.path)
    ? { appliesAt: 'restart' as const, restartReason: `Why ${field.path} cannot change while Rocky Surf runs.` }
    : { appliesAt: 'save' as const }),
}))

const SECTIONS: SettingsSection[] = [
  { id: 'server', title: 'Server', help: 'Where Rocky Surf itself listens.' },
  { id: 'github', title: 'GitHub access tokens', help: 'Tokens for cloning private repositories.' },
  { id: 'ssh', title: 'SSH public keys', help: 'Public keys you reuse, saved by name.' },
  { id: 'ssh.keys', title: 'Your public keys', help: 'Each one is a name and the PUBLIC half of a keypair.' },
  { id: 'providers.hetzner', title: 'Hetzner', help: 'Servers at Hetzner.' },
  { id: 'providers.aws', title: 'AWS', help: 'EC2 instances in one region.' },
  { id: 'providers.azure', title: 'Azure', help: 'Virtual machines in one Azure region.' },
  { id: 'providers.gcp', title: 'Google Cloud', help: 'Compute Engine instances in one zone.' },
  { id: 'providers.byo', title: 'Your own machines', help: 'Machines you already have.' },
  { id: 'providers.byo.hosts', title: 'Hosts', help: 'The machines Rocky Surf may claim.' },
  { id: 'limits', title: 'Limits', help: 'Guardrails, enforced server-side.' },
  { id: 'registry', title: 'Pack sources', help: 'Where Surge Packs may come from.' },
  { id: 'registry.sources', title: 'Sources', help: 'The sources this instance browses.' },
  { id: 'mcp', title: 'MCP', help: 'What an MCP client may do.' },
]

/** The redacted view, as core serves it: no literal anywhere, references intact. */
const VIEW: SettingsView = {
  file: { path: '/srv/rockysurf.config.yaml', exists: true, mtimeMs: 1_700_000_000_000 },
  /** Nothing waiting on a restart, which is the ordinary state of the page since #264. */
  pendingRestart: [],
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
    ssh: { keys: [{ name: 'laptop', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKPX laptop' }] },
    limits: { maxServers: 5 },
    registry: {
      enabled: true,
      sources: [{ name: 'Rocky Surf Pack Shop', url: 'https://raw.githubusercontent.com/x/shop/main', trust: 'community' }],
    },
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
  /**
   * Mirrored from core's `SETTINGS_LISTS`, `blank` and all — because the page now DRAWS from
   * this (issue #302 follow-up). `ssh.keys` deliberately has no hand-written block on the page,
   * so what these four rows say is the whole of what its card can be.
   */
  lists: [
    // No blank: the token list collects a token through its own card before writing anything.
    { path: 'github.tokens', itemFields: ['host', 'owner', 'repo', 'pat'], labelField: 'owner', empty: 'None yet.' },
    {
      path: 'ssh.keys',
      itemFields: ['name', 'publicKey'],
      blank: { name: 'my-laptop', publicKey: '' },
      labelField: 'name',
      empty: 'None yet. Add one and the New Server page will offer it.',
    },
    {
      path: 'providers.byo.hosts',
      itemFields: ['name', 'host', 'user', 'port', 'fingerprint', 'identityFile'],
      blank: { name: 'change-me', host: '10.0.0.1' },
      labelField: 'name',
      empty: 'None yet. Enabling this provider requires at least one host.',
    },
    {
      path: 'registry.sources',
      itemFields: ['name', 'url', 'trust'],
      blank: { name: 'my-packs', url: 'https://example.com/my-pack.yaml', trust: 'community' },
      labelField: 'name',
      empty: 'None yet.',
    },
  ],
  drifted: false,
  restartHint: 'Changes apply after a restart: stop the process with Ctrl-C and run ./start.sh again.',
  // Split the way core splits it (#232): the two commands are their own runs, so the page can
  // set them in <code> without reading core's prose.
  restartHintSegments: [
    { text: 'Changes apply after a restart: stop the process with ' },
    { text: 'Ctrl-C', code: true },
    { text: ' and run ' },
    { text: './start.sh', code: true },
    { text: ' again.' },
  ],
}

/**
 * The GitHub connection, as core's `/api/v1/github/connection` answers it (rockysurf-7fyf.2).
 *
 * Served from the stub rather than mocked at the module level, for the same reason the settings
 * view is: the page's job is to render what the route says, and a mocked client would let the
 * two drift. No device flow runs in this file — the card's own state machine is exercised in
 * `components/ConnectGitHubCard.test.tsx` — so nothing here needs `/connect`.
 */
const CONNECTION_DISCONNECTED = {
  clientIdConfigured: true,
  connected: false,
  configFallbackSet: true,
}

let stub: StubServer
/** What `/api/v1/github/connection` answers with. */
let githubConnection: Record<string, unknown>
/** Every DELETE of the GitHub connection, so a disconnect can be asserted as a request. */
let githubDisconnects: number
/** Every PUT body the page sent, in order. */
let saves: { mtimeMs: number | null; changes: { path: (string | number)[]; value?: unknown; unset?: true }[] }[]
/** What the next PUT answers with. `null` means "accept it and echo the view back". */
let nextSaveFailure: { status: number; body: unknown } | null
/** What the next GET answers with, when the read itself is meant to fail. */
let getFailure: { status: number; body: unknown } | null
let served: SettingsView
/**
 * What `/api/v1/providers` answers with — the catalogues behind the saved-type pickers (#212).
 *
 * Empty by default, which is the state every other test in this file runs in and the state a
 * real installation is in whenever the clouds cannot be read: the saved-type boxes are then the
 * free-text boxes they have always been, and nothing else on the page changes.
 */
let catalogues: unknown[]
/** Every push of the SSH whitelist the page made, and what core answered (issue #304). */
let syncCalls: number
let syncResponse: { synced: unknown[] }

beforeEach(async () => {
  saves = []
  nextSaveFailure = null
  getFailure = null
  served = structuredClone(VIEW)
  githubConnection = { ...CONNECTION_DISCONNECTED }
  githubDisconnects = 0
  catalogues = []
  syncCalls = 0
  syncResponse = {
    synced: [{ provider: 'aws', status: 'updated', applied: ['203.0.113.7/32'], reported: [], detail: 'Authorized 203.0.113.7/32.' }],
  }
  setAuthToken('test-token')

  stub = await startStubServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (url.pathname === '/api/v1/github/connection') {
      if (req.method === 'DELETE') {
        githubDisconnects += 1
        githubConnection = { ...githubConnection, connected: false, login: null, scopes: [] }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ disconnected: true, removed: true, message: 'forgotten locally' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(githubConnection))
      return
    }

    if (url.pathname === '/api/v1/providers') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(catalogues))
      return
    }

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

    if (url.pathname === '/api/v1/network/ssh-access/sync' && req.method === 'POST') {
      syncCalls += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(syncResponse))
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
        /*
          THE STUB CLASSIFIES THE SAVE THE WAY CORE DOES (issue #264).

          It used to answer every PUT with `drifted: true`, which was the truth when every save
          left the process behind. It no longer is: core adopts what it can and reports the
          remainder per path, and a stub that kept claiming drift would let the page pass while
          telling an operator their save had done nothing. So it splits the paths it was sent by
          the inventory it is already serving.
        */
        const saved = (JSON.parse(body) as { changes: { path: (string | number)[] }[] }).changes.map((change) =>
          change.path.map((segment) => (typeof segment === 'number' ? '*' : segment)).join('.'),
        )
        const specOf = (path: string) => served.fields.find((field) => field.path === path)
        const restartRequired = saved.flatMap((path) => {
          const spec = specOf(path)
          return spec?.appliesAt === 'restart' ? [{ path, reason: spec.restartReason ?? '' }] : []
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            saved: true,
            applied: saved.filter((path) => specOf(path)?.appliesAt !== 'restart'),
            restartRequired,
            // Core names the clouds whose whitelist this save left behind (issue #304).
            networkSyncNeeded: [
              ...new Set(
                saved.flatMap((path) => {
                  const match = /^providers\.([^.]+)\.sshAllowedCidr$/.exec(path)
                  return match?.[1] ? [match[1]] : []
                }),
              ),
            ],
            ...served,
            drifted: restartRequired.length > 0,
            pendingRestart: restartRequired,
          }),
        )
      })
      return
    }

    res.writeHead(404).end()
  })

})

afterEach(async () => {
  setAuthToken(null)
  await stub.close()
})

/**
 * `at` is the URL the page opens on, which is how a deep link into one section is tested:
 * `?section=` is the whole of the page's navigation state (issue #122).
 */
function renderPage(at = '/settings') {
  return render(
    <MemoryRouter initialEntries={[at]}>
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

/**
 * Open a section's tab (issue #122).
 *
 * The page draws one section at a time, so a test that drives a control on another one says
 * which — and a control on a hidden panel is out of the accessibility tree, so `getByRole` will
 * not find it either. The title is matched from the START because a tab holding unsaved work or
 * a rejected field grows a sentence after it, for the benefit of a screen reader.
 */
const open = (title: string) => fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${title}`) }))

/** The section the whole token list lives on. */
const GITHUB = 'GitHub access tokens'

/** Open the token list and start a new entry, which is where six of these tests begin. */
const addToken = () => {
  open(GITHUB)
  fireEvent.click(screen.getByRole('button', { name: 'Add a token' }))
}

/**
 * Click a button inside one token card, where several cards offer the same label.
 *
 * It opens the GitHub tab first because that is where every token card is: reaching one is part
 * of clicking it, and a test about what a Save button sends should not read as a test about
 * navigation.
 */
const clickIn = (id: string, name: string) => {
  open(GITHUB)
  fireEvent.click(within(tokenCard(id)).getByRole('button', { name }))
}

/** The one save this page made, once it has made it. */
async function onlySave(): Promise<(typeof saves)[number]> {
  await waitFor(() => expect(saves).toHaveLength(1))
  return saves[0]!
}

/* --------------------------------------------------------------------------- the read */

/**
 * WHAT OWNS THE MASKED BOXES (issue #212, second half).
 *
 * Chrome reads a form holding two or more `type=password` boxes as several forms crammed into
 * one and says so in DevTools — measured against this page's own markup in headless Chrome,
 * along with the two alternatives that do not work: `autocomplete="new-password"` leaves the
 * warning in place, and a hidden username field trades it for a DevTools issue of its own.
 *
 * One form owner per masked box is what silences it, and it also describes what was already
 * true: a token box is not part of the bulk save. So what is asserted here is ownership, which
 * is the whole of the fix — the config form must own no masked box, every masked box must be
 * owned by a form that is not the config form, and the plain-text boxes must not have moved.
 */
describe('what owns the masked credential boxes', () => {
  /** The one form the Save button at the foot of the page submits. */
  const configForm = () => document.querySelector('.settings-layout')!.closest('form') as HTMLFormElement

  const masked = (form: HTMLFormElement) =>
    [...form.elements].filter((el) => (el as HTMLInputElement).type === 'password')

  it('gives every masked token box a form of its own, outside the config form', async () => {
    served.values.github = {
      pat: { secret: true, state: 'set' },
      tokens: [{ repo: 'acme/widgets', pat: { secret: true, state: 'set' } }],
    }
    renderPage()
    await loaded()
    addToken()

    // Three masked boxes on this page — the instance-wide token, the scoped entry, the draft.
    const boxes = ['github.pat', 'github.tokens.0.pat', 'github.tokens.new.pat'].map(control)
    for (const box of boxes) {
      expect(box.type).toBe('password')
      const owner = document.getElementById(box.getAttribute('form') ?? '')
      expect(owner?.tagName).toBe('FORM')
      // Beside the config form, never inside it: a form inside a form is not a thing HTML has.
      expect(owner).not.toBe(configForm())
      expect(configForm().contains(owner)).toBe(false)
      expect(box.form).toBe(owner)
    }
    // Each box has its OWN owner: two in one form is the condition Chrome complains about.
    expect(new Set(boxes.map((b) => b.getAttribute('form'))).size).toBe(3)
    expect(masked(configForm())).toEqual([])
  })

  it('leaves the plain-text boxes in the config form, which is what saves them', async () => {
    renderPage()
    await loaded()

    // An env-var-name box holds no key material, is not masked, and IS part of the bulk save —
    // moving it out of the form would be a change to how the page saves, not to a warning.
    const box = control('providers.hetzner.token')
    expect(box.type).toBe('text')
    expect(box.getAttribute('form')).toBeNull()
    expect(box.form).toBe(configForm())
  })
})

describe('what the page shows', () => {
  it('shows a ${VAR} reference as the reference in the boxes that take one', async () => {
    served.values.providers = {
      ...(served.values.providers as Record<string, unknown>),
      hetzner: { enabled: true, token: { secret: true, state: 'reference', reference: '${HETZNER_TOKEN}' } },
    }
    renderPage()
    await loaded()

    // The file holds `${HETZNER_TOKEN}`; the box holds the variable's name. The braces belong to
    // the file format (rockysurf-4o3o).
    expect(control('providers.hetzner.token').value).toBe('HETZNER_TOKEN')
    expect(document.body.textContent).not.toContain(LITERAL_TOKEN)
  })

  it('shows a stored literal as a state, never as a value', async () => {
    renderPage()
    await loaded()

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
    // And a scoped entry is an entry of the same list, named the way an operator names a repo.
    expect(tokenCard('0').textContent).toContain('acme/widgets')
    expect(control('github.tokens.0.repo').value).toBe('acme/widgets')
    // Both token boxes are empty: these are paste boxes, and the file's `${VAR}` is a state
    // rather than something to edit in place. See the prefill case below.
    expect(control('github.pat').value).toBe('')
    expect(control('github.tokens.0.pat').value).toBe('')
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

    expect(tokenCard('fallback').textContent).toContain('A token is stored in the configuration file')
    expect(tokenCard('0').textContent).toContain('Not set in the configuration file')
    expect(tokenCard('0').textContent).toContain('acme')
    expect(document.body.textContent).not.toContain(LITERAL_TOKEN)
  })

  it('saves one entry at a time, so an index cannot move under a pending edit', async () => {
    renderPage()
    await loaded()

    fireEvent.change(control('server.port'), { target: { value: '8080' } })
    fireEvent.change(control('github.tokens.0.pat'), { target: { value: 'github_pat_newacme' } })

    // The page-wide Save carries the port and nothing from the list.
    save()
    expect((await onlySave()).changes).toEqual([{ path: ['server', 'port'], value: 8080 }])

    // And the token edit survived that save rather than being swept up by it.
    expect(control('github.tokens.0.pat').value).toBe('github_pat_newacme')
    clickIn('0', 'Save this token')
    // The first save is already awaited above (`onlySave()`), so this is a second, independent
    // real round trip against the stub HTTP server — not a race with the first. There is no
    // promise the test can hold for it (`clickIn` only dispatches a DOM event), so the only
    // deterministic thing left to fix is testing-library's default 1000ms `waitFor` budget,
    // which is too tight for a real socket under a loaded CI runner (rockysurf-zn33: observed
    // giving up at ~1.2s on run 32296243192, green on immediate rerun of the same commit).
    // `CreateServerPage.test.tsx` widens the same class of real-HTTP wait to 3000ms; this one
    // gets a bit more headroom since it is the second round trip in the test, not the first.
    await waitFor(() => expect(saves).toHaveLength(2), { timeout: 5000 })
    expect(saves[1]!.changes).toEqual([
      { path: ['github', 'tokens', 0, 'pat'], value: 'github_pat_newacme' },
    ])
  })

  it('writes a retyped instance-wide token to github.pat, not to the list', async () => {
    renderPage()
    await loaded()

    fireEvent.change(control('github.pat'), { target: { value: 'ghp_otherToken' } })
    clickIn('fallback', 'Save this token')

    expect((await onlySave()).changes).toEqual([{ path: ['github', 'pat'], value: 'ghp_otherToken' }])
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

    addToken()
    // Nothing is written by pressing Add: the entry is drafted first.
    expect(saves).toHaveLength(0)

    fireEvent.change(control('github.tokens.new.repo'), { target: { value: 'acme/other' } })
    fireEvent.change(control('github.tokens.new.pat'), { target: { value: 'github_pat_other' } })
    clickIn('new', 'Add this token')

    expect((await onlySave()).changes).toEqual([
      { path: ['github', 'tokens', 1], value: { repo: 'acme/other', pat: 'github_pat_other' } },
    ])
  })

  it('adds an entry with no scope to github.pat, which is what an unscoped entry means', async () => {
    served = structuredClone(VIEW)
    served.values.github = { tokens: [] }
    renderPage()
    await loaded()

    addToken()
    fireEvent.change(control('github.tokens.new.pat'), { target: { value: 'ghp_fallbackToken' } })
    clickIn('new', 'Add this token')

    expect((await onlySave()).changes).toEqual([{ path: ['github', 'pat'], value: 'ghp_fallbackToken' }])
  })

  it('refuses a second unscoped entry in a sentence, rather than as a schema error', async () => {
    renderPage()
    await loaded()

    addToken()
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

    addToken()
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
    open(GITHUB)
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
/* ------------------- the policy, narrowed: two kinds of credential box (7fyf.2) */

/**
 * BOTH HALVES, IN ONE FILE, ON PURPOSE.
 *
 * rockysurf-7fyf.2 reverses rockysurf-4o3o for the two GitHub PATs and upholds it everywhere
 * else. A test file that only covered the new behaviour would let the old rule rot in the
 * fields nobody was looking at, and one that only covered the old rule would go red the moment
 * the new one shipped. So the env-var cases below name `providers.hetzner.token` and the paste
 * cases name the GitHub paths, and neither set is allowed to widen quietly into the other's.
 */
describe('a token box takes the name of an environment variable — where it still does', () => {
  it('is plain text for a variable name, and masked for a pasted token', async () => {
    renderPage()
    await loaded()

    // Masking a variable name is theatre; masking key material is not. Same page, two answers,
    // because the two boxes hold two different kinds of thing.
    expect(control('providers.hetzner.token').type).toBe('text')
    expect(control('github.pat').type).toBe('password')
    expect(control('github.tokens.0.pat').type).toBe('password')
  })

  it('says what each box is for, in its label', async () => {
    renderPage()
    await loaded()

    expect(document.querySelector('label[for="providers.hetzner.token"]')?.textContent).toBe(
      'Token Environment Variable',
    )
    for (const path of ['github.pat', 'github.tokens.0.pat']) {
      expect(document.querySelector(`label[for="${path}"]`)?.textContent, `${path} is mislabelled`).toBe('Token')
    }
  })

  it('round-trips a reference: the file keeps its braces, the box does not', async () => {
    served.values.providers = {
      ...(served.values.providers as Record<string, unknown>),
      hetzner: { enabled: true, token: { secret: true, state: 'reference', reference: '${HETZNER_TOKEN}' } },
    }
    renderPage()
    await loaded()

    expect(control('providers.hetzner.token').value).toBe('HETZNER_TOKEN')
    fireEvent.change(control('providers.hetzner.token'), { target: { value: 'OTHER_HETZNER' } })
    save()

    expect((await onlySave()).changes).toEqual([
      { path: ['providers', 'hetzner', 'token'], value: '${OTHER_HETZNER}' },
    ])
  })

  it('normalises the ${...} form, because copying the line out of the file is the obvious move', async () => {
    renderPage()
    await loaded()

    fireEvent.change(control('providers.hetzner.token'), { target: { value: '${OTHER_HETZNER}' } })
    save()

    // Not `${${OTHER_HETZNER}}` — one normalisation, at one seam.
    expect((await onlySave()).changes).toEqual([
      { path: ['providers', 'hetzner', 'token'], value: '${OTHER_HETZNER}' },
    ])
  })

  /**
   * THE REFUSAL STILL FIRES, AND ONLY WHERE IT SHOULD. Both assertions matter: the first is the
   * rule surviving, the second is the reversal being a narrowing rather than a repeal.
   */
  it('refuses a literal in a variable-name box, and refuses nothing in a paste box', async () => {
    renderPage()
    await loaded()

    fireEvent.change(control('providers.hetzner.token'), { target: { value: 'hcloud-live-abcdef' } })
    const refusal = document.querySelector('[data-refusal="providers.hetzner.token"]')!
    expect(refusal.textContent).toContain('NAME of an environment variable')
    expect(refusal.textContent).toContain('holds only the reference')

    fireEvent.change(control('github.pat'), { target: { value: 'ghp_liveTokenPastedOnPurpose' } })
    expect(document.querySelector('[data-refusal="github.pat"]')).toBeNull()
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

  /**
   * A new entry is ONE change carrying `{ repo, pat }`, so the credential in it is not at the
   * change's own path. This is the case that makes `asReferences` descend rather than look only
   * at the path it was handed — and, now that the PAT inside is a literal, the case that proves
   * descending did not start rewriting one.
   */
  it('sends the credential inside a whole new entry verbatim, not as a reference', async () => {
    renderPage()
    await loaded()

    addToken()
    fireEvent.change(control('github.tokens.new.repo'), { target: { value: 'acme/other' } })
    fireEvent.change(control('github.tokens.new.pat'), { target: { value: 'github_pat_otherEntry' } })
    clickIn('new', 'Add this token')

    expect((await onlySave()).changes).toEqual([
      { path: ['github', 'tokens', 1], value: { repo: 'acme/other', pat: 'github_pat_otherEntry' } },
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

/* ------------------------------------------ the GitHub token boxes take a pasted token */

describe('a GitHub token box takes the token itself', () => {
  it('sends what was pasted, verbatim, with no ${...} anywhere near it', async () => {
    renderPage()
    await loaded()

    fireEvent.change(control('github.pat'), { target: { value: 'ghp_pastedLiteralToken1234' } })
    clickIn('fallback', 'Save this token')

    const sent = await onlySave()
    expect(sent.changes).toEqual([{ path: ['github', 'pat'], value: 'ghp_pastedLiteralToken1234' }])
    expect(JSON.stringify(sent)).not.toContain('${')
  })

  /**
   * THE PREFILL TRAP, WHICH IS THE BUG THIS CHANGE COULD MOST EASILY HAVE SHIPPED.
   *
   * The old box prefilled a `${GITHUB_PAT}` state with the bare name `GITHUB_PAT`, as editable
   * text — correct while the box wanted a name. In a box that now takes tokens, that same
   * prefill is a live grenade: the operator sees `GITHUB_PAT` sitting in a token box, types one
   * character, and a working reference becomes a literal nobody meant to write.
   *
   * So a reference renders as a STATE LINE with an EMPTY input, and the file keeps it.
   */
  it('renders a ${VAR} reference as a state line and an EMPTY box, never as editable text', async () => {
    renderPage()
    await loaded()

    // The file says `${GITHUB_PAT}` — see VIEW — and the box says nothing at all.
    expect(control('github.pat').value).toBe('')
    expect(control('github.pat').placeholder).toContain('Leave empty to keep')
    expect(tokenCard('fallback').textContent).toContain('This entry names an environment variable')
    expect(tokenCard('fallback').textContent).toContain('Leave the box empty to keep it')
    // And the name is not sitting anywhere an operator could mistake for the box's contents.
    expect(control('github.pat').value).not.toBe('GITHUB_PAT')
  })

  it('leaves the reference in the file when another field on the card is saved', async () => {
    renderPage()
    await loaded()

    // Change the scope on the entry whose PAT is `${ACME_PAT}`, and save that card.
    fireEvent.change(control('github.tokens.0.repo'), { target: { value: 'acme/other' } })
    clickIn('0', 'Save this token')

    // The PAT is simply not in the payload, so the file's reference is untouched — rule 2 of
    // `settings/routes.ts`, relied on here rather than reimplemented.
    const sent = await onlySave()
    expect(sent.changes.some((c) => c.path.includes('pat'))).toBe(false)
    expect(JSON.stringify(sent)).not.toContain('ACME_PAT')
  })

  it('never renders a token value from a settings read, in any state', async () => {
    served.values.github = {
      pat: { secret: true, state: 'set' },
      tokens: [{ owner: 'acme', pat: { secret: true, state: 'reference', reference: '${ACME_PAT}' } }],
    }
    renderPage()
    await loaded()

    // The redacted view has no value to leak, which is the point: the page cannot display one
    // because core never sent one.
    expect(document.body.textContent).not.toContain(LITERAL_TOKEN)
    expect(control('github.pat').value).toBe('')
    expect(control('github.tokens.0.pat').value).toBe('')
    expect(tokenCard('fallback').textContent).toContain('A token is stored in the configuration file')
  })
})

/* ------------------------------------------------------- the Connect GitHub card's place */

describe('the Connect GitHub card', () => {
  const connectCard = () => document.querySelector('[data-github-connect]') as HTMLElement

  it('sits at the top of the GitHub section, above the tokens it is the fallback for', async () => {
    renderPage()
    await loaded()

    const card = await screen.findByText('Connect GitHub', { selector: 'h3' })
    expect(card).toBeTruthy()
    // Document order: the catch-all first, the exceptions below it.
    const position = connectCard().compareDocumentPosition(tokenCard('fallback'))
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  /**
   * The card is disabled without a client ID, so the box that fixes that has to be reachable
   * from the same page — otherwise the instruction on the card sends the operator to a text
   * editor for a value the Settings API already accepts.
   */
  it('offers the OAuth App client ID as an ordinary box, and saves it to the file', async () => {
    renderPage()
    await loaded()

    const box = control('github.oauth.clientId')
    expect(box).toBeTruthy()
    // Public, so it is not masked and not classified secret.
    expect(box.type).toBe('text')

    fireEvent.change(box, { target: { value: 'Iv1.0123456789abcdef' } })
    save()

    expect((await onlySave()).changes).toEqual([
      { path: ['github', 'oauth', 'clientId'], value: 'Iv1.0123456789abcdef' },
    ])
  })

  it('says what covers everything no scoped entry matches', async () => {
    renderPage()
    await loaded()

    const line = await screen.findByText(/^Everything else:/)
    expect(line.textContent).toContain('the token in the configuration file')

    githubConnection = { clientIdConfigured: true, connected: true, login: 'octocat', scopes: ['repo'], configFallbackSet: false }
    renderPage()
    expect((await screen.findAllByText('Everything else: connected as @octocat')).length).toBeGreaterThan(0)
  })

  it('names the winner when a connection and a config fallback both exist', async () => {
    githubConnection = {
      clientIdConfigured: true,
      connected: true,
      login: 'octocat',
      scopes: ['repo'],
      configFallbackSet: true,
    }
    renderPage()
    await loaded()

    const superseded = await screen.findByText(/takes precedence over this entry/)
    expect(superseded.textContent).toContain('@octocat')
    expect(superseded.textContent).toContain('not this one')
  })

  it('confirms a disconnect first, and says it is not a revocation at GitHub', async () => {
    githubConnection = {
      clientIdConfigured: true,
      connected: true,
      login: 'octocat',
      scopes: ['repo'],
      configFallbackSet: false,
    }
    renderPage()
    await loaded()

    open(GITHUB)
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('NOT revoked at GitHub')
    expect(dialog.textContent).toContain('github.com/settings/applications')
    expect(githubDisconnects, 'the confirmation must come before the request').toBe(0)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(githubDisconnects).toBe(1))
    // Nothing was written to the config file: this token never lived there.
    expect(saves).toHaveLength(0)
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

    open('Hetzner')
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

    open('Your own machines')
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
    open('Your own machines')
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
    addToken()
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
    // The pending edit is cleared, so the box is back to what the file's state renders as —
    // empty, since a paste box never prefills. That is what every ACCEPTED save does here, and
    // what a rejected one does not: a rejected save leaves the typed text in place to be fixed.
    expect(control('github.tokens.0.pat').value).toBe('')
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

/**
 * WHAT A SAVE DID, PER SETTING (issue #264).
 *
 * The page used to say one thing about every save: nothing has taken effect, restart. It now
 * says the true thing, which differs by field — so these cases are about the SPLIT. The
 * per-field note is the primary surface (it is there before anybody clicks Save); the banner and
 * the footer sentence follow from it.
 */
const drifting = (path: string, reason: string) => ({
  ...structuredClone(VIEW),
  drifted: true,
  pendingRestart: [{ path, reason }],
})

describe('restart honesty, per setting', () => {
  it('says nothing about restarting a process that matches its file', async () => {
    renderPage()
    await loaded()
    expect(screen.queryByRole('status')).toBeNull()
  })

  /**
   * THE NOTE THE OPERATOR READS BEFORE THEY CLICK. It renders from the inventory alone, on a
   * page nobody has saved anything on, which is exactly when it is most useful.
   */
  it('marks each field that needs a restart, at the control, with core own reason', async () => {
    renderPage()
    await loaded()

    const port = document.querySelector('[data-restart-required="server.port"]')!
    expect(port.textContent).toContain('Takes effect after a restart')
    expect(port.textContent).toContain('Why server.port cannot change while Rocky Surf runs.')
    // The read-only one carries it too: moving a data directory is a stop-and-start, and the
    // fact that the box is not editable does not tell an operator that.
    expect(document.querySelector('[data-restart-required="server.dataDir"]')).toBeTruthy()
  })

  it('puts no such note on the settings that apply on save — which is nearly all of them', async () => {
    renderPage()
    await loaded()

    expect(document.querySelector('[data-restart-required="limits.maxServers"]')).toBeNull()
    expect(document.querySelector('[data-restart-required="providers.aws.region"]')).toBeNull()
    expect(document.querySelectorAll('[data-restart-required]').length).toBeLessThan(5)
  })

  it('keeps a standing notice, naming what is waiting, once one of them has been saved', async () => {
    served = drifting('server.port', 'The socket this page arrived on is already bound.')
    renderPage()
    await loaded()

    const banner = screen.getByRole('status')
    expect(banner.textContent).toContain('waiting on a restart')
    expect(banner.textContent).toContain('server.port')
    // And it says the rest of the file is not waiting, which is the half a bare banner lost.
    expect(banner.textContent).toContain('already in use')
    expect(banner.textContent).toContain('./start.sh')
  })

  it('raises that notice after saving a setting that needs one', async () => {
    renderPage()
    await loaded()
    expect(screen.queryByRole('status')).toBeNull()

    fireEvent.change(control('server.port'), { target: { value: '8080' } })
    save()

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('server.port'))
    expect(screen.getByRole('status').textContent).toContain('./start.sh')
  })

  /** The behaviour change, stated as a test: saving a limit no longer raises the banner. */
  it('raises nothing after saving a setting that is already in force', async () => {
    renderPage()
    await loaded()

    fireEvent.change(control('limits.maxServers'), { target: { value: '12' } })
    save()

    await waitFor(() => expect(saves).toHaveLength(1))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('tells the operator beside the save button that saving applies, and offers the restart only when one is due', async () => {
    renderPage()
    await loaded()
    const actions = () => document.querySelector('.settings-actions')!.textContent
    expect(actions()).toContain('Saving applies straight away')
    expect(actions()).not.toContain('./start.sh')

    cleanup()
    served = drifting('server.port', 'The socket this page arrived on is already bound.')
    renderPage()
    await loaded()
    expect(document.querySelector('.settings-actions')!.textContent).toContain('./start.sh')
  })

  it('sets the commands the operator types in <code>, and still reads as one sentence (#232)', async () => {
    served = drifting('server.port', 'The socket this page arrived on is already bound.')
    renderPage()
    await loaded()

    for (const host of [document.querySelector('.settings-actions')!, screen.getByRole('status')]) {
      expect([...host.querySelectorAll('code')].map((el) => el.textContent)).toEqual(['Ctrl-C', './start.sh'])
      // The markup is the only thing that changed: the hint still reads as core wrote it.
      expect(host.textContent).toContain(VIEW.restartHint)
    }
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

/* ------------------------------------------------- issue #122: navigating the sections */

/**
 * ONE SECTION AT A TIME, AND THE INVENTORY DECIDES WHAT THE SECTIONS ARE.
 *
 * The claims here are the ones a reader of `SettingsPage.tsx` is asked to believe, and each is
 * checked as a property of the SERVED INVENTORY rather than of a list in the page: that the tabs
 * are the sections core sent, that a section core adds appears with its fields in it and nothing
 * in the page edited, that switching cannot lose something typed, and that a link and a rejected
 * save both put the operator on the right tab.
 *
 * The last of those is why the stub's inventory is not trimmed for these tests: the fixture is
 * the real shape, ten sections deep, one of them nested.
 */
describe('finding your way around the page', () => {
  /** The tab labels, in the order they are drawn. */
  const tabNames = () =>
    screen.getAllByRole('tab').map((tab) => tab.textContent?.replace(/●.*/, '').trim())

  const selected = () => screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true')

  const panelOf = (id: string) => document.getElementById(`settings-panel-${id}`)!

  it('draws a tab per section the server sent, in the server\'s order', async () => {
    renderPage()
    await loaded()

    // Eleven tabs for fourteen sections: `providers.byo.hosts` is inside `providers.byo`,
    // `registry.sources` inside `registry` and `ssh.keys` inside `ssh`, so each is a card on
    // its parent's tab rather than a tab beside it.
    expect(tabNames()).toEqual([
      'Server',
      'GitHub access tokens',
      'SSH public keys',
      'Hetzner',
      'AWS',
      'Azure',
      'Google Cloud',
      'Your own machines',
      'Limits',
      'Pack sources',
      'MCP',
    ])
    expect(selected()!.textContent).toContain('Server')
  })

  it('shows the section you chose and hides the one you left', async () => {
    renderPage()
    await loaded()

    expect(panelOf('server').hasAttribute('hidden')).toBe(false)
    expect(panelOf('limits').hasAttribute('hidden')).toBe(true)

    open('Limits')

    expect(panelOf('server').hasAttribute('hidden')).toBe(true)
    expect(panelOf('limits').hasAttribute('hidden')).toBe(false)
    expect(selected()!.textContent).toContain('Limits')
    // The nested section rides along with its parent rather than being lost between tabs.
    open('Your own machines')
    expect(panelOf('providers.byo').textContent).toContain('The machines Rocky Surf may claim')
  })

  it('opens the section a link names, so a reload comes back to where it was', async () => {
    renderPage('/settings?section=providers.aws')
    await loaded()

    expect(selected()!.textContent).toContain('AWS')
    expect(panelOf('providers.aws').hasAttribute('hidden')).toBe(false)
  })

  it('opens the tab that HOLDS a nested section a link names', async () => {
    renderPage('/settings?section=providers.byo.hosts')
    await loaded()

    expect(selected()!.textContent).toContain('Your own machines')
  })

  it('falls back to the first tab rather than a blank page when the link names nothing', async () => {
    renderPage('/settings?section=providers.nowhere')
    await loaded()

    expect(selected()!.textContent).toContain('Server')
  })

  it('moves between tabs with the arrow keys, and takes the selection with it', async () => {
    renderPage()
    await loaded()

    fireEvent.keyDown(selected()!, { key: 'ArrowDown' })
    expect(selected()!.textContent).toContain('GitHub access tokens')

    // Wrapping, both ways: a keyboard user arrowing off the top lands on the last tab.
    fireEvent.keyDown(selected()!, { key: 'ArrowUp' })
    fireEvent.keyDown(selected()!, { key: 'ArrowUp' })
    expect(selected()!.textContent).toContain('MCP')
  })

  /**
   * THE ONE THAT WOULD HURT. Ten sections behind one Save button means switching sections cannot
   * be allowed to drop what was typed on the one being left — and the operator has to be able to
   * tell that it did not, from the tab, without going back to look.
   */
  it('keeps what was typed on another section, and saves it from wherever you are', async () => {
    renderPage()
    await loaded()

    fireEvent.change(control('server.port'), { target: { value: '8080' } })
    open('Limits')
    fireEvent.change(control('limits.maxServers'), { target: { value: '9' } })

    // The tab left behind says it is holding something, in a sentence and not only in a dot.
    const serverTab = screen.getByRole('tab', { name: /^Server/ })
    expect(serverTab.textContent).toContain('has unsaved changes')
    expect(serverTab.querySelector('.tab-marker')).toBeTruthy()

    open('Server')
    expect(control('server.port').value).toBe('8080')

    save()
    expect((await onlySave()).changes).toEqual([
      { path: ['server', 'port'], value: 8080 },
      { path: ['limits', 'maxServers'], value: 9 },
    ])
  })

  it('goes to the tab holding a field the server refused, so the rejection is not off screen', async () => {
    nextSaveFailure = {
      status: 400,
      body: {
        error: 'limits.maxServers: must be at least 1',
        code: 'bad_request',
        issues: [{ path: 'limits.maxServers', message: 'must be at least 1' }],
      },
    }

    renderPage()
    await loaded()

    open('Limits')
    fireEvent.change(control('limits.maxServers'), { target: { value: '0' } })
    open('Server')
    save()

    await waitFor(() => expect(selected()!.textContent).toContain('Limits'))
    expect(panelOf('limits').textContent).toContain('must be at least 1')
  })

  /* ------------------------------------------------- the part issue #124 depends on */

  /**
   * A SECTION THIS PAGE HAS NEVER HEARD OF, from the inventory alone.
   *
   * This is the test of the whole design and the reason it is written this way: box-type
   * preferences (issue #124) are fields and a section in `settings/fields.ts`, and adding them
   * must not need an edit to `SettingsPage.tsx` to be reachable, editable and saveable. Nothing
   * below names a section this repository has today.
   */
  it('gives a section core added a tab of its own, with its fields in it', async () => {
    served.sections.push({
      id: 'boxes',
      title: 'Box types',
      help: 'What Small, Medium and Large mean at each provider.',
    })
    served.fields.push({
      path: 'boxes.small',
      kind: 'string',
      writable: true,
      appliesAt: 'save',
      help: 'The offering Small resolves to.',
    })
    served.fields.push({
      path: 'boxes.dedicated',
      kind: 'boolean',
      writable: true,
      appliesAt: 'save',
      help: 'Whether Small means a dedicated core.',
    })

    renderPage()
    await loaded()

    expect(tabNames()).toContain('Box types')
    open('Box types')
    expect(panelOf('boxes').textContent).toContain('What Small, Medium and Large mean')
    // Not merely listed: the boxes are the ordinary controls, chosen by `kind`, and they save.
    expect(control('boxes.dedicated').type).toBe('checkbox')
    fireEvent.change(control('boxes.small'), { target: { value: 'cx22' } })
    save()

    expect((await onlySave()).changes).toEqual([{ path: ['boxes', 'small'], value: 'cx22' }])
  })

  /**
   * THE SHAPE ISSUE #124 ACTUALLY SHIPPED, which the generic test above does not cover.
   *
   * `preferences.tiers` is not one flat section: it is a tab (`preferences`) with a card per
   * cloud nested inside it (`preferences.tiers.aws`, …), the same arrangement `providers.byo`
   * and `providers.byo.hosts` already use. What is checked here is that the nesting rule —
   * longest section id prefixing a field's path owns the field — puts each cloud's three boxes
   * on the right card and puts all of them behind one tab, and that a save names the path the
   * config file has. Still no edit to `SettingsPage.tsx`.
   */
  it('nests a section inside another one core added, and saves the real path', async () => {
    served.sections.push({
      id: 'preferences',
      title: 'Preferences',
      help: 'Your own answers, remembered, and re-read while Rocky Surf is running.',
    })
    for (const cloud of ['aws', 'gcp']) {
      served.sections.push({
        id: `preferences.tiers.${cloud}`,
        title: `${cloud.toUpperCase()} boxes`,
        help: `Which machine type each size means on ${cloud}, blank for the cheapest that fits.`,
      })
      for (const size of ['small', 'medium', 'large']) {
        served.fields.push({
          path: `preferences.tiers.${cloud}.${size}`,
          kind: 'string',
          writable: true,
          appliesAt: 'save',
          help: `The type to use whenever you ask ${cloud} for a ${size} box. Leave it blank for the default.`,
        })
      }
    }

    renderPage()
    await loaded()

    // ONE tab for seven sections' worth of new material — the clouds are cards on it, not tabs
    // beside it, exactly as `providers.byo.hosts` is a card on Your own machines.
    expect(tabNames()).toContain('Preferences')
    expect(tabNames()).not.toContain('AWS boxes')
    expect(tabNames()).not.toContain('GCP boxes')
    open('Preferences')

    // Each cloud's boxes are on its own card, chosen by the longest matching section id rather
    // than by the order the sections happen to be listed in.
    const card = (id: string) => document.querySelector(`[data-section="${id}"]`)
    expect(card('preferences.tiers.aws')!.textContent).toContain('Which machine type each size means on aws')
    expect(card('preferences.tiers.gcp')!.textContent).toContain('on gcp')
    // Both cards live in the one Preferences panel rather than in panels of their own.
    expect(panelOf('preferences').textContent).toContain('on gcp')

    fireEvent.change(control('preferences.tiers.aws.small'), { target: { value: 't4g.medium' } })
    save()

    expect((await onlySave()).changes).toEqual([
      { path: ['preferences', 'tiers', 'aws', 'small'], value: 't4g.medium' },
    ])
  })

  /* ------------------------------------------- the saved types are picked, not typed (#212) */

  /**
   * THE CATALOGUE UNDER EACH SAVED-TYPE BOX (issue #212).
   *
   * These boxes were free text over a vocabulary nobody remembers — `Standard_B2ps_v2` typed by
   * hand into the one place a typo is kept rather than corrected on the next screen. What is
   * asserted here is the wiring, not the table: the table is `MachineTypePicker`, tested against
   * the New Server page, and the claims that belong to THIS page are that a picked row lands in
   * the box, that the save names the path the configuration file has, that picking the saved row
   * again gets back to blank (the default) in one move, and that a cloud with no catalogue keeps
   * the box it has always had.
   */
  /** The sections and fields core generates for `preferences.tiers`, for the tests below. */
  function servePreferences(clouds: readonly string[] = ['aws']): void {
    served.sections.push({
      id: 'preferences',
      title: 'Preferences',
      help: 'Your own answers, remembered, and re-read while Rocky Surf is running.',
    })
    for (const cloud of clouds) {
      served.sections.push({
        id: `preferences.tiers.${cloud}`,
        title: cloud.toUpperCase(),
        help: `Which machine type each size means on ${cloud}, blank for the cheapest that fits.`,
      })
      for (const size of ['small', 'medium', 'large']) {
        served.fields.push({
          path: `preferences.tiers.${cloud}.${size}`,
          kind: 'string',
          writable: true,
          appliesAt: 'save',
          help: `The type to use whenever you ask ${cloud} for a ${size} box. Leave it blank for the default.`,
        })
      }
    }
  }

  /** One row of a cloud's catalogue, as `/providers` puts it on the wire. */
  const offering = (id: string, available = true) => ({
    id,
    cpu: 2,
    memoryGb: 4,
    arch: 'arm64',
    hourly: null,
    available,
    region: 'us-east-1',
  })

  /** One cloud, as `/providers` puts it on the wire. */
  const catalogue = (id: string, displayName: string, ids: readonly string[]) => ({
    id,
    displayName,
    capabilities: {
      stop: true,
      ipStableAcrossStop: false,
      canInjectHostKeys: false,
      userDataMaxBytes: 16384,
      generatesUserData: true,
    },
    offerings: ids.map((each) => offering(each)),
  })

  const fieldGroup = (path: string) => document.querySelector(`[data-field="${path}"]`) as HTMLElement

  /** Open the catalogue under one saved-type box, once it has arrived. */
  async function openCatalogue(path: string): Promise<HTMLElement> {
    const group = await waitFor(() => {
      const found = fieldGroup(path)
      expect(found.querySelector('details')).toBeTruthy()
      return found
    })
    fireEvent.click(within(group).getByRole('button', { name: /^Choose from/ }))
    // A `<details>` fires its `toggle` event as a queued task rather than during the click, so
    // the rows are one turn of the loop away from the click that asked for them.
    await waitFor(() => expect(within(group).queryByRole('table')).toBeTruthy())
    return group
  }

  /** Click Select (or Selected) on one row of an open catalogue. */
  const pick = (group: HTMLElement, id: string) =>
    fireEvent.click(within(within(group).getByRole('row', { name: new RegExp(id) })).getByRole('button'))

  it('offers the cloud’s own catalogue under a saved-type box, and saves what was picked', async () => {
    servePreferences()
    catalogues = [catalogue('aws', 'Amazon EC2', ['t4g.small', 't4g.large'])]

    renderPage()
    await loaded()
    open('Preferences')
    const group = await openCatalogue('preferences.tiers.aws.small')

    pick(group, 't4g.large')

    // The box IS the field: a picked row fills it, and the one Save button at the foot of the
    // page sends it like any other pending edit.
    expect(control('preferences.tiers.aws.small').value).toBe('t4g.large')
    save()
    expect((await onlySave()).changes).toEqual([
      { path: ['preferences', 'tiers', 'aws', 'small'], value: 't4g.large' },
    ])
  })

  it('gets back to blank — the cheapest that meets the floor — in one move', async () => {
    servePreferences()
    served.values.preferences = { tiers: { aws: { small: 't4g.large' } } }
    catalogues = [catalogue('aws', 'Amazon EC2', ['t4g.small', 't4g.large'])]

    renderPage()
    await loaded()
    open('Preferences')
    const group = await openCatalogue('preferences.tiers.aws.small')

    // The saved row reads as the selected one; clicking it again is how the preference is
    // dropped. Blank means the default, so the change on the wire is an `unset` rather than an
    // empty string — which is what would make the file hold "" as a machine type.
    pick(group, 't4g.large')

    expect(control('preferences.tiers.aws.small').value).toBe('')
    save()
    expect((await onlySave()).changes).toEqual([{ path: ['preferences', 'tiers', 'aws', 'small'], unset: true }])
  })

  it('keeps the free-text box for a cloud this installation has no catalogue for', async () => {
    servePreferences(['aws', 'gcp'])
    catalogues = [catalogue('aws', 'Amazon EC2', ['t4g.small'])]

    renderPage()
    await loaded()
    open('Preferences')
    await openCatalogue('preferences.tiers.aws.small')

    // GCP is in the file's inventory and not in this installation's providers — switched off,
    // or unreadable. The box still works, because a saved type is the operator's answer and a
    // missing catalogue is not a reason to stop them writing one down.
    expect(fieldGroup('preferences.tiers.gcp.small').querySelector('details')).toBeNull()
    fireEvent.change(control('preferences.tiers.gcp.small'), { target: { value: 'c4a-standard-4' } })
    save()
    expect((await onlySave()).changes).toEqual([
      { path: ['preferences', 'tiers', 'gcp', 'small'], value: 'c4a-standard-4' },
    ])
  })

  it('says so when the saved type is not in the catalogue, rather than showing nothing selected', async () => {
    servePreferences()
    served.values.preferences = { tiers: { aws: { small: 'm7i.metal-48xl' } } }
    catalogues = [catalogue('aws', 'Amazon EC2', ['t4g.small', 't4g.large'])]

    renderPage()
    await loaded()
    open('Preferences')

    const group = await waitFor(() => {
      const found = fieldGroup('preferences.tiers.aws.small')
      expect(found.querySelector('[data-tier-unlisted]')).toBeTruthy()
      return found
    })
    // Kept as written, and said in words: not an error, and not a silent empty list.
    expect(control('preferences.tiers.aws.small').value).toBe('m7i.metal-48xl')
    expect(group.textContent).toContain('is not currently offering m7i.metal-48xl')
  })

  /** A deep link straight to the Preferences tab — the link the New Server page points at. */
  it('opens Preferences from the link the New Server page uses', async () => {
    served.sections.push({
      id: 'preferences',
      title: 'Preferences',
      help: 'Your own answers, remembered, and re-read while Rocky Surf is running.',
    })
    served.fields.push({
      path: 'preferences.tiers.aws.small',
      kind: 'string',
      writable: true,
      appliesAt: 'save',
      help: 'The type to use whenever you ask AWS for a small box. Leave it blank for the default.',
    })

    renderPage('/settings?section=preferences')
    await loaded()

    expect(selected()!.textContent).toContain('Preferences')
  })

  /**
   * NO SECTION IS ALL PROSE AND NO CONTROLS — the general form of the `ssh.keys` bug.
   *
   * That bug shipped as: core declared a section and a list, the page had no hand-written block
   * for it, every field it covered was a `*` pattern excluded from the leftovers, and the card
   * rendered a heading and a paragraph of help promising an editor that was not there. Nothing
   * looked broken, which is why it reached an operator.
   *
   * So this walks EVERY tab core sends and insists each card either draws something or says
   * plainly that this build has no editor for it. It is the assertion that would have failed on
   * the shipped page, and it fails for the next section too, not only for this one.
   */
  it('never draws a card that is only prose, on any tab', async () => {
    renderPage()
    await loaded()

    const tabTitles = screen.getAllByRole('tab').map((tab) => tab.textContent ?? '')
    expect(tabTitles.length).toBeGreaterThan(5)

    for (const title of tabTitles) {
      fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }))
      const panel = document.querySelector('.settings-panel:not([hidden])')!
      for (const header of panel.querySelectorAll('[data-section]')) {
        const id = header.getAttribute('data-section')!
        const card = header.closest('section')!
        const controls = card.querySelectorAll('input, textarea, select, button')
        const explains = card.textContent!.includes('has no editor for this section')
        // A heading over nested cards draws nothing of its own, and that is not this fault.
        const isHeadingOverCards = served.sections.some((s) => s.id.startsWith(`${id}.`))
        expect(
          controls.length > 0 || explains || isHeadingOverCards,
          `the "${id}" card renders help text and no way to change anything`,
        ).toBe(true)
      }
    }
  })

  /**
   * A LIST CORE DECLARES THAT THIS BUILD HAS NEVER HEARD OF still gets an editor — the same
   * promise `humanize` makes for a field core adds, which lists did not have and needed.
   */
  it('draws a list core added that the page has no block for', async () => {
    served.sections.push({ id: 'notifications', title: 'Notifications', help: 'Where alerts go.' })
    served.fields.push(
      { path: 'notifications.targets.*.name', kind: 'string', writable: true, appliesAt: 'save', help: 'A label.' },
      { path: 'notifications.targets.*.webhookUrl', kind: 'string', writable: true, appliesAt: 'save', help: 'A URL.' },
    )
    served.lists.push({
      path: 'notifications.targets',
      itemFields: ['name', 'webhookUrl'],
      blank: { name: 'my-alerts', webhookUrl: '' },
      labelField: 'name',
      empty: 'None yet. Add one to be told when something happens.',
    })
    served.values['notifications'] = { targets: [{ name: 'oncall', webhookUrl: 'https://example.com/hook' }] }

    renderPage()
    await loaded()
    open('Notifications')

    expect(control('notifications.targets.0.name').value).toBe('oncall')
    // The label is the humanized field name — worse than a hand-written one, and vastly better
    // than the control not existing.
    expect(control('notifications.targets.0.webhookUrl').closest('.form-group')!.textContent).toContain('Webhook Url')

    fireEvent.click(within(panelOf('notifications')).getByRole('button', { name: 'Add' }))
    expect((await onlySave()).changes).toEqual([
      { path: ['notifications', 'targets', 1], value: { name: 'my-alerts', webhookUrl: '' } },
    ])
  })

  it('draws a field core added to a section it already knows, inside that section', async () => {
    served.fields.push({
      path: 'limits.maxRunningHours',
      kind: 'number',
      writable: true,
      appliesAt: 'save',
      help: 'How long a box may run before it is stopped.',
    })

    renderPage()
    await loaded()
    open('Limits')

    const box = control('limits.maxRunningHours')
    expect(box).toBeTruthy()
    expect(panelOf('limits').contains(box)).toBe(true)
    // The label it is given is its own path segment, which is what a spec carries — and the help
    // core wrote is on it like every other control's.
    expect(box.closest('.form-group')!.textContent).toContain('Max Running Hours')
    expect(box.closest('.form-group')!.textContent).toContain('How long a box may run')
  })

  it('finds a home for a field whose path no section claims, rather than dropping it', async () => {
    served.fields.push({
      path: 'telemetry.enabled',
      kind: 'boolean',
      writable: true,
      appliesAt: 'save',
      help: 'Whether anything is reported anywhere.',
    })

    renderPage()
    await loaded()

    // A section invented from the path's first segment: worse than a real `SectionSpec`, and far
    // better than a writable setting nobody can see.
    expect(tabNames()).toContain('Telemetry')
    open('Telemetry')
    expect(control('telemetry.enabled')).toBeTruthy()
  })

  it('says where to change a setting it has no control for, instead of offering a broken one', async () => {
    served.fields.push({
      path: 'limits.blockedRegions',
      kind: 'stringList',
      writable: true,
      appliesAt: 'save',
      help: 'Regions no server may be created in.',
    })
    ;(served.values['limits'] as Record<string, unknown>)['blockedRegions'] = ['eu-west-1']

    renderPage()
    await loaded()
    open('Limits')

    expect(panelOf('limits').textContent).toContain('eu-west-1')
    expect(panelOf('limits').textContent).toContain('no editor for a setting of this shape yet')
    expect(control('limits.blockedRegions')).toBeNull()
  })
})

/**
 * PACK SOURCES (issue #88).
 *
 * The list a person adds their own packs to. It was config-file-only, so getting your own pack
 * onto your own instance meant sshing in and hand-editing YAML; these tests are about what the
 * page sends when it is done here instead — an append of a whole entry, and a field edit that
 * names the entry it belongs to — plus the one sentence that must reach the screen, which is
 * what a URL in this box actually means.
 */
describe('pack sources', () => {
  const panelOf = (id: string) => document.getElementById(`settings-panel-${id}`)!

  it('draws the sources on their own tab, with the source already configured on it', async () => {
    renderPage()
    await loaded()
    open('Pack sources')

    expect(control('registry.enabled')).toBeTruthy()
    expect(control('registry.sources.0.url').value).toBe('https://raw.githubusercontent.com/x/shop/main')
    expect(control('registry.sources.0.trust').value).toBe('community')
  })

  it('says beside the URL box what a source actually is, before anyone pastes one in', async () => {
    // The warning is core's words, carried through unchanged. A URL box here is a box for
    // somebody else's root shell, and the page must not draw it as though it were a hostname.
    renderPage()
    await loaded()
    open('Pack sources')

    expect(control('registry.sources.0.url').closest('.form-group')!.textContent).toContain('run as ROOT')
  })

  it('adds a source as one whole entry appended to the list', async () => {
    renderPage()
    await loaded()
    open('Pack sources')

    fireEvent.click(within(panelOf('registry')).getByRole('button', { name: 'Add' }))

    expect((await onlySave()).changes).toEqual([
      {
        path: ['registry', 'sources', 1],
        value: { name: 'my-packs', url: 'https://example.com/my-pack.yaml', trust: 'community' },
      },
    ])
  })

  it('points an existing source at a personal pack file, naming the entry it edits', async () => {
    renderPage()
    await loaded()
    open('Pack sources')

    fireEvent.change(control('registry.sources.0.url'), {
      target: { value: 'https://packs.example.com/my-pack.yaml' },
    })
    save()

    expect((await onlySave()).changes).toEqual([
      { path: ['registry', 'sources', 0, 'url'], value: 'https://packs.example.com/my-pack.yaml' },
    ])
  })
})

/**
 * YOUR OWN SSH PUBLIC KEYS (issue #302).
 *
 * The list the New Server page's picker offers. Three things matter enough to pin: the key is
 * drawn as a READABLE box rather than a masked one — it is published material, and masking it
 * would hide the value the operator compares against `~/.ssh/*.pub` while implying Rocky Surf
 * is keeping a secret for them; the warning about the private half reaches the screen; and Add
 * appends an entry with an EMPTY key, because the alternative — a plausible-looking placeholder
 * — would either be refused by core or, worse, be a real key somebody else holds the other half
 * of.
 */
describe('saved SSH public keys', () => {
  const panelOf = (id: string) => document.getElementById(`settings-panel-${id}`)!

  it('draws the saved key on its own tab, readable, not masked', async () => {
    renderPage()
    await loaded()
    open('SSH public keys')

    expect(control('ssh.keys.0.name').value).toBe('laptop')
    expect(control('ssh.keys.0.publicKey').value).toBe('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKPX laptop')
  })

  it('says beside the box that the private half must never go in it', async () => {
    renderPage()
    await loaded()
    open('SSH public keys')

    expect(control('ssh.keys.0.publicKey').closest('.form-group')!.textContent).toContain('Never paste a private key')
  })

  it('adds an entry with no key in it, rather than a placeholder somebody holds', async () => {
    renderPage()
    await loaded()
    open('SSH public keys')

    fireEvent.click(within(panelOf('ssh')).getByRole('button', { name: 'Add' }))

    expect((await onlySave()).changes).toEqual([
      { path: ['ssh', 'keys', 1], value: { name: 'my-laptop', publicKey: '' } },
    ])
  })

  it('saves a pasted key against the entry it belongs to', async () => {
    renderPage()
    await loaded()
    open('SSH public keys')

    const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB4nOEqLQMPa6QK8 desktop'
    fireEvent.change(control('ssh.keys.0.publicKey'), { target: { value: KEY } })
    save()

    expect((await onlySave()).changes).toEqual([{ path: ['ssh', 'keys', 0, 'publicKey'], value: KEY }])
  })

  it('removes a key', async () => {
    renderPage()
    await loaded()
    open('SSH public keys')

    fireEvent.click(within(panelOf('ssh')).getByRole('button', { name: 'Remove' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }))

    expect((await onlySave()).changes).toEqual([{ path: ['ssh', 'keys', 0], unset: true }])
  })

  it('shows core refusal of a private key against the box it was pasted into', async () => {
    // Core's sentence, on the field, not in a banner: the operator has to see which box is
    // wrong, and the message tells them to rotate what they just copied.
    nextSaveFailure = {
      status: 400,
      body: {
        error: 'ssh.keys.0.publicKey: that is a PRIVATE key…',
        code: 'bad_request',
        issues: [
          {
            path: 'ssh.keys.0.publicKey',
            message:
              'that is a PRIVATE key, and it must never be pasted here or stored by Rocky Surf. ' +
              'Paste the PUBLIC half instead — the file ending in `.pub`.',
          },
        ],
      },
    }
    renderPage()
    await loaded()
    open('SSH public keys')

    fireEvent.change(control('ssh.keys.0.publicKey'), { target: { value: '-----BEGIN OPENSSH PRIVATE KEY-----' } })
    save()

    const group = await waitFor(() => {
      const found = control('ssh.keys.0.publicKey').closest('.form-group')!
      expect(found.textContent).toContain('PRIVATE key')
      return found
    })
    expect(group.textContent).toContain('.pub')
  })

  /**
   * THE STATE THE BUG WAS ACTUALLY SEEN IN (issue #302 follow-up).
   *
   * Every test above this one runs against a list that already has an entry, and all of them
   * passed while the shipped page showed an operator with NO saved keys two boxes of prose and
   * no way to add one. An empty list is what every installation starts in, so it is the case
   * that had to be pinned and was not.
   */
  it('offers a way to add the first key when none are saved', async () => {
    served.values['ssh'] = { keys: [] }
    renderPage()
    await loaded()
    open('SSH public keys')

    const panel = panelOf('ssh')
    expect(within(panel).getByRole('button', { name: 'Add' })).toBeTruthy()
    expect(panel.textContent).toContain('None yet')

    fireEvent.click(within(panel).getByRole('button', { name: 'Add' }))
    expect((await onlySave()).changes).toEqual([
      { path: ['ssh', 'keys', 0], value: { name: 'my-laptop', publicKey: '' } },
    ])
  })

  it('offers a way to add the first key when the file has no ssh block at all', async () => {
    // A config file that has never mentioned `ssh:` — which is every file until this feature is
    // used once. `values.ssh` is then absent entirely, not an empty list.
    delete served.values['ssh']
    renderPage()
    await loaded()
    open('SSH public keys')

    expect(within(panelOf('ssh')).getByRole('button', { name: 'Add' })).toBeTruthy()
  })
})


/**
 * The SSH whitelist editor (issue #304).
 *
 * Rendered rather than reasoned about: the incident this repository had on the very day this
 * shipped was a settings section that looked populated — heading, help text — and had no working
 * control in it at all, because `SETTINGS_LISTS` was declared and read by nothing. So these
 * tests drive the actual DOM the operator gets.
 */
describe('the SSH whitelist editor', () => {
  const AWS = 'AWS'
  const cidrBlock = () => document.querySelector('[data-field="providers.aws.sshAllowedCidr"]') as HTMLElement

  function withCidrs(cidrs: string[] | string) {
    served.values.providers = {
      ...(served.values.providers as Record<string, unknown>),
      aws: { enabled: true, region: 'us-east-1', sshAllowedCidr: cidrs },
    }
  }

  it('draws one removable entry per network, plus a box to add another', async () => {
    withCidrs(['203.0.113.7/32', '198.51.100.0/24'])
    renderPage()
    await loaded()
    open(AWS)

    const block = within(cidrBlock())
    expect(block.getByText('203.0.113.7/32')).toBeTruthy()
    expect(block.getByText('198.51.100.0/24')).toBeTruthy()
    expect(block.getAllByRole('button', { name: 'Remove' })).toHaveLength(2)
    expect(block.getByRole('button', { name: 'Add' })).toBeTruthy()
  })

  it('still draws a pre-#304 single CIDR, because an existing file says one string', async () => {
    withCidrs('203.0.113.7/32')
    renderPage()
    await loaded()
    open(AWS)
    expect(within(cidrBlock()).getByText('203.0.113.7/32')).toBeTruthy()
  })

  /** An empty list means SSH reachable from nowhere, and is almost never what was meant. */
  it('will not remove the last network, and says why', async () => {
    withCidrs(['203.0.113.7/32'])
    renderPage()
    await loaded()
    open(AWS)

    const remove = within(cidrBlock()).getByRole('button', { name: 'Remove' }) as HTMLButtonElement
    expect(remove.disabled).toBe(true)
    expect(remove.title).toMatch(/add the replacement first/)
  })

  it('warns what removing a network actually does before doing it', async () => {
    withCidrs(['203.0.113.7/32', '198.51.100.0/24'])
    renderPage()
    await loaded()
    open(AWS)

    fireEvent.click(within(cidrBlock()).getAllByRole('button', { name: 'Remove' })[1]!)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/immediately ends new SSH connections from that network/)
    expect(dialog.textContent).toMatch(/existing sessions survive/)
  })

  it('adds a typed network to the list', async () => {
    withCidrs(['203.0.113.7/32'])
    renderPage()
    await loaded()
    open(AWS)

    const block = within(cidrBlock())
    fireEvent.change(block.getByLabelText('Add a network for aws'), { target: { value: '198.51.100.0/24' } })
    fireEvent.click(block.getByRole('button', { name: 'Add' }))
    expect(within(cidrBlock()).getByText('198.51.100.0/24')).toBeTruthy()
  })

  /**
   * The two-act guard, which until now had NO control on this page at all: `allowAllCidr` was
   * absent from the field inventory, so the save route refused any request naming it and the one
   * procedure SECURITY.md and the provider docs describe could not be carried out here.
   */
  it('confirms 0.0.0.0/0 before adding it, then asks for the second act', async () => {
    withCidrs(['203.0.113.7/32'])
    renderPage()
    await loaded()
    open(AWS)

    expect(document.getElementById('providers.aws.allowAllCidr')).toBeNull()

    fireEvent.change(within(cidrBlock()).getByLabelText('Add a network for aws'), {
      target: { value: '0.0.0.0/0' },
    })
    fireEvent.click(within(cidrBlock()).getByRole('button', { name: 'Add' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/every address on the internet/i)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 0.0.0.0/0' }))

    await waitFor(() => expect(within(cidrBlock()).getByText('0.0.0.0/0')).toBeTruthy())
    // And only now does the second act appear.
    expect(document.getElementById('providers.aws.allowAllCidr')).toBeTruthy()
  })
})


describe('pushing the SSH whitelist at the clouds (issue #304)', () => {
  const AWS = 'AWS'
  const pushButton = () => screen.getByRole('button', { name: 'Push SSH access to the clouds' })

  function withCidrs(cidrs: string[]) {
    served.values.providers = {
      ...(served.values.providers as Record<string, unknown>),
      aws: { enabled: true, region: 'us-east-1', sshAllowedCidr: cidrs },
    }
  }

  it('pushes automatically after a save that changed a list, and shows what each cloud did', async () => {
    withCidrs(['203.0.113.7/32'])
    renderPage()
    await loaded()
    open(AWS)

    const block = within(document.querySelector('[data-field="providers.aws.sshAllowedCidr"]') as HTMLElement)
    fireEvent.change(block.getByLabelText('Add a network for aws'), { target: { value: '198.51.100.0/24' } })
    fireEvent.click(block.getByRole('button', { name: 'Add' }))
    save()

    await waitFor(() => expect(syncCalls).toBe(1))
    expect(await screen.findByText('SSH access at the cloud')).toBeTruthy()
    expect(document.body.textContent).toContain('Authorized 203.0.113.7/32.')
  })

  it('does not push after a save that had nothing to do with SSH access', async () => {
    renderPage()
    await loaded()
    fireEvent.change(control('limits.maxServers'), { target: { value: '9' } })
    save()

    await waitFor(() => expect(saves).toHaveLength(1))
    expect(syncCalls).toBe(0)
  })

  /**
   * The repair path. A cloud can be wrong while the file is right — GCP's firewall rule only
   * ever read `sshAllowedCidr` at create time — and no save would ever fix that, because
   * nothing about it is a change. So the button does not wait for one.
   */
  it('pushes on demand, with nothing edited', async () => {
    renderPage()
    await loaded()
    fireEvent.click(pushButton())

    await waitFor(() => expect(syncCalls).toBe(1))
    expect(saves).toHaveLength(0)
    expect(await screen.findByText('SSH access at the cloud')).toBeTruthy()
  })

  it('names the cloud that refused, and keeps its remediation on the page', async () => {
    syncResponse = {
      synced: [
        {
          provider: 'gcp',
          status: 'failed',
          applied: [],
          reported: [],
          detail: 'compute.firewalls.update is missing. Run: gcloud compute firewall-rules update rockysurf-ssh --source-ranges=203.0.113.7/32',
        },
      ],
    }
    renderPage()
    await loaded()
    fireEvent.click(pushButton())

    await waitFor(() => expect(syncCalls).toBe(1))
    // The command has to survive on the page — a toast is not something you can copy from twice.
    expect(await screen.findByText(/gcloud compute firewall-rules update/)).toBeTruthy()
  })
})
