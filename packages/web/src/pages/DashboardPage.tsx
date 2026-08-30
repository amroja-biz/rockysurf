import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import toast from 'react-hot-toast'
import { ActivityFeed } from '../components/ActivityFeed'
import { BackupReminder } from '../components/BackupReminder'
import { warningsSummary } from '../components/BootstrapReport'
import { ConfirmModal } from '../components/ConfirmModal'
import { IpChangeAlert } from '../components/IpChangeAlert'
import { PackIcon } from '../components/PackIcon'
import { AppShell } from '../components/AppShell'
import { StaleServersNotice } from '../components/StaleServersNotice'
import { Tabs } from '../components/Tabs'
import { Lamp, Plate, Shore, Swell, Tally } from '../components/etched'
import { StillBillingNotice } from '../components/StillBillingNotice'
import { SyncErrorNotice } from '../components/SyncErrorNotice'
import { canStop, useProviderCapabilities } from '../hooks/useProviderCapabilities'
import {
  TRANSITION_STALLED_HINT,
  useServerTransition,
  type TransitionAction,
} from '../hooks/useServerTransition'
import { useServerUpdates } from '../hooks/useServerUpdates'
import {
  ApiError,
  getServer,
  listServers,
  listSurgePacks,
  startServer,
  stopServer,
  terminateServer,
  type ProviderCapabilities,
  type ProviderInfo,
  type Server,
  type ServerSummary,
  type SurgePack,
} from '../lib/api'
import { formatCostCell, formatTimestamp, formatUptime, STEP_LABELS } from '../lib/format'
import { destructiveAction } from '../lib/serverActions'

/**
 * The server list.
 *
 * Ported from the legacy SPA's dashboard page. What changed and why:
 *
 *  - **Action gating is capability-driven.** The old card computed `canStop =
 *    !server.spotInstance && status === 'running'` — a fact about one cloud's billing model
 *    hard-coded into a component. It now asks the provider registry whether this server's
 *    provider can stop an instance at all.
 *  - **Billing, spot and limits are gone**, along with the banner, the interruption warning
 *    and the "you have reached your server limit" gate.
 *  - **Live updates use core's event vocabulary** (`server-status`, `bootstrap-progress`),
 *    not the legacy `provisioning-progress`.
 */
