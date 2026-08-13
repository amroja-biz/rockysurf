import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'
import { createApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { configSchema } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { makeFakeProvider } from '../providers/fake.js'
import { ProviderRegistry } from '../providers/registry.js'
import { createSecretsStore } from '../secrets/store.js'
import { createEventsService } from '../services/events.js'
import type { ConfiguredScope, RepositoryResolution } from './resolve.js'

/**
 * THE CREATE SCREEN'S LIVE TOKEN DISPLAY, through the route the SPA actually calls
 * (rockysurf-18lq).
 *
 * A REAL FORGE ON 127.0.0.1, for the same reason `preflight.test.ts` uses one: the question this
 * endpoint answers is partly a network question, and a fixture that mocked the fetch layer would
 * prove nothing about whether a public repository is distinguishable from a private one. The
 * forge below answers the real smart-HTTP discovery request and behaves like GitHub does — 401
 * for a private path without the right credential, 200 for a public one with no credential at
 * all.
 *
 * WHAT IS BEING PROVED. Not that a matcher matches: `token-matching.test.ts` does that, against
 * the real shell program. What is proved here is the WIRING and the DISCRETION — that the route
 * exists, that it is composed with this installation's real token table and its real config file,
 * that it separates the four states a user can be in, and that a token VALUE cannot come out of
 * it in any of them.
 */

const PASSWORD = 'correct-horse-battery-staple'
const TOKEN = 'ghp_scoped_secret_value'
const FALLBACK = 'ghp_fallback_secret_value'

let forge: HttpServer
let forgePort: number
let asked: string[]

beforeEach(async () => {
  asked = []
  forge = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    asked.push(url.pathname)
    const authorized =
      req.headers.authorization === `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`
    const advertise = () =>
      res
        .writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' })
        .end('001e# service=git-upload-pack\n')

    // Public: opens for anybody, including a request carrying no credential at all.
    if (url.pathname === '/opensource/tool.git/info/refs') return void advertise()
    // Private, and covered by the scoped entry.
    if (url.pathname === '/acme/widgets.git/info/refs') return void (authorized ? advertise() : res.writeHead(401).end())
    // Private, and covered by nothing — the state that used to reach the box as a failed clone.
    if (url.pathname === '/stranger/secrets.git/info/refs') return void res.writeHead(401).end()
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => forge.listen(0, '127.0.0.1', resolve))
  forgePort = (forge.address() as AddressInfo).port
})

afterEach(async () => {
  await new Promise<void>((resolve) => {
    forge.closeAllConnections?.()
    forge.close(() => resolve())
  })
})

const repoUrl = (path: string) => `http://127.0.0.1:${forgePort}/${path}`
const forgeHost = () => `127.0.0.1:${forgePort}`

let opened: OpenedDatabase
let created: ReturnType<typeof createApp>
let cookie: string
let dir: string

/**
 * Boot an app whose RUNNING config and whose config FILE can deliberately disagree.
 *
 * That gap is not exotic — it is the state of every installation between a save on the settings
 * page and its next restart, and it is the state rockysurf-1z5q's whole bug lived in. By DEFAULT
 * they agree, because that is what `boot()` guarantees at startup and it is the state a test
 * about anything else wants to be in; `file` is how a test creates the drift on purpose.
 */
async function build(options: { config: Record<string, unknown>; file?: string; env?: NodeJS.ProcessEnv }) {
  opened = openTestDatabase()
  dir = mkdtempSync(join(tmpdir(), 'rockysurf-resolve-'))
  const configPath = join(dir, 'rockysurf.config.yaml')
  writeFileSync(configPath, options.file ?? stringifyYaml(options.config))

  const secrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })
  created = createApp({
    db: opened.db,
    config: configSchema.parse(options.config),
    secrets,
    secretsStore: createSecretsStore(opened.db, randomBytes(32)),
    events: createEventsService(),
    providers: new ProviderRegistry([makeFakeProvider()]),
    configPath,
    ...(options.env ? { env: options.env } : {}),
  })
  const login = await created.app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
}

afterEach(() => opened?.close())

/** The route the create form calls on every debounced keystroke. */
async function resolve(urls: string[], withCookie = true) {
  const res = await created.app.request('/api/v1/git/resolve-repositories', {
    method: 'POST',
    headers: { ...(withCookie ? { cookie } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ urls }),
  })
  const text = await res.text()
  return { status: res.status, text, body: JSON.parse(text) as { resolutions?: RepositoryResolution[] } }
}

const only = (body: { resolutions?: RepositoryResolution[] }): RepositoryResolution => body.resolutions![0]!

