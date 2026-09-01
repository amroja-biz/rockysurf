import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { useNavigate, useSearchParams } from 'react-router'
import { Link } from 'react-router'
import {
  ApiError,
  createServer,
  getSetupState,
  listConfiguredScopes,
  listProviders,
  listSshKeys,
  listSurgePacks,
  resolveRepositories,
  getSettings,
  saveSettings,
  type ConfiguredScope,
  type CreateServerRequest,
  type Offering,
  type ProviderInfo,
  type ProviderSetupState,
  type RepositoryResolution,
  type SavedSshKey,
  type SurgePack,
} from '../lib/api'
import {
  archLabel,
  availableArchitectures,
  formatHourly,
  formatMonthly,
  formatPricesAsOf,
  resolveSize,
  SIZE_REQUIREMENTS,
  SIZES,
  type Architecture,
  type ServerSize,
  type SizeResolution,
} from '../lib/requirements'
import { parseEnvironment, SECRET_LINE_PREFIX } from '../lib/environment'
import { repoDocUrl } from '../lib/links'
import { useAuth } from '../contexts/AuthContext'
import { AppShell } from '../components/AppShell'
// Extracted for issue #212, so the Settings page's saved types are chosen from the same
// catalogue in the same way rather than typed from memory into a free-text box.
import { MachineTypePicker } from '../components/MachineTypePicker'
import { PackIcon } from '../components/PackIcon'
import { ProviderErrorNotice } from '../components/ProviderErrorNotice'
import { ProvisioningFeed } from '../components/ProvisioningFeed'
import { Tabs } from '../components/Tabs'

/**
 * Create a server.
 *
 * Ported from the legacy SPA's create-server page, minus three things that no longer
 * exist and one that was never right:
 *
 *  - the **billing gate** — self-hosted, so the operator pays their own cloud bill;
 *  - the **spot radio** — spot is cut from v0.1 (an interrupted box with an agent mid-task
 *    undercuts the whole point of a persistent dev box);
 *  - the **GitHub App repo picker** — v0.1 has no GitHub App, so repositories are a free-text
 *    list;
 *  - the **`open-claw` hardcode**. The old page decided which fields to show by comparing the
 *    selected pack id against a literal: `requiresRdp = selectedPackId === 'open-claw'`. Packs
 *    now declare `requiresRepos` and `requiresRdp` themselves (ADR-0004), so a new pack gets
 *    the right form without anyone editing this file.
 *
 * The repositories field is on the form for EVERY pack (issue #178). `requiresRepos` used to
 * decide whether the field existed, which turned "this pack does not need a repository" into
 * "you cannot clone one onto this box" — a user who wants their project on an open-claw box had
 * no way to say so. Core never gated on the flag: it clones whatever `repositories` arrives and
 * exports `$REPOS` to every setup script. So the flag now has exactly one job, the one issue #90
 * gave it: when the pack expects a repository and the list is empty, ask before creating.
 *
 * The startup script field (issue #184) is on the form for every pack for the same reason and
 * is not conditional on anything at all: it is the user's own instructions to their own box,
 * core renders a plan step for whatever arrives, and an empty field sends nothing.
 *
 * The same rule applies to providers. Nothing here compares `provider.id` against a literal —
 * provider-specific controls are driven by `capabilities.*`, which is what lets one form serve
 * clouds that work very differently.
 *
 * ── CHOOSING THE CLOUD (rockysurf-va2l) ───────────────────────────────────────────────
 * With several providers loaded the user picks, and NOTHING is preselected: the plan card
 * below is a price, and a preselected cloud is a spend decision made by list order rather
 * than by a person. With exactly one there is no choice to offer, so the page states which
 * cloud it is rather than staying silent about it.
 *
 * The page also reports providers that are enabled in the config but did not load. That is
 * the bug the owner actually hit: a provider whose section its own schema rejected is dropped
 * at composition, leaving an installation that looks single-cloud with the explanation only in
 * the boot log. The reason travels here through `SetupState`, in the provider's own words.
 * ──────────────────────────────────────────────────────────────────────────────────────
 *
 * ── THE ORDER OF THE FORM (issue #245) ────────────────────────────────────────────────
 * The lower half of this form runs in the order the box boots, and it is an order, not a list:
 *
 *   Surge Pack → <pack> settings → Repositories → Environment → Startup script → SSH access
 *
 * Two rules produce it. **A pack's own questions sit under the pack** — the settings section and
 * the desktop password are asked by the thing chosen directly above them, so they are not
 * separated from it by three fields nobody's pack asked for. And **an input precedes the code
 * that reads it**: the startup script consumes the repositories and the environment, so it is
 * asked for last. The tell that the old order was wrong was in the copy — the script's own hint
 * had to say "put tokens in Environment BELOW", a forward reference to a field the reader had
 * not reached. Anything moved into this half must keep both rules; nothing here may point
 * forward at a field further down the page.
 * ──────────────────────────────────────────────────────────────────────────────────────
 */
/**
 * One repository's line in the live token display (rockysurf-18lq).
 *
 * FIVE STATES, and they are five because collapsing any pair of them loses something a user has
 * to act on differently:
 *
 *  - **a scoped token** — the good case, and it names the entry so the operator can tell that
 *    the token they meant is the token that will be used;
 *  - **the instance-wide fallback** — also fine, but a different promise: `github.pat` is the
 *    general credential and may well not have access to this repository;
 *  - **public** — reachable with no credential at all, which core can only claim because it
 *    asked the forge anonymously and got an answer;
 *  - **refused** — core's own sentence, which already names the URL and the causes;
 *  - **waiting on a restart** — the config file has an entry this process has not read yet
 *    (rockysurf-1z5q), which is NOT "no token" and must not be shown as one.
 *
 * NAMES, NEVER VALUES. Every string rendered here is a scope identity or an environment variable
 * name; core will not send anything else, and this component asks for nothing else.
 */
function RepositoryTokenLine({ resolution }: { resolution: RepositoryResolution | undefined }) {
  if (!resolution) return <span className="hint">checking…</span>

  const { live, pending } = resolution

  const token =
    live.kind === 'scoped' ? (
      <span className="repo-token">
        {live.envVar ? (
          <>
            <code>{live.envVar}</code>, the token scoped to <code>{live.scope}</code>
          </>
        ) : (
          <>
            the token scoped to <code>{live.scope}</code>
          </>
        )}
      </span>
    ) : live.kind === 'fallback' ? (
      <span className="repo-token">
        the instance-wide <code>github.pat</code>
        {live.envVar ? (
          <>
            {' '}
            (<code>{live.envVar}</code>)
          </>
        ) : null}
      </span>
    ) : null

  return (
    <>
      {resolution.reachable === 'ok' ? (
        token ? (
          <span className="repo-ok">opens with {token}</span>
        ) : (
          // No token was sent and it opened anyway. That is what public means, and it is the
          // one state the browser could never have worked out for itself.
          <span className="repo-ok">public repository — no token needed</span>
        )
      ) : (
        <span className="repo-refused">
          {resolution.reason}
          {resolution.code === 'no_matching_token' && (
            <>
              {' '}
              <Link to="/settings">Add one in Settings.</Link>
            </>
          )}
        </span>
      )}
      {/*
        The file says something this process has not read. Rendered as its own line rather than
        folded into the sentence above, because it is a different tense: the one above is what a
        box created NOW receives, and this is what has to happen for that to change.
      */}
      {pending && (
        <div className="repo-pending">
          {pending.kind === 'none' ? (
            <>The configuration file no longer covers this repository, so a restart would drop that token.</>
          ) : (
            <>
              The configuration file has a token for <code>{pending.scope ?? 'every other repository'}</code>
              {pending.envVar ? (
                <>
                  {' '}
                  (<code>{pending.envVar}</code>)
                </>
              ) : null}
              , but Rocky Surf has not restarted since it was added.
            </>
          )}
          {pending.envVar && pending.envVarSet === false && (
            <>
              {' '}
              <strong>
                <code>{pending.envVar}</code> is not set in the environment Rocky Surf was started from, so that
                restart will refuse to start.
              </strong>
            </>
          )}
        </div>
      )}
    </>
  )
}

/**
 * PICK THE REPOSITORIES THIS INSTALLATION ALREADY HAS TOKENS FOR (rockysurf-mh8f).
 *
 * The owner's observation, and it is the whole design: the Settings entries already NAME
 * repositories, so asking the operator to retype `https://github.com/acme/private-thing` into this
 * form is the system declining to use what it knows. A chip inserts the canonical URL, and because
 * the entry is configured, the live resolution line (rockysurf-18lq) beneath resolves it
 * immediately — a picked repository and a typed one are annotated by exactly the same code path,
 * because a pick is nothing but text arriving in the textarea.
 *
 * ── WHY ONLY ONE KIND OF ENTRY IS A BUTTON ────────────────────────────────────────────────
 * An entry naming `owner` AND `repo` names a clone URL, so it can be inserted whole. The other
 * three kinds do not:
 *
 *  - an ACCOUNT entry (`owner: acme`) names an account. Rocky Surf v0.1 has no GitHub App and so
 *    cannot list what is under one — this page's own header says the repository field is free text
 *    for exactly that reason. The rejected alternative was a chip inserting
 *    `https://github.com/acme/` for the user to finish: it puts a line in the box that is not a
 *    repository, which the live display then has to refuse, so the picker would manufacture the
 *    error state it exists to remove — and a half-line left behind by a click the user thought
 *    better of is a line they never typed and will be asked to explain at create.
 *  - a HOST entry is the same objection one level wider;
 *  - the FALLBACK names nothing at all.
 *
 * So those three are STATED — which is worth saying, because "anything under acme is covered" is
 * the reassurance this form otherwise withholds — and the typing is left to the person who knows
 * the repository's name.
 *
 * NOTHING HERE MATCHES ANYTHING. `kind`, `label` and `url` are all core's words; this component
 * chooses which of them is a button. The precedence rules stay where they are, and this screen
 * remains a consumer of them rather than a second opinion about them.
 */
