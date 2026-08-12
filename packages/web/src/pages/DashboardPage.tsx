import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import toast from 'react-hot-toast'
import { ActivityFeed } from '../components/ActivityFeed'
import { ConfirmModal } from '../components/ConfirmModal'
import { IpChangeAlert } from '../components/IpChangeAlert'
import { AppShell } from '../components/AppShell'
import { canStop, useProviderCapabilities } from '../hooks/useProviderCapabilities'
import { useServerUpdates } from '../hooks/useServerUpdates'
import {
  ApiError,
  listServers,
  startServer,
  stopServer,
  terminateServer,
  type ProviderCapabilities,
  type ServerSummary,
} from '../lib/api'
import { formatCost, formatUptime, STATUS_LABELS, STEP_LABELS } from '../lib/format'

/**
 * The server list.
 *
 * Ported from `frontend/src/pages/DashboardPage.tsx`. What changed and why:
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
  const { byId: capabilities } = useProviderCapabilities()

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

  return (
    <AppShell title="Servers">
      <div className="dashboard-actions">
        <Link className="button primary" to="/servers/new">
          New server
        </Link>
      </div>

      {loading && <p>Loading your servers…</p>}
      {error && <p role="alert">{error}</p>}
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

type PendingAction = 'stop' | 'start' | 'terminate'

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

  // Capability first, then state. A provider that cannot stop an instance never offers the
  // button, whatever the server is doing.
  const providerCanStop = canStop(capabilities, server.provider)
  const showStop = providerCanStop && server.status === 'running'
  const showStart = providerCanStop && server.status === 'stopped'
  const showTerminate = server.status === 'running' || server.status === 'stopped' || server.status === 'failed'

  async function run(action: PendingAction, call: () => Promise<unknown>, done: string) {
    setConfirming(null)
    setPending(action)
    try {
      await call()
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
        <span className="status-badge" data-status={server.status}>
          {STATUS_LABELS[server.status]}
        </span>
      </header>

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
          <dd>{formatUptime(server.uptime ?? 0)}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{formatCost(server.estimatedTotalCost, server.hourlyCost?.currency)}</dd>
        </div>
      </dl>

      <footer className="server-card-actions">
        {showStop && (
          <button disabled={pending !== null} onClick={() => setConfirming('stop')}>
            {pending === 'stop' ? 'Stopping…' : 'Stop'}
          </button>
        )}
        {showStart && (
          <button
            disabled={pending !== null}
            onClick={() => void run('start', () => startServer(server.serverId), `${server.name} is starting`)}
          >
            {pending === 'start' ? 'Starting…' : 'Start'}
          </button>
        )}
        {showTerminate && (
          <button className="destructive" disabled={pending !== null} onClick={() => setConfirming('terminate')}>
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
