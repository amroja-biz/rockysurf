import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type CreatedApp } from '../app.js'
import { ensureLocalAdmin } from '../auth/admin.js'
import { MemorySecretStore } from '../auth/secret-store.js'
import { issueSession } from '../auth/sessions.js'
import { ConfigError, configSchema, loadConfig, type Config } from '../config/index.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { upsertUserByGithubId } from '../db/repositories/users.js'
import { applyChanges } from './document.js'

/**
 * The settings editor, driven through the real app (rockysurf-m29b).
 *
 * WHY THE WHOLE APP AND A REAL FILE. Every claim this feature makes is about the seam between
 * an HTTP response and a file on disk: that a pasted token never crosses it, that a `${VAR}`
 * survives a round trip through a form, that a comment is still there afterwards, that two
 * writers cannot silently overwrite each other. A test that called the route handler with a
 * fake filesystem would be asserting those things about a mock. So these run against
 * `createApp`, a session cookie, and a scratch config file in a temp directory.
 *
 * THE FIRST DESCRIBE BLOCK IS NOT ABOUT THIS CODE. It pins the behaviour of the `yaml` package
 * that everything else here is built on — that editing a parsed Document leaves the surrounding
 * bytes alone. If that ever stops being true, the failure should name the library rather than
 * arriving as a mystery in a route test.
 */

const PASSWORD = 'correct-horse-battery-staple'
/** A literal credential, as an operator who ignored the advice would have pasted it. */
const LITERAL_TOKEN = 'hcloud-LITERALtokenSHOULDneverLEAK-9f3a'

const CONFIG_WITH_COMMENTS = [
  '# Rocky Surf configuration — hand-written, comments and all.',
  '',
  'server:',
  '  # Port for the web UI and API.',
  '  port: 3000',
  '',
  'github:',
  '  # Instance-wide fallback token.',
  '  pat: "${GITHUB_PAT}"',
  '  tokens:',
  '    # acme keeps its own fine-grained PAT',
  '    - repo: "acme/widgets"',
  '      pat: "${ACME_PAT}"',
  '',
  'providers:',
  '  hetzner:',
  '    enabled: true',
  '    # Pasted rather than referenced, which is what makes this file worth redacting.',
  `    token: "${LITERAL_TOKEN}"`,
  '    location: fsn1',
  '',
  'limits:',
  '  maxServers: 5',
  '',
].join('\n')

let opened: OpenedDatabase
let secrets: MemorySecretStore
let created: CreatedApp
let dir: string
let configPath: string
let token: string

const config: Config = configSchema.parse({})

/** The environment the app validates `${VAR}` references against. */
const ENV = {
  GITHUB_PAT: 'gh-pat-value',
  ACME_PAT: 'acme-pat-value',
  HETZNER_TOKEN: 'hetzner-env-value',
  NEW_PAT: 'new-pat-value',
}

beforeEach(async () => {
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v

  dir = mkdtempSync(join(tmpdir(), 'rockysurf-settings-'))
  configPath = join(dir, 'rockysurf.config.yaml')
  writeFileSync(configPath, CONFIG_WITH_COMMENTS)

  opened = openTestDatabase()
  secrets = new MemorySecretStore()
  await ensureLocalAdmin({ db: opened.db, secrets, password: PASSWORD })
  created = createApp({ db: opened.db, config, secrets, configPath })

  const res = await created.app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  token = ((await res.json()) as { token: string }).token
})

afterEach(() => {
  opened.close()
  rmSync(dir, { recursive: true, force: true })
  for (const k of Object.keys(ENV)) delete process.env[k]
})

const auth = (bearer = token) => ({ authorization: `Bearer ${bearer}`, 'content-type': 'application/json' })

const getSettings = (bearer = token) => created.app.request('/api/v1/settings', { headers: auth(bearer) })

const save = (body: unknown, bearer = token) =>
  created.app.request('/api/v1/settings', { method: 'PUT', headers: auth(bearer), body: JSON.stringify(body) })

/**
 * A save that is expected to succeed, with the status checked here.
 *
 * Used everywhere the assertion afterwards is about the FILE, because those assertions pass
 * happily against a rejected save: "the token is still there" is equally true when nothing was
 * written at all. One rejected save did hide behind that while this file was being written.
 */
