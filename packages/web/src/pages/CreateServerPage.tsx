import { useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { useNavigate } from 'react-router'
import { Link } from 'react-router'
import {
  ApiError,
  createServer,
  getSetupState,
  listConfiguredScopes,
  listProviders,
  listSurgePacks,
  resolveRepositories,
  type ConfiguredScope,
  type CreateServerRequest,
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
  resolveOffering,
  SIZE_REQUIREMENTS,
  SIZES,
  type Architecture,
  type ServerSize,
} from '../lib/requirements'
import { AppShell } from '../components/AppShell'
import { ProvisioningFeed } from '../components/ProvisioningFeed'
import { useAuth } from '../contexts/AuthContext'

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

/**
 * A tab list, written to the WAI-ARIA tabs pattern by hand (rockysurf-jn71).
 *
 * THE FIRST ONE IN THIS APP, which is why it is a component and not a pair of buttons inline:
 * `role="tab"` without the roving tabindex and the arrow keys is a control that looks like tabs
 * and does not behave like them, and the next screen that wants tabs should copy something that
 * already works. It is deliberately generic — it knows about keys and labels, nothing about
 * packs — so moving it into `components/` the day a second page needs it is a cut and paste.
 *
 * NO DEPENDENCY. The repo has no UI kit, `App.css` is hand-written, and the one widget library
 * anybody has proposed is deferred to v0.2 (rockysurf-57zw); forty lines is not worth a package.
 *
 * AUTOMATIC ACTIVATION — selection follows focus, so an arrow key both moves and switches. The
 * pattern recommends it when the panels are cheap to render, and these are: the panel is a list
 * of radio cards already in memory. Manual activation would mean arrowing then pressing Enter,
 * which is two keystrokes for a control with two positions.
 *
 * ONE PANEL, and both tabs point `aria-controls` at it. There is genuinely one region here whose
 * contents change, so this is a truer description than two panels of which one is unmounted —
 * and it means no tab ever carries an `aria-controls` that resolves to nothing.
 */
function Tabs<K extends string>({
  label,
  panelId,
  tabs,
  active,
  onSelect,
}: {
  label: string
  /** The id of the single `role="tabpanel"` the caller renders below this list. */
  panelId: string
  tabs: readonly { key: K; label: string }[]
  active: K
  onSelect: (key: K) => void
}) {
  const buttons = useRef(new Map<K, HTMLButtonElement | null>())

  // Wraps, because the pattern says a tab list wraps: End-to-Home by arrowing off the edge is
  // the behaviour a keyboard user already has everywhere else.
  const moveTo = (index: number) => {
    const next = tabs[(index + tabs.length) % tabs.length]
    if (!next) return
    onSelect(next.key)
    buttons.current.get(next.key)?.focus()
  }

  return (
    <div className="tablist" role="tablist" aria-label={label}>
      {tabs.map((tab, index) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          id={`${panelId}-tab-${tab.key}`}
          className={`tab ${tab.key === active ? 'selected' : ''}`}
          aria-selected={tab.key === active}
          aria-controls={panelId}
          // Roving tabindex: one stop for the whole list, so Tab moves past the control rather
          // than through every tab in it.
          tabIndex={tab.key === active ? 0 : -1}
          ref={(el) => {
            buttons.current.set(tab.key, el)
          }}
          onClick={() => onSelect(tab.key)}
          onKeyDown={(event) => {
            const to =
              event.key === 'ArrowRight'
                ? index + 1
                : event.key === 'ArrowLeft'
                  ? index - 1
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : null
            if (to === null) return
            event.preventDefault()
            moveTo(to)
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

/** Which tab a pack belongs on. Core's three words, grouped into this screen's two. */
type PackTab = 'official' | 'community'
const tabFor = (pack: SurgePack): PackTab => (pack.provenance === 'official' ? 'official' : 'community')

export function CreateServerPage() {
  const navigate = useNavigate()
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
  const [packId, setPackId] = useState('')
  /**
   * Which shelf of the picker is showing (rockysurf-jn71). NOT part of the request — it decides
   * what is on screen and nothing else, which is the whole point: switching it must never move
   * `packId`.
   */
  const [packTab, setPackTab] = useState<PackTab>('official')
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
  const [createdServerId, setCreatedServerId] = useState<string | null>(null)

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
        if (enabled[0]) {
          setPackId(enabled[0].packId)
          // Open on whichever tab HOLDS the preselection, rather than on Official by rule. The
          // selection rule is untouched — lowest displayOrder, exactly as before — and this only
          // follows it, so an installation whose only enabled packs are contributed ones opens
          // on Community instead of on an Official shelf that does not contain the checked
          // radio (rockysurf-jn71).
          setPackTab(tabFor(enabled[0]))
        }
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

  // Resolve the t-shirt size to a CONCRETE offering, before submit, so the price shown is the
  // price of the machine that will actually be created.
  const resolution = useMemo(() => {
    if (!provider) return null
    return resolveOffering(provider.offerings, { ...SIZE_REQUIREMENTS[size], ...(arch ? { arch } : {}) })
  }, [provider, size, arch])

  const resolved = resolution?.ok ? resolution.offering : null
  const pricesAsOf = formatPricesAsOf(resolved?.hourly?.fetchedAt)

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

  function validate(): string | null {
    if (!providerId) return 'Choose a provider'
    if (!packId) return 'Choose a pack'
    if (!resolution) return 'Choose a provider'
    if (!resolution.ok) return resolution.reason
    if (requiresRepos && repositories.length === 0) return 'This pack needs at least one repository'
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
    setSubmitError(null)
    setRepoErrors([])
    setSubmitting(true)

    try {
      const request: CreateServerRequest = {
        size,
        packId,
        provider: providerId,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        // The offering the user was shown a price for — not whatever core would pick now.
        ...(resolved ? { offeringId: resolved.id, arch: resolved.arch } : {}),
        ...(requiresRepos ? { repositories } : {}),
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

        <fieldset>
          <legend>Size</legend>
          {SIZES.map((option) => {
            const requirements = SIZE_REQUIREMENTS[option]
            return (
              <label key={option} className={`radio-option ${option === size ? 'selected' : ''}`}>
                <input type="radio" name="size" value={option} checked={option === size} onChange={() => setSize(option)} />
                <span className="size-name">{option}</span>
                <span className="size-detail">
                  at least {requirements.vcpu} vCPU · {requirements.memGb} GB RAM
                </span>
              </label>
            )
          })}
        </fieldset>

        {/* Architecture, offered only where the provider actually sells more than one. */}
        {architectures.length > 1 && (
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

        {/* The resolved machine — shown BEFORE submit, with its price and the date of that price. */}
        <section className="resolved-offering" aria-live="polite">
          {resolution?.ok ? (
            <>
              <h2>
                {resolved!.id} <span className="arch-badge">{archLabel(resolved!.arch)}</span>
              </h2>
              <p>
                {resolved!.cpu} vCPU · {resolved!.memoryGb} GB RAM
                {resolved!.diskGb ? ` · ${resolved!.diskGb} GB disk` : ''} · {resolved!.region}
              </p>
              <p className="price">
                <strong>{formatHourly(resolved!.hourly)}</strong>
                {formatMonthly(resolved!.hourly) && <> · about {formatMonthly(resolved!.hourly)}/month if left running</>}
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
            <p className={resolution?.soldOut ? 'warning' : 'error'}>{resolution?.reason ?? 'Choose a provider'}</p>
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
              in Admin → Surge Packs, then reload.
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
                      {/* Admin-aware, because `/admin/pack-shop` is behind `AdminRoute` — a link
                          offered to a member is a link that bounces them back to the dashboard.
                          The member gets the fact instead: somebody else does this. */}
                      {user?.isAdmin ? (
                        <Link to="/admin/pack-shop">Browse the Pack Shop</Link>
                      ) : (
                        <>Your Rocky Surf operator installs packs for this installation.</>
                      )}
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
                    {/*
                      The card image, when the pack names one. Shipped packs point `imageUrl` at a
                      bundled asset; a pack that names none — which is every third-party pack until
                      its author adds one — simply has no image here, and the row still reads
                      correctly. `onError` covers the other half: an imageUrl pointing at something
                      that is not there would otherwise leave a broken-image glyph in the list.
                    */}
                    {option.imageUrl && (
                      <img
                        className="pack-icon"
                        src={option.imageUrl}
                        alt=""
                        loading="lazy"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none'
                        }}
                      />
                    )}
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
              One git URL per line. They are cloned onto the box during setup. Public URLs need no
              credentials; private repositories need <code>github.pat</code> set in{' '}
              <code>rockysurf.config.yaml</code> — see <code>docs/self-hosting.md</code>.
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
                  because push-mode bootstrap installs everything over its own SSH connection. */}
              <p className="hint">
                Rocky Surf also authorizes a key of its own on this box — it installs everything over its own SSH
                connection, so it needs one. Your key is added alongside it, and both will work.
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

        <button type="submit" className="btn-primary" disabled={submitting || !resolution?.ok}>
          {submitting ? 'Creating…' : 'Create server'}
        </button>
      </form>
    </AppShell>
  )
}
