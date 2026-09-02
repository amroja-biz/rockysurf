import { serve, type ServerType } from '@hono/node-server'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, type AppEnv, type CreatedApp } from './app.js'
import { ADMIN_PASSWORD_ENV, ensureLocalAdmin } from './auth/admin.js'
import { ensureDataDir } from './boot/data-dir.js'
import { acquireDataDirLock } from './boot/data-dir-lock.js'
import { syncPacksAtBoot } from './boot/packs.js'
import { SettingsSecretStore, type SecretStore } from './auth/secret-store.js'
import {
  createConfigStore,
  loadConfigOrExitWithSource,
  type Config,
  type ConfigStore,
  type LoadConfigOptions,
} from './config/index.js'
import { defaultDatabasePath, openDatabase, type OpenedDatabase } from './db/client.js'
import { createSecretsStore, loadMasterKey, type SecretsStore } from './secrets/index.js'
import { createServerSecretsLoader } from './bootstrap/server-secrets.js'
import type { ProviderRegistry } from './providers/registry.js'
import { createEventsService, type EventsService } from './services/events.js'
import type { Jobs } from './jobs/index.js'
import type { Hono } from 'hono'
import { runStartupRecovery } from './jobs/recovery.js'

/**
 * The boot path: config, database, migrations, secrets, admin, serve.
 *
 * ORDER IS THE CONTENT of this file, and every step depends on the one before it:
 *
 *  1. **config** — nothing else knows where the data directory is. A bad config exits with a
 *     printed message rather than a stack trace (rockysurf-gonw.4).
 *  2. **database + migrations** — run unconditionally, because drizzle records what it has
 *     applied and a no-op is cheap. Making the operator remember a separate migrate command is
 *     how a self-hosted tool greets someone with a broken table on their second upgrade.
 *  3. **secrets** — load the master key (generating it on first boot) and open the encrypted
 *     store, so every later milestone has it and the key file exists from day one.
 *
 *     The admin password HASH deliberately does not go in there. That store encrypts things
 *     that must come back out as plaintext — SSH private keys, git tokens —
 *     and a scrypt hash is one-way by design, with no plaintext to protect and no
 *     `SecretKind` that fits. It lives in the `settings` table behind an allowlist that
 *     refuses anything reversible (`auth/secret-store.ts`).
 *  4. **admin** — ensure the account exists and has a password, printing a generated one once.
 *  5. **serve**.
 *
 * `boot()` returns everything it built so a test can drive the real path with a temporary
 * config and shut it down cleanly. `main()` is the thin wrapper the `npx` entry point calls
 * (rockysurf-gonw.9).
 */

export interface BootOptions extends LoadConfigOptions {
  /** Skip `serve()`. A test wants the wiring, not a listening socket. */
  listen?: boolean
  /** Override where the admin password hash is kept. Defaults to the settings table. */
  secrets?: (db: OpenedDatabase) => SecretStore
  /** Overrides `config.server.port`, for tests that need an ephemeral port. */
  port?: number
  /** Overrides `config.server.host`, for tests that assert what the listener actually bound. */
  host?: string
  /**
   * Where ONE-TIME notices go: the generated admin password, the back-up-your-key warning.
   * Defaults to stderr. Kept separate from `log` because the CLI treats these differently —
   * they are shown once, on the boot that produced them, and never repeated.
   */
  announce?: (message: string) => void
  /** Where routine boot progress goes (pack counts, warnings). Defaults to stderr. */
  log?: (message: string) => void
  /**
   * Build the provider registry (rockysurf-55fx.12).
   *
   * THE SEAM THAT MAKES CORE PORTABLE. Core cannot import a provider package — the dependency
   * lint forbids it, and that rule is what keeps the SDK honest and the AWS SDK out of an
   * `npx` cold start. So providers arrive already constructed, from a COMPOSITION ROOT that is
   * allowed to import both: `packages/rockysurf`.
   *
   * Called once the config exists. Credentials resolve from the config file first, then from
   * the provider's own environment variables — never from anything stored (issue #280).
   *
   * Omitted, core falls back to the fake provider, which is what makes `npx` usable with no
   * cloud account at all.
   */
  providers?: (context: ProviderCompositionContext) => ProviderRegistry
}

