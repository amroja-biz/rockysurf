import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import toast from 'react-hot-toast'
import { AddRepositoryModal } from '../components/AddRepositoryModal'
import { AppShell } from '../components/AppShell'
import { ConfirmModal } from '../components/ConfirmModal'
import { IpChangeAlert } from '../components/IpChangeAlert'
import { canStop, useProviderCapabilities } from '../hooks/useProviderCapabilities'
import { useServerUpdates } from '../hooks/useServerUpdates'
import {
  ApiError,
  downloadSshKey,
  getServer,
  listSurgePacks,
  startServer,
  stopServer,
  terminateServer,
  type ProvisioningStep,
  type Server,
  type SurgePack,
} from '../lib/api'
import { formatCost, formatDate, formatUptime, STATUS_LABELS, STEP_LABELS, STEP_ORDER } from '../lib/format'

/**
 * One server: what it is, how to connect to it, and what it is doing right now.
 *
 * Ported from `frontend/src/pages/ServerDetailPage.tsx`. Three things changed:
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
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<'stop' | 'terminate' | null>(null)
  const [addingRepo, setAddingRepo] = useState(false)
  const { byId: capabilities } = useProviderCapabilities()

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
      setServer((current) => {
        if (!current) return current
        if (event.type === 'server-status') {
          return { ...current, status: event.status, publicIp: event.publicIp ?? current.publicIp }
        }
        if (event.type === 'bootstrap-progress') {
          return { ...current, provisioningStep: event.step as ProvisioningStep }
        }
        if (event.type === 'ip-changed') {
          return { ...current, publicIp: event.newIp, previousIp: event.previousIp, ipChangedAt: new Date().toISOString() }
        }
        return current
      })
    }, []),
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

  const providerCanStop = canStop(capabilities, server.provider)
  // `-p` only when the box is not on 22, which is every server core provisioned itself.
  const sshPort = server.sshPort ? `-p ${server.sshPort} ` : ''
  const sshCommand = `ssh ${sshPort}-i ${server.name}.pem ${server.sshUser}@${server.publicIp ?? '<address>'}`

  async function run(action: string, call: () => Promise<unknown>, done: string) {
    setConfirming(null)
    setPending(action)
    try {
      await call()
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
      {server.previousIp && server.publicIp && server.ipChangedAt && (
        <IpChangeAlert
          serverId={server.serverId}
          previousIp={server.previousIp}
          currentIp={server.publicIp}
          changedAt={server.ipChangedAt}
        />
      )}

      <section className="server-summary">
        <span className="status-badge" data-status={server.status}>
          {STATUS_LABELS[server.status]}
        </span>
        <dl>
          <div>
            <dt>Address</dt>
            <dd>{server.publicIp ?? '—'}</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>
              {server.size} · {server.offeringId} · {server.arch}
            </dd>
          </div>
          <div>
            <dt>Uptime</dt>
            <dd>{formatUptime(server.totalUptimeSeconds)}</dd>
          </div>
          <div>
            <dt>Estimated cost</dt>
            <dd>{formatCost(server.estimatedTotalCost, server.hourlyCost?.currency)}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatDate(server.createdAt)}</dd>
          </div>
        </dl>
        {server.errorMessage && <p role="alert">{server.errorMessage}</p>}
      </section>

      <section className="server-actions">
        {providerCanStop && server.status === 'running' && (
          <button disabled={pending !== null} onClick={() => setConfirming('stop')}>
            Stop
          </button>
        )}
        {providerCanStop && server.status === 'stopped' && (
          <button
            disabled={pending !== null}
            onClick={() => void run('start', () => startServer(server.serverId), 'Starting')}
          >
            Start
          </button>
        )}
        {server.status !== 'terminated' && (
          <button className="destructive" disabled={pending !== null} onClick={() => setConfirming('terminate')}>
            Terminate
          </button>
        )}
      </section>

      {server.status === 'provisioning' && (
        <ProvisioningTimeline current={server.provisioningStep} logLines={logLines} />
      )}

      {server.status === 'running' && (
        <section className="connection">
          <h2>Connect</h2>
          <pre>
            <code>{sshCommand}</code>
          </pre>
          <button onClick={() => void downloadSshKey(server.serverId, server.name).catch(() => toast.error('No key available'))}>
            Download {server.name}.pem
          </button>
          <p className="hint">
            The key is served once per request and is the only copy you get; store it somewhere safe and
            <code> chmod 600 </code> it before use.
          </p>

          {/* Gated on pack metadata, not on the pack's name. */}
          {pack?.requiresRdp && (
            <div className="rdp-instructions">
              <h3>Remote desktop</h3>
              <p>Tunnel the desktop port over SSH, then point your RDP client at localhost:</p>
              <pre>
                <code>{`ssh ${sshPort}-i ${server.name}.pem -L 3389:localhost:3389 ${server.sshUser}@${server.publicIp ?? '<address>'}`}</code>
              </pre>
              <p className="hint">Sign in as {server.sshUser} with the password you set when you created the server.</p>
            </div>
          )}
        </section>
      )}

      <section className="repositories">
        <h2>Repositories</h2>
        {server.repositories.length === 0 ? (
          <p>None yet.</p>
        ) : (
          <ul>
            {server.repositories.map((repo) => (
              <li key={repo}>
                <code>{repo}</code>
              </li>
            ))}
          </ul>
        )}
        {server.status === 'running' && <button onClick={() => setAddingRepo(true)}>Add a repository</button>}
      </section>

      <section className="tools">
        <h2>Installed</h2>
        <ul>
          {server.tools.map((tool) => (
            <li key={tool}>{tool}</li>
          ))}
        </ul>
      </section>

      {addingRepo && (
        <AddRepositoryModal
          serverId={server.serverId}
          onAdded={async () => {
            await refresh()
          }}
          onClose={() => setAddingRepo(false)}
        />
      )}
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
          title={`Terminate ${server.name}?`}
          message="This destroys the server and its disk. It cannot be undone."
          confirmLabel="Terminate"
          isDestructive
          onCancel={() => setConfirming(null)}
          onConfirm={() => void run('terminate', () => terminateServer(server.serverId), 'Terminating')}
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
function ProvisioningTimeline({ current, logLines }: { current?: ProvisioningStep; logLines: string[] }) {
  const reachedIndex = current ? STEP_ORDER.indexOf(current) : -1

  return (
    <section className="provisioning-timeline">
      <h2>Setting up</h2>
      <ol>
        {STEP_ORDER.map((step, index) => {
          const state = index < reachedIndex ? 'done' : index === reachedIndex ? 'active' : 'pending'
          return (
            <li key={step} data-state={state}>
              {STEP_LABELS[step]}
            </li>
          )
        })}
      </ol>
      {logLines.length > 0 && (
        <details open>
          <summary>Install log</summary>
          <pre className="install-log" data-testid="install-log">
            {logLines.join('\n')}
          </pre>
        </details>
      )}
    </section>
  )
}
