import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app.js'
import {
  checkConfigText,
  configSchema,
  type ConfigIssue,
  type ConfigWarning,
  type ReloadOutcome,
} from '../config/index.js'
import { badRequest, conflict, forbidden, success } from '../http/responses.js'
import { validate } from '../http/validate.js'
import { applyChanges, parseTree, type Change } from './document.js'
import { patternOf, type FieldSpec, type ListSpec, type SectionSpec } from './fields.js'
import { buildSettingsInventory, type DescribedProvider, type SettingsInventory } from './inventory.js'
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
 *  4. **Restart honesty, now per field** (issue #264). A save APPLIES: the file is re-read and
 *     this process adopts it before the response is written, so the response can say which of
 *     the paths just saved are already in force. The five that cannot be — the port, the
 *     listening address, the data directory, the auth mode, and the MCP server's scopes, which
 *     belong to a different process — say so individually, with `fields.ts`'s own reason.
 *     `drifted` and `pendingRestart` are narrowed to exactly those: a notice that survives a
 *     page reload, and now one that appears only when something really is waiting. `warnings`
 *     is the case where nothing could be applied at all — a saved reference to a variable this
 *     process cannot see leaves the file un-adoptable until it is exported and core restarted.
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
  /**
   * Make this process adopt the file it has just written (issue #264).
   *
   * `createApp` supplies `configStore.reload`. It is optional because a core built without a
   * config store has nothing to adopt WITH, and the honest thing for such a build to say is the
   * old sentence: saved, applies at the next restart. That is what `NO_CONFIG_STORE` below
   * says, rather than this route claiming an effect nothing produced.
   */
  reload?: () => ReloadOutcome
  /**
   * What the composition root knows about a provider id — its factory's display name — so a
   * personal provider's panel can wear the name its package gives it (ADR-0026). Absent, the
   * panel is titled by the config key, which is the only name anyone has for a package that did
   * not load.
   */
  describeProvider?: (id: string) => DescribedProvider | undefined
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
  /**
   * The inventory, so the page renders read-only reasons, help and warnings from one source.
   *
   * BUILT FOR THIS FILE (ADR-0026): core's hand-written rows plus a panel for every personal
   * provider section the file names — see `settings/inventory.ts`. A section with no row renders
   * nowhere, so the inventory has to know about a section before the page can.
   */
  fields: readonly FieldSpec[]
  /** Section titles and their help text, for the same reason (rockysurf-5qzg). */
  sections: readonly SectionSpec[]
  lists: readonly ListSpec[]
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
  /**
   * True when a RESTART-REQUIRED value in the file differs from the one in force (issue #264).
   *
   * It used to mean "the file differs from what this process booted with", which after #264 is
   * true of every successful save and says nothing an operator can act on — the process has
   * adopted those values. Narrowed to the five paths that genuinely wait, so the banner appears
   * when there is something to restart FOR, and `pendingRestart` names them.
   */
  drifted: boolean
  /** Which restart-required settings are waiting, with the reason each one gives. */
  pendingRestart: readonly PendingRestart[]
  restartHint: string
  /** The same sentence, split so a client can set its commands in monospace (#232). */
  restartHintSegments: readonly HintSegment[]
}