async function saveOk(changes: unknown[]): Promise<void> {
  const res = await save({ mtimeMs: mtime(), changes })
  expect(res.status, await res.text()).toBe(200)
}

/** The current file's mtime, which is the token a save has to present. */
const mtime = () => statSync(configPath).mtimeMs

const file = () => readFileSync(configPath, 'utf8')

interface View {
  file: { path: string; exists: boolean; mtimeMs: number | null }
  values: Record<string, any>
  defaults: Record<string, any>
  /** The inventory the editor renders from — help, warnings, reasons and the hidden flag. */
  fields: { path: string; help: string; hidden?: true }[]
  sections: { id: string; title: string; help: string }[]
  drifted: boolean
  issues?: { path: string; message: string }[]
  warnings?: { path: string; message: string; variable: string }[]
}

async function readView(): Promise<View> {
  const res = await getSettings()
  expect(res.status).toBe(200)
  return (await res.json()) as View
}

/* ------------------------------------------------------- the library this is all built on */

describe('the yaml Document API, before anything is built on it', () => {
  it('round-trips an unedited file byte for byte', () => {
    expect(parseDocument(CONFIG_WITH_COMMENTS).toString()).toBe(CONFIG_WITH_COMMENTS)
  })

  it('leaves every other byte alone when one value changes', () => {
    const after = applyChanges(CONFIG_WITH_COMMENTS, [{ path: ['server', 'port'], value: 8080 }])
    expect(after).toBe(CONFIG_WITH_COMMENTS.replace('port: 3000', 'port: 8080'))
  })

  it('fills in a section whose every child is commented out, keeping the commented lines', () => {
    const text = 'server:\n  # port: 3000\nlimits:\n  maxServers: 5\n'
    const after = applyChanges(text, [{ path: ['server', 'port'], value: 4000 }])
    expect(after).toContain('# port: 3000')
    expect(after).toContain('port: 4000')
    expect(after).toContain('maxServers: 5')
  })

  it('turns an empty inline list into a block list when the first entry is added', () => {
    const text = 'providers:\n  byo:\n    hosts: []\n'
    const after = applyChanges(text, [
      { path: ['providers', 'byo', 'hosts', 0], value: { name: 'workshop', host: '10.0.0.9' } },
    ])
    expect(after).toBe('providers:\n  byo:\n    hosts:\n      - name: workshop\n        host: 10.0.0.9\n')
  })
})

/* ------------------------------------------------------------------------------- custody */

describe('the read is redacted', () => {
  it('never puts a literal token in any response byte', async () => {
    const raw = await (await getSettings()).text()
    expect(raw).not.toContain(LITERAL_TOKEN)
    // Not merely absent by accident: the field is present and says what state it is in.
    expect(JSON.parse(raw).values.providers.hetzner.token).toEqual({ secret: true, state: 'set' })
  })

  it('keeps the literal out of a SAVE response too, which is the same file read again', async () => {
    const res = await save({ mtimeMs: mtime(), changes: [{ path: ['limits', 'maxServers'], value: 9 }] })
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain(LITERAL_TOKEN)
  })

  it('shows a ${VAR} reference verbatim, flagged as a reference rather than as a value', async () => {
    const view = await readView()
    expect(view.values.github.pat).toEqual({ secret: true, state: 'reference', reference: '${GITHUB_PAT}' })
    expect(view.values.github.tokens[0].pat).toEqual({
      secret: true,
      state: 'reference',
      reference: '${ACME_PAT}',
    })
    // The variable's VALUE is a different thing, and it is not in the response.
    expect(JSON.stringify(view)).not.toContain(ENV.GITHUB_PAT)
  })

  it('masks a value that merely contains a reference, because the rest of it is literal', async () => {
    writeFileSync(configPath, 'providers:\n  hetzner:\n    token: "tok_live_${GITHUB_PAT}"\n')
    const raw = await (await getSettings()).text()
    expect(raw).not.toContain('tok_live_')
    expect(JSON.parse(raw).values.providers.hetzner.token.state).toBe('set')
  })

  it('masks a credential-named key under a section the schema has never heard of', async () => {
    // A provider from a branch that has not merged: the field inventory cannot know it, and the
    // file is invalid, and it is still holding a token that must not come back out.
    writeFileSync(configPath, `providers:\n  newcloud:\n    apiToken: "${LITERAL_TOKEN}"\n`)
    const raw = await (await getSettings()).text()
    expect(raw).not.toContain(LITERAL_TOKEN)
    // …and the page still shows what is wrong, which is the whole point of editing it here.
    expect(JSON.parse(raw).issues[0].path).toContain('newcloud')
  })

  it('reports the schema defaults, and they carry no credential to smuggle', async () => {
    const view = await readView()
    expect(view.defaults.server.port).toBe(3000)
    expect(view.defaults.limits.maxServers).toBe(5)
    // Nothing defaults a credential — an absent optional field is absent, not empty-string.
    expect(view.defaults.providers.hetzner.token).toBeUndefined()
    expect(view.defaults.github.pat).toBeUndefined()
  })
})

