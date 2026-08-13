import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { boot, type BootedApp, type BootOptions } from './server.js'
import { DataDirLockError } from './boot/data-dir-lock.js'

/**
 * The `npx rockysurf` command line (rockysurf-gonw.9).
 *
 * This is where "self-hosted" is either credible or not. Somebody who has never seen this
 * project types one command and has to end up with a running control plane and a password
 * they can log in with — so the boot path's job is to do everything without asking, and this
 * file's job is to SAY what it did. Every message here is written to be read by a human at a
 * terminal on their first ever run.
 *
 * Refusal messages from `loadConfigOrExit` and the master-key permission checks are passed
 * through verbatim. They were written to be printed, they name the file and the fix, and
 * rewording them here would only make them worse.
 */

export const MIN_NODE_MAJOR = 24

export interface CliIo {
  out(message: string): void
  err(message: string): void
}

const defaultIo: CliIo = {
  out: (message) => process.stdout.write(`${message}\n`),
  err: (message) => process.stderr.write(`${message}\n`),
}

/**
 * Core's OWN version, read at runtime so it can never drift from the manifest.
 *
 * Not necessarily what `--version` prints: the composition root passes its own through
 * `RunCliOptions.version`, because the package a user installed is `rockysurf`, not this one.
 */
export function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
      version?: string
    }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * The Node version gate, as a pure function so it can be tested without spawning an old Node.
 *
 * Returns the message to print, or undefined when the version is fine. The point is that an
 * operator on Node 20 gets a sentence telling them what to do, not a `SyntaxError` from deep
 * inside a dependency — which is what an unguarded modern-syntax entry point produces, and
 * which reads like the project is broken rather than their runtime being old.
 */
export function nodeVersionError(version: string, minMajor = MIN_NODE_MAJOR): string | undefined {
  const major = Number.parseInt(version.replace(/^v/, '').split('.')[0] ?? '', 10)
  if (!Number.isFinite(major) || major >= minMajor) return undefined
  return [
    `rockysurf needs Node ${minMajor} or newer — this is Node ${version}.`,
    '',
    '  nvm install 24 && nvm use 24     # or your platform\'s installer',
    '',
    'Then run `npx rockysurf` again.',
  ].join('\n')
}

const USAGE = `rockysurf — self-hosted persistent cloud dev boxes for coding agents

Usage
  rockysurf [options]              start the control plane (default)

Options
  --config <path>    configuration file. Without it, the first of these that exists:
                       ./rockysurf.config.yaml      (this directory)
                       ~/.rockysurf/config.yaml     (the durable home)
                     and if neither does, the defaults.
  --port <port>      override the configured port
  --version, -v      print the version and exit
  --help, -h         print this message and exit

Environment
  ROCKYSURF_ADMIN_PASSWORD   set the admin password instead of generating one
  ROCKYSURF_SECRET_KEY       master key for the encrypted secret store
                             (default: <dataDir>/secret.key, created on first boot)

Docs: https://github.com/amroja-biz/rockysurf`

export interface ParsedArgs {
  command: 'serve' | 'help' | 'version'
  configPath?: string
  port?: number
  /** Set when parsing failed; the caller prints it and exits 2. */
  error?: string
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: 'serve' }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--help':
      case '-h':
        return { command: 'help' }
      case '--version':
      case '-v':
        return { command: 'version' }
      case '--config': {
        const value = argv[++i]
        if (!value) return { command: 'serve', error: '--config needs a path' }
        parsed.configPath = value
        break
      }
      case '--port': {
        const value = argv[++i]
        const port = Number(value)
        if (!value || !Number.isInteger(port) || port < 1 || port > 65535) {
          return { command: 'serve', error: `--port needs a number between 1 and 65535, got ${value ?? '(nothing)'}` }
        }
        parsed.port = port
        break
      }
      default:
        // `serve` is accepted so muscle memory from other tools works.
        if (arg === 'serve') break
        return { command: 'serve', error: `unknown option: ${arg}` }
    }
  }

  return parsed
}

/**
 * The host to put in the banner URL, which is not always the host that was bound
 * (rockysurf-pii7).
 *
 * A wildcard bind is not an address anyone can open, so those become loopback — which is
 * reachable and is where the operator running the command actually is. Anything else is
 * printed as configured: bound to one specific address, `127.0.0.1` would be a dead link.
 */
export function bannerHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '') return '127.0.0.1'
  return host.includes(':') ? `[${host}]` : host
}

/**
 * What the operator sees once the server is up.
 *
 * The URL comes last and on its own line because that is the thing they need to act on. The
 * password banner is NOT repeated here — `ensureLocalAdmin` prints it once, on the boot where
 * it was generated, and printing it again on every start would train people to ignore it.
 */
