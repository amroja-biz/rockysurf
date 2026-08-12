import {
  ProviderError,
  isProviderError,
  type ComputeProvider,
  type InstanceState,
  type InstanceView,
} from '@rockysurf/provider-sdk'
import type { Db } from '../db/client.js'
import { buildIdempotencyKey } from '../db/ids.js'
import {
  countActiveServersForUser,
  getProviderData,
  getServer,
  getServerByIdempotencyKey,
  insertServer,
  listServersByUser,
  setKeyMaterial,
  setNetworkAddress,
  setProviderData,
  updateServerStatus,
} from '../db/repositories/servers.js'
import { appendEvent } from '../db/repositories/users.js'
import type { NetworkAddressPatch } from '../db/repositories/servers.js'
import type { BootstrapMode, Architecture, ServerRow, ServerSize, ServerStatus } from '../db/schema.js'
import { canTransition } from '../db/transitions.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { SecretsStore } from '../secrets/store.js'
import type { EventsService } from '../services/events.js'
import { fingerprintPublicKey, generateServerKeys } from '../ssh/keys.js'
import { ensureServerKeys } from '../ssh/server-keys.js'
import { renderPushUserData } from '../bootstrap/user-data.js'

/**
 * The server lifecycle service: create, read, start, stop, terminate.
 *
 * This is the port of `backend/src/servers/createServer.ts` with **the ordering inverted**,
 * which is the whole point of the task and of ADR-0001 decision 5. The old code provisioned
 * first and wrote the database row afterwards, so a crash between the two left a running,
 * billing instance that nothing in the database referenced — an orphan nobody could find, bill
 * or terminate. Here the row is written FIRST, in `requested`, with the idempotency key that
 * the provider call then carries. The worst case becomes a row with no instance, which the
 * startup recovery pass (rockysurf-55fx.7) can adopt or fail cleanly.
 *
 * Everything here is capability-driven. There is not one `provider.id` comparison in this
 * file, and there must never be: differences between clouds arrive through
 * `provider.capabilities` and through the frozen `InstanceView` vocabulary.
 */

/** Raised when the caller asked for something this provider's capabilities forbid. */
export class UnsupportedOperationError extends Error {
  override readonly name = 'UnsupportedOperationError'
  constructor(
    readonly providerId: string,
    readonly operation: string,
  ) {
    super(`provider '${providerId}' does not support ${operation}`)
  }
}

/** Raised when the row is not in a state where the request makes sense. */
export class ConflictError extends Error {
  override readonly name = 'ConflictError'
  constructor(message: string) {
    super(message)
  }
}

export class ServerNotFoundError extends Error {
  override readonly name = 'ServerNotFoundError'
  constructor(readonly serverId: string) {
    super(`no such server: ${serverId}`)
  }
}

/**
 * How a provider's `InstanceView.state` maps onto the row's `status`.
 *
 * `terminating` deliberately maps to `terminated`: for core's purposes the server is gone and
 * never coming back, and the row should stop offering start/stop. The reconciler cares about
 * the difference — the resources still exist — and reads `listManaged()` for that, which is
 * exactly why amendment A3 added the state rather than making everyone guess.
 */
const STATE_TO_STATUS: Record<InstanceState, ServerStatus | undefined> = {
  pending: 'provisioning',
  running: 'running',
  stopping: 'running', // still billing; it becomes `stopped` when the provider says so
  stopped: 'stopped',
  terminating: 'terminated',
  terminated: 'terminated',
  failed: 'failed',
  // The provider does not know. Leave the row alone rather than inventing a status.
  unknown: undefined,
}

/**
 * A booted VM is not a usable box (rockysurf-55fx.13).
 *
 * `sync` used to fold `state: 'running'` straight into `status: 'running'`, which sounds
 * obviously right and is the bug that made the first milestone exit run fail: the provider
 * reports `running` the moment the hypervisor has the machine, roughly a minute before cloud-init
 * has finished and long before anything is installed. Promoting there closed the only window
 * bootstrap has — `acceptsProgressReports()` and the ticker's bootstrap branch BOTH require
 * `provisioning` — so the box was abandoned mid-boot with no tools on it, and the row said
 * `running` with `provisioningStep: requested` forever.
 *
 * So the promotion out of `provisioning` belongs to bootstrap alone: `recordProgress('ready')`
 * is what flips the row and stamps `startedAt`, whether that report arrives over the callback
 * route or from the push supervisor reading the box's journal. This applies to BOTH topologies
 * deliberately — the rule is about whether this server's own bootstrap has finished, which is
 * not a fact about how it reports.
 *
 * Nothing else is suppressed. `stopped`, `failed` and `terminated` still fold in from the
 * provider, because those are facts about the instance that no amount of bootstrapping changes,
 * and the 30-minute provisioning timeout still bounds how long a row may sit here.
 */
