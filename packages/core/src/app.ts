import { serveStatic } from '@hono/node-server/serve-static'
import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { Hono, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { createPreferenceReader, type Config } from './config/index.js'
import type { Db } from './db/client.js'
import { getPack } from './db/repositories/packs.js'
import { getUserByGithubUsername } from './db/repositories/users.js'
import type { ServerRow, Session, User } from './db/schema.js'
import { ADMIN_PASSWORD_HASH_KEY, LOCAL_ADMIN_USERNAME } from './auth/admin.js'
import { verifyPassword } from './auth/passwords.js'
import type { SecretStore } from './auth/secret-store.js'
import {
  DEFAULT_SESSION_TTL_MS,
  issueSession,
  resolveSession,
  revokeSession,
  SESSION_COOKIE,
} from './auth/sessions.js'
import { badRequest, serverError, success, unauthorized } from './http/responses.js'
import { validate } from './http/validate.js'
import { createInternalRoutes } from './bootstrap/internal-routes.js'
import { bootstrapModeHooks } from './bootstrap/push-runner.js'
import { snapshotInstallPlan } from './bootstrap/install-plan.js'
import { createSimulatedBootstrap } from './bootstrap/simulated-bootstrap.js'
import { createPushBootstrapSupervisor } from './bootstrap/supervisor.js'
import { createCostsRoutes } from './costs/routes.js'
import { createRegistryClient, type RegistryClient } from './packs/registry.js'
import { createPackRoutes } from './packs/routes.js'
import type { SecretsStore } from './secrets/store.js'
import { createDefaultRegistry, type ProviderRegistry } from './providers/registry.js'
import { createJobs, type Jobs } from './jobs/index.js'
import { createLifecycleService, type LifecycleService } from './servers/lifecycle.js'
import { preflightRepositories, preflightRepository } from './git/preflight.js'
import { createGitRoutes } from './git/resolve.js'
import { createGithubRoutes } from './github/routes.js'
import type { FetchLike } from './github/device-flow.js'
import { narrowTokensToRepositories } from './git/token-matching.js'
import { githubTokenScope } from './bootstrap/server-secrets.js'
import { createServerRoutes } from './servers/routes.js'
import { createSettingsRoutes } from './settings/routes.js'
import { createSetupRoutes } from './setup/routes.js'
import { createEventsService, type EventsService } from './services/events.js'
import { createSshKeyRoutes } from './ssh/routes.js'

/**
 * The control-plane HTTP surface.
 *
 * SCAFFOLD SCOPE (rockysurf-gonw.7): health, single-admin auth, and the SSE stream. Server,
 * pack and tool routes land in gonw.8 and 4b; static serving is a stub until 4d. What is here
 * is the shape everything else hangs off — an app FACTORY taking its dependencies, so tests
 * build one per case with an in-memory database and no globals.
 */

export interface AppEnv {
  Variables: {
    user: User
    session: Session
  }
}

export interface AppDeps {
  db: Db
  config: Config
  /** Where the admin password hash is read from. See auth/secret-store.ts for the gonw.6 seam. */
  secrets: SecretStore
  /**
   * The encrypted secrets store (rockysurf-gonw.6), holding per-server SSH key material.
   *
   * Optional so tests that exercise auth or packs need not build one. When absent the
   * private-key download route is not mounted at all — a 404 rather than a route that
   * discovers at request time that it has nowhere to read from.
   */
  secretsStore?: SecretsStore
  /**
   * Reads the decrypted per-server secrets a callback-mode box fetches (git token, remote
   * desktop password). Injected so the internal routes never reach into the secret store
   * themselves; absent means the secrets endpoint serves an empty set rather than 500ing.
   */
  loadServerSecrets?: (server: ServerRow) => Promise<Record<string, string>>
  /**
   * The `fetch` the GitHub device flow uses (rockysurf-7fyf.1). Production leaves it unset and
   * gets the platform one; the tests pass a stub, which is what keeps the suite offline.
   */
  githubFetch?: FetchLike
  /** Shared with the boot path and the job loop, so both can push to open streams. */
  events?: EventsService
  sessionTtlMs?: number
  /** SSE keep-alive interval. Tests shorten it; the default matches proxy idle timeouts. */
  heartbeatMs?: number
  /** Built SPA assets. Absent until 4d. */
  publicDir?: string
  /**
   * The pack registry client (rockysurf-arym.4). Defaults to one built from `config.registry`.
   *
   * Injectable for the same reason `PackRoutesDeps.fetchText` is: the real client goes through
   * the SSRF guard, which correctly refuses the loopback addresses a test server lives on, so a
   * test of the shop seam has to supply its own. Constructing the default performs no fetch, so
   * an app that never opens the shop never touches the network.
   */
  registry?: RegistryClient
  /**
   * The config file this process loaded, so the settings editor writes the file that is
   * actually in force (rockysurf-m29b).
   *
   * Passed in rather than resolved here, for the reason the whole factory takes its
   * dependencies: `createApp` must not read `process.argv`. Absent means the settings routes
   * are not mounted at all — the same shape as the SSH-key download without a secrets store,
   * and honest about it, since an editor that cannot name the file it edits has nothing to
   * offer. `boot()` always supplies it.
   */
  configPath?: string
  /**
   * The environment `${VAR}` references in the config file are checked against.
   *
   * Only the two features that read the FILE rather than the loaded config need it — the
   * settings editor, which warns about a reference it cannot resolve, and the create screen's
   * token display, which says the same thing about a token entry (rockysurf-18lq). Injectable
   * for the reason everything else here is: `createApp` reads no ambient state, and a test
   * asserting on "the variable is not set" must be able to say so rather than hope.
   */
  env?: NodeJS.ProcessEnv
  /**
   * Compute providers. Defaults to the in-memory fake, so a fresh `npx rockysurf` with no
   * cloud credentials is still a working control plane (rockysurf-55fx.1).
   */
  providers?: ProviderRegistry
  /** Injected by tests that need to drive the lifecycle directly. */
  lifecycle?: LifecycleService
  /** Injected by tests. Built here by default so limits are enforced without extra wiring. */
  jobs?: Jobs
}

export interface CreatedApp {
  app: Hono<AppEnv>
  events: EventsService
  /**
   * The in-process job loop (rockysurf-55fx.6). NOT started here — `boot()` starts it and
   * stops it, because starting timers as a side effect of building an app would leave every
   * test that builds one leaking intervals.
   */
  jobs: Jobs
  /**
   * The lifecycle's provider refresh, exposed so `boot()` can run the startup recovery pass
   * over it (rockysurf-55fx.7). It already honours the describe() propagation grace, which is
   * why recovery asks it rather than calling `describe()` itself.
   */
  sync: (row: ServerRow) => Promise<ServerRow>
}

/**
 * 25 seconds. Comfortably under the 30s idle timeout that nginx, Cloudflare and most reverse
 * proxies apply by default — a stream that only speaks when something happens gets closed by
 * the middlebox long before the user notices anything is wrong.
 */
const DEFAULT_HEARTBEAT_MS = 25_000

const loginBody = z.strictObject({
  password: z.string().min(1, { error: 'password is required' }),
})

/** The user as the SPA sees it. */
const publicUser = (user: User) => ({
  id: user.id,
  username: user.githubUsername,
  email: user.email,
  avatarUrl: user.avatarUrl,
  isAdmin: user.isAdmin,
})

export function createApp(deps: AppDeps): CreatedApp {
  const { db, config, secrets } = deps
  const events = deps.events ?? createEventsService()
  const sessionTtlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  // Secure cookies only when core is actually served over TLS; a `Secure` cookie on plain
  // http://localhost is silently dropped by the browser, which would make first-run login
  // fail in the one setup every self-hoster starts with.
  const secureCookie = config.server.publicUrl?.startsWith('https:') ?? false

  const registry = deps.providers ?? createDefaultRegistry()
  const bootstrapHooks = bootstrapModeHooks(db, config)

  /**
   * The push bootstrap, driven by the provision ticker (rockysurf-55fx.13).
   *
   * Only with a secrets store, and that is a hard requirement rather than a convenience: the
   * push authenticates with the per-server private key, which lives nowhere else. Without the
   * store there is no key to connect with, so the ticker syncs rows and installs nothing —
   * the same shape as the SSH-key download route just below, which is also not mounted when
   * there is nothing to decrypt. `boot()` always builds one.
   */
  const bootstrap = deps.secretsStore
    ? createPushBootstrapSupervisor({
        db,
        events,
        secrets: deps.secretsStore,
        // How the supervisor learns that a row's provider has no machine to dial (ADR-0003,
        // amendment E15). Passed unconditionally and inert unless a provider says so, which is
        // what keeps this out of configuration: there is no "demo mode" to switch on by mistake
        // against a real cloud.
        capabilities: (providerId) => (registry.has(providerId) ? registry.get(providerId).capabilities : undefined),
        simulate: createSimulatedBootstrap(),
        ...(deps.loadServerSecrets ? { loadServerSecrets: deps.loadServerSecrets } : {}),
      })
    : undefined

  /**
   * Jobs and the lifecycle service each need the other: the jobs' provision ticker syncs
   * through `lifecycle.sync`, and the lifecycle's create path enforces limits through
   * `jobs.checkLimits`. The cycle is broken with a late-bound `sync` — jobs only call it at
   * tick time, by which point the lifecycle exists.
   */
  let lifecycleRef: LifecycleService | undefined
  const jobs =
    deps.jobs ??
    createJobs({
      db,
      registry,
      events,
      limits: config.limits,
      sync: (row) => {
        if (!lifecycleRef) throw new Error('jobs ticked before the lifecycle service was built')
        return lifecycleRef.sync(row)
      },
      ...(bootstrap ? { bootstrap } : {}),
      onFailure: config.bootstrap.onFailure,
    })

  const lifecycle =
    deps.lifecycle ??
    createLifecycleService({
      checkLimits: jobs.checkLimits,
      db,
      registry,
      events,
      // Hand the store to the lifecycle and let it own the SSH identity: it mints once,
      // before the provider is called, through `ensureServerKeys`, and passes the same keys
      // to its own user-data renderer. An override here would be a second place that mints,
      // and the failure mode of two minters is a box authorizing one key while core keeps the
      // private half of the other.
      ...(deps.secretsStore ? { secretsStore: deps.secretsStore } : {}),
      // Topology selection + whatever that topology needs before the provider is called.
      // Push is the default and mints nothing; callback mints its tokens onto the new row.
      selectBootstrapMode: bootstrapHooks.selectMode,
      prepareBootstrapMode: bootstrapHooks.mintTokensIfNeeded,
      // What the box will actually install, frozen onto the row at create time. Push reads it
      // from there; callback serves it to the box. Neither topology works without it.
      snapshotInstallPlan: (row, mode, options) =>
        void snapshotInstallPlan(db, row, {
          mode,
          ...(config.server.publicUrl ? { publicUrl: config.server.publicUrl } : {}),
          ...(options?.managedPublicKey ? { managedPublicKey: options.managedPublicKey } : {}),
          ...(options?.secretEnvironmentNames ? { secretEnvironmentNames: options.secretEnvironmentNames } : {}),
        }),
    })

  const app = new Hono<AppEnv>()

  app.onError((err, c) => {
    console.error('unhandled error', err)
    return serverError(c)
  })

  /** Bearer first so scripts and the CLI have a header-only path; cookie for the browser. */
  function presentedToken(c: Parameters<MiddlewareHandler<AppEnv>>[0]): string | undefined {
    const header = c.req.header('authorization')
    if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
    return getCookie(c, SESSION_COOKIE)
  }

  const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
    const resolved = resolveSession(db, presentedToken(c))
    if (!resolved) return unauthorized(c)
    c.set('user', resolved.user)
    c.set('session', resolved.session)
    await next()
  }

  /* ----------------------------------------------------------------- unauthenticated */

  app.get('/health', (c) =>
    success(c, {
      ok: true,
      name: 'rockysurf',
      authMode: config.auth.mode,
      providers: Object.entries(config.providers)
        .filter(([, provider]) => provider.enabled)
        .map(([id]) => id),
    }),
  )

  app.post('/api/v1/auth/login', validate('json', loginBody), async (c) => {
    const { password } = c.req.valid('json')

    if (config.auth.mode !== 'local') {
      return badRequest(c, `password login is not available in auth mode "${config.auth.mode}"`)
    }

    const storedHash = await secrets.get(ADMIN_PASSWORD_HASH_KEY)
    // verifyPassword burns equivalent scrypt work when the hash is absent, so "no admin
    // configured" and "wrong password" cost the same and look the same.
    if (!verifyPassword(password, storedHash)) return unauthorized(c, 'Invalid password')

    const user = findLocalAdmin(db)
    if (!user) return serverError(c, 'no admin account exists')

    const { token } = issueSession(db, user.id, sessionTtlMs)
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: secureCookie,
      maxAge: Math.floor(sessionTtlMs / 1000),
    })

    // The token is also returned so a non-browser client (CLI, MCP server) can use the
    // bearer path without parsing Set-Cookie.
    return success(c, { user: publicUser(user), token })
  })

  /* ------------------------------------------------------------------- authenticated */

  // Everything under /api/v1 needs a session except logging in.
  app.use('/api/v1/*', async (c, next) => {
    if (c.req.path === '/api/v1/auth/login') return next()
    return requireAuth(c, next)
  })

  app.post('/api/v1/auth/logout', (c) => {
    revokeSession(db, presentedToken(c))
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return success(c, { ok: true })
  })

  app.get('/api/v1/auth/me', (c) => success(c, { user: publicUser(c.get('user')) }))

  /**
   * The SSE stream that replaces the WebSocket API.
   *
   * Three things this has to get right, all of which are about the connection ending rather
   * than the data flowing: unsubscribe when the client goes away (or every closed tab leaks a
   * listener for the life of the process), stop the heartbeat with it, and keep both safe to
   * run twice, because abort and normal completion can both fire.
   */
  app.get('/api/v1/events', (c) => {
    const user = c.get('user')
    return streamSSE(c, async (stream) => {
      const unsubscribe = events.subscribe(user.id, (payload) => {
        void stream.writeSSE({ event: 'message', data: JSON.stringify(payload) })
      })

      const heartbeat = setInterval(() => {
        // An SSE comment: ignored by EventSource, enough to keep a proxy from idling us out.
        void stream.write(': heartbeat\n\n')
      }, heartbeatMs)

      await stream.writeSSE({ event: 'connected', data: JSON.stringify({ userId: user.id }) })

      try {
        await new Promise<void>((resolve) => {
          stream.onAbort(resolve)
        })
      } finally {
        clearInterval(heartbeat)
        unsubscribe()
      }
    })
  })

  /* ------------------------------------------------------------------- tools & packs */

  // Mounted after the /api/v1/* auth middleware above, so every route inside it inherits a
  // session; the admin half applies its own isAdmin check on top.
  // The pack registry client is built HERE, from the config this app was handed, rather than
  // injected — it is a pure function of `config.registry` with no lifecycle and nothing to
  // close. Constructing it performs no fetch (rockysurf-arym.3), so this costs nothing at boot
  // and a control plane with no route off the machine starts exactly as it did before.
  app.route(
    '/',
    createPackRoutes({ db, registry: deps.registry ?? createRegistryClient({ config: config.registry }) }),
  )

  /* ---------------------------------------------------------------------------- costs */

  // Read-only spend view (rockysurf-hzi7.4). Shares the jobs' spend tracker rather than
  // recomputing, so the number the page shows and the number the create path enforces the cap
  // against are the same number.
  app.route('/', createCostsRoutes({ db, spend: jobs.spend, limits: config.limits }))

  /*
   * The box-facing callback routes, mounted OUTSIDE `/api/v1` on purpose: a booting server
   * has no session, and authenticates with a per-server token instead. Callback mode only —
   * a push-mode server never has tokens minted, so every one of these returns 401 for it.
   */
  app.route(
    '/',
    createInternalRoutes({
      db,
      events,
      loadServerSecrets: deps.loadServerSecrets,
      ...(deps.secretsStore ? { secrets: deps.secretsStore } : {}),
      // So a callback-mode tool failure releases the machine the same way push mode's does
      // (ADR-0010): one rule, both topologies.
      registry,
      onFailure: config.bootstrap.onFailure,
    }),
  )
  /*
   * The repository preflight is composed HERE (rockysurf-k6xp), for the same reason the token
   * set is passed rather than stored (`server.ts`, yzae): the credentials it needs live in the
   * config file and in the encrypted store, and the route must not grow a dependency on either.
   *
   * It predicts the token the BOX would choose, so it reads the same two sources the box's
   * `secrets.env` is built from — `github.tokens` in file order, and the instance-wide
   * `github.pat` as the fallback. The per-user stored token that `server-secrets.ts` prefers
   * over `github.pat` is deliberately NOT read here: this runs before a row exists, there is no
   * server to attribute it to, and reaching into the secrets store for a user's PAT to make a
   * network request they did not ask for is a custody decision this check has no business
   * making. The consequence is stated in the refusal: it names the causes rather than claiming
   * to have ruled them out.
   */
  const preflightDeps = () => ({
    tokens: config.github.tokens,
    ...(config.github.pat ? { fallbackToken: config.github.pat } : {}),
  })
  app.route(
    '/',
    createServerRoutes({
      lifecycle,
      registry,
      preflightRepositories: (urls) => preflightRepositories(urls, preflightDeps()),
      /*
       * WHICH TOKENS A BOX CARRIES, for its own detail page (rockysurf-18lq) — scope identities
       * only, never values, and computed by the same narrowing function that decides what is
       * actually written into `secrets.env`.
       *
       * It is derived from the row's declared repositories under the CURRENT configuration
       * rather than recorded at create, and the page says so: a box keeps whatever its
       * `secrets.env` was built with (there is no re-push), so an operator who has since edited
       * `github.tokens` and restarted is reading a prediction of a decision already made. The
       * alternative — a column holding the deployed scopes — buys accuracy for exactly that case
       * and costs a migration plus a second source of truth about what the box holds; ta7g
       * already states the rule that makes the prediction safe to read ("boxes already built keep
       * what they were built with"), so the page states it too.
       */
      githubTokenScopes: (repositories) =>
        narrowTokensToRepositories(config.github.tokens, repositories).map(githubTokenScope),
      carriesFallbackToken: Boolean(config.github.pat),
      /*
       * WHAT THE SELECTED PACK ASKS FOR, so the create route can check the request against it
       * (issue #189, ADR-0013).
       *
       * A lookup rather than the database, for the reason every other hook on this route is one:
       * the route validates a request and must not grow the ability to read anything else. The
       * declaration comes off the packs table, which is the cache of `packs/*.yaml` (ADR-0004),
       * so an operator who edits a pack's inputs and restarts gets the new question on the next
       * create — and servers already built keep the answers they were built with, on their own
       * rows.
       */
      packInputs: (packId) => getPack(db, packId)?.inputs,
      /*
       * `providers.<cloud>.sizes`, finally read by something (rockysurf-j10e).
       *
       * The section is looked up BY REGISTRY ID rather than by a list of cloud names written
       * here, so this stays a generic read of whatever the config file has — the same shape as
       * the `Object.entries(config.providers)` above, and no provider-id conditional enters
       * core. A provider with no section, or a section with no `sizes`, yields `undefined`,
       * which the route reads as "offer everything": the documented default, and the one an
       * operator who has never heard of this field gets.
       */
      /*
       * The user's saved type for a size on a cloud (issue #124), read from the FILE rather
       * than from the config this process booted with — see `config/live-preferences.ts` for
       * why this one block is the exception. Same shape as `offeringAllowlist` above: a
       * function taking a registry id, so no cloud's name enters core.
       */
      tierPreference: createPreferenceReader({
        booted: config.preferences,
        ...(deps.configPath ? { configPath: deps.configPath } : {}),
      }),
      offeringAllowlist: (providerId) => {
        const section: unknown = (config.providers as Record<string, unknown>)[providerId]
        if (typeof section !== 'object' || section === null) return undefined
        const sizes: unknown = (section as { sizes?: unknown }).sizes
        if (!Array.isArray(sizes) || sizes.some((s) => typeof s !== 'string')) return undefined
        return sizes as readonly string[]
      },
    }),
  )
  /*
   * The create screen's live token display (rockysurf-18lq): the same matching module and the
   * same preflight the create route uses, offered read-only so the answer arrives while the URL
   * is being typed rather than after a machine has been launched. `configPath` is passed so it
   * can also say when the FILE holds a token this process has not restarted into.
   */
  app.route(
    '/',
    createGitRoutes({
      preflight: (url) => preflightRepository(url, preflightDeps()),
      ...preflightDeps(),
      ...(deps.configPath ? { configPath: deps.configPath } : {}),
      ...(deps.env ? { env: deps.env } : {}),
    }),
  )
  // First-run wizard state and credential capture (rockysurf-hzi7.2).
  app.route('/', createSetupRoutes({ config, registry, ...(deps.secretsStore ? { secrets: deps.secretsStore } : {}) }))
  // The config-file editor (rockysurf-m29b). Admin-only, and it reads and writes the FILE —
  // config is configuration and never becomes data.
  if (deps.configPath) {
    app.route('/', createSettingsRoutes({ configPath: deps.configPath, ...(deps.env ? { env: deps.env } : {}) }))
  }

  /* ------------------------------------------------------------------------ ssh keys */

  // The private-key download (rockysurf-55fx.2). Inherits the same session requirement and
  // applies its own ownership check. Not mounted without a secrets store, because there would
  // be nothing to decrypt.
  if (deps.secretsStore) app.route('/', createSshKeyRoutes({ db, secrets: deps.secretsStore }))

  /* -------------------------------------------------------------------- connect github */

  /**
   * The device flow behind the Connect GitHub button (rockysurf-7fyf.1).
   *
   * Guarded on the secrets store for the same reason the key download is: the token it mints
   * goes into the encrypted store, so without one there is nowhere to put it and the honest
   * answer is a 404 rather than a route that discovers that at request time.
   *
   * The config's github block is passed rather than the whole config — the routes need the
   * client id and one boolean, and reading `github.pat` itself here would put a credential in
   * their reach for no purpose. `fetch` is injected so the tests script GitHub's answers.
   */
  if (deps.secretsStore) {
    app.route(
      '/',
      createGithubRoutes({
        db,
        secrets: deps.secretsStore,
        config: {
          ...(config.github.oauth.clientId ? { clientId: config.github.oauth.clientId } : {}),
          configFallbackSet: Boolean(config.github.pat),
        },
        ...(deps.githubFetch ? { fetch: deps.githubFetch } : {}),
      }),
    )
  }

  /* ------------------------------------------------------------------------- the SPA */

  /**
   * The built web bundle, served from this same process and origin — which is why there is no
   * CORS anywhere in this file (ADR-0001).
   *
   * Two rules, and the second is the one that is easy to get wrong:
   *
   *  - assets are served from `publicDir` as files;
   *  - anything else that is not an API path falls back to `index.html`, because the SPA owns
   *    client-side routes like `/servers/srv-abc123`. A user who reloads that URL, or opens a
   *    link to it, must get the app rather than a 404 from a server that has no such route.
   *
   * The fallback deliberately EXCLUDES `/api` and `/internal`. Without that, a typo in an API
   * path would return `index.html` with a 200, and the client would try to parse HTML as JSON
   * and report something incoherent instead of the 404 that actually happened. `/health` is
   * excluded for the same reason: a health check must never be answered by the SPA shell.
   */
  if (deps.publicDir) {
    const publicDir = deps.publicDir
    const indexHtml = join(publicDir, 'index.html')

    app.use('/*', serveStatic({ root: relative(process.cwd(), publicDir) || '.' }))

    app.get('*', async (c, next) => {
      const path = c.req.path
      if (path.startsWith('/api') || path.startsWith('/internal') || path === '/health') return next()
      try {
        return c.html(await readFile(indexHtml, 'utf8'))
      } catch {
        // A publicDir that exists but holds no build is a misconfiguration worth naming.
        return next()
      }
    })
  } else {
    /**
     * No bundle wired in. Say so plainly rather than 404ing, so someone running core from a
     * checkout without having built the web package learns what is missing.
     */
    app.get('/', (c) =>
      c.html(
        `<!doctype html><meta charset="utf-8"><title>Rocky Surf</title>` +
          `<body style="font:16px system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem">` +
          `<h1>Rocky Surf</h1>` +
          `<p>The control plane is running, but no web bundle is configured. Build it with ` +
          `<code>pnpm --filter @rockysurf/web build</code>, or point <code>publicDir</code> at ` +
          `an existing build. The API is live at <code>/api/v1</code> and health at ` +
          `<code>/health</code>.</p>`,
      ),
    )
  }

  lifecycleRef = lifecycle

  return { app, events, jobs, sync: (row) => lifecycle.sync(row) }
}

/**
 * The local admin. Goes through the repository rather than a raw query so the db seam holds;
 * see auth/admin.ts for why the sentinel identity exists at all.
 */
function findLocalAdmin(db: Db): User | undefined {
  return getUserByGithubUsername(db, LOCAL_ADMIN_USERNAME)
}
