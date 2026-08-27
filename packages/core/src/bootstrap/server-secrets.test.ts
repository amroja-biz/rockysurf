import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boot, type BootedApp } from '../server.js'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GIT_CREDENTIAL_HELPER } from './resolver.js'
import { ADMIN_PASSWORD_ENV } from '../auth/admin.js'
import { openTestDatabase, type OpenedDatabase } from '../db/client.js'
import { newServerId, newUserId } from '../db/ids.js'
import { servers, users, type ServerRow } from '../db/schema.js'
import { createSecretsStore } from '../secrets/store.js'
import { mintCallbackTokens } from '../db/repositories/bootstrap-tokens.js'
import { upsertPack } from '../db/repositories/packs.js'
import { getServer } from '../db/repositories/servers.js'
import { parseInstallPlan } from './plan.js'
import { renderSecretsEnv } from './push.js'
import {
  createServerSecretsLoader,
  GITHUB_TOKEN_SET_ENV,
  SECRET_ENV_KEYS,
  SECRET_ENV_KEY_NAMES,
} from './server-secrets.js'

/**
 * The secrets hook, unit-tested AND wired-tested (rockysurf-55fx.14).
 *
 * The wiring half is the point. `loadServerSecrets` had a passing unit-tested consumer on both
 * sides — the callback route served whatever it was handed, the push runner wrote whatever it
 * was given — and production still delivered nothing, because `boot()` never supplied the hook.
 * That is the same shape of gap 55fx.13 found: every unit test built the wiring it needed and
 * then asserted on it, which is exactly the test that cannot see a missing composition.
 */

let opened: OpenedDatabase

/**
 * Run the real credential helper the way git runs it (rockysurf-ta7g).
 *
 * NOT A REIMPLEMENTATION OF THE MATCHING. The program under test is the exact string
 * `resolver.ts` embeds in the clone step, executed by `/bin/sh` with the credential protocol on
 * stdin — `git -c credential.helper='!prog'` runs `sh -c 'prog "$@"' prog get`, which is what
 * the argv below reproduces. A test that parsed `secrets.env` and reasoned about scopes in
 * TypeScript would agree with itself forever while the shell did something else; this one fails
 * if the shell is wrong, and it caught the fact that git omits `path=` entirely unless
 * `credential.useHttpPath` is set.
 *
 * Returns the password the helper chose, or `undefined` when it declined to answer.
 */
function askCredentialHelper(
  env: Record<string, string>,
  request: { host: string; path?: string },
): string | undefined {
  const stdin = ['protocol=https', `host=${request.host}`]
  if (request.path !== undefined) stdin.push(`path=${request.path}`)

  const result = spawnSync(
    '/bin/sh',
    ['-c', `${GIT_CREDENTIAL_HELPER.slice(1)} "$@"`, 'rockysurf-credential-helper', 'get'],
    {
      input: `${stdin.join('\n')}\n\n`,
      // `tr` and the shell itself need a PATH; nothing else from this process leaks in, so a
      // GITHUB_TOKEN in the developer's own environment cannot make the test pass.
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...env },
      encoding: 'utf8',
    },
  )

  expect(result.status, result.stderr).toBe(0)
  return /^password=(.*)$/m.exec(result.stdout)?.[1]
}