/** The config an operator with a self-hosted forge and one repository token would have written. */
const scopedOnly = () => ({ github: { tokens: [{ host: forgeHost(), owner: 'acme', pat: TOKEN }] } })

describe('the four states the create screen can be in', () => {
  it('names the scope of the token a matching repository will use', async () => {
    await build({ config: scopedOnly() })
    const one = only((await resolve([repoUrl('acme/widgets.git')])).body)

    expect(one.live).toEqual({ kind: 'scoped', scope: `${forgeHost()}/acme/*` })
    expect(one.reachable).toBe('ok')
    expect(one.pending).toBeUndefined()
  })

  it('says a repository is reachable with NO token, which is what public means', async () => {
    // The state the bead insists cannot be decided in the browser: nothing about the URL says
    // whether it is public, and the only way to know is to ask the forge the way git would.
    await build({ config: scopedOnly() })
    const one = only((await resolve([repoUrl('opensource/tool.git')])).body)

    expect(one.live).toEqual({ kind: 'none' })
    expect(one.reachable).toBe('ok')
    // Asked anonymously — the whole basis of the claim.
    expect(asked).toEqual(['/opensource/tool.git/info/refs'])
  })

  it('separates “no token matches” from “a token was tried and refused”', async () => {
    await build({ config: scopedOnly() })
    const unmatched = only((await resolve([repoUrl('stranger/secrets.git')])).body)

    expect(unmatched.live).toEqual({ kind: 'none' })
    expect(unmatched.reachable).toBe('refused')
    // k6xp's certainty, not a list of maybes: core ran the box's own rules and got nothing.
    expect(unmatched.code).toBe('no_matching_token')
    expect(unmatched.reason).toContain('No configured token matches')
  })

  it('reports the instance-wide fallback as itself, not as a scoped match', async () => {
    // A user needs to be able to tell "covered by the token for this repository" from "covered
    // by the general one", because they are different promises about what will be sent.
    await build({ config: { github: { pat: FALLBACK, tokens: [{ host: forgeHost(), owner: 'acme', pat: TOKEN }] } } })
    const one = only((await resolve([repoUrl('stranger/secrets.git')])).body)

    expect(one.live.kind).toBe('fallback')
    expect(one.live.scope).toBeUndefined()
  })

  it('refuses a malformed URL in the preflight’s own words, without contacting anything', async () => {
    await build({ config: scopedOnly() })
    const one = only((await resolve(['git@github.com:acme/widgets.git'])).body)

    expect(one.reachable).toBe('refused')
    expect(one.code).toBe('unsupported_scheme')
    expect(one.reason).toContain('is an SSH remote')
    expect(asked).toEqual([])
  })
})

describe('a token the file holds and this process does not (rockysurf-1z5q)', () => {
  /** The file after a settings save that added an entry: present on disk, absent from memory. */
  const fileWithPending = () =>
    [
      'github:',
      '  tokens:',
      `    - host: ${forgeHost()}`,
      '      owner: acme',
      `      pat: "${TOKEN}"`,
      `    - host: ${forgeHost()}`,
      '      repo: "stranger/secrets"',
      '      pat: "${STRANGER_PAT}"',
      '',
    ].join('\n')

  it('says the entry exists and names the variable it is waiting on', async () => {
    // Without this, the screen tells the person who just added the token that there is no token
    // — which is false, and is the least useful sentence available to it.
    await build({ config: scopedOnly(), file: fileWithPending(), env: {} })
    const one = only((await resolve([repoUrl('stranger/secrets.git')])).body)

    // A box created NOW still gets nothing: the running process has not read the new entry.
    expect(one.live).toEqual({ kind: 'none' })
    // ...and the reason it will not stay that way is stated, by name.
    expect(one.pending).toEqual({
      kind: 'scoped',
      scope: `${forgeHost()}/stranger/secrets`,
      envVar: 'STRANGER_PAT',
      envVarSet: false,
    })
  })

  it('distinguishes “saved but not exported” from “saved and exported”', async () => {
    // The same file, one variable set. The entry is still pending — this process has not
    // restarted — but the restart it is waiting for will now succeed rather than refuse.
    await build({ config: scopedOnly(), file: fileWithPending(), env: { STRANGER_PAT: 'ghp_exported' } })
    const one = only((await resolve([repoUrl('stranger/secrets.git')])).body)

    expect(one.pending?.envVarSet).toBe(true)
    expect(one.pending?.envVar).toBe('STRANGER_PAT')
  })

  it('says nothing about pending when the file and the process agree', async () => {
    // The ordinary case, and the one that must stay quiet: a warning shown on every line would
    // be a warning nobody reads.
    await build({
      config: scopedOnly(),
      file: ['github:', '  tokens:', `    - host: ${forgeHost()}`, '      owner: acme', `      pat: "${TOKEN}"`, ''].join('\n'),
    })
    const one = only((await resolve([repoUrl('acme/widgets.git')])).body)

    expect(one.pending).toBeUndefined()
  })

  it('names the variable a LIVE entry came from, which only the file remembers', async () => {
    // The running config holds the interpolated value and cannot say where it came from. The
    // name is what an operator needs in order to rotate it, and a name is not a credential —
    // `settings/view.ts` returns them in full on exactly that reasoning.
    await build({
      config: scopedOnly(),
      file: [
        'github:',
        '  tokens:',
        `    - host: ${forgeHost()}`,
        '      owner: acme',
        '      pat: "${ACME_PAT}"',
        '',
      ].join('\n'),
      env: { ACME_PAT: TOKEN },
    })
    const one = only((await resolve([repoUrl('acme/widgets.git')])).body)

    expect(one.live).toEqual({
      kind: 'scoped',
      scope: `${forgeHost()}/acme/*`,
      envVar: 'ACME_PAT',
      envVarSet: true,
    })
    expect(one.pending).toBeUndefined()
  })
})

