import { serveStatic } from '@hono/node-server/serve-static'
import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { Hono, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import type { Config } from './config/index.js'
import type { Db } from './db/client.js'
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
import { createPushBootstrapSupervisor } from './bootstrap/supervisor.js'
import { createCostsRoutes } from './costs/routes.js'
import { createPackRoutes } from './packs/routes.js'
import type { SecretsStore } from './secrets/store.js'
import { createDefaultRegistry, type ProviderRegistry } from './providers/registry.js'
import { createJobs, type Jobs } from './jobs/index.js'
import { createLifecycleService, type LifecycleService } from './servers/lifecycle.js'
import { createServerRoutes } from './servers/routes.js'
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
  /** Shared with the boot path and the job loop, so both can push to open streams. */
  events?: EventsService
  sessionTtlMs?: number
  /** SSE keep-alive interval. Tests shorten it; the default matches proxy idle timeouts. */
  heartbeatMs?: number
  /** Built SPA assets. Absent until 4d. */
  publicDir?: string
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
      snapshotInstallPlan: (row, mode) =>
        void snapshotInstallPlan(db, row, {
          mode,
          ...(config.server.publicUrl ? { publicUrl: config.server.publicUrl } : {}),
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
  app.route('/', createPackRoutes({ db }))

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
  app.route('/', createInternalRoutes({ db, events, loadServerSecrets: deps.loadServerSecrets }))
  app.route('/', createServerRoutes({ lifecycle, registry }))
  // First-run wizard state and credential capture (rockysurf-hzi7.2).
  app.route('/', createSetupRoutes({ config, registry, ...(deps.secretsStore ? { secrets: deps.secretsStore } : {}) }))

  /* ------------------------------------------------------------------------ ssh keys */

  // The private-key download (rockysurf-55fx.2). Inherits the same session requirement and
  // applies its own ownership check. Not mounted without a secrets store, because there would
  // be nothing to decrypt.
  if (deps.secretsStore) app.route('/', createSshKeyRoutes({ db, secrets: deps.secretsStore }))

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