function seed(repositories: readonly string[] = []): { row: ServerRow; userId: string } {
  const userId = newUserId()
  const now = new Date().toISOString()
  // Unique identity per call: `users` has unique indexes on both GitHub columns, so two
  // servers for two different people need two distinct users.
  opened.db
    .insert(users)
    .values({
      id: userId,
      githubId: `gh:${userId}`,
      githubUsername: userId,
      isAdmin: false,
      createdAt: now,
      updatedAt: now,
    })
    .run()

  const id = newServerId()
  const [row] = opened.db
    .insert(servers)
    .values({
      id,
      userId,
      name: id,
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
      status: 'provisioning',
      bootstrapMode: 'push',
      ...(repositories.length > 0 ? { repositories: JSON.stringify(repositories) } : {}),
      idempotencyKey: id,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .all()
  return { row: row!, userId }
}

beforeEach(() => {
  opened = openTestDatabase()
})

afterEach(() => {
  opened.close()
})

describe('the key-name contract', () => {
  it('is exactly the names packs are promised', () => {
    // Changing either of these breaks every pack written against them. The list is asserted
    // here so a rename has to be a deliberate act with a failing test in front of it.
    expect(SECRET_ENV_KEYS.githubToken).toBe('GITHUB_TOKEN')
    expect(SECRET_ENV_KEYS.rdpPassword).toBe('RDP_PASSWORD')
    expect([...SECRET_ENV_KEY_NAMES].sort()).toEqual(['GITHUB_TOKEN', 'RDP_PASSWORD'])
  })
})

describe('loading a server’s secrets', () => {
  it('reads the git token by USER and the desktop password by SERVER', () => {
    const store = createSecretsStore(opened.db, Buffer.alloc(32, 7))
    const { row, userId } = seed()

    // One token per user, reused across their servers; one desktop password per box, because
    // it is set on that box's own `rocky` account.
    store.putGithubToken(userId, 'ghp_private_repos')
    store.putRdpPassword(row.id, 'hunter2')

    return createServerSecretsLoader(store)(row).then((env) => {
      expect(env).toEqual({ GITHUB_TOKEN: 'ghp_private_repos', RDP_PASSWORD: 'hunter2' })
    })
  })

  it('omits a key that has no secret rather than emitting it empty', async () => {
    // `RDP_PASSWORD=` would satisfy the resolver's `-z` guard and then set an EMPTY desktop
    // password. Absent is the honest answer, and the step fails with the message it already has.
    const store = createSecretsStore(opened.db, Buffer.alloc(32, 7))
    const { row, userId } = seed()
    store.putGithubToken(userId, 'ghp_only')

    const env = await createServerSecretsLoader(store)(row)
    expect(env).toEqual({ GITHUB_TOKEN: 'ghp_only' })
    expect(Object.keys(env)).not.toContain('RDP_PASSWORD')
  })

  it('returns nothing at all for a server with no secrets, without throwing', async () => {
    const store = createSecretsStore(opened.db, Buffer.alloc(32, 7))
    const { row } = seed()
    await expect(createServerSecretsLoader(store)(row)).resolves.toEqual({})
  })

  it('does not leak one user’s token to another user’s server', async () => {
    const store = createSecretsStore(opened.db, Buffer.alloc(32, 7))
    const mine = seed()
    const theirs = seed()
    store.putGithubToken(mine.userId, 'ghp_mine')

    expect(await createServerSecretsLoader(store)(theirs.row)).toEqual({})
    expect(await createServerSecretsLoader(store)(mine.row)).toEqual({ GITHUB_TOKEN: 'ghp_mine' })
  })
})

describe('the config-file PAT (rockysurf-yzae)', () => {
  it('supplies GITHUB_TOKEN when the store holds nothing', async () => {
    // The whole point of the bead: with no writer for the store, this was the only way a
    // self-hoster could ever authenticate a clone, and it did not exist.
    const store = createSecretsStore(opened.db, Buffer.alloc(32, 7))
    const { row } = seed()

    const env = await createServerSecretsLoader(store, { githubPat: 'ghp_from_config' })(row)
    expect(env).toEqual({ GITHUB_TOKEN: 'ghp_from_config' })
  })

  it('applies to every user’s servers, because it is instance-wide configuration', async () => {
    const store = createSecretsStore(opened.db, Buffer.alloc(32, 7))
    const mine = seed()
    const theirs = seed()
    const load = createServerSecretsLoader(store, { githubPat: 'ghp_operator' })

    // Stated as a test rather than left implicit: in `github-device` mode this hands the
    // operator's token to a box someone else created, which is why the docs say to scope it.
    expect(await load(mine.row)).toEqual({ GITHUB_TOKEN: 'ghp_operator' })
    expect(await load(theirs.row)).toEqual({ GITHUB_TOKEN: 'ghp_operator' })
  })

  it('yields to a stored per-user token, which someone had to put there deliberately', async () => {
    const store = createSecretsStore(opened.db, Buffer.alloc(32, 7))
    const mine = seed()
    const theirs = seed()
    store.putGithubToken(mine.userId, 'ghp_mine')
    const load = createServerSecretsLoader(store, { githubPat: 'ghp_operator' })

    expect(await load(mine.row)).toEqual({ GITHUB_TOKEN: 'ghp_mine' })
    // ...and the instance default still covers everyone who has not stored one.
    expect(await load(theirs.row)).toEqual({ GITHUB_TOKEN: 'ghp_operator' })
  })

  it('omits the key when neither source has one, rather than emitting it empty', async () => {
    const store = createSecretsStore(opened.db, Buffer.alloc(32, 7))
    const { row } = seed()
    await expect(createServerSecretsLoader(store, {})(row)).resolves.toEqual({})
  })

  it('never writes the config value into the store — no copy to go stale', async () => {
    // The failure this ordering exists to prevent: persist the config PAT once, and rotating
    // it in the config file leaves the old row shadowing the new value forever.
    const store = createSecretsStore(opened.db, Buffer.alloc(32, 7))
    const { row, userId } = seed()

    await createServerSecretsLoader(store, { githubPat: 'ghp_first' })(row)
    expect(store.listSecretRefs({ kind: 'github-token' })).toEqual([])

    // A restart with an edited config really does rotate, because the old value was nowhere.
    const env = await createServerSecretsLoader(store, { githubPat: 'ghp_second' })(row)
    expect(env).toEqual({ GITHUB_TOKEN: 'ghp_second' })
    expect(store.getGithubToken(userId)).toBeUndefined()
  })
})

describe('boot() supplies the hook — the wiring that was missing', () => {
  let booted: BootedApp | undefined
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rockysurf-secrets-'))
    writeFileSync(join(dir, 'rockysurf.config.yaml'), `server:\n  dataDir: "${join(dir, 'data')}"\n`)
  })

  afterEach(async () => {
    await booted?.close()
    booted = undefined
  })

  it('hands install steps a real environment, not an empty one', async () => {
    booted = await boot({ argv: [], cwd: dir, env: {}, listen: false, announce: () => {}, log: () => {} })

    // Seeded through the SAME store boot opened, so this proves the hook reads production's
    // store rather than one a test constructed for it.
    const userId = newUserId()
    const now = new Date().toISOString()
    booted.db.db
      .insert(users)
      .values({ id: userId, githubId: 'gh:1', githubUsername: 'someone', isAdmin: false, createdAt: now, updatedAt: now })
      .run()
    const id = newServerId()
    const [row] = booted.db.db
      .insert(servers)
      .values({
        id,
        userId,
        name: id,
        provider: 'fake',
        size: 'small',
        offeringId: 'fake-small',
        arch: 'arm64',
        status: 'provisioning',
        bootstrapMode: 'push',
        idempotencyKey: id,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all()

    booted.secretsStore.putGithubToken(userId, 'ghp_from_boot')
    booted.secretsStore.putRdpPassword(id, 'desktop-pw')

    // Driven through the REAL callback route on the app `boot()` built — not through a loader
    // this test constructed. That distinction is the whole point: a test that supplies the
    // wiring it is checking is precisely the test that missed this bug for two milestones.
    const { planToken } = mintCallbackTokens(booted.db.db, id)
    const res = await booted.app.request(`/internal/servers/${id}/secrets?token=${planToken}`)

    expect(res.status).toBe(200)
    expect((await res.json()) as { secrets: Record<string, string> }).toEqual({
      secrets: { GITHUB_TOKEN: 'ghp_from_boot', RDP_PASSWORD: 'desktop-pw' },
    })
    // The most sensitive body core emits must never sit in a cache.
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('served an EMPTY set before the hook was supplied — the regression this guards', async () => {
    // Same route, same tokens, no secrets stored: proves the endpoint's emptiness used to be
    // indistinguishable from "this installation has no credentials", which is why nothing
    // caught it.
    booted = await boot({ argv: [], cwd: dir, env: {}, listen: false, announce: () => {}, log: () => {} })

    const userId = newUserId()
    const now = new Date().toISOString()
    booted.db.db
      .insert(users)
      .values({ id: userId, githubId: 'gh:2', githubUsername: 'nobody', isAdmin: false, createdAt: now, updatedAt: now })
      .run()
    const id = newServerId()
    booted.db.db
      .insert(servers)
      .values({
        id,
        userId,
        name: id,
        provider: 'fake',
        size: 'small',
        offeringId: 'fake-small',
        arch: 'arm64',
        status: 'provisioning',
        bootstrapMode: 'callback',
        idempotencyKey: id,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    const { planToken } = mintCallbackTokens(booted.db.db, id)
    const res = await booted.app.request(`/internal/servers/${id}/secrets?token=${planToken}`)
    expect(await res.json()).toEqual({ secrets: {} })
  })
})

/**
 * `github.pat` reaches a box, driven through boot and the real route (rockysurf-yzae).
 *
 * THE SAME 55fx.13 LESSON, one layer along. `github.pat` parsed correctly (config tests said
 * so), `${GITHUB_PAT}` interpolated correctly (interpolation tests said so), the loader served
 * whatever it was handed (the unit tests above said so) and the box wired `$GITHUB_TOKEN` into
 * git correctly (the resolver's tests said so) — and a private-repo clone still could not
 * authenticate, because nothing joined the first half to the second. Only a test that starts
 * at a config FILE and ends at the response a box actually receives can see that.
 */
function writeConfigIn(dir: string, github: string): void {
  writeFileSync(
    join(dir, 'rockysurf.config.yaml'),
    `server:\n  dataDir: "${join(dir, 'data')}"\n${github}`,
  )
}

/**
 * A user and one of their servers, in the database `boot()` opened. Returns the server id.
 *
 * `repositories` is what the box DECLARED at create, and since rockysurf-18lq it decides which
 * scoped tokens the box receives — so a seed that omits it is a box that legitimately gets none.
 */
function seedServer(app: BootedApp, suffix: string, repositories: readonly string[] = []): string {
  const userId = newUserId()
  const now = new Date().toISOString()
  app.db.db
    .insert(users)
    .values({
      id: userId,
      githubId: `gh:${suffix}`,
      githubUsername: `user-${suffix}`,
      isAdmin: false,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  const id = newServerId()
  app.db.db
    .insert(servers)
    .values({
      id,
      userId,
      name: id,
      provider: 'fake',
      size: 'small',
      offeringId: 'fake-small',
      arch: 'arm64',
      status: 'provisioning',
      bootstrapMode: 'callback',
      ...(repositories.length > 0 ? { repositories: JSON.stringify(repositories) } : {}),
      idempotencyKey: id,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return id
}

/** The response an actual box receives, through the actual route, on the app `boot()` built. */
async function fetchSecrets(app: BootedApp, id: string): Promise<Record<string, string>> {
  const { planToken } = mintCallbackTokens(app.db.db, id)
  const res = await app.app.request(`/internal/servers/${id}/secrets?token=${planToken}`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { secrets: Record<string, string> }
  return body.secrets
}

describe('a config-file PAT reaches the box', () => {
  let booted: BootedApp | undefined
  let dir: string

  const writeConfig = (github: string): void => writeConfigIn(dir, github)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rockysurf-pat-'))
  })

  afterEach(async () => {
    await booted?.close()
    booted = undefined
  })

  it('serves the literal `github.pat` from the config file', async () => {
    writeConfig('github:\n  pat: "ghp_literal_from_file"\n')
    booted = await boot({ argv: [], cwd: dir, env: {}, listen: false, announce: () => {}, log: () => {} })

    expect(await fetchSecrets(booted, seedServer(booted, 'literal'))).toEqual({
      GITHUB_TOKEN: 'ghp_literal_from_file',
    })
  })

  it('serves a `${GITHUB_PAT}` the environment supplied — the documented contract', async () => {
    // The form the example config and .env.example actually advertise. Nothing about it was
    // exercised end to end before, and the promise it makes was false.
    writeConfig('github:\n  pat: "${GITHUB_PAT}"\n')
    booted = await boot({
      argv: [],
      cwd: dir,
      env: { GITHUB_PAT: 'ghp_from_environment' },
      listen: false,
      announce: () => {},
      log: () => {},
    })

    expect(await fetchSecrets(booted, seedServer(booted, 'interpolated'))).toEqual({
      GITHUB_TOKEN: 'ghp_from_environment',
    })
  })

  it('leaves GITHUB_TOKEN absent when no pat is configured, so public clones are unaffected', async () => {
    writeConfig('')
    booted = await boot({ argv: [], cwd: dir, env: {}, listen: false, announce: () => {}, log: () => {} })

    expect(await fetchSecrets(booted, seedServer(booted, 'none'))).toEqual({})
  })

  it('rotates on restart with an edited config, because nothing was persisted', async () => {
    // The behaviour that decided the design. A boot that copied the PAT into the encrypted
    // store would pass the first half of this test and fail the second, with the config file
    // reading correctly and every clone still using the old token.
    writeConfig('github:\n  pat: "ghp_before_rotation"\n')
    booted = await boot({ argv: [], cwd: dir, env: {}, listen: false, announce: () => {}, log: () => {} })
    expect(await fetchSecrets(booted, seedServer(booted, 'rotate-a'))).toEqual({
      GITHUB_TOKEN: 'ghp_before_rotation',
    })
    // The store is untouched: the secret exists nowhere but the config file and this process.
    expect(booted.secretsStore.listSecretRefs({ kind: 'github-token' })).toEqual([])
    await booted.close()

    writeConfig('github:\n  pat: "ghp_after_rotation"\n')
    booted = await boot({ argv: [], cwd: dir, env: {}, listen: false, announce: () => {}, log: () => {} })
    // Same data directory, same database, same master key — only the config file changed.
    expect(await fetchSecrets(booted, seedServer(booted, 'rotate-b'))).toEqual({
      GITHUB_TOKEN: 'ghp_after_rotation',
    })
  })
})

/**
 * One token per repository, from the config file to the token the helper actually picks
 * (rockysurf-ta7g).
 *
 * THE SEAM THIS BEAD ADDS IS A SHELL PROGRAM, so the test has to end in the shell. Core can
 * only put a table of scopes and tokens in `secrets.env`; the choice of which one opens
 * `github.com/acme/widgets` is made on the box, inside the credential helper, because that is
 * the only place that knows what git is asking for. A test that stopped at the secrets
 * response would assert that a table was written correctly and prove nothing about whether the
 * right token comes out of it — the same shape of gap yzae and 55fx.13 both closed one layer
 * lower down.
 *
 * EVERY SEED NOW DECLARES ITS REPOSITORIES (rockysurf-18lq), and that is the only thing about
 * this block that changed. Narrowing means a box receives the entries its declared repositories
 * select rather than all of them, so a seed that declared none used to be an accident of the
 * fixture and is now a box that correctly gets no scoped tokens at all. Declaring them keeps
 * every assertion below asking exactly what it asked before — which token the helper picks from
 * the table it holds — and the narrowing itself is proved in its own block, against the same
 * shell.
 */
describe('per-repository tokens reach the box and the helper picks between them', () => {
  let booted: BootedApp | undefined
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rockysurf-tokens-'))
  })

  afterEach(async () => {
    await booted?.close()
    booted = undefined
  })

  /**
   * The config the rest of this block boots: three scopes, one instance-wide fallback.
   *
   * BROADEST ENTRY FIRST, deliberately. Written specific-first, a helper that simply took the
   * first match would pass every assertion below while implementing no precedence at all —
   * the file order would be doing the work. This order fails that helper.
   *
   * THE REPOSITORY ENTRY IS WRITTEN THE EASY WAY, `repo: "acme/widgets"` (rockysurf-ly2n), so
   * this block also proves the one-string form is normalised ahead of everything else: the
   * scope it produces, the secrets response it lands in, and the token the helper picks below
   * are the same ones the split form produced before it.
   */
  /**
   * Repositories that between them select all three scoped entries of `CONFIG`, so the box these
   * tests seed carries the whole table and the helper has a real choice to make.
   */
  const ALL_THREE_SCOPES = [
    'https://github.com/acme/widgets.git',
    'https://github.com/acme/other',
    'https://git.example.com/anyone/anything',
  ]

  const CONFIG = [
    'github:',
    '  pat: "ghp_fallback"',
    '  tokens:',
    '    - owner: acme',
    '      pat: "ghp_acme"',
    '    - repo: "acme/widgets"',
    '      pat: "ghp_widgets"',
    '    - host: git.example.com',
    '      pat: "${ENTERPRISE_PAT}"',
    '',
  ].join('\n')

  it('selects most-specific-first: repo, then owner, then host, then the fallback', async () => {
    writeConfigIn(dir, CONFIG)
    booted = await boot({
      argv: [],
      cwd: dir,
      env: { ENTERPRISE_PAT: 'ghp_enterprise' },
      listen: false,
      announce: () => {},
      log: () => {},
    })

    // Everything below runs against THIS — the bytes a box receives, not a table the test built.
    const env = await fetchSecrets(booted, seedServer(booted, 'multi', ALL_THREE_SCOPES))

    expect(askCredentialHelper(env, { host: 'github.com', path: 'acme/widgets.git' })).toBe('ghp_widgets')
    expect(askCredentialHelper(env, { host: 'github.com', path: 'acme/other.git' })).toBe('ghp_acme')
    expect(askCredentialHelper(env, { host: 'git.example.com', path: 'anyone/anything' })).toBe('ghp_enterprise')
    // No entry names github.com/stranger, so the instance-wide token answers — which is
    // exactly what every installation did before this bead, unchanged.
    expect(askCredentialHelper(env, { host: 'github.com', path: 'stranger/thing' })).toBe('ghp_fallback')
    // ...and a host nobody named gets the fallback too, rather than someone else's token.
    expect(askCredentialHelper(env, { host: 'gitlab.com', path: 'acme/widgets' })).toBe('ghp_fallback')
  })

  it('matches case-insensitively, because github.com does', async () => {
    // A repositories field pasted from a browser reads `github.com/Acme/Widgets`. Matching it
    // case-sensitively against a config written in lower case would silently fall back to the
    // instance token and 404 on a repo the operator had configured correctly.
    writeConfigIn(dir, CONFIG)
    booted = await boot({
      argv: [],
      cwd: dir,
      env: { ENTERPRISE_PAT: 'ghp_enterprise' },
      listen: false,
      announce: () => {},
      log: () => {},
    })
    const env = await fetchSecrets(booted, seedServer(booted, 'case', ['https://github.com/Acme/Widgets.git']))

    expect(askCredentialHelper(env, { host: 'GitHub.com', path: 'Acme/Widgets.git' })).toBe('ghp_widgets')
  })

  it('answers nothing at all when no entry matches and there is no fallback', async () => {
    // The public-clone case, on a box that happens to hold private-repo tokens. Printing a
    // token here would offer it to a host nobody named; printing an empty password would make
    // git fail an authentication it never needed to attempt.
    writeConfigIn(dir, 'github:\n  tokens:\n    - owner: acme\n      pat: "ghp_acme"\n')
    booted = await boot({ argv: [], cwd: dir, env: {}, listen: false, announce: () => {}, log: () => {} })
    const env = await fetchSecrets(booted, seedServer(booted, 'nofallback', ['https://github.com/acme/private']))

    // No `github.pat`, so packs see no GITHUB_TOKEN — the set is not a substitute for it.
    expect(env['GITHUB_TOKEN']).toBeUndefined()
    expect(askCredentialHelper(env, { host: 'github.com', path: 'someone/public' })).toBeUndefined()
    expect(askCredentialHelper(env, { host: 'github.com', path: 'acme/private' })).toBe('ghp_acme')
  })

  it('leaves a path-less request to the fallback rather than guessing', async () => {
    // git omits `path=` unless `credential.useHttpPath` is on. If that config line is ever
    // dropped from the clone step, this is the behaviour every request degrades to — worth
    // being deliberate about rather than discovering as a wrong-token 404.
    writeConfigIn(dir, CONFIG)
    booted = await boot({
      argv: [],
      cwd: dir,
      env: { ENTERPRISE_PAT: 'ghp_enterprise' },
      listen: false,
      announce: () => {},
      log: () => {},
    })
    const env = await fetchSecrets(booted, seedServer(booted, 'nopath', ALL_THREE_SCOPES))

    expect(askCredentialHelper(env, { host: 'github.com' })).toBe('ghp_fallback')
    // A host-scoped entry still applies, because it needs no path to be sure.
    expect(askCredentialHelper(env, { host: 'git.example.com' })).toBe('ghp_enterprise')
  })

  it('rotates on restart, and persists nothing — the same custody as github.pat', async () => {
    writeConfigIn(dir, 'github:\n  tokens:\n    - owner: acme\n      pat: "ghp_before"\n')
    booted = await boot({ argv: [], cwd: dir, env: {}, listen: false, announce: () => {}, log: () => {} })
    expect(askCredentialHelper(await fetchSecrets(booted, seedServer(booted, 'rot-a', ['https://github.com/acme/widgets'])), {
      host: 'github.com',
      path: 'acme/widgets',
    })).toBe('ghp_before')
    // Nothing new is written to the encrypted store: the set exists in the file and in this
    // process, and nowhere else. A stored copy would shadow the file forever.
    expect(booted.secretsStore.listSecretRefs({ kind: 'github-token' })).toEqual([])
    await booted.close()

    writeConfigIn(dir, 'github:\n  tokens:\n    - owner: acme\n      pat: "ghp_after"\n')
    booted = await boot({ argv: [], cwd: dir, env: {}, listen: false, announce: () => {}, log: () => {} })
    expect(askCredentialHelper(await fetchSecrets(booted, seedServer(booted, 'rot-b', ['https://github.com/acme/widgets'])), {
      host: 'github.com',
      path: 'acme/widgets',
    })).toBe('ghp_after')
  })

  it('sends nothing extra when no tokens are configured, so nothing changes for anyone else', async () => {
    writeConfigIn(dir, 'github:\n  pat: "ghp_only"\n')
    booted = await boot({ argv: [], cwd: dir, env: {}, listen: false, announce: () => {}, log: () => {} })

    // The pre-ta7g environment, byte for byte: one variable, no count, no scopes.
    expect(await fetchSecrets(booted, seedServer(booted, 'compat'))).toEqual({ GITHUB_TOKEN: 'ghp_only' })
  })
})

describe('the shape of the token set in secrets.env (rockysurf-ta7g)', () => {
  it('indexes from 1 and pairs each token with a scope', async () => {
    const store = createSecretsStore(opened.db, Buffer.alloc(32, 7))
    const { row } = seed(['https://github.com/acme/widgets', 'https://git.example.com/x/y'])

    const env = await createServerSecretsLoader(store, {
      githubTokens: [
        { owner: 'acme', repo: 'widgets', pat: 'ghp_widgets' },
        { host: 'git.example.com', pat: 'ghp_enterprise' },
      ],
    })(row)

    expect(env).toEqual({
      ROCKYSURF_GITHUB_TOKEN_COUNT: '2',
      ROCKYSURF_GITHUB_TOKEN_1: 'ghp_widgets',
      ROCKYSURF_GITHUB_TOKEN_1_SCOPE: 'github.com/acme/widgets',
      ROCKYSURF_GITHUB_TOKEN_2: 'ghp_enterprise',
      ROCKYSURF_GITHUB_TOKEN_2_SCOPE: 'git.example.com/*/*',
    })
  })

  it('names the scope fields core’s own, not the pack contract', () => {
    // Every one of these lands in `secrets.env`, which the agent exports into every step's
    // environment — so a pack CAN read them. They are deliberately outside `SECRET_ENV_KEYS`
    // anyway: that set is a closed promise to pack authors, and this encoding is core's to
    // change. `GITHUB_TOKEN` stays the one name a pack should read.
    expect([...SECRET_ENV_KEY_NAMES]).not.toContain(GITHUB_TOKEN_SET_ENV.count)
    expect(GITHUB_TOKEN_SET_ENV.count.startsWith('ROCKYSURF_')).toBe(true)
    expect(GITHUB_TOKEN_SET_ENV.token(1).startsWith('ROCKYSURF_')).toBe(true)
    expect(GITHUB_TOKEN_SET_ENV.scope(1).startsWith('ROCKYSURF_')).toBe(true)
  })

  it('leaves the set out entirely when none is configured', async () => {
    const store = createSecretsStore(opened.db, Buffer.alloc(32, 7))
    const { row } = seed(['https://github.com/acme/widgets'])
    // An empty `_COUNT=0` would be harmless but dishonest; absent is what the helper's
    // `${…:-0}` default is written for.
    await expect(createServerSecretsLoader(store, { githubPat: 'ghp_x', githubTokens: [] })(row)).resolves.toEqual({
      GITHUB_TOKEN: 'ghp_x',
    })
  })
})

/**
 * NARROWING: a box receives the tokens its own repositories select, and no others
 * (rockysurf-18lq).
 *
 * THIS IS A DELIBERATE AMENDMENT to ta7g's instance-wide doctrine, so it is tested the way ta7g
 * was — from a config FILE, through a real boot, out of the real secrets route, and into the real
 * shell credential helper. The claim being proved has two halves and both need the shell:
 *
 *  1. the box gets LESS — a token for a repository it was never told about is simply not there,
 *     which is the security win and the entire point;
 *  2. every clone it WAS built for still resolves to exactly the token it resolved to before,
 *     because dropping non-winning entries cannot change a winner. That is an argument in
 *     `narrowTokensToRepositories`'s header, and an argument about precedence that is only ever
 *     checked in TypeScript is the drift this file's own helper comment warns about.
 */
describe('a box carries only the tokens its declared repositories need (rockysurf-18lq)', () => {
  let booted: BootedApp | undefined
  let dir: string

  /** Broadest first again, for the same reason the ta7g fixture is written that way. */
  const CONFIG = [
    'github:',
    '  pat: "ghp_fallback"',
    '  tokens:',
    '    - owner: acme',
    '      pat: "ghp_acme"',
    '    - repo: "acme/widgets"',
    '      pat: "ghp_widgets"',
    '    - host: git.example.com',
    '      pat: "ghp_enterprise"',
    '',
  ].join('\n')

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rockysurf-narrow-'))
    writeConfigIn(dir, CONFIG)
    booted = await boot({ argv: [], cwd: dir, env: {}, listen: false, announce: () => {}, log: () => {} })
  })

  afterEach(async () => {
    await booted?.close()
    booted = undefined
  })

  it('sends the entry a declared repository selects, and not the ones it does not', async () => {
    const env = await fetchSecrets(booted!, seedServer(booted!, 'one', ['https://github.com/acme/widgets']))

    // One scoped entry, because one repository was declared and it selects exactly one.
    expect(env[GITHUB_TOKEN_SET_ENV.count]).toBe('1')
    expect(env[GITHUB_TOKEN_SET_ENV.scope(1)]).toBe('github.com/acme/widgets')
    // The enterprise host's token is on the same installation and is NOT on this box. Before
    // this bead it was, and a compromise of this box handed over a credential for a forge it
    // had no business knowing existed.
    expect(Object.values(env)).not.toContain('ghp_enterprise')
    expect(Object.values(env)).not.toContain('ghp_acme')

    // ...and the clone it was built for is unaffected, asked of the real shell program.
    expect(askCredentialHelper(env, { host: 'github.com', path: 'acme/widgets.git' })).toBe('ghp_widgets')
  })

  it('keeps the OWNER entry when the declared repository needs it, and drops the repo entry', async () => {
    // The other side of precedence: `acme/other` is covered by the owner-scoped entry, and the
    // more specific `acme/widgets` entry is nothing to do with this box.
    const env = await fetchSecrets(booted!, seedServer(booted!, 'owner', ['https://github.com/acme/other']))

    expect(env[GITHUB_TOKEN_SET_ENV.count]).toBe('1')
    expect(env[GITHUB_TOKEN_SET_ENV.scope(1)]).toBe('github.com/acme/*')
    expect(Object.values(env)).not.toContain('ghp_widgets')
    expect(askCredentialHelper(env, { host: 'github.com', path: 'acme/other' })).toBe('ghp_acme')
  })

  it('gives a box that declared no repositories no scoped tokens at all', async () => {
    // A `requiresRepos: false` pack, or a create that named none. Every configured token used to
    // ride along; now none does, and the fallback is all that remains.
    const env = await fetchSecrets(booted!, seedServer(booted!, 'norepos'))

    expect(env[GITHUB_TOKEN_SET_ENV.count]).toBeUndefined()
    expect(env).toEqual({ GITHUB_TOKEN: 'ghp_fallback' })
  })

  it('SHIPS THE FALLBACK ANYWAY — the ruling, pinned', async () => {
    /*
     * `github.pat` is not narrowed, on any box, ever. It is not a token for a repository: it is
     * the instance's general-purpose GitHub credential, and `docs/writing-a-pack.md` promises
     * pack authors that `gh auth setup-git` works "when configured". Narrowing it away would
     * make that promise depend on which repositories somebody typed into a form, and would
     * break `gh` on precisely the best-configured boxes — every private repo covered by a
     * scoped entry, therefore nothing left over, therefore no `GITHUB_TOKEN`.
     */
    const covered = await fetchSecrets(booted!, seedServer(booted!, 'fb-a', ['https://github.com/acme/widgets']))
    expect(covered['GITHUB_TOKEN']).toBe('ghp_fallback')

    const bare = await fetchSecrets(booted!, seedServer(booted!, 'fb-b'))
    expect(bare['GITHUB_TOKEN']).toBe('ghp_fallback')

    const unmatched = await fetchSecrets(booted!, seedServer(booted!, 'fb-c', ['https://github.com/stranger/thing']))
    expect(unmatched['GITHUB_TOKEN']).toBe('ghp_fallback')
    // Nothing scoped, because nothing matched — but the fallback still answers for it.
    expect(unmatched[GITHUB_TOKEN_SET_ENV.count]).toBeUndefined()
    expect(askCredentialHelper(unmatched, { host: 'github.com', path: 'stranger/thing' })).toBe('ghp_fallback')
  })

  it('narrows case-insensitively and through a .git suffix, because matching does', async () => {
    // A URL pasted from a browser address bar. Narrowing that were case-sensitive would quietly
    // build a box with no token for a repository the operator had configured correctly — the
    // failure would appear minutes later, on the box, as a 404.
    const env = await fetchSecrets(booted!, seedServer(booted!, 'case', ['https://GitHub.com/Acme/Widgets.git']))

    expect(env[GITHUB_TOKEN_SET_ENV.scope(1)]).toBe('github.com/acme/widgets')
    expect(askCredentialHelper(env, { host: 'github.com', path: 'acme/widgets' })).toBe('ghp_widgets')
  })

  it('ignores text that is not a URL a box could clone, rather than guessing at it', async () => {
    // `createAnyway` means junk really does reach a row. An scp-style remote and a typo must
    // contribute no entry — narrowing that invented a match would hand out a token on the
    // strength of a string the preflight had already refused.
    const env = await fetchSecrets(
      booted!,
      seedServer(booted!, 'junk', ['git@github.com:acme/widgets.git', 'not a url', 'https://github.com/acme/widgets']),
    )

    expect(env[GITHUB_TOKEN_SET_ENV.count]).toBe('1')
    expect(env[GITHUB_TOKEN_SET_ENV.scope(1)]).toBe('github.com/acme/widgets')
  })

  it('gives two boxes on one installation two different sets', async () => {
    // The blast-radius claim, stated as one assertion: neither box can present the other's
    // credential, and before this bead both held both.
    const mine = await fetchSecrets(booted!, seedServer(booted!, 'sep-a', ['https://github.com/acme/widgets']))
    const theirs = await fetchSecrets(booted!, seedServer(booted!, 'sep-b', ['https://git.example.com/ops/infra']))

    expect(askCredentialHelper(mine, { host: 'git.example.com', path: 'ops/infra' })).toBe('ghp_fallback')
    expect(askCredentialHelper(theirs, { host: 'github.com', path: 'acme/widgets' })).toBe('ghp_fallback')
    expect(askCredentialHelper(mine, { host: 'github.com', path: 'acme/widgets' })).toBe('ghp_widgets')
    expect(askCredentialHelper(theirs, { host: 'git.example.com', path: 'ops/infra' })).toBe('ghp_enterprise')
  })
})

/**
 * The desktop password reaches the box, from the POST the SPA sends (rockysurf-z0wf).
 *
 * THE THIRD TIME THIS SHAPE OF GAP HAS BEEN FOUND, and the reason this test starts at an HTTP
 * request rather than at the store. Everything on the box end was finished: `SECRET_ENV_KEYS`
 * named `RDP_PASSWORD`, the loader read `getRdpPassword`, the resolver injected a `chpasswd`
 * step for every `requiresRdp` pack, and the SPA had a password field with confirmation and a
 * length rule. What did not exist was the ONE link between them — `putRdpPassword` had no
 * production caller, and `POST /api/v1/servers` declared `rdpPassword` on its body schema,
 * validated it, and then never mentioned it again.
 *
 * The failure that produced is worth stating because it is the opposite of loud: the box came
 * up, SSH worked, xrdp installed, sesman accepted the connection, and PAM refused every
 * password there was to type — `rocky`'s shadow field still held the `!` cloud-init left. The
 * only honest test is one that begins where the user's password begins.
 */
describe('a desktop password posted to the create route reaches the box', () => {
  let booted: BootedApp | undefined
  let dir: string
  let cookie: string

  const PASSWORD = 'admin-password-for-the-test'
  const RDP = 'a-desktop-password'
  const DESKTOP_PACK = 'test-desktop'

  /** The create request the SPA sends for a `requiresRdp` pack. */
  const createServer = async (body: Record<string, unknown>) =>
    booted!.app.request('/api/v1/servers', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ size: 'small', packId: DESKTOP_PACK, ...body }),
    })

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'rockysurf-rdp-'))
    writeConfigIn(dir, '')
    process.env[ADMIN_PASSWORD_ENV] = PASSWORD
    booted = await boot({ argv: [], cwd: dir, env: {}, listen: false, announce: () => {}, log: () => {} })

    // A pack that asks for a desktop, in the database `boot()` opened. Seeded rather than
    // read from `packs/` because the packs directory boot picks is relative to the process
    // cwd, and what is under test is the credential path, not pack discovery.
    upsertPack(booted.db.db, {
      id: DESKTOP_PACK,
      name: 'Test desktop',
      tools: [],
      displayOrder: 1,
      enabled: true,
      requiresRepos: false,
      requiresRdp: true,
      desktop: 'xfce',
    })

    const login = await booted.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    expect(login.status).toBe(200)
    cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
  })

  afterEach(async () => {
    delete process.env[ADMIN_PASSWORD_ENV]
    await booted?.close()
    booted = undefined
  })

  it('serves the password the user typed, through the route a box actually calls', async () => {
    const res = await createServer({ rdpPassword: RDP })
    expect(res.status).toBe(201)
    const { serverId } = (await res.json()) as { serverId: string }

    // Not `booted.secretsStore.getRdpPassword(serverId)`: that would prove the store was
    // written and nothing about what the box receives. This is the response the box gets.
    expect(await fetchSecrets(booted!, serverId)).toEqual({ RDP_PASSWORD: RDP })
  })

  it('gives the box a plan whose rdp step consumes exactly that variable', async () => {
    const res = await createServer({ rdpPassword: RDP })
    const { serverId } = (await res.json()) as { serverId: string }

    // The other half of the contract, asserted against the SNAPSHOT the box will execute
    // rather than against a plan this test resolved for itself.
    const plan = parseInstallPlan(getServer(booted!.db.db, serverId)!.installPlan!)
    const rdp = plan.steps.find((step) => step.id === 'rdp')
    expect(rdp).toBeDefined()
    expect(rdp!.run).toContain('"$RDP_PASSWORD"')
    // Never in argv, where `ps` would show it to every unprivileged step on the same box.
    expect(rdp!.run).not.toContain(RDP)
  })

  it('omits the key when no password was posted, rather than emitting it empty', async () => {
    // `RDP_PASSWORD=` would pass the step's `-z` guard and set an EMPTY desktop password.
    const res = await createServer({})
    expect(res.status).toBe(201)
    const { serverId } = (await res.json()) as { serverId: string }
    expect(await fetchSecrets(booted!, serverId)).toEqual({})
  })

  it('refuses a password too short to be one, instead of accepting and dropping it', async () => {
    // The SPA has always required eight characters. The API accepted anything, which mattered
    // for exactly as long as the value went nowhere.
    expect((await createServer({ rdpPassword: 'short' })).status).toBe(400)
  })

  it('never returns the password from any route the user’s browser calls', async () => {
    const res = await createServer({ rdpPassword: RDP })
    const created = await res.text()
    const detail = await (await booted!.app.request(`/api/v1/servers/${JSON.parse(created).serverId}`, { headers: { cookie } })).text()
    const list = await (await booted!.app.request('/api/v1/servers', { headers: { cookie } })).text()

    // The custody rule, checked from the outside: the create response, the detail route and
    // the list route are the three places a password would leak into a browser tab or a log.
    for (const body of [created, detail, list]) expect(body).not.toContain(RDP)
  })

  it('scopes the password to the server, not to the user who owns it', async () => {
    // `RDP_PASSWORD` is per-SERVER because it is set on that box's own `rocky` account —
    // the split `SECRET_ENV_KEYS` states against `GITHUB_TOKEN`, which is per-user.
    const first = (await (await createServer({ rdpPassword: RDP })).json()) as { serverId: string }
    const second = (await (await createServer({ rdpPassword: 'a-different-one' })).json()) as { serverId: string }

    expect(await fetchSecrets(booted!, first.serverId)).toEqual({ RDP_PASSWORD: RDP })
    expect(await fetchSecrets(booted!, second.serverId)).toEqual({ RDP_PASSWORD: 'a-different-one' })
  })
})

