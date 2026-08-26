import { readFileSync, statSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import type { ServerSize } from '../db/schema.js'
import { preferencesSchema, type PreferencesConfig } from './schema.js'

/**
 * THE ONE BLOCK OF THE CONFIG FILE THAT IS RE-READ WHILE ROCKY SURF IS RUNNING (issue #124).
 *
 * Everything else in `rockysurf.config.yaml` is boot wiring — a port that is already bound, a
 * data directory whose database is already open, a credential a provider client was already
 * built from — and "changes apply after a restart" is the honest answer for all of it.
 *
 * `preferences.tiers` is not that. It is a note the user leaves themselves about which machine
 * type they want next time, and the whole feature is "the same types come up every time": a
 * preference that needs the control plane restarted before it applies is a preference that did
 * not get remembered. So this reads the file, at create time, on the create path only.
 *
 * WHY THAT IS SAFE HERE AND WOULD NOT BE ELSEWHERE:
 *
 *  - **Nothing is built from it.** A tier preference is one string compared against a catalogue
 *    that has just been fetched. No client, no connection and no key is derived from it, so
 *    there is no half-old, half-new state for it to produce.
 *  - **The file is written atomically.** `settings/routes.ts` writes a temp file and renames, so
 *    a read either sees the whole previous file or the whole next one, never a torn one.
 *  - **A bad file changes nothing.** Unparseable YAML, a `preferences` block the schema refuses,
 *    a file that has been deleted — every one of them falls back to the preferences this process
 *    booted with, which is what the rest of core is already using. Reading this block never
 *    turns a broken file into a failed create; the boot path is still where a broken file is
 *    reported.
 *  - **It is cached by mtime**, so the ordinary case is a `stat` rather than a parse, and a
 *    create is not made slower by a feature nobody has configured.
 *
 * The file stays the single source of truth. This is a re-read of it, not a second copy of it —
 * the distinction that matters, and the reason the database gains nothing here (config is
 * configuration and never becomes data).
 */

export interface PreferenceReaderDeps {
  /** The file `boot()` loaded. Absent — tests, an embedded core — means "use the booted value". */
  configPath?: string
  /** What this process booted with, and the answer whenever the file cannot be read. */
  booted: PreferencesConfig
}

/** `(providerId, size) => the remembered machine type`, or undefined when there is none. */
export type PreferenceReader = (providerId: string, size: ServerSize) => string | undefined

interface Cached {
  mtimeMs: number | null
  preferences: PreferencesConfig
}

/**
 * Parse just the `preferences` block, tolerating everything else being wrong.
 *
 * Deliberately NOT `configSchema`: a file whose `providers.aws.sshAllowedCidr` is missing is a
 * file an operator is in the middle of fixing, and it must not also cost them the preference
 * they saved an hour ago. `preferences` is validated on its own terms and judged on its own.
 *
 * `${VAR}` is not interpolated, because a machine type is a machine type — there is no reason
 * to point one at an environment variable, and a literal `${…}` simply fails to match any
 * offering and falls back with a reason, which is the behaviour a typo gets anyway.
 */
function parsePreferences(text: string): PreferencesConfig | undefined {
  let tree: unknown
  try {
    tree = parseYaml(text)
  } catch {
    return undefined
  }
  if (tree === null || typeof tree !== 'object') return undefined
  const result = preferencesSchema.safeParse((tree as { preferences?: unknown }).preferences)
  return result.success ? result.data : undefined
}

export function createPreferenceReader(deps: PreferenceReaderDeps): PreferenceReader {
  const { configPath } = deps
  let cached: Cached | undefined

  function current(): PreferencesConfig {
    if (!configPath) return deps.booted
    let mtimeMs: number | null
    try {
      mtimeMs = statSync(configPath).mtimeMs
    } catch {
      // No file at all — a fresh install running on defaults, or one whose file has been moved.
      return deps.booted
    }
    if (cached && cached.mtimeMs === mtimeMs) return cached.preferences
    let preferences: PreferencesConfig | undefined
    try {
      preferences = parsePreferences(readFileSync(configPath, 'utf8'))
    } catch {
      preferences = undefined
    }
    const resolved = preferences ?? deps.booted
    cached = { mtimeMs, preferences: resolved }
    return resolved
  }

  return (providerId, size) => {
    const tiers = (current().tiers as Record<string, Record<string, string | undefined> | undefined>)[providerId]
    return tiers?.[size]
  }
}