describe('what the endpoint refuses to say, and who may ask', () => {
  it('never returns a token value, in any state', async () => {
    await build({
      config: { github: { pat: FALLBACK, tokens: [{ host: forgeHost(), owner: 'acme', pat: TOKEN }] } },
      file: ['github:', `  pat: "${FALLBACK}"`, '  tokens:', `    - host: ${forgeHost()}`, '      owner: acme', `      pat: "${TOKEN}"`, ''].join('\n'),
    })
    // Every branch at once: a scoped match, the fallback, a refusal and a shape failure.
    const res = await resolve([
      repoUrl('acme/widgets.git'),
      repoUrl('stranger/secrets.git'),
      repoUrl('opensource/tool.git'),
      'nonsense',
    ])

    expect(res.status).toBe(200)
    expect(res.text).not.toContain(TOKEN)
    expect(res.text).not.toContain(FALLBACK)
  })

  it('requires a session, like every other /api/v1 route', async () => {
    await build({ config: scopedOnly() })
    expect((await resolve([repoUrl('acme/widgets.git')], false)).status).toBe(401)
    expect(asked).toEqual([])
  })

  it('caps how many URLs one request may fan out to', async () => {
    await build({ config: scopedOnly() })
    const many = Array.from({ length: 11 }, (_, i) => repoUrl(`acme/repo-${i}`))
    expect((await resolve(many)).status).toBe(400)
    expect(asked).toEqual([])
  })

  it('answers a whole box of URLs in one round trip, in the order they were sent', async () => {
    await build({ config: scopedOnly() })
    const res = await resolve([repoUrl('acme/widgets.git'), repoUrl('opensource/tool.git')])

    expect(res.body.resolutions).toHaveLength(2)
    expect(res.body.resolutions![0]!.live.kind).toBe('scoped')
    expect(res.body.resolutions![1]!.live.kind).toBe('none')
  })
})

/**
 * WHAT THE CREATE FORM MAY OFFER (rockysurf-mh8f).
 *
 * The owner's point: the Settings entries already NAME repositories, so the create screen should
 * offer them rather than make somebody retype them. This endpoint is what it offers, and the
 * property under test is the JUDGEMENT — which entries name a URL and which only name an account
 * — plus the same two guarantees the sibling route carries: never a value, never without a
 * session. It probes nothing, so there is no forge traffic to assert here beyond its absence.
 */