/* ---------------------------------------------------------------------------- the writes */

describe('a save edits the file in place', () => {
  it('keeps a comment above a field byte for byte', async () => {
    const res = await save({ mtimeMs: mtime(), changes: [{ path: ['server', 'port'], value: 8080 }] })
    expect(res.status).toBe(200)
    expect(file()).toBe(CONFIG_WITH_COMMENTS.replace('port: 3000', 'port: 8080'))
  })

  it('leaves a ${VAR} reference exactly as written when another field is saved', async () => {
    await saveOk([{ path: ['limits', 'maxServers'], value: 12 }])
    expect(file()).toContain('pat: "${GITHUB_PAT}"')
    expect(file()).toContain('pat: "${ACME_PAT}"')
    // And the reference still reads as a reference afterwards, not as its expansion.
    expect((await readView()).values.github.pat.reference).toBe('${GITHUB_PAT}')
  })

  it('writes a new reference as a reference, never as what it expands to', async () => {
    await save({
      mtimeMs: mtime(),
      changes: [{ path: ['providers', 'hetzner', 'token'], value: '${HETZNER_TOKEN}' }],
    })
    // Quoted, because `yaml` keeps the style the scalar was already written in.
    expect(file()).toContain('token: "${HETZNER_TOKEN}"')
    expect(file()).not.toContain(ENV.HETZNER_TOKEN)
    expect((await readView()).values.providers.hetzner.token.reference).toBe('${HETZNER_TOKEN}')
  })

  it('writes an optional block whole, and removes it whole', async () => {
    // Half a spend cap is not a smaller cap; `{ amount }` with no currency is a file that will
    // not load, so the block is one change rather than two.
    await saveOk([{ path: ['limits', 'spendCap'], value: { amount: 250, currency: 'EUR' } }])
    expect(file()).toContain('spendCap:\n    amount: 250\n    currency: EUR')

    await saveOk([{ path: ['limits', 'spendCap'], unset: true }])
    expect(file()).not.toContain('spendCap')
    expect(file()).toContain('maxServers: 5')
  })

  it('leaves keys this version does not surface untouched', async () => {
    // `auth.mode` is read-only here and `server.dataDir` is not editable at all; both survive,
    // as does a comment nobody's form knows about.
    writeFileSync(configPath, `${CONFIG_WITH_COMMENTS}auth:\n  # deliberate\n  mode: local\n`)
    await saveOk([{ path: ['limits', 'maxServers'], value: 3 }])
    expect(file()).toContain('auth:\n  # deliberate\n  mode: local')
  })
})