function suppressesPromotionToRunning(row: ServerRow, nextStatus: ServerStatus): boolean {
  return nextStatus === 'running' && row.status === 'provisioning' && row.provisioningStep !== 'ready'
}

/**
 * `SHA256:…` of a public-key line, or undefined if it is not one.
 *
 * A provider's report is untrusted input — it may be a truncated line, a fingerprint pasted into
 * the wrong field, or nothing at all — and the caller's question is only ever "do these bytes
 * hash to the pin", to which "they are not a key" is a perfectly good no.
 */
function safeFingerprint(publicKeyLine: string): string | undefined {
  try {
    return fingerprintPublicKey(publicKeyLine)
  } catch {
    return undefined
  }
}

/** The public halves the render path may see. Private halves never leave the secrets store. */
export interface ServerKeyHalves {
  /** Authorized keys for the unprivileged user: core's own, plus the caller's if supplied. */
  sshPublicKeys: string[]
  /** Present only when core minted a host keypair for this server. */
  hostKeys?: { ed25519Private: string; ed25519Public: string }
}

export interface CreateServerInput {
  userId: string
  name: string
  provider: string
  size: ServerSize
  offeringId: string
  arch: Architecture
  packId?: string
  tools?: string[]
  repositories?: string[]
  /** An extra public key the user wants authorized alongside core's own. */
  sshPublicKey?: string
  /**
   * Supplied by a caller that may retry — an `Idempotency-Key` header, say.
   *
   * Reusing a key returns the ORIGINAL row without provisioning again, which is what makes a
   * retried create safe. Omitting it mints a fresh key with a generation component
   * (amendment C1) so that terminating a server and recreating it identically is a new
   * server, not a collision with the dead row.
   */
  idempotencyKey?: string
}

export interface LifecycleDeps {
  db: Db
  registry: ProviderRegistry
  events: EventsService
  /**
   * SEAM for rockysurf-55fx.6: the concurrency cap and the spend cap are enforced by the
   * ticker task, which owns the config and the accrued-cost view. Passing a checker here
   * keeps the enforcement point in one place — the create path — without this service
   * growing a dependency on config or on cost accounting.
   *
   * Throwing from it rejects the create BEFORE the row is written, which is the only place a
   * limit can be enforced without leaving a row behind.
   */
  checkLimits?: (input: CreateServerInput, activeServers: number) => void | Promise<void>
  /**
   * The encrypted store that holds per-server private key material (rockysurf-gonw.6).
   *
   * Present in production, where every server gets a real SSH identity. Absent only in tests
   * that do not care about keys — see the fallback in `create`.
   */
  secretsStore?: SecretsStore
  /**
   * Override the rendered pre-boot document. Defaults to the inert push-mode cloud-config.
   *
   * Providers that generate no user-data (`generatesUserData: false`, i.e. BYO) always get
   * `''` regardless of this.
   */
  renderUserData?: (row: ServerRow, provider: ComputeProvider, keys: ServerKeyHalves) => string
  /**
   * Bootstrap topology for a new server (rockysurf-55fx.4). Defaults to `push`, which is the
   * only mode that needs nothing inbound — see `bootstrapModeHooks` in bootstrap/push-runner.
   */
  selectBootstrapMode?: () => BootstrapMode
  /**
   * Called once the row exists, with the mode it was created in. Callback mode mints the plan
   * and status tokens here; push mode deliberately mints NOTHING, because a push-mode box is
   * never told a core URL and never given a credential to present.
   */
  prepareBootstrapMode?: (serverId: string, mode: BootstrapMode) => void
  /**
   * Resolve the install plan and snapshot it onto the new row (rockysurf-55fx.13).
   *
   * Separate from `prepareBootstrapMode` because it is not topology-specific: BOTH modes are
   * dead without it. Push reads the plan off the row to know what to install; callback serves
   * it to the box from `/internal/servers/:id/plan`. Absent in tests that never bootstrap.
   */
  snapshotInstallPlan?: (row: ServerRow, mode: BootstrapMode) => void
}

