import { readFileSync } from 'node:fs'
import { checkConfigText } from './load.js'
import type { Config } from './schema.js'

/**
 * THE CONFIG FILE, RE-READ WHILE ROCKY SURF IS RUNNING (issue #264).
 *
 * Until this file existed, `rockysurf.config.yaml` was read exactly once, by `boot()`, and
 * every value in it was frozen into whatever was built from it — a provider client, a limits
 * enforcer, a token table. Saving on the Settings page therefore changed a FILE and nothing
 * else, and the page said so with a banner that stayed up until somebody stopped the process.
 * That is a defensible design for a file read at startup and a poor experience for the person
 * who just turned a cloud on and watched nothing happen.
 *
 * SO THE FILE IS NOW RE-READ ON SAVE, and the process adopts it. What that means precisely:
 *
 *  - **One store, one in-force `Config`.** Everything that used to close over `boot()`'s config
 *    now reads through `current()` — at the moment it needs the value, not at the moment it was
 *    constructed. `Live<T>` below is that same idea for the handful of seams that take a slice
 *    of the config rather than the whole of it.
 *  - **Adoption is all-or-nothing.** A file that does not parse, does not validate, or names a
 *    `${VAR}` this process cannot see is NOT adopted: the previous values stay in force and
 *    `reload()` says why. There is no half-old, half-new config, because the swap is one
 *    assignment of one immutable object.
 *  - **It is the same validator the save already ran.** `checkConfigText` is what
 *    `settings/routes.ts` checks a candidate file with and what `config/load.ts` boots on, so
 *    "valid enough to write" and "valid enough to adopt" cannot drift apart.
 *  - **Three values are PINNED to what this process booted with.** See `PINNED_PATHS`.
 *
 * WHAT THIS DOES NOT DO is re-derive anything by itself. Swapping the config makes every LIVE
 * read see the new value; the things that were BUILT from a value — the provider clients, the
 * pack registry client — are rebuilt by their owners, which subscribe through `onChange`.
 * `settings/fields.ts` is where the resulting promise is written down per field, and
 * `fields.test.ts` holds the two halves together.
 *
 * `config/live-preferences.ts` predates this and stays: `preferences.tiers` is read from the
 * file at create time on its own mtime cache, which keeps working whether or not a store
 * exists (an embedded core, a test) and needs no save to have happened.
 */

/**
 * A value a dependency may be given once, or asked for each time it is used.
 *
 * THE SEAM THAT MADE #264 A SMALL CHANGE RATHER THAN A REWRITE. Half of core takes a slice of
 * the config — `LimitsConfig`, the two GitHub token fields, `{ server: { publicUrl } }` — and
 * every one of those parameters was a value captured at construction. Widening them to `Live<T>`
 * leaves every existing caller (and every test) compiling exactly as it did, while letting
 * `createApp` hand over a function that reads the config in force at the moment of the call.
 *
 * Deliberately NOT a proxy over `Config`. A proxy would have made every one of these seams live
 * with no edit at all, and it would also have made `config.limits.maxServers` a number that
 * changes under the reader with nothing at the call site saying so. `Live<T>` is visible in the
 * type, so a dependency declares whether it re-reads.
 */
export type Live<T> = T | (() => T)

/** Resolve a `Live<T>`. A `T` that is itself a function is not a case core has. */
export function readLive<T>(value: Live<T>): T {
  return typeof value === 'function' ? (value as () => T)() : value
}

/**
 * The settings this process cannot adopt while it is running, kept at their booted values.
 *
 * NOT a policy about what is SAFE to change — it is a statement of fact about this process. The
 * listener is bound to a port on an interface, and the database, the master key and the
 * encrypted store are open from one directory; `auth.mode` decides whether the password login
 * every open session was issued by still exists. A `Config` that named the file's newer values
 * for any of the four would be a config that lies about the process holding it, and everything
 * downstream — `/health`, the boot banner, a future reader — would repeat the lie.
 *
 * So the file may say what it likes, and this process keeps running on what it started with
 * until it is restarted. That is the promise `settings/fields.ts` marks these fields with, and
 * `fields.test.ts` fails if any path here is not marked `appliesAt: 'restart'` there.
 */
export const PINNED_PATHS = ['server.port', 'server.host', 'server.dataDir', 'auth.mode'] as const

