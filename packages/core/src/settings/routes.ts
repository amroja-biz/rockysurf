import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app.js'
import { checkConfigText, configSchema, type ConfigIssue, type ConfigWarning } from '../config/index.js'
import { badRequest, conflict, forbidden, success } from '../http/responses.js'
import { validate } from '../http/validate.js'
import { applyChanges, parseTree, type Change } from './document.js'
import { SETTINGS_FIELDS, SETTINGS_LISTS, SETTINGS_SECTIONS, specFor, patternOf, type FieldSpec } from './fields.js'
import { fingerprint, redactTree } from './view.js'

/**
 * `/api/v1/settings` — the config file, read redacted and written in place (rockysurf-m29b).
 *
 * FIVE RULES, and each one is a way this feature could have gone wrong:
 *
 *  1. **The read is redacted.** Secret-classified fields arrive as `set`/`not set`; a `${VAR}`
 *     reference arrives verbatim, because a variable name is not a credential. See `view.ts`.
 *     Nothing in this file touches the secrets store, which is why the custody test in
 *     `secrets/route-inventory.test.ts` needs no new exemption — there is no plaintext accessor
 *     to exempt.
 *  2. **Writes are write-only for secrets.** Not by a special code path but by the shape of the
 *     request: a save sends the fields it CHANGED. A secret the operator did not retype is not
 *     in the payload, so it is not written, so it keeps its value — and its `${VAR}` form.
 *     Clearing one is an explicit `unset`.
 *  3. **The write goes to the config file**, through the comment-preserving Document API, and
 *     touches only the paths named. Config is configuration and never becomes data (yzae): the
 *     database is not consulted here and gains no copy of any of this.
 *  4. **Restart honesty.** Everything in this file is read at boot. A save says so, and the
 *     `drifted` flag keeps saying so on every subsequent read until the process is restarted —
 *     a notice that survives a page reload rather than a toast that does not. `warnings` is the
 *     same idea sharpened: a saved reference to a variable this process cannot see is a restart
 *     that will FAIL rather than merely one that is pending, and it says so until it is fixed.
 *  5. **Conflicts are refused, never merged.** A read hands the caller the file's mtime; a save
 *     hands it back, and a mismatch is a 409 with nothing written. Someone hand-editing the
 *     file while the page is open is the ordinary case, not the exotic one.
 *
 * Admin-only, both routes.
 */

export interface SettingsRoutesDeps {
  /** The file `boot()` actually loaded. Absolute — every message quotes it. */
  configPath: string
  /** Environment used to check `${VAR}` references on save. */
  env?: NodeJS.ProcessEnv
}

/**
 * One edit. `value` and `unset` are alternatives; `path` is checked against the field inventory
 * before anything is written, so a save cannot reach a field the editor does not offer.
 */
const changeSchema = z
  .strictObject({
    path: z.array(z.union([z.string().min(1), z.number().int().nonnegative()])).min(1),
    value: z.unknown().optional(),
    unset: z.literal(true).optional(),
  })
  .refine((c) => c.unset === true || 'value' in c, {
    error: 'a change needs either a value or unset: true',
    path: ['value'],
  })

const saveBody = z.strictObject({
  /**
   * The file's modification time as the caller last read it, or null for "there was no file".
   * The concurrency token, and the reason a hand-edit cannot be silently clobbered.
   */
  mtimeMs: z.number().nullable(),
  changes: z.array(changeSchema).min(1, { error: 'nothing to save' }),
})

/** What the editor is told about the file, with every secret already reduced to its state. */
interface SettingsView {
  file: { path: string; exists: boolean; mtimeMs: number | null }
  /** The file's own values, uninterpolated, secrets masked. */
  values: unknown
  /** What the loader uses for anything absent above — the schema's own defaults. */
  defaults: unknown
  /** The inventory, so the page renders read-only reasons, help and warnings from one source. */
  fields: readonly FieldSpec[]
  /** Section titles and their help text, for the same reason (rockysurf-5qzg). */
  sections: typeof SETTINGS_SECTIONS
  lists: typeof SETTINGS_LISTS
  /** Present when the file on disk does not validate. The editor exists to fix this state. */
  issues?: readonly ConfigIssue[]
  /**
   * Present when the file is valid but names variables THIS process's environment does not set
   * (rockysurf-1z5q) — so a save records the reference and the page still says, at the field
   * and at the top of the form, what has to happen before a restart.
   *
   * On the view rather than only on the save response, and that is the point: it is a fact
   * about the file and the environment, not about the save event, so it survives a reload and
   * keeps saying so until the variable is exported and the process restarted — exactly the way
   * `drifted` does, and for the same reason.
   */
  warnings?: readonly ConfigWarning[]
  /** True when the file's values differ from the ones this process booted with. */
  drifted: boolean
  restartHint: string
  /** The same sentence, split so a client can set its commands in monospace (#232). */
  restartHintSegments: readonly HintSegment[]
}