describe('write-only semantics for a secret', () => {
  it('keeps the current value when the field is not in the payload', async () => {
    await saveOk([{ path: ['limits', 'maxServers'], value: 7 }])
    expect(file()).toContain(LITERAL_TOKEN)
  })

  it('replaces it when a new value is sent', async () => {
    await save({
      mtimeMs: mtime(),
      changes: [{ path: ['providers', 'hetzner', 'token'], value: 'replacement-token' }],
    })
    expect(file()).not.toContain(LITERAL_TOKEN)
    expect(file()).toContain('token: "replacement-token"')
  })

  it('removes the key entirely on an explicit clear', async () => {
    const res = await save({
      mtimeMs: mtime(),
      changes: [{ path: ['providers', 'hetzner', 'token'], unset: true }],
    })
    expect(res.status).toBe(200)
    expect(file()).not.toContain('token:')
    // The view stays faithful to the file: a removed key is absent, which the editor reads as
    // "not set" the same way it does for every other field the file does not mention.
    expect((await readView()).values.providers.hetzner.token).toBeUndefined()

    /**
     * AND THE COMMENT ABOVE IT GOES WITH IT. A comment sits on the node beneath it, so deleting
     * the field deletes the sentence written to explain that field — the same rule as removing
     * a list entry, and the same reason: the prose described the thing that is no longer there.
     * Every OTHER comment in the file survives, which is what a save is actually promising.
     */
    expect(file()).not.toContain('# Pasted rather than referenced')
    expect(file()).toContain('# Port for the web UI and API.')
    expect(file()).toContain('# acme keeps its own fine-grained PAT')
  })

  it('changes a per-repository PAT without disturbing its neighbours', async () => {
    const res = await save({
      mtimeMs: mtime(),
      changes: [{ path: ['github', 'tokens', 0, 'pat'], value: '${NEW_PAT}' }],
    })
    expect(res.status).toBe(200)
    expect(file()).toContain('# acme keeps its own fine-grained PAT')
    expect(file()).toContain('- repo: "acme/widgets"')
    expect(file()).toContain('pat: "${NEW_PAT}"')
  })
})

/* -------------------------------------------------------------------------- conflicts */