/** What a composition root gets to build the registry from. */
export interface ProviderCompositionContext {
  config: Config
  /** The environment credential variables are read from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Where a composition root reports what it wired, or why it could not. */
  log: (message: string) => void
}

export interface BootedApp {
  /** What this process started on. The values in `PINNED_PATHS` stay these forever (#264). */
  config: Config
  /**
   * The live configuration (issue #264). `current()` is what every route reads; `reload()` is
   * what the settings save calls. Exposed so a caller embedding core — and the boot tests — can
   * drive an adoption without going through HTTP.
   */
  configStore: ConfigStore
  db: OpenedDatabase
  app: Hono<AppEnv>
  events: EventsService
  /** The in-process job loop, already started unless `listen: false`. */
  jobs: Jobs
  /** Where the admin password hash lives. */
  secrets: SecretStore
  /** The encrypted store, for everything reversible. Handed to later milestones. */
  secretsStore: SecretsStore
  /**
   * True when this boot created the data directory — the authoritative first-boot signal.
   *
   * Derived from the directory rather than from "did anything get announced", because
   * routine boot logging also flows to the operator and must not make every start look
   * like a first run.
   */
  firstBoot: boolean
  /** Undefined when `listen: false`. */
  server?: ServerType
  port: number
  /** The interface the listener bound. Loopback unless the config widened it (rockysurf-pii7). */
  host: string
  /** Stops the listener and closes the database. Safe to call twice. */
  close(): Promise<void>
}