export interface LifecycleService {
  create(input: CreateServerInput): Promise<ServerRow>
  get(userId: string, serverId: string): Promise<ServerRow>
  list(userId: string): Promise<ServerRow[]>
  start(userId: string, serverId: string): Promise<ServerRow>
  stop(userId: string, serverId: string): Promise<ServerRow>
  terminate(userId: string, serverId: string): Promise<ServerRow>
  /** Refresh one row from the provider. Exposed for the tickers and the recovery pass. */
  sync(row: ServerRow): Promise<ServerRow>
}

export function createLifecycleService(deps: LifecycleDeps): LifecycleService {
  const { db, registry, events } = deps

  const renderUserData =
    deps.renderUserData ??
    ((row: ServerRow, provider: ComputeProvider, keys: ServerKeyHalves) =>
      renderPushUserData(
        {
          hostname: row.name,
          sshPublicKeys: keys.sshPublicKeys,
          sshUser: row.sshUser,
          // Pinning is offered only when the provider admits it can carry the key. On a
          // provider without the capability core falls back to trust-on-first-use, which the
          // SSH client enforces by recording the key it sees and refusing any later change.
          ...(provider.capabilities.canInjectHostKeys && keys.hostKeys ? { hostKeys: keys.hostKeys } : {}),
        },
        provider.capabilities.userDataMaxBytes,
      ).userData)

  /**
   * Mint and persist the server's SSH identity.
   *
   * With a secrets store this is the real path: two ed25519 keypairs, private halves
   * encrypted at rest, the host fingerprint and the secret id written onto the row so a later
   * connection can verify what it is talking to.
   *
   * WITHOUT one — tests that do not care about keys — it falls back to a generated keypair
   * whose private halves are discarded. The keys are real and valid, so specs still validate
   * and providers still see a well-formed authorized key; the box simply could not be logged
   * into, which is exactly right for a test that never opens an SSH connection. Production
   * always has the store: `boot()` builds it before the app.
   */
  function provisionKeys(row: ServerRow, provider: ComputeProvider, userSuppliedPublicKey?: string): ServerKeyHalves {
    if (deps.secretsStore) {
      // `ensureServerKeys`, not `provisionServerKeys`: idempotent, so a create path that runs
      // twice for one server reuses the identity instead of minting a second one and
      // orphaning the first. It also means anything else that renders user-data for this
      // server (the app's own render override, for one) sees the SAME keys.
      const provisioned = ensureServerKeys(db, deps.secretsStore, {
        serverId: row.id,
        // Capability-driven, like everything else here. A provider that cannot carry a host key
        // to the box will present its own, so the minted fingerprint must not become the row's
        // pin — the provider reports the real one from its own first connection instead.
        pinHostKey: provider.capabilities.canInjectHostKeys,
        ...(userSuppliedPublicKey ? { userSuppliedPublicKey } : {}),
      })
      return { sshPublicKeys: provisioned.sshPublicKeys, hostKeys: provisioned.hostKeys }
    }

    const ephemeral = generateServerKeys(row.id)
    return {
      sshPublicKeys: [ephemeral.user.publicKey],
      hostKeys: { ed25519Private: ephemeral.host.privateKey, ed25519Public: ephemeral.host.publicKey },
    }
  }

  /**
   * Record a host-key pin the PROVIDER reported, once and only once.
   *
   * Only a provider with `canInjectHostKeys: false` populates `InstanceView.hostKeyFingerprint`:
   * it could not be given a key to present, so it learned the box's own on its first connection
   * and hands core the fingerprint to verify against. Core's own verification stays strict — what
   * arrives here is a pin, not permission to trust.
   *
   * NEVER OVERWRITTEN. A row that already has a pin and a provider reporting a different one is a
   * host-key change, and quietly adopting it would turn a pin into rolling trust — the exact
   * failure pinning exists to prevent. The disagreement surfaces where it belongs: the next SSH
   * connection refuses, loudly and without retrying.
   */
  function adoptReportedHostKey(row: ServerRow, view: Pick<InstanceView, 'hostKeyFingerprint' | 'hostPublicKey'>): ServerRow {
    const reported = view.hostKeyFingerprint
    if (!reported || row.hostKeyFingerprint) return row

    // The KEY is adopted with the pin, in the same write, and only when it hashes to it
    // (ADR-0003, E14). The pin is what a provider verified during a real handshake; the key is
    // bytes that arrived beside it. On disagreement the pin is kept alone and the row simply has
    // no key to serve — which degrades to "cannot hand out a known_hosts entry", never to
    // "hands out the wrong one".
    const publicKey = view.hostPublicKey
    const agrees = publicKey ? safeFingerprint(publicKey) === reported : false

    return setKeyMaterial(db, row.id, {
      hostKeyFingerprint: reported,
      ...(agrees && publicKey ? { hostPublicKey: publicKey } : {}),
    })
  }

  /**
   * Record the sshd port the provider reported (ADR-0003, E13).
   *
   * Part of the address, and folded like one — UNLIKE the host-key pin above, which is written
   * once and never overwritten. A port is not a trust decision: if the operator moves sshd and
   * updates the registry, the new value is simply the truth, and the connection that would
   * otherwise fail is core dialling a port nobody is listening on. The host key protects the
   * conversation whichever port it happens on.
   */
  function adoptReportedPort(row: ServerRow, reported: number | undefined): ServerRow {
    if (reported === undefined || reported === row.sshPort) return row
    return setNetworkAddress(db, row.id, { sshPort: reported })
  }

  /** Load a row and prove it belongs to this user. */
  function owned(userId: string, serverId: string): ServerRow {
    const row = getServer(db, serverId)
    // A row owned by someone else is reported as absent, not as forbidden: telling a caller
    // that a server exists but is not theirs leaks the id space.
    if (!row || row.userId !== userId) throw new ServerNotFoundError(serverId)
    return row
  }

  async function emit(row: ServerRow, type: string, extra: Record<string, unknown> = {}): Promise<void> {
    appendEvent(db, { type, serverId: row.id, userId: row.userId, payload: extra })
    await events.broadcastToUser(row.userId, {
      type,
      serverId: row.id,
      status: row.status,
      ...extra,
    })
  }

  /** Apply a status change, persist it, and tell the user's open streams. */
  async function transition(row: ServerRow, to: ServerStatus, options: { errorMessage?: string } = {}): Promise<ServerRow> {
    if (row.status === to) return row
    const updated = updateServerStatus(db, row.id, to, options)
    await emit(updated, 'server-status', options.errorMessage ? { error: options.errorMessage } : {})
    return updated
  }

  /**
   * Read the provider's view of a row and fold it back in.
   *
   * Ported from the spike's `sync()`, including the detail that made it worth porting: the
   * previousIp / ipChangedAt breadcrumb is written only for providers that ADMIT their
   * address moves across a stop. On a provider with `ipStableAcrossStop`, a changed address
   * is a surprise worth recording as a plain update, not a user-facing "your IP moved".
   *
   * Hands back the raw provider state alongside the row, because `start` and `stop` need to
   * tell a user WHY a refusal happened and the row's status cannot say: a row is `running`
   * both when the box is up and when it is midway through shutting down (rockysurf-55fx.15).
   * `state` is absent when the provider was not asked, or answered `not_found`.
   */
  async function syncObserved(row: ServerRow): Promise<{ row: ServerRow; state?: InstanceState }> {
    const data = getProviderData(row)
    if (!data || row.status === 'terminated' || row.status === 'requested') return { row }

    const provider = registry.get(row.provider)
    let view: InstanceView
    try {
      view = await provider.describe(data)
    } catch (err) {
      // A read failure must not corrupt the row. Report what we last knew.
      if (isProviderError(err) && err.code === 'not_found') return { row }
      throw err
    }

    let current = adoptReportedHostKey(row, view)
    const nextStatus = STATE_TO_STATUS[view.state]
    if (
      nextStatus &&
      nextStatus !== current.status &&
      canTransition(current.status, nextStatus) &&
      !suppressesPromotionToRunning(current, nextStatus)
    ) {
      current = await transition(current, nextStatus)
    }

    if (view.publicIp && view.publicIp !== current.publicIp) {
      // An address seen for the FIRST time is an assignment, not a move — the same
      // distinction the repositories make for bootstrap reports, and for the same reason: a
      // "your IP changed, update your SSH config" notice on every successful boot is noise.
      const previousIp = current.publicIp ?? undefined
      const moved = previousIp !== undefined && !provider.capabilities.ipStableAcrossStop

      const patch: NetworkAddressPatch = { publicIp: view.publicIp }
      if (moved) {
        patch.previousIp = previousIp
        patch.ipChangedAt = new Date().toISOString()
      }
      if (view.publicDns) patch.publicDns = view.publicDns

      current = setNetworkAddress(db, current.id, patch)
      if (moved) await emit(current, 'ip-changed', { previousIp, newIp: view.publicIp })
    }

    current = adoptReportedPort(current, view.sshPort)

    return { row: current, state: view.state }
  }

  async function sync(row: ServerRow): Promise<ServerRow> {
    return (await syncObserved(row)).row
  }

  return {
    async create(input: CreateServerInput): Promise<ServerRow> {
      const provider = registry.get(input.provider)

      // A replayed create returns the original row and provisions NOTHING.
      if (input.idempotencyKey) {
        const existing = getServerByIdempotencyKey(db, input.idempotencyKey)
        if (existing) return existing
      }

      // Limits are checked BEFORE the row is written — the only point at which a refusal
      // leaves nothing behind.
      await deps.checkLimits?.(input, countActiveServersForUser(db, input.userId))

      const idempotencyKey =
        input.idempotencyKey ??
        buildIdempotencyKey({
          userId: input.userId,
          name: input.name,
          provider: input.provider,
          offeringId: input.offeringId,
        })

      // Decided before the row is written, because the mode is a column on it. Push unless
      // core has a public URL and the caller asked for callback (ADR-0002).
      const bootstrapMode = deps.selectBootstrapMode?.() ?? 'push'

      /* ---- STEP 1: the row, FIRST, in `requested`. ---- */
      const row = insertServer(db, {
        userId: input.userId,
        name: input.name,
        provider: input.provider,
        size: input.size,
        offeringId: input.offeringId,
        arch: input.arch,
        idempotencyKey,
        bootstrapMode,
        ...(input.packId ? { packId: input.packId } : {}),
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.repositories ? { repositories: input.repositories } : {}),
      })

      // Only now can tokens be minted: they are written onto the row that has just appeared.
      deps.prepareBootstrapMode?.(row.id, bootstrapMode)
      // The plan is snapshotted here, before the provider is called, so that a server which
      // exists at all has something to install — a row that reaches `provisioning` with a null
      // plan can never bootstrap in either topology.
      deps.snapshotInstallPlan?.(row, bootstrapMode)
      await emit(row, 'server-status')

      /* ---- STEP 2: the SSH identity, before anything can consume it. ---- */
      //
      // Order is load-bearing twice over. The row must exist first, because
      // `provisionServerKeys` writes the fingerprint and the secret id ONTO it. And the host
      // keypair must exist before the document is rendered, because the private half is what
      // cloud-init installs — a box cannot be given a key that has not been generated yet.
      const keys = provisionKeys(row, provider, input.sshPublicKey)

      /* ---- STEP 3: only now does the provider hear about it. ---- */
      const spec = {
        serverId: row.id,
        name: row.name,
        offeringId: row.offeringId,
        arch: row.arch,
        sshPublicKeys: keys.sshPublicKeys,
        // BYO has no pre-boot hook at all, so there is nothing to render for it.
        userData: provider.capabilities.generatesUserData ? renderUserData(row, provider, keys) : '',
        tags: { 'managed-by': 'rockysurf', 'server-id': row.id },
        idempotencyKey,
      }

      try {
        await provider.validateSpec(spec)
        const result = await provider.provision(spec)

        // The pin, when the provider is the one that knows it, before anything can connect: the
        // create path is the only place it can be recorded early enough for the FIRST bootstrap
        // connection to verify against it.
        const withData = adoptReportedHostKey(setProviderData(db, row.id, result.data), result.initial)
        const initial = STATE_TO_STATUS[result.initial.state] ?? 'provisioning'
        // A6 again: the create response already told us the state, so there is no describe()
        // round trip here — and on a real cloud that round trip would land in the
        // eventual-consistency window that amendment A4 exists to survive.
        const provisioning = await transition(
          withData,
          canTransition(withData.status, initial) ? initial : 'provisioning',
        )

        if (result.initial.publicIp) {
          return setNetworkAddress(db, provisioning.id, {
            publicIp: result.initial.publicIp,
            ...(result.initial.publicDns ? { publicDns: result.initial.publicDns } : {}),
            // Same reason as the pin above: the create path is the only place this can be
            // recorded early enough for the FIRST bootstrap connection to use it (E13).
            ...(result.initial.sshPort ? { sshPort: result.initial.sshPort } : {}),
          })
        }
        return adoptReportedPort(provisioning, result.initial.sshPort)
      } catch (err) {
        // The row survives the failure, carrying the reason. That is the difference between a
        // failure someone can see and an orphan nobody can.
        const message = isProviderError(err) ? `${err.code}: ${err.message}` : String(err)
        await transition(row, 'failed', { errorMessage: message })
        throw err
      }
    },

    async get(userId: string, serverId: string): Promise<ServerRow> {
      return await sync(owned(userId, serverId))
    },

    async list(userId: string): Promise<ServerRow[]> {
      const rows = listServersByUser(db, userId)
      // Sequential rather than parallel: a user with twenty servers should not open twenty
      // simultaneous provider connections every time the dashboard polls.
      const synced: ServerRow[] = []
      for (const row of rows) synced.push(await sync(row))
      return synced
    },

    async start(userId: string, serverId: string): Promise<ServerRow> {
      const row = owned(userId, serverId)
      const provider = registry.get(row.provider)

      // Capability first, and never `typeof provider.start === 'function'` — the flag is the
      // single source of truth (amendment A2), and the method exists on every provider.
      if (!provider.capabilities.stop) throw new UnsupportedOperationError(provider.id, 'start')

      const data = getProviderData(row)
      if (!data) throw new ConflictError('server has no provider handle yet')

      // Ask the provider before acting, not after. A stop that EC2 has accepted but not yet
      // finished leaves the row `running` (a machine still shutting down is still billing),
      // and only the provider's own word distinguishes that from a healthy box.
      const { row: fresh, state } = await syncObserved(row)
      if (fresh.status !== 'stopped') {
        throw new ConflictError(
          state === 'stopping'
            ? 'server is still stopping; try again in a moment'
            : `server is ${fresh.status}, not stopped`,
        )
      }
      // Still `stopped` in the row, but the provider has it coming up already — a restart that
      // core has issued and the cloud has not finished. Re-issuing would be a second
      // StartInstances for no gain, and the fake provider rejects it outright.
      if (state === 'pending') throw new ConflictError('server is already starting; it will be running shortly')

      await provider.start(data)
      // No optimistic `running` here: EC2 keeps answering `stopped` for a beat after it accepts
      // StartInstances, so writing `running` and re-reading folded the row straight back and
      // broadcast a status pair that was never true (rockysurf-55fx.15). The row is promoted by
      // whichever sync first sees the provider actually running it — on a provider that starts
      // instantly, that is this one.
      return await sync(fresh)
    },

    async stop(userId: string, serverId: string): Promise<ServerRow> {
      const row = owned(userId, serverId)
      const provider = registry.get(row.provider)

      if (!provider.capabilities.stop) throw new UnsupportedOperationError(provider.id, 'stop')

      const data = getProviderData(row)
      if (!data) throw new ConflictError('server has no provider handle yet')

      const { row: fresh, state } = await syncObserved(row)
      if (fresh.status !== 'running') {
        throw new ConflictError(
          // The mirror of the start-side case: the row still reads `stopped` because that is
          // what the provider says, but the box is on its way up and cannot be stopped yet.
          state === 'pending' && fresh.status === 'stopped'
            ? 'server is still starting; try again in a moment'
            : `server is ${fresh.status}, not running`,
        )
      }
      if (state === 'stopping') throw new ConflictError('server is already stopping')

      await provider.stop(data)
      // Symmetrically with `start`: the row becomes `stopped` when the PROVIDER says stopped,
      // not when it accepts the request. EC2 spends tens of seconds in `stopping` and refuses
      // StartInstances throughout, so a row that claimed `stopped` there offered the user a
      // Start button that could only fail (rockysurf-55fx.15). Providers that stop promptly —
      // Hetzner, the fake — report `stopped` on this very describe and settle in one call.
      return await sync(fresh)
    },

    async terminate(userId: string, serverId: string): Promise<ServerRow> {
      const row = owned(userId, serverId)

      // Idempotent at this layer too: terminating a terminated server is success, not a 409.
      if (row.status === 'terminated') return row

      const data = getProviderData(row)
      if (data) {
        const provider = registry.get(row.provider)
        // The provider's terminate is idempotent by contract — not-found is success — so a
        // row whose instance is already gone still ends up terminated here.
        await provider.terminate(data)
      }

      return await transition(row, 'terminated')
    },

    sync,
  }
}