describe('a concurrent hand-edit is refused, not merged', () => {
  it('409s with a message naming the file, and writes nothing', async () => {
    const stale = mtime()

    // Someone edits the file in $EDITOR while the page is open. The mtime is nudged forward
    // explicitly because a write inside the same millisecond would otherwise not move it.
    const handEdited = `${CONFIG_WITH_COMMENTS}\n# added by hand\n`
    writeFileSync(configPath, handEdited)
    const now = new Date(Date.now() + 2000)
    utimesSync(configPath, now, now)

    const res = await save({ mtimeMs: stale, changes: [{ path: ['server', 'port'], value: 9999 }] })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.code).toBe('conflict')
    expect(body.error).toContain(configPath)
    expect(body.error).toContain('Nothing was written')

    // The hand edit is intact and the save did not land.
    expect(file()).toBe(handEdited)
  })

  it('accepts the save once the caller has re-read the file', async () => {
    writeFileSync(configPath, `${CONFIG_WITH_COMMENTS}\n# added by hand\n`)
    const fresh = await readView()
    const res = await save({ mtimeMs: fresh.file.mtimeMs, changes: [{ path: ['server', 'port'], value: 9999 }] })
    expect(res.status).toBe(200)
    expect(file()).toContain('port: 9999')
    expect(file()).toContain('# added by hand')
  })

  it('refuses a save against "there was no file" when a file has since appeared', async () => {
    rmSync(configPath)
    const empty = await readView()
    expect(empty.file.exists).toBe(false)
    expect(empty.file.mtimeMs).toBeNull()

    writeFileSync(configPath, 'server:\n  port: 4444\n')
    const res = await save({ mtimeMs: null, changes: [{ path: ['server', 'port'], value: 5555 }] })
    expect(res.status).toBe(409)
    expect(file()).toContain('port: 4444')
  })

  it('never widens the file\'s permissions on the way through a temp file', async () => {
    // A file an operator chmodded, because it holds a pasted token. Writing a temp file with the
    // default umask and renaming it over this would silently make it world-readable.
    chmodSync(configPath, 0o600)
    await saveOk([{ path: ['limits', 'maxServers'], value: 6 }])
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
    expect(file()).toContain('maxServers: 6')
  })

  it('leaves a deliberately group-readable file as the operator set it', async () => {
    chmodSync(configPath, 0o640)
    await saveOk([{ path: ['limits', 'maxServers'], value: 6 }])
    expect(statSync(configPath).mode & 0o777).toBe(0o640)
  })

  it('creates the file when there really is none', async () => {
    rmSync(configPath)
    const res = await save({ mtimeMs: null, changes: [{ path: ['limits', 'maxServers'], value: 2 }] })
    expect(res.status).toBe(200)
    expect(file()).toBe('limits:\n  maxServers: 2\n')
    // It may hold a pasted credential later; it is not created world-readable.
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
  })

  /**
   * THE FIRST SAVE OF A RUN THAT HAS NO CONFIG FILE ANYWHERE (rockysurf-8wgm).
   *
   * `boot()` hands this route the path resolution settled on, and when nothing was found that is
   * `~/.rockysurf/config.yaml` — deliberately not a file in whatever directory `npx` was run
   * from, which cf51 established must stay empty. So the page's very first save is a file
   * CREATION, in a directory that on a fresh machine may not exist yet.
   */
  it('creates ~/.rockysurf/config.yaml, and its directory, on the first save', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rockysurf-home-'))
    const homeConfig = join(home, '.rockysurf', 'config.yaml')
    try {
      // The app a first run builds. Same database, so the session already issued still works.
      const fresh = createApp({ db: opened.db, config, secrets, configPath: homeConfig })
      const read = await fresh.app.request('/api/v1/settings', { headers: auth() })
      const view = (await read.json()) as View

      // The page is told where it will write, and that there is nothing there yet.
      expect(view.file.path).toBe(homeConfig)
      expect(view.file.exists).toBe(false)
      expect(view.file.mtimeMs).toBeNull()

      const res = await fresh.app.request('/api/v1/settings', {
        method: 'PUT',
        headers: auth(),
        body: JSON.stringify({ mtimeMs: null, changes: [{ path: ['server', 'port'], value: 3111 }] }),
      })
      expect(res.status, await res.clone().text()).toBe(200)
      const saved = (await res.json()) as View
      expect(saved.file.path).toBe(homeConfig)
      expect(saved.file.exists).toBe(true)

      expect(readFileSync(homeConfig, 'utf8')).toBe('server:\n  port: 3111\n')
      // Owner-only, both of them: this directory is where the master key lives too.
      expect(statSync(homeConfig).mode & 0o777).toBe(0o600)
      expect(statSync(join(home, '.rockysurf')).mode & 0o777).toBe(0o700)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

/* ------------------------------------------------------------------------- validation */

describe('validation is the config schema itself', () => {
  it('rejects a bad value with the field path, and writes nothing', async () => {
    const before = file()
    const res = await save({ mtimeMs: mtime(), changes: [{ path: ['server', 'port'], value: 70000 }] })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { issues: { path: string; message: string }[] }
    expect(body.issues.map((i) => i.path)).toContain('server.port')
    expect(file()).toBe(before)
  })

  it('reports a schema refinement in the schema\'s own words', async () => {
    const res = await save({
      mtimeMs: mtime(),
      changes: [{ path: ['providers', 'byo', 'enabled'], value: true }],
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { issues: { path: string; message: string }[] }
    expect(body.issues[0]?.path).toBe('providers.byo.hosts')
    expect(body.issues[0]?.message).toContain('no hosts are listed')
  })

  it('refuses a path the editor does not offer, rather than writing it', async () => {
    const res = await save({ mtimeMs: mtime(), changes: [{ path: ['server', 'nonsense'], value: 1 }] })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('does not edit that field')
  })

  it('refuses to write a read-only field, and says why', async () => {
    const res = await save({ mtimeMs: mtime(), changes: [{ path: ['server', 'dataDir'], value: '/tmp/elsewhere' }] })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { issues: { path: string; message: string }[] }
    expect(body.issues[0]?.path).toBe('server.dataDir')
    expect(body.issues[0]?.message).toContain('encrypted secrets store')
    expect(file()).toContain('# Rocky Surf configuration')
  })

  /**
   * A field the page does not draw is still a field the route knows (rockysurf-5qzg).
   *
   * `hidden` is about rendering and nothing else. If it had been implemented by deleting the
   * entry instead, this save would still be refused — but with the vaguer "does not edit that
   * field" above, rather than with the sentence explaining that the mode being selected has no
   * implementation. The specific message is the reason the entry stays.
   */
  it('refuses a hidden field by name, with the reason the page never shows', async () => {
    const res = await save({ mtimeMs: mtime(), changes: [{ path: ['auth', 'mode'], value: 'github-device' }] })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { issues: { path: string; message: string }[] }
    expect(body.issues[0]?.path).toBe('auth.mode')
    expect(body.issues[0]?.message).toContain('lock you out')
    expect(file()).not.toContain('github-device')
  })
})

/**
 * A REFERENCE MAY BE SAVED AHEAD OF THE VARIABLE (rockysurf-1z5q).
 *
 * The owner hit this live: adding a token entry for a private repository (`acme/private-thing`
 * here) with `${PRIVATE_THING_PAT}` came back 400, because save-time validation ran boot's interpolation and
 * boot treats an unset variable as fatal. It is fatal at boot and ordinary at save, and the
 * reason is the workflow the page itself prescribes: the token box asks for a variable NAME
 * (rockysurf-4o3o), and a variable cannot be exported into a process that is already running.
 * So the save was refusing to record the one thing the page had just asked for, and the only
 * way through was to restart the core before the settings that need the restart could be typed.
 *
 * The save now writes, and says what has to happen before the next start. These cases pin all
 * three halves of that: it writes, it warns, and boot still refuses the file it wrote.
 */
describe('saving a reference to a variable that is not set yet', () => {
  const PRIVATE_THING = { owner: 'acme', repo: 'private-thing', pat: '${PRIVATE_THING_PAT}' }

  /** The owner's exact save: a new entry in the token list, naming a variable nobody exported. */
  const addPrivateThing = () => save({ mtimeMs: mtime(), changes: [{ path: ['github', 'tokens', 1], value: PRIVATE_THING }] })

  it('saves it, and the file holds the reference rather than nothing', async () => {
    const res = await addPrivateThing()
    expect(res.status, await res.clone().text()).toBe(200)
    expect(file()).toContain('pat: ${PRIVATE_THING_PAT}')
    expect(file()).toContain('repo: private-thing')
    // The neighbours are untouched, which is the ordinary promise a save makes.
    expect(file()).toContain('# acme keeps its own fine-grained PAT')
  })

  it('says which variable is missing, at the entry that references it', async () => {
    const body = (await (await addPrivateThing()).json()) as View & { saved: boolean }
    expect(body.saved).toBe(true)
    expect(body.warnings?.map((w) => w.variable)).toEqual(['PRIVATE_THING_PAT'])
    expect(body.warnings?.[0]?.path).toBe('github.tokens.1.pat')
    expect(body.warnings?.[0]?.message).toContain('${PRIVATE_THING_PAT}')
    // The sentence has to say what happens next, not merely that something is missing.
    expect(body.warnings?.[0]?.message).toContain('before the next restart')
    // A warning is not an error: the page must not render this as a failed save.
    expect(body.issues).toBeUndefined()
  })

  /**
   * THE WARNING OUTLIVES THE SAVE, which is the whole difference between this and a toast. The
   * file is now one that will not boot, and it stays that way until somebody exports the
   * variable — so the page has to keep saying so on every read, exactly as `drifted` does.
   */
  it('keeps saying so on every subsequent read, not just in the save response', async () => {
    await addPrivateThing()
    const first = await readView()
    expect(first.warnings?.map((w) => w.variable)).toEqual(['PRIVATE_THING_PAT'])
    expect(first.drifted).toBe(true)
    // And again, because a page reload is the ordinary thing that loses a notice.
    expect((await readView()).warnings?.[0]?.path).toBe('github.tokens.1.pat')
  })

  it('says nothing at all once the variable IS exported — the control', async () => {
    process.env.PRIVATE_THING_PAT = 'ghp_exported_by_the_operator'
    try {
      const res = await save({
        mtimeMs: mtime(),
        changes: [{ path: ['github', 'tokens', 1], value: PRIVATE_THING }],
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as View
      expect(body.warnings).toBeUndefined()
      // Still a reference in the file, and still never the value — save is not resolution.
      expect(file()).toContain('pat: ${PRIVATE_THING_PAT}')
      expect(file()).not.toContain('ghp_exported_by_the_operator')
      expect(JSON.stringify(body)).not.toContain('ghp_exported_by_the_operator')
    } finally {
      delete process.env.PRIVATE_THING_PAT
    }
  })

  /**
   * BOOT IS UNTOUCHED, and this is the assertion that makes the warning honest rather than a
   * way of hiding a problem: the file the page just wrote really will refuse to start, with the
   * message the warning promised, naming the same variable.
   */
  it('leaves boot refusing the very file it just wrote, naming the variable', async () => {
    await addPrivateThing()
    let err: unknown
    try {
      loadConfig({ configPath, argv: [], cwd: dir, home: dir, env: {} })
    } catch (caught) {
      err = caught
    }
    expect(err).toBeInstanceOf(ConfigError)
    expect((err as ConfigError).message).toContain('${PRIVATE_THING_PAT}')
    expect((err as ConfigError).message).toContain('are not set')
  })

  /**
   * THE SOFTENING IS NARROW: only "this variable is not set" stops being a refusal. Everything
   * the schema has an opinion about is still checked, in the very same entry, so a warning
   * cannot become a way of writing a file that is actually wrong.
   */
  it('still refuses a bad scope in the entry carrying the reference', async () => {
    const before = file()
    const res = await save({
      mtimeMs: mtime(),
      changes: [{ path: ['github', 'tokens', 1], value: { owner: 'a b c', pat: '${PRIVATE_THING_PAT}' } }],
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { issues: { path: string; message: string }[] }
    expect(body.issues.map((i) => i.path)).toContain('github.tokens.1.owner')
    expect(file()).toBe(before)
  })

  it('still refuses a duplicate scope, warning or not', async () => {
    const before = file()
    const res = await save({
      mtimeMs: mtime(),
      changes: [{ path: ['github', 'tokens', 1], value: { repo: 'acme/widgets', pat: '${PRIVATE_THING_PAT}' } }],
    })
    expect(res.status).toBe(400)
    expect(file()).toBe(before)
  })
})

/**
 * THE FIRST SAVE OF A RUN WITH NO CONFIG FILE, AND THE BODIES THAT MISS IT (rockysurf-1z5q).
 *
 * A hand-built `PUT` against this path came back **500 server_error** while the bug was being
 * reproduced, and the cause was not the first-save path at all: a body that is not JSON was
 * throwing out of Hono's validator, past every 400 this route knows how to produce, into the
 * app's catch-all. Every way of getting the body wrong is the caller's mistake and belongs in
 * the same envelope as every other one, so these enumerate them.
 */
describe('a first save, and a body that does not survive the trip', () => {
  let fresh: CreatedApp
  let homeDir: string
  let homeConfig: string

  const put = (body: string, contentType: string | null = 'application/json') =>
    fresh.app.request('/api/v1/settings', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        ...(contentType === null ? {} : { 'content-type': contentType }),
      },
      body,
    })

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'rockysurf-first-'))
    homeConfig = join(homeDir, '.rockysurf', 'config.yaml')
    fresh = createApp({ db: opened.db, config, secrets, configPath: homeConfig })
  })

  afterEach(() => rmSync(homeDir, { recursive: true, force: true }))

  it('takes the real page flow: read, echo the null mtime back, and the file appears', async () => {
    const view = (await (await fresh.app.request('/api/v1/settings', { headers: auth() })).json()) as View
    expect(view.file.exists).toBe(false)
    expect(view.file.mtimeMs).toBeNull()

    const res = await put(JSON.stringify({ mtimeMs: view.file.mtimeMs, changes: [{ path: ['limits', 'maxServers'], value: 2 }] }))
    expect(res.status, await res.clone().text()).toBe(200)
    expect(readFileSync(homeConfig, 'utf8')).toBe('limits:\n  maxServers: 2\n')
  })

  it('takes a first save whose only field is a reference to an unset variable', async () => {
    const res = await put(
      JSON.stringify({ mtimeMs: null, changes: [{ path: ['github', 'tokens', 0], value: { owner: 'acme', repo: 'private-thing', pat: '${PRIVATE_THING_PAT}' } }] }),
    )
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as View
    expect(body.warnings?.[0]?.variable).toBe('PRIVATE_THING_PAT')
    expect(readFileSync(homeConfig, 'utf8')).toContain('${PRIVATE_THING_PAT}')
  })

  it('answers a body that is not JSON with a 400 that says so, never a 500', async () => {
    const res = await put('{ mtimeMs: null, changes: [ ')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.code).toBe('bad_request')
    expect(body.error).toContain('not valid JSON')
    expect(existsSync(homeConfig)).toBe(false)
  })

  /**
   * A body sent without the header is not merely unvalidated — Hono does not DECODE it, and
   * substitutes `{}`. The old answer was "mtimeMs: expected number, received undefined" for a
   * request that plainly sent `mtimeMs`, which is a 400 pointing at the wrong thing entirely.
   */
  it('says the Content-Type is why, rather than blaming a field the caller did send', async () => {
    const res = await put(JSON.stringify({ mtimeMs: null, changes: [{ path: ['limits', 'maxServers'], value: 2 }] }), null)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('application/json')
    expect(body.error).not.toContain('mtimeMs')
  })

  it('answers a missing mtimeMs with the field-level 400 envelope', async () => {
    const res = await put(JSON.stringify({ changes: [{ path: ['limits', 'maxServers'], value: 2 }] }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string; issues: { path: string }[] }
    expect(body.code).toBe('bad_request')
    expect(body.issues.map((i) => i.path)).toContain('mtimeMs')
  })

  it('answers an empty change list, and a body with no fields at all, the same way', async () => {
    expect((await put(JSON.stringify({ mtimeMs: null, changes: [] }))).status).toBe(400)
    expect((await put(JSON.stringify({}))).status).toBe(400)
    expect((await put('null')).status).toBe(400)
    expect(existsSync(homeConfig)).toBe(false)
  })
})

/**
 * WHAT THE PAGE IS TOLD ABOUT ITSELF (rockysurf-5qzg).
 *
 * The inventory travels with every read, so the words on the page and the rules the route
 * enforces are the same data. These cases assert the payload carries the three things directive
 * 1 and 3 added — help on every field, section titles and help, and the hidden flag — because a
 * web test can only check that the page renders what it was given.
 */
describe('the inventory the editor reads', () => {
  it('carries help for every field it offers', async () => {
    const view = await readView()
    expect(view.fields.length).toBeGreaterThan(20)
    for (const field of view.fields) {
      expect(field.help, `${field.path} reached the page with no help text`).toBeTruthy()
    }
  })

  it('carries the sections, so a heading and its explanation come from one place', async () => {
    const view = await readView()
    const github = view.sections.find((s) => s.id === 'github')
    expect(github?.title).toBe('GitHub access tokens')
    expect(github?.help).toContain('most specific entry')
  })

  it('marks the field the page must not draw, and marks only that one', async () => {
    const view = await readView()
    expect(view.fields.filter((f) => f.hidden).map((f) => f.path)).toEqual(['auth.mode'])
  })
})

/* ---------------------------------------------------------------- restart honesty & auth */

describe('restart honesty', () => {
  it('reports no drift for a file nobody has touched since boot', async () => {
    expect((await readView()).drifted).toBe(false)
  })

  it('reports drift after a save — the running process is still on the old values', async () => {
    await saveOk([{ path: ['limits', 'maxServers'], value: 4 }])
    expect((await readView()).drifted).toBe(true)
  })

  it('does not call a comment-only hand edit a change of settings', async () => {
    writeFileSync(configPath, CONFIG_WITH_COMMENTS.replace('# Port for the web UI and API.', '# The port.'))
    expect((await readView()).drifted).toBe(false)
  })

  it('says what a save requires, in the response', async () => {
    const res = await save({ mtimeMs: mtime(), changes: [{ path: ['limits', 'maxServers'], value: 4 }] })
    const body = (await res.json()) as { saved: boolean; restartHint: string }
    expect(body.saved).toBe(true)
    expect(body.restartHint).toContain('./start.sh')
  })
})

describe('admin only', () => {
  it('refuses a signed-in non-admin on both routes', async () => {
    const user = upsertUserByGithubId(opened.db, { githubId: 'gh-2', githubUsername: 'someone', isAdmin: false })
    const { token: theirs } = issueSession(opened.db, user.id)

    expect((await getSettings(theirs)).status).toBe(403)
    const res = await save({ mtimeMs: mtime(), changes: [{ path: ['server', 'port'], value: 1234 }] }, theirs)
    expect(res.status).toBe(403)
    expect(file()).toContain('port: 3000')
  })

  it('refuses an unauthenticated caller before it reads anything', async () => {
    expect((await created.app.request('/api/v1/settings')).status).toBe(401)
  })
})