/** What a reload did, in terms the settings route can put in front of an operator. */
export interface ReloadOutcome {
  /** True when this process is now running on the file's values. */
  applied: boolean
  /**
   * Why it is not, in the operator's own terms — absent when it is.
   *
   * A save that just passed `checkConfigText` normally reaches here and applies. The case that
   * does not is the one `rockysurf-1z5q` built the warning path for: the file now names a
   * `${VAR}` this process's environment does not set, so its values are not KNOWABLE and there
   * is nothing to adopt. The save still stands; the reference is recorded; this says so.
   */
  blocked?: string
}

export interface ConfigStore {
  /** The configuration in force right now. Never a torn or half-adopted one. */
  current(): ConfigView
  /** What `boot()` started on, for anything that has to compare against it. */
  booted(): ConfigView
  /** Re-read the file and adopt it if it can be. Never throws. */
  reload(): ReloadOutcome
  /** Called after an adoption, with the config now in force and the one it replaced. */
  onChange(listener: (next: ConfigView, previous: ConfigView) => void): () => void
}

/** The store hands back the same `Config` shape core has always used. */
export type ConfigView = Config

export interface ConfigStoreDeps {
  /** What `boot()` loaded, and the value in force until a reload replaces it. */
  booted: Config
  /**
   * The file `boot()` read. Absent — an embedded core, a test — makes the store a constant:
   * `reload()` reports that there is no file to re-read and nothing ever changes.
   */
  configPath?: string
  /** The environment `${VAR}` references are resolved against. */
  env?: NodeJS.ProcessEnv
  /** Injected by tests. Defaults to reading `configPath`. */
  readText?: (path: string) => string
}

const NO_FILE =
  'Rocky Surf is running on built-in defaults with no configuration file, so there is nothing to ' +
  're-read.'

/**
 * Keep the four facts about this process, whatever the file now says. See `PINNED_PATHS`.
 *
 * Written out by hand rather than driven from `PINNED_PATHS` by a generic path-setter: four
 * fields, two blocks, and a loop over dotted strings would be harder to read than the thing it
 * replaced. The test asserts the two agree.
 */
function pinRunningFacts(next: Config, booted: Config): Config {
  return {
    ...next,
    server: {
      ...next.server,
      port: booted.server.port,
      host: booted.server.host,
      dataDir: booted.server.dataDir,
    },
    auth: { ...next.auth, mode: booted.auth.mode },
  }
}

export function createConfigStore(deps: ConfigStoreDeps): ConfigStore {
  const env = deps.env ?? process.env
  const readText = deps.readText ?? ((path: string) => readFileSync(path, 'utf8'))
  const booted = deps.booted
  let inForce: Config = booted
  const listeners = new Set<(next: Config, previous: Config) => void>()

  function reload(): ReloadOutcome {
    const { configPath } = deps
    if (!configPath) return { applied: false, blocked: NO_FILE }

    let text: string
    try {
      text = readText(configPath)
    } catch (err) {
      // ENOENT is the ordinary case for a first save that has not landed yet, and any other
      // read error is a filesystem problem the operator can act on. Neither is a reason to
      // stop serving on the values already in force.
      const detail = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'it does not exist' : String(err)
      return { applied: false, blocked: `${configPath} could not be read (${detail}), so nothing changed.` }
    }

    const checked = checkConfigText(text, env)
    if (!checked.ok) {
      return {
        applied: false,
        blocked:
          `${configPath} does not validate, so Rocky Surf is still running on the settings it ` +
          `had: ${checked.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
      }
    }
    if (!checked.config) {
      /**
       * A file that is ahead of its environment (rockysurf-1z5q). `checkConfigText` withholds
       * the parsed config exactly here, because with a variable unset the values are not
       * knowable — the tree still holds `${ACME_PAT}` where a token belongs. Adopting that
       * would put the literal text of a reference where a credential goes.
       */
      const named = [...new Set(checked.warnings.map((warning) => warning.variable))]
      return {
        applied: false,
        blocked:
          `Saved. ${named.join(', ')} ${named.length === 1 ? 'is' : 'are'} not set in the ` +
          'environment Rocky Surf was started from, so the file cannot be applied yet — export ' +
          `${named.length === 1 ? 'it' : 'them'} and restart.`,
      }
    }

    const previous = inForce
    inForce = pinRunningFacts(checked.config, booted)
    for (const listener of listeners) listener(inForce, previous)
    return { applied: true }
  }

  return {
    current: () => inForce,
    booted: () => booted,
    reload,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
