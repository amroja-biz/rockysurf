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
import { useAuth } from '../contexts/AuthContext'
import { AppShell } from '../components/AppShell'
import { PackIcon } from '../components/PackIcon'
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

/**
 * A specific machine type, named directly, over a t-shirt size (rockysurf-kh3u, issue #24 PR 1).
 *
 * A size is a floor — "at least this much" — and the create route already accepts an
 * `offeringId` naming an exact one; this disclosure is the first place on this page that lets a
 * person reach it, over the SAME catalogue the Size fieldset above resolves against. Nothing here
 * fetches anything of its own: it is handed the allowlist-filtered offerings the page already
 * loaded for the resolver, so a row shown here is a row the create request can actually name.
 *
 * RENDER CAP, deliberately. The catalogue this reads from is ~12 rows today and will be roughly a
 * thousand once AWS's generator widens it (issue #24 PR 2a) — searching first and rendering a
 * capped, filtered slice is what keeps that future catalogue from becoming a thousand DOM rows.
 *
 * SOLD-OUT ROWS ARE DISABLED, NOT HIDDEN — an id a person cannot buy today is still a real id,
 * and hiding it would make the catalogue look smaller than it is. `Offering.available` is the
 * only signal any provider puts on the wire for this (no provider attaches a per-row reason
 * string), so every disabled row carries the same honest, generic sentence rather than one this
 * component would have to invent per cloud.
 */