/**
 * PACK INPUTS REACH EVERY STEP THROUGH THIS ONE FILE (issue #189, ADR-0013).
 *
 * The delivery claim is the whole feature, and it has three separable halves: the loader puts
 * both kinds of value in the environment, the writer produces a file a shell can actually
 * source, and `agent.sh` forwards it to root and unprivileged steps alike. The first two are
 * asserted here; the third is asserted by exercising the real `agent.sh` in
 * `agent-environment.test.ts` and by the push smoke.
 */
describe('a pack’s own inputs in secrets.env (issue #189)', () => {
  const store = () => createSecretsStore(opened.db, Buffer.alloc(32, 7))

  function seedWithInputs(values: Record<string, string>): ReturnType<typeof seed> {
    const seeded = seed()
    opened.db
      .update(servers)
      .set({ packInputs: JSON.stringify(values) })
      .where(eq(servers.id, seeded.row.id))
      .run()
    return { ...seeded, row: getServer(opened.db, seeded.row.id)! }
  }

  it('delivers the non-secret half from the ROW and the secret half from the STORE', async () => {
    const secrets = store()
    const { row } = seedWithInputs({ HEADLONG_HEADLESS: '1' })
    secrets.putPackInputSecrets(row.id, { HEADLONG_API_KEY: 'sk-live' })

    const env = await createServerSecretsLoader(secrets)(row)
    expect(env['HEADLONG_HEADLESS']).toBe('1')
    expect(env['HEADLONG_API_KEY']).toBe('sk-live')
  })

  it('never lets a pack input displace a name the platform promises', async () => {
    // `packs/schema.ts` refuses `GITHUB_TOKEN` as an input name, so this cannot happen through
    // the create route at all. The ordering here is the second lock: a row hand-edited past the
    // schema still cannot take a name a pack author was promised.
    const secrets = store()
    const { row, userId } = seedWithInputs({ GITHUB_TOKEN: 'attacker-token' })
    secrets.putGithubToken(userId, 'ghp_real')

    expect((await createServerSecretsLoader(secrets)(row))['GITHUB_TOKEN']).toBe('ghp_real')
  })

  it('writes no secret row at all for a server with no secret inputs', () => {
    const secrets = store()
    const { row } = seed()
    // `{}` would leave a secret-shaped artefact with nothing in it for every listing and audit
    // to explain.
    expect(secrets.putPackInputSecrets(row.id, {})).toBeUndefined()
    expect(secrets.listSecretRefs({ kind: 'pack-inputs' })).toEqual([])
    expect(secrets.getPackInputSecrets(row.id)).toEqual({})
  })

  it('gives a box with no inputs exactly the environment it had before', async () => {
    const { row } = seed()
    expect(await createServerSecretsLoader(store())(row)).toEqual({})
  })
})

