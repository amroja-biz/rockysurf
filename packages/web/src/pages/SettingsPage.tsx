import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import toast from 'react-hot-toast'
import { useSearchParams } from 'react-router'
import { AppShell } from '../components/AppShell'
import { ConfirmModal } from '../components/ConfirmModal'
import { ConnectGitHubCard, DISCONNECT_CONFIRMATION } from '../components/ConnectGitHubCard'
import { MachineTypePicker } from '../components/MachineTypePicker'
import { Tabs } from '../components/Tabs'
import {
  ApiError,
  disconnectGithub,
  getGithubConnection,
  getSettings,
  listProviders,
  saveSettings,
  syncSshAccess,
  type SshAccessSyncReport,
  type GithubConnection,
  type ProviderInfo,
  type SecretView,
  type SettingsChange,
  type SettingsField,
  type SettingsList,
  type SettingsView,
} from '../lib/api'
import { ENV_VAR_ONLY, envVarDisplay, envVarReference } from '../lib/envRef'
import {
  describeScope,
  newScopedEntry,
  refuseNewEntry,
  scopeChanges,
  tokenKey,
  tokenSpecPath,
  unifiedTokens,
  type RawTokenEntry,
  type TokenEntry,
} from '../lib/githubTokens'

/**
 * Settings — a GUI over `rockysurf.config.yaml` (rockysurf-m29b, streamlined by rockysurf-5qzg).
 *
 * IT EDITS THE FILE. Not a copy of it in the database, not a settings table that shadows it:
 * the same YAML an operator would open in an editor, edited in place with its comments intact.
 * Config is configuration and never becomes data, so there is one place these values live and
 * no second copy to disagree with it.
 *
 * THREE THINGS THIS PAGE HAS TO BE HONEST ABOUT, and they are the whole design:
 *
 *  1. **It cannot show you a secret, and it will not take one.** A token box holds the NAME of an
 *     environment variable (rockysurf-4o3o): the file gets `${GITHUB_PAT}`, the box shows
 *     `GITHUB_PAT`, and anything that is not a variable name is refused here with the reason. A
 *     literal already in the file still loads and is still never displayed — it reads as a stored
 *     token, with the way out of it stated under the box. See `lib/envRef.ts`.
 *  2. **A blank secret box means "leave it alone".** Every other field here saves what is in it.
 *     A secret field saves only what you type into it, because the alternative — blank meaning
 *     "delete the token" — would wipe a credential every time somebody changed the port.
 *     Removing one is a separate, labelled button with a confirmation.
 *  3. **It says what a save actually did, per setting** (issue #264). Almost everything here is
 *     in force the moment it is written — core re-reads the file and adopts it before the save
 *     even answers — and the page says so, by name. The handful that a running process cannot
 *     adopt (the port and the address it listens on, the data directory, the auth mode, and the
 *     MCP server's scopes, which belong to a different process) carry the reason at the control
 *     itself, and only THOSE raise the banner. The banner is still server-derived rather than a
 *     toast, so it survives a reload and stays up until the restart happens.
 *
 * The field inventory — field labels aside — comes from the server: which fields are writable,
 * why the read-only ones are not, which carry a warning, what each one is FOR, and which do not
 * render at all. One source of truth, so a field that becomes editable does not also need an
 * edit here to stop claiming it is not.
 *
 * ── WHAT rockysurf-5qzg CHANGED, and why each ─────────────────────────────────────────
 * **Nothing renders a control it cannot honour.** A read-only field whose only message is "you
 * cannot use this" is not honesty, it is an invitation followed by a refusal — so the server
 * marks it `hidden` and the page draws nothing. `server.dataDir` and `providers.aws.sizes` are
 * NOT that: they are settings that work, whose values an operator wants to read and whose
 * reasons name where the edit is actually made. `auth.mode` is, because the mode its one
 * available edit would select has not been built.
 *
 * **One list of access tokens.** `github.pat` and `github.tokens[]` were two sections for one
 * subject. They are now one list in which the entry with no scope IS the instance-wide
 * fallback; `lib/githubTokens.ts` holds that mapping, and every change it emits still names a
 * path the config file already had.
 *
 * **Every field says what it is for**, in a line under its label rather than a `title` nobody
 * can hover on a phone. The words come from the server, which took them from the example config
 * and the self-hosting guide, so the file, the docs and this page cannot disagree.
 * ──────────────────────────────────────────────────────────────────────────────────────
 *
 * ── ONE SECTION AT A TIME, AND THE SERVER DECIDES WHAT THE SECTIONS ARE (issue #122) ──
 * The page used to be one column a screen and a half long, with ten headings in it and no way
 * to get to the tenth but scrolling. It is now a tab per section — a column of tabs beside the
 * form on a wide screen, a scrolling strip above it on a narrow one — and the four rules it
 * follows are all consequences of the same decision, that **the navigation is the inventory**:
 *
 *  1. **Nothing here lists the sections.** They come from `view.sections`, in the server's
 *     order, and a section whose id is inside another one's (`providers.byo.hosts` inside
 *     `providers.byo`) is a card on that tab rather than a tab of its own. Add a section to
 *     `settings/fields.ts` and it appears here — with its fields in it — with no edit to this
 *     file. That is the property issue #124 needs, and `SettingsPage.wiring.test.tsx` asserts
 *     it against a section this page has never heard of.
 *  2. **Every field in the inventory is drawn by somebody.** The blocks below are hand-written,
 *     for the reasons the m29b note above gives, and each one records the paths it drew;
 *     anything left over is rendered generically into the section it belongs to. A field added
 *     to core is therefore editable here immediately, and a hand-written control for it later
 *     is an improvement rather than a fix.
 *  3. **Every panel stays mounted.** Only `hidden` moves. Switching tabs with a half-typed port
 *     or an unsaved token cannot lose either — the edit map is above all of this anyway, and a
 *     tab carries a dot when it holds unsaved work or a rejected field, so the one Save button
 *     at the foot of the page never saves something the operator cannot see.
 *  4. **The tab is in the URL** (`?section=`), so a link goes to a section, a reload comes back
 *     to it, and a save the server rejects switches to the tab holding the first bad field.
 * ──────────────────────────────────────────────────────────────────────────────────────
 *
 * ── THE SAVED TYPES ARE CHOSEN FROM THE CATALOGUE, NOT TYPED (issue #212) ─────────────
 * `preferences.tiers.<cloud>.<size>` used to be a free-text box: a cloud's own machine-type
 * vocabulary, typed from memory, in the one place on this installation where a typo is
 * REMEMBERED rather than corrected on the next screen. Each of those boxes now carries the same
 * filterable catalogue the New Server page offers — the same component (`MachineTypePicker`),
 * over the same `/providers` rows, with the same "Available only" filter and the same per-row
 * refusals — and selecting a row fills the box.
 *
 * THREE THINGS IT DOES NOT CHANGE, each of them load-bearing:
 *
 *  - **The box stays.** Blank means "the cheapest type that meets the floor", which has to
 *    remain typable and clearable; a catalogue is not always there to pick from (a cloud that is
 *    switched off in this very file has no provider loaded, and `/providers` is advisory here);
 *    and a saved type is the operator's answer, not a second guess at it, so a type this
 *    installation cannot currently offer is still a legitimate thing to have written down.
 *  - **Nothing is hard-coded per cloud.** The picker is offered to any field whose path has the
 *    SHAPE `preferences.tiers.<id>.<size>` when a provider with that id is loaded, so a cloud
 *    added to core's table (`settings/fields.ts`) gets one with no edit here — the property
 *    issue #124 built and rule 1 above protects.
 *  - **One form, one Save button.** Selecting a row records a pending edit like any keystroke;
 *    it saves with everything else, and the tab wears the same unsaved dot.
 * ──────────────────────────────────────────────────────────────────────────────────────
 *
 * ── WHY THE CONTROLS ARE FUNCTIONS AND NOT COMPONENTS ─────────────────────────────────
 * `textField(...)` is called; it is not `<TextField/>`. A component DECLARED inside this
 * function is a new component type on every render, so React unmounts and remounts its subtree
 * each time state changes — and an input that remounts loses focus after every keystroke. The
 * alternative is hoisting them out with `edits`, `setEdit`, `specs` and `fieldErrors` threaded
 * through every call. Calling them keeps the reconciler seeing one stable tree.
 * ──────────────────────────────────────────────────────────────────────────────────────
 */

type Edits = Record<string, SettingsChange>

/** `['github','tokens',0,'pat']` → `'github.tokens.0.pat'`, the key edits and issues are held by. */
const keyOf = (path: (string | number)[]) => path.join('.')

/** The same path with list indices generalised, which is how the server names a field spec. */
const patternOf = (path: (string | number)[]) => path.map((s) => (typeof s === 'number' ? '*' : s)).join('.')

/** The query parameter carrying the open section, so a link and a reload both land on it. */
const SECTION_PARAM = 'section'

/**
 * The section a dotted path belongs to: the LONGEST section id that prefixes it.
 *
 * Longest, not first, because the sections nest — `providers.byo.hosts.0.name` is a host's
 * field and not a stray `providers.byo` one, and a first-match rule would put every host field
 * on the wrong card the moment the two sections were listed in the wrong order.
 */
function sectionOf(path: string, ids: readonly string[]): string | undefined {
  let best: string | undefined
  for (const id of ids) {
    if (path !== id && !path.startsWith(`${id}.`)) continue
    if (best === undefined || id.length > best.length) best = id
  }
  return best
}

/**
 * `preferences.tiers.aws.small` → `aws`, and anything else → undefined (issue #212).
 *
 * THE SHAPE, NOT A LIST OF CLOUDS. Core generates these fields from one table, so a cloud added
 * there appears here with no edit to this file (issue #124) — a hand-written case per cloud would
 * give that property straight back. What the id has to match is a provider this installation
 * actually loaded, which is a fact about the running process rather than anything written here.
 */
function tierCloudOf(path: string): string | undefined {
  const parts = path.split('.')
  return parts.length === 4 && parts[0] === 'preferences' && parts[1] === 'tiers' ? parts[2] : undefined
}

/**
 * The tab a section is drawn on: itself, or the outermost section that contains it.
 *
 * A nested section is a card on its parent's tab rather than a tab of its own — "Your own
 * machines" and "Hosts" are one subject, and splitting them across two tabs would ask an
 * operator to enable a provider on one and satisfy its requirement on another.
 */
function tabOf(id: string, ids: readonly string[]): string {
  let current = id
  for (;;) {
    const parent = ids.reduce<string | undefined>(
      (best, other) =>
        other !== current && current.startsWith(`${other}.`) && (best === undefined || other.length < best.length)
          ? other
          : best,
      undefined,
    )
    if (parent === undefined) return current
    current = parent
  }
}

/**
 * `sshAllowedCidr` → `Ssh Allowed Cidr`.
 *
 * ONLY EVER A FALLBACK. Every field this page has a hand-written block for has a hand-written
 * label; this is what a field core added after this build shipped gets, so that it renders with
 * a readable name instead of not rendering at all.
 */
