import { randomBytes } from 'node:crypto'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { configSchema } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { servers } from '../db/schema.js'
import { makeFakeProvider } from '../providers/fake.js'
import { ProviderRegistry } from '../providers/registry.js'
import { createSecretsStore } from '../secrets/store.js'
import { createEventsService } from '../services/events.js'
import { preflightRepository } from './preflight.js'
import { selectToken } from './token-matching.js'

/**
 * A REPOSITORY URL IS CHECKED BEFORE AN INSTANCE IS LAUNCHED (rockysurf-k6xp).
 *
 * The owner's live test cost a full EC2 boot and a full bootstrap to discover a one-character
 * typo, because the clone is nearly the last step a pack runs — and the box that discovered it
 * kept running and kept billing (4byx). This is the fail-early half.
 *
 * THE FORGE HERE IS A REAL HTTP SERVER answering the real smart-HTTP discovery request, on
 * 127.0.0.1. That address is exactly what the SSRF guard exists to refuse, which makes it the
 * right fixture twice over: the tests that expect a probe configure `github.tokens` with that
 * host, so the operator has vouched for it the way a self-hosted forge is vouched for, and the
 * test that expects a REFUSAL leaves it unconfigured and gets the guard's answer. Nothing is
 * mocked at the fetch layer, so the header the probe sends and the status it reads are the real
 * ones.
 */

const PASSWORD = 'correct-horse-battery-staple'
const TOKEN = 'ghp_forge_token'

let forge: HttpServer
let forgePort: number
/** Every discovery request the forge received, so the credential can be asserted on. */
let asked: Array<{ path: string; authorization: string | undefined }>

