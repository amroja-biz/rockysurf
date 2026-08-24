import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import toast from 'react-hot-toast'
import { AppShell } from '../components/AppShell'
import { ConfirmModal } from '../components/ConfirmModal'
import { IpChangeAlert } from '../components/IpChangeAlert'
import { StatusBadge } from '../components/StatusBadge'
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
import { formatCostCell, formatDate, formatUptime, isProvisioningStep, STEP_LABELS, STEP_ORDER } from '../lib/format'

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
      {server.previousIp && server.publicIp && server.ipChangedAt && (
        <IpChangeAlert
          serverId={server.serverId}
          previousIp={server.previousIp}
          currentIp={server.publicIp}
          changedAt={server.ipChangedAt}
        />
      )}

      <section className="server-summary">
        <StatusBadge status={server.status} transition={transition.pending} />
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
          The display fields, editable in place (issue #46). The auto-minted name
          (`server-mt0nilwv`) was the whole report: a fleet of those is a fleet of boxes
          nobody can tell apart. Rename and description are core-side display facts only —
          the provider identity is the server id, so nothing on the cloud moves.
        */}
        {editing ? (
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
            <button type="button" className="link" onClick={() => setEditing(true)}>
              Edit
            </button>
          </p>
        )}
        <dl>
          <div>
            <dt>Address</dt>
            <dd>
              {server.publicIp ?? '—'}
              {server.consoleUrl && (
                <>
                  {' · '}
                  <a href={server.consoleUrl} target="_blank" rel="noopener noreferrer">
                    Open in {providerName ?? 'provider'} console ↗
                  </a>
                </>
              )}
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
              rockysurf-4d8h is the per-pack detail view rather than the admin table. */}
          {server.packId && (
            <div>
              <dt>Surge Pack</dt>
              <dd data-testid="server-pack">
                <Link to={`/packs/${server.packId}`}>{pack?.name ?? server.packId}</Link>
              </dd>
            </div>
          )}
          <div>
            <dt>Uptime</dt>
            <dd>{formatUptime(server.totalUptimeSeconds)}</dd>
          </div>
          <div>
            <dt>Estimated cost</dt>
            <dd title={cost.title}>{cost.text}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatDate(server.createdAt)}</dd>
          </div>
        </dl>
        {server.errorMessage && <p role="alert">{server.errorMessage}</p>}
        {/* After the reason, because "diagnose" only means something once you can read what
            broke — and before the action buttons, which is where "terminate" lives. */}
        <StillBillingNotice server={server} detailed />
      </section>

      {/* Every button is disabled for the whole of a transition, not just for the request: a
          box that is coming up cannot be stopped, and core would refuse with a 409 anyway
          (rockysurf-55fx.15). Offering a button that can only fail is what the 409 message was
          apologising for. */}
      <section className="server-actions">
        {providerCanStop && server.status === 'running' && (
          <button disabled={busy} onClick={() => setConfirming('stop')}>
            {transition.pending === 'stop' || pending === 'stop' ? 'Stopping…' : 'Stop'}
          </button>
        )}
        {providerCanStop && server.status === 'stopped' && (
          <button disabled={busy} onClick={() => void run('start', () => startServer(server.serverId), 'Starting')}>
            {transition.pending === 'start' || pending === 'start' ? 'Starting…' : 'Start'}
          </button>
        )}
        {server.status !== 'terminated' && (
          <button className="destructive" disabled={busy} onClick={() => setConfirming('terminate')}>
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
          {server.suppliedSshKey ? (
            <>
              <p className="hint" data-testid="supplied-key-hint">
                Connects with the key you supplied at create time
                {server.suppliedSshKey.comment ? ` (${server.suppliedSshKey.comment})` : ''}, fingerprint{' '}
                <code>{server.suppliedSshKey.fingerprint}</code>.
              </p>
              {/*
                Demoted, not removed (issue #41): Rocky Surf's own key stays authorized no
                matter which SSH option was picked at create time, because push-mode bootstrap
                installs everything over its own connection and needs it regardless. It is
                also the recovery path if the user's own key is ever lost.
              */}
              <details className="own-key-disclosure">
                <summary>Rocky Surf's own key</summary>
                <p className="hint">
                  Rocky Surf also authorizes a key of its own on this box — it installs everything over its own SSH
                  connection, so it needs one whether or not you supplied your own. It works too, and it is the way
                  back in if you ever lose your key:
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
                  Core keeps a copy and every download is recorded; re-downloading later is fine. Store it somewhere
                  safe and <code>chmod 600</code> it before use.
                </p>
              </details>
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
                <code>{`ssh ${sshPort}-i ${server.name}.pem -L ${pack.webPort}:127.0.0.1:${pack.webPort} ${server.sshUser}@${server.publicIp ?? '<address>'}`}</code>
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
                <code>{`ssh ${sshPort}-i ${server.name}.pem -L 3389:localhost:3389 ${server.sshUser}@${server.publicIp ?? '<address>'}`}</code>
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
      {/* `.step-list` + `.step-<state>` is the stylesheet's vocabulary — the rail, the dots and
          the four colours. This list carried its state on a `data-state` attribute nothing
          styled, so every step rendered identically and a timeline that HAD advanced still
          looked like it had not (rockysurf-xinr). The attribute stays for tests to read. */}
      <ol className="step-list">
        {STEP_ORDER.map((step, index) => {
          const state = index < reachedIndex ? 'done' : index === reachedIndex ? 'active' : 'pending'
          return (
            <li
              key={step}
              className={`step step-${state}`}
              data-state={state}
              aria-current={state === 'active' ? 'step' : undefined}
            >
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
