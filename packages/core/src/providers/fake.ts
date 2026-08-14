import {
  DESCRIBE_ABSENCE_GRACE,
  ProviderError,
  unsupportedOperationError,
  type ComputeProvider,
  type InstanceState,
  type InstanceView,
  type ManagedResource,
  type Offering,
  type ProviderCapabilities,
  type ProviderData,
  type ProvisionSpec,
  type ProvisionResult,
} from '@rockysurf/provider-sdk'

/**
 * The in-memory provider. Two jobs, and it has to be good at both:
 *
 *  1. **The permanent CI test double.** Every lifecycle test runs against this, so it must
 *     behave like a real cloud where that matters — eventual consistency, a `terminating`
 *     window, capability gating — and be deterministic where it doesn't.
 *  2. **Dev mode.** With no cloud credentials configured, this is the provider core registers,
 *     so someone can run `npx rockysurf`, create a "server", and see the whole UI work without
 *     an AWS account. That is why it lives in `src/`, not in a test directory.
 *
 * It implements the FROZEN SDK exactly (ADR-0003). Where the contract has a subtle rule, this
 * provider is the reference implementation of it — most importantly the absence grace on
 * `describe()`, which is the one rule a provider author is most likely to skip.
 */

export interface FakeProviderOptions {
  id?: string
  displayName?: string
  /** Overrides merged over the defaults below. `stop: false` gives a no-stop provider. */
  capabilities?: Partial<ProviderCapabilities>
  /**
   * Declare `capabilities.simulatedInstances`, so core drives this server's install plan
   * in-process instead of over SSH (ADR-0003, amendment E15). Default `false`.
   *
   * OFF BY DEFAULT BECAUSE THIS PROVIDER HAS TWO JOBS AND ONLY ONE OF THEM WANTS IT. As the CI
   * test double it is used by tests that create a server and then drive progress themselves —
   * by calling `applyAgentState`, by POSTing to the callback route, or by asserting that a row
   * deliberately STAYS in `provisioning` because the provider reporting a booted VM is not a
   * promotion (rockysurf-55fx.13). A simulation racing those tests would be a second writer of
   * the thing under test. As dev mode it is the only thing that can finish a bootstrap on a
   * machine with no cloud account, so `composeRegistry` and `createDefaultRegistry` — the two
   * places that register this provider as somebody's trial run rather than as a fixture — turn
   * it on, and nothing else does.
   */
  simulateBootstrap?: boolean
  /** ms between provision and the instance reporting `running`. Default 0 (instant). */
  bootMs?: number
  /** ms an instance sits in `terminating` before it is gone. Default 0. */
  terminateMs?: number
  /**
   * ms an instance sits in `stopping` before it reports `stopped`. Default 0.
   *
   * Hetzner stops fast enough that core never saw this window; EC2 takes tens of seconds and
   * refuses StartInstances throughout it. Setting this above zero is what reproduces
   * rockysurf-55fx.15's stop half.
   */
  stopMs?: number
  /**
   * ms after a `start()` during which `describe()` STILL reports `stopped`. Default 0.
   *
   * The mirror-image lag, and the one that is easy to disbelieve: EC2 accepts StartInstances
   * and then keeps answering `stopped` for a beat before it says `pending`. Core used to write
   * `running` optimistically and have the very next describe fold it straight back.
   */
  startAckMs?: number
  /**
   * ms after provision during which `describe()` cannot see the instance yet.
   *
   * This models the eventual consistency that made amendment A4 the highest-severity finding
   * of the spike: on real EC2, a `describe()` 0.1s after a SUCCESSFUL launch returned
   * not-found. Set it above zero to prove the grace works; a provider without the grace
   * reports `terminated` here and core marks a healthy, billing instance dead.
   */
  propagationMs?: number
  /** Artificial latency on every call, to shake out missing awaits. Default 0. */
  latencyMs?: number
  /** Make the next N calls to this method fail with the given error. Test hook. */
  failures?: Partial<Record<FakeMethod, ProviderError>>
  /**
   * Replace the catalogue below, for a test that needs a shape the defaults do not have —
   * most usefully an offering with `hourly: null`, which is how BYO reports the operator's own
   * hardware and the case that must create successfully while staying unpriced.
   *
   * It replaces the list `validateSpec` checks against too, so an overridden catalogue is the
   * whole truth about this provider rather than a second opinion the create path would reject.
   */
  offerings?: Offering[]
  /** Deterministic clock, for tests that need to control the boot window. */
  now?: () => number
}