export function DashboardPage() {
  const [servers, setServers] = useState<ServerSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [packById, setPackById] = useState<Map<string, SurgePack>>(new Map())
  const { byId: capabilities, providers } = useProviderCapabilities()
  /**
   * Which cloud's tab is open lives in the URL, the same way the packs page keeps `?tab=`
   * (issue #204): a pasted link opens the same cloud, and `replace` keeps switching out of
   * history. A value naming no tab falls back to the first cloud that has a box on it.
   */
  const [searchParams, setSearchParams] = useSearchParams()

  const refresh = useCallback(async () => {
    try {
      setServers(await listServers())
      setError(null)
    } catch {
      setError('Could not load your servers')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * Read ONE row again, in place (issue #154).
   *
   * A single-server `getServer`, not `refresh()`, for the reason the card's transition nudge
   * gives below: a list refresh syncs every row this user has against its provider, which is a
   * lot of cloud calls to learn about one box. A read that fails changes nothing — the frame
   * has already patched the status, and a card showing last-known state beats a card that
   * blanks because one GET did.
   */
  const refreshRow = useCallback(async (serverId: string) => {
    try {
      const row = await getServer(serverId)
      setServers((current) => current.map((server) => (server.serverId === serverId ? row : server)))
    } catch {
      // Deliberately silent: nothing the user can act on, and the row still reads what it read.
    }
  }, [])

  /**
   * Pack names for the cards (issue #137): fetched once, not per card, and matched by id — the
   * same "id first, name once the list answers" shape `ServerDetailPage` already uses. A pack
   * since deleted just leaves its id out of the map, and the card falls back to `packId`.
   */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const packs = await listSurgePacks()
        if (!cancelled) setPackById(new Map(packs.map((p: SurgePack) => [p.packId, p])))
      } catch {
        // The cards are still useful without pack names; they fall back to showing the id.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Live updates, applied in place.
   *
   * Patching the row rather than refetching the list is deliberate: a provisioning server
   * emits a step every few seconds, and refetching on each one would make the page flicker
   * and hammer core for a field it just told us.
   *
   * A TERMINAL FRAME IS THE EXCEPTION (ADR-0010, issue #154), the same exception the detail
   * page makes. The frame carries a status and nothing else, while the verdict on whether the
   * machine still exists — `billing`, which decides whether this card's button says Terminate
   * or Dismiss — lives on the row. Patching `status: 'failed'` onto the object this page holds
   * left the provisioning-time billing block on it, so the card offered to Terminate a machine
   * core had already released. It is one read of one row, on an event that arrives once.
   */
  useServerUpdates(
    useCallback((event) => {
      if (event.type === 'server-status' && (event.status === 'failed' || event.status === 'terminated')) {
        void refreshRow(event.serverId)
      }
      setServers((current) =>
        current.map((server) => {
          if (server.serverId !== event.serverId) return server
          if (event.type === 'server-status') {
            return { ...server, status: event.status, publicIp: event.publicIp ?? server.publicIp }
          }
          if (event.type === 'bootstrap-progress') {
            return { ...server, provisioningStep: event.step as ServerSummary['provisioningStep'] }
          }
          if (event.type === 'ip-changed') {
            return { ...server, publicIp: event.newIp, previousIp: event.previousIp, ipChangedAt: new Date().toISOString() }
          }
          return server
        }),
      )
    }, [refreshRow]),
  )

  const live = servers.filter((server) => server.status !== 'terminated')
  const groups = groupByProvider(live, providers)
  const requested = searchParams.get(PROVIDER_TAB_PARAM)
  const activeGroup =
    groups.find((group) => group.id === requested) ?? groups.find((group) => group.servers.length > 0) ?? groups[0]
  const openTab = (id: string) => {
    const next = new URLSearchParams(searchParams)
    next.set(PROVIDER_TAB_PARAM, id)
    setSearchParams(next, { replace: true })
  }

  /**
   * One notice per provider whose view is stale, not one per row (rockysurf-gg9x): the cause
   * — expired credentials, a cloud outage — is per-cloud, and a user with five boxes on it
   * needs one explanation, not five copies. The message is core's verbatim, because the
   * provider wrote the remedy into it: for an expired login, the exact command to run.
   */
  const staleProviders = [
    ...new Map(live.filter((s) => s.syncError).map((s) => [s.provider, s.syncError!])).entries(),
  ]

  return (
    <AppShell title="Servers">
      {/*
        Dashboard is where a session lands (rockysurf-prqc, issue #89): `/` is the only route
        every sign-in reaches before anything else, so it is the one place a reminder shown
        "once per app load" actually means once, rather than once per page.
      */}
      <BackupReminder />
      {/*
        Near the server list, not inside it (issue #126): the notice is about what the list
        as a whole can and can't promise, so it sits above the cards rather than inside
        `ServerCard` or the grouping logic below, both of which belong to other in-flight work.
      */}
      <StaleServersNotice />

      <div className="dashboard-actions">
        <Link className="button primary new-action" to="/servers/new">
          New server
        </Link>
      </div>

      {loading && <p>Loading your servers…</p>}
      {/* The list did not load at all — a refusal, and it takes the red the `SyncErrorNotice`
          below it takes yellow for: that one is a stale list, this one is no list (issue #216). */}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {staleProviders.map(([providerId, message]) => (
        <SyncErrorNotice
          key={providerId}
          testId={`sync-error-${providerId}`}
          lead={`Could not refresh your ${providers.find((p) => p.id === providerId)?.displayName ?? providerId} servers — showing their last known state.`}
          message={message}
        />
      ))}
      {!loading && !error && live.length === 0 && (
        <Shore>
          No servers yet. <Link to="/servers/new">Create one</Link> to get started.
        </Shore>
      )}

      {/*
        One tab per cloud (after the one-heading-per-cloud grouping of issue #121): every
        configured provider gets a tab even with nothing on it, so the page also says where a
        box COULD go, and a cloud the provider list has never heard of still gets one from the
        rows that name it. The count beside the name carries the only state that matters at a
        glance — green if anything on that cloud is running, yellow if boxes are there but none
        is, plain for none at all.
      */}
      {activeGroup && (
        <>
          <Tabs
            label="Cloud providers"
            panelId="fleet"
            className="provider-tabs"
            tabs={groups.map((group) => ({
              key: group.id,
              label: (
                <>
                  {group.label}
                  <span className="provider-tab-count" data-tone={fleetTone(group.servers)}>
                    {group.servers.length}
                  </span>
                </>
              ),
              controls: `fleet-panel-${group.id}`,
            }))}
            active={activeGroup.id}
            onSelect={openTab}
          />
          <Swell opacity={0.3} />
          <section
            className="provider-group"
            role="tabpanel"
            id={`fleet-panel-${activeGroup.id}`}
            aria-labelledby={`fleet-tab-${activeGroup.id}`}
            data-testid={`provider-group-${activeGroup.id}`}
          >
            {activeGroup.servers.length === 0 && live.length > 0 ? (
              <Shore>
                Nothing on {activeGroup.label}. <Link to="/servers/new">Create a server</Link> there.
              </Shore>
            ) : (
              <div className="server-grid">
                {activeGroup.servers.map((server) => (
                  <ServerCard
                    key={server.serverId}
                    server={server}
                    capabilities={capabilities}
                    pack={server.packId ? packById.get(server.packId) : undefined}
                    onChanged={refresh}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <ActivityFeed servers={servers} />
    </AppShell>
  )
}

/** The bucket a row lands in when it names no provider at all — see `groupByProvider`. */
const UNGROUPED = '__none__'
const PROVIDER_TAB_PARAM = 'provider'

/** What the count on a cloud's tab says about it: something running, boxes but none up, or none. */
export function fleetTone(servers: ServerSummary[]): 'running' | 'stopped' | 'empty' {
  if (servers.some((server) => server.status === 'running')) return 'running'
  return servers.length > 0 ? 'stopped' : 'empty'
}

/**
 * The fleet, split by the cloud each box is on (issue #121).
 *
 * The page listed every server in one grid and never said which cloud any of them was on, so a
 * fleet spread over three providers read as one undifferentiated wall of cards — the fact was
 * on the row the whole time. A heading per cloud says it once for a group rather than repeating
 * a badge on every card, and it gives the answer at the altitude the question is asked at:
 * "what do I have running on Azure" is a question about a group, not about a row.
 *
 * NAMES COME FROM THE PROVIDER LIST, ids are the fallback. `displayName` is what every other
 * page calls a cloud, and a row whose provider is not in that list — a bring-your-own box, or a
 * cloud the operator has since removed from their config — is a row this page must still show.
 * It groups under its own id rather than disappearing into an "unknown" bucket that would hide
 * which cloud it actually was; only a row naming NO provider gets the generic heading.
 *
 * Ordering is by name, with the nameless group last, so the page does not reshuffle itself when
 * a create lands or a terminate removes the last box on some cloud.
 */
export function groupByProvider(
  servers: ServerSummary[],
  providers: ProviderInfo[],
): Array<{ id: string; label: string; servers: ServerSummary[] }> {
  // Every configured cloud is a bucket before any row is read, so a cloud with nothing on it
  // still gets its tab (and its zero).
  const buckets = new Map<string, ServerSummary[]>(providers.map((p) => [p.id, []]))
  for (const server of servers) {
    const id = server.provider || UNGROUPED
    const bucket = buckets.get(id)
    if (bucket) bucket.push(server)
    else buckets.set(id, [server])
  }

  return [...buckets.entries()]
    .map(([id, rows]) => ({
      id,
      label: id === UNGROUPED ? 'Other' : (providers.find((p) => p.id === id)?.displayName ?? id),
      servers: rows,
    }))
    .sort((a, b) => {
      if (a.id === UNGROUPED) return 1
      if (b.id === UNGROUPED) return -1
      return a.label.localeCompare(b.label)
    })
}

type PendingAction = TransitionAction | 'terminate'

function ServerCard({
  server,
  capabilities,
  pack,
  onChanged,
}: {
  server: ServerSummary
  capabilities: Map<string, ProviderCapabilities>
  /** The pack itself, when the dashboard's pack list still has it (issue #137): its name for
   *  the Pack row, its mark for the corner. */
  pack?: SurgePack
  onChanged: () => void | Promise<void>
}) {
  const [pending, setPending] = useState<PendingAction | null>(null)
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState<'stop' | 'terminate' | null>(null)

  /**
   * The same in-flight affordance the detail page shows (rockysurf-4t8y), because this is the
   * other place the pill and the buttons live — the owner's Start click is as likely to happen
   * here as there.
   *
   * The nudge is a single-server `getServer`, not `onChanged()`: a list refresh syncs every
   * row this user has against its provider, which is a lot of cloud calls to make every few
   * seconds to learn about one box. Core syncs the row it is asked for and broadcasts the
   * change, so the card is usually updated by the stream before this even returns; the explicit
   * `onChanged()` is what keeps the card correct on a tab whose stream has dropped.
   */
  const transition = useServerTransition(server.status, async () => {
    const next = await getServer(server.serverId)
    if (next.status !== server.status) await onChanged()
  })

  // Capability first, then state. A provider that cannot stop an instance never offers the
  // button, whatever the server is doing.
  const providerCanStop = canStop(capabilities, server.provider)
  const showStop = providerCanStop && server.status === 'running'
  const showStart = providerCanStop && server.status === 'stopped'
  const showTerminate = server.status === 'running' || server.status === 'stopped' || server.status === 'failed'
  /**
   * Terminate, or Dismiss for a failed row whose machine core already released (issue #154).
   *
   * The rule and the wording come from `lib/serverActions.ts` because the detail page asks the
   * same question of the same row — this card said "Terminate" for a box the detail page said
   * "Dismiss" for, which is a promise to destroy something that no longer exists.
   */
  const destructive = destructiveAction(server)
  const busy = pending !== null || transition.pending !== null
  const cost = formatCostCell(server)

  async function run(action: PendingAction, call: () => Promise<Server>, done: string) {
    setConfirming(null)
    setPending(action)
    try {
      const accepted = await call()
      // The accepted response is the only fact there is at this point: the provider has the
      // request, and the row still reads what it read before the click.
      if (action !== 'terminate') transition.begin(action, accepted.status)
      toast.success(done)
      await onChanged()
    } catch (err) {
      // Core's message when it has one. A refused stop/start is usually a transient state the
      // user can act on — "server is still stopping; try again in a moment" (rockysurf-55fx.15)
      // — and `Could not stop dev-box` throws that away and leaves them guessing.
      toast.error(err instanceof ApiError ? err.detail : `Could not ${action} ${server.name}`)
    } finally {
      setPending(null)
    }
  }

  return (
    // The card is a Plate (#174): same element, same class, same `data-status` the stylesheet
    // and the tests read. Lit only while the box is genuinely live — every plate lit is none.
    <Plate
      as="article"
      className="server-card"
      data-status={server.status}
      lit={server.status === 'running'}
      onClick={(event) => {
        // The whole card goes to the detail page, not just the name: a card that lights up
        // under the pointer promises to be clickable. Not a wrapping <a>, because the card
        // holds buttons and a confirm dialog, and a link around a button is neither valid nor
        // what a click on Terminate means — so a click that landed on any control, or on the
        // dialog, or that was really a text selection, is left alone. The name keeps its own
        // link for middle-click, cmd-click and a screen reader.
        const target = event.target as HTMLElement
        if (target.closest('a, button, input, select, textarea, [role="dialog"]')) return
        if (window.getSelection()?.toString()) return
        navigate(`/servers/${server.serverId}`)
      }}
    >
      {server.previousIp && server.publicIp && server.ipChangedAt && (
        <IpChangeAlert
          serverId={server.serverId}
          previousIp={server.previousIp}
          currentIp={server.publicIp}
          changedAt={server.ipChangedAt}
        />
      )}

      <header className="server-card-head">
        <div>
          <h3>
            <Link to={`/servers/${server.serverId}`}>{server.name}</Link>
          </h3>
          <Lamp status={server.status} transition={transition.pending} />
        </div>
        {/* The pack's mark in the corner the header leaves empty: the same image or monogram
            the packs page and the create form show, so a box reads as "a Headlong box" at a
            glance rather than only in the Pack row below. Nothing until the pack list has
            answered — a monogram that turns into an image a beat later is a flicker. */}
        {pack && (
          <span className="server-card-pack" title={pack.name} data-testid="card-pack-icon">
            <PackIcon pack={pack} />
          </span>
        )}
      </header>

      {transition.stalled && (
        <p className="hint" role="status">
          {TRANSITION_STALLED_HINT}
        </p>
      )}

      {/*
        The reason before the notice, same order as the detail page (rockysurf-edbf): the notice
        says "terminate or diagnose", and "diagnose" is only an instruction once the card has said
        what broke. Without this line a failed row was a red pill and nothing else — the reason was
        in the row all along, and only the page the user was not on rendered it.
      */}
      {/*
        `title` carries the whole message because the card shows only its first lines: a
        provider's refusal can be a page of prose (issue #128), and the account of it belongs on
        the detail page this card links to.
      */}
      {server.errorMessage && (
        <p role="alert" className="server-card-error" title={server.errorMessage}>
          {server.errorMessage}
        </p>
      )}

      {/*
        A box that came up with something missing (ADR-0010) — a repository that did not clone.
        One line here; the detail page carries the account. Without it a `Running` pill on a
        box that is missing the repository the user asked for reads as "all good".
      */}
      {server.status === 'running' && warningsSummary(server.bootstrapReport) && (
        <p className="bootstrap-warnings-note" role="status">
          {warningsSummary(server.bootstrapReport)} — <Link to={`/servers/${server.serverId}`}>see why</Link>
        </p>
      )}

      {/*
        Above the meta list, deliberately: it is the explanation for the two numbers below it.
        A `Failed` pill beside `Uptime 2h / $0.02` reads as a contradiction until this says why.
      */}
      <StillBillingNotice server={server} />

      {server.status === 'provisioning' && server.provisioningStep && (
        <p className="provisioning-step">{STEP_LABELS[server.provisioningStep] ?? server.provisioningStep}</p>
      )}

      {/* The rule between what the box is doing and what it is — in the illustration's hand,
          quiet enough not to compete with the plate's own frame (ui_kits/etched). */}
      <Swell opacity={0.22} />
      <dl className="server-meta">
        <div>
          <dt>Address</dt>
          <dd>{server.publicIp ?? '—'}</dd>
        </div>
        {/* By name when the dashboard's pack list has it, by id when it doesn't — a pack since
            deleted still built this box (issue #137). Same fallback rule as the detail page's
            Surge Pack line, one row here because the card has no room for a link and a byline. */}
        {server.packId && (
          <div>
            <dt>Pack</dt>
            <dd data-testid="card-pack" title={pack ? server.packId : undefined}>
              {pack?.name ?? server.packId}
            </dd>
          </div>
        )}
        <div>
          <dt>Uptime</dt>
          {/* The tally sits BESIDE the number, never instead of it: uptime has no ceiling, so
              it is counted, not gauged. Only when core sent a number — a dash gets no strokes. */}
          <dd className="uptime">
            {Number.isFinite(server.totalUptimeSeconds) && (
              <Tally hours={(server.totalUptimeSeconds as number) / 3600} />
            )}
            {formatUptime(server.totalUptimeSeconds)}
          </dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd title={cost.title}>{cost.text}</dd>
        </div>
        {/*
          When this box was started (issue #121). Uptime above says how long it has been up,
          which is a different fact on a box that has been stopped and started again — the one
          the owner uses to tell this morning's experiment from the one they left running last
          week.
        */}
        <div>
          <dt>Created</dt>
          <dd>{formatTimestamp(server.createdAt)}</dd>
        </div>
      </dl>

      <footer className="server-card-actions">
        {showStop && (
          <button className="stop-action" disabled={busy} onClick={() => setConfirming('stop')}>
            {pending === 'stop' || transition.pending === 'stop' ? 'Stopping…' : 'Stop'}
          </button>
        )}
        {showStart && (
          <button
            disabled={busy}
            onClick={() => void run('start', () => startServer(server.serverId), `${server.name} is starting`)}
          >
            {pending === 'start' || transition.pending === 'start' ? 'Starting…' : 'Start'}
          </button>
        )}
        {showTerminate && (
          <button className="destructive" disabled={busy} onClick={() => setConfirming('terminate')}>
            {pending === 'terminate' ? destructive.pendingLabel : destructive.label}
          </button>
        )}
      </footer>

      {confirming === 'stop' && (
        <ConfirmModal
          title={`Stop ${server.name}?`}
          message="The disk is kept, so you can start it again later. You are not billed for a stopped instance's compute."
          confirmLabel="Stop"
          onCancel={() => setConfirming(null)}
          onConfirm={() => void run('stop', () => stopServer(server.serverId), `${server.name} is stopping`)}
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
            // Same call underneath either way — core's terminate is idempotent, and clearing a
            // row whose machine is gone is what it does for one (ADR-0010).
            void run(
              'terminate',
              () => terminateServer(server.serverId),
              destructive.label === 'Dismiss' ? `${server.name} dismissed` : `${server.name} is terminating`,
            )
          }
        />
      )}
    </Plate>
  )
}