beforeEach(async () => {
  asked = []
  forge = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    asked.push({ path: url.pathname, authorization: req.headers.authorization })

    const authorized = req.headers.authorization === `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`

    /*
     * GitHub's own smart-HTTP behaviour, which is what makes this fixture worth having.
     *
     * A PRIVATE repository answers 401 to an unauthenticated request — that 401 is exactly what
     * makes git prompt for a username, and on a headless box with no TTY that prompt is the
     * `could not read Username for ...: No such device or address` the owner saw (ldo1). It
     * answers 401 to a WRONG token too, and 200 to the right one.
     *
     * Everything else is 404, standing in for the ambiguous case: GitHub answers 404 for "no
     * such repository" and for "private and not yours" alike, deliberately, so that a token
     * cannot be used to enumerate private repositories.
     */
    if (url.pathname === '/acme/private-thing.git/info/refs') {
      return void (authorized
        ? res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' }).end('001e# service=git-upload-pack\n')
        : res.writeHead(401).end())
    }
    if (url.pathname !== '/acme/widgets.git/info/refs') return void res.writeHead(404).end()
    if (!authorized) return void res.writeHead(401).end()
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' })
    res.end('001e# service=git-upload-pack\n')
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

/** The config an operator with a self-hosted forge on that port would have written. */
const forgeConfig = () => ({ github: { tokens: [{ host: `127.0.0.1:${forgePort}`, pat: TOKEN }] } })

/* --------------------------------------------------------------- the check on its own */

describe('what the preflight decides, and what it says', () => {
  const deps = () => ({ tokens: configSchema.parse(forgeConfig()).github.tokens })

  it('passes a URL the forge opens with the token the box would use', async () => {
    expect(await preflightRepository(repoUrl('acme/widgets.git'), deps())).toEqual({
      ok: true,
      url: repoUrl('acme/widgets.git'),
    })
    // The discovery request git itself sends, with the credential the helper would print.
    expect(asked).toEqual([
      { path: '/acme/widgets.git/info/refs', authorization: expect.stringMatching(/^Basic /) },
    ])
  })

  it('adds the .git suffix a browser URL does not carry', async () => {
    expect((await preflightRepository(repoUrl('acme/widgets'), deps())).ok).toBe(true)
    expect(asked[0]!.path).toBe('/acme/widgets.git/info/refs')
  })

  it('refuses a typo, names the URL, and names the three causes', async () => {
    const result = await preflightRepository(repoUrl('acme/widgts.git'), deps())
    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.code).toBe('not_found')
    expect(result.reason).toContain(repoUrl('acme/widgts.git'))
    expect(result.reason).toContain('a typo in the URL')
    expect(result.reason).toContain('a private repository with no token configured for it')
    expect(result.reason).toContain('a token that does not have access')
    // And which credential was tried, so "check the token" is a checkable instruction.
    expect(result.reason).toContain(`127.0.0.1:${forgePort}/*/*`)
  })

  it('distinguishes a wrong token from a wrong URL', async () => {
    const wrongToken = configSchema.parse({
      github: { tokens: [{ host: `127.0.0.1:${forgePort}`, pat: 'ghp_expired' }] },
    })
    const result = await preflightRepository(repoUrl('acme/widgets.git'), { tokens: wrongToken.github.tokens })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('unauthorized')
    expect(result.reason).toContain('refused the configured token')
  })

  it('refuses an SSH remote for what it is, not as a typo', async () => {
    const result = await preflightRepository('git@github.com:acme/widgets.git')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('unsupported_scheme')
    expect(result.reason).toContain('not given an SSH key')
  })

  it('refuses a URL that names no repository, without asking anyone', async () => {
    const result = await preflightRepository(repoUrl('acme'), deps())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('not_a_repository')
    expect(asked).toEqual([]) // nothing was probed: the shape settled it
  })

  /**
   * THE OWNER'S LIVE FAILURE, REPRODUCED (rockysurf-ldo1).
   *
   * 2026-08-13: a create for the private `acme/private-thing` on an installation whose config
   * held SCOPED tokens only — nothing matching `acme/*`, and no fallback `pat`. The helper's
   * terminal rule is `[ -n "$t" ] || exit 0`, so it printed nothing, git prompted for a
   * username, found no TTY, and the clone died with `fatal: could not read Username for ...:
   * No such device or address`. Correct, and humanly useless — the owner diagnosed it only
   * because they had built the token feature themselves.
   *
   * The config shape is the point of these cases: scoped-only with no fallback is the ONE shape
   * where the preflight's prediction comes back empty, and an empty prediction is a cause core
   * is CERTAIN of rather than one of three it is guessing between.
   */
  describe("the owner's case: scoped tokens configured, none matching, no fallback", () => {
    /** Their config shape: real entries, none of which covers `acme`, and no `pat`. */
    const scopedButNotMatching = () =>
      configSchema.parse({
        github: {
          tokens: [
            { owner: 'globex', pat: 'ghp_globex' },
            { host: `127.0.0.1:${forgePort}`, owner: 'someone-else', pat: TOKEN },
          ],
        },
      }).github.tokens

    it('predicts what the box will do: no token at all', () => {
      // The prediction the whole message rests on, asserted directly. The differential test in
      // token-matching.test.ts proves the real shell agrees with this.
      expect(
        selectToken({ host: `127.0.0.1:${forgePort}`, path: '/acme/private-thing' }, scopedButNotMatching()),
      ).toBeUndefined()
    })

    it('names THIS cause rather than listing three, and names the scopes that were available', async () => {
      const url = repoUrl('acme/private-thing.git')
      const result = await preflightRepository(url, { tokens: scopedButNotMatching() })
      expect(result.ok).toBe(false)
      if (result.ok) return

      // A distinct code, so a client is not left string-matching prose to tell this apart from
      // a rejected token or a typo.
      expect(result.code).toBe('no_matching_token')
      expect(result.reason).toContain(`No configured token matches ${url}`)
      expect(result.reason).toContain('the box would clone it anonymously')

      // The half the owner had to work out for themselves: what WAS on offer, and the fact
      // that none of it covered this repository.
      expect(result.reason).toContain(`Tokens are configured for: github.com/globex/*, 127.0.0.1:${forgePort}/someone-else/*`)
      expect(result.reason).toContain(`none covers 127.0.0.1:${forgePort}/acme/private-thing`)

      // And what to do about it.
      expect(result.reason).toContain('Add an entry under github.tokens')
      expect(result.reason).toContain('github.pat')

      // SCOPE IDENTITIES ONLY. The pats are in the config this was built from; neither may
      // appear in a string that is rendered to a browser, a CLI and an agent transcript.
      expect(result.reason).not.toContain('ghp_globex')
      expect(result.reason).not.toContain(TOKEN)
    })

    it('says so differently when there are no tokens configured at all', async () => {
      const result = await preflightRepository(repoUrl('acme/private-thing.git'), {
        allowHosts: new Set(['127.0.0.1']),
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.code).toBe('no_matching_token')
      // "none of these covers it" is the wrong sentence when there are no `these`.
      expect(result.reason).toContain('No git tokens are configured on this installation at all')
    })

    it('distinguishes it from a token that WAS tried and rejected', async () => {
      const wrongToken = configSchema.parse({
        github: { tokens: [{ host: `127.0.0.1:${forgePort}`, owner: 'acme', pat: 'ghp_revoked' }] },
      }).github.tokens

      const result = await preflightRepository(repoUrl('acme/private-thing.git'), { tokens: wrongToken })
      expect(result.ok).toBe(false)
      if (result.ok) return
      // Same HTTP 401 from the same forge — a different diagnosis, because a token WAS selected.
      expect(result.code).toBe('unauthorized')
      expect(result.reason).toContain('revoked, expired, or missing repository read access')
      expect(result.reason).toContain(`127.0.0.1:${forgePort}/acme/*`)
      expect(result.reason).not.toContain('ghp_revoked')
    })

    it('passes once a matching entry exists, which is the fix the message asks for', async () => {
      const fixed = configSchema.parse({
        github: { tokens: [{ owner: 'globex', pat: 'ghp_globex' }, { host: `127.0.0.1:${forgePort}`, owner: 'acme', pat: TOKEN }] },
      }).github.tokens
      expect((await preflightRepository(repoUrl('acme/private-thing.git'), { tokens: fixed })).ok).toBe(true)
    })

    it('and passes on the fallback alone, which is the other fix it asks for', async () => {
      const fallbackOnly = configSchema.parse({
        github: { pat: TOKEN, tokens: [{ owner: 'globex', pat: 'ghp_globex' }] },
      }).github
      expect(
        (
          await preflightRepository(repoUrl('acme/private-thing.git'), {
            tokens: fallbackOnly.tokens,
            fallbackToken: fallbackOnly.pat!,
            allowHosts: new Set(['127.0.0.1']),
          })
        ).ok,
      ).toBe(true)
    })
  })

  it('refuses to probe a private address nobody vouched for, and says it is policy', async () => {
    // The SAME url as the passing case, with the token list empty — so the only thing that
    // changed is whether the operator named this host. A repository URL must not become a way
    // to knock on the metadata service.
    const result = await preflightRepository(repoUrl('acme/widgets.git'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('blocked')
    expect(result.reason).toContain('was not checked')
    expect(asked).toEqual([]) // and nothing was contacted
  })
})

/* ------------------------------------------------------- the same thing, through the route */

describe('the create route refuses before it launches anything', () => {
  let opened: OpenedDatabase
  let created: ReturnType<typeof createApp>
  let cookie: string

  async function build(): Promise<void> {
    opened = openTestDatabase()
    const secrets = new MemorySecretStore()
    await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })
    created = createApp({
      db: opened.db,
      config: configSchema.parse(forgeConfig()),
      secrets,
      secretsStore: createSecretsStore(opened.db, randomBytes(32)),
      events: createEventsService(),
      providers: new ProviderRegistry([makeFakeProvider()]),
    })
    const login = await created.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
  }

  beforeEach(build)
  afterEach(() => opened.close())

  async function create(body: Record<string, unknown>) {
    const res = await created.app.request('/api/v1/servers', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ size: 'small', ...body }),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  /** Every server row this installation has, whoever owns it. */
  const rowCount = () => opened.db.select().from(servers).all().length

  it('creates when every URL opens', async () => {
    const res = await create({ repositories: [repoUrl('acme/widgets.git')] })
    expect(res.status).toBe(201)
    expect(rowCount()).toBe(1)
  })

  it('refuses a typo with a field-level error, and writes NO row', async () => {
    const res = await create({ repositories: [repoUrl('acme/widgts.git')] })

    expect(res.status).toBe(400)
    // The project envelope, which this route did not emit before k6xp — it was the last caller
    // of the bare zValidator, so a 400 here used to be an OBJECT in the `error` field and every
    // client rendered "[object Object]" or "API Error: 400".
    expect(typeof res.body['error']).toBe('string')
    expect(res.body['code']).toBe('bad_request')
    expect(res.body['issues']).toEqual([
      { path: 'repositories.0', message: expect.stringContaining('a typo in the URL') },
    ])
    expect(String(res.body['error'])).toContain('createAnyway')

    // The whole point, and the thing a test of the message alone would miss: the refusal
    // happens before `lifecycle.create` writes anything, so there is no row, no instance, no
    // bill and nothing to clean up.
    expect(rowCount()).toBe(0)
  })

  it('reports every bad URL at once, so a user fixes the form rather than one field', async () => {
    const res = await create({
      repositories: [repoUrl('acme/widgets.git'), repoUrl('acme/nope.git'), 'not a url at all'],
    })
    expect(res.status).toBe(400)
    expect(res.body['issues']).toEqual([
      { path: 'repositories.1', message: expect.any(String) },
      { path: 'repositories.2', message: expect.stringContaining('is not a URL') },
    ])
  })

  it('honours the override, because the check is a prediction and not a guarantee', async () => {
    const res = await create({ repositories: [repoUrl('acme/widgts.git')], createAnyway: true })
    expect(res.status).toBe(201)
    // And the URL is stored exactly as sent — the override means "I know", not "fix it for me".
    expect(res.body['repositories']).toEqual([repoUrl('acme/widgts.git')])
  })

  it('does not probe anything when the create names no repositories', async () => {
    asked = []
    expect((await create({})).status).toBe(201)
    expect(asked).toEqual([])
  })
})
