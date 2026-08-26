import {
  ProviderError,
  isProviderError,
  type ComputeProvider,
  type InstanceState,
  type InstanceView,
  type Price,
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
  recordProgress,
  recordProviderState,
  setKeyMaterial,
  setNetworkAddress,
  setProviderData,
  setServerMetadata,
  updateServerStatus,
} from '../db/repositories/servers.js'
import { appendEvent } from '../db/repositories/users.js'
import type { NetworkAddressPatch, ServerMetadataPatch } from '../db/repositories/servers.js'
import type {
  BootstrapMode,
  Architecture,
  ProvisioningStep,
  ServerRow,
  ServerStatus,
  StoredSize,
} from '../db/schema.js'
import { advancesProvisioning, canTransition } from '../db/transitions.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { SecretsStore } from '../secrets/store.js'
import type { EventsService } from '../services/events.js'
import { fingerprintPublicKey, generateServerKeys } from '../ssh/keys.js'
import { ensureServerKeys, normalizeUserPublicKey } from '../ssh/server-keys.js'
import { bootstrapProgressEvent, serverStatusEvent } from '../bootstrap/progress-event.js'
import { renderPushUserData } from '../bootstrap/user-data.js'

/**
 * The server lifecycle service: create, read, start, stop, terminate.
 *
 * This is the port of the legacy Lambda backend's create-server handler with **the ordering inverted**,
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
 * How a provider's `InstanceView.state` maps onto the row's PROGRESS vocabulary (rockysurf-ljxi).
 *
 * The step list has always carried `instance_launching` and `instance_running`, and the SPA has
 * always drawn them ("Launching the machine", "Machine running, waiting for SSH") — but nothing
 * in core ever reported either, so a row went straight from `requested` to `installing_tools`.
 * On a real cloud that silence covers the boot and the SSH wait, which is the LONGEST stretch of
 * a create: the timeline sat on "Requested" for minutes and then jumped, retroactively marking
 * two steps done that were never once the active step.
 *
 * These two facts are provider-confirmed by construction, which is the 55fx.13/55fx.15 doctrine
 * that this map exists to keep: the only input is what the provider just said about the machine.
 * `pending` means the create call has been accepted and the machine is coming up. `running` means
 * the provider has the machine up — and because `suppressesPromotionToRunning` deliberately does
 * NOT let that promote the row, the box is at that moment exactly what the SPA's label claims:
 * running, and being waited on for SSH.
 *
 * Deliberately separate from `STATE_TO_STATUS` rather than folded into it. That map answers "what
 * IS this server", this one answers "how far along is its provisioning", and the states where the
 * two disagree are the whole point: `running` here means work still to do, not work finished.
 *
 * Every other state is `undefined` — a stopped, terminating or failed instance is not making
 * provisioning progress, and `unknown` is the provider admitting it does not know.
 */