function readyBanner(booted: BootedApp, firstBoot: boolean): string {
  const url = `http://${bannerHost(booted.host)}:${booted.port}`
  const lines = [
    '',
    `  Rocky Surf is running at  ${url}`,
    '',
    `  data      ${booted.config.server.dataDir}`,
    `  auth      ${booted.config.auth.mode}`,
  ]
  if (firstBoot) {
    lines.push('', '  First boot: the data directory and encryption key were created just now.')
  }
  lines.push('', '  Press Ctrl-C to stop.', '')
  return lines.join('\n')
}

export interface RunCliOptions {
  io?: CliIo
  /** Injected in tests so a run can be stopped without a real signal. */
  signals?: NodeJS.Signals[]
  /**
   * Passed straight through to `boot()`. The composition root (`packages/rockysurf`) supplies
   * it; core on its own has no way to construct a provider (rockysurf-55fx.12).
   */
  providers?: BootOptions['providers']
  /**
   * What `--version` prints (rockysurf-aor6).
   *
   * THE COMPOSITION ROOT SUPPLIES ITS OWN. `readVersion()` below reads the manifest beside
   * core's `dist/`, which is `@rockysurf/core`'s version — not the version of the `rockysurf`
   * package somebody installed and typed the command from. The two are published separately,
   * so the moment they differ, core answering for the CLI is simply a wrong answer.
   *
   * Defaults to core's own version, so `runCli` on its own still reports something true.
   */
  version?: string
}

/**
 * Run the CLI. Resolves with the process exit code.
 *
 * For `serve` this does not resolve until the server is asked to stop, which is what keeps
 * the process alive without a `setInterval` keepalive.
 */
export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const io = options.io ?? defaultIo

  const versionProblem = nodeVersionError(process.version)
  if (versionProblem) {
    io.err(versionProblem)
    return 1
  }

  const args = parseArgs(argv)
  if (args.error) {
    io.err(args.error)
    io.err('')
    io.err(USAGE)
    return 2
  }
  if (args.command === 'help') {
    io.out(USAGE)
    return 0
  }
  if (args.command === 'version') {
    io.out(options.version ?? readVersion())
    return 0
  }

  // One-time notices (the generated password, the back-up-your-key warning) and routine boot
  // progress both go to stderr ahead of the ready banner, unmodified. They travel on separate
  // channels because only the first kind means "this is a first run".
  const toStderr = (message: string) => io.err(message)

  let booted: BootedApp
  try {
    booted = await boot({
      /**
       * BOTH, deliberately (rockysurf-nb6e). `configPath` is the parsed `--config`, and it is now
       * a real option that resolution honours rather than one spread into a type that had no such
       * field and dropped it on the floor. `argv` is passed as well so that everything downstream
       * reads THESE arguments: a `runCli(argv)` called in-process used to fall back to
       * `process.argv`, which for the binary is the same array — and for a test or an embedder is
       * somebody else's, resolving against the real cwd and the operator's real home.
       */
      argv,
      ...(args.configPath ? { configPath: args.configPath } : {}),
      ...(args.port ? { port: args.port } : {}),
      ...(options.providers ? { providers: options.providers } : {}),
      announce: toStderr,
      log: toStderr,
    })
  } catch (err) {
    // The single-core refusal (rockysurf-utjq), passed through verbatim like the config
    // refusals above it: the message names the holding pid, the directory and the lock file,
    // and a stack trace would only bury that. Anything else is a real bug and still throws.
    if (err instanceof DataDirLockError) {
      io.err(err.message)
      return 1
    }
    throw err
  }

  io.err(readyBanner(booted, booted.firstBoot))

  return await new Promise<number>((resolve) => {
    let stopping = false
    const stop = (signal: NodeJS.Signals) => {
      // A second Ctrl-C while a shutdown is in flight should not start a second one.
      if (stopping) return
      stopping = true
      io.err(`\nreceived ${signal}, shutting down…`)
      void shutdown(booted)
        .then(() => resolve(0))
        .catch((err: unknown) => {
          io.err(`shutdown failed: ${err instanceof Error ? err.message : String(err)}`)
          resolve(1)
        })
    }
    for (const signal of options.signals ?? (['SIGINT', 'SIGTERM'] as NodeJS.Signals[])) {
      process.once(signal, () => stop(signal))
    }
  })
}

/**
 * Stop cleanly: close the listener, then checkpoint and close the database.
 *
 * The checkpoint is the part worth spelling out. In WAL mode the recent writes live in
 * `rockysurf.db-wal` until a checkpoint folds them into the main file. better-sqlite3 does
 * that on a clean `close()`, but TRUNCATE first means the WAL is emptied and removed rather
 * than left beside the database — so someone who copies `rockysurf.db` as a backup after
 * stopping the server gets all of their data, instead of a file that is silently missing the
 * last few minutes.
 */
async function shutdown(booted: BootedApp): Promise<void> {
  try {
    booted.db.sqlite.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    // An in-memory database has no WAL, and a checkpoint failure must not block shutdown.
  }
  await booted.close()
}