describe('the repository picker’s data (rockysurf-mh8f)', () => {
  async function scopes(withCookie = true) {
    const res = await created.app.request('/api/v1/git/configured-scopes', {
      headers: withCookie ? { cookie } : {},
    })
    const text = await res.text()
    return { status: res.status, text, list: (JSON.parse(text) as { scopes?: ConfiguredScope[] }).scopes ?? [] }
  }

  it('offers an owner+repo entry as a clone URL, which is the whole point of the picker', async () => {
    await build({ config: { github: { tokens: [{ repo: 'acme/private-thing', pat: TOKEN }] } } })
    const { list } = await scopes()

    expect(list).toEqual([
      {
        kind: 'repository',
        scope: 'github.com/acme/private-thing',
        label: 'acme/private-thing',
        url: 'https://github.com/acme/private-thing',
        state: 'live',
      },
    ])
    expect(asked).toEqual([])
  })

  it('gives an account and a forge entry no URL, because neither names a repository', async () => {
    // The design decision this bead had to make. An account entry names an account, and v0.1 has
    // no way to list what is under one — so it is stated on the form, never inserted.
    await build({
      config: { github: { tokens: [{ owner: 'acme', pat: TOKEN }, { host: 'git.example.com', pat: TOKEN }] } },
    })
    const { list } = await scopes()

    expect(list.map((s) => [s.kind, s.label, s.url])).toEqual([
      ['account', 'acme', undefined],
      ['host', 'git.example.com', undefined],
    ])
  })

  it('names the host when it is not github.com, since the label is all a chip shows', async () => {
    await build({ config: { github: { tokens: [{ host: 'git.example.com', repo: 'acme/widgets', pat: TOKEN }] } } })
    const { list } = await scopes()

    expect(list[0]!.label).toBe('acme/widgets on git.example.com')
    // HTTPS always: the box clones with a token in a Basic header and is never given an SSH key,
    // which is why k6xp refuses `git@…` and why this form's placeholder stopped teaching it.
    expect(list[0]!.url).toBe('https://git.example.com/acme/widgets')
  })

  it('lists the instance-wide fallback last, and only when there is one', async () => {
    await build({ config: { github: { pat: FALLBACK, tokens: [{ repo: 'acme/widgets', pat: TOKEN }] } } })
    const withFallback = await scopes()
    expect(withFallback.list.map((s) => s.kind)).toEqual(['repository', 'fallback'])
    expect(withFallback.list[1]).toEqual({ kind: 'fallback', scope: '*', state: 'live' })

    await build({ config: { github: { tokens: [{ repo: 'acme/widgets', pat: TOKEN }] } } })
    expect((await scopes()).list.map((s) => s.kind)).toEqual(['repository'])
  })

  it('offers nothing at all when nothing is configured, so the form grows no new chrome', async () => {
    await build({ config: {} })
    expect((await scopes()).list).toEqual([])
  })

  it('names the variable an entry is drawn from, which only the file remembers', async () => {
    await build({
      config: { github: { pat: FALLBACK, tokens: [{ repo: 'acme/widgets', pat: TOKEN }] } },
      file: [
        'github:',
        '  pat: "${GITHUB_PAT}"',
        '  tokens:',
        '    - repo: "acme/widgets"',
        '      pat: "${ACME_PAT}"',
        '',
      ].join('\n'),
      env: { GITHUB_PAT: FALLBACK, ACME_PAT: TOKEN },
    })
    const { list } = await scopes()

    expect(list[0]).toMatchObject({ envVar: 'ACME_PAT', envVarSet: true, state: 'live' })
    expect(list[1]).toMatchObject({ kind: 'fallback', envVar: 'GITHUB_PAT', envVarSet: true })
  })

  it('offers a token the FILE holds and this process does not, marked as needing a restart', async () => {
    // The moment the picker exists for: the operator has just saved the entry in Settings and
    // come straight here. An empty picker would be the least useful answer available.
    await build({
      config: {},
      file: ['github:', '  tokens:', '    - repo: "acme/private-thing"', '      pat: "${ACME_PAT}"', ''].join('\n'),
      env: {},
    })
    const { list } = await scopes()

    expect(list).toEqual([
      {
        kind: 'repository',
        scope: 'github.com/acme/private-thing',
        label: 'acme/private-thing',
        url: 'https://github.com/acme/private-thing',
        envVar: 'ACME_PAT',
        envVarSet: false,
        state: 'pending',
      },
    ])
  })

  it('calls an entry live when both tables hold it, because that is what a box gets now', async () => {
    await build({
      config: { github: { tokens: [{ repo: 'acme/widgets', pat: TOKEN }] } },
      file: ['github:', '  tokens:', '    - repo: "acme/widgets"', `      pat: "${TOKEN}"`, ''].join('\n'),
    })
    const { list } = await scopes()

    expect(list).toHaveLength(1)
    expect(list[0]!.state).toBe('live')
  })

  it('never returns a token value, and needs a session like every other /api/v1 route', async () => {
    await build({
      config: { github: { pat: FALLBACK, tokens: [{ repo: 'acme/widgets', pat: TOKEN }] } },
      file: ['github:', `  pat: "${FALLBACK}"`, '  tokens:', '    - repo: "acme/widgets"', `      pat: "${TOKEN}"`, ''].join('\n'),
    })

    const ok = await scopes()
    expect(ok.status).toBe(200)
    expect(ok.text).not.toContain(TOKEN)
    expect(ok.text).not.toContain(FALLBACK)

    expect((await scopes(false)).status).toBe(401)
  })
})