/**
 * `secrets.env` IS SHELL SOURCE, and a pack input is whatever a person typed into a form.
 *
 * `agent.sh` loads the file with `set -a; . secrets.env`, so an unquoted value with a space runs
 * a command, and one containing `$(…)` executes it as root. The values were previously all
 * shapes core controlled — a PAT, a password, a `host/owner/repo` scope the config schema
 * restricts — and that stopped being true with issue #189. The test runs the REAL bash rather
 * than asserting on the text, because the question is what a shell does with it.
 */
describe('the secrets.env writer quotes what a shell would otherwise execute', () => {
  const sourceAndEcho = (pairs: Record<string, string>, name: string): { status: number; value: string } => {
    const file = join(mkdtempSync(join(tmpdir(), 'rockysurf-secrets-')), 'secrets.env')
    writeFileSync(file, `${renderSecretsEnv(pairs)}\n`)
    const result = spawnSync('/bin/bash', ['-c', `set -a; . "$1"; set +a; printf %s "\${${name}}"`, 'sh', file], {
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
      encoding: 'utf8',
    })
    return { status: result.status ?? -1, value: result.stdout }
  }

  it('carries a value with spaces through intact', () => {
    // Unquoted this is `FOO=a` followed by an attempt to run `b`.
    expect(sourceAndEcho({ MODEL: 'claude opus 5' }, 'MODEL')).toEqual({ status: 0, value: 'claude opus 5' })
  })

  it('does not execute a command substitution or expand a variable', () => {
    const marker = '$(id -u)`whoami`${HOME}'
    expect(sourceAndEcho({ HEADLONG_ENDPOINT: marker }, 'HEADLONG_ENDPOINT')).toEqual({ status: 0, value: marker })
  })

  it('survives a value containing a single quote', () => {
    expect(sourceAndEcho({ NOTE: "it's fine" }, 'NOTE')).toEqual({ status: 0, value: "it's fine" })
  })

  it('still lets the agent read the NAME as everything before the first =', () => {
    // `load_secrets` in `agent.sh` does `while IFS='=' read -r name _`, which is how a value
    // reaches an unprivileged step at all. Quoting the VALUE must not change that.
    const rendered = renderSecretsEnv({ A: 'x=y', B: 'z' })
    expect(rendered.split('\n').map((line) => line.split('=')[0])).toEqual(['A', 'B'])
  })
})