/**
 * A run of the restart hint. `code` marks a literal the operator types or copies — a key press
 * or a command — which the product's type rule says is monospace wherever it appears.
 */
export interface HintSegment {
  text: string
  code?: boolean
}

/**
 * The restart instruction, in segments rather than one string (#232).
 *
 * Core keeps the words AND says which of them are commands, because the alternative is a client
 * scanning the prose for `./start.sh` to decide what to mark up — which makes core's copy an
 * accidental API, and breaks the moment the sentence is reworded. `RESTART_HINT` is still the
 * whole sentence, joined here so the two cannot drift apart.
 */
export const RESTART_HINT_SEGMENTS: readonly HintSegment[] = [
  { text: 'Rocky Surf reads this file once, at startup. Changes apply after a restart: stop the process with ' },
  { text: 'Ctrl-C', code: true },
  { text: ' and run ' },
  { text: './start.sh', code: true },
  { text: ' again.' },
]

export const RESTART_HINT = RESTART_HINT_SEGMENTS.map((segment) => segment.text).join('')

interface ReadFile {
  text: string
  exists: boolean
  mtimeMs: number | null
  /** The file's own permission bits, carried so a save cannot widen them. */
  mode: number | null
}

/** Read the file, tolerating absence — a fresh install has no config file at all (cf51). */
function readFile(path: string): ReadFile {
  try {
    const stat = statSync(path)
    return { text: readFileSync(path, 'utf8'), exists: true, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777 }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { text: '', exists: false, mtimeMs: null, mode: null }
    }
    throw err
  }
}