const STATE_TO_MILESTONE: Record<InstanceState, ProvisioningStep | undefined> = {
  pending: 'instance_launching',
  running: 'instance_running',
  stopping: undefined,
  stopped: undefined,
  terminating: undefined,
  terminated: undefined,
  failed: undefined,
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

/**
 * The price this server is created at, read from the provider's own catalogue (rockysurf-dec8).
 *
 * THIS IS THE ONLY PLACE A ROW IS EVER PRICED, and it is here rather than in the HTTP route so
 * that the SPA, the CLI and the MCP server are priced by construction rather than by three
 * callers each remembering to. `servers.hourly_cost_amount` had no writer at all until this
 * existed: every row was NULL, so the uptime ticker accrued nothing, month-to-date spend was
 * permanently zero, and `limits.spendCap` could not refuse a create no matter how much the
 * fleet cost. The cap was configuration nothing enforced.
 *
 * Three decisions this encodes, all of them deliberate:
 *
 *  1. **The currency is the provider's, and it is never converted.** A `Price` carries an
 *     amount AND an ISO 4217 code (amendment B2), and both are stored verbatim. A Hetzner row
 *     priced in EUR does not count against a USD cap — `jobs/limits.ts` compares the cap only
 *     against its own currency's bucket — and it is not silently zero either: it accrues into
 *     the EUR bucket, which `/api/v1/costs` reports per currency and the costs page displays.
 *     Converting here would mean inventing an exchange rate, which is the one thing a spend
 *     figure must never do.
 *  2. **Unpriced stays honestly unpriced, and never blocks a create.** An offering with
 *     `hourly: null` (BYO quotes none — Rocky Surf has no idea what the operator's own hardware
 *     costs them, and `null` means unknown, never free) and a `listOfferings()` that throws
 *     both land the same way: a row with no price, counted in `unpricedServers` and surfaced
 *     there rather than folded into a total as zero. The create is what the user asked for; the
 *     price is what we can say about it, and losing the second must never cost them the first.
 *  3. **It is a snapshot, taken once.** The row keeps the price it was created at for life;
 *     a later change to the provider's rates does not retro-price it. `hourlyCostFetchedAt`
 *     carries the provider's own stamp, which `/costs` reports as `pricedAt` and the estimate
 *     UI already shows as "prices as of <date>" — so an estimate can always say what it is
 *     based on.
 *
 * The catalogue read is cheap on every provider in v0: AWS and the fake answer from a bundled
 * table, and BYO caches each host's hardware after the first probe. Hetzner really does call its
 * API, and on the size-only create path that is a second read of a list the route just fetched —
 * paid knowingly, because a create is not a hot path and pricing every caller by construction is
 * worth one catalogue call.
 */
async function priceOffering(provider: ComputeProvider, offeringId: string): Promise<Price | null> {
  try {
    const offerings = await provider.listOfferings()
    return offerings.find((offering) => offering.id === offeringId)?.hourly ?? null
  } catch {
    return null
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
  /** Optional free-text purpose (issue #46). Display-only, like `name`. */
  description?: string
  provider: string
  /** `'custom'` for a server created by naming an offering directly (rockysurf-kh3u). */
  size: StoredSize
  offeringId: string
  arch: Architecture
  packId?: string
  tools?: string[]
  repositories?: string[]
  /** An extra public key the user wants authorized alongside core's own. */
  sshPublicKey?: string
  /**
   * The remote-desktop password for a `requiresRdp` pack (rockysurf-z0wf).
   *
   * SCOPED TO THE SERVER, not to the user, because it is set on THAT box's `rocky` account —
   * the split `bootstrap/server-secrets.ts` already states for `RDP_PASSWORD` against
   * `GITHUB_TOKEN`. It is stored under the server id the moment the row exists and read back
   * by `createServerSecretsLoader`; nothing else ever reads it, and no route returns it.
   *
   * ABSENT IS A VALID STATE and stays one. A pack that does not set `requiresRdp` gets no
   * `rdp` step, so a server created without a password is complete rather than half-built —
   * which is also why this is not defaulted to a generated value. Core generating one would
   * mean core had to hand it back to the user afterwards, and that is a route returning
   * plaintext (`secrets/route-inventory.test.ts`) bought to replace a value the user already
   * knows because they chose it.
   */
  rdpPassword?: string
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
   *
   * Called AFTER `provisionKeys` now (ADR-0008, issue #92), so `managedPublicKey` can carry
   * core's own just-minted public key line for a supplied-key row's final step.
   */
  snapshotInstallPlan?: (row: ServerRow, mode: BootstrapMode, options?: { managedPublicKey?: string }) => void
}

/**
 * A row plus the reason its provider view could not be refreshed just now, when it could not.
 *
 * `get` and `list` serve these instead of throwing (rockysurf-gg9x): the owner's GCP
 * application-default credentials hit Google's periodic reauth, and the dashboard rendered
 * "Could not load your servers" over a list that was mostly healthy AWS and Hetzner rows. An
 * expired credential for ONE cloud is routine on a self-hosted laptop, so a read failure
 * degrades to the stored row — and the provider's own message rides along because it names
 * the remedy; for an expired login it contains the exact command to run.
 *
 * Reads only. Start, stop and terminate still throw: acting on a box the provider cannot be
 * asked about is a refusal, not a degradation.
 */
export interface SyncedServer {
  row: ServerRow
  /** Absent when the provider answered and the row is fresh. */
  syncError?: string
}

export interface LifecycleService {
  create(input: CreateServerInput): Promise<ServerRow>
  get(userId: string, serverId: string): Promise<SyncedServer>
  list(userId: string): Promise<SyncedServer[]>
  /**
   * Rewrite the display fields — name, description — and nothing else (issue #46).
   *
   * No provider call and no status rules: the provider identity is the row's `id`, the
   * hostname was stamped at create, so a rename is a fact about the dashboard, not the box.
   * Editing a stopped or even terminated row is legitimate for the same reason.
   */
  updateMetadata(userId: string, serverId: string, patch: ServerMetadataPatch): Promise<ServerRow>
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

  /**
   * Record the provider's own console URL for this instance (ADR-0003, E16).
   *
   * Folded like the port, with one deliberate asymmetry: an ABSENT value never clears a stored
   * one. `describe()` legitimately answers with a sparse view — the not-found and
   * already-terminated paths return little more than a state — and clearing on those would drop
   * the link every time a terminating box is polled. Core never constructs one of these, so a
   * value here always came from the provider that owns the URL shape.
   */
  function adoptReportedConsoleUrl(row: ServerRow, reported: string | undefined): ServerRow {
    if (reported === undefined || reported === row.consoleUrl) return row
    return setNetworkAddress(db, row.id, { consoleUrl: reported })
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

  /**
   * "This row's status changed", built by the one constructor that builds them (rockysurf-xinr).
   *
   * Every `server-status` frame core puts on the wire now comes from `serverStatusEvent`, which
   * means every one of them carries the ADDRESS as well as the status. That matters for the
   * frame this path emits most often in front of a waiting user: the one that confirms a start.
   * The SPA shows a transitional "Starting…" affordance from the moment the provider accepts
   * the request (rockysurf-4t8y) and resolves it on this frame, so the frame is what a page
   * that never refetches gets to render — and on a cloud whose address moves across a stop,
   * the old hand-built payload left it with the previous machine's IP until a second event
   * arrived.
   */
  async function emitServerStatus(row: ServerRow, errorMessage?: string): Promise<void> {
    appendEvent(db, {
      type: 'server-status',
      serverId: row.id,
      userId: row.userId,
      payload: errorMessage ? { error: errorMessage } : {},
    })
    await events.broadcastToUser(row.userId, {
      ...serverStatusEvent(row),
      ...(errorMessage ? { error: errorMessage } : {}),
    })
  }

  /**
   * Report what the provider just said about the machine, in the row's step vocabulary.
   *
   * ONE reporter for both bootstrap topologies, because the fact is not a bootstrap report at
   * all — it is core's own observation of the instance, and both a push-mode and a callback-mode
   * server are observed through this same path (the create call's `initial`, then every
   * `describe` the ticker drives). Push mode is where the SSH wait happens, but the push runner
   * is deliberately NOT the one to announce `instance_running`: it never asks the provider
   * anything, so all it could honestly report is "core is about to dial", and a step that says
   * the machine is running must come from the machine's owner saying so.
   *
   * `advancesProvisioning` is what makes this safe to call from a path that repeats: `describe`
   * answers `running` for the whole install, and without the guard every tick would drag the row
   * back to `instance_running` from wherever bootstrap had got to. It also gives report-once,
   * so the ten-second sweep produces one event per milestone rather than one per tick.
   *
   * The row is updated before the event is built, so the two agree — the property xinr's tests
   * pin, and the reason a reload and a live update show the same timeline.
   */
  async function reportInstanceMilestone(row: ServerRow, state: InstanceState | undefined): Promise<ServerRow> {
    const step = state ? STATE_TO_MILESTONE[state] : undefined
    if (!step || !advancesProvisioning(row.provisioningStep, step)) return row

    // Refused when the row is past provisioning — a report is not a reason to move a finished
    // server, and this path can run from any `get`.
    const updated = recordProgress(db, row.id, { step })
    if (!updated) return row

    appendEvent(db, { type: 'bootstrap.step', serverId: updated.id, userId: updated.userId, payload: { step } })
    await events.broadcastToUser(
      updated.userId,
      bootstrapProgressEvent({ serverId: updated.id, step, status: updated.status, publicIp: updated.publicIp }),
    )
    return updated
  }

  /** Apply a status change, persist it, and tell the user's open streams. */
  async function transition(row: ServerRow, to: ServerStatus, options: { errorMessage?: string } = {}): Promise<ServerRow> {
    if (row.status === to) return row
    const updated = updateServerStatus(db, row.id, to, options)
    await emitServerStatus(updated, options.errorMessage)
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

    /*
     * A row whose provider is not in this registry degrades to its stored state instead of
     * failing (rockysurf-1nfc).
     *
     * `registry.get` throws for an id the current config does not enable. `rockysurf-gg9x`
     * already stopped that from taking the whole listing down, by catching per row and
     * reporting the message as `syncError` — which is the right answer for a cloud having a bad
     * day, and the wrong one here. A provider the operator switched off has not failed at
     * anything, so surfacing "unknown provider: gcp. Configured: azure" against every one of its
     * rows presents a deliberate configuration choice as a fault, and the remedy it implies is
     * to undo that choice.
     *
     * Turning a provider off is ordinary: trying a cloud and dropping it, or narrowing a config
     * for one run, both leave rows behind. Those rows are history, and history renders from
     * what is stored. This is the same rule the `not_found` branch below already follows — a
     * read we cannot make must not corrupt or hide the row — applied one step earlier, to the
     * read we cannot even attempt.
     *
     * Only the OBSERVATION is skipped. Every operation that genuinely needs a live provider —
     * start, stop, terminate, ssh — still calls `registry.get` and still refuses loudly, which
     * is correct: those cannot be served from a stored row.
     */
    if (!registry.has(row.provider)) return { row }

    const provider = registry.get(row.provider)
    let view: InstanceView
    try {
      view = await provider.describe(data)
    } catch (err) {
      // A read failure must not corrupt the row. Report what we last knew.
      if (isProviderError(err) && err.code === 'not_found') return { row }
      throw err
    }

    // The provider's own word about the machine, recorded BEFORE anything is derived from it
    // (rockysurf-4byx). Whatever the status machine does with this state next — promote,
    // suppress, or refuse the transition outright — the fact that a machine exists and is
    // metering is now on the row, and cost accrual reads it rather than the status.
    let current = adoptReportedHostKey(recordProviderState(db, row.id, view.state), view)
    const nextStatus = STATE_TO_STATUS[view.state]
    if (
      nextStatus &&
      nextStatus !== current.status &&
      canTransition(current.status, nextStatus) &&
      !suppressesPromotionToRunning(current, nextStatus) &&
      // A FAILED row stays failed when its machine goes away (ADR-0010). The machine going
      // away is now the ordinary outcome of a failed tool install — core released it — and
      // `terminated` rows are hidden from the dashboard, which would hide the explanation with
      // it. The provider state recorded just above still goes to `terminated`, so billing stops
      // and the still-billing notice clears; only the STATUS holds, until the user dismisses the
      // row through `terminate`, which is the one way out of `failed`.
      !(current.status === 'failed' && nextStatus === 'terminated')
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
    current = adoptReportedConsoleUrl(current, view.consoleUrl)
    // Last, so the milestone is reported against the address and status this read established:
    // `instance_running` travels with the IP the user is about to be told to connect to.
    current = await reportInstanceMilestone(current, view.state)

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
      // leaves nothing behind. The pasted key is validated here for the same reason (issue
      // #41 fallout, rockysurf-9fvy.1): `normalizeUserPublicKey` used to run in STEP 2, after
      // the row already existed, so a malformed paste threw past a `requested` row that no
      // provider would ever hear about. Normalizing once, here, means the trimmed value is
      // what gets persisted onto the row below AND what gets handed to `provisionKeys` — one
      // normalization, one value, two readers (issue #41).
      await deps.checkLimits?.(input, countActiveServersForUser(db, input.userId))
      const sshPublicKey = input.sshPublicKey ? normalizeUserPublicKey(input.sshPublicKey) : undefined

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

      // The price, before the row is written, because it is a column on it too. After the
      // limits check so a refused create never asks a provider anything (see `priceOffering`).
      const hourlyCost = await priceOffering(provider, input.offeringId)

      /* ---- STEP 1: the row, FIRST, in `requested`. ---- */
      const row = insertServer(db, {
        userId: input.userId,
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        provider: input.provider,
        size: input.size,
        offeringId: input.offeringId,
        arch: input.arch,
        idempotencyKey,
        bootstrapMode,
        hourlyCost,
        ...(sshPublicKey ? { userSuppliedPublicKey: sshPublicKey } : {}),
        ...(input.packId ? { packId: input.packId } : {}),
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.repositories ? { repositories: input.repositories } : {}),
      })

      // Only now can tokens be minted: they are written onto the row that has just appeared.
      deps.prepareBootstrapMode?.(row.id, bootstrapMode)

      /* ---- STEP 2: the SSH identity, before anything can consume it. ---- */
      //
      // Order is load-bearing twice over. The row must exist first, because
      // `provisionServerKeys` writes the fingerprint and the secret id ONTO it. And the host
      // keypair must exist before the document is rendered, because the private half is what
      // cloud-init installs — a box cannot be given a key that has not been generated yet.
      const keys = provisionKeys(row, provider, sshPublicKey)

      // The plan is snapshotted here, before the provider is called, so that a server which
      // exists at all has something to install — a row that reaches `provisioning` with a null
      // plan can never bootstrap in either topology.
      //
      // AFTER keys, not before (ADR-0008, issue #92): a supplied-key server's plan needs core's
      // own newly-minted public key line to render the step that later removes exactly that
      // line from the box, and that text does not exist until `provisionKeys` mints it. Nothing
      // between here and STEP 1 reads `row.installPlan`, so moving this past STEP 2 changes
      // nothing else about create ordering (ADR-0001's "row before provider" is unaffected —
      // both of these still run well before STEP 3's provider call).
      deps.snapshotInstallPlan?.(row, bootstrapMode, { managedPublicKey: keys.sshPublicKeys[0] })
      await emitServerStatus(row)

      // The desktop password belongs to the same step for the same reason: it is server-scoped
      // secret material, and the row it is filed under has to exist first. It is written here
      // rather than at push time because BOTH topologies read it back later and from the same
      // loader — push when it writes `secrets.env`, callback when the box fetches its secrets —
      // and neither has the create request in hand by then. A store is only absent in tests
      // that never open a connection; production always has one, built by `boot()`.
      if (input.rdpPassword && deps.secretsStore) deps.secretsStore.putRdpPassword(row.id, input.rdpPassword)

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

        // The meter starts HERE, not at `ready` (rockysurf-4byx). `provision()` has returned a
        // machine and the provider is charging for it from this moment, whatever the row's
        // status does next — including failing during bootstrap, which leaves the instance up
        // by design and used to accrue nothing at all.
        recordProviderState(db, row.id, result.initial.state)

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

        const addressed = result.initial.publicIp
          ? setNetworkAddress(db, provisioning.id, {
              publicIp: result.initial.publicIp,
              ...(result.initial.publicDns ? { publicDns: result.initial.publicDns } : {}),
              // Same reason as the pin above: the create path is the only place this can be
              // recorded early enough for the FIRST bootstrap connection to use it (E13).
              ...(result.initial.sshPort ? { sshPort: result.initial.sshPort } : {}),
            })
          : adoptReportedPort(provisioning, result.initial.sshPort)

        // On both clouds the create response already knows the instance id, so the console link
        // is live while the box is still booting rather than after the first sync (E16).
        const linked = adoptReportedConsoleUrl(addressed, result.initial.consoleUrl)

        // The first thing anyone can honestly say about this machine, said here rather than
        // waiting up to ten seconds for the ticker's first sync to say it: `provision()` has
        // returned a handle and the state the provider gave it with. Until this landed, the
        // timeline's answer to "what is happening" for the whole boot was "Requested".
        return await reportInstanceMilestone(linked, result.initial.state)
      } catch (err) {
        // The row survives the failure, carrying the reason. That is the difference between a
        // failure someone can see and an orphan nobody can.
        const message = isProviderError(err) ? `${err.code}: ${err.message}` : String(err)
        await transition(row, 'failed', { errorMessage: message })
        throw err
      }
    },

    async get(userId: string, serverId: string): Promise<SyncedServer> {
      // `owned` throws OUTSIDE the guard below: a server this user does not have is still a
      // 404, not a stored row with an excuse attached.
      const row = owned(userId, serverId)
      try {
        return { row: await sync(row) }
      } catch (err) {
        return { row, syncError: isProviderError(err) ? err.message : String(err) }
      }
    },

    async list(userId: string): Promise<SyncedServer[]> {
      const rows = listServersByUser(db, userId)
      // Sequential rather than parallel: a user with twenty servers should not open twenty
      // simultaneous provider connections every time the dashboard polls.
      const synced: SyncedServer[] = []
      for (const row of rows) {
        try {
          synced.push({ row: await sync(row) })
        } catch (err) {
          // Same policy as GET /providers' `offeringsError`: one cloud having a bad day must
          // not take the whole list down with it (rockysurf-gg9x). The stored row is still a
          // fact worth serving, and the provider's message rides along because it names the
          // remedy — for expired credentials, the exact command to run.
          synced.push({ row, syncError: isProviderError(err) ? err.message : String(err) })
        }
      }
      return synced
    },

    async updateMetadata(userId: string, serverId: string, patch: ServerMetadataPatch): Promise<ServerRow> {
      // Ownership is the only gate. No provider call and no status rule — see the interface.
      return setServerMetadata(db, owned(userId, serverId).id, patch)
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

      /**
       * READ THE ROW AGAIN, because the `await` above is long enough to lose a race with a
       * retry of this very call (rockysurf-nimu).
       *
       * The check at the top of this function makes a SEQUENTIAL second terminate succeed. It
       * cannot see a CONCURRENT one, which is the shape a lost response actually produces: the
       * client's response never arrived, the request that produced it is still inside
       * `provider.terminate` — tens of seconds on a real cloud — and the retry reads the same
       * `running` row the first call read. Both then reach here; the second calls
       * `updateServerStatus`, which re-reads the row and asserts against the status it finds,
       * and the loser gets `409 illegal server status transition: terminated → terminated` for
       * a terminate that WORKED. An agent is the caller that cannot survive that: SECURITY.md's
       * model agent reports the refusal and stops, so it reports a phantom failure for a
       * destroyed machine and a human goes looking for a box that is not there.
       *
       * Re-reading closes it because there is no `await` between this read and the write —
       * `transition` reaches `updateServerStatus` synchronously, and better-sqlite3 is
       * synchronous, so no other turn of the loop can interleave. Anything added between the
       * two that yields would reopen the window.
       */
      const fresh = owned(userId, serverId)
      if (fresh.status === 'terminated') return fresh

      return await transition(fresh, 'terminated')
    },

    sync,
  }
}