function humanize(segment: string): string {
  const spaced = segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** An edit key belonging to the unified token list, which saves per entry rather than in bulk. */
const isTokenKey = (key: string) => key === 'github.pat' || key.startsWith('github.tokens.')

function valueAt(tree: unknown, path: (string | number)[]): unknown {
  let node: unknown = tree
  for (const segment of path) {
    if (node === null || node === undefined || typeof node !== 'object') return undefined
    node = (node as Record<string | number, unknown>)[segment]
  }
  return node
}

/** A secret field's state, tolerating a file where the key is simply absent. */
function secretAt(tree: unknown, path: (string | number)[]): SecretView {
  const found = valueAt(tree, path)
  if (found && typeof found === 'object' && 'secret' in found) return found as SecretView
  return { secret: true, state: 'unset' }
}

interface ListField {
  name: string
  label: string
  secret?: boolean
  /** The variable name shown as a placeholder in a credential box — see `lib/envRef.ts`. */
  example?: string
}

/**
 * Core's restart instruction, with the runs it flagged as commands set in <code> (#232).
 *
 * `Ctrl-C` and `./start.sh` are things the operator types at a terminal, and the type rule is
 * that those are monospace wherever they appear. The page does not decide WHICH runs those are:
 * core marks them, because a client picking `./start.sh` out of core's prose by hand would turn
 * a sentence into an interface. The whole sentence still reads the same.
 */
function RestartHint({ segments }: { segments: SettingsView['restartHintSegments'] }) {
  return (
    <>
      {segments.map((segment) =>
        segment.code ? <code key={segment.text}>{segment.text}</code> : <span key={segment.text}>{segment.text}</span>,
      )}
    </>
  )
}

/**
 * The note under a control that a running Rocky Surf cannot honour yet (issue #264).
 *
 * PER FIELD, AT THE CONTROL, and the wording is core's. The old page put one banner over
 * everything saying nothing had taken effect; the true statement is about five specific
 * settings, and the place to make it is beside each of them — where somebody about to change
 * the port reads it before they click Save, rather than after.
 *
 * Rendered for the writable and the read-only alike: `server.dataDir` is not editable here and
 * an operator still has to know that moving it is a stop-and-start, not an edit.
 */
function RestartNote({ spec }: { spec: SettingsField | undefined }) {
  if (spec?.appliesAt !== 'restart' || !spec.restartReason) return null
  return (
    <p className="hint settings-restart-note" data-restart-required={spec.path}>
      <strong>Takes effect after a restart.</strong> {spec.restartReason}
    </p>
  )
}

/** A blank entry being filled in before it is added — held here, never written half-formed. */
interface TokenDraft {
  scope: string
  host: string
  pat: string
}

export function SettingsPage() {
  const [view, setView] = useState<SettingsView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [edits, setEdits] = useState<Edits>({})
  /** Field path → message, from the last rejected save. Cleared when that field is edited. */
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /**
   * ONE CONFIRMATION ON THIS PAGE, over two kinds of destructive act. Most of them are a change
   * to the config file, so they carry a `change` and go through `submit`. Disconnecting GitHub
   * is not a file edit at all — it deletes a row from the encrypted store — so it carries a
   * `confirm` instead. A second modal for it would have been a second set of words about the
   * same interaction.
   */
  const [pendingRemoval, setPendingRemoval] = useState<{
    title?: string
    label: string
    message?: string
    confirmLabel?: string
    change?: SettingsChange
    confirm?: () => void | Promise<void>
  } | null>(null)
  /** What the last push of the SSH whitelist did, per cloud (issue #304). */
  const [syncReports, setSyncReports] = useState<SshAccessSyncReport[] | null>(null)
  const [pushing, setPushing] = useState(false)
  /** The half-typed CIDR in each cloud's Add box, keyed by field path (issue #304). */
  const [cidrDrafts, setCidrDrafts] = useState<Record<string, string>>({})
  const [connection, setConnection] = useState<GithubConnection | null>(null)
  /**
   * The loaded clouds and what each of them sells, for the saved-type pickers (issue #212).
   *
   * ADVISORY, like the GitHub connection above and for the same reason: this page's job is
   * editing the configuration file, and it can still do that with no catalogue at all — the
   * saved-type boxes simply stay the free-text boxes they have always been. So a failure here
   * leaves the list empty and nothing else on the page notices.
   *
   * It is the SAME `/providers` response the New Server page reads, allowlist and all, rather
   * than a settings-only endpoint: a type this picker offers has to be a type that page would
   * resolve to, and two sources for one catalogue is how they come to disagree.
   */
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [draft, setDraft] = useState<TokenDraft | null>(null)
  const [draftError, setDraftError] = useState<string | null>(null)
  /**
   * WHICH SECTION IS OPEN LIVES IN THE URL, not in a `useState` beside it (issue #122).
   *
   * One place, so there is nothing to keep in step: a pasted `?section=providers.aws` opens AWS,
   * a reload after a save comes back to the tab it was on, and the browser's own history holds
   * the answer rather than a state variable that a remount would reset to the first tab.
   *
   * `replace` on selection, so a Back press leaves Settings rather than walking back up through
   * every tab the operator looked at on the way in.
   */
  const [searchParams, setSearchParams] = useSearchParams()
  const openSection = useCallback(
    (id: string) => {
      const next = new URLSearchParams(searchParams)
      next.set(SECTION_PARAM, id)
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  const load = useCallback(async () => {
    try {
      setView(await getSettings())
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.detail : 'Could not read the configuration file')
    }
  }, [])

  /**
   * The GitHub connection, read separately from the config file because it IS separate: the
   * connected token lives in the encrypted store, not in `rockysurf.config.yaml`. A failure here
   * leaves `connection` null and the card simply does not draw — the config editor below it is
   * unaffected, which is the right blast radius for a feature that is not about the file.
   */
  const loadConnection = useCallback(async () => {
    try {
      setConnection(await getGithubConnection())
    } catch {
      setConnection(null)
    }
  }, [])

  /** The catalogues, read once. A cloud that cannot be reached simply offers no list (#212). */
  const loadProviders = useCallback(async () => {
    try {
      setProviders(await listProviders())
    } catch {
      setProviders([])
    }
  }, [])

  useEffect(() => {
    void load()
    void loadConnection()
    void loadProviders()
  }, [load, loadConnection, loadProviders])

  const specs = useMemo(() => {
    const map = new Map<string, SettingsField>()
    for (const field of view?.fields ?? []) map.set(field.path, field)
    return map
  }, [view])

  const sections = useMemo(() => {
    const map = new Map<string, { title: string; help: string }>()
    for (const section of view?.sections ?? []) map.set(section.id, section)
    return map
  }, [view])

  /** The lists core declares, by path — what `genericList` draws a card from. */
  const lists = useMemo(() => {
    const map = new Map<string, SettingsList>()
    for (const list of view?.lists ?? []) map.set(list.path, list)
    return map
  }, [view])

  /** Edits the bulk Save carries — the token list keeps its own, per entry. */
  const formEdits = Object.entries(edits).filter(([key]) => !isTokenKey(key))
  const tokenEdits = Object.entries(edits).filter(([key]) => isTokenKey(key))
  const dirty = formEdits.length > 0
  const anyDirty = Object.keys(edits).length > 0

  function setEdit(path: (string | number)[], change: SettingsChange | null): void {
    const key = keyOf(path)
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    setEdits((prev) => {
      const next = { ...prev }
      if (change === null) delete next[key]
      else next[key] = change
      return next
    })
  }

  /**
   * Every credential change, with the box's text turned into the file's reference — or the keys
   * that cannot be, because what is in them is not a variable name (rockysurf-4o3o).
   *
   * ONE SEAM, so no caller can bypass it: the bulk Save, a token card's own Save, a removal and a
   * confirmation all reach the file through `submit`, and this runs on whatever they hand it.
   * `specs` decides what is a credential — the same server inventory that decides everything else
   * about a field — rather than the page guessing from the path.
   *
   * IT DESCENDS INTO A CHANGE'S VALUE, because two of them are whole blocks rather than scalars: a
   * new token entry is written as one `github.tokens.<n>` change carrying `{ repo, pat }`, and a
   * spend cap as `{ amount, currency }`. Checking only the change's own path would leave the
   * credential inside the first of those unexamined — which is exactly the shape a new entry
   * arrives in, so it would be the common case rather than an edge one.
   */
  function asReferences(changes: SettingsChange[]): { sent: SettingsChange[]; refused: string[] } {
    const refused: string[] = []

    const convert = (path: (string | number)[], value: unknown): unknown => {
      const spec = specs.get(patternOf(path))
      // A paste box sends what was pasted, verbatim (rockysurf-7fyf.2). Converting it would
      // write `${ghp_…}` into the file — a reference to a variable named after a token.
      if (spec?.kind === 'secret' && spec.accepts === 'literal') return value
      if (spec?.kind === 'secret') {
        const reference = envVarReference(String(value ?? ''))
        if (reference !== null) return reference
        refused.push(keyOf(path))
        return value
      }
      // Objects only: a list arriving as a whole value is a shape nothing on this page writes,
      // and walking one would invent index paths that no spec could answer for.
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, convert([...path, key], item)]),
        )
      }
      return value
    }

    const sent = changes.map((change) =>
      change.unset ? change : { ...change, value: convert(change.path, change.value) },
    )
    return { sent, refused }
  }

  /**
   * Send a set of changes, and report whether the file took them.
   *
   * `only` carries a save that must travel alone: a structural change to a list, or one entry of
   * the token list. An index is how a list entry is named, and a removal renumbers every entry
   * after it, so combining "remove entry 1" with "change entry 2's owner" would apply the second
   * edit to whichever entry moved into that slot. Rather than blocking the whole page while
   * anything is unsaved (which is what m29b did), each list refuses only its OWN combinations:
   * Add and Remove are disabled while that list has pending edits, and everything else on the
   * page carries on independently.
   */
  async function submit(only?: SettingsChange[], onlyKeys?: string[]): Promise<boolean> {
    if (!view) return false
    const changes = only ?? formEdits.map(([, change]) => change)
    // A save clears the edits it CARRIED and no others. Clearing the whole map — which is what
    // one bulk form could get away with — would throw away a half-typed token in the list below
    // every time somebody saved the port.
    const clear = new Set(onlyKeys ?? formEdits.map(([key]) => key))
    if (changes.length === 0) return false

    // Nothing is sent when a token box holds something other than a variable name. The box itself
    // is already showing the policy and the reason, so this says which box and stops.
    const { sent, refused } = asReferences(changes)
    if (refused.length > 0) {
      setFormError(
        `Nothing was saved: ${refused.join(', ')} must name an environment variable rather than hold a token.`,
      )
      return false
    }

    setSaving(true)
    setFormError(null)
    setFieldErrors({})
    try {
      const result = await saveSettings(view.file.mtimeMs, sent)
      setView(result)
      setEdits((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => !clear.has(key))))
      /**
       * WHAT THE SAVE DID, not merely that it happened (issue #264).
       *
       * The toast used to say "Saved to the configuration file", which was true and was also the
       * least useful half of the answer — the operator's actual question is whether the thing
       * they just changed is doing anything yet. Core answers it per path, so this reports it
       * per path: applied now, waiting for a restart, or not applied at all because the file
       * names a variable this process cannot see.
       *
       * The waiting case is a toast AND stays on the page: the banner and the per-field notes
       * are server-derived and outlive this message, which is what a reload must not lose.
       */
      if (result.reloadBlocked) toast.error(result.reloadBlocked)
      else if (result.restartRequired.length > 0) {
        const names = result.restartRequired.map((entry) => entry.path).join(', ')
        toast.success(
          result.applied.length > 0
            ? `Saved and applied. ${names} needs a restart before it takes effect.`
            : `Saved. ${names} needs a restart before it takes effect.`,
        )
      } else toast.success('Saved, and applied — no restart needed')

      /**
       * AND THEN PUSH IT AT THE CLOUD (issue #304).
       *
       * A second call rather than part of the save, so a cloud that is slow or unreachable
       * cannot fail a file write that has already succeeded. Core says which clouds went stale;
       * it says nothing when the reload did not apply, because pushing then would send the list
       * the operator had before this save.
       */
      if (result.networkSyncNeeded?.length) await pushSshAccess('Saved, but could not push the SSH rule')
      return true
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.data as { issues?: { path: string; message: string }[] } | undefined
        setFieldErrors(Object.fromEntries((body?.issues ?? []).map((i) => [i.path, i.message])))
        setFormError(err.detail)
        // A rejected field on a tab nobody is looking at is a rejection nobody can read, and the
        // page has one Save button for every section. So the first bad field decides the tab.
        const firstBad = body?.issues?.[0]?.path
        const ids = view.sections.map((section) => section.id)
        const landsOn = firstBad === undefined ? undefined : sectionOf(firstBad, ids)
        if (landsOn !== undefined) openSection(tabOf(landsOn, ids))
        // A 409 means the file moved underneath and nothing was written. Show it as it is now,
        // with the pending edits still in the form so nothing typed here is thrown away.
        if (err.status === 409) await load()
      } else {
        setFormError('Could not save the configuration file')
      }
      return false
    } finally {
      setSaving(false)
    }
  }

  if (loadError) {
    return (
      <AppShell title="Settings" className="page settings">
        <p className="error">{loadError}</p>
      </AppShell>
    )
  }

  if (!view) {
    return (
      <AppShell title="Settings" className="page settings">
        <p className="hint">Reading the configuration file…</p>
      </AppShell>
    )
  }

  const { values, defaults } = view

  /**
   * Every inventory path a hand-written control drew, this render (issue #122).
   *
   * THE LEDGER BEHIND RULE 2 at the top of this file. The blocks below name their fields one by
   * one — that is the m29b decision and it stands — which means the page can fall behind the
   * inventory silently, and a setting nobody can see is a setting nobody can fix. So each
   * control records itself here as it is built, and whatever the inventory has that this set
   * does not is drawn generically into the section it belongs to.
   *
   * A PLAIN SET MUTATED DURING RENDER, deliberately. It is filled while the section bodies are
   * BUILT (they are called, not mounted — see the note above), read once afterwards in the same
   * pass, and thrown away with the render that made it, so there is no state to get stale and a
   * double render in StrictMode simply builds it twice.
   */
  const drawn = new Set<string>()
  const draw = (pattern: string) => drawn.add(pattern)

  /**
   * One `<form>` per masked credential box, so Chrome stops reading this page as several forms
   * crammed into one — and so it is right about what it is reading.
   *
   * WHAT CHROME SAYS, MEASURED rather than guessed (headless Chrome 152, DevTools issues and the
   * password-manager's own console recommendations, over the markup this page actually renders):
   *
   *  - two or more `type=password` boxes owned by one form → "Multiple forms should be contained
   *    in their own form elements; break up complex forms into ones that represent a single
   *    action". That is the warning in the report, and it is the ONLY one this page draws.
   *  - `autocomplete="new-password"` on those boxes does not remove it — and on a lone box it
   *    trades it for "Password forms should have (optionally hidden) username fields", because
   *    the hint promotes the box to a password form Chrome then wants a username for. A hidden
   *    username input silences that in turn and adds a DevTools issue of its own
   *    (`FormEmptyIdAndNameAttributesForInputError`), so the pair is worse than either half.
   *  - one password box per form owner, `autocomplete="off"` kept: silent, no console
   *    recommendation and no DevTools issue.
   *
   * SO THE FIX IS THE ONE CHROME ASKS FOR, WITHOUT MOVING ANYTHING. The `form` attribute names a
   * box's form owner by id, which need not be an ancestor — so each token box is owned by its own
   * empty form rendered beside the config form, while the DOM, the layout, the ONE FORM / ONE
   * SAVE BUTTON design and the ten mounted panels are exactly as they were. It also states
   * something already true: a token box is NOT part of the bulk save (`isTokenKey` keeps it out
   * of `formEdits`), it is saved by its own card's button, and until now the only thing Enter in
   * one of those boxes could do was submit the config form it never belonged to.
   *
   * A PLAIN ARRAY MUTATED DURING RENDER, on the ledger above's precedent and with the same
   * lifetime: the boxes are BUILT before the owners are rendered — they are called, not mounted —
   * and the array is thrown away with the render that filled it.
   */
  const passwordFormOwners: string[] = []
  const passwordFormOwner = (key: string) => `password-form-${key}`

  /**
   * The server's warnings, by the same dotted key the errors use (rockysurf-1z5q).
   *
   * They render like an error and mean something different: the save WENT THROUGH, and the file
   * now names a variable the running core cannot see. Keyed rather than listed so the sentence
   * lands on the control that caused it, the same way a save error does — and because they come
   * from the view rather than from the last response, they are still there after a reload, which
   * an error from a rejected save is not.
   */
  const warnings = Object.fromEntries((view.warnings ?? []).map((w) => [w.path, w.message]))
  /** The distinct variables, for the one sentence at the top of the form. */
  const unsetVars = [...new Set((view.warnings ?? []).map((w) => w.variable))]

  /* ------------------------------------------------------------------ field renderers */

  /**
   * The help line, under the label and above the control (rockysurf-5qzg, directive 3).
   *
   * ONE MECHANISM, EVERYWHERE, and it is deliberately not a tooltip. A `title` attribute is
   * invisible on a touch screen, invisible to a keyboard, and not reliably announced by a screen
   * reader — so on a page whose whole job is explaining a config file to somebody who has not
   * read it, the explanation would be missing for exactly the readers most in need of it. A `?`
   * popover is worse value again: JS state, focus handling and a second interaction pattern, for
   * one sentence. An always-visible line is what this page already does for warnings, secret
   * state and read-only reasons, so it is the house style rather than a new one, and
   * `aria-describedby` ties it to the control it belongs to.
   */
  function helpFor(specPath: string, id: string): ReactNode {
    const help = specs.get(specPath)?.help
    return help ? (
      <p className="field-help" id={`${id}-help`}>
        {help}
      </p>
    ) : null
  }

  const helpId = (specPath: string, id: string) => (specs.get(specPath)?.help ? `${id}-help` : undefined)

  /** Label, help, control, the server's warning for the field, and any error from a save. */
  function wrap(path: (string | number)[], label: string, control: ReactNode): ReactNode {
    const pattern = patternOf(path)
    const spec = specs.get(pattern)
    draw(pattern)
    // A hidden field is not drawn even when a call site asks for it: the inventory decides.
    if (spec?.hidden) return null
    const key = keyOf(path)
    const error = fieldErrors[key]
    return (
      <div className="form-group" data-field={key} key={key}>
        <label htmlFor={key}>{label}</label>
        {helpFor(pattern, key)}
        {control}
        {spec?.warning && <p className="hint settings-warning">{spec.warning}</p>}
        <RestartNote spec={spec} />
        {warnings[key] && <p className="warning settings-field-warning">{warnings[key]}</p>}
        {error && <p className="error settings-field-error">{error}</p>}
      </div>
    )
  }

  /** A field the editor shows and will not write, with the server's reason for that. */
  function readOnlyField(path: (string | number)[], label: string): ReactNode {
    const pattern = patternOf(path)
    const spec = specs.get(pattern)
    draw(pattern)
    if (spec?.hidden) return null
    const key = keyOf(path)
    const current = valueAt(values, path) ?? valueAt(defaults, path)
    const shown = current === undefined ? 'not set' : Array.isArray(current) ? current.join(', ') : String(current)
    return (
      <div className="form-group" data-field={key} key={key}>
        <label>{label}</label>
        {helpFor(pattern, key)}
        <p className="settings-value">{shown}</p>
        <p className="read-only">{spec?.reason}</p>
        <RestartNote spec={spec} />
      </div>
    )
  }

  /** What a text box for this path is showing right now: the pending edit, else the file. */
  function shownText(path: (string | number)[]): string {
    const edit = edits[keyOf(path)]
    const current = valueAt(values, path)
    if (edit) return edit.unset ? '' : String(edit.value ?? '')
    return current === undefined || current === null ? '' : String(current)
  }

  /**
   * `extra` is drawn under the box, inside the same form group.
   *
   * The one caller that passes anything is the saved-type field (issue #212), whose catalogue
   * picker belongs to its box rather than beside it: the two controls edit the same setting, and
   * the label, the help, the warning and the save error above and below them are that setting's.
   */
  function textField(
    path: (string | number)[],
    label: string,
    type: 'text' | 'number' = 'text',
    extra?: ReactNode,
  ): ReactNode {
    const key = keyOf(path)
    const fallback = valueAt(defaults, path)
    const shown = shownText(path)

    return wrap(
      path,
      label,
      <>
        <input
          id={key}
          type={type}
          value={shown}
          aria-describedby={helpId(patternOf(path), key)}
          placeholder={fallback === undefined ? '' : `default: ${String(fallback)}`}
          onChange={(e) => {
            const raw = e.target.value
            // An emptied box says nothing about the field, which is how the file gets back to the
            // default rather than to an empty string.
            if (raw === '') return setEdit(path, { path, unset: true })
            const asNumber = Number(raw)
            setEdit(path, {
              path,
              value: type === 'number' && Number.isFinite(asNumber) ? asNumber : raw,
            })
          }}
        />
        {extra}
      </>,
    )
  }

  /**
   * A saved type for one (cloud, size), with that cloud's own catalogue under it (issue #212).
   *
   * THE BOX IS STILL THERE and still does everything it did — it is the picker that is new, and
   * it writes into the same pending edit a keystroke would. Emptying the box, or selecting the
   * already-selected row, unsets the field: blank is the default (the cheapest type that meets
   * the size's floor) and it has to stay reachable in one move.
   *
   * NO CATALOGUE, NO PICKER — and no apology for one either. A cloud switched off in this very
   * file loads no provider, `/providers` is advisory here, and either way the answer is the box
   * this field has always had, which can still hold a type this installation cannot offer today.
   * That is deliberate: a saved type is the operator's answer, not a second guess at it, and core
   * already says which and why when it has to fall back.
   */
  function tierField(path: (string | number)[], label: string, cloud: string): ReactNode {
    const catalogue = providers.find((p) => p.id === cloud)
    const offerings = catalogue?.offerings ?? []
    if (!catalogue || offerings.length === 0) return textField(path, label)

    const saved = shownText(path)
    const known = offerings.some((o) => o.id === saved)
    return textField(
      path,
      label,
      'text',
      <>
        <MachineTypePicker
          instanceId={keyOf(path)}
          offerings={offerings}
          selectedId={saved === '' ? null : saved}
          onSelect={(offering) => setEdit(path, { path, value: offering.id })}
          onClear={() => setEdit(path, { path, unset: true })}
          // The saved type is never hidden by "Available only": it is the row this operator came
          // to look at, and its own unavailable reason is why they came.
          preferredIds={new Set(saved === '' ? [] : [saved])}
          summary={`Choose from ${catalogue.displayName}`}
          hint={
            'The catalogue the New Server page resolves against, narrowed by this installation’s own ' +
            'allowlist. Selecting a type fills the box above; selecting it again empties the box, which ' +
            'is the default — the cheapest type that meets this size’s floor.'
          }
        />
        {/* Not an error, and not a refusal: the file may name a type from another region, one
            outside `providers.<cloud>.sizes`, or one no longer sold. Core falls back to the
            floor and says so on the New Server page (issue #124); this is where somebody
            wondering why the list shows no selection finds that out. */}
        {saved !== '' && !known && (
          <p className="hint" data-tier-unlisted={keyOf(path)}>
            {catalogue.displayName} is not currently offering {saved} to this installation, so it is
            not in the list above. It is kept as written — a server asking for this size falls back
            to the cheapest type that meets the floor until it can be bought again.
          </p>
        )}
      </>,
    )
  }

  function boolField(path: (string | number)[], label: string): ReactNode {
    const key = keyOf(path)
    const edit = edits[key]
    const current = valueAt(values, path) ?? valueAt(defaults, path) ?? false
    return wrap(
      path,
      label,
      <input
        id={key}
        type="checkbox"
        aria-describedby={helpId(patternOf(path), key)}
        checked={edit ? Boolean(edit.value) : Boolean(current)}
        onChange={(e) => setEdit(path, { path, value: e.target.checked })}
      />,
    )
  }

  /** True when this field's box takes a pasted token rather than a variable name. */
  const acceptsLiteral = (specPath: string) => specs.get(specPath)?.accepts === 'literal'

  /**
   * A credential box, in one of the two shapes `FieldSpec.accepts` allows.
   *
   * `'envVarName'` — the default, rockysurf-4o3o, and still what Hetzner and the BYO hosts get.
   * PLAIN TEXT, DELIBERATELY: `type=password` over a variable name is theatre, the content is
   * not key material, masking it stops the operator proof-reading the one thing they have to get
   * right, and hiding it would suggest that pasting a token here is what the box is for. The
   * policy is enforced instead of implied — `envVarReference` refuses anything that is not a
   * name, in words, before anything is sent.
   *
   * `'literal'` — the two GitHub PATs, since rockysurf-7fyf.2. `type=password`, and that INVERTS
   * the sentence above rather than contradicting it: masking a variable name is theatre, masking
   * key material is not. No live refusal, because there is nothing left to refuse.
   *
   * ── THE PREFILL TRAP, WHICH IS WHY THE `reference` CASE SPLITS ────────────────────────
   * An env-var box prefills a `${VAR}` state with the bare name, as editable text — correct,
   * because the name is exactly what that box wants. Doing the same in a PASTE box would put
   * `GITHUB_PAT` in a box that now takes tokens, where the operator's first keystroke turns a
   * working reference into a literal nobody meant to write.
   *
   * So for a paste box a `reference` renders the way `set` already does: a STATE LINE and an
   * EMPTY input. Blank means keep, which the hint says in as many words, and the file is
   * preserved by rule 2 of `settings/routes.ts` — a save carries only what changed, and an
   * untouched secret is not in the payload.
   * ──────────────────────────────────────────────────────────────────────────────────────
   */
  function secretInput(
    path: (string | number)[],
    specPath: string,
    example: string,
  ): { input: ReactNode; state: SecretView; cleared: boolean; refusal: string | null } {
    const key = keyOf(path)
    const state = secretAt(values, path)
    const edit = edits[key]
    const cleared = edit?.unset === true
    const literal = acceptsLiteral(specPath)
    draw(specPath)

    // Masked boxes get a form owner of their own (see `passwordFormOwners`). Only masked ones:
    // an env-var-name box is plain text, holds no key material, and is part of the bulk save.
    const owner = literal ? passwordFormOwner(key) : undefined
    if (owner) passwordFormOwners.push(owner)

    const typed = edit && !cleared ? String(edit.value ?? '') : undefined
    const fromFile =
      !cleared && typed === undefined && !literal && state.state === 'reference'
        ? envVarDisplay(state.reference)
        : ''
    const shown = cleared ? '' : (typed ?? fromFile)
    // Live, because a refusal that waited for the Save button would let an operator type a whole
    // token before being told the box never wanted one. An empty box is not a refusal: blank
    // means keep. A paste box refuses nothing.
    const refusal =
      !literal && typed !== undefined && typed.trim() !== '' && envVarReference(typed) === null
        ? ENV_VAR_ONLY
        : null

    const input = (
      <input
        id={key}
        type={literal ? 'password' : 'text'}
        spellCheck={false}
        // `off` and not `new-password`: this is a personal access token for a forge, not a
        // password for this site, and the hint that would invite a browser to remember it is
        // also the hint that makes Chrome ask for a username field to file it under. Measured
        // both ways — see the note on `passwordFormOwners`.
        autoComplete="off"
        {...(owner ? { form: owner } : {})}
        disabled={cleared}
        value={shown}
        aria-describedby={helpId(specPath, key)}
        placeholder={placeholderFor(state, { cleared, literal, example })}
        onChange={(e) => {
          // Blank means KEEP — the one kind of field on this page where it does. Removing a
          // credential is a labelled button, so a half-finished edit can never delete one.
          const raw = e.target.value
          setEdit(path, raw === '' ? null : { path, value: raw })
        }}
      />
    )
    return { input, state, cleared, refusal }
  }

  /**
   * What the file currently says about a credential, in a sentence.
   *
   * The `literal` half is not the same sentence with a word changed. For a paste box, a stored
   * token is the NORMAL state rather than something to migrate out of, and a `${VAR}` reference
   * is a working configuration this page must not talk anyone out of — the file still supports
   * it, and a hand-edited one keeps loading forever.
   */
  function secretStateHint(state: SecretView, literal: boolean): string {
    if (state.state === 'set') {
      return literal
        ? 'A token is stored in the configuration file and cannot be displayed here. Paste a new one ' +
            'to replace it. '
        : 'A literal token is stored in the configuration file, and cannot be displayed here. Move it ' +
            'into an environment variable and name that variable here; the file will then hold only the ' +
            'reference. '
    }
    if (state.state === 'reference') {
      return literal
        ? 'This entry names an environment variable, which Rocky Surf reads at startup — that still ' +
            'works and the file is unchanged. Leave the box empty to keep it, or paste a token to ' +
            'replace it. '
        : 'Read from this environment variable at startup. The file holds the reference — never what it expands to. '
    }
    return 'Not set in the configuration file. '
  }

  /** The greyed text in a credential box, which differs by state and by what the box takes. */
  function placeholderFor(
    state: SecretView,
    { cleared, literal, example }: { cleared: boolean; literal: boolean; example: string },
  ): string {
    if (cleared) return 'Will be removed when you save'
    if (literal) {
      if (state.state === 'set') return 'A token is stored in the file — paste a new one to replace it'
      if (state.state === 'reference') return 'Leave empty to keep the environment variable this names'
      return example
    }
    if (state.state === 'set') return 'A token is stored in the file — name a variable to replace it'
    return example
  }

  /** The live refusal under a token box, when what is in it is not a variable name. */
  function refusalLine(key: string, refusal: string | null): ReactNode {
    return refusal ? (
      <p className="error settings-field-error" data-refusal={key}>
        {refusal}
      </p>
    ) : null
  }

  function secretField(path: (string | number)[], label: string, example: string): ReactNode {
    const key = keyOf(path)
    const pattern = patternOf(path)
    const spec = specs.get(pattern)
    if (spec?.hidden) return null
    const { input, state, cleared, refusal } = secretInput(path, pattern, example)

    return (
      <div className="form-group" data-field={key} key={key}>
        <label htmlFor={key}>{label}</label>
        {helpFor(pattern, key)}
        {input}
        {refusalLine(key, refusal)}
        <p className="hint">
          {secretStateHint(state, acceptsLiteral(pattern))}
          Leave this blank to keep it as it is.
        </p>
        {spec?.warning && <p className="hint settings-warning">{spec.warning}</p>}
        {fieldErrors[key] && <p className="error settings-field-error">{fieldErrors[key]}</p>}
        {(state.state !== 'unset' || cleared) && (
          <button
            type="button"
            className="btn-secondary settings-clear"
            onClick={() => setEdit(path, cleared ? null : { path, unset: true })}
          >
            {cleared ? 'Keep it after all' : 'Remove this credential'}
          </button>
        )}
      </div>
    )
  }

  /** One half of a spend cap that does not exist in the file yet — see the note at its use. */
  function newCapField(name: 'amount' | 'currency', label: string, type: 'text' | 'number'): ReactNode {
    const id = `limits.spendCap.${name}`
    draw(id)
    const pending = (edits['limits.spendCap']?.value ?? {}) as { amount?: number; currency?: string }
    return (
      <div className="form-group" data-field={id} key={id}>
        <label htmlFor={id}>{label}</label>
        {helpFor(id, id)}
        <input
          id={id}
          type={type}
          aria-describedby={helpId(id, id)}
          value={String(pending[name] ?? '')}
          onChange={(e) => {
            const raw = e.target.value
            const value = name === 'amount' ? (raw === '' ? '' : Number(raw)) : raw
            setEdit(['limits', 'spendCap'], {
              path: ['limits', 'spendCap'],
              value: { ...pending, [name]: value },
            })
          }}
        />
        {fieldErrors[id] && <p className="error settings-field-error">{fieldErrors[id]}</p>}
      </div>
    )
  }

  /**
   * A control for a field the blocks below do not name — rule 2 at the top of this file.
   *
   * IT IS NOT A FORM GENERATOR, and the m29b note about why this page has none still holds: the
   * hand-written blocks decide what the settings page LOOKS like, and this decides only what
   * happens to a field they have not caught up with. The difference that matters is that this
   * one cannot invent a control the inventory did not describe — it reads `kind`, `writable` and
   * `hidden` off the same spec every other control here obeys, and its label is the field's own
   * last path segment because a spec carries no label. A hand-written block for the field later
   * takes over silently, because a drawn field is no longer left over.
   */
  function fallbackField(spec: SettingsField): ReactNode {
    if (spec.hidden) return null
    const path = spec.path.split('.')
    const label = humanize(path[path.length - 1] ?? spec.path)
    if (!spec.writable) return readOnlyField(path, label)
    // A saved type is a string field with a catalogue behind it (issue #212). Recognised by the
    // SHAPE of its path rather than named cloud by cloud, so this stays a rule about a kind of
    // setting — which is what a fallback renderer is — instead of becoming the hand-written
    // block per cloud that issue #124 exists to avoid.
    const cloud = spec.kind === 'string' ? tierCloudOf(spec.path) : undefined
    if (cloud !== undefined) return tierField(path, label, cloud)
    switch (spec.kind) {
      case 'boolean':
        return boolField(path, label)
      case 'number':
        return textField(path, label, 'number')
      case 'secret':
        return secretField(path, label, 'A_VARIABLE_NAME')
      // A list and a whole optional block are the two shapes a generic control would have to
      // guess at — how many entries, and what half a block means — so this says what the file
      // holds and where to change it rather than offering a box that would write the wrong
      // shape. `mcp.scopes` and `limits.spendCap` have hand-written editors and never land here.
      case 'stringList':
      case 'group':
        return uneditableFallback(spec, label)
      default:
        return textField(path, label)
    }
  }

  /** The value, and the honest sentence that this build has no control for a field of this shape. */
  function uneditableFallback(spec: SettingsField, label: string): ReactNode {
    const path = spec.path.split('.')
    const current = valueAt(values, path) ?? valueAt(defaults, path)
    const shown =
      current === undefined
        ? 'not set'
        : Array.isArray(current)
          ? current.join(', ')
          : JSON.stringify(current)
    return (
      <div className="form-group" data-field={spec.path} key={spec.path}>
        <label>{label}</label>
        {helpFor(spec.path, spec.path)}
        <p className="settings-value">{shown}</p>
        <p className="read-only">
          This page has no editor for a setting of this shape yet. Change <code>{spec.path}</code>{' '}
          in the configuration file itself.
        </p>
      </div>
    )
  }

  /**
   * The networks allowed to reach SSH on one cloud (issue #304).
   *
   * A hand-written control rather than the generic `stringList` fallback, because this list is
   * the one setting on the page where REMOVING an entry is itself a request to change a firewall:
   * the operator is not editing a preference, they are ending SSH from a network. The generic
   * renderer says "this page has no editor for a setting of this shape", which was the honest
   * answer while nothing pushed the value anywhere and is the wrong one now.
   *
   * ONE function taking a cloud, not three blocks. Every provider that maintains a whitelist gets
   * the same control, for the same reason the field inventory drives the rest of the page.
   *
   * Two rules are enforced here rather than left to the save to reject:
   * - the LAST entry cannot be removed, because an empty list means SSH reachable from nowhere
   *   and the operator almost certainly meant to add the replacement first;
   * - `0.0.0.0/0` is confirmed before it is added, and then needs `allowAllCidr` as well — the
   *   two-act guard the providers have always had, which until now had no control on this page
   *   at all, so the one procedure the docs describe could not be carried out here.
   */
  function cidrListField(cloud: string, label: string): ReactNode {
    const path = ['providers', cloud, 'sshAllowedCidr']
    const key = path.join('.')
    const spec = specs.get(key)
    if (!spec) return null

    const savedRaw = valueAt(values, path) ?? valueAt(defaults, path)
    // Tolerates the pre-#304 scalar in an operator's file: one CIDR is a list of one.
    const saved = savedRaw === undefined ? [] : Array.isArray(savedRaw) ? (savedRaw as string[]) : [String(savedRaw)]
    const pending = (edits[key]?.value as string[] | undefined) ?? saved
    const draft = cidrDrafts[key] ?? ''
    const setList = (next: string[]) => setEdit(path, { path, value: next })

    function addDraft() {
      const value = draft.trim()
      if (value === '' || pending.includes(value)) return
      const commit = () => {
        setList([...pending, value])
        setCidrDrafts((drafts) => ({ ...drafts, [key]: '' }))
      }
      if (value === '0.0.0.0/0') {
        setPendingRemoval({
          title: 'Open SSH to the whole internet?',
          label: value,
          message:
            '0.0.0.0/0 means every address on the internet may reach SSH on every box this cloud ' +
            'creates. These boxes run agent-authored code and hold your git token. You will also ' +
            'have to tick "Allow all CIDR" below before this can be saved.',
          confirmLabel: 'Add 0.0.0.0/0',
          confirm: commit,
        })
        return
      }
      commit()
    }

    const lastOne = pending.length === 1

    return (
      <div className="form-group" data-field={key}>
        <fieldset aria-describedby={helpId(key, key)}>
          <legend>{label}</legend>
          {helpFor(key, key)}
          {pending.length === 0 ? (
            <p className="hint">
              None set. SSH would be unreachable from anywhere — add the network you connect from.
            </p>
          ) : (
            <ul className="settings-cidr-list">
              {pending.map((cidr) => (
                <li key={cidr}>
                  <code>{cidr}</code>
                  <button
                    type="button"
                    className="link-button"
                    disabled={lastOne}
                    title={
                      lastOne
                        ? 'SSH would be unreachable from anywhere — add the replacement first.'
                        : undefined
                    }
                    onClick={() =>
                      setPendingRemoval({
                        title: 'Remove this network?',
                        label: cidr,
                        message:
                          `Removing ${cidr} immediately ends new SSH connections from that ` +
                          'network; existing sessions survive. It is pushed to the cloud when you save.',
                        confirm: () => setList(pending.filter((entry) => entry !== cidr)),
                      })
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="settings-cidr-add">
            <input
              type="text"
              aria-label={`Add a network for ${cloud}`}
              placeholder="203.0.113.7/32"
              value={draft}
              onChange={(e) => setCidrDrafts((drafts) => ({ ...drafts, [key]: e.target.value }))}
            />
            <button type="button" onClick={addDraft} disabled={draft.trim() === ''}>
              Add
            </button>
          </div>
        </fieldset>
        {spec.warning && <p className="hint settings-warning">{spec.warning}</p>}
        {fieldErrors[key] && <p className="error">{fieldErrors[key]}</p>}
        {/*
          The second act, shown only once the dangerous value is actually in the list — a
          permanent checkbox offering to open SSH to the internet is an invitation, and this is
          not one. It is an ordinary boolean field, so its help and warning come from core.
        */}
        {pending.includes('0.0.0.0/0') && boolField(['providers', cloud, 'allowAllCidr'], 'Allow all CIDR')}
      </div>
    )
  }

  /**
   * Push the whitelist at the clouds, and keep what each of them said (issue #304).
   *
   * Shared by the save and by the button beneath it, because they are the same errand arriving
   * from two directions. The BUTTON is not redundant: the save only pushes what the save
   * changed, and the state this issue was reported from is a cloud that drifted while the config
   * file stayed exactly as it was — a GCP firewall rule whose `sourceRanges` were frozen at
   * create time and have ignored the setting ever since. Nothing in a save would fix that,
   * because nothing about it is a change.
   */
  async function pushSshAccess(failurePrefix = 'Could not push the SSH rule'): Promise<void> {
    setPushing(true)
    setSyncReports(null)
    try {
      const { synced } = await syncSshAccess()
      setSyncReports(synced)
      const failed = synced.filter((report) => report.status === 'failed')
      if (failed.length > 0) {
        toast.error(`Could not update SSH access on ${failed.map((report) => report.provider).join(', ')}.`)
      } else if (synced.some((report) => report.status === 'updated')) {
        toast.success('SSH access updated at the cloud.')
      } else if (synced.length > 0) {
        toast.success('The clouds already allowed exactly these networks.')
      }
    } catch (err) {
      toast.error(`${failurePrefix}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setPushing(false)
    }
  }

  /* -------------------------------------------------------------- the unified token list */

  const rawTokens = (valueAt(values, ['github', 'tokens']) as RawTokenEntry[] | undefined) ?? []
  const tokenEntries = unifiedTokens(values)
  const fallbackIsSet = tokenEntries[0]!.secret.state !== 'unset'
  /** Add and Remove renumber or clear; they wait for this list's own edits to settle. */
  const tokenListBusy = tokenEdits.length > 0 ? 'Save or discard your changes to these tokens first' : undefined

  /** Everything keyed at or inside one entry — including keys the card has no box for. */
  function entryMessages(source: Record<string, string>, prefix: string): { key: string; message: string }[] {
    return Object.entries(source)
      .filter(([key]) => key === prefix || key.startsWith(`${prefix}.`))
      .map(([key, message]) => ({ key, message }))
  }

  /** Every save error whose path falls inside one entry. */
  const entryErrors = (prefix: string) => entryMessages(fieldErrors, prefix)
  /** Every unset-variable warning inside one entry — the saved-but-not-startable state. */
  const entryWarnings = (prefix: string) => entryMessages(warnings, prefix)

  /** The changes one entry's pending edits amount to, in the file's own paths. */
  function entryChanges(entry: TokenEntry): SettingsChange[] {
    const patKey = tokenKey(entry.target, 'pat')
    const patEdit = edits[patKey]

    if (entry.target.kind === 'fallback') {
      return patEdit ? [{ path: ['github', 'pat'], value: patEdit.value }] : []
    }

    const { index } = entry.target
    const scopeEdit = edits[tokenKey(entry.target, 'scope')]
    const hostEdit = edits[tokenKey(entry.target, 'host')]
    const out: SettingsChange[] = []
    if (scopeEdit) out.push(...scopeChanges(index, String(scopeEdit.value ?? ''), rawTokens[index] ?? {}))
    if (hostEdit) {
      const typed = String(hostEdit.value ?? '').trim()
      out.push(
        typed === ''
          ? { path: ['github', 'tokens', index, 'host'], unset: true }
          : { path: ['github', 'tokens', index, 'host'], value: typed },
      )
    }
    if (patEdit) out.push({ path: ['github', 'tokens', index, 'pat'], value: patEdit.value })
    return out
  }

  /**
   * A scope or host box.
   *
   * Recorded only when what is typed DIFFERS from what the file says, so an entry whose text was
   * typed back to where it started is not dirty and its Save button says so. It also means an
   * entry nobody touched is never rewritten — which matters for a `repo:` the schema rejects,
   * where re-writing it as an `owner:` would change what the operator meant rather than fix it.
   */
  function scopeBox(
    entry: TokenEntry,
    field: 'scope' | 'host',
    label: string,
    placeholder: string,
  ): ReactNode {
    const key = tokenKey(entry.target, field)
    const specPath = tokenSpecPath(entry.target, field)
    const current = entry[field]
    const edit = edits[key]
    const shown = edit ? String(edit.value ?? '') : current

    return (
      <div className="form-group" data-field={key} key={key}>
        <label htmlFor={key}>{label}</label>
        {helpFor(specPath, key)}
        <input
          id={key}
          type="text"
          spellCheck={false}
          autoComplete="off"
          value={shown}
          placeholder={placeholder}
          aria-describedby={helpId(specPath, key)}
          onChange={(e) => {
            const raw = e.target.value
            setEdit(key.split('.'), raw === current ? null : { path: key.split('.'), value: raw })
          }}
        />
      </div>
    )
  }

  function tokenCard(entry: TokenEntry): ReactNode {
    const isFallback = entry.target.kind === 'fallback'
    const cardId = isFallback ? 'fallback' : String((entry.target as { index: number }).index)
    const patKey = tokenKey(entry.target, 'pat')
    const patSpec = tokenSpecPath(entry.target, 'pat')
    const patPath = patKey.split('.')
    // Token-shaped, because these boxes take tokens now — a variable name here would be an
    // instruction the box no longer follows.
    const { input, state, refusal } = secretInput(patPath, patSpec, isFallback ? 'ghp_…' : 'github_pat_…')
    const scopeEdit = edits[tokenKey(entry.target, 'scope')]
    const hostEdit = edits[tokenKey(entry.target, 'host')]
    const heading = describeScope(
      scopeEdit ? String(scopeEdit.value ?? '') : entry.scope,
      hostEdit ? String(hostEdit.value ?? '') : entry.host,
      entry.target,
    )
    const changes = entryChanges(entry)
    const entryPrefix = isFallback ? 'github.pat' : `github.tokens.${cardId}`
    const errors = entryErrors(entryPrefix)
    const unset = entryWarnings(entryPrefix)
    // A removal renumbers the entries after it, so it waits for the list's other edits. The
    // fallback renumbers nothing and waits only for its own.
    const removeBlocked = isFallback
      ? changes.length > 0
        ? 'Save or discard the change to this token first'
        : undefined
      : tokenListBusy

    return (
      <div className="settings-entry" data-token={cardId} key={cardId}>
        <h3>{heading}</h3>
        {isFallback ? (
          <>
            <p className="field-help">
              The entry with no scope. Every clone that no entry below matches uses this token.
            </p>
            {/*
              TWO CATCH-ALLS CAN BOTH EXIST, and only one of them is used. The stored token wins
              (`bootstrap/server-secrets.ts`), so the page says which — this is rockysurf-0rw3's
              open question answered as "warn, do not refuse". `configFallbackSet` comes from the
              connection route precisely so this needs no guessing.
            */}
            {connection?.connected && connection.configFallbackSet && (
              <p className="warning settings-field-warning" data-fallback-superseded>
                You are connected as @{connection.login ?? 'your GitHub account'}, and a connected
                account takes precedence over this entry. Boxes you create use that token, not this
                one.
              </p>
            )}
          </>
        ) : (
          <>
            {scopeBox(entry, 'scope', 'Repository or account', 'acme/widgets')}
            {scopeBox(entry, 'host', 'Host', 'github.com')}
          </>
        )}

        <div className="form-group" data-field={patKey}>
          <label htmlFor={patKey}>Token</label>
          {helpFor(patSpec, patKey)}
          {input}
          {refusalLine(patKey, refusal)}
          <p className="hint">
            {secretStateHint(state, acceptsLiteral(patSpec))}
            Leave this blank to keep it as it is.
          </p>
        </div>

        {/* No `role="status"`: the banner at the top is the live region, and one announcement
            of the same news is enough. This is the copy that sits where the fix happens. */}
        {unset.map((warning) => (
          <p className="warning settings-field-warning" key={warning.key}>
            {warning.message}
          </p>
        ))}

        {errors.map((error) => (
          <p className="error settings-field-error" key={error.key}>
            {error.key}: {error.message}
          </p>
        ))}

        <div className="settings-entry-actions">
          <button
            type="button"
            className="btn-primary"
            disabled={changes.length === 0 || saving}
            onClick={() =>
              void submit(
                changes,
                (['scope', 'host', 'pat'] as const).map((field) => tokenKey(entry.target, field)),
              )
            }
          >
            Save this token
          </button>
          {(state.state !== 'unset' || !isFallback) && (
            <button
              type="button"
              className="destructive"
              disabled={Boolean(removeBlocked) || saving}
              title={removeBlocked}
              onClick={() =>
                setPendingRemoval({
                  label: heading,
                  change: isFallback
                    ? { path: ['github', 'pat'], unset: true }
                    : { path: ['github', 'tokens', (entry.target as { index: number }).index], unset: true },
                  message: isFallback
                    ? 'The instance-wide token will be removed from the configuration file. Clones that no ' +
                      'scoped entry matches will then be attempted with no token at all, which is fine for ' +
                      'public repositories and fails for private ones.'
                    : undefined,
                })
              }
            >
              {isFallback ? 'Remove this token' : 'Remove this entry'}
            </button>
          )}
        </div>
      </div>
    )
  }

  function draftCard(): ReactNode {
    if (!draft) return null
    const set = (patch: Partial<TokenDraft>) => {
      setDraftError(null)
      setDraft({ ...draft, ...patch })
    }
    /**
     * WHERE A REJECTED ADD LANDS (rockysurf-1z5q, third finding).
     *
     * The draft is not an entry yet, so it has no index of its own — the Add button writes it at
     * the end of the list, and the server answers about `github.tokens.<length>`. Nothing here
     * used to read that, so a 400 about the entry being added rendered nowhere near it: the
     * summary went to the form-level line at the TOP of a long page, and the card the operator
     * was looking at said nothing at all. Same lookup the saved cards use, same prefix the Add
     * button will send.
     */
    const draftPrefix = draft.scope.trim() === '' && draft.host.trim() === '' ? 'github.pat' : `github.tokens.${rawTokens.length}`
    const draftErrors = entryErrors(draftPrefix)
    // The same live refusal the existing cards give — which, now that both GitHub PAT paths take
    // a pasted token, fires for neither of them. It is kept rather than deleted because the
    // draft's destination is decided by what is typed above it, and a future scoped field that
    // still wants a variable name would need it back.
    const draftRefusal =
      !acceptsLiteral(draftPrefix === 'github.pat' ? 'github.pat' : 'github.tokens.*.pat') &&
      draft.pat.trim() !== '' &&
      envVarReference(draft.pat) === null
        ? ENV_VAR_ONLY
        : null
    // The draft's box is masked for the same reason a saved card's is, so it takes a form owner
    // on the same terms — recorded here because this box is built by hand rather than by
    // `secretInput`.
    const draftIsMasked = acceptsLiteral('github.tokens.*.pat')
    const draftOwner = draftIsMasked ? passwordFormOwner('github.tokens.new.pat') : undefined
    if (draftOwner) passwordFormOwners.push(draftOwner)

    const box = (field: 'scope' | 'host', label: string, placeholder: string, specPath: string) => {
      const id = `github.tokens.new.${field === 'scope' ? 'repo' : 'host'}`
      return (
        <div className="form-group" data-field={id}>
          <label htmlFor={id}>{label}</label>
          {helpFor(specPath, id)}
          <input
            id={id}
            type="text"
            spellCheck={false}
            autoComplete="off"
            value={draft[field]}
            placeholder={placeholder}
            aria-describedby={helpId(specPath, id)}
            onChange={(e) => set({ [field]: e.target.value } as Partial<TokenDraft>)}
          />
        </div>
      )
    }

    return (
      <div className="settings-entry" data-token="new">
        <h3>{describeScope(draft.scope, draft.host, { kind: 'scoped', index: -1 })}</h3>
        {box('scope', 'Repository or account', 'acme/widgets', 'github.tokens.*.repo')}
        {box('host', 'Host', 'github.com', 'github.tokens.*.host')}
        <div className="form-group" data-field="github.tokens.new.pat">
          <label htmlFor="github.tokens.new.pat">Token</label>
          {helpFor('github.tokens.*.pat', 'github.tokens.new.pat')}
          <input
            id="github.tokens.new.pat"
            type={draftIsMasked ? 'password' : 'text'}
            spellCheck={false}
            // The same two rules the saved cards' boxes follow: `off` rather than a hint that
            // invites a browser to file a forge token as a password for this site, and a form
            // owner of its own while the box is masked (see `passwordFormOwners`).
            autoComplete="off"
            {...(draftOwner ? { form: draftOwner } : {})}
            value={draft.pat}
            placeholder="github_pat_…"
            aria-describedby={helpId('github.tokens.*.pat', 'github.tokens.new.pat')}
            onChange={(e) => set({ pat: e.target.value })}
          />
          {refusalLine('github.tokens.new.pat', draftRefusal)}
        </div>
        {draftError && <p className="error settings-field-error">{draftError}</p>}
        {draftErrors.map((error) => (
          <p className="error settings-field-error" key={error.key}>
            {error.key}: {error.message}
          </p>
        ))}
        <div className="settings-entry-actions">
          <button
            type="button"
            className="btn-primary"
            disabled={saving}
            onClick={() => {
              // The two refusals a draft has of its own. What is IN the token box is not one of
              // them: `asReferences` normalises it and refuses a literal on the way out, the same
              // as for every other credential box, and the box is already showing why.
              const refusal = refuseNewEntry(draft.scope, draft.host, draft.pat, fallbackIsSet)
              if (refusal) return setDraftError(refusal)
              // No scope and no host is the fallback, which is one key rather than a list entry.
              const unscoped = draft.scope.trim() === '' && draft.host.trim() === ''
              const change: SettingsChange = unscoped
                ? { path: ['github', 'pat'], value: draft.pat }
                : {
                    path: ['github', 'tokens', rawTokens.length],
                    value: newScopedEntry(draft.scope, draft.host, draft.pat),
                  }
              // Nothing pending is cleared: a draft carries its own state and borrows no edits.
              void submit([change], []).then((ok) => {
                if (ok) setDraft(null)
              })
            }}
          >
            Add this token
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setDraft(null)
              setDraftError(null)
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  /* -------------------------------------------------------------------------- the lists */

  function listSection(
    path: string[],
    fields: ListField[],
    itemLabel: (entry: Record<string, unknown>, index: number) => string,
    /** Absent means this list is not added to here — its entries still render. */
    blank: Record<string, unknown> | undefined,
    empty: string,
    /** The item field a card is titled by — also the one a new entry must not collide on. */
    labelField?: string,
  ): ReactNode {
    const entries = (valueAt(values, path) as Record<string, unknown>[] | undefined) ?? []
    const prefix = `${path.join('.')}.`

    /**
     * REMOVING renumbers; APPENDING does not — so only Remove waits for a clean list.
     *
     * The interlock used to cover both, and its reason only ever applied to one of them: an
     * index is how an entry is named, so combining "remove entry 1" with "change entry 2's
     * name" would apply the second edit to whichever entry slid into that slot. Appending at
     * the END moves nothing, and a pending edit to entry 0 means exactly what it did before.
     *
     * Disabling Add was not merely unnecessary, it was the whole failure people hit: having
     * typed into a brand-new entry, the obvious button to press is the one directly under it,
     * and it was greyed out telling them to "save or discard your other changes" — while the
     * button that actually saves sits in the page footer. The instruction described the fix for
     * a problem they did not have, and it read as a refusal to save what they had just typed.
     */
    const listDirty = Object.keys(edits).some((key) => key.startsWith(prefix))
    const blockedRemove = listDirty
      ? 'Save or discard your changes to this list first — removing an entry renumbers the rest'
      : undefined

    /**
     * A NEW ENTRY MUST NOT COLLIDE WITH ONE THAT IS ALREADY THERE.
     *
     * `blank` is a constant, and the schemas behind these lists require the label to be unique
     * — `ssh.keys` ("two saved SSH keys share a name"), `registry.sources`, and the BYO hosts.
     * So pressing Add twice sent the same name twice and core refused the SECOND one, every
     * time, forever: a list you could never get a second entry into, which for a list of your
     * SSH keys is the entire point of it. Numbering the new one is what a person would have
     * done by hand.
     */
    const uniqueBlank = (): Record<string, unknown> | undefined => {
      if (!blank) return undefined
      const field = labelField ?? fields[0]?.name
      if (!field) return blank
      const proposed = blank[field]
      if (typeof proposed !== 'string') return blank
      const taken = new Set(entries.map((entry) => String(entry[field] ?? '')))
      if (!taken.has(proposed)) return blank
      let n = 2
      while (taken.has(`${proposed} ${n}`)) n += 1
      return { ...blank, [field]: `${proposed} ${n}` }
    }

    // The section wrapper and the header belong to the panel that draws this list, so a list is
    // a section's CONTENTS here — the same shape every other block below has.
    return (
      <>
        {entries.length === 0 && <p className="hint">{empty}</p>}
        {entries.map((entry, index) => {
          /*
            THE HEADING FOLLOWS THE BOX, not the file (issue #302 follow-up).

            `entry` is the SAVED value, so a card you had just renamed kept its old title while
            the Name box under it showed the new one — the page contradicting itself about which
            entry you were looking at, which is exactly how it looked to somebody who could not
            tell whether their typing had registered at all.
          */
          const live = { ...entry }
          for (const f of fields) {
            const pending = edits[keyOf([...path, index, f.name])]
            if (pending && !pending.unset && typeof pending.value === 'string') live[f.name] = pending.value
          }
          return (
            <div className="settings-entry" key={index}>
              <h3>{itemLabel(live, index)}</h3>
              {fields.map((f) =>
                f.secret
                  ? secretField([...path, index, f.name], f.label, f.example ?? 'A_VARIABLE_NAME')
                  : textField([...path, index, f.name], f.label, f.name === 'port' ? 'number' : 'text'),
              )}
              <button
                type="button"
                className="destructive"
                disabled={Boolean(blockedRemove) || saving}
                title={blockedRemove}
                onClick={() =>
                  setPendingRemoval({
                    label: itemLabel(live, index),
                    change: { path: [...path, index], unset: true },
                  })
                }
              >
                Remove
              </button>
            </div>
          )
        })}
        {blank && (
          <button
            type="button"
            className="btn-secondary"
            disabled={saving}
            onClick={() => void submit([{ path: [...path, entries.length], value: uniqueBlank() }], [])}
          >
            Add
          </button>
        )}
      </>
    )
  }

  /**
   * ANY LIST CORE DECLARES, DRAWN WITHOUT A HAND-WRITTEN BLOCK FOR IT.
   *
   * This is `humanize`'s doctrine (see its comment) applied to lists instead of fields, and it
   * exists because the absence of it shipped a broken page. `ssh.keys` (issue #302) was added to
   * core's inventory and to `SETTINGS_LISTS`, and the page drew its two section headers — those
   * come down the wire — and no controls at all, because the only thing that has ever produced
   * a list here is a hand-written entry keyed by section id. The operator got two boxes of prose
   * and no way to add a key.
   *
   * `view.lists` was already being served and simply never read. Now it is: core says which
   * paths are lists, what an entry is made of, what a new one looks like and what to say when
   * there are none, and the page renders that. A hand-written block still wins where one exists
   * — the token list's bespoke flow, the nicer labels on hosts and pack sources — so this is a
   * floor under the page rather than a replacement for it.
   *
   * The labels are `humanize`d field names, which is honestly worse than hand-written ones and
   * enormously better than nothing.
   */
  function genericList(id: string): ReactNode | undefined {
    /*
     * A list is drawn on the section that IS its path (`ssh.keys`), or — when core declared no
     * section for it — on the nearest section that owns it (`notifications.targets` on a
     * `notifications` tab). Without the second case a list one level below its section renders
     * nowhere, which is the same silence this function exists to end.
     */
    const mine = [...lists.values()].filter((list) =>
      allSections.includes(list.path) ? list.path === id : sectionOf(list.path, allSections) === id,
    )
    if (mine.length === 0) return undefined
    return mine.map((list) => <Fragment key={list.path}>{oneList(list)}</Fragment>)
  }

  function oneList(list: SettingsList): ReactNode {
    const id = list.path
    const fields: ListField[] = list.itemFields.map((name) => {
      const spec = specs.get(`${id}.*.${name}`)
      return {
        name,
        label: humanize(name),
        ...(spec?.kind === 'secret' ? { secret: true } : {}),
      }
    })
    const labelField = list.labelField ?? list.itemFields[0]!
    const noun = sections.get(id)?.title ?? humanize(id.split('.').pop() ?? id)

    return listSection(
      id.split('.'),
      fields,
      (entry, index) => String(entry[labelField] || `${noun} ${index + 1}`),
      list.blank,
      list.empty,
      labelField,
    )
  }

  /* ---------------------------------------------------------------------------- render */

  /**
   * A section's title and what the whole section is for, both from the server's inventory.
   *
   * A title is fabricated from the id only for a section that does not exist in the inventory —
   * the synthetic home of a field whose path no `SectionSpec` claims. Everything else is core's
   * words, which is what keeps the file, the docs and this page saying the same thing.
   */
  function sectionHeader(id: string): ReactNode {
    const section = sections.get(id)
    return (
      <header className="settings-section-header" data-section={id}>
        <h2>{section?.title ?? humanize(id.split('.').pop() ?? id)}</h2>
        {section?.help && <p className="field-help">{section.help}</p>}
      </header>
    )
  }

  const scopes = ((valueAt(values, ['mcp', 'scopes']) ?? valueAt(defaults, ['mcp', 'scopes'])) as string[]) ?? []
  const pendingScopes = (edits['mcp.scopes']?.value as string[] | undefined) ?? scopes
  const spendCap = valueAt(values, ['limits', 'spendCap']) as { amount?: number; currency?: string } | undefined
  const capEdit = edits['limits.spendCap']
  const capOn = capEdit ? capEdit.unset !== true : spendCap !== undefined

  /** Issues about the file that no rendered field claims — the page still has to report them. */
  const unplacedIssues = (view.issues ?? []).filter((i) => !specs.has(patternOf(i.path.split('.'))))

  /* ------------------------------------------------------- what each section actually holds */

  // The two controls that go through neither `wrap` nor `secretInput` — a checkbox over a whole
  // block, and a fieldset of four boxes — so they enter the ledger by hand rather than being
  // drawn twice, once here and once as a leftover.
  draw('limits.spendCap')
  draw('mcp.scopes')

  /**
   * The SSH whitelist and its second act, for every cloud that has one (issue #304).
   *
   * Both halves enter the ledger by hand, and `allowAllCidr` does so even when it is not on
   * screen. That is the `group` doctrine applied to a pair that is not a `group`: the CIDR list
   * OWNS the checkbox, and a block written and removed whole must not have its hidden half
   * reappear at the bottom of the tab as a leftover — which is a permanent, unexplained offer to
   * open SSH to the internet, sitting away from the list that gives it its meaning.
   */
  for (const cloud of ['aws', 'azure', 'gcp']) {
    draw(`providers.${cloud}.sshAllowedCidr`)
    draw(`providers.${cloud}.allowAllCidr`)
  }

  /**
   * THE HAND-WRITTEN BLOCKS, keyed by the section id core gave them.
   *
   * Contents only: the card, its heading and its place among the tabs are the panel's job below,
   * which is what lets a section core adds render in exactly the same frame as these without a
   * line here. A key with no entry is not a hole — it is a section drawn from the inventory.
   */
  const handWritten: Record<string, ReactNode> = {
    server: (
      <>
        {textField(['server', 'port'], 'Port', 'number')}
        {textField(['server', 'host'], 'Listen address')}
        {textField(['server', 'publicUrl'], 'Public URL')}
        {readOnlyField(['server', 'dataDir'], 'Data directory')}
      </>
    ),

    /*
      ONE LIST, TWO SHAPES IN THE FILE. Each entry saves on its own — every card's button is its
      own PUT — because a list where one Save button covers additions, removals and edits has to
      guess what an index meant by the time it is applied. See `lib/githubTokens.ts`.
    */
    github: (
      <>
        {/*
          FIRST IN THE SECTION, because it is the catch-all and everything below it is the
          exceptions. Its token goes to the encrypted store, which core reads live at
          server-create; since issue #264 the pasted PATs below are live too, read from the file
          per box, so nothing in this section waits for a restart any more.
        */}
        <ConnectGitHubCard
          connection={connection}
          onChanged={loadConnection}
          onDisconnect={() =>
            setPendingRemoval({
              title: 'Disconnect this GitHub account?',
              label: `@${connection?.login ?? 'this account'}`,
              confirmLabel: 'Disconnect',
              message: DISCONNECT_CONFIRMATION,
              confirm: async () => {
                try {
                  await disconnectGithub()
                  await loadConnection()
                  toast.success('Rocky Surf has forgotten this GitHub token')
                } catch {
                  setFormError('Could not disconnect the GitHub account.')
                }
              },
            })
          }
        />
        {/*
          The client ID the card above is disabled without. It renders here, in the same
          section, because that is what makes the card's instruction actionable without
          leaving the browser — and it is an ordinary text box rather than a credential box
          because a device-flow client ID is public.

          It goes to the config file rather than the store — and since issue #264 that is no
          longer a restart: the routes behind the button read the client id per request, so
          pasting one here enables the card above immediately.
        */}
        {textField(['github', 'oauth', 'clientId'], 'OAuth App client ID')}
        {tokenEntries.map(tokenCard)}
        {draftCard()}
        {!draft && (
          <button
            type="button"
            className="btn-secondary"
            disabled={Boolean(tokenListBusy) || saving}
            title={tokenListBusy}
            onClick={() => {
              setDraftError(null)
              setDraft({ scope: '', host: '', pat: '' })
            }}
          >
            Add a token
          </button>
        )}
      </>
    ),

    'providers.hetzner': (
      <>
        {boolField(['providers', 'hetzner', 'enabled'], 'Enabled')}
        {/*
          THE SAME POLICY AS THE TOKEN LIST, and the same label. It is the same kind of thing —
          a provider credential in a file that gets backed up — so a second rule here would be a
          second rule for no reason. (rockysurf-4o3o, directive 3.)
        */}
        {secretField(['providers', 'hetzner', 'token'], 'Token Environment Variable', 'HETZNER_TOKEN')}
        {textField(['providers', 'hetzner', 'location'], 'Location')}
        {textField(['providers', 'hetzner', 'consoleProjectId'], 'Console project id', 'number')}
      </>
    ),

    'providers.aws': (
      <>
        {boolField(['providers', 'aws', 'enabled'], 'Enabled')}
        {textField(['providers', 'aws', 'region'], 'Region')}
        {textField(['providers', 'aws', 'profile'], 'Profile')}
        {cidrListField('aws', 'SSH allowed from')}
        {readOnlyField(['providers', 'aws', 'sizes'], 'Offered instance types')}
      </>
    ),

    'providers.azure': (
      <>
        {boolField(['providers', 'azure', 'enabled'], 'Enabled')}
        {/*
          No credential field, and that is the point. Azure credentials come from the
          environment, a managed identity or `az login` — there is nowhere in the config file
          to put a client secret, so there is no box here inviting someone to paste one.
        */}
        {textField(['providers', 'azure', 'subscriptionId'], 'Subscription id')}
        {textField(['providers', 'azure', 'resourceGroup'], 'Resource group')}
        {textField(['providers', 'azure', 'location'], 'Location')}
        {cidrListField('azure', 'SSH allowed from')}
        {readOnlyField(['providers', 'azure', 'sizes'], 'Offered VM sizes')}
      </>
    ),

    'providers.gcp': (
      <>
        {boolField(['providers', 'gcp', 'enabled'], 'Enabled')}
        {/*
          No credential field here either, for the same reason as Azure. GCP credentials come
          from Application Default Credentials — the same chain `gcloud` uses — and the config
          file has no field that can hold key material, so there is no box inviting a paste.
        */}
        {textField(['providers', 'gcp', 'projectId'], 'Project id')}
        {textField(['providers', 'gcp', 'zone'], 'Zone')}
        {cidrListField('gcp', 'SSH allowed from')}
        {readOnlyField(['providers', 'gcp', 'sizes'], 'Offered machine types')}
      </>
    ),

    'providers.byo': (
      <>
        {boolField(['providers', 'byo', 'enabled'], 'Enabled')}
        {textField(['providers', 'byo', 'identityFile'], 'Default private key path')}
      </>
    ),

    /*
      `ssh.keys` (issue #302) is DELIBERATELY ABSENT from this record. It is drawn by
      `genericList` from what core declares, which is the whole point of that function existing:
      the hand-written entry this replaced was the only reason the section worked, and a section
      whose editor lives here is a section that silently renders as prose the moment core ships
      ahead of the SPA. Leaving one list to the generic path means the generic path is exercised
      by the product rather than only by a test.
    */

    /* Nested under `providers.byo`, so it is a second card on that tab rather than a tab of its
       own: enabling the provider and satisfying its one requirement are the same errand. */
    'providers.byo.hosts': listSection(
      ['providers', 'byo', 'hosts'],
      [
        { name: 'name', label: 'Name' },
        { name: 'host', label: 'Address' },
        { name: 'user', label: 'Admin login' },
        { name: 'port', label: 'SSH port' },
        { name: 'fingerprint', label: 'Host key fingerprint' },
        { name: 'identityFile', label: 'Private key path' },
      ],
      (entry, i) => String(entry['name'] || `host ${i + 1}`),
      { name: 'change-me', host: '10.0.0.1' },
      'None yet. Enabling this provider requires at least one host.',
      'name',
    ),

    limits: (
      <>
        {textField(['limits', 'maxServers'], 'Most servers at once', 'number')}
        {textField(['limits', 'createRatePerHour'], 'Most created per hour', 'number')}

        <div className="form-group" data-field="limits.spendCap">
          <label htmlFor="limits.spendCap">Stop creating servers over a spend cap</label>
          {helpFor('limits.spendCap', 'limits.spendCap')}
          <input
            id="limits.spendCap"
            type="checkbox"
            aria-describedby={helpId('limits.spendCap', 'limits.spendCap')}
            checked={capOn}
            onChange={(e) =>
              setEdit(
                ['limits', 'spendCap'],
                e.target.checked
                  ? {
                      path: ['limits', 'spendCap'],
                      // Written whole: half a cap is not a smaller cap, it is a file that
                      // will not load.
                      value: { amount: spendCap?.amount ?? 50, currency: spendCap?.currency ?? 'USD' },
                    }
                  : { path: ['limits', 'spendCap'], unset: true },
              )
            }
          />
          {fieldErrors['limits.spendCap'] && <p className="error">{fieldErrors['limits.spendCap']}</p>}
        </div>
        {/*
          Two ways to edit the same two numbers, because there are two situations. A cap the
          file already has is edited field by field, like everything else. A cap being turned
          on does not exist yet, so its fields edit the pending block — otherwise enabling a
          cap would take two saves, the first of which writes a figure nobody chose.
        */}
        {capOn && spendCap !== undefined && (
          <>
            {textField(['limits', 'spendCap', 'amount'], 'Cap', 'number')}
            {textField(['limits', 'spendCap', 'currency'], 'Currency')}
          </>
        )}
        {capOn && spendCap === undefined && capEdit?.value !== undefined && (
          <>
            {newCapField('amount', 'Cap', 'number')}
            {newCapField('currency', 'Currency', 'text')}
          </>
        )}
      </>
    ),

    /**
     * WHERE PACKS MAY COME FROM (issue #88).
     *
     * The list was config-file-only until now, and a person who wanted their own pack on their
     * own instance had to ssh in and edit YAML to get it. This is the same act done in the same
     * place — an admin-only page that writes that file — and it writes nothing else: saving a
     * source records a URL. Nothing is fetched here, nothing is installed here, and the scripts
     * behind that URL are still only ever run after somebody has read them in Surge Packs.
     */
    registry: (
      <>
        {boolField(['registry', 'enabled'], 'Browse pack sources')}
        {textField(['registry', 'cacheTtlSeconds'], 'Reuse a listing for (seconds)', 'number')}
      </>
    ),

    /* A card on the Pack sources tab rather than a tab of its own: switching the shop on and
       saying what it points at are one errand, exactly as with the BYO hosts above. */
    'registry.sources': listSection(
      ['registry', 'sources'],
      [
        { name: 'name', label: 'Name' },
        { name: 'url', label: 'URL' },
        { name: 'trust', label: 'Your label for it' },
      ],
      (entry, i) => String(entry['name'] || `source ${i + 1}`),
      { name: 'my-packs', url: 'https://example.com/my-pack.yaml', trust: 'community' },
      "None yet. Add one to browse somebody else's packs — or your own, published as a single " +
        'YAML file at an https URL.',
      'name',
    ),

    mcp: (
      <div className="form-group" data-field="mcp.scopes">
        <fieldset aria-describedby={helpId('mcp.scopes', 'mcp.scopes')}>
          <legend>What an MCP client may do</legend>
          {helpFor('mcp.scopes', 'mcp.scopes')}
          {(['read', 'stop', 'create', 'terminate'] as const).map((scope) => (
            <label key={scope} className="settings-scope">
              <input
                type="checkbox"
                checked={pendingScopes.includes(scope)}
                onChange={(e) =>
                  setEdit(['mcp', 'scopes'], {
                    path: ['mcp', 'scopes'],
                    value: e.target.checked
                      ? [...pendingScopes, scope]
                      : pendingScopes.filter((s) => s !== scope),
                  })
                }
              />
              {scope}
            </label>
          ))}
        </fieldset>
        {specs.get('mcp.scopes')?.warning && (
          <p className="hint settings-warning">{specs.get('mcp.scopes')!.warning}</p>
        )}
        {fieldErrors['mcp.scopes'] && <p className="error">{fieldErrors['mcp.scopes']}</p>}
      </div>
    ),
  }

  /* ----------------------------------------------- the sections, the leftovers, and the tabs */

  /**
   * A group owns its halves, so they are not leftovers when it chose not to draw them.
   *
   * `limits.spendCap.amount` is absent from the page whenever the cap is off, and that is what a
   * `group` IS — a block written and removed whole. Only a group this page actually drew gets
   * that authority; a group core adds that nothing here knows about does not get to hide its own
   * fields, so its halves render as ordinary settings rather than as nothing at all.
   */
  const ownedByADrawnGroup = (path: string) =>
    view.fields.some((f) => f.kind === 'group' && drawn.has(f.path) && path.startsWith(`${f.path}.`))

  /**
   * Everything in the inventory that no block above drew — rule 2 at the top of this file.
   *
   * `*` paths are excluded because a list-item spec describes a shape rather than a setting:
   * `github.tokens.*.pat` is drawn once per entry by the list that owns it, or not at all when
   * the list is empty, and a control for the pattern itself would edit nothing.
   */
  const leftovers = view.fields.filter(
    (f) => !f.hidden && !f.path.includes('*') && !drawn.has(f.path) && !ownedByADrawnGroup(f.path),
  )

  /**
   * A home for a leftover whose path no `SectionSpec` claims: its first path segment, as a
   * section of its own.
   *
   * The honest answer to a field with nowhere to go. It is worse than a real section — the title
   * is invented and there is no sentence saying what the group is for — and it is much better
   * than a setting that exists, is writable, and cannot be seen. Giving the field a section in
   * `settings/fields.ts` replaces it with the real thing, here and in the docs at once.
   */
  const sectionIds = view.sections.map((section) => section.id)
  const strays = [
    ...new Set(
      leftovers.filter((f) => sectionOf(f.path, sectionIds) === undefined).map((f) => f.path.split('.')[0]!),
    ),
  ]
  const allSections = [...sectionIds, ...strays]
  const leftoversIn = (id: string) => leftovers.filter((f) => sectionOf(f.path, allSections) === id)

  /** One tab per outermost section, in the inventory's order, with its nested sections on it. */
  const tabIds = [...new Set(allSections.map((id) => tabOf(id, allSections)))]
  const cardsOn = (tab: string) => allSections.filter((id) => tabOf(id, allSections) === tab)
  const panelId = (tab: string) => `settings-panel-${tab}`

  /** The tab a dotted key's news belongs on, so a dot can be put over it. */
  const tabForKey = (key: string) => {
    const section = sectionOf(key, allSections)
    return section === undefined ? undefined : tabOf(section, allSections)
  }
  const tabsFor = (keys: string[]) =>
    new Set(keys.map(tabForKey).filter((tab): tab is string => tab !== undefined))
  /** Tabs holding something typed and not yet saved. */
  const unsavedTabs = tabsFor(Object.keys(edits))
  /** Tabs holding a field the server refused, or a field the file on disk gets wrong. */
  const troubledTabs = tabsFor([...Object.keys(fieldErrors), ...(view.issues ?? []).map((i) => i.path)])

  /**
   * WHICH TAB IS OPEN. The URL says, and a value naming nothing falls back to the first tab
   * rather than to a blank page — a link that has outlived the section it pointed at is a bad
   * link, not a broken settings page. A deep link to a NESTED section opens the tab that holds
   * it, so `?section=providers.byo.hosts` lands on Your own machines with the hosts in view.
   */
  const requested = searchParams.get(SECTION_PARAM)
  const active =
    (requested !== null && allSections.includes(requested) ? tabOf(requested, allSections) : undefined) ??
    tabIds[0] ??
    ''

  const tabs = tabIds.map((id) => {
    const marker = troubledTabs.has(id) ? 'error' : unsavedTabs.has(id) ? 'unsaved' : null
    return {
      key: id,
      controls: panelId(id),
      label: (
        <>
          {sections.get(id)?.title ?? humanize(id.split('.').pop() ?? id)}
          {/* The dot is decoration; the words beside it are what a screen reader reads, because
              a coloured circle is not a message. */}
          {marker && (
            <>
              <span className={`tab-marker ${marker}`} aria-hidden="true">
                ●
              </span>
              <span className="sr-only">
                {marker === 'error' ? ', has a rejected field' : ', has unsaved changes'}
              </span>
            </>
          )}
        </>
      ),
    }
  })

  return (
    <AppShell title="Settings" className="page settings">
      <p className="hint">
        These are the contents of <code>{view.file.path}</code>
        {view.file.exists ? '.' : ', which does not exist yet — saving creates it.'}
      </p>

      {/*
        Server-derived, so a reload does not lose it — and NARROW since issue #264. It used to
        appear after every save, because every save left the process behind; now a save is
        adopted, so this appears only when one of the few settings a running process cannot take
        on has been changed, and it names them rather than making the operator guess which.
      */}
      {view.drifted && (
        <p className="warning" role="status">
          Saved, and waiting on a restart:{' '}
          {view.pendingRestart.map((entry) => entry.path).join(', ')}. Everything else you have
          saved is already in use. <RestartHint segments={view.restartHintSegments} />
        </p>
      )}

      {/*
        THE RESTART BANNER, SHARPENED (rockysurf-1z5q). Above it says a restart is PENDING; this
        says the restart will FAIL. Saving a reference before the variable exists is the order
        this page asks for — the token boxes take a variable name, and nobody can export one into
        a running process — so the save went through and this is the other half of that bargain:
        the exact variable, and what has to happen before the next start. Server-derived like the
        drift banner, so it survives a reload and stays until the variable is exported.
      */}
      {unsetVars.length > 0 && (
        <p className="warning" data-unset-vars role="status">
          Saved. {unsetVars.join(', ')} {unsetVars.length === 1 ? 'is' : 'are'} not set in the
          environment this Rocky Surf was started from, so the configuration file is now ahead of
          it. Export {unsetVars.length === 1 ? 'it' : 'them'} before restarting — otherwise the
          next start will refuse, naming {unsetVars.length === 1 ? 'the same variable' : 'the same variables'}.
        </p>
      )}

      {view.issues && view.issues.length > 0 && (
        <p className="error">
          The configuration file on disk is not valid, and Rocky Surf will not start on it until
          that is fixed — here, or in the file itself.
        </p>
      )}
      {unplacedIssues.map((issue) => (
        <p className="error" key={issue.path}>
          {issue.path}: {issue.message}
        </p>
      ))}

      {formError && <p className="error">{formError}</p>}
      {/*
        What the push actually did, per cloud (issue #304) — kept on the page rather than left to
        a toast, because `detail` carries remediation (a gcloud or aws command) that an operator
        has to be able to read twice and copy.
      */}
      {syncReports && syncReports.length > 0 && (
        <div className="settings-sync-report">
          <h3>SSH access at the cloud</h3>
          <ul>
            {syncReports.map((report) => (
              <li key={report.provider} data-sync-provider={report.provider} data-sync-status={report.status}>
                <strong>{report.provider}</strong>: {report.status}
                {report.detail ? ` — ${report.detail}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {/*
          ONE FORM, ONE SAVE BUTTON, TEN PANELS. The tabs decide what is on screen and nothing
          else: every panel stays mounted, the edit map lives above all of them, and the footer
          below saves whatever is pending wherever it was typed. Switching tabs is therefore not
          a thing that can lose work — and the tab holding the unsaved work wears a dot, so the
          Save button never covers something the operator cannot see.
        */}
        <div className="settings-layout">
          <Tabs
            label="Settings sections"
            panelId="settings"
            className="settings-nav"
            tabs={tabs}
            active={active}
            onSelect={openSection}
          />
          <div className="settings-panels">
            {tabIds.map((tab) => (
              <div
                key={tab}
                className="settings-panel"
                role="tabpanel"
                id={panelId(tab)}
                aria-labelledby={`settings-tab-${tab}`}
                hidden={tab !== active}
              >
                {cardsOn(tab).map((id) => {
                  const contents = handWritten[id] ?? genericList(id)
                  const extras = leftoversIn(id).map((spec) => fallbackField(spec))
                  /*
                    A section whose children hold the controls draws none of its own, and that is
                    not the empty-card fault below — `ssh`, `preferences` and `registry` are
                    headings over the cards nested under them. Only a LEAF that draws nothing is
                    the state worth reporting.
                  */
                  const hasChildCards = cardsOn(tab).some((other) => other.startsWith(`${id}.`))
                  return (
                    <section key={id}>
                      {sectionHeader(id)}
                      {contents}
                      {extras}
                      {/*
                        A CARD THAT DRAWS NOTHING SAYS SO (issue #302 follow-up).

                        This is the state the ssh.keys bug was actually seen in: core sends a
                        section, the page has no block and no declared list for it, and every
                        field it covers is a `*` pattern excluded from the leftovers — so the
                        card rendered a heading, a paragraph of help describing an editor, and
                        no editor. Prose promising a control that is not there is worse than an
                        error, because nothing looks broken.

                        It cannot happen for a list core declares any more. It can still happen
                        when the app is older than the core serving it, which is exactly when an
                        operator needs to be told rather than left looking for a button.
                      */}
                      {!contents && extras.length === 0 && !hasChildCards && (
                        <p className="hint settings-warning">
                          This version of the Rocky Surf app has no editor for this section — it is newer than the
                          page. Edit it in {view.file.path} directly, or update Rocky Surf.
                        </p>
                      )}
                    </section>
                  )
                })}
              </div>
            ))}
          </div>
        </div>

        <footer className="settings-actions">
          <button type="submit" className="btn-primary" disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save to the file'}
          </button>
          <button type="button" className="btn-secondary" disabled={!anyDirty || saving} onClick={() => setEdits({})}>
            Discard changes
          </button>
          {/*
            The repair for a cloud that drifted without the file changing (issue #304) — which is
            the state GCP has been in for every installation, since its firewall rule only ever
            read `sshAllowedCidr` at create time.
          */}
          <button type="button" className="btn-secondary" disabled={pushing || saving} onClick={() => pushSshAccess()}>
            {pushing ? 'Pushing…' : 'Push SSH access to the clouds'}
          </button>
          {/*
            THE STANDING SENTENCE UNDER THE SAVE BUTTON (issue #264).

            It used to be the restart instruction, unconditionally — the page telling everyone,
            before they had even clicked, that nothing they were about to do would work yet. The
            standing fact is now the opposite one, and the restart instruction appears only when
            something is actually waiting for it.
          */}
          <p className="hint">
            Saving applies straight away. The few settings that need a restart say so under the
            box.{' '}
            {view.drifted && <RestartHint segments={view.restartHintSegments} />}
          </p>
        </footer>
      </form>

      {/*
        THE FORM OWNERS FOR THE MASKED BOXES ABOVE — see the note on `passwordFormOwners`.

        Rendered here, AFTER the config form and never inside it: a form inside a form is not a
        thing HTML has, and the whole point is that these own the token boxes instead of the
        config form owning them. Empty, and they stay empty — the box is where it always was and
        is associated with its owner by id, which is what the `form` attribute is for.

        Nothing submits: a token card saves through its own button, so Enter in one of these boxes
        now does nothing at all rather than submitting the config form it never belonged to.

        `.password-form-owner` and not the `hidden` attribute: this stylesheet sets
        `form { display: flex }`, an author rule that outranks the user agent's `[hidden]`, so a
        hidden form would still be laid out — as a flex item, collecting the panel's 1.25rem gap
        apiece.
      */}
      {passwordFormOwners.map((id) => (
        <form key={id} id={id} className="password-form-owner" onSubmit={(e) => e.preventDefault()} />
      ))}

      {pendingRemoval && (
        <ConfirmModal
          title={pendingRemoval.title ?? 'Remove this entry?'}
          message={
            pendingRemoval.message ??
            `${pendingRemoval.label} will be removed from the configuration file, along with any comment written above it. Everything else in the file is left alone.`
          }
          confirmLabel={pendingRemoval.confirmLabel ?? 'Remove'}
          isDestructive
          onCancel={() => setPendingRemoval(null)}
          onConfirm={() => {
            const { change, confirm } = pendingRemoval
            setPendingRemoval(null)
            if (confirm) return void confirm()
            if (change) void submit([change], [])
          }}
        />
      )}
    </AppShell>
  )
}