export function createSettingsRoutes(deps: SettingsRoutesDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  const env = deps.env ?? process.env

  /**
   * The file as this process loaded it. Taken here because building the app IS boot, and taken
   * over the parsed tree rather than the bytes so a comment edit is not reported as drift.
   */
  const bootFingerprint = fingerprint(parseTree(readFile(deps.configPath).text))

  /** The schema's own defaults, redacted like everything else so there is one masked path. */
  const defaults = redactTree(configSchema.parse({}))

  function view(): SettingsView {
    const file = readFile(deps.configPath)
    const tree = parseTree(file.text)
    const checked = checkConfigText(file.text, env)
    return {
      file: { path: deps.configPath, exists: file.exists, mtimeMs: file.mtimeMs },
      values: redactTree(tree),
      defaults,
      fields: SETTINGS_FIELDS,
      sections: SETTINGS_SECTIONS,
      lists: SETTINGS_LISTS,
      ...(checked.ok ? {} : { issues: checked.issues }),
      ...(checked.warnings.length > 0 ? { warnings: checked.warnings } : {}),
      drifted: fingerprint(tree) !== bootFingerprint,
      restartHint: RESTART_HINT,
      restartHintSegments: RESTART_HINT_SEGMENTS,
    }
  }

  /**
   * Admin, ahead of everything — including body validation.
   *
   * As middleware rather than a line in each handler, so the order is the point: a non-admin
   * gets 403 without first being told, by a 400 naming `changes[0].path`, what the request body
   * of a route they may not use looks like.
   */
  routes.use('/api/v1/settings', async (c, next) => {
    if (!c.get('user').isAdmin) return forbidden(c, 'Admin access required')
    await next()
  })

  routes.get('/api/v1/settings', (c) => success(c, view()))

  routes.put('/api/v1/settings', validate('json', saveBody), (c) => {
    const { mtimeMs, changes } = c.req.valid('json')

    /**
     * WHAT A SAVE MAY TOUCH. Every path goes through the inventory, so a request cannot write
     * `server.dataDir` merely by naming it — the read-only reasons in `fields.ts` are enforced
     * here rather than merely rendered by the page. A path the editor does not know is refused
     * too: this route is not a general-purpose YAML writer, and treating it as one would make
     * the field inventory decorative.
     */
    const rejected = changes.flatMap((change) => {
      const path = change.path as (string | number)[]
      const spec = specFor(path)
      if (spec) {
        return spec.writable
          ? []
          : [{ path: patternOf(path), message: spec.reason ?? 'this field is not editable here' }]
      }
      // A whole list entry — `{ path: ['github','tokens',2] }` — is how an entry is added or
      // removed, and it is legal exactly for the lists the inventory declares.
      const isListEntry =
        typeof path[path.length - 1] === 'number' &&
        SETTINGS_LISTS.some((list) => list.path === patternOf(path.slice(0, -1)))
      if (isListEntry) return []
      return [{ path: patternOf(path), message: 'this settings page does not edit that field' }]
    })
    if (rejected.length > 0) {
      return badRequest(c, rejected.map((r) => `${r.path}: ${r.message}`).join('; '), rejected)
    }

    const before = readFile(deps.configPath)
    if (before.mtimeMs !== mtimeMs) {
      return conflict(
        c,
        `${deps.configPath} changed on disk after this page read it — someone edited the file, or ` +
          'another tab saved. Nothing was written. Reload this page to see the current file, then ' +
          'make your change again.',
      )
    }

    let text: string
    try {
      text = applyChanges(before.text, changes as Change[])
    } catch (err) {
      // A malformed document the Document API refuses to descend into. The file is unchanged.
      return badRequest(c, `could not apply the change to ${deps.configPath}: ${(err as Error).message}`)
    }

    /**
     * VALIDATED BY THE SCHEMA ITSELF, before anything is written. Not a second set of rules
     * that agrees with `configSchema` today and drifts from it next month: the candidate text
     * goes through the very function the boot path uses, and its field paths come back as
     * issues the editor puts next to the controls that caused them.
     *
     * A REFERENCE TO AN UNSET VARIABLE IS NOT AN ISSUE HERE (rockysurf-1z5q). It comes back as
     * a warning, the save goes through, and the response says which variable is missing. The
     * file is allowed to be ahead of the environment — the token boxes above ask for variable
     * NAMES, and an operator cannot export a variable into a process that is already running,
     * so refusing the save meant the page could not record the one thing it had asked for.
     * `checkConfigText` carries the reasoning; boot's hard error is untouched.
     */
    const checked = checkConfigText(text, env)
    if (!checked.ok) {
      return badRequest(
        c,
        checked.issues.map((i) => `${i.path}: ${i.message}`).join('; '),
        checked.issues as { path: string; message: string }[],
      )
    }

    writeAtomically(deps.configPath, text, before.mode)

    return success(c, { saved: true, ...view() })
  })

  return routes
}

/**
 * Write via a temporary file in the same directory, then rename.
 *
 * A truncated write here is not an inconvenience: `rockysurf.config.yaml` is the file the
 * process reads at startup, so a crash mid-write is an installation that will not boot. Rename
 * within a directory is atomic, so the file is afterwards either entirely the old one or
 * entirely the new one.
 *
 * THE MODE IS CARRIED ACROSS, and that is not tidiness. Writing the temp file with the default
 * umask and renaming it over the original REPLACES the original's permissions with the temp
 * file's — so an operator who had chmodded a config file holding a pasted token to 0600 would
 * find it world-readable after saving the port from a web page. A file this route creates gets
 * 0600 for the same reason.
 */
function writeAtomically(path: string, text: string, existingMode: number | null): void {
  const temp = join(dirname(path), `.${basename(path)}.rockysurf-${process.pid}.tmp`)
  try {
    /**
     * THE DIRECTORY MAY NOT EXIST YET (rockysurf-8wgm). With no config file anywhere, the file
     * this page creates is `~/.rockysurf/config.yaml`, and on a run that has not booted — a
     * `dataDir` pointed elsewhere — nothing has made `~/.rockysurf`. `0700` because this is the
     * same directory the master key lives in, and the mode is set explicitly rather than left to
     * the umask for exactly the reason `ensureDataDir` does it: a typical umask yields `0755`.
     */
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(temp, text, { encoding: 'utf8', mode: existingMode ?? 0o600 })
    // `mode` only applies when the file is created, and a crashed save may have left one behind.
    chmodSync(temp, existingMode ?? 0o600)
    renameSync(temp, path)
  } catch (err) {
    try {
      unlinkSync(temp)
    } catch {
      // The temp file never existed, or is already gone. Either way the real error is below.
    }
    throw err
  }
}