export type FakeMethod =
  | 'validateCredentials'
  | 'validateSpec'
  | 'provision'
  | 'describe'
  | 'terminate'
  | 'stop'
  | 'start'
  /** Goes through `enter()` so a test can make the catalogue unreadable — a create must survive it. */
  | 'listOfferings'

interface FakeInstance {
  instanceId: string
  spec: ProvisionSpec
  /** When the instance becomes visible to describe(). */
  visibleAt: number
  /** When it flips from pending to running. */
  runningAt: number
  state: InstanceState
  /** When a terminating instance finishes. */
  goneAt?: number
  /** When a stopping instance finishes stopping. */
  stoppedAt?: number
  /** When a started instance stops answering `stopped` and admits it is coming up. */
  leavesStoppedAt?: number
  publicIp: string
  /** True once the instance has ever been observed running — see the absence grace. */
  everRunning: boolean
}

export interface FakeProvider extends ComputeProvider {
  /** Test hook: how many times provision() actually reached the provider. */
  readonly provisionCalls: number
  /** Test hook: every method call in order, for asserting call ORDER against the database. */
  readonly calls: FakeMethod[]
  /** Test hook: fail the next call to `method` with `error`. */
  failNext(method: FakeMethod, error: ProviderError): void
  /** Test hook: drop every instance, as if the account were wiped. */
  reset(): void
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  stop: true,
  ipStableAcrossStop: true,
  canInjectHostKeys: true,
  userDataMaxBytes: 32768,
  generatesUserData: true,
}

const OFFERINGS: Offering[] = [
  {
    id: 'fake-small',
    cpu: 2,
    memoryGb: 4,
    diskGb: 40,
    arch: 'arm64',
    hourly: { amount: 0.01, currency: 'USD', fetchedAt: '2026-08-12T00:00:00Z' },
    available: true,
    region: 'fake-1',
  },
  {
    id: 'fake-medium',
    cpu: 4,
    memoryGb: 8,
    diskGb: 80,
    arch: 'amd64',
    hourly: { amount: 0.04, currency: 'USD', fetchedAt: '2026-08-12T00:00:00Z' },
    available: true,
    region: 'fake-1',
  },
  {
    // Deliberately unavailable: `Offering.available` exists because a price is not an offer,
    // and a size resolver needs something to be unable to pick.
    id: 'fake-sold-out',
    cpu: 8,
    memoryGb: 16,
    arch: 'arm64',
    hourly: { amount: 0.08, currency: 'USD', fetchedAt: '2026-08-12T00:00:00Z' },
    available: false,
    region: 'fake-1',
  },
]

