import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import toast from 'react-hot-toast'
import { ActivityFeed } from '../components/ActivityFeed'
import { BackupReminder } from '../components/BackupReminder'
import { warningsSummary } from '../components/BootstrapReport'
import { ConfirmModal } from '../components/ConfirmModal'
import { IpChangeAlert } from '../components/IpChangeAlert'
import { AppShell } from '../components/AppShell'
import { StatusBadge } from '../components/StatusBadge'
import { StillBillingNotice } from '../components/StillBillingNotice'
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
  startServer,
  stopServer,
  terminateServer,
  type ProviderCapabilities,
  type Server,
  type ServerSummary,
} from '../lib/api'
import { formatCostCell, formatUptime, STEP_LABELS } from '../lib/format'

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
  const { byId: capabilities, providers } = useProviderCapabilities()

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
   * Live updates, applied in place.
   *
   * Patching the row rather than refetching the list is deliberate: a provisioning server
   * emits a step every few seconds, and refetching on each one would make the page flicker
   * and hammer core for a field it just told us.
   */
  useServerUpdates(
    useCallback((event) => {
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
    }, []),
  )

  const live = servers.filter((server) => server.status !== 'terminated')

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

      <div className="dashboard-actions">
        <Link className="button primary" to="/servers/new">
          New server
        </Link>
      </div>

      {loading && <p>Loading your servers…</p>}
      {error && <p role="alert">{error}</p>}
      {staleProviders.map(([providerId, message]) => (
        <p key={providerId} role="alert" className="sync-error" data-testid={`sync-error-${providerId}`}>
          Could not refresh your {providers.find((p) => p.id === providerId)?.displayName ?? providerId} servers —
          showing their last known state. {message}
        </p>
      ))}
      {!loading && !error && live.length === 0 && (
        <p className="empty">
          No servers yet. <Link to="/servers/new">Create one</Link> to get started.
        </p>
      )}

      <div className="server-grid">
        {live.map((server) => (
          <ServerCard key={server.serverId} server={server} capabilities={capabilities} onChanged={refresh} />
        ))}
      </div>

      <ActivityFeed servers={servers} />
    </AppShell>
  )
}

type PendingAction = TransitionAction | 'terminate'

function ServerCard({
  server,
  capabilities,
  onChanged,
}: {
  server: ServerSummary
  capabilities: Map<string, ProviderCapabilities>
  onChanged: () => void | Promise<void>
}) {
  const [pending, setPending] = useState<PendingAction | null>(null)
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
    <article className="server-card" data-status={server.status}>
      {server.previousIp && server.publicIp && server.ipChangedAt && (
        <IpChangeAlert
          serverId={server.serverId}
          previousIp={server.previousIp}
          currentIp={server.publicIp}
          changedAt={server.ipChangedAt}
        />
      )}

      <header>
        <h3>
          <Link to={`/servers/${server.serverId}`}>{server.name}</Link>
        </h3>
        <StatusBadge status={server.status} transition={transition.pending} />
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
      {server.errorMessage && <p role="alert">{server.errorMessage}</p>}

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

      <dl className="server-meta">
        <div>
          <dt>Address</dt>
          <dd>{server.publicIp ?? '—'}</dd>
        </div>
        <div>
          <dt>Uptime</dt>
          <dd>{formatUptime(server.totalUptimeSeconds)}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd title={cost.title}>{cost.text}</dd>
        </div>
      </dl>

      <footer className="server-card-actions">
        {showStop && (
          <button disabled={busy} onClick={() => setConfirming('stop')}>
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
            {pending === 'terminate' ? 'Terminating…' : 'Terminate'}
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
          title={`Terminate ${server.name}?`}
          message="This destroys the server and its disk. It cannot be undone."
          confirmLabel="Terminate"
          isDestructive
          onCancel={() => setConfirming(null)}
          onConfirm={() =>
            void run('terminate', () => terminateServer(server.serverId), `${server.name} is terminating`)
          }
        />
      )}
    </article>
  )
}