export async function boot(options: BootOptions = {}): Promise<BootedApp> {
  /**
   * ONE resolution, and it reports which file it read (rockysurf-8wgm) — so the settings editor
   * writes the file this process is actually running on: the one `--config` named, the one in
   * the working directory, or `~/.rockysurf/config.yaml`. With no config file anywhere,
   * `source.path` is the home file a first save creates rather than cwd litter.
   */
  const { config, source } = loadConfigOrExitWithSource(options)
  const configPath = source.path

  /**
   * THE LIVE CONFIGURATION (issue #264): the same file, re-read whenever the settings page
   * saves it, with `PINNED_PATHS` held at the values this process actually started on.
   *
   * Built here rather than inside `createApp` because this is the only place that knows which
   * file was loaded and what it parsed to — the two halves the store needs — and because a core
   * embedded by a test is entitled to run on exactly the config it was handed. Everything after
   * this point that wants a value takes it from the store.
   */
  const configStore = createConfigStore({
    booted: config,
    ...(configPath ? { configPath } : {}),
    ...(options.env ? { env: options.env } : {}),
  })

  // Before anything writes into it: both openDatabase and loadMasterKey create the data
  // directory as a side effect, with the default mode, and it ends up holding secret.key.
  const log = options.log ?? ((message: string) => console.error(message))
  const dataDir = ensureDataDir(config.server.dataDir)
  if (dataDir.warning) log(dataDir.warning)

  /**
   * THE SINGLE-CORE GUARANTEE (rockysurf-utjq): one live core per data directory, enforced
   * before the database is opened — migrations, the recovery pass and the job loops are all
   * writes a second core must never make, and WAL-mode SQLite happily lets two processes
   * write. Throws `DataDirLockError` with a printed-verbatim message naming the holding pid;
   * a stale lock (crashed or SIGKILLed core) is reclaimed silently. Everything after this
   * point releases the lock on failure, so a boot that dies half-way does not brick the
   * directory for the retry in the same still-alive process.
   */
  const lock = acquireDataDirLock({ dataDir: config.server.dataDir, log })

  try {
    return await bootHoldingLock()
  } catch (err) {
    // A boot that failed half-way holds no database and runs no jobs; holding the lock past
    // this throw would only block the retry from the same still-alive process.
    lock.release()
    throw err
  }

  // A hoisted inner function rather than a 100-line try block, so the boot sequence below
  // keeps its indentation and its diff history. `close()` is the release path for the boots
  // that succeed.
  async function bootHoldingLock(): Promise<BootedApp> {
  const db = openDatabase({ url: defaultDatabasePath(config.server.dataDir) })

  const masterKey = loadMasterKey({ dataDir: config.server.dataDir })
  const secretsStore = createSecretsStore(db.db, masterKey.key)

  const secrets = options.secrets?.(db) ?? new SettingsSecretStore(db.db)

  await ensureLocalAdmin({
    db: db.db,
    secrets,
    password: process.env[ADMIN_PASSWORD_ENV],
    ...(options.announce ? { announce: options.announce } : {}),
  })

  // Files are the source of truth for shipped packs; the database is a cache and edit layer
  // (ADR-0004). A broken pack file is logged and skipped, never fatal — see syncPacksAtBoot.
  syncPacksAtBoot({ db: db.db, dataDir: config.server.dataDir, log })

  const events = createEventsService()
  // `secretsStore` is NOT optional here, whatever its type says. Without it the lifecycle
  // falls back to an ephemeral keypair that is never persisted — the box authorizes a key
  // nobody kept, the operator can never SSH in, and nothing fails at the time — and the
  // private-key download route is not mounted at all. Both failures are silent, which is why
  // `boot-keys.test.ts` asserts this wiring through the real boot path rather than trusting it.
  // The built SPA, when there is one. `public/` sits beside `dist/` inside the package and is
  // populated by the web build; a checkout that has never run it simply has no directory, and
  // core says so at `/` rather than 404ing. Resolved here rather than in `createApp` so the
  // app factory stays a pure function of its dependencies and tests can point it anywhere.
  const publicDir = resolvePublicDir()

  const registry = options.providers?.({ config, log })

  /**
   * REBUILT WHEN THE PROVIDER CONFIGURATION CHANGES (issue #264).
   *
   * The one thing on the settings page that most obviously did nothing until a restart: turning
   * a cloud on, fixing a region, or correcting `sshAllowedCidr` all changed the file while the
   * process went on holding whatever clients boot had built. Composition is a pure function of
   * the config and the secrets store (`packages/rockysurf/src/compose.ts` — never throws, reports
   * a bad section instead), so re-running it is safe to do while the app serves; the registry
   * object the whole app holds takes the new contents in place.
   *
   * Scoped to the `providers` block, so saving the port does not rebuild five cloud clients, and
   * `pricing`, which composition also reads, travels with them — a rebuild is a rebuild.
   */
  if (registry && options.providers) {
    const compose = options.providers
    configStore.onChange((next, previous) => {
      if (JSON.stringify([next.providers, next.pricing]) === JSON.stringify([previous.providers, previous.pricing])) {
        return
      }
      registry.replaceWith(compose({ config: next, log }))
    })
  }

  const created: CreatedApp = createApp({
    db: db.db,
    config,
    configStore,
    secrets,
    secretsStore,
    // Backup/Restore's re-seal and readability probe (issue #331) — ciphertext work the
    // store has no verb for; see the AppDeps comment.
    masterKey: masterKey.key,
    events,
    // The hook that hands a pack's install steps their credentials (rockysurf-55fx.14). It was
    // an AppDeps option nothing in production supplied, so `secrets.env` was written empty and
    // the callback secrets endpoint served nothing — a private-repo clone or a requiresRdp pack
    // failed for a reason the logs never explained.
    //
    // `github.pat` is read HERE, and this is the only place it is read (rockysurf-yzae). It was
    // declared in the schema, advertised in the example config as `${GITHUB_PAT}` and consumed
    // by nothing, so the store the loader reads had no writer and every private-repo clone
    // failed — the box end of the credential path was finished and connected to nothing. It is
    // passed rather than persisted so that editing the config and restarting really does
    // rotate the token; see `ServerSecretsOptions`.
    //
    // `github.tokens` joins it on exactly the same terms (rockysurf-ta7g): read once, passed,
    // never stored. Both are configuration, and neither becomes data.
    // A function since #264, so that editing the token and saving rotates it for the very next
    // box rather than for the next start. Still passed, still never persisted.
    loadServerSecrets: createServerSecretsLoader(secretsStore, () => {
      const live = configStore.current()
      return {
        ...(live.github.pat ? { githubPat: live.github.pat } : {}),
        ...(live.github.tokens.length > 0 ? { githubTokens: live.github.tokens } : {}),
      }
    }),
    ...(registry ? { providers: registry } : {}),
    ...(publicDir ? { publicDir } : {}),
    configPath,
  })
  const port = options.port ?? config.server.port
  const host = options.host ?? config.server.host

  /**
   * STARTUP RECOVERY, before any timer starts (rockysurf-55fx.7, ADR-0001).
   *
   * Every server that was mid-flight when core last stopped is re-attached or failed cleanly.
   * It runs even when `listen: false` — a test or a CLI command that opens the database is
   * still core waking up, and leaving a row stuck is the failure this pass exists to prevent.
   */
  const recovery = await runStartupRecovery({ db: db.db, sync: created.sync, log })
  if (recovery.examined > 0) {
    log(
      `recovery: ${recovery.reattached.length} re-attached, ${recovery.settled.length} already settled, ` +
        `${recovery.failed.length} failed cleanly`,
    )
  }

  let server: ServerType | undefined
  if (options.listen !== false) {
    // `hostname` is the whole point of rockysurf-pii7: without it node-server binds every
    // interface, which for a box holding cloud credentials is a decision nobody made.
    server = serve({ fetch: created.app.fetch, port, hostname: host })
    // One pass of every job immediately, THEN the timers. The reconciler running once at
    // startup is an ADR-0001 requirement rather than an optimisation: it is what turns "core
    // was off for a week" into a list of disagreements an operator can act on, instead of a
    // surprise on the next bill.
    await created.jobs.runAllNow()
    // Started with the listener, not with the app: a test that builds an app must not
    // inherit live intervals.
    created.jobs.start()
  }

  let closed = false
  return {
    config,
    configStore,
    db,
    app: created.app,
    events: created.events,
    jobs: created.jobs,
    secrets,
    secretsStore,
    firstBoot: dataDir.created,
    ...(server ? { server } : {}),
    port,
    host,
    async close() {
      if (closed) return
      closed = true
      // Order matters on the way down: stop accepting requests, then let the jobs finish the
      // tick they are in (each awaits its own in-flight work), and only then close the
      // database out from under them. The lock goes last: it must not read as free while
      // anything here can still write.
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
      await created.jobs.stop()
      db.close()
      lock.release()
    },
  }
  }
}

/**
 * Locate the built SPA, or return undefined when there is none.
 *
 * `public/` resolves the same from `src/` and from `dist/` because both sit one level below
 * the package root — the same arrangement `bootstrap/agent.sh` uses. `ROCKYSURF_PUBLIC_DIR`
 * overrides it, which is what a developer serving a bundle from somewhere else needs.
 */
function resolvePublicDir(): string | undefined {
  const override = process.env['ROCKYSURF_PUBLIC_DIR']
  if (override) return existsSync(override) ? override : undefined
  const bundled = fileURLToPath(new URL('../public', import.meta.url))
  return existsSync(join(bundled, 'index.html')) ? bundled : undefined
}

/** Entry point. Kept separate from `boot()` so importing this module starts nothing. */
export async function main(): Promise<void> {
  const booted = await boot()
  console.error(
    `rockysurf listening on http://127.0.0.1:${booted.port}` +
      ` (auth: ${booted.config.auth.mode}, data: ${booted.config.server.dataDir})`,
  )
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void booted.close().then(() => process.exit(0))
    })
  }
}
