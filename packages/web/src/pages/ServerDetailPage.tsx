import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import toast from 'react-hot-toast'
import { AppShell } from '../components/AppShell'
import { BootstrapReport } from '../components/BootstrapReport'
import { ConfirmModal } from '../components/ConfirmModal'
import { IpChangeAlert } from '../components/IpChangeAlert'
import { Beacon, Lamp, Plate, Swell, Tally } from '../components/etched'
import { StillBillingNotice } from '../components/StillBillingNotice'
import { ToolList } from '../components/ToolList'
import { canStop, useProviderCapabilities } from '../hooks/useProviderCapabilities'
import {
  TRANSITION_STALLED_HINT,
  useServerTransition,
  type TransitionAction,
} from '../hooks/useServerTransition'
import { useServerUpdates } from '../hooks/useServerUpdates'
import {
  ApiError,
  downloadSshKey,
  getServer,
  listSurgePacks,
  startServer,
  stopServer,
  terminateServer,
  updateServer,
  type ProvisioningStep,
  type Server,
  type SurgePack,
} from '../lib/api'
import {
  formatCostCell,
  formatDateTime,
  formatTimestamp,
  formatUptime,
  isProvisioningStep,
  STEP_LABELS,
  STEP_ORDER,
} from '../lib/format'
import { destructiveAction } from '../lib/serverActions'

/**
 * One server: what it is, how to connect to it, and what it is doing right now.
 *
 * Ported from the legacy SPA's server detail page. Three things changed:
 *
 *  - the timeline is fed by `bootstrap-progress` events and a live `bootstrap-log` tail,
 *    which is what core actually emits in both bootstrap modes;
 *  - the remote-desktop instructions are gated on the PACK's `requiresRdp` flag rather than
 *    on `packId === 'open-claw'`, which is the hardcode ADR-0004 added those fields to kill;
 *  - stop/start are gated on provider capability, and spot, resize and billing are gone.
 */