function RepositoryPicker({
  scopes,
  present,
  onInsert,
}: {
  scopes: ConfiguredScope[]
  /** The repository lines in the box right now, so an entry already added reads as added. */
  present: readonly string[]
  onInsert: (url: string) => void
}) {
  const offered = scopes.filter((scope) => scope.kind === 'repository' && scope.url)
  const context = scopes.filter((scope) => scope.kind !== 'repository')

  /*
   * THE EMPTY STATE IS SILENCE, and it covers one case more than "no tokens at all": an
   * installation whose only credential is `github.pat` gets no picker either, because the hint
   * above this field already says that `github.pat` is what private repositories use, and a
   * second panel repeating it would be new chrome earning nothing. The picker appears exactly
   * when configuration names something more specific than "everything".
   */
  if (scopes.every((scope) => scope.kind === 'fallback')) return null

  const variable = (scope: ConfiguredScope) =>
    scope.envVar ? (
      <>
        {' '}
        (<code>{scope.envVar}</code>)
      </>
    ) : null

  // A token this process has not read yet is real and worth offering — it is what the operator
  // just saved in Settings — but it is not what a box created in the next minute would carry.
  const restart = (scope: ConfiguredScope) =>
    scope.state === 'pending' ? <span className="repo-chip-pending"> · after a restart</span> : null

  return (
    <div className="repo-picker" data-testid="repo-picker">
      {offered.length > 0 && (
        <>
          <p className="hint">Repositories this installation has a token for — click to add:</p>
          {/* Named in the SINGULAR, deliberately: "Configured repositories" would be a second
              element answering to the repositories field's own label, and a screen reader user
              asking for that field would get two answers. */}
          <div className="repo-chips" role="group" aria-label="Add a configured repository">
            {offered.map((scope) => {
              const added = present.includes(scope.url!)
              return (
                <button
                  key={scope.scope}
                  type="button"
                  className="repo-chip"
                  disabled={added}
                  title={added ? 'Already in the list below' : scope.url}
                  onClick={() => onInsert(scope.url!)}
                >
                  {scope.label}
                  {restart(scope)}
                  {added && <span className="repo-chip-added"> · added</span>}
                </button>
              )
            })}
          </div>
        </>
      )}
      {context.length > 0 && (
        <>
          {/* True of all three kinds below, and it is the reason none of them is a button.
              "Also" only when there was a first list — an installation configured entirely by
              account would otherwise open on a sentence referring back to nothing. */}
          <p className="hint">
            {offered.length > 0 ? 'Also configured' : 'Configured'}, but naming no single repository — type the
            repository&apos;s URL and it will be matched:
          </p>
          <ul className="repo-picker-context" data-testid="repo-picker-context">
            {context.map((scope) => (
              <li key={scope.scope}>
                {scope.kind === 'account' ? (
                  <>
                    <code>{scope.label}</code> — any repository under this account{variable(scope)}
                  </>
                ) : scope.kind === 'host' ? (
                  <>
                    <code>{scope.label}</code> — anything on this forge{variable(scope)}
                  </>
                ) : (
                  <>
                    Everything else — the instance-wide <code>github.pat</code>
                    {variable(scope)}
                  </>
                )}
                {restart(scope)}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/** Which tab a pack belongs on. Core's three words, grouped into this screen's two. */
type PackTab = 'official' | 'community'
const tabFor = (pack: SurgePack): PackTab => (pack.provenance === 'official' ? 'official' : 'community')

export function CreateServerPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  // Only for deciding whether to OFFER the "remember this" button: the config file is admin
  // territory, and the route enforces that regardless of what this page draws.
  const { user } = useAuth()

  /* ---------------------------------------------------------------- catalogue */
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [unloadable, setUnloadable] = useState<ProviderSetupState[]>([])
  const [packs, setPacks] = useState<SurgePack[]>([])
  /** What this installation has tokens for, offered as a picker below (rockysurf-mh8f). */
  const [scopes, setScopes] = useState<ConfiguredScope[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  /* ---------------------------------------------------------------- form */
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [providerId, setProviderId] = useState('')
  const [size, setSize] = useState<ServerSize>('small')
  const [arch, setArch] = useState<Architecture | undefined>(undefined)
  /**
   * A specific machine type picked by id, over a t-shirt size (rockysurf-kh3u). `null` means
   * the Size fieldset above is driving the request, exactly as before this bead. Set, it means
   * the opposite: the Size radios read as deselected, and submit sends `offeringId` and OMITS
   * `size` entirely — core derives `'custom'` for the row rather than reading it from the wire.
   */
  const [customOfferingId, setCustomOfferingId] = useState<string | null>(null)
  const [packId, setPackId] = useState('')
  /**
   * Which shelf of the picker is showing (rockysurf-jn71). NOT part of the request — it decides
   * what is on screen and nothing else, which is the whole point: switching it must never move
   * `packId`.
   */
  const [packTab, setPackTab] = useState<PackTab>('official')
  /**
   * Named by `?pack=<packId>` (rockysurf-4d8h) but not on offer — absent, or disabled, so the
   * public list never carried it. Stated rather than swallowed: silently landing on a
   * different pack is how somebody creates a box with the wrong software on it.
   */
  const [packNotice, setPackNotice] = useState<string | null>(null)
  const [repoInput, setRepoInput] = useState('')
  const [sshKeyOption, setSshKeyOption] = useState<'generate' | 'provide'>('generate')
  const [sshPublicKey, setSshPublicKey] = useState('')
  /**
   * The public keys saved in Settings (issue #302), and which one is chosen.
   *
   * ADVISORY, like the token scopes above: the paste box has never needed this list and still
   * does not, so a failed read costs the convenience and not the form.
   *
   * `savedKeyName` is `''` for "paste one instead", which is also what an installation with no
   * saved keys is permanently in — the picker does not render at all there, and the fieldset is
   * exactly what it was before this feature. The chosen key is resolved to its LINE at submit;
   * the name never goes on the wire, because core stores the key and not a reference to one,
   * and a name that outlived the key it pointed at would be a box authorized against nothing.
   */
  const [savedSshKeys, setSavedSshKeys] = useState<SavedSshKey[]>([])
  const [savedKeyName, setSavedKeyName] = useState('')
  const [rdpPassword, setRdpPassword] = useState('')
  const [rdpPasswordConfirm, setRdpPasswordConfirm] = useState('')
  /**
   * The user's own first-boot script and who runs it (issue #184).
   *
   * On the form for EVERY pack, on the same doctrine as the repositories field (issue #178):
   * the field is not something a pack grants: it is the user's own instructions to their own
   * box, and core renders the step for whatever arrives. `rocky` is the default because the
   * unprivileged account is the one whose home, PATH and toolchain the pack just built.
   */
  const [userScript, setUserScript] = useState('')
  const [userScriptRunAs, setUserScriptRunAs] = useState<'root' | 'rocky'>('rocky')
  /**
   * The user's OWN environment for this box (issue #197, ADR-0014).
   *
   * ONE TEXTAREA, kept as text rather than as parsed state, because the text IS the document:
   * it survives a paste, it is what a `secret:` marker is part of, and it is the same format
   * `rockysurf create --env-file` reads. Parsing on submit rather than on every keystroke means
   * a half-typed line is never an error message.
   *
   * On the form for every pack, like the startup script above and for the same reason: this is
   * the user's own configuration of their own box, and no pack grants or withholds it.
   */
  const [environmentText, setEnvironmentText] = useState('')
  /**
   * What the SELECTED PACK asks for, keyed by the environment variable name (issue #189).
   *
   * PACK METADATA DRIVES THE FIELDS, exactly as `requiresRdp` drives the password field: there
   * is no per-pack code here, and there must never be. A pack that declares an input gets a
   * field on this form the moment it is installed.
   *
   * Kept keyed by name rather than as a parallel array so that switching packs cannot leave a
   * value sitting under the wrong label — `packInputValues[input.name]` is either this pack's
   * answer or nothing. The effect below prefills declared defaults and drops answers for names
   * the newly-chosen pack does not ask for; keeping an answer under a name that is asked for by
   * BOTH packs is deliberate, because it is the same question.
   */
  const [packInputValues, setPackInputValues] = useState<Record<string, string>>({})

  /* ---------------------------------------------------------------- submission */
  const [submitting, setSubmitting] = useState(false)
  /**
   * Either a plain sentence core or this form already wrote for a human, or the `ApiError`
   * itself when the failure was a classified cloud provider error (issue #127) — kept whole,
   * rather than collapsed to its `.detail` string here, so `ProviderErrorNotice` below can read
   * `providerErrorCode` and `providerCode` off it and render a headline plus detail instead of
   * one raw dump.
   */
  const [submitError, setSubmitError] = useState<string | ApiError | null>(null)
  /**
   * Core's per-repository refusals, keyed by their position in `repositories` (rockysurf-k6xp).
   *
   * Kept separate from `submitError` because they are a different KIND of thing: the summary is
   * about the request, these are about specific lines the user typed, and a form that dumps
   * four URL failures into one banner makes the user diff two lists by eye.
   */
  const [repoErrors, setRepoErrors] = useState<string[]>([])
  /**
   * Offered only AFTER a refusal, never before. A checkbox that is always there invites
   * clicking past a check nobody has read; one that appears with the reason beside it is a
   * decision about that reason.
   */
  const [createAnyway, setCreateAnyway] = useState(false)
  /**
   * A repository is asked for, never demanded (issue #90). A `requiresRepos` pack still asks —
   * that is what the flag means — but an empty list refuses nothing: the first submit offers
   * this confirmation instead, on the `createAnyway` doctrine above (the checkbox appears with
   * its reason on screen, so ticking it is a decision about that reason). `offered` is the
   * submit having happened; `confirmed` is the user's answer.
   */
  const [withoutReposOffered, setWithoutReposOffered] = useState(false)
  const [createWithoutRepos, setCreateWithoutRepos] = useState(false)
  const [createdServerId, setCreatedServerId] = useState<string | null>(null)
  /**
   * Types remembered from this page since it loaded, by provider then size (issue #124).
   *
   * Local because `/providers` is fetched once; core has the authoritative copy the moment the
   * save returns, and this only keeps the page the save was made from in step with it.
   */
  const [savedTiers, setSavedTiers] = useState<Record<string, Partial<Record<ServerSize, string>>>>({})
  /** Which (size) button is mid-save, so it can be disabled and say so. */
  const [savingTier, setSavingTier] = useState<ServerSize | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [providerList, packList, setup, tokenScopes, savedKeys] = await Promise.all([
          listProviders(),
          listSurgePacks(),
          // Advisory only, so a failure here must not take the form down with it: the page's
          // job is creating a server, and it can still do that without the diagnosis of a
          // provider that is already missing.
          getSetupState().catch(() => null),
          // Also advisory, and for the same reason: the repository field is free text with or
          // without the picker, so a failed read costs a convenience and not the form.
          listConfiguredScopes().catch(() => []),
          // Advisory for the third time (issue #302): the saved-key picker is a shortcut past
          // the paste box, and the paste box works whether or not this read did.
          listSshKeys().catch(() => []),
        ])
        if (cancelled) return

        setProviders(providerList)
        setScopes(tokenScopes)
        setSavedSshKeys(savedKeys)
        // Preselected when there is exactly one, on the same rule the provider list above uses:
        // a menu with one item is not a choice. With several the person picks, because picking
        // the first would authorize a key they did not look at.
        if (savedKeys.length === 1) setSavedKeyName(savedKeys[0]!.name)
        setUnloadable((setup?.providers ?? []).filter((p) => p.enabled && !p.loaded))
        // Preselected ONLY when there is no choice to make. With several clouds loaded the
        // user picks one; the old `providerList[0]` was how a server silently landed on
        // whichever provider composition built first (rockysurf-va2l).
        if (providerList.length === 1) setProviderId(providerList[0]!.id)

        const enabled = packList.filter((p) => p.enabled).sort((a, b) => a.displayOrder - b.displayOrder)
        setPacks(enabled)
        // Arriving from a pack's "Launch a server with this pack" button (rockysurf-4d8h,
        // issue #51): a different STARTING pack, nothing else. The selection rule below —
        // lowest displayOrder wins absent a request — is otherwise untouched.
        const wantedPackId = searchParams.get('pack')
        const asked = wantedPackId ? enabled.find((p) => p.packId === wantedPackId) : undefined
        const preselected = asked ?? enabled[0]
        if (preselected) {
          setPackId(preselected.packId)
          // Open on whichever tab HOLDS the preselection, rather than on Official by rule. The
          // selection rule is untouched — lowest displayOrder, exactly as before — and this only
          // follows it, so an installation whose only enabled packs are contributed ones opens
          // on Community instead of on an Official shelf that does not contain the checked
          // radio (rockysurf-jn71).
          setPackTab(tabFor(preselected))
        }
        // Asked for but not available — absent from the catalogue, or disabled — and NOTHING
        // was silently substituted. The usual lowest-displayOrder pack still gets preselected
        // above; this only says so.
        if (wantedPackId && !asked) setPackNotice(wantedPackId)
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load options')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const provider = useMemo(() => providers.find((p) => p.id === providerId), [providers, providerId])
  const pack = useMemo(() => packs.find((p) => p.packId === packId), [packs, packId])

  /**
   * THE PUBLIC KEY THIS CREATE WILL AUTHORIZE — one value, whichever way it was supplied.
   *
   * The picker and the paste box are two ways to fill one field, not two fields, so everything
   * downstream (the validation below, the submit, core, the box) sees a single string and has
   * no idea which control produced it. That is what keeps a pasted key working exactly as it
   * did: nothing was inserted into its path.
   *
   * A saved name that no longer matches anything — the key was removed in Settings in another
   * tab while this form was open — resolves to `''` and is refused by the validation, rather
   * than silently falling back to the paste box's contents or to no key at all.
   */
  const chosenPublicKey = useMemo(() => {
    if (savedKeyName === '') return sshPublicKey.trim()
    return savedSshKeys.find((k) => k.name === savedKeyName)?.publicKey ?? ''
  }, [savedKeyName, savedSshKeys, sshPublicKey])

  /**
   * The two shelves (rockysurf-jn71). The same partition the admin Pack Shop already performs —
   * `official` on one side, everything else on the other — kept in the VIEW, where the naming
   * decision belongs, rather than pushed into core's vocabulary.
   */
  const shelved = useMemo(() => packs.filter((p) => tabFor(p) === packTab), [packs, packTab])

  const architectures = useMemo(() => availableArchitectures(provider?.offerings ?? []), [provider])

  // Resolve the t-shirt sizes to CONCRETE offerings, before submit, so the price shown is the
  // price of the machine that will actually be created. Computed even in custom mode — cheap,
  // and it means switching back to a size needs no re-derivation.
  //
  // EVERY size, not only the selected one (rockysurf-b1gr). The Size fieldset labels each option
  // with the machine it would land on, and three floors that all read "at least 2 vCPU" cannot be
  // compared without clicking through them one at a time. One resolver over one catalogue at one
  // arch, so a label and the plan card below can never quote different machines for the same size.
  /**
   * The saved types for THIS cloud (issue #124): whatever core sent, plus anything remembered
   * on this page since it loaded.
   *
   * The local half exists because the page does not re-fetch `/providers` after a save. Core
   * re-reads `preferences.tiers` from the file on every create, so a saved type is live for
   * every other surface immediately; this keeps the screen in front of the person who just
   * saved it honest too, rather than showing them the old default until they reload.
   */
  const tierPreferences = useMemo(
    () => ({ ...(provider?.tierPreferences ?? {}), ...(providerId ? (savedTiers[providerId] ?? {}) : {}) }),
    [provider, providerId, savedTiers],
  )

  /**
   * Every saved/preferred type id for this provider, across all three sizes (issue #153).
   *
   * Handed to `MachineTypePicker` so its "Available only" checkbox never hides one of these
   * rows: an unavailable preferred type already gets a note in the Size fieldset above (via
   * `resolveSize`'s `note`), and disappearing its row from the table beneath would make that
   * note point at nothing a person looking at the table could find.
   */
  const preferredOfferingIds = useMemo(
    () => new Set(Object.values(tierPreferences).filter((id): id is string => Boolean(id))),
    [tierPreferences],
  )

  const sizeResolutions = useMemo(() => {
    if (!provider) return null
    return new Map(
      SIZES.map((option): [ServerSize, SizeResolution] => [
        option,
        resolveSize(provider.offerings, option, {
          ...(arch ? { arch } : {}),
          ...(tierPreferences[option] ? { preference: tierPreferences[option]! } : {}),
        }),
      ]),
    )
  }, [provider, arch, tierPreferences])

  const resolution = sizeResolutions?.get(size) ?? null

  /**
   * The machine type picker's own pick, re-looked-up rather than cached as an `Offering`
   * (rockysurf-kh3u). A provider switch clears `customOfferingId` (see the provider radio's
   * `onChange`), so this can only miss when the id itself has fallen out of the catalogue —
   * which the empty-string check in `validate` below turns into a plain refusal to submit.
   */
  const customOffering = useMemo(() => {
    if (!customOfferingId || !provider) return null
    return provider.offerings.find((o) => o.id === customOfferingId) ?? null
  }, [provider, customOfferingId])

  // THE OFFERING THE REQUEST WILL ACTUALLY NAME: the custom pick when there is one, the size
  // resolution's answer otherwise. Everything downstream — the price card, the submit button,
  // the request body — reads this one value rather than branching on `customOfferingId` itself.
  const resolved = customOfferingId ? customOffering : resolution?.ok ? resolution.offering : null
  const pricesAsOf = formatPricesAsOf(resolved?.hourly?.fetchedAt)

  // The failure to show when `resolved` is null: the picker's own refusal in custom mode, or
  // the size resolver's in size mode. Narrowed by hand (`resolution && !resolution.ok`) rather
  // than the optional-chained `resolution?.reason` the JSX used before this bead — that no
  // longer type-narrows `resolution`, because the branch it sits in is keyed off `resolved` now.
  const planFailure =
    resolution && !resolution.ok
      ? { reason: resolution.reason, soldOut: resolution.soldOut }
      : { reason: 'Choose a provider', soldOut: false }

  // Pack metadata, not pack identity, decides which fields exist. `requiresRepos` decides no
  // field at all — the repositories field is always there (issue #178); it decides only whether
  // an empty list is confirmed before the create goes out (issue #90).
  const requiresRepos = pack?.requiresRepos ?? false
  const requiresRdp = pack?.requiresRdp ?? false
  /** The same rule again, for the pack's own questions (issue #189). Empty means no section. */
  const packInputs = useMemo(() => pack?.inputs ?? [], [pack])

  /**
   * The Environment textarea, read as `KEY=value` lines (issue #197).
   *
   * Parsed on every change so the submit check and the request body come from ONE reading of
   * the text — but nothing is SHOWN until the user submits, because a message under a field
   * somebody is still typing into is noise, not help.
   */
  const environment = useMemo(() => parseEnvironment(environmentText), [environmentText])

  /*
   * PREFILL THE DECLARED DEFAULTS, AND FORGET WHAT THIS PACK DOES NOT ASK (issue #189).
   *
   * Runs on every change of pack, which is the only thing that can change the questions. Two
   * jobs in one pass, because they are the same decision:
   *
   *  - a declared `default` is written in, so the field shows the pack author's answer and a
   *    user who agrees with it can leave it alone. It seeds only a name with NO value yet, so
   *    it never overwrites something the user has typed.
   *  - a name the new pack does not ask for is dropped, so switching packs cannot smuggle an
   *    old answer into a create that would be refused for it (core 400s an unknown name). A
   *    name BOTH packs ask for keeps its answer: it is literally the same question, and making
   *    someone retype it would be pedantry rather than safety.
   *
   * A secret input is never seeded — the pack schema refuses a default on one — so a password
   * field always starts empty.
   *
   * DONE DURING RENDER, NOT IN AN EFFECT (issue #209). An effect runs only after the fields it
   * is seeding have been committed, so there was one render in which every field the pack asks
   * for was on screen and EMPTY, with its default arriving a beat later. That flash is a bug on
   * its own, and it is also the flake: a keystroke landing in that window went into an empty
   * box, and the effect then put the default back in front of it — typing `0` over a field
   * that declares `1` left `10` on the wire. React's documented way of adjusting state when the
   * thing it is derived from changes is to set it during render and let the component re-run
   * before anything reaches the DOM, which is what this does. The guard is the identity of
   * `packInputs`, which changes only when the pack does.
   */
  const [seededFor, setSeededFor] = useState<SurgePack['inputs']>(undefined)
  if (seededFor !== packInputs) {
    setSeededFor(packInputs)
    setPackInputValues((previous) => {
      const next: Record<string, string> = {}
      for (const input of packInputs) {
        const kept = previous[input.name]
        const value = kept !== undefined && kept !== '' ? kept : (input.default ?? '')
        if (value !== '') next[input.name] = value
      }
      // Same answers as before means the same object, so a pack change that asks nothing new
      // does not cost a second render pass.
      const names = Object.keys(next)
      const unchanged =
        names.length === Object.keys(previous).length && names.every((n) => previous[n] === next[n])
      return unchanged ? previous : next
    })
  }

  const repositories = useMemo(
    () =>
      repoInput
        .split(/[\n,]/)
        .map((line) => line.trim())
        .filter(Boolean),
    [repoInput],
  )

  /*
   * ── LIVE TOKEN RESOLUTION (rockysurf-18lq) ──────────────────────────────────────────────
   *
   * Which credential each typed URL will actually be cloned with, answered while it is being
   * typed. The whole computation happens in core, over the module that predicts the box's
   * credential helper (`git/token-matching.ts`) and the create-time preflight (k6xp) — this
   * component sends strings and renders sentences. Nothing about the matching rules is
   * reimplemented here, deliberately: two implementations of precedence is how the screen comes
   * to describe a box that does not exist.
   *
   * DEBOUNCED AND CACHED, and the probe is real. Public-versus-private is not knowable from the
   * text of a URL — the only way to know is to ask the forge the way `git clone` asks, which is
   * exactly what the preflight already does — so the alternative to asking was showing "we will
   * check this later", which is the answer the user came here to avoid. The cost is bounded by
   * three things rather than by hope: a 600 ms debounce, a cache keyed by the URL that survives
   * editing away and back, and core's own cap on how many URLs one request may carry.
   */
  const [resolutions, setResolutions] = useState<Record<string, RepositoryResolution>>({})

  useEffect(() => {
    // Only URLs nothing has answered for yet. A user adding a fourth line does not re-probe the
    // first three, and backspacing over a line and retyping it costs nothing at all.
    const unresolved = repositories.filter((url) => !(url in resolutions)).slice(0, 10)
    if (unresolved.length === 0) return

    let cancelled = false
    const timer = setTimeout(() => {
      void resolveRepositories(unresolved)
        .then((answers) => {
          if (cancelled) return
          setResolutions((current) => {
            const next = { ...current }
            for (const answer of answers) next[answer.url] = answer
            return next
          })
        })
        // Advisory only. The create route runs the same check for real, and a display that
        // could take the form down with it would be worse than one that is sometimes quiet.
        .catch(() => {})
    }, 600)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [repositories, resolutions])

  // A consent given about an empty list is about THAT list: the moment a repository is added,
  // both the offer and any answer to it are withdrawn, so removing the line later re-asks
  // rather than riding on a tick given in a different situation (issue #90).
  useEffect(() => {
    if (repositories.length > 0) {
      setWithoutReposOffered(false)
      setCreateWithoutRepos(false)
    }
  }, [repositories])

  /**
   * Add a picked repository to the box (rockysurf-mh8f).
   *
   * It appends TEXT, and that is the whole of the integration: the line is now indistinguishable
   * from one somebody typed, so the resolution display, the submit parse and core's preflight all
   * treat it identically. Nothing about a picked repository is remembered separately, which is
   * what keeps the picker from being a second source of truth about the field's contents.
   *
   * DEDUPE LIVES IN THE CHIP, not here, and it lives in exactly one place on purpose. A chip
   * whose URL is already a line in the box is disabled and says "added" — so the fact is stated
   * where the user is looking, and a guard in this function would be a second expression of it
   * that no click could ever reach. It compares the EXACT URL and nothing further: a line the
   * user spelled differently — with `.git`, or a trailing slash — is THEIRS, and a picker that
   * rewrote or swallowed it would be editing text a person wrote. The live display annotates both
   * spellings truthfully, so a near-duplicate is visible rather than silent.
   */
  function insertRepository(url: string) {
    setRepoInput((current) => {
      const body = current.replace(/\s+$/, '')
      return body === '' ? url : `${body}\n${url}`
    })
  }

  /**
   * REMEMBER THIS MACHINE TYPE AS MY <size> FOR <cloud> (issue #124).
   *
   * The low-friction half of the feature. The Settings page can set the same thing in a text
   * box, but nobody opens Settings to answer a question they are already looking at: the moment
   * a user picks `t4g.large` by hand on the New Server page IS the moment they know it is what
   * they want, and this asks them there in one click.
   *
   * IT WRITES THE CONFIG FILE, through the same guarded route the Settings page uses — read for
   * the mtime, then save against it, so a hand-edit in another window is refused rather than
   * clobbered. Two round trips, deliberately: the concurrency token is the whole reason that
   * route is safe, and inventing a second unguarded way in would be a way to lose someone's
   * file.
   *
   * ADMIN ONLY, because the route is. A non-admin never sees the button rather than seeing one
   * that 403s — the difference between a control that does nothing and a control that is not
   * offered.
   */
  async function rememberTier(size: ServerSize, offeringId: string) {
    if (!providerId) return
    setSavingTier(size)
    try {
      const view = await getSettings()
      await saveSettings(view.file.mtimeMs, [
        { path: ['preferences', 'tiers', providerId, size], value: offeringId },
      ])
      setSavedTiers((current) => ({ ...current, [providerId]: { ...current[providerId], [size]: offeringId } }))
      setCustomOfferingId(null)
      setSize(size)
      toast.success(`${offeringId} is now your ${size} on ${provider?.displayName ?? providerId}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save that preference')
    } finally {
      setSavingTier(null)
    }
  }

  function validate(): string | null {
    if (!providerId) return 'Choose a provider'
    if (!packId) return 'Choose a pack'
    if (customOfferingId) {
      if (!customOffering) return 'That machine type is no longer offered by this provider — pick another'
    } else {
      if (!resolution) return 'Choose a provider'
      if (!resolution.ok) return resolution.reason
    }
    if (requiresRdp) {
      if (rdpPassword.length < 8) return 'Remote desktop password must be at least 8 characters'
      if (rdpPassword !== rdpPasswordConfirm) return 'Remote desktop passwords do not match'
    }
    /*
     * A required input with nothing in it blocks the submit HERE rather than at core (#189).
     * Core refuses it too — a limit only one front end honours is not a limit — but discovering
     * it in the browser costs a sentence, while discovering it at the API costs a round trip
     * for a field the user is looking at.
     */
    const missing = packInputs.find((input) => input.required && !(packInputValues[input.name] ?? '').trim())
    if (missing) return `${missing.label} is required by this pack`
    /*
     * A line that is not `KEY=value`, or a name written twice, blocks the submit here (#197).
     * Core refuses both as well — the name rules and the collision with a pack input are its
     * call, and it says so with the pack's own label — but a line the browser can already see
     * is malformed should not cost a round trip.
     */
    if (environment.errors.length > 0) return environment.errors[0]!
    if (sshKeyOption === 'provide' && !chosenPublicKey) {
      // Two ways to be empty, and they need different sentences: nothing pasted, or a saved key
      // chosen that has since been removed in Settings.
      return savedKeyName === ''
        ? 'Paste your SSH public key, or let Rocky Surf generate one'
        : `The saved public key "${savedKeyName}" is no longer in Settings — choose another, or paste one`
    }
    /*
     * THE WRONG HALF OF THE KEYPAIR, caught in the browser (issue #302).
     *
     * Core refuses it too, and core's refusal is the one that matters — this is the same
     * belt-and-braces the pack inputs above get. But a private key that has been pasted into a
     * form has already left `~/.ssh`, and the sooner somebody is told to stop and rotate it the
     * better; a round trip to find out is a round trip that puts it in one more request log.
     */
    if (sshKeyOption === 'provide' && /PRIVATE KEY/i.test(chosenPublicKey)) {
      return 'That is a PRIVATE key. Paste the PUBLIC half instead — the file ending in .pub — and rotate the key you just copied.'
    }
    return null
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const problem = validate()
    if (problem) {
      setSubmitError(problem)
      return
    }
    // Not in `validate()`, because it is not a defect in what the user entered — it is a
    // question the form has not asked yet (issue #90).
    if (requiresRepos && repositories.length === 0 && !createWithoutRepos) {
      setWithoutReposOffered(true)
      setSubmitError('No repository is listed. Confirm below to create the server without one.')
      return
    }
    setSubmitError(null)
    setRepoErrors([])
    setSubmitting(true)

    const packInputPayload = Object.fromEntries(
      packInputs
        .map((input) => [input.name, (packInputValues[input.name] ?? '').trim()] as const)
        .filter(([, value]) => value !== ''),
    )

    try {
      const request: CreateServerRequest = {
        // OMITTED, not sent as `'custom'`, once a specific machine type is picked
        // (rockysurf-kh3u): the literal is never valid on the wire, and core derives it from
        // `offeringId` arriving with no `size` at all.
        ...(customOfferingId ? {} : { size }),
        packId,
        provider: providerId,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        // The offering the user was shown a price for — not whatever core would pick now.
        ...(resolved ? { offeringId: resolved.id, arch: resolved.arch } : {}),
        // Omitted when empty — a confirmed repo-less create goes on the wire exactly like a
        // create with nothing typed (issue #90). Sent whenever something IS typed, whatever the
        // pack declares: the box clones for any pack (issue #178).
        ...(repositories.length > 0 ? { repositories } : {}),
        ...(createAnyway ? { createAnyway: true } : {}),
        // The KEY, never the name it was chosen by (issue #302): core stores the
        // `authorized_keys` line on the row, so a create is answerable to the key it actually
        // authorized rather than to a Settings entry that may be edited or removed later.
        ...(sshKeyOption === 'provide' ? { sshPublicKey: chosenPublicKey } : {}),
        ...(requiresRdp ? { rdpPassword } : {}),
        // Trimmed, and omitted entirely when there is nothing but whitespace: an empty textarea
        // is not a request to run anything, and a `userScriptRunAs` with no script is a 400
        // (issue #184). The two therefore go on the wire together or not at all.
        ...(userScript.trim() ? { userScript: userScript.trim(), userScriptRunAs } : {}),
        // ONLY the names this pack declares, and only the ones with something in them: core
        // refuses an unknown name, and an empty optional value would set a variable to the empty
        // string on the box, where a pack script's own `${FOO:-}` default can no longer fire
        // (issue #189).
        ...(Object.keys(packInputPayload).length > 0 ? { packInputs: packInputPayload } : {}),
        // Omitted entirely when the field is empty, so a create with nothing typed goes on the
        // wire exactly as it did before this field existed (issue #197).
        ...(Object.keys(environment.entries).length > 0 ? { environment: environment.entries } : {}),
      }

      const created = await createServer(request)
      toast.success('Server created')
      // Stay on the page and show the live feed rather than navigating away mid-provision:
      // the interesting part happens over the next minute, and it happens here.
      setCreatedServerId(created.serverId)
    } catch (err) {
      /*
       * `detail`, not `message` (rockysurf-k6xp). `ApiError`'s own message is the status line
       * — "API Error: 400 Bad Request" — so this form was the one place in the SPA that
       * structurally could not display anything core said, while every sibling component
       * already read `.detail`. A create is also the request with the most to say: which
       * limit refused it, which provider is ambiguous, which repository URL does not open.
       */
      if (err instanceof ApiError) {
        setSubmitError(err)
        // Field-level detail lands on the field. `repositories.N` is the only path this form
        // has somewhere to put; anything else stays in the summary above.
        const byIndex: string[] = []
        for (const issue of err.issues) {
          const at = /^repositories\.(\d+)$/.exec(issue.path)
          if (at) byIndex[Number(at[1])] = issue.message
        }
        setRepoErrors(byIndex)
      } else {
        setSubmitError(err instanceof Error ? err.message : 'Failed to create server')
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <AppShell title="New server" className="page">
        <p>Loading options…</p>
      </AppShell>
    )
  }

  if (loadError) {
    return (
      <AppShell title="New server" className="page">
        <p className="error">{loadError}</p>
      </AppShell>
    )
  }

  // Once created, the form is done and the feed takes over.
  if (createdServerId) {
    return (
      <AppShell title={`Setting up ${name.trim() || 'your server'}`} className="page">
        <ProvisioningFeed serverId={createdServerId} onReady={() => navigate(`/servers/${createdServerId}`)} />
        <button type="button" className="btn-secondary" onClick={() => navigate(`/servers/${createdServerId}`)}>
          Go to server
        </button>
      </AppShell>
    )
  }

  return (
    <AppShell title="New server" className="page">
      <form onSubmit={handleSubmit}>
        <label className="form-label" htmlFor="name">
          Name <span className="hint">optional</span>
        </label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="dev-box" />

        <label className="form-label" htmlFor="description">
          Description <span className="hint">optional</span>
        </label>
        {/* The field that stops a fleet of `server-mt0nilwv`s (issue #46). Editable later
            from the server page, so skipping it here costs nothing. */}
        <input
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
          placeholder="What is this box for?"
        />

        {/* Provider — a real choice when there is one, and a plain statement when there is not. */}
        {providers.length > 1 ? (
          <fieldset data-testid="provider-choice">
            <legend>Provider</legend>
            <p className="hint">
              Pick the cloud this server runs on. The plan and its price below are that cloud&apos;s
              answer, and it is that cloud that bills you.
            </p>
            {providers.map((p) => (
              <label key={p.id} className={`radio-option ${p.id === providerId ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="provider"
                  value={p.id}
                  checked={p.id === providerId}
                  onChange={() => {
                    setProviderId(p.id)
                    setArch(undefined) // catalogues differ; do not carry an arch across
                    setCustomOfferingId(null) // ...and not a machine-type pick either
                  }}
                />
                <span>{p.displayName}</span>
              </label>
            ))}
          </fieldset>
        ) : (
          provider && (
            <p className="hint" data-testid="sole-provider">
              Creating on <strong>{provider.displayName}</strong>, the only cloud configured.
            </p>
          )
        )}

        {/*
          Enabled in the config, absent from the registry. Shown on THIS page and not only in
          the boot log, because this is where someone discovers their second cloud is missing —
          they came here to pick it. The reason is the provider's own error text, so it names
          the field to fix rather than paraphrasing it into something ungreppable.
        */}
        {unloadable.length > 0 && (
          <div className="warning" data-testid="providers-unavailable">
            <p>
              {unloadable.length === 1 ? 'One configured provider is' : `${unloadable.length} configured providers are`}{' '}
              enabled but did not load, so {unloadable.length === 1 ? 'it is' : 'they are'} not offered here:
            </p>
            <ul>
              {unloadable.map((p) => (
                <li key={p.id}>
                  <strong>{p.displayName}</strong>
                  {p.unavailableReason ? <> — {p.unavailableReason}</> : null}
                </li>
              ))}
            </ul>
            <p>Fix the section in <code>rockysurf.config.yaml</code> and restart Rocky Surf.</p>
          </div>
        )}

        {provider?.offeringsError && (
          <p className="warning">Could not read {provider.displayName}&apos;s catalogue: {provider.offeringsError}</p>
        )}

        {/*
          One aggregate notice when a provider's catalogue came back entirely unpriced —
          usually the hosted price feed being unreachable (gh issue #100, ADR-0009). Without
          it, a page of rows each saying "price unknown" reads as a per-row mystery instead of
          one condition. Deliberately not an error: creates work fine, only the estimates are
          missing, and the sentence says exactly that.
        */}
        {provider && provider.offerings.length > 0 && provider.offerings.every((o) => o.hourly === null) && (
          <p className="warning" data-testid="prices-unavailable">
            Prices are currently unavailable for {provider.displayName} — cost estimates cannot be shown, but
            servers can still be created.
          </p>
        )}

        <fieldset>
          <legend>Size</legend>
          {SIZES.map((option) => {
            const requirements = SIZE_REQUIREMENTS[option]
            // The machine this size would land on right now. Absent before a cloud is chosen,
            // and absent for a size this cloud cannot meet — the label keeps its floor and says
            // nothing more, because the reason belongs to the size actually selected and the
            // plan card below already gives it there.
            const lands = sizeResolutions?.get(option)
            return (
              <label key={option} className={`radio-option ${!customOfferingId && option === size ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="size"
                  value={option}
                  // Deselected, not merely un-highlighted, once a specific machine type is
                  // picked (rockysurf-kh3u): `size` is state this component still holds, but
                  // it is not what will be sent, and a checked radio would say otherwise.
                  checked={!customOfferingId && option === size}
                  onChange={() => {
                    setSize(option)
                    setCustomOfferingId(null)
                  }}
                />
                <span className="size-name">{option}</span>
                <span className="size-detail">
                  at least {requirements.vcpu} vCPU · {requirements.memGb} GB RAM
                </span>
                {lands?.ok && (
                  <span className="size-detail" data-testid={`size-resolves-${option}`}>
                    {/* Never blank, never $0 — null means the provider quoted nothing, not free.
                        When the whole catalogue came back that way it is one condition, and the
                        aggregate notice above says so once for all three of these. */}
                    {lands.offering.id} · {lands.offering.hourly ? formatHourly(lands.offering.hourly) : 'price unknown'}
                  </span>
                )}
                {/* The type this user saved, being used (issue #124). On the row rather than in
                    the plan card, because the question it answers — "why is my medium bigger
                    than the floor says?" — is asked while reading the three rows. */}
                {lands?.ok && lands.preferred && (
                  <span className="size-detail" data-testid={`size-preferred-${option}`}>
                    your saved type
                  </span>
                )}
              </label>
            )
          })}
          {/*
            A saved type that could not be used, and what was used instead (issue #124).

            SHOWN FOR THE SELECTED SIZE ONLY, and only while a size is what drives the request:
            a machine type picked by hand has already overridden every size, so a sentence about
            what one of them would have resolved to is answering a question nobody asked.

            NEVER AS AN ERROR: nothing is broken, the create will succeed, and the machine is
            simply not the one the preference names.
            Silence here is the failure mode the whole note exists to prevent — a user who saved
            a type, got a different one, and found out from the invoice.
          */}
          {!customOfferingId && resolution?.note && (
            <p className="hint" data-testid="tier-preference-note">
              {resolution.note}
            </p>
          )}
        </fieldset>

        {provider && (
          <MachineTypePicker
            offerings={provider.offerings}
            selectedId={customOfferingId}
            onSelect={(offering) => setCustomOfferingId(offering.id)}
            onClear={() => setCustomOfferingId(null)}
            preferredIds={preferredOfferingIds}
          />
        )}

        {/*
          "MAKE THIS MY DEFAULT" (issue #124) — the one-click half of the preference.

          Offered exactly when there is something to remember: a specific machine type has been
          picked by hand, which is the moment the user has demonstrably decided. Three buttons
          rather than one, because the type alone does not say WHICH size it is the answer for,
          and asking that question in the same click is cheaper than a second screen.

          A size whose saved type is already this one gets no button — there is nothing to save,
          and a button that would write what is already written is a button that lies about
          having done something.
        */}
        {provider && customOffering && user?.isAdmin && (
          <div className="tier-preference" data-testid="remember-tier">
            <p className="hint">
              Use <code>{customOffering.id}</code> every time you ask {provider.displayName} for a:
            </p>
            <div className="tier-preference-actions">
              {SIZES.map((option) =>
                tierPreferences[option] === customOffering.id ? (
                  <span key={option} className="hint" data-testid={`tier-saved-${option}`}>
                    {option} — saved
                  </span>
                ) : (
                  <button
                    key={option}
                    type="button"
                    className="button secondary"
                    disabled={savingTier !== null}
                    onClick={() => void rememberTier(option, customOffering.id)}
                  >
                    {savingTier === option ? 'Saving…' : option}
                  </button>
                ),
              )}
            </div>
            <p className="hint">
              Saved to <code>rockysurf.config.yaml</code>, and used by the CLI and MCP too. Change or clear it
              under Preferences in <Link to="/settings?section=preferences">Settings</Link>.
            </p>
          </div>
        )}

        {/* Architecture, offered only where the provider actually sells more than one, and
            only while a size — not a specific machine type — is driving the request: a
            picked offering already carries its own arch, and this control would do nothing. */}
        {architectures.length > 1 && !customOfferingId && (
          <fieldset>
            <legend>Architecture</legend>
            <label className={`radio-option ${arch === undefined ? 'selected' : ''}`}>
              <input type="radio" name="arch" checked={arch === undefined} onChange={() => setArch(undefined)} />
              <span>Any</span>
              <span className="size-detail">cheapest that fits</span>
            </label>
            {architectures.map((option) => (
              <label key={option} className={`radio-option ${option === arch ? 'selected' : ''}`}>
                <input type="radio" name="arch" value={option} checked={option === arch} onChange={() => setArch(option)} />
                <span>{archLabel(option)}</span>
                {option === 'arm64' && <span className="size-detail">usually cheaper</span>}
              </label>
            ))}
          </fieldset>
        )}

        {/* The resolved machine — shown BEFORE submit, with its price and the date of that price.
            Reads `resolved` rather than `resolution.ok` directly (rockysurf-kh3u), because it is
            now the answer to either question: which offering the size resolved to, or which one
            the machine-type picker named outright. */}
        <section className="resolved-offering" aria-live="polite" data-testid="resolved-offering">
          {resolved ? (
            <>
              {/* The heading labels the box; it does not carry the id (#226). Under the etched
                  skin an h2 is cut in letterspaced caps, and caps label a field — they cannot
                  hold an identifier the user has to read character by character and may type
                  into a provider console. So the id keeps its own <code>, as it does on the
                  server card and in the machine-type table. */}
              <h2>Machine</h2>
              <p className="resolved-offering-id">
                <code data-testid="resolved-offering-id">{resolved.id}</code>{' '}
                <span className="arch-badge">{archLabel(resolved.arch)}</span>
              </p>
              <p>
                {resolved.cpu} vCPU · {resolved.memoryGb} GB RAM
                {resolved.diskGb ? ` · ${resolved.diskGb} GB disk` : ''} · {resolved.region}
              </p>
              <p className="price">
                <strong>{formatHourly(resolved.hourly)}</strong>
                {formatMonthly(resolved.hourly) && <> · about {formatMonthly(resolved.hourly)}/month if left running</>}
              </p>
              {pricesAsOf ? (
                <p className="price-note">
                  Estimate, {pricesAsOf}. You are billed by {provider?.displayName}, not by Rocky Surf.
                </p>
              ) : (
                <p className="price-note">
                  This provider quoted no price. You are billed by {provider?.displayName}, not by Rocky Surf.
                </p>
              )}
            </>
          ) : (
            <p className={!customOfferingId && planFailure.soldOut ? 'warning' : 'error'}>
              {customOfferingId
                ? 'That machine type is no longer offered by this provider — pick another.'
                : planFailure.reason}
            </p>
          )}
        </section>

        <fieldset>
          <legend>Surge Pack</legend>
          {/*
            A fresh install has no packs until someone adds a YAML file or creates one in the
            admin UI. Saying so beats an empty box above a button that refuses to submit —
            which is exactly what browser verification caught here.
          */}
          {packs.length === 0 && (
            <p className="hint">
              No Surge Packs are available yet. Add a pack file to <code>packs/</code> or create one
              at <Link to="/packs">Surge Packs</Link>, then reload.
            </p>
          )}
          {/* A `?pack=` naming something not on offer (rockysurf-4d8h) — stated, never
              swallowed. The usual lowest-displayOrder pack is still preselected above; this
              only says the requested one was not it. */}
          {packNotice && (
            <p className="hint" data-testid="pack-preselect-missing">
              <code>{packNotice}</code> is not available on this installation, so nothing was
              preselected.
            </p>
          )}
          {/*
            OFFICIAL AND COMMUNITY (rockysurf-jn71). Both tabs are always here once there is a
            pack to show — including on the fresh install with nothing contributed, where hiding
            the empty shelf would remove the feature from exactly the people who have not yet
            learned that a Pack Shop exists, and would make the control grow a tab under them the
            first time their operator installs one.

            The zero-packs case keeps the sentence above and no tabs: there is nothing to sort
            into shelves, and the message a user needs there is the one that says so.
          */}
          {packs.length > 0 && (
            <>
              <Tabs
                label="Surge Pack source"
                panelId="pack-tabpanel"
                active={packTab}
                onSelect={setPackTab}
                tabs={[
                  { key: 'official', label: 'Official' },
                  { key: 'community', label: 'Community' },
                ]}
              />
              {/*
                WHAT IS ACTUALLY CHOSEN, on both tabs, always. The selected pack can be on the
                shelf you are not looking at — switching tabs deliberately does not move it — so
                without this line the checked radio simply vanishes and the form reads as though
                nothing is selected. Stated rather than implied, because the alternative designs
                both lose: auto-selecting the new tab's first pack changes which software gets
                installed on the box by list order (the failure rockysurf-va2l fixed for the
                provider picker), and clearing the selection makes a tab click destructive.
              */}
              <p className="hint pack-selected" data-testid="pack-selected">
                Selected: <strong>{pack ? pack.name : 'none yet'}</strong>
              </p>
              <div role="tabpanel" id="pack-tabpanel" aria-labelledby={`pack-tabpanel-tab-${packTab}`}>
                {shelved.length === 0 &&
                  (packTab === 'community' ? (
                    <p className="hint" data-testid="community-empty">
                      No community packs are installed.{' '}
                      {/* `/packs` is member-reachable (rockysurf-4d8h, issue #51), unlike the
                          admin-only `/admin/pack-shop` it replaced — so this is offered to
                          everyone rather than branching on `user?.isAdmin`. */}
                      <Link to="/packs">Browse the Surge Packs</Link>
                    </p>
                  ) : (
                    // The mirror case, and it is reachable: an operator can disable the packs
                    // that shipped. An empty box under a tab says less than a sentence does.
                    <p className="hint" data-testid="official-empty">
                      No packs from this Rocky Surf release are enabled.
                    </p>
                  ))}
                {shelved.map((option) => (
                  <label key={option.packId} className={`radio-option ${option.packId === packId ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="pack"
                      value={option.packId}
                      checked={option.packId === packId}
                      onChange={() => setPackId(option.packId)}
                    />
                    {/* The pack's mark — its image, or a monogram when it has none (or the
                        image failed). One component, shared with the /packs catalogue
                        (rockysurf-4d8h), so every third-party pack still reads correctly. */}
                    <PackIcon pack={option} />
                    <span>{option.name}</span>
                    <span className="size-detail">{option.tools.map((t) => t.name).join(', ')}</span>
                  </label>
                ))}
              </div>
            </>
          )}
        </fieldset>

        {/* WHAT THE PACK ASKS FOR (issue #189, ADR-0013). Rendered from `pack.inputs` and from
            nothing else — no `packId` is compared anywhere in this file, which is the same rule
            that let `requiresRdp` replace the old `open-claw` hardcode. The section does not
            exist for a pack that asks for nothing. */}
        {packInputs.length > 0 && (
          <div className="form-group">
            <label className="form-label">{pack?.name} settings</label>
            {/* Said once, above the fields, because it is true of all of them and because a
                person about to type a key needs to know where it goes. The second sentence is
                the honest limit: these reach the box as environment variables for its setup,
                not as a secret store the user can read back. */}
            <p className="hint">
              This pack asks for these before it installs. They are given to its install scripts as environment
              variables and are not shown in your shell afterwards.
            </p>
            {packInputs.map((input) => (
              <div key={input.name} className="pack-input">
                {/* The label is a direct text node so `getByText(label)` finds this element and
                    not an ancestor, and the required marker is a sibling rather than part of
                    it — tests query fields by their label. */}
                <label className="form-label" htmlFor={`packInput-${input.name}`}>
                  {input.label}
                  {input.required ? <span className="hint"> required</span> : <span className="hint"> optional</span>}
                </label>
                {input.description && <p className="hint">{input.description}</p>}
                <input
                  id={`packInput-${input.name}`}
                  /* A password field for a `secret` input, for the reason the RDP field is one:
                     the value is a credential, it must not be shoulder-read, and browsers must
                     not offer to remember it as an ordinary form value. Core stores it
                     encrypted and returns it from no route. */
                  type={input.secret ? 'password' : 'text'}
                  value={packInputValues[input.name] ?? ''}
                  onChange={(e) => setPackInputValues((v) => ({ ...v, [input.name]: e.target.value }))}
                  {...(input.secret ? { autoComplete: 'new-password' as const } : {})}
                />
                {/* The variable the box will actually see. Shown because a pack's own guide and
                    README talk about it by name, and a user debugging their box needs to be able
                    to join the two up. */}
                <span className="size-detail">
                  <code>${input.name}</code>
                </span>
              </div>
            ))}
          </div>
        )}

        {requiresRdp && (
          <div className="form-group">
            <label className="form-label" htmlFor="rdpPassword">
              Remote desktop password
            </label>
            <p className="hint">This pack installs a graphical desktop. At least 8 characters.</p>
            <input
              id="rdpPassword"
              type="password"
              value={rdpPassword}
              onChange={(e) => setRdpPassword(e.target.value)}
              autoComplete="new-password"
            />
            <label className="form-label" htmlFor="rdpPasswordConfirm">
              Confirm password
            </label>
            <input
              id="rdpPasswordConfirm"
              type="password"
              value={rdpPasswordConfirm}
              onChange={(e) => setRdpPasswordConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </div>
        )}

        {/* Always present, whatever the pack declares (issue #178). The pack's flag only changes
            the marker on the label and whether an empty list is confirmed at submit. */}
        <div className="form-group">
          {/* REQUIRED-NESS ON THE LABEL, NOT IN PROSE (issue #245). The pack's expectation used
              to be sentence three of the paragraph below, where the two fields on either side of
              this one were saying "optional" in the one place a form is read for that. Same
              markers, same position, same `.hint` span as a pack's own inputs already use.

              "required" is the pack's word, not a refusal: an empty list still creates a server
              (issue #90) — the submit asks once and takes yes for an answer. The label says what
              the pack expects; the check at submit says what happens if you disagree. */}
          <label className="form-label" htmlFor="repositories">
            Repositories{' '}
            {requiresRepos ? <span className="hint">required</span> : <span className="hint">optional</span>}
          </label>
          {/* ONE LINE OF PURPOSE (issue #245). What the field is for, and nothing else; the
              credential rules that used to follow it are in the disclosure below. */}
          <p className="field-help">One git URL per line. They are cloned onto the box during setup.</p>
          {/* The private-repo rules are still ON THIS PAGE, because the form is where the
              mistake is made: a private URL is accepted, provisioning starts, and the clone
              fails minutes later on the box with nothing here having hinted why
              (rockysurf-f1z1). Behind a disclosure rather than in the lead, because the live
              resolution list under the textarea answers the question per URL as it is typed
              (rockysurf-18lq) — it names the token, or refuses and links to Settings — so this
              is the reference, not the warning.

              It names `github.pat` in the config file, which is the one place that populates the
              token — not an environment variable core reads, because it reads none
              (rockysurf-yzae wired the config key through; the box end was already done). */}
          <details className="field-details">
            <summary role="button">How they are cloned, and what a private one needs</summary>
            <ul>
              <li>Cloned over HTTPS during setup, into the box&apos;s home directory.</li>
              <li>Public URLs need no credentials.</li>
              <li>
                A private repository needs <code>github.pat</code> set in{' '}
                <code>rockysurf.config.yaml</code> — see{' '}
                <a href={repoDocUrl('docs/self-hosting.md')} target="_blank" rel="noreferrer">
                  <code>docs/self-hosting.md</code>
                </a>
                .
              </li>
              <li>Every line below says which credential it will actually open with, as you type.</li>
            </ul>
          </details>
          {/* Above the field rather than beside it, because the order is the workflow: pick what
              is already configured, then type whatever else this box needs (rockysurf-mh8f). */}
          <RepositoryPicker scopes={scopes} present={repositories} onInsert={insertRepository} />
          <textarea
            id="repositories"
            rows={4}
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            // HTTPS on both lines. The second used to read `git@github.com:you/other.git`,
            // which is a form the box cannot use at all — it clones over HTTPS with a token
            // and is never given an SSH key — so the placeholder was teaching the very
            // mistake core now refuses (rockysurf-k6xp).
            placeholder={'https://github.com/you/project.git\nhttps://github.com/you/other'}
          />
          {/* What each URL resolves to, as it is typed (rockysurf-18lq). `aria-live` because
              the answers arrive after the typing stops and a screen reader would otherwise
              never learn that the line it just dictated needs a token nobody has configured. */}
          {repositories.length > 0 && (
            <ul className="repo-resolutions" aria-live="polite" data-testid="repo-resolutions">
              {repositories.map((url, index) => (
                <li key={`${url}-${index}`}>
                  <code>{url}</code> — <RepositoryTokenLine resolution={resolutions[url]} />
                </li>
              ))}
            </ul>
          )}
          {/* Core checked each of these before launching anything, and this is what it found.
              Rendered against the line the user typed rather than as one banner, because the
              only useful next action is editing a specific URL. */}
          {repoErrors.length > 0 && (
            <ul className="repo-errors" role="alert">
              {repositories.map((url, index) =>
                repoErrors[index] ? (
                  <li key={`${url}-${index}`}>
                    <code>{url}</code> — {repoErrors[index]}
                  </li>
                ) : null,
              )}
            </ul>
          )}
        </div>

        {/* THE USER'S OWN ENVIRONMENT (issue #197, ADR-0014). On the form for every pack, like
            the startup script below: a pack cannot grant or withhold a person's ability to hand
            their own box a value. Empty means nothing is sent at all. */}
        <div className="form-group">
          <label className="form-label" htmlFor="environment">
            Environment <span className="hint">optional</span>
          </label>
          {/* ONE LINE OF PURPOSE, THEN THE CAVEAT ON ITS OWN LINE (issue #245). The paragraph
              this replaces carried five facts, and the one a person must read before typing a
              token into a box on a web page — that an unmarked line is kept in the clear — was
              the fourth of them. */}
          {/* THE SHELL HALF IS ISSUE #244, and it is one line because it is one fact: a value set
              here used to reach the setup steps and stop there, so the honest sentence was "every
              step of this box's setup can read it". It is now also exported into the login shell,
              which is what a person expects of something called Environment — and the copy says
              both halves rather than leaving the second to be discovered over SSH.

              It is also why the caveat below names ROCKY SURF as the thing that will not show a
              secret back, rather than saying it "cannot be read back". Once #244 exports these
              into the login shell, a secret IS legible to anyone who can open a shell on the box
              — what no route returns it to is the control plane. The unqualified sentence would
              have been a promise this product cannot keep. */}
          <p className="field-help">
            One <code>KEY=value</code> per line — your own values for this box, available to its setup and in your
            shell when you SSH in.
          </p>
          <p className="field-caveat">
            Stored and shown in the clear unless the line starts with <code>{SECRET_LINE_PREFIX}</code>, which
            stores it encrypted — keep your own copy, because Rocky Surf will not show it back to you.
          </p>
          <details className="field-details">
            <summary role="button">What the names and values may be</summary>
            <ul>
              <li>
                Names are <code>UPPER_SNAKE_CASE</code>. The names Rocky Surf exports itself are refused, and so
                is one the selected pack already asks for.
              </li>
              <li>Values are a single line each, and are never written into the install plan.</li>
              <li>Plain lines are shown on the server&apos;s page afterwards, so you can read back what a box was built with.</li>
              <li>
                Rocky Surf writes these once, when the box is built — they cannot be edited here
                afterwards. On the box itself they are yours to change: they live in{' '}
                <code>~/.config/rockysurf/environment</code>.
              </li>
            </ul>
          </details>
          <textarea
            id="environment"
            rows={4}
            value={environmentText}
            onChange={(e) => setEnvironmentText(e.target.value)}
            placeholder={'MY_ENDPOINT=https://api.example.com\nsecret:MY_API_TOKEN=…\n'}
            spellCheck={false}
          />
        </div>

        {/* On the form for EVERY pack, like Repositories above (issue #184). A pack cannot grant
            or withhold this: it is the user's own instructions to their own box, and core
            renders the step for whatever arrives. Empty means no step at all. */}
        <div className="form-group">
          <label className="form-label" htmlFor="userScript">
            Startup script <span className="hint">optional</span>
          </label>
          {/* The contract stays ON THIS PAGE — this is where the decision is made, and the same
              reason the private-repo rules sit under Repositories — but it is five facts, and a
              paragraph of five buries the one that matters most. So: one line of purpose, the
              plain-text caveat on its own line, and the semantics behind the disclosure
              (issue #245). */}
          <p className="field-help">A shell script this box runs once, near the end of setup.</p>
          <p className="field-caveat">
            Stored and sent to the box in plain text. Put passwords and tokens in Environment above and read{' '}
            <code>$KEY</code> here instead.
          </p>
          <details className="field-details">
            <summary role="button">When it runs, what it gets, and what happens if it fails</summary>
            <ul>
              <li>Runs after the pack&apos;s tools are installed and your repositories are cloned.</li>
              <li>
                Gets <code>$REPOS</code>, <code>$HOME</code> and <code>$ARCH</code> like a pack script does, plus
                anything you set in Environment above.
              </li>
              <li>
                Run with <code>bash</code>, and nothing is added to it — write <code>set -euo pipefail</code>{' '}
                yourself if you want it.
              </li>
              <li>If it fails the server still comes up, and the whole log is kept on it as a warning.</li>
              <li>At most 16 KiB, and 30 minutes to run. It runs once, during setup, and never again.</li>
              <li>
                The full contract is in{' '}
                <a href={repoDocUrl('docs/self-hosting.md')} target="_blank" rel="noreferrer">
                  <code>docs/self-hosting.md</code>
                </a>
                .
              </li>
            </ul>
          </details>
          <textarea
            id="userScript"
            rows={6}
            value={userScript}
            onChange={(e) => setUserScript(e.target.value)}
            placeholder={'set -euo pipefail\nmkdir -p "$HOME/.config"\n'}
          />
          {/*
            WHO RUNS IT IS A PROPERTY OF THE SCRIPT, NOT A SECTION BESIDE IT (issue #245).

            This was a peer section — its own caps heading and two full-width radio cards, so a
            choice that does nothing without a script carried more weight on the page than the
            script it modifies, and carried it whether or not anything had been typed. It is now
            one small row under the textarea: the legend, then two compact options.

            The account names are `<code>` because they are what the user types — `sudo -u rocky`,
            `ssh rocky@…` — and the whole page monospaces those.
          */}
          {/* `script-run-as`, not `run-as`: that class is already the install preview's "as rocky"
              tail, and it carries a `margin-left: auto` that shoved this fieldset off the form's
              left edge. */}
          <fieldset className="script-run-as">
            <legend>Run as</legend>
            <div className="script-run-as-options">
              <label className={`script-run-as-option ${userScriptRunAs === 'rocky' ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="userScriptRunAs"
                  checked={userScriptRunAs === 'rocky'}
                  onChange={() => setUserScriptRunAs('rocky')}
                />
                <code>rocky</code>
                {/* Deliberately does not contain the word the other option is named for: both
                    children are part of each radio's accessible name, so a "…when you need root"
                    here would make `getByRole('radio', { name: /root/i })` ambiguous. */}
                <span className="size-detail">the account you SSH in as</span>
              </label>
              <label className={`script-run-as-option ${userScriptRunAs === 'root' ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="userScriptRunAs"
                  checked={userScriptRunAs === 'root'}
                  onChange={() => setUserScriptRunAs('root')}
                />
                <code>root</code>
                {/* Was "what EC2 user data does" — AWS's name for its own feature, on a form that
                    also creates Azure, GCP and Hetzner boxes. What the choice actually costs the
                    user is the same on every cloud, so it is said in those terms instead. */}
                <span className="size-detail">full privileges; anything it creates is owned by root</span>
              </label>
            </div>
          </fieldset>
        </div>

        <fieldset>
          <legend>SSH access</legend>
          <label className={`radio-option ${sshKeyOption === 'generate' ? 'selected' : ''}`}>
            <input
              type="radio"
              name="sshKey"
              checked={sshKeyOption === 'generate'}
              onChange={() => setSshKeyOption('generate')}
            />
            <span>Generate a key for me</span>
            <span className="size-detail">downloadable once the server is ready</span>
          </label>
          <label className={`radio-option ${sshKeyOption === 'provide' ? 'selected' : ''}`}>
            <input
              type="radio"
              name="sshKey"
              checked={sshKeyOption === 'provide'}
              onChange={() => setSshKeyOption('provide')}
            />
            <span>Use my own public key</span>
          </label>
          {sshKeyOption === 'provide' && (
            <>
              {/*
                THE SAVED KEYS (issue #302), and only when there are some.

                An installation that has never saved one sees exactly the form it saw before —
                no empty menu, no control whose only message is "you have not used this yet",
                which is the rule `fields.ts` states for the Settings page and which applies
                just as well here.

                The picker WRITES NOTHING into the textarea below, and the textarea is hidden
                while a saved key is selected. Copying the key into the box would invite an edit
                that silently detaches it from the name above it; two controls that can disagree
                about one value is how a person authorizes a key they did not mean to.
              */}
              {savedSshKeys.length > 0 && (
                <div className="form-group">
                  <label htmlFor="savedSshKey">Public key</label>
                  <select
                    id="savedSshKey"
                    value={savedKeyName}
                    onChange={(e) => setSavedKeyName(e.target.value)}
                  >
                    {savedSshKeys.map((key) => (
                      <option key={key.name} value={key.name}>
                        {key.name}
                      </option>
                    ))}
                    <option value="">Paste a different public key…</option>
                  </select>
                  <p className="hint">
                    Saved on the <Link to="/settings?section=ssh">Settings page</Link>. Public keys only — Rocky Surf
                    never stores a private key.
                  </p>
                </div>
              )}
              {savedKeyName === '' && (
                <textarea
                  aria-label="SSH public key"
                  rows={3}
                  value={sshPublicKey}
                  onChange={(e) => setSshPublicKey(e.target.value)}
                  placeholder="ssh-ed25519 AAAA… you@laptop"
                />
              )}
              {/* Issue #41: the create form used to present these two options as mutually
                  exclusive. They are not — Rocky Surf's key is appended, never substituted,
                  because push-mode bootstrap installs everything over its own SSH connection.
                  Issue #92: that key is temporary, not permanent — once bootstrap finishes, it
                  is removed and yours is the only one left. */}
              <p className="hint">
                Rocky Surf also authorizes a key of its own on this box while it installs everything — it needs one
                for that. Once setup finishes, that key is removed and yours is the only one left on the box.
              </p>
            </>
          )}
          {/*
            Capability-driven, not provider-driven. A provider that cannot carry a host key
            leaves core on trust-on-first-use, and the user deserves to know that before they
            connect — not to discover it from an SSH warning later.
          */}
          {provider && !provider.capabilities.canInjectHostKeys && (
            <p className="hint">
              {provider.displayName} cannot pre-install a host key, so the first connection is trusted on sight and
              pinned from then on.
            </p>
          )}
        </fieldset>

        {provider && !provider.capabilities.stop && (
          <p className="hint">{provider.displayName} servers cannot be stopped and restarted — only terminated.</p>
        )}

        {submitError &&
          (typeof submitError === 'string' ? <p className="error">{submitError}</p> : <ProviderErrorNotice error={submitError} />)}

        {/* The way past a preflight refusal, offered only once there IS one — with the reasons
            still on screen above it, so ticking it is a decision about them. The check is a
            prediction of what the box will do, and a prediction can be wrong: a forge that was
            briefly down, or a credential core cannot know the box will end up using. */}
        {repoErrors.length > 0 && (
          <label className="checkbox-row">
            <input type="checkbox" checked={createAnyway} onChange={(e) => setCreateAnyway(e.target.checked)} />
            <span>
              Create anyway. The box will still try to clone these; if they really are wrong it will
              fail during setup and keep billing until you terminate it.
            </span>
          </label>
        )}

        {/* The repo-less confirmation (issue #90), on the same doctrine as `createAnyway`:
            offered only once a submit has raised the question, with the reason on screen. */}
        {requiresRepos && withoutReposOffered && repositories.length === 0 && (
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={createWithoutRepos}
              onChange={(e) => setCreateWithoutRepos(e.target.checked)}
            />
            <span>
              Create the server without a repository. Nothing is cloned during setup — you can
              clone whatever you like over SSH once it is running.
            </span>
          </label>
        )}

        <button type="submit" className="btn-primary new-action" disabled={submitting || !resolved}>
          {submitting ? 'Creating…' : 'Create server'}
        </button>
      </form>
    </AppShell>
  )
}