/**
 * THE USER'S OWN ENVIRONMENT REACHES THE BOX THE SAME WAY (issue #197, ADR-0014).
 *
 * The point of the feature is that a startup script (ADR-0011) can read `$MY_TOKEN` without the
 * token being stored in plain text anywhere — so the delivery claim is what has to be true. Four
 * sources fold into one environment here; `agent-environment.test.ts` proves the real `agent.sh`
 * forwards it to root and unprivileged steps alike.
 */
describe('an environment the creator supplied, in secrets.env (issue #197)', () => {
  const store = () => createSecretsStore(opened.db, Buffer.alloc(32, 7))

  function seedWith(columns: { packInputs?: Record<string, string>; environment?: Record<string, string> }) {
    const seeded = seed()
    opened.db
      .update(servers)
      .set({
        ...(columns.packInputs ? { packInputs: JSON.stringify(columns.packInputs) } : {}),
        ...(columns.environment ? { environment: JSON.stringify(columns.environment) } : {}),
      })
      .where(eq(servers.id, seeded.row.id))
      .run()
    return { ...seeded, row: getServer(opened.db, seeded.row.id)! }
  }

  it('folds all four sources into one environment', async () => {
    const secrets = store()
    const { row } = seedWith({ packInputs: { HEADLONG_HEADLESS: '1' }, environment: { MY_ENDPOINT: 'https://mine' } })
    secrets.putPackInputSecrets(row.id, { HEADLONG_API_KEY: 'sk-live' })
    secrets.putServerEnvironmentSecrets(row.id, { MY_TOKEN: 'ghp-mine' })

    const env = await createServerSecretsLoader(secrets)(row)
    expect(env['HEADLONG_HEADLESS']).toBe('1')
    expect(env['HEADLONG_API_KEY']).toBe('sk-live')
    expect(env['MY_ENDPOINT']).toBe('https://mine')
    expect(env['MY_TOKEN']).toBe('ghp-mine')
  })

  it('never lets a supplied name displace one the platform promises', async () => {
    // `env/names.ts` refuses `GITHUB_TOKEN` at the create route, so this cannot happen through
    // the API at all. The ordering here is the second lock: a row hand-edited past the rules
    // still cannot take a name a pack author was promised.
    const secrets = store()
    const { row, userId } = seedWith({ environment: { GITHUB_TOKEN: 'attacker-token' } })
    secrets.putGithubToken(userId, 'ghp_real')

    expect((await createServerSecretsLoader(secrets)(row))['GITHUB_TOKEN']).toBe('ghp_real')
  })

  it('writes no secret row at all for a server with no secret lines', () => {
    const secrets = store()
    const { row } = seed()
    expect(secrets.putServerEnvironmentSecrets(row.id, {})).toBeUndefined()
    expect(secrets.listSecretRefs({ kind: 'server-environment' })).toEqual([])
    expect(secrets.getServerEnvironmentSecrets(row.id)).toEqual({})
  })

  it('keeps the two kinds apart, so a pack input is never read back as an environment line', () => {
    const secrets = store()
    const { row } = seed()
    secrets.putPackInputSecrets(row.id, { FROM_PACK: 'a' })
    secrets.putServerEnvironmentSecrets(row.id, { FROM_USER: 'b' })
    expect(secrets.getPackInputSecrets(row.id)).toEqual({ FROM_PACK: 'a' })
    expect(secrets.getServerEnvironmentSecrets(row.id)).toEqual({ FROM_USER: 'b' })
  })
})
