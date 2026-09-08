import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import toast from 'react-hot-toast'
import { Link, useSearchParams } from 'react-router'
import { AppShell } from '../components/AppShell'
import { BackupRestoreCards } from '../components/BackupRestoreCards'
import { ConfirmModal } from '../components/ConfirmModal'
import { ConnectGitHubCard, DISCONNECT_CONFIRMATION } from '../components/ConnectGitHubCard'
import { ProviderFailure } from '../components/ProviderErrorNotice'
import {
  acceptsLiteral,
  asReferences,
  boolField as drawBoolField,
  cidrListField as drawCidrListField,
  genericField,
  helpFor as drawHelpFor,
  helpId as drawHelpId,
  humanize,
  keyOf,
  patternOf,
  readOnlyField as drawReadOnlyField,
  refusalLine,
  RestartNote,
  secretAt,
  secretField as drawSecretField,
  secretInput as drawSecretInput,
  secretStateHint,
  textField as drawTextField,
  valueAt,
  type Edits,
  type FieldsContext,
} from '../components/settingsFields'
import { Tabs } from '../components/Tabs'
import {
  ApiError,
  checkProviderCredentials,
  disconnectGithub,
  getGithubConnection,
  getSettings,
  listProviders,
  saveSettings,
  syncSshAccess,
  type CredentialCheckReport,
  type SshAccessSyncReport,
  type GithubConnection,
  type ProviderInfo,
  type SecretView,
  type SettingsChange,
  type SettingsField,
  type SettingsList,
  type SettingsListAdd,
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
import { SHOP_PROVIDERS_URL } from '../lib/links'

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
 *     order, and a section whose id is inside another one's (`registry.sources` inside
 *     `registry`) is a card on that tab rather than a tab of its own. Add a section to
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
 * each time state changes — and an input that remounts loses focus after every keystroke.
 * Calling them keeps the reconciler seeing one stable tree.
 * ──────────────────────────────────────────────────────────────────────────────────────
 *
 * ── AND WHERE THEY LIVE NOW: `components/settingsFields.tsx` (issue #474) ─────────────
 * The renderers moved out of this function and the closure they had over `edits`, `specs`,
 * `values` and `fieldErrors` became one explicit `FieldsContext`, built once per render below.
 * The reason is the setup wizard: its whole job is to SET a cloud UP rather than describe
 * setting it up, so it draws that cloud's Settings fields in place — and "the same fields, the
 * same labels, the same validation, the same save" is only true if it is the same code. They are
 * still called rather than mounted, for the reason directly above; nothing about what this page
 * renders changed.
 * ──────────────────────────────────────────────────────────────────────────────────────
 */

/** The query parameter carrying the open section, so a link and a reload both land on it. */
const SECTION_PARAM = 'section'

/**
 * The section a dotted path belongs to: the LONGEST section id that prefixes it.
 *
 * Longest, not first, because the sections nest — `registry.sources.0.name` is a source's field
 * and not a stray `registry` one, and a first-match rule would put every source field on the
 * wrong card the moment the two sections were listed in the wrong order.
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

/** An edit key belonging to the unified token list, which saves per entry rather than in bulk. */
const isTokenKey = (key: string) => key === 'github.pat' || key.startsWith('github.tokens.')

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
  /**
   * What the clouds said about the credentials this save just put in force (issue #450).
   *
   * ON THE PAGE, in the same block the SSH push reports into, and not in a toast: a rejected
   * credential's detail is the cloud's own paragraph — a REST path, its own code, sometimes a
   * command to run — and a toast that vanishes is not something an operator can read twice or
   * copy out of.
   */
  const [credentialReports, setCredentialReports] = useState<CredentialCheckReport[] | null>(null)
  const [verifying, setVerifying] = useState(false)
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
   * THE HALF-TYPED NEW ENTRY OF EACH GENERIC LIST, keyed by the list's path (rsui-9sc).
   *
   * A key present here IS the open form: Add puts an empty record in, Cancel and a successful
   * save take it out. Held as page state and never written half-formed — the owner's ruling on
   * this flow is that no entry exists in the file until the person typed it and asked for it,
   * which is also how the token list's own draft has always worked.
   */
  const [listDrafts, setListDrafts] = useState<Record<string, Record<string, string>>>({})
  /** The refusal under a list's form — a required box left empty, or a name already taken. */
  const [listDraftErrors, setListDraftErrors] = useState<Record<string, string>>({})
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
    const map = new Map<string, { title: string; help: string; advisories?: string[] }>()
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
    const { sent, refused } = asReferences(specs, changes)
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

      /**
       * AND THEN ASK THE CLOUD WHETHER THE CREDENTIALS WORK (issue #450).
       *
       * Same errand, same shape: core names the Providers this save switched on or changed, and
       * a second call proves them. NEVER BLOCKING and never able to fail the save — the file is
       * written and adopted by the time this runs, so a cloud that is down produces a row saying
       * so and nothing else. Core sends an empty list for a section that is switched off.
       */
      if (result.credentialCheckNeeded?.length) await verifyCredentials(result.credentialCheckNeeded)
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
   * Field patterns whose `warning` a list has already said once, at its own head (rsui-9sc).
   *
   * The private-key warning belongs to `ssh.keys.*.publicKey`, and rendering it under the
   * pattern meant rendering it under EVERY entry's box — the owner read the same paragraph
   * three times on one screen. A warning about a KIND of field is section-level news, so the
   * list states it once above its entries and the per-entry renderers skip it. Same lifetime
   * and same discipline as `drawn` above: filled while the sections are built, read in the
   * same pass, thrown away with the render.
   */
  const hoistedWarnings = new Set<string>()

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
   * WHAT THE CONTROLS NEED IN PLACE OF THIS FUNCTION'S SCOPE (issue #474).
   *
   * The renderers below used to be declared here, closing over `edits`, `specs`, `values` and the
   * rest. They now live in `components/settingsFields.tsx` because the setup wizard draws the same
   * fields — the same labels, the same validation, the same `PUT /api/v1/settings` — and a second
   * implementation of them would have been a second set of labels to drift and a second idea of
   * what a credential box accepts. The closure becomes this object; nothing else about them
   * changed, and they are still CALLED rather than mounted, for the focus reason at the top of
   * this file.
   */
  const fieldsContext: FieldsContext = {
    values,
    defaults,
    specs,
    edits,
    fieldErrors,
    warnings,
    setEdit,
    providers,
    cidrDrafts,
    setCidrDrafts,
    confirm: setPendingRemoval,
    draw,
    hoistedWarnings,
    passwordFormOwners,
  }

  /* The thin wrappers the blocks below call. One argument shorter at every call site, and the
     ledger, the drafts and the confirmation all reach the shared controls the same way. */
  const helpFor = (specPath: string, id: string): ReactNode => drawHelpFor(fieldsContext, specPath, id)
  const helpId = (specPath: string, id: string) => drawHelpId(fieldsContext, specPath, id)
  const textField = (
    path: (string | number)[],
    label: string,
    type: 'text' | 'number' = 'text',
    extra?: ReactNode,
  ): ReactNode => drawTextField(fieldsContext, path, label, type, extra)
  const boolField = (path: (string | number)[], label: string): ReactNode =>
    drawBoolField(fieldsContext, path, label)
  const readOnlyField = (path: (string | number)[], label: string): ReactNode =>
    drawReadOnlyField(fieldsContext, path, label)
  const secretField = (path: (string | number)[], label: string, example: string): ReactNode =>
    drawSecretField(fieldsContext, path, label, example)
  const secretInput = (path: (string | number)[], specPath: string, example: string) =>
    drawSecretInput(fieldsContext, path, specPath, example)
  const cidrListField = (cloud: string, label: string): ReactNode =>
    drawCidrListField(fieldsContext, cloud, label)
  /** True when this field's box takes a pasted token rather than a variable name. */
  const acceptsLiteralBox = (specPath: string) => acceptsLiteral(fieldsContext, specPath)
  /**
   * A control for a field the blocks below do not name — rule 2 at the top of this file.
   *
   * The same renderer the wizard draws a whole Provider panel with, which is not a coincidence:
   * since ADR-0027 a Provider's panel IS a list of inventory fields, and this page has had no
   * hand-written `providers.*` block since issue #370.
   */
  const fallbackField = (spec: SettingsField): ReactNode => genericField(fieldsContext, spec)

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
   * Push the whitelist at the clouds, and keep what each of them said (issue #304).
   *
   * Shared by the save and by the button beneath it, because they are the same errand arriving
   * from two directions. The BUTTON is not redundant: the save only pushes what the save
   * changed, and the state this issue was reported from is a cloud that drifted while the config
   * file stayed exactly as it was — a GCP firewall rule whose `sourceRanges` were frozen at
   * create time and have ignored the setting ever since. Nothing in a save would fix that,
   * because nothing about it is a change.
   */
  async function pushSshAccess(
    failurePrefix = 'Could not push the SSH rule',
    revoke?: Record<string, string[]>,
  ): Promise<void> {
    setPushing(true)
    setSyncReports(null)
    try {
      const { synced } = await syncSshAccess(revoke)
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

  /**
   * Prove the named Providers' credentials at their clouds, and keep what each of them said (#450).
   *
   * The counterpart of `pushSshAccess` above and deliberately its twin: one follow-up call after
   * a save, a per-Provider report kept on the page, and a failure here that changes nothing about
   * the save that has already succeeded. The check itself never blocks — by the time it runs the
   * file is written and this process has adopted it — so the worst case is a row saying the cloud
   * could not be reached.
   */
  async function verifyCredentials(ids: string[]): Promise<void> {
    setVerifying(true)
    setCredentialReports(null)
    try {
      const { checked } = await checkProviderCredentials(ids)
      setCredentialReports(checked)
    } catch (err) {
      /*
        The CHECK failed, not the save — so this is the one case that has no per-Provider row to
        put on the page, and it says which Providers went unverified rather than implying they
        were rejected.
      */
      toast.error(
        `Saved, but could not check ${ids.join(', ')} at the cloud: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      setVerifying(false)
    }
  }

  /**
   * KEEP an authorized-but-unlisted network by adding it to the list (issue #309, default action).
   *
   * The safe half of the keep-or-remove prompt: it adds the CIDR the cloud is still allowing to
   * `sshAllowedCidr` and saves that one change, which re-pushes and folds the extra back into the
   * list. Nothing is revoked, so this can never cut off a network the operator is sitting on.
   */
  async function keepExtraCidr(cloud: string, cidr: string): Promise<void> {
    const path = ['providers', cloud, 'sshAllowedCidr']
    const key = path.join('.')
    const savedRaw = valueAt(values, path) ?? valueAt(defaults, path)
    const saved = savedRaw === undefined ? [] : Array.isArray(savedRaw) ? (savedRaw as string[]) : [String(savedRaw)]
    const pending = (edits[key]?.value as string[] | undefined) ?? saved
    if (pending.includes(cidr)) return
    await submit([{ path, value: [...pending, cidr] }], [key])
  }

  /**
   * REMOVE an authorized-but-unlisted network — an itemized, confirmed revoke (issue #309).
   *
   * Never a silent side effect: it opens the one confirmation this page has, and only on the
   * operator's yes does it call the sync route with this CIDR in the `revoke` set. The provider
   * authorizes-before-revoke and removes it only if it can prove it created it; a range it cannot
   * prove comes back as a failure that names the manual command.
   */
  function confirmRemoveExtraCidr(cloud: string, cidr: string): void {
    setPendingRemoval({
      title: `Remove ${cidr} from ${cloud}?`,
      label: cidr,
      message:
        `${cidr} is authorized on ${cloud} but is not in your list. Removing it revokes the rule ` +
        'Rocky Surf created for it, ending new SSH connections from that network; existing ' +
        'sessions survive. Your list is reasserted first, so nothing you kept is affected.',
      confirmLabel: 'Remove from the cloud',
      confirm: () => pushSshAccess('Could not remove the network', { [cloud]: [cidr] }),
    })
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
            {secretStateHint(state, acceptsLiteralBox(patSpec))}
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
      !acceptsLiteralBox(draftPrefix === 'github.pat' ? 'github.pat' : 'github.tokens.*.pat') &&
      draft.pat.trim() !== '' &&
      envVarReference(draft.pat) === null
        ? ENV_VAR_ONLY
        : null
    // The draft's box is masked for the same reason a saved card's is, so it takes a form owner
    // on the same terms — recorded here because this box is built by hand rather than by
    // `secretInput`.
    const draftIsMasked = acceptsLiteralBox('github.tokens.*.pat')
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
    add: SettingsListAdd | undefined,
    empty: string,
    /** The item field a card is titled by — also the one a new entry must not collide on. */
    labelField?: string,
  ): ReactNode {
    const entries = (valueAt(values, path) as Record<string, unknown>[] | undefined) ?? []
    const listKey = path.join('.')
    const prefix = `${listKey}.`

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
     * The warnings this list's item fields carry, said ONCE at the head of the list (rsui-9sc).
     *
     * A `warning` on `ssh.keys.*.publicKey` is a warning about every key box that will ever be
     * drawn here, and drawing it under each of them told the owner the same thing under every
     * card. Recording the pattern in `hoistedWarnings` is what stops the per-entry renderers
     * repeating it; the sentence itself is core's, unchanged.
     */
    const listWarnings = fields.flatMap((f) => {
      const pattern = `${listKey}.*.${f.name}`
      const warning = specs.get(pattern)?.warning
      if (!warning) return []
      hoistedWarnings.add(pattern)
      return [{ pattern, warning }]
    })

    /**
     * THE BLANK FORM AN Add CLICK REVEALS — and the whole add flow (rsui-9sc).
     *
     * What it replaces: Add used to WRITE a placeholder entry to the config file on the spot —
     * `{ name: 'my-laptop', publicKey: '' }` — so a first visit after one click showed what
     * looked like a saved key nobody had saved, and every further click minted `my-laptop 2`,
     * a card with a Remove button interlocked into the bargain. The owner's ruling: a button
     * that says what it adds, a form with NO default name that asks for the fields, and an
     * entry that exists only once it is typed and saved. The token list's draft card has
     * always worked this way; this is the same convention for every generic list.
     *
     * Nothing here goes through `edits`: the draft is not an entry and has no index, so a
     * half-typed form cannot dirty the list, block Remove, or be carried off by the footer
     * Save. Its one save is its own button, appending at `entries.length` — and a refusal from
     * the server lands back on this form's own boxes, because that is the index the server
     * answers about.
     */
    const draftValues = add ? listDrafts[listKey] : undefined
    const draftId = (name: string) => `${listKey}.new.${name}`
    const draftPrefix = `${listKey}.${entries.length}`
    const closeDraft = () => {
      setListDrafts((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== listKey)))
      setListDraftErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== listKey)))
    }

    function addDraftEntry(add: SettingsListAdd, draftValues: Record<string, string>): void {
      const refuse = (message: string) => setListDraftErrors((prev) => ({ ...prev, [listKey]: message }))
      const typed = (name: string) => (draftValues[name] ?? '').trim()

      const missing = fields.find((f) => add.required.includes(f.name) && typed(f.name) === '')
      if (missing) return refuse(`A new ${add.noun} needs the ${missing.label.toLowerCase()} filled in first.`)

      // The schemas behind these lists require the label to be unique — core would refuse the
      // save — but the server's sentence arrives keyed to the whole list, and the person is
      // looking at this form. Same check, said where they are, before anything is sent.
      const title = labelField ? typed(labelField) : ''
      if (labelField && entries.some((entry) => String(entry[labelField] ?? '') === title)) {
        return refuse(`There is already a ${add.noun} called “${title}” — give this one a different name.`)
      }

      // Only what was typed is written. A box left empty says nothing, so an optional field is
      // absent from the file and a schema default (a host's port, a source's trust) applies —
      // the entry a person would have written by hand.
      const value: Record<string, unknown> = {}
      for (const f of fields) {
        const raw = typed(f.name)
        if (raw === '') continue
        const asNumber = Number(raw)
        value[f.name] = f.name === 'port' && Number.isFinite(asNumber) ? asNumber : raw
      }
      void submit([{ path: [...path, entries.length], value }], []).then((ok) => {
        if (ok) closeDraft()
      })
    }

    function draftForm(add: SettingsListAdd, draftValues: Record<string, string>): ReactNode {
      return (
        <div className="settings-entry" data-list-draft={listKey}>
          <h3>New {add.noun}</h3>
          {fields.map((f) => {
            const id = draftId(f.name)
            const specPath = `${listKey}.*.${f.name}`
            const placeholder = String(add.example[f.name] ?? '')
            /* The server answers about the slot this form is writing to — `entries.length` —
               so its refusal of a box renders under that box, not at the top of the page. */
            const serverError = fieldErrors[`${draftPrefix}.${f.name}`]
            return (
              <div className="form-group" data-field={id} key={id}>
                <label htmlFor={id}>{f.label}</label>
                {helpFor(specPath, id)}
                <input
                  id={id}
                  type={f.name === 'port' ? 'number' : 'text'}
                  spellCheck={false}
                  autoComplete="off"
                  value={draftValues[f.name] ?? ''}
                  placeholder={placeholder}
                  aria-describedby={helpId(specPath, id)}
                  onChange={(e) => {
                    setListDraftErrors((prev) =>
                      Object.fromEntries(Object.entries(prev).filter(([k]) => k !== listKey)),
                    )
                    setListDrafts((prev) => ({
                      ...prev,
                      [listKey]: { ...draftValues, [f.name]: e.target.value },
                    }))
                  }}
                />
                {serverError && <p className="error settings-field-error">{serverError}</p>}
              </div>
            )
          })}
          {listDraftErrors[listKey] && (
            <p className="error settings-field-error" data-draft-refusal={listKey}>
              {listDraftErrors[listKey]}
            </p>
          )}
          {/* A refusal of the entry as a whole — or of a box this form does not draw. */}
          {Object.entries(fieldErrors)
            .filter(
              ([key]) =>
                (key === draftPrefix || key.startsWith(`${draftPrefix}.`)) &&
                !fields.some((f) => key === `${draftPrefix}.${f.name}`),
            )
            .map(([key, message]) => (
              <p className="error settings-field-error" key={key}>
                {message}
              </p>
            ))}
          <div className="settings-entry-actions">
            <button type="button" className="btn-primary" disabled={saving} onClick={() => addDraftEntry(add, draftValues)}>
              Add this {add.noun}
            </button>
            <button type="button" className="btn-secondary" onClick={closeDraft}>
              Cancel
            </button>
          </div>
        </div>
      )
    }

    // The section wrapper and the header belong to the panel that draws this list, so a list is
    // a section's CONTENTS here — the same shape every other block below has.
    return (
      <>
        {listWarnings.map(({ pattern, warning }) => (
          <p className="hint settings-warning" data-list-warning={pattern} key={pattern}>
            {warning}
          </p>
        ))}
        {entries.length === 0 && !draftValues && <p className="hint">{empty}</p>}
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
        {add && draftValues && draftForm(add, draftValues)}
        {/*
          CYAN, LIKE EVERY BUTTON THAT CREATES SOMETHING NEW — "New Server", "New Surge Pack",
          and now this. `btn-primary` for the base skin, `new-action` so the etched skin colours
          it as a create rather than a start; the pairing is #183's convention, stated at the
          `.new-action` rule in etched.css.
        */}
        {add && !draftValues && (
          <button
            type="button"
            className="btn-primary new-action"
            disabled={saving}
            onClick={() => setListDrafts((prev) => ({ ...prev, [listKey]: {} }))}
          >
            Add {add.noun}
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
   * — the token list's bespoke flow — so this is a floor under the page rather than a
   * replacement for it.
   *
   * SINCE ISSUE #370 IT IS ALSO THE CEILING for a provider's lists. The last hand-written one
   * went with the provider that declared it, and the labels a declaration carries are not lost:
   * `oneList` reads a label off the field's spec when the inventory carries one, and falls back
   * to `humanize` when it does not, which is honestly worse than a written label and enormously
   * better than nothing.
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
        // The label the inventory carries when it has one — a provider that DECLARED this list
        // wrote "Admin login" and "Host key fingerprint", and humanizing the key would put "User"
        // and "Fingerprint" over boxes whose own sentences say otherwise (ADR-0027).
        label: spec?.label ?? humanize(name),
        ...(spec?.kind === 'secret' ? { secret: true } : {}),
      }
    })
    const labelField = list.labelField ?? list.itemFields[0]!
    const noun = sections.get(id)?.title ?? humanize(id.split('.').pop() ?? id)

    return listSection(
      id.split('.'),
      fields,
      (entry, index) => String(entry[labelField] || `${noun} ${index + 1}`),
      list.add,
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
        {/* What the PROVIDER wrote for the operator (ADR-0027) — quirks worth knowing before the
            controls below, never something this page computes with. */}
        {section?.advisories?.map((text) => (
          <p key={text} className="hint settings-advisory" data-advisory={id}>
            {text}
          </p>
        ))}
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
   * THE HAND-WRITTEN BLOCKS, keyed by the section id core gave them.
   *
   * Contents only: the card, its heading and its place among the tabs are the panel's job below,
   * which is what lets a section core adds render in exactly the same frame as these without a
   * line here. A key with no entry is not a hole — it is a section drawn from the inventory.
   */
  /**
   * How many GitHub tokens sit in the file as LITERALS ('set' covers a mixed value too, the
   * `view.ts` line). The Backup card's disclosure is exact — "these N will not be included" —
   * because the backup redacts exactly these (issue #331), and a vague "may include tokens"
   * would be the warning-shaped reassurance the PR rules ban.
   */
  const literalTokenCount =
    (secretAt(view.values, ['github', 'pat']).state === 'set' ? 1 : 0) +
    ((valueAt(view.values, ['github', 'tokens']) as unknown[] | undefined) ?? []).filter(
      (_, index) => secretAt(view.values, ['github', 'tokens', index, 'pat']).state === 'set',
    ).length

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
      BACKUP AND RESTORE (issue #331): the one section whose id is not a config path, so no
      field will ever land on it — the two cards are the whole tab. A restore can change the
      configuration file AND the database, so its callback reloads everything this page holds.
    */
    backup: (
      <BackupRestoreCards
        literalTokenCount={literalTokenCount}
        onRestored={() => {
          void load()
          void loadConnection()
          void loadProviders()
        }}
      />
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
          /* Cyan like every other button that creates something new (rsui-9sc) — this card flow
             was already the convention the generic lists now follow, so it wears the colour too. */
          <button
            type="button"
            className="btn-primary new-action"
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

    /*
      NO `providers.*` ENTRIES AT ALL (ADR-0027, completed by issue #370). Every provider panel —
      Hetzner's token box, the three clouds' CIDR control, a provider's own list card — arrives from the
      factory's declared settings with its own labels, placeholders and sentences, and the generic
      renderer below draws it. The blocks that used to be here were the D4 gap: a cloud not in this
      file had no panel, and a cloud not in this repository could never be added to it.

      `ssh.keys` (issue #302) is absent for the same reason and was absent first: a section whose
      editor lives here is a section that silently renders as prose the moment core ships ahead of
      the SPA. What is left in this record is the sections that are genuinely bespoke — a device
      flow, a token card, a spend cap written whole.
    */

    limits: (
      <>
        {textField(['limits', 'maxServers'], 'Most Servers at once', 'number')}
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
       saying what it points at are one errand. */
    'registry.sources': listSection(
      ['registry', 'sources'],
      [
        { name: 'name', label: 'Name' },
        { name: 'url', label: 'URL' },
        { name: 'trust', label: 'Your label for it' },
      ],
      (entry, i) => String(entry['name'] || `source ${i + 1}`),
      lists.get('registry.sources')?.add,
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
  /**
   * The SSH whitelist and its second act, for every cloud that has one (issue #304) — DERIVED
   * from the inventory rather than from a list of cloud names (ADR-0027), so a provider that
   * declares one, personal or shipped, gets the same treatment with no edit here.
   *
   * `allowAllCidr` enters the ledger even though nothing above draws it, and that is the whole
   * point of this loop. It is the `group` doctrine applied to a pair that is not a `group`: the
   * CIDR list OWNS the checkbox, and the control that draws them both must not have its hidden
   * half reappear at the bottom of the tab as a leftover — a permanent, unexplained offer to open
   * SSH to the internet, sitting away from the list that gives it its meaning. The list itself is
   * NOT marked drawn: `fallbackField` draws it, as the leftover it now always is.
   */
  for (const field of view.fields) {
    const cloud = /^providers\.([^.]+)\.sshAllowedCidr$/.exec(field.path)?.[1]
    if (!cloud) continue
    draw(`providers.${cloud}.allowAllCidr`)
  }

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
   * it, so `?section=registry.sources` lands on Pack sources with the sources in view.
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
      {(verifying || (credentialReports && credentialReports.length > 0) || (syncReports && syncReports.length > 0)) && (
        <div className="settings-sync-report">
          {/*
            WHAT THE CLOUD SAID ABOUT THE CREDENTIALS THIS SAVE PUT IN FORCE (issue #450).

            In the block the SSH push already reports into rather than in a second one: they are
            two halves of one answer to "did that save work?", they arrive by the same mechanism
            (core names the clouds, the page makes one follow-up call), and a second status area
            would mean an operator has two places to look after one click.
          */}
          {(verifying || (credentialReports && credentialReports.length > 0)) && (
            <>
              <h3>Credentials at the cloud</h3>
              {verifying && (
                <p className="hint" data-credentials-checking>
                  Checking…
                </p>
              )}
              {credentialReports && credentialReports.length > 0 && (
                <ul>
                  {credentialReports.map((report) => (
                    <li
                      key={report.provider}
                      data-credential-provider={report.provider}
                      data-credential-status={report.status}
                    >
                      <strong>{report.displayName}</strong>:{' '}
                      {report.status === 'verified' ? (
                        'Credentials and region verified'
                      ) : (
                        /*
                          THE PROVIDER'S OWN ERROR, VERBATIM, in the component the New Server page
                          uses for the same failure — so a rejected key reads the same whichever
                          page the operator was standing on when the cloud rejected it.
                        */
                        <ProviderFailure
                          {...(report.code ? { code: report.code } : {})}
                          {...(report.providerCode ? { providerCode: report.providerCode } : {})}
                          detail={report.detail}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {syncReports && syncReports.length > 0 && (
            <>
          <h3>SSH access at the cloud</h3>
          <ul>
            {syncReports.map((report) => (
              <li key={report.provider} data-sync-provider={report.provider} data-sync-status={report.status}>
                <strong>{report.provider}</strong>: {report.status}
                {report.detail ? ` — ${report.detail}` : ''}
                {/*
                  THE KEEP-OR-REMOVE PROMPT (issue #309). A cloud reports as `removable` the
                  networks it is still allowing that Rocky Surf can prove it created but the list no
                  longer names — the pre-#308 accumulation on the first push, and thereafter the one
                  CIDR a removal produces. Each is offered keep (adds it back to the list) or remove
                  (a confirmed revoke). DEFAULT KEEP: doing nothing leaves them authorized, because
                  one may be the network the operator is reading this from.
                */}
                {report.removable && report.removable.length > 0 && (
                  <div className="settings-sync-adopt" data-sync-removable={report.provider}>
                    <p>
                      These networks are authorized on {report.provider} but not in your list. Keep one to add
                      it back, or remove it from the cloud:
                    </p>
                    <ul>
                      {report.removable.map((cidr) => (
                        <li key={cidr} data-removable-cidr={cidr}>
                          <code>{cidr}</code>
                          <button
                            type="button"
                            className="link-button"
                            disabled={pushing || saving}
                            onClick={() => void keepExtraCidr(report.provider, cidr)}
                          >
                            Keep in list
                          </button>
                          <button
                            type="button"
                            className="link-button"
                            disabled={pushing || saving}
                            onClick={() => confirmRemoveExtraCidr(report.provider, cidr)}
                          >
                            Remove from {report.provider}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            ))}
          </ul>
            </>
          )}
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
                {/*
                  WHERE A PROVIDER ROCKY SURF DID NOT SHIP COMES FROM (issue #394, then #426,
                  both amending ADR-0028). Providers are not on the Surge Packs page and are
                  configured HERE, on their own tab, once they load — that half of #394 stands.
                  What #426 changed is where one is installed from: the Rocky Surf Shop tab in
                  the app, or the command-line steps in the shop's providers section. The pointer
                  is on every provider tab rather than once at the top of the page, since the
                  other tabs are core's own sections and have nothing to do with it.
                */}
                {tab.startsWith('providers.') && (
                  <p className="hint" data-provider-shop-pointer>
                    Providers Rocky Surf does not ship are installed from the{' '}
                    <Link to="/shop">Rocky Surf Shop</Link> tab, or from the command line — the{' '}
                    <a href={SHOP_PROVIDERS_URL} target="_blank" rel="noreferrer">
                      providers section of the Rocky Surf Shop
                    </a>{' '}
                    has the packages and the steps — and are configured here once they load.
                  </p>
                )}
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