export function ServerDetailPage() {
  const { serverId = '' } = useParams()
  const [server, setServer] = useState<Server | null>(null)
  const [pack, setPack] = useState<SurgePack | null>(null)
  const [logLines, setLogLines] = useState<string[]>([])
  /** One line under the active step while it waits or has gone quiet (#129, #205); cleared by the next event. */
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<'stop' | 'terminate' | null>(null)
  const [editing, setEditing] = useState(false)
  const { byId: capabilities, providers } = useProviderCapabilities()

  const refresh = useCallback(async () => {
    try {
      const next = await getServer(serverId)
      setServer(next)
      setError(null)
      return next
    } catch {
      setError('Could not load this server')
      return null
    } finally {
      setLoading(false)
    }
  }, [serverId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * The stop/start affordance (rockysurf-4t8y).
   *
   * `refresh` is the nudge: it is a plain `GET /servers/:id`, which core answers by syncing the
   * row from the provider — so while this is polling, core is the thing asking AWS, and the
   * `server-status` it broadcasts when the answer changes resolves this page AND every other
   * tab of this user's watching the same box.
   */
  const transition = useServerTransition(server?.status, () => void refresh())

  // The pack tells the page whether this box has a desktop and wants a password — metadata,
  // not a name check.
  useEffect(() => {
    if (!server?.packId) return
    let cancelled = false
    void (async () => {
      try {
        const packs = await listSurgePacks()
        if (!cancelled) setPack(packs.find((p) => p.packId === server.packId) ?? null)
      } catch {
        // The page is still useful without pack metadata; the RDP block simply stays hidden.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [server?.packId])

  useServerUpdates(
    useCallback((event) => {
      if (event.type === 'bootstrap-log') {
        // Bounded: an install can emit thousands of lines and the tail is what anyone reads.
        setLogLines((current) => [...current, event.line ?? ''].slice(-200))
        return
      }
      if (event.type === 'server-status' && (event.status === 'failed' || event.status === 'terminated')) {
        // A terminal frame is the cue to read the row again (ADR-0010): the report, and the
        // verdict on whether the machine still bills, live on the row and not on the frame.
        // Patching only `status` onto the object this page already holds kept the `billing`
        // block from the provisioning phase, and the button below read "Terminate" for a
        // machine core had just released.
        void refresh()
      }
      // Every progress event either carries a reason for waiting or clears the last one.
      if (event.type === 'bootstrap-progress') setNotice(event.notice ?? null)
      setServer((current) => {
        if (!current) return current
        if (event.type === 'server-status') {
          return { ...current, status: event.status, publicIp: event.publicIp ?? current.publicIp }
        }
        if (event.type === 'bootstrap-progress') {
          // Guarded, not cast: a value the timeline cannot place leaves it where it is rather
          // than moving it to nowhere. See `isProvisioningStep`.
          if (!isProvisioningStep(event.step)) return current
          return { ...current, provisioningStep: event.step }
        }
        if (event.type === 'ip-changed') {
          return { ...current, publicIp: event.newIp, previousIp: event.previousIp, ipChangedAt: new Date().toISOString() }
        }
        return current
      })
    }, [refresh]),
    serverId,
  )

  if (loading) return <AppShell title="Server">Loading…</AppShell>
  if (error || !server) {
    return (
      <AppShell title="Server">
        <p role="alert">{error ?? 'Not found'}</p>
        <Link to="/">Back to your servers</Link>
      </AppShell>
    )
  }

  /**
   * A row whose machine is gone (issue #125).
   *
   * `terminated` is the only status this covers, and deliberately not `failed`: a failed box may
   * still be running and billing (ADR-0010), which is why it keeps its Dismiss/Terminate button
   * and its place on the dashboard. `terminated` is absorbing — nothing can start, stop, connect
   * to or rename what no longer exists — so from here the page stops being a control panel and
   * becomes the RECORD of how the box was configured: placement, size, pack, tools,
   * repositories, what its bootstrap did, and what it ended up costing.
   *
   * This is a rendering mode, not a second page. Splitting it out would mean two components
   * drifting over the same row, and the facts a user wants about a dead box are the same facts
   * the live page already shows — minus the ones that need a machine to be true.
   */
  const historical = server.status === 'terminated'
  /**
   * Terminate, or Dismiss for a failed row core already released (ADR-0010). The rule and its
   * wording moved to `lib/serverActions.ts` when the dashboard card had to ask it too (issue
   * #154) — it was implemented here and nowhere else, so the same row read `Dismiss` on this
   * page and `Terminate` on its card.
   */
  const destructive = destructiveAction(server)
  const providerCanStop = canStop(capabilities, server.provider)
  const busy = pending !== null || transition.pending !== null
  const cost = formatCostCell(server)
  // The console link is rendered when core sent one and not otherwise — the page never builds a
  // URL from `server.provider`, for the same reason nothing else in this UI switches on a
  // provider id (ADR-0003, E16). The name beside it is the provider's own `displayName`, so an
  // installation with a provider this build has never heard of still gets a sensible label.
  const providerName = providers.find((p) => p.id === server.provider)?.displayName
  // `-p` only when the box is not on 22, which is every server core provisioned itself.
  const sshPort = server.sshPort ? `-p ${server.sshPort} ` : ''
  const generatedKeyCommand = `ssh ${sshPort}-i ${server.name}.pem ${server.sshUser}@${server.publicIp ?? '<address>'}`
  // When the user supplied a key at create time, it — not the generated `.pem` — is the
  // primary way in (issue #41): Rocky Surf's key is appended alongside it, not substituted,
  // so it stays authorized but is no longer the only path the page leads with. `-i` carries a
  // placeholder because only the user knows where their private key lives (rockysurf-hky6);
  // a bare `ssh` that leaned on agents and default paths read as incomplete rather than clever.
  const sshCommand = server.suppliedSshKey
    ? `ssh ${sshPort}-i <path to your key> ${server.sshUser}@${server.publicIp ?? '<address>'}`
    : generatedKeyCommand
  // Once the supplied key is the ONLY key (issue #92), the generated `.pem` no longer exists —
  // core retired the private half the moment bootstrap confirmed the removal. `suppliedKeyOnly`
  // is absent/false for every box that still has both (no supplied key at all, mid-bootstrap,
  // or one that shipped before this feature), which is exactly when the `.pem` forms below stay
  // correct as written.
  const managedKeyRetired = Boolean(server.suppliedSshKey) && server.suppliedKeyOnly === true
  const identityFlag = managedKeyRetired ? '-i <path to your key> ' : `-i ${server.name}.pem `

  /**
   * The Installed card's two sources, in honesty order (rockysurf-idxd). `server.tools` is
   * the row's own record of what this box was built with — but a create that names only a
   * pack leaves it empty, which rendered the card as a heading over nothing. The pack's
   * expanded tool list is the truthful fallback, caveat stated below where it is used. Names
   * resolve through the pack where they can, and each keeps the url the pack declared — the
   * same "see what you are installing" promise the create page makes.
   */
  const packToolById = new Map((pack?.tools ?? []).map((tool) => [tool.toolId, tool]))
  const recordedTools = server.tools.map(
    (id) => packToolById.get(id) ?? { toolId: id, name: id, url: undefined, description: undefined },
  )
  const installedTools = recordedTools.length > 0 ? recordedTools : (pack?.tools ?? [])

  async function run(action: TransitionAction | 'terminate', call: () => Promise<Server>, done: string) {
    setConfirming(null)
    setPending(action)
    try {
      const accepted = await call()
      // The response IS the fact "the provider took the request" — the only fact anyone has at
      // this point, and the one the page had been throwing away. The row it carries says
      // whether there is anything left to wait for.
      if (action !== 'terminate') transition.begin(action, accepted.status)
      toast.success(done)
      await refresh()
    } catch (err) {
      // See DashboardPage: core's own message is the actionable one for a refused stop/start.
      toast.error(err instanceof ApiError ? err.detail : `Could not ${action} this server`)
    } finally {
      setPending(null)
    }
  }

  return (
    <AppShell title={server.name}>
      {/* Not on a terminated row: "your server's address has changed" is a call to reconnect,
          and there is nothing to reconnect to. The move itself is still history, and the
          Address line below carries it. */}
      {!historical && server.previousIp && server.publicIp && server.ipChangedAt && (
        <IpChangeAlert
          serverId={server.serverId}
          previousIp={server.previousIp}
          currentIp={server.publicIp}
          changedAt={server.ipChangedAt}
        />
      )}

      <section className="server-summary">
        <Lamp status={server.status} transition={transition.pending} />
        {transition.stalled && (
          <p className="hint" role="status">
            {TRANSITION_STALLED_HINT}
          </p>
        )}
        {/*
          Before the facts it qualifies: everything below — status, address, cost — is core's
          last KNOWN state when this is set, and a page that renders the numbers first and the
          caveat later has already been believed (rockysurf-gg9x). Core's message verbatim,
          because the provider wrote the remedy into it.
        */}
        {server.syncError && (
          <p role="alert" className="sync-error" data-testid="sync-error">
            Could not refresh this server from its provider — showing its last known state. {server.syncError}
          </p>
        )}
        {/*
          Said once, at the top, before any of the numbers below it (issue #125): every fact on
          this page is what the row recorded, and none of it is being refreshed from a cloud
          that has nothing left to report. Same placement rule as the stale-view notice above —
          a caveat rendered after the facts it qualifies has already been believed.
        */}
        {historical && (
          <p className="historical-notice" role="status" data-testid="historical-notice">
            This server was terminated{server.terminatedAt ? ` on ${formatDateTime(server.terminatedAt)}` : ''}. Its
            machine and disk are gone; what follows is Rocky Surf's record of how it was configured.
          </p>
        )}
        {/*
          The display fields, editable in place (issue #46). The auto-minted name
          (`server-mt0nilwv`) was the whole report: a fleet of those is a fleet of boxes
          nobody can tell apart. Rename and description are core-side display facts only —
          the provider identity is the server id, so nothing on the cloud moves.

          Read-only once the box is gone: a rename is for telling live boxes apart, and editing
          the record of one that no longer exists rewrites history for no one's benefit. Core
          would still accept the PATCH — ownership is its only gate — so this is the UI declining
          to offer it, not a new rule.
        */}
        {editing && !historical ? (
          <EditDetailsForm
            server={server}
            onCancel={() => setEditing(false)}
            onSaved={(next) => {
              setServer(next)
              setEditing(false)
            }}
          />
        ) : (
          <p className="server-description" data-testid="server-description">
            {server.description ?? <span className="hint">No description.</span>}{' '}
            {!historical && (
              <button type="button" className="link" onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
          </p>
        )}
        <Swell opacity={0.25} />
        <dl>
          <div>
            <dt>{historical ? 'Last address' : 'Address'}</dt>
            <dd>
              {server.publicIp ?? '—'}
              {/* No console link on a terminated row: the instance is not there, so the link
                  leads to a provider page about nothing. */}
              {!historical && server.consoleUrl && (
                <>
                  {' · '}
                  <a href={server.consoleUrl} target="_blank" rel="noopener noreferrer">
                    Open in {providerName ?? 'provider'} console ↗
                  </a>
                </>
              )}
            </dd>
          </div>
          {/* Which cloud, and where on it (issue #125). Obvious on a live box from its address
              and console link, and unanswerable on a dead one from anything but the row —
              which is the whole reason it is now rendered. The provider's own displayName, so
              an installation carrying rows from a provider this build does not enable still
              names it rather than showing a bare id. */}
          <div>
            <dt>Provider</dt>
            <dd data-testid="server-placement">
              {providerName ?? server.provider}
              {server.region && <> · {server.region}</>}
            </dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>
              {/* `'custom'` — created by naming an offering directly (rockysurf-kh3u) — is never
                  rendered as that word: the offering id beside it already says what this box
                  is, and repeating "custom" would say less than omitting it. */}
              {server.size !== 'custom' && <>{server.size} · </>}
              {server.offeringId} · {server.arch}
            </dd>
          </div>
          {/* The pack this box was built from (issue #46) — by name when the pack list has
              it, by id when it doesn't (a pack since deleted still built this box). Linked to
              the catalogue page the nav already offers everyone (rockysurf-idxd), which since
              rockysurf-4d8h is the per-pack detail view rather than the admin table. The slug
              rides along as a title (issue #137): the name is what a reader wants, but the
              slug is what a pack file, a CLI flag and a URL all call this pack, so it stays one
              hover away instead of disappearing once a name is known. */}
          {server.packId && (
            <div>
              <dt>Surge Pack</dt>
              <dd data-testid="server-pack">
                <Link to={`/packs/${server.packId}`} title={pack?.name ? server.packId : undefined}>
                  {pack?.name ?? server.packId}
                </Link>
              </dd>
            </div>
          )}
          {/* The meter stopped when the machine did, so these two read as totals rather than as
              a live count (issue #125). Same numbers, same accrual — only the tense changes. */}
          <div>
            <dt>{historical ? 'Total uptime' : 'Uptime'}</dt>
            {/* Beside the number, never instead of it — uptime has no ceiling, so it is
                counted, not gauged (#174). Same rule as the card. */}
            <dd className="uptime">
              {Number.isFinite(server.totalUptimeSeconds) && (
                <Tally hours={(server.totalUptimeSeconds as number) / 3600} />
              )}
              {formatUptime(server.totalUptimeSeconds)}
            </dd>
          </div>
          <div>
            <dt>{historical ? 'Estimated cost, final' : 'Estimated cost'}</dt>
            <dd title={cost.title}>{cost.text}</dd>
          </div>
          <div>
            <dt>Created</dt>
            {/* The same stamp the card shows (issue #121): two pages disagreeing about how a
                date is written is the drift `lib/format` exists to prevent. */}
            <dd>{formatTimestamp(server.createdAt)}</dd>
          </div>
          {historical && server.terminatedAt && (
            <div>
              <dt>Terminated</dt>
              {/* `formatTimestamp`, like Created directly above it (issue #121): these two
                  bracket the box's life and are read against each other, so a column stamp
                  beside a prose date would make the pair harder to compare than either alone.
                  The prose form belongs in the notice at the top, which is a sentence. */}
              <dd data-testid="server-terminated-at">{formatTimestamp(server.terminatedAt)}</dd>
            </div>
          )}
        </dl>
        {/* The whole account when there is one (ADR-0010); the one-line reason when there is
            not — a failure below the plan, or a row from before reports existed. */}
        {server.bootstrapReport && (server.bootstrapReport.failure || server.bootstrapReport.warnings.length > 0) ? (
          <BootstrapReport report={server.bootstrapReport} />
        ) : (
          server.errorMessage && <p role="alert">{server.errorMessage}</p>
        )}
        {/* After the reason, because "diagnose" only means something once you can read what
            broke — and before the action buttons, which is where "terminate" lives. */}
        <StillBillingNotice server={server} detailed />
      </section>

      {/* Every button is disabled for the whole of a transition, not just for the request: a
          box that is coming up cannot be stopped, and core would refuse with a 409 anyway
          (rockysurf-55fx.15). Offering a button that can only fail is what the 409 message was
          apologising for. */}
      {/* Nothing to act on once the box is gone, so the section itself does not render — an
          empty bordered strip where the buttons used to be reads as a control panel whose
          controls failed to load (issue #125). */}
      {!historical && (
        <section className="server-actions">
          {providerCanStop && server.status === 'running' && (
            <button className="stop-action" disabled={busy} onClick={() => setConfirming('stop')}>
              {transition.pending === 'stop' || pending === 'stop' ? 'Stopping…' : 'Stop'}
            </button>
          )}
          {providerCanStop && server.status === 'stopped' && (
            <button disabled={busy} onClick={() => void run('start', () => startServer(server.serverId), 'Starting')}>
              {transition.pending === 'start' || pending === 'start' ? 'Starting…' : 'Start'}
            </button>
          )}
          {/* No `status !== 'terminated'` guard of its own any more: `historical` above IS that
              condition, and the section it gates does not render at all for a box that is gone.
              A failed row whose machine core already released has nothing left to terminate
              either — the button clears the row, and says so (ADR-0010). Same call underneath,
              because core's terminate is idempotent. */}
          <button className="destructive" disabled={busy} onClick={() => setConfirming('terminate')}>
            {destructive.label}
          </button>
        </section>
      )}

      {server.status === 'provisioning' && (
        <ProvisioningTimeline current={server.provisioningStep} notice={notice} logLines={logLines} />
      )}

      {server.status === 'running' && (
        <section className="connection">
          <h2>Connect</h2>
          <pre>
            <code>{sshCommand}</code>
          </pre>
          {server.suppliedSshKey ? (
            <>
              <p className="hint" data-testid="supplied-key-hint">
                Connects with the key you supplied at create time
                {server.suppliedSshKey.comment ? ` (${server.suppliedSshKey.comment})` : ''}, fingerprint{' '}
                <code>{server.suppliedSshKey.fingerprint}</code>.
              </p>
              {/*
                Demoted, not removed, UNLESS it has actually been retired (issue #41, then
                issue #92). Rocky Surf's own key stays authorized through bootstrap no matter
                which SSH option was picked at create time — push-mode bootstrap installs
                everything over its own connection and needs it regardless — and while that is
                true this disclosure is the recovery path if the user's own key is ever lost.
                Once bootstrap's last step removes it, core also retires the stored private
                half, so there is nothing left here to disclose or download.
              */}
              {!managedKeyRetired && (
                <details className="own-key-disclosure">
                  <summary>Rocky Surf's own key</summary>
                  <p className="hint">
                    Rocky Surf also authorizes a key of its own on this box — it installs everything over its own
                    SSH connection, so it needs one whether or not you supplied your own. It works too, and it is
                    the way back in if you ever lose your key:
                  </p>
                  <pre>
                    <code>{generatedKeyCommand}</code>
                  </pre>
                  <button
                    onClick={() => void downloadSshKey(server.serverId, server.name).catch(() => toast.error('No key available'))}
                  >
                    Download {server.name}.pem
                  </button>
                  <p className="hint">
                    Core keeps a copy and every download is recorded; re-downloading later is fine. Store it
                    somewhere safe and <code>chmod 600</code> it before use.
                  </p>
                </details>
              )}
            </>
          ) : (
            <>
              <button
                onClick={() => void downloadSshKey(server.serverId, server.name).catch(() => toast.error('No key available'))}
              >
                Download {server.name}.pem
              </button>
              <p className="hint">
                Core keeps a copy and every download is recorded; re-downloading later is fine. Store it somewhere
                safe and <code>chmod 600</code> it before use.
              </p>
            </>
          )}

          {/*
            The tunnel, IN CONNECT, for a pack that declares a web UI (rockysurf-bbmi). The
            guide already opens with this command, but the owner's own test showed what a
            wall of text does to it: they ran the plain command above, found no way to reach
            the UI, and concluded the pack needed a GUI. The one line that changes how you
            connect belongs where connecting is explained — gated on pack metadata, not on
            the pack's name, exactly like the RDP block below.
          */}
          {pack?.webPort && (
            <div className="web-ui-instructions">
              <h3>Web UI</h3>
              <p>
                {pack.name} serves a web UI on the box's loopback only, so connect with the port
                forwarded — use this instead of the plain command above:
              </p>
              <pre>
                <code>{`ssh ${sshPort}${identityFlag}-L ${pack.webPort}:127.0.0.1:${pack.webPort} ${server.sshUser}@${server.publicIp ?? '<address>'}`}</code>
              </pre>
              <p className="hint">
                Leave that session open, then open http://localhost:{pack.webPort} in the browser on
                your own machine. The guide below says how to start the UI on the box.
              </p>
            </div>
          )}

          {/* Gated on pack metadata, not on the pack's name. */}
          {pack?.requiresRdp && (
            <div className="rdp-instructions">
              <h3>Remote desktop</h3>
              <p>Tunnel the desktop port over SSH, then point your RDP client at localhost:</p>
              <pre>
                <code>{`ssh ${sshPort}${identityFlag}-L 3389:localhost:3389 ${server.sshUser}@${server.publicIp ?? '<address>'}`}</code>
              </pre>
              <p className="hint">Sign in as {server.sshUser} with the password you set when you created the server.</p>
              {/*
                THE RECOVERY PATH, not the password (rockysurf-z0wf). Rocky Surf will not show
                you the password, and the reason is not only custody: the stored copy is a
                record of what was DELIVERED at create time, so the moment anyone runs
                `passwd` on the box it is wrong, and a panel confidently displaying a stale
                secret is worse than one that displays none. Resetting it is one command over
                a connection the user already has.
              */}
              <p className="hint">
                Forgotten it? Rocky Surf will not show it to you — SSH in with the key above and set a new one:
                <code> sudo passwd {server.sshUser}</code>
              </p>
            </div>
          )}
        </section>
      )}

      {/*
        The pack's own post-boot instructions (rockysurf-7ckx): what the install could not do
        for the user, which on every shipped pack is "authenticate the agents". Beside Connect
        rather than inside it, because Connect is about reaching the box and this is about what
        to do once you are on it.

        Rendered as TEXT inside a <pre>. The guide is pack-authored content and a pack may come
        from a stranger's pull request or an imported URL, so it goes through React's escaping
        like every other pack field on this page — no markdown parser, no dangerouslySetInnerHTML.
        A pack with no guide (every third-party one, until its author writes one) renders nothing.
      */}
      {server.status === 'running' && pack?.guide && (
        <section className="pack-guide">
          <h2>Getting started with {pack.name}</h2>
          {/*
            Not "run these on the box": that claim was false for any pack whose first step is
            an `ssh -L` from the user's laptop, and it contradicted the guide it was
            introducing (rockysurf-bbmi).
          */}
          <p className="hint">
            Written by the pack. Most steps run on the box once you are connected; where one runs
            on your own machine instead, the guide says which.
          </p>
          <pre className="pack-guide-text">{pack.guide}</pre>
        </section>
      )}

      <section className="repositories">
        <h2>Repositories</h2>
        {server.repositories.length === 0 ? (
          // "Yet" is a promise, and there is no later for a box that is gone.
          <p>{historical ? 'None.' : 'None yet.'}</p>
        ) : (
          <ul>
            {server.repositories.map((repo) => (
              <li key={repo}>
                <code>{repo}</code>
              </li>
            ))}
          </ul>
        )}
        {/*
          WHICH GIT TOKENS THIS BOX HOLDS (rockysurf-18lq), and the trade that comes with the
          answer being short.

          A box is built with the tokens its declared repositories selected and no others, which
          is a smaller blast radius and also a smaller box: there is no way to push a token to a
          machine after it is built, so a repository cloned by hand later has only whatever the
          instance-wide token covers. Saying so here is the honest half of the feature — the
          remedy really is terminate and recreate, and a user who learns that from a failed clone
          on the box has already paid for it.
        */}
        {server.githubTokenScopes !== undefined && (
          <div className="server-tokens" data-testid="github-token-scopes">
            {server.githubTokenScopes.length > 0 ? (
              <p>
                Git tokens on this box:{' '}
                {server.githubTokenScopes.map((scope, index) => (
                  <span key={scope}>
                    {index > 0 && ', '}
                    <code>{scope}</code>
                  </span>
                ))}
                {server.carriesFallbackToken && (
                  <>
                    , and the instance-wide <code>github.pat</code>
                  </>
                )}
                .
              </p>
            ) : (
              <p>
                {server.carriesFallbackToken ? (
                  <>
                    This box carries only the instance-wide <code>github.pat</code> — no repository-scoped token
                    matched what it was created with.
                  </>
                ) : (
                  <>This box carries no git tokens.</>
                )}
              </p>
            )}
            <p className="hint">
              Tokens are chosen at create from the repositories above, and there is no way to add one to a
              running box. Cloning a private repository none of these covers means terminating and recreating
              with it declared, or authenticating that clone by hand.
            </p>
          </div>
        )}
        {/*
          No "Add a repository" button, on purpose (rockysurf-8z4r). It POSTed to a route core
          never had, and the hint above it already tells the truth 18lq shipped: tokens are
          chosen at create, and nothing can push one to a running box. Adding a repository
          after the fact is a bootstrap concern — a clone step pushed to the box — not a row
          edit; if that feature is built, it enters through the bootstrap pipeline, not here.
        */}
      </section>

      {/*
        WHAT THIS BOX WAS CONFIGURED WITH (issues #189, #197).

        Two sources, one section, and the section says which is which: the pack asked for one
        set and the creator typed the other, and after the create screen is gone this page is the
        only thing that remembers either. Secret values are in neither list and are returned by
        no route at all — saying so out loud is the honest half, because nothing can show them
        back and the remedy for a lost one is a new box.

        Absent entirely for a box with neither, which is every box built before this existed.
      */}
      {(server.packInputs || server.environment) && (
        <section className="server-environment">
          <h2>Configuration</h2>
          {server.packInputs && (
            <>
              <p className="hint">{pack ? `Settings the ${pack.name} pack asked for.` : 'Settings the pack asked for.'}</p>
              <ul data-testid="pack-inputs">
                {Object.entries(server.packInputs).map(([name, value]) => (
                  <li key={name}>
                    <code>{name}</code>=<code>{value}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          {server.environment && (
            <>
              <p className="hint">Environment you set when you created this box.</p>
              <ul data-testid="server-environment">
                {Object.entries(server.environment).map(([name, value]) => (
                  <li key={name}>
                    <code>{name}</code>=<code>{value}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="hint">
            Values marked secret are stored encrypted and are shown by nothing, here or anywhere else. There is no way
            to change any of these on a running box — the environment is written once, when the box is built.
          </p>
        </section>
      )}

      <section className="tools">
        <h2>Installed</h2>
        {installedTools.length === 0 ? (
          <p className="hint">Nothing recorded for this box.</p>
        ) : (
          <ToolList tools={installedTools} testId="installed-tools" />
        )}
        {recordedTools.length === 0 && installedTools.length > 0 && pack && (
          <p className="hint">
            From the {pack.name} pack. A pack edited since this box booted describes the pack, not
            necessarily the box.
          </p>
        )}
      </section>

      {confirming === 'stop' && (
        <ConfirmModal
          title={`Stop ${server.name}?`}
          message="The disk is kept, so you can start it again later."
          confirmLabel="Stop"
          onCancel={() => setConfirming(null)}
          onConfirm={() => void run('stop', () => stopServer(server.serverId), 'Stopping')}
        />
      )}
      {confirming === 'terminate' && (
        <ConfirmModal
          title={destructive.confirmTitle}
          message={destructive.confirmMessage}
          confirmLabel={destructive.label}
          isDestructive
          onCancel={() => setConfirming(null)}
          onConfirm={() =>
            // One call for both endings: core's terminate is idempotent, so clearing a row
            // whose machine is already gone is the same request (ADR-0010).
            void run(
              'terminate',
              () => terminateServer(server.serverId),
              destructive.label === 'Dismiss' ? 'Dismissed' : 'Terminating',
            )
          }
        />
      )}
    </AppShell>
  )
}

/**
 * The bootstrap timeline.
 *
 * Steps come from core's `reports` vocabulary, which is lossy on purpose — several plan steps
 * share one label — so this shows progress through the labels and puts the live log
 * underneath for anyone who needs to know which step is actually running.
 */
function ProvisioningTimeline({
  current,
  notice,
  logLines,
}: {
  current?: ProvisioningStep
  notice?: string | null
  logLines: string[]
}) {
  return (
    // On a plate of its own, like every other block on this page (ui_kits/etched): the beam
    // needs a frame to be read against, and unframed it floated between two cards.
    <Plate as="section" className="provisioning-timeline">
      <h2>Setting up</h2>
      {/* The beam (#174): `Beacon` still emits `.step-list` + `.step-<state>` + `data-state`,
          the vocabulary the stylesheet and the tests read (rockysurf-xinr), and reads its steps
          and labels from `lib/format` rather than carrying a third copy. An unrecognised
          `current` leaves it where it is rather than resetting it — see `isProvisioningStep`. */}
      <Beacon current={current} steps={STEP_ORDER} labels={STEP_LABELS} notice={notice} />
      {logLines.length > 0 && (
        <details open>
          <summary>Install log</summary>
          <pre className="install-log" data-testid="install-log">
            {logLines.join('\n')}
          </pre>
        </details>
      )}
    </Plate>
  )
}

/**
 * Name and description, edited together (issue #46).
 *
 * One form rather than two pencils because they are the same kind of fact — the user's own
 * words about the box — and a save is one PATCH either way. The response replaces the page's
 * row wholesale, so the title, the pem-download label and this section all move at once.
 */
function EditDetailsForm({
  server,
  onCancel,
  onSaved,
}: {
  server: Server
  onCancel: () => void
  onSaved: (next: Server) => void
}) {
  const [name, setName] = useState(server.name)
  const [description, setDescription] = useState(server.description ?? '')
  const [saving, setSaving] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    try {
      // Description always travels: '' is a real instruction — "clear it" — not an omission.
      onSaved(await updateServer(server.serverId, { name: name.trim(), description: description.trim() }))
      toast.success('Details saved')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.detail : 'Could not save the details')
      setSaving(false)
    }
  }

  return (
    <form className="server-edit" data-testid="edit-details" onSubmit={submit}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={63} />
      </label>
      <label>
        Description
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
          placeholder="What is this box for?"
        />
      </label>
      <button type="submit" disabled={saving || !name.trim()}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      <button type="button" onClick={onCancel} disabled={saving}>
        Cancel
      </button>
    </form>
  )
}