function MachineTypePicker({
  offerings,
  selectedId,
  onSelect,
  onClear,
}: {
  offerings: readonly Offering[]
  /** The offering id currently driving the request, or `null` when a size drives it instead. */
  selectedId: string | null
  onSelect: (offering: Offering) => void
  onClear: () => void
}) {
  // Collapsed by default, and the TABLE ITSELF IS NOT MOUNTED while collapsed — not merely
  // visually hidden. Two reasons, not one: the catalogue this reads from is ~12 rows today and
  // will be roughly a thousand once AWS's generator widens it (issue #24 PR 2a), so there is no
  // reason to build rows nobody has asked to see; and a mounted-but-hidden table would duplicate
  // every row's price text into the page underneath the Size fieldset above, which the rest of
  // this page's own price display already renders once.
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return offerings
    return offerings.filter((o) => o.id.toLowerCase().includes(q) || o.region.toLowerCase().includes(q))
  }, [offerings, query])

  const shown = filtered.slice(0, MACHINE_PICKER_RENDER_CAP)
  const hiddenCount = filtered.length - shown.length

  return (
    <details
      className="machine-picker"
      data-testid="machine-type-picker"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      {/* `role="button"` stated explicitly: the ARIA-in-HTML mapping for a details' first
          `<summary>` is implicitly "button", but it is a context-dependent mapping few
          accessibility-tree implementations compute, so this is declared rather than assumed. */}
      <summary role="button">Choose a specific machine type</summary>
      {!open ? null : (
        <>
          <p className="hint">
            Pick an exact machine type instead of a size. Selecting one sends this type instead of a size, and
            clears the Size choice above.
          </p>
          <input
            type="search"
            className="machine-picker-search"
            aria-label="Search machine types"
            placeholder="Search by id or region…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="machine-picker-table-wrap">
            <table>
              <caption className="hint">Estimates only — you are billed by the provider, not by Rocky Surf.</caption>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>vCPU</th>
                  <th>Memory</th>
                  <th>Disk</th>
                  <th>Arch</th>
                  <th>Region</th>
                  <th>Price</th>
                  <th>
                    <span className="sr-only">Select</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((offering) => {
                  const asOf = formatPricesAsOf(offering.hourly?.fetchedAt)
                  const selected = offering.id === selectedId
                  return (
                    <tr key={offering.id} className={selected ? 'selected' : ''}>
                      <td>{offering.id}</td>
                      <td>{offering.cpu}</td>
                      <td>{offering.memoryGb} GB</td>
                      <td>{offering.diskGb ? `${offering.diskGb} GB` : '—'}</td>
                      <td>
                        <span className="arch-badge">{archLabel(offering.arch)}</span>
                      </td>
                      <td>{offering.region}</td>
                      <td>
                        {offering.hourly ? (
                          <>
                            {formatHourly(offering.hourly)}
                            {asOf && <div className="hint">{asOf}</div>}
                          </>
                        ) : (
                          // Never blank, never $0 — null means the provider quoted nothing, not free.
                          'price unknown'
                        )}
                      </td>
                      <td>
                        {!offering.available ? (
                          // The provider's own reason where it gives one — Azure says which
                          // quota gate refused (issue #116) — and the generic sentence where
                          // it does not. "Sold out" for a size the subscription has no quota
                          // for would tell the user to wait for stock that never comes.
                          // `.unavailable`, not `.warning`: the latter is a page-level notice
                          // with a border and a rem of padding, and an inline span wearing it
                          // inside a table cell painted a box outside the table (issue #113).
                          <span className="unavailable">{offering.unavailableReason ?? 'sold out right now'}</span>
                        ) : (
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => (selected ? onClear() : onSelect(offering))}
                          >
                            {selected ? 'Selected' : 'Select'}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {hiddenCount > 0 && <p className="hint">{hiddenCount} more — refine your search to see them.</p>}
        </>
      )}
    </details>
  )
}
/** Search-filtered rows rendered before "N more — refine" takes over (see `MachineTypePicker`). */
const MACHINE_PICKER_RENDER_CAP = 50

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
  const [rdpPassword, setRdpPassword] = useState('')
  const [rdpPasswordConfirm, setRdpPasswordConfirm] = useState('')

  /* ---------------------------------------------------------------- submission */
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
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
        const [providerList, packList, setup, tokenScopes] = await Promise.all([
          listProviders(),
          listSurgePacks(),
          // Advisory only, so a failure here must not take the form down with it: the page's
          // job is creating a server, and it can still do that without the diagnosis of a
          // provider that is already missing.
          getSetupState().catch(() => null),
          // Also advisory, and for the same reason: the repository field is free text with or
          // without the picker, so a failed read costs a convenience and not the form.
          listConfiguredScopes().catch(() => []),
        ])
        if (cancelled) return

        setProviders(providerList)
        setScopes(tokenScopes)
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

  // Pack metadata, not pack identity, decides which fields exist.
  const requiresRepos = pack?.requiresRepos ?? false
  const requiresRdp = pack?.requiresRdp ?? false

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
    if (!requiresRepos || unresolved.length === 0) return

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
  }, [repositories, resolutions, requiresRepos])

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
    if (sshKeyOption === 'provide' && !sshPublicKey.trim()) return 'Paste your SSH public key, or let Rocky Surf generate one'
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
        // create for a pack that never asked (issue #90).
        ...(requiresRepos && repositories.length > 0 ? { repositories } : {}),
        ...(createAnyway ? { createAnyway: true } : {}),
        ...(sshKeyOption === 'provide' ? { sshPublicKey: sshPublicKey.trim() } : {}),
        ...(requiresRdp ? { rdpPassword } : {}),
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
        setSubmitError(err.detail)
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
        <section className="resolved-offering" aria-live="polite">
          {resolved ? (
            <>
              <h2>
                {resolved.id} <span className="arch-badge">{archLabel(resolved.arch)}</span>
              </h2>
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

        {/* Conditional on what the PACK declares, never on which pack it is. */}
        {requiresRepos && (
          <div className="form-group">
            <label className="form-label" htmlFor="repositories">
              Repositories
            </label>
            {/* The private-repo sentence is here because the form is where the mistake is made:
                a private URL is accepted, provisioning starts, and the clone fails minutes
                later on the box with nothing on this page having hinted why (rockysurf-f1z1).
                It names `github.pat` in the config file, which is the one place that populates
                the token — not an environment variable core reads, because it reads none
                (rockysurf-yzae wired the config key through; the box end was already done). */}
            <p className="hint">
              One git URL per line, or none at all. They are cloned onto the box during setup.
              Public URLs need no credentials; private repositories need <code>github.pat</code> set
              in <code>rockysurf.config.yaml</code> — see <code>docs/self-hosting.md</code>.
            </p>
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
              <textarea
                aria-label="SSH public key"
                rows={3}
                value={sshPublicKey}
                onChange={(e) => setSshPublicKey(e.target.value)}
                placeholder="ssh-ed25519 AAAA… you@laptop"
              />
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

        {submitError && <p className="error">{submitError}</p>}

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

        <button type="submit" className="btn-primary" disabled={submitting || !resolved}>
          {submitting ? 'Creating…' : 'Create server'}
        </button>
      </form>
    </AppShell>
  )
}