/** One setting saved into the file that the running process is not using yet. */
export interface PendingRestart {
  /** The inventory path, so the page can put the note on the control. */
  path: string
  /** `fields.ts`'s own sentence about why this one cannot change while core runs. */
  reason: string
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
 *
 * REWORDED BY ISSUE #264, because the old sentence — "Rocky Surf reads this file once, at
 * startup" — stopped being true. It is now HOW TO RESTART rather than a claim that you have to,
 * so the page can print it under the small number of settings that still need one without also
 * telling everyone else that nothing they saved has taken effect.
 */
export const RESTART_HINT_SEGMENTS: readonly HintSegment[] = [
  { text: 'To restart Rocky Surf: stop the process with ' },
  { text: 'Ctrl-C', code: true },
  { text: ' and run ' },
  { text: './start.sh', code: true },
  { text: ' again.' },
]

export const RESTART_HINT = RESTART_HINT_SEGMENTS.map((segment) => segment.text).join('')

/**
 * What a core with no live config store says about a save. See `SettingsRoutesDeps.reload`.
 *
 * The old behaviour, stated rather than pretended away: nothing here re-read the file, so the
 * values in force are the ones this process started with.
 */
const NO_CONFIG_STORE =
  'Saved to the file. This Rocky Surf was built without a live configuration store, so the new ' +
  'values apply at the next restart.'

/** The schema's own defaults, unredacted — what a value absent from the file actually resolves to. */
const SCHEMA_DEFAULTS: unknown = configSchema.parse({})

/** Read a dotted path out of a parsed tree. `undefined` for anything not present. */
function valueAtPath(tree: unknown, path: string): unknown {
  let node: unknown = tree
  for (const segment of path.split('.')) {
    if (node === null || node === undefined || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

/**
 * The effective value of a path: what the file says, or what the loader would default it to.
 *
 * Comparing raw file values would report a restart as pending for someone who saved
 * `server.port: 8080` into a file that had simply been relying on the default 8080 — a banner
 * about a change that is not one. The defaults are the same ones `configSchema` gives boot.
 */
function effectiveAt(tree: unknown, path: string): unknown {
  const found = valueAtPath(tree, path)
  return found === undefined ? valueAtPath(SCHEMA_DEFAULTS, path) : found
}

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
   * over the parsed TREE rather than the bytes so a comment edit is not reported as drift.
   *
   * The tree itself is kept, not only its hash: since #264 the question is no longer "has
   * anything changed?" but "has one of these five changed?", and that needs the values.
   */
  const bootTree = parseTree(readFile(deps.configPath).text)

  /** The inventory for a given file — core's rows plus a panel per personal provider (ADR-0026). */
  const inventoryFor = (tree: unknown): SettingsInventory =>
    buildSettingsInventory({ tree, ...(deps.describeProvider ? { describeProvider: deps.describeProvider } : {}) })

  /** The schema's own defaults, redacted like everything else so there is one masked path. */
  const defaults = redactTree(SCHEMA_DEFAULTS)

  /**
   * Which restart-required settings the file has moved and this process has not (issue #264).
   *
   * Compared against the values at BOOT rather than against the store's current config, because
   * `PINNED_PATHS` means the store is still serving the booted values for four of the five and
   * would report no difference at all. `mcp.scopes` is the fifth and is not pinned — nothing in
   * this process reads it — so it is compared the same way and for the same reason. A personal
   * provider's `package` is the sixth kind (ADR-0026): the package is loaded at boot.
   */
  function pendingRestart(tree: unknown, inventory: SettingsInventory): PendingRestart[] {
    return inventory.restartRequiredPaths.flatMap((path) => {
      // No inventory path that needs a restart is inside a list, so none of them carries a `*`.
      if (path.includes('*')) return []
      if (fingerprint(effectiveAt(tree, path)) === fingerprint(effectiveAt(bootTree, path))) return []
      const reason = inventory.fields.find((field) => field.path === path)?.restartReason
      return reason ? [{ path, reason }] : []
    })
  }

  function view(): SettingsView {
    const file = readFile(deps.configPath)
    const tree = parseTree(file.text)
    const inventory = inventoryFor(tree)
    const checked = checkConfigText(file.text, env)
    const waiting = pendingRestart(tree, inventory)
    return {
      file: { path: deps.configPath, exists: file.exists, mtimeMs: file.mtimeMs },
      values: redactTree(tree, [], inventory.isSecretPath),
      defaults,
      fields: inventory.fields,
      sections: inventory.sections,
      lists: inventory.lists,
      ...(checked.ok ? {} : { issues: checked.issues }),
      ...(checked.warnings.length > 0 ? { warnings: checked.warnings } : {}),
      drifted: waiting.length > 0,
      pendingRestart: waiting,
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
    // The inventory for the file AS IT IS, so a personal section already in the file is editable
    // and one that is not is refused like any other unknown path (ADR-0026).
    const inventory = inventoryFor(parseTree(readFile(deps.configPath).text))
    const rejected = changes.flatMap((change) => {
      const path = change.path as (string | number)[]
      const spec = inventory.specFor(path)
      if (spec) {
        return spec.writable
          ? []
          : [{ path: patternOf(path), message: spec.reason ?? 'this field is not editable here' }]
      }
      // A whole list entry — `{ path: ['github','tokens',2] }` — is how an entry is added or
      // removed, and it is legal exactly for the lists the inventory declares.
      const isListEntry =
        typeof path[path.length - 1] === 'number' &&
        inventory.lists.some((list) => list.path === patternOf(path.slice(0, -1)))
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

    /**
     * AND THEN THE PROCESS ADOPTS IT (issue #264), before the response is written.
     *
     * Synchronous and inline rather than a background watcher, and that ordering is the whole
     * point: by the time the page's save resolves, the values are already the ones in force, so
     * the very next request the operator makes — a create on a cloud they have just turned on —
     * sees them. A watcher would have made "did it take?" a race the page could not report on.
     *
     * A reload that cannot be applied leaves the previous values running and says so; the file
     * is still written either way, because the save is a record of the operator's intent and
     * the environment catching up (`rockysurf-1z5q`) is the ordinary next step.
     */
    const outcome: ReloadOutcome = deps.reload?.() ?? { applied: false, blocked: NO_CONFIG_STORE }

    /**
     * WHAT THIS SAVE DID, path by path, so the page never has to generalise.
     *
     * Split by the inventory's own `appliesAt`, over the paths the request actually named — not
     * over the whole file. An operator who saved the AWS region and the port did two different
     * things in one click, and the honest report is one line about each.
     */
    const saved = changes.map((change) => patternOf(change.path as (string | number)[]))
    const waiting = view().pendingRestart
    const restartRequired = waiting.filter((entry) => saved.includes(entry.path))

    return success(c, {
      saved: true,
      /** Paths in this save that the running process is already using. Empty if it could not adopt. */
      applied: outcome.applied ? saved.filter((path) => inventory.specFor(path.split('.'))?.appliesAt !== 'restart') : [],
      /** Paths in this save that wait for a restart, each with its own reason. */
      restartRequired,
      /** Why nothing could be applied, when that is the case. */
      ...(outcome.blocked ? { reloadBlocked: outcome.blocked } : {}),
      /**
       * Clouds whose SSH whitelist this save has just made stale, for the SPA to push (issue #304).
       *
       * THIS ROUTE DELIBERATELY DOES NOT PUSH IT ITSELF. A settings save is a cheap, local,
       * non-throwing operation — write the file, adopt it, answer — and ADR-0017 leans on that:
       * adoption is all-or-nothing and nothing may become half-applied. Reaching three cloud APIs
       * from inside it would put a save's success at the mercy of a network timeout and make the
       * one transaction the ADR designed as atomic into a partial one. So the save says what is
       * now out of date, and `POST /api/v1/network/ssh-access/sync` does the pushing, where a
       * per-cloud failure is a per-cloud failure and nothing else.
       *
       * Empty when the reload did not apply: the registry is still holding the PREVIOUS config,
       * so a sync now would push the CIDRs the operator had before this save rather than the ones
       * they just approved — which is exactly the silent widening this feature must never do.
       */
      networkSyncNeeded: outcome.applied ? providersNeedingNetworkSync(saved) : [],
      ...view(),
    })
  })

  return routes
}

/**
 * Which provider sections in this save changed the networks allowed to reach SSH.
 *
 * Derived from the saved PATHS rather than from a list of cloud ids, so a provider added later
 * is covered by having a `sshAllowedCidr` at all — the same reason the field inventory drives
 * the page instead of a hand-written block per cloud.
 */
function providersNeedingNetworkSync(savedPaths: readonly string[]): string[] {
  const ids = new Set<string>()
  for (const path of savedPaths) {
    const match = /^providers\.([^.]+)\.sshAllowedCidr$/.exec(path)
    if (match?.[1]) ids.add(match[1])
  }
  return [...ids]
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
 *
 * Exported for the one other route that writes the config file: the wizard's enable-a-cloud
 * POST (`../setup/routes.ts`, issue #280), which must not reinvent the crash-safety above.
 */
export function writeAtomically(path: string, text: string, existingMode: number | null): void {
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