export function makeFakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  const id = options.id ?? 'fake'
  const catalogue = options.offerings ?? OFFERINGS
  const capabilities: ProviderCapabilities = {
    ...DEFAULT_CAPABILITIES,
    ...(options.simulateBootstrap ? { simulatedInstances: true } : {}),
    // Last, so an explicit override still wins — a test that wants the flag without the option
    // spelling, or without it, gets what it asked for.
    ...options.capabilities,
  }
  const now = options.now ?? (() => Date.now())
  const bootMs = options.bootMs ?? 0
  const terminateMs = options.terminateMs ?? 0
  const stopMs = options.stopMs ?? 0
  const startAckMs = options.startAckMs ?? 0
  const propagationMs = options.propagationMs ?? 0
  const latencyMs = options.latencyMs ?? 0

  const instances = new Map<string, FakeInstance>()
  /**
   * Instance ids this provider has ever answered `running` for (rockysurf-r5qn).
   *
   * SEPARATE FROM THE INSTANCE RECORD, and that separation is the point. `FakeInstance.
   * everRunning` lives on the record and dies with it, so once an instance is gone there is
   * nothing left to consult — which is precisely the moment the question is asked. The real
   * providers keep exactly this: a per-PROCESS `Set` that outlives the cloud's own state,
   * because "I have seen this running" is a fact about what this process observed, not about
   * what the account still contains.
   *
   * Deliberately NOT cleared by `reset()`. That hook wipes the ACCOUNT; a provider object's
   * memory of what it once saw is not in the account, and clearing it here would make the fake
   * forget something a real provider would still know.
   */
  const seenRunning = new Set<string>()
  const byIdempotencyKey = new Map<string, string>()
  const pendingFailures = new Map<FakeMethod, ProviderError>(Object.entries(options.failures ?? {}) as [FakeMethod, ProviderError][])
  const calls: FakeMethod[] = []
  let seq = 0
  let provisionCalls = 0

  const tick = () => (latencyMs > 0 ? new Promise<void>((r) => setTimeout(r, latencyMs)) : Promise.resolve())

  async function enter(method: FakeMethod): Promise<void> {
    calls.push(method)
    await tick()
    const failure = pendingFailures.get(method)
    if (failure) {
      pendingFailures.delete(method)
      throw failure
    }
  }

  /** Advance an instance's state to whatever the clock says it should be. */
  function settle(instance: FakeInstance): FakeInstance {
    const t = now()
    if (instance.state === 'terminating' && instance.goneAt !== undefined && t >= instance.goneAt) {
      instance.state = 'terminated'
      return instance
    }
    if (instance.state === 'stopping' && instance.stoppedAt !== undefined && t >= instance.stoppedAt) {
      instance.state = 'stopped'
      return instance
    }
    // A started instance keeps saying `stopped` until the ack window closes; only then does it
    // admit to `pending`, and only then does the boot clock apply.
    if (instance.state === 'stopped' && instance.leavesStoppedAt !== undefined && t >= instance.leavesStoppedAt) {
      delete instance.leavesStoppedAt
      instance.state = 'pending'
    }
    if (instance.state === 'pending' && t >= instance.runningAt) {
      instance.state = 'running'
      instance.everRunning = true
    }
    return instance
  }

  /** Visible to describe()? Models the provider-side propagation window. */
  const visible = (instance: FakeInstance) => now() >= instance.visibleAt

  function requireVisible(data: ProviderData): FakeInstance | undefined {
    const instanceId = String(data['instanceId'] ?? '')
    const instance = instances.get(instanceId)
    if (!instance) return undefined
    return visible(instance) ? settle(instance) : undefined
  }

  /**
   * The view this provider ANSWERS A DESCRIBE WITH, remembering that it said `running`.
   *
   * Recorded on the describe path rather than inside `viewOf` (rockysurf-r5qn), because
   * `provision()` also builds a view — of an instance that is deliberately NOT yet visible to
   * reads when `propagationMs` is set. Stamping there would teach the grace that the instance
   * had been seen running before any read could have seen it, and the propagation case would
   * then answer `terminated` on the first attempt: the exact data-loss bug the grace exists to
   * prevent. `provider-aws` has no equivalent hazard — its `initial` comes from the RunInstances
   * response and its `viewOf` only ever sees describe results — which is why the same
   * bookkeeping sits in a different place there.
   */
  function served(instance: FakeInstance): InstanceView {
    const settled = settle(instance)
    if (settled.state === 'running') seenRunning.add(settled.instanceId)
    return viewOf(settled)
  }

  function viewOf(instance: FakeInstance): InstanceView {
    const running = instance.state === 'running'
    return {
      state: instance.state,
      ...(running ? { publicIp: instance.publicIp, publicDns: `${instance.instanceId}.fake.invalid` } : {}),
      offeringId: instance.spec.offeringId,
    }
  }

  const provider: FakeProvider = {
    id,
    displayName: options.displayName ?? 'Fake (in-memory)',
    capabilities,

    get provisionCalls() {
      return provisionCalls
    },
    get calls() {
      return calls
    },
    failNext(method, error) {
      pendingFailures.set(method, error)
    },
    reset() {
      instances.clear()
      byIdempotencyKey.clear()
      calls.length = 0
      seq = 0
      provisionCalls = 0
    },

    async validateCredentials() {
      await enter('validateCredentials')
    },

    async validateSpec(spec: ProvisionSpec) {
      await enter('validateSpec')
      const offering = catalogue.find((o) => o.id === spec.offeringId)
      if (!offering) throw new ProviderError('invalid_spec', `no such offering: ${spec.offeringId}`)
      if (!offering.available) throw new ProviderError('capacity', `${offering.id} is not currently available`)
      if (offering.arch !== spec.arch) {
        throw new ProviderError('invalid_spec', `arch ${spec.arch} does not match offering ${offering.id} (${offering.arch})`)
      }
      if (spec.sshPublicKeys.length === 0) throw new ProviderError('invalid_spec', 'at least one ssh public key is required')
      if (Buffer.byteLength(spec.userData, 'utf8') > capabilities.userDataMaxBytes) {
        throw new ProviderError('invalid_spec', `userData exceeds userDataMaxBytes (${capabilities.userDataMaxBytes})`)
      }
      // Amendment D3: an instance tagged with someone else's prefix is invisible to
      // listManaged() and therefore an orphan from the moment it is created.
      const managedBy = spec.tags['managed-by']
      if (managedBy !== undefined && managedBy !== 'rockysurf') {
        throw new ProviderError('invalid_spec', `tags['managed-by'] is '${managedBy}' but this provider reconciles 'rockysurf'`)
      }
    },

    async listOfferings() {
      await enter('listOfferings')
      return catalogue.map((o) => ({ ...o }))
    },

    async provision(spec: ProvisionSpec): Promise<ProvisionResult> {
      await enter('provision')
      provisionCalls++

      // Provider-side idempotency, mirroring EC2's ClientToken and Hetzner's name-dedupe: a
      // replay returns the ORIGINAL instance rather than launching a second one.
      const replayed = byIdempotencyKey.get(spec.idempotencyKey)
      if (replayed) {
        const existing = instances.get(replayed)
        if (existing) return { data: { instanceId: replayed }, initial: viewOf(settle(existing)) }
      }

      await provider.validateSpec(spec)

      const t = now()
      const instanceId = `i-fake-${++seq}`
      const instance: FakeInstance = {
        instanceId,
        spec,
        visibleAt: t + propagationMs,
        runningAt: t + bootMs,
        state: bootMs > 0 ? 'pending' : 'running',
        publicIp: `198.51.100.${seq % 250}`,
        everRunning: bootMs === 0,
      }
      instances.set(instanceId, instance)
      byIdempotencyKey.set(spec.idempotencyKey, instanceId)

      // A6: the create call already knows the answer, so core does not need a describe()
      // round trip — which on a real cloud would land straight in the propagation window.
      return { data: { instanceId, region: 'fake-1' }, initial: viewOf(instance) }
    },

    async describe(data: ProviderData): Promise<InstanceView> {
      await enter('describe')

      const instanceId = String(data['instanceId'] ?? '')
      const known = instances.get(instanceId)

      // AMENDMENT A4, implemented as the reference case.
      //
      // Absence maps to `terminated` — but only after a bounded grace, and only for an
      // instance never yet observed running. A provider that skips this reports a healthy,
      // booting, BILLING instance as dead the moment it is created, because the create call
      // returns before the read path is consistent. That is a data-loss bug, and it is the
      // single easiest rule in the SDK to leave out.
      //
      // AND ONLY FOR ONE NEVER SEEN RUNNING, which is the other half of the same rule and was
      // missing here (rockysurf-r5qn). An instance this provider has already answered `running`
      // for is not ambiguous when it disappears: it is gone, and sitting through the grace to
      // say so is pure delay in a teardown core polls in a loop. `provider-aws` and
      // `provider-hetzner` both take the narrow reading; this file is the one a provider author
      // reads to learn the rule, so it was teaching the wrong one.
      if (!known || !visible(known)) {
        const attempts = seenRunning.has(instanceId) ? 1 : DESCRIBE_ABSENCE_GRACE.attempts
        for (let attempt = 1; attempt < attempts; attempt++) {
          await new Promise<void>((r) => setTimeout(r, DESCRIBE_ABSENCE_GRACE.delayMs))
          const retry = instances.get(instanceId)
          if (retry && visible(retry)) return served(retry)
        }
        return { state: 'terminated' }
      }

      return served(known)
    },

    async terminate(data: ProviderData): Promise<void> {
      await enter('terminate')
      const instanceId = String(data['instanceId'] ?? '')
      const instance = instances.get(instanceId)
      // Idempotent: not-found is SUCCESS, not an error.
      if (!instance) return
      if (instance.state === 'terminated' || instance.state === 'terminating') return

      instance.state = terminateMs > 0 ? 'terminating' : 'terminated'
      instance.goneAt = now() + terminateMs
    },

    async listManaged(): Promise<ManagedResource[]> {
      await tick()
      const resources: ManagedResource[] = []
      for (const instance of instances.values()) {
        settle(instance)
        // A `terminating` instance still exists and still holds resources, so the reconciler
        // must still see it. Only `terminated` is gone.
        if (instance.state === 'terminated') continue
        resources.push({
          kind: 'instance',
          providerNativeId: instance.instanceId,
          ownership: 'server-owned',
          serverId: instance.spec.serverId,
        })
      }
      // One shared resource, so a reconciler that treats the list as a delete-list is caught
      // by the fake rather than by a real cloud.
      resources.push({ kind: 'network', providerNativeId: `${id}-shared-net`, ownership: 'shared' })
      return resources
    },

    async stop(data: ProviderData) {
      await enter('stop')
      // A2: required method, throws when the capability is false. Core checks the flag first,
      // but a provider must still refuse — the flag and the method cannot be allowed to drift.
      if (!capabilities.stop) throw unsupportedOperationError(id, 'stop')
      const instance = requireVisible(data)
      if (!instance) throw new ProviderError('not_found', `no such instance: ${String(data['instanceId'])}`)
      if (instance.state !== 'running') {
        throw new ProviderError('conflict', `instance is ${instance.state}, not running`)
      }
      instance.state = stopMs > 0 ? 'stopping' : 'stopped'
      instance.stoppedAt = now() + stopMs
    },

    async start(data: ProviderData) {
      await enter('start')
      if (!capabilities.stop) throw unsupportedOperationError(id, 'start')
      const instance = requireVisible(data)
      if (!instance) throw new ProviderError('not_found', `no such instance: ${String(data['instanceId'])}`)
      if (instance.state !== 'stopped') {
        throw new ProviderError('conflict', `instance is ${instance.state}, not stopped`)
      }
      instance.runningAt = now() + startAckMs + bootMs
      if (startAckMs > 0) {
        // Accepted, and still answering `stopped`. This is the window core used to paper over
        // by writing `running` itself (rockysurf-55fx.15).
        instance.leavesStoppedAt = now() + startAckMs
      } else {
        delete instance.leavesStoppedAt
        instance.state = bootMs > 0 ? 'pending' : 'running'
      }
      // A provider whose IP does not survive a stop hands back a different one, which is what
      // drives the previousIp / ipChangedAt breadcrumb in core.
      if (!capabilities.ipStableAcrossStop) instance.publicIp = `198.51.100.${(++seq % 250) + 1}`
    },
  }

  return provider
}
