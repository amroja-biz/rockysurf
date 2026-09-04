import {
  ARCHITECTURES,
  DESCRIBE_ABSENCE_GRACE,
  INSTANCE_STATES,
  isProviderError,
  PROVIDER_ERROR_CODES,
  RESOURCE_OWNERSHIPS,
  type ComputeProvider,
  type InstanceView,
  type ManagedResource,
  type Offering,
  type ProviderFactory,
} from '@rockysurf/provider-sdk'

/**
 * `@rockysurf/provider-conformance` — the checks every compute provider runs against itself.
 *
 * Deliberately test-framework-free: these take values and throw `ConformanceError`, so they
 * can be called from vitest, from a fixture harness, or from a future real-cloud verification
 * script without dragging a runner along.
 *
 * WHY THIS PACKAGE EXISTS. The suite was written inside `@rockysurf/provider-hetzner`
 * (rockysurf-55fx.8) with a note that it wanted a shared home but that promoting it needed a
 * decision, since provider packages must not import each other and the SDK keeps zero runtime
 * dependencies as an acceptance criterion. The second consumer has now arrived
 * (`@rockysurf/provider-aws`, rockysurf-gyp1.1), which is the trigger that note named — and
 * duplicating an assertion suite is precisely how two providers drift into asserting
 * different things about the same contract.
 *
 * It depends only on the SDK, and only providers' TEST code depends on it, so the SDK's
 * zero-dependency promise is untouched.
 *
 * MIGRATION NOTE: `provider-hetzner` still carries its own copy. Moving it over is a
 * one-import change and is left to that package's owner rather than done from inside another
 * provider's task — see the gyp1.1 report.
 */

export class ConformanceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConformanceError'
  }
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConformanceError(message)
}

/** Static shape: every method present, identity sane, capabilities complete. */
export function assertProviderShape(provider: ComputeProvider): void {
  check(typeof provider.id === 'string' && provider.id.length > 0, 'provider.id must be a non-empty string')
  check(provider.id === provider.id.toLowerCase(), `provider.id '${provider.id}' must be lowercase`)
  check(typeof provider.displayName === 'string' && provider.displayName.length > 0, 'displayName required')

  const methods = [
    'validateCredentials',
    'validateSpec',
    'listOfferings',
    'provision',
    'describe',
    'terminate',
    'listManaged',
    // REQUIRED even when capabilities.stop is false, where they throw invalid_spec
    // (ADR-0003, A2). Core branches on the flag, never on whether the method exists.
    'stop',
    'start',
  ] as const

  for (const method of methods) {
    check(typeof provider[method] === 'function', `provider must implement ${method}()`)
  }

  const caps = provider.capabilities
  check(typeof caps?.stop === 'boolean', 'capabilities.stop must be a boolean')
  check(typeof caps.ipStableAcrossStop === 'boolean', 'capabilities.ipStableAcrossStop must be a boolean')
  check(typeof caps.canInjectHostKeys === 'boolean', 'capabilities.canInjectHostKeys must be a boolean')
  check(Number.isInteger(caps.userDataMaxBytes) && caps.userDataMaxBytes >= 0, 'userDataMaxBytes must be >= 0')
  check(typeof caps.generatesUserData === 'boolean', 'capabilities.generatesUserData must be a boolean')

  /**
   * `managesSshAccess` and `syncSshAccess()` are ONE claim, checked in both directions (ADR-0021).
   *
   * Deliberately NOT in the required-methods list above: this is the first OPTIONAL method on the
   * interface, because a required one is a breaking change for every provider written outside this
   * repository, while a capability nobody declares costs them nothing. That freedom is exactly why
   * the two halves need pinning together — an optional method is the shape that can silently drift
   * out of agreement with its flag.
   *
   * Both directions matter. A provider declaring the flag without the method is a crash the first
   * time an operator saves a CIDR. A provider implementing the method without the flag is worse in
   * a quieter way: core branches on the FLAG and never on `typeof provider.syncSshAccess`, so the
   * method is simply never called — the provider looks like it maintains a whitelist, and silently
   * does not.
   */
  if (caps.managesSshAccess === true) {
    check(
      typeof provider.syncSshAccess === 'function',
      'capabilities.managesSshAccess is true, so the provider must implement syncSshAccess()',
    )
  } else {
    check(
      provider.syncSshAccess === undefined,
      'provider implements syncSshAccess() without declaring capabilities.managesSshAccess — core ' +
        'branches on the flag, so the method would never be called',
    )
  }

  /**
   * The optional capabilities are optional, not loosely typed (ADR-0025). A provider that sets
   * `billsWhileStopped: 'yes'` or `1` would read as truthy in core's billing predicate and as
   * absent in a strict comparison, which is two answers to a question about money. Absent is
   * legal and means false; present must be a boolean.
   */
  if (caps.billsWhileStopped !== undefined) {
    check(typeof caps.billsWhileStopped === 'boolean', 'capabilities.billsWhileStopped must be a boolean when present')
  }
  if (caps.simulatedInstances !== undefined) {
    check(typeof caps.simulatedInstances === 'boolean', 'capabilities.simulatedInstances must be a boolean when present')
  }

  // A provider that cannot deliver user-data cannot place a host key before first contact.
  if (!caps.generatesUserData) {
    check(!caps.canInjectHostKeys, 'canInjectHostKeys requires generatesUserData')
  }
}

/** A factory's exports, including that `createProvider` does no I/O. */
export function assertFactoryShape<T>(factory: ProviderFactory<T>, validConfig: T): void {
  check(typeof factory.id === 'string' && factory.id.length > 0, 'factory.id required')
  check(typeof factory.displayName === 'string', 'factory.displayName required')
  check(typeof factory.configSchema?.parse === 'function', 'factory.configSchema must have parse()')

  const provider = factory.createProvider(validConfig)
  check(provider.id === factory.id, `createProvider() returned id '${provider.id}', expected '${factory.id}'`)
  assertProviderShape(provider)
}

/**
 * Offering invariants, exercised against every provider's REAL `listOfferings()` result — not
 * just the shape of the type. AWS's catalogue grew from 14 hand-picked types to roughly a
 * thousand, generated mechanically (rockysurf-tzzw); a suite that only checked `listOfferings`
 * was a function would have said nothing about whether that thousand-row table is internally
 * consistent. These five checks are what would actually break if the generator or a provider's
 * `buildOfferings()` went wrong: a duplicate id (two rows racing for the same offering), a
 * non-positive cpu/mem (a parsing bug in the feed join), an architecture outside the frozen set,
 * a malformed price where `null` was meant, or a blank region.
 */
export function assertOfferingsShape(offerings: readonly Offering[]): void {
  const seenIds = new Set<string>()

  for (const offering of offerings) {
    const where = `offering '${offering.id}'`
    check(typeof offering.id === 'string' && offering.id.length > 0, `${where}: id required`)
    check(Number.isFinite(offering.cpu) && offering.cpu > 0, `${where}: cpu must be positive`)
    check(Number.isFinite(offering.memoryGb) && offering.memoryGb > 0, `${where}: memoryGb must be positive`)
    check((ARCHITECTURES as readonly string[]).includes(offering.arch), `${where}: arch '${offering.arch}' invalid`)
    check(typeof offering.available === 'boolean', `${where}: available must be a boolean`)
    // A reason is an explanation of `available: false`; one on an available offering is a
    // contradiction a selector cannot render.
    if (offering.unavailableReason !== undefined) {
      check(
        typeof offering.unavailableReason === 'string' && offering.unavailableReason.length > 0,
        `${where}: unavailableReason must be a non-empty string when present`,
      )
      check(!offering.available, `${where}: unavailableReason is set on an available offering`)
    }
    check(typeof offering.region === 'string' && offering.region.length > 0, `${where}: region required`)

    // A duplicate id is two offerings a caller cannot tell apart — `validateSpec()` resolves a
    // `ProvisionSpec.offeringId` by matching exactly one of these, and `find()` would silently
    // pick whichever came first.
    check(!seenIds.has(offering.id), `${where}: duplicate offering id — every id must be unique per listOfferings() call`)
    seenIds.add(offering.id)

    // `hourly: null` means UNKNOWN and is legal. A malformed price is not.
    if (offering.hourly !== null) {
      const price = offering.hourly
      check(Number.isFinite(price.amount) && price.amount > 0, `${where}: price amount must be > 0`)
      check(/^[A-Z]{3}$/.test(price.currency), `${where}: currency '${price.currency}' must be ISO 4217`)
      check(!Number.isNaN(Date.parse(price.fetchedAt)), `${where}: fetchedAt must be ISO 8601`)
    }
  }
}

export function assertManagedShape(resources: readonly ManagedResource[]): void {
  for (const resource of resources) {
    const where = `managed resource '${resource.providerNativeId}'`
    check(typeof resource.kind === 'string' && resource.kind.length > 0, `${where}: kind required`)
    check(typeof resource.providerNativeId === 'string', `${where}: providerNativeId must be a string`)
    check(
      (RESOURCE_OWNERSHIPS as readonly string[]).includes(resource.ownership),
      `${where}: ownership '${resource.ownership}' invalid`,
    )
    // Absent serverId on a server-owned resource is legal but notable — an owned resource
    // nobody can attribute cannot be safely reaped by server.
    if (resource.serverId !== undefined) {
      check(typeof resource.serverId === 'string', `${where}: serverId must be a string when present`)
    }
  }
}

/** Anything thrown across the interface must be a ProviderError with a frozen code. */
export function assertProviderErrorShape(err: unknown): void {
  check(isProviderError(err), `expected a ProviderError, got ${String(err)}`)
  check(
    (PROVIDER_ERROR_CODES as readonly string[]).includes(err.code),
    `ProviderError code '${err.code}' is not one of the nine frozen codes`,
  )
  check(typeof err.retryable === 'boolean', 'ProviderError.retryable must be derived and boolean')
}

export function assertInstanceStateValid(state: string): void {
  check((INSTANCE_STATES as readonly string[]).includes(state), `instance state '${state}' is not in the frozen set`)
}

/* ------------------------------------------------------- describe() absence grace (A4) */

/**
 * What one read of the provider's underlying instance-read API answers.
 *
 * Only the two answers the grace turns on: the instance is not there, or it is there and
 * running. Every other state maps through paths the shape assertions already cover.
 */
export type DescribeRead = 'absent' | 'running'

/** One scripted scenario, ready to be described exactly once. */
export interface AbsenceGraceProbe {
  /**
   * Call `describe()` once and report both what it decided AND how many reads of the
   * underlying API it spent deciding. The read count is the whole point: the difference
   * between a provider that honours the grace and one that skips it is invisible in the
   * returned state alone whenever the instance really is gone.
   */
  run(): Promise<{ view: InstanceView; reads: number }>
}

/**
 * The provider-specific wiring {@link assertDescribeAbsenceGrace} needs.
 *
 * Behaviour, unlike shape, cannot be asserted from the `ComputeProvider` interface alone —
 * it needs the provider's read path stubbed, and only the provider's own tests know how to
 * do that (an EC2 client mock, a `fetch` route table, an in-memory map). So the harness is
 * the seam: each provider supplies four lines of wiring and inherits the assertions.
 */
export interface AbsenceGraceHarness {
  /** Provider id, for failure messages. */
  readonly provider: string
  /**
   * The grace the provider under test was BUILT with, when tests shorten the delay or
   * lengthen the attempts. Defaults to {@link DESCRIBE_ABSENCE_GRACE}. Only `attempts`
   * matters here; a test that also zeroes `delayMs` (all three providers do) changes what the
   * suite costs, never what it proves.
   */
  readonly grace?: { attempts: number }
  /**
   * A probe over an instance this provider has NEVER observed running — the ambiguous case,
   * where absence might be a create that has not propagated yet.
   *
   * The read path must answer `script` in order and then repeat the LAST entry forever, so
   * `['absent']` is "gone, permanently" and `['absent', 'absent', 'running']` is the
   * eventual-consistency window that cost a live instance in rockysurf-gyp1.4.
   */
  neverSeenRunning(script: readonly DescribeRead[]): Promise<AbsenceGraceProbe> | AbsenceGraceProbe
  /**
   * A probe over an instance this provider HAS observed running and that its read path now
   * reports gone — the teardown path, which core polls in a loop. Reads must be counted from
   * the moment it went absent, not from the observation that made it `running`.
   */
  goneAfterRunning(): Promise<AbsenceGraceProbe> | AbsenceGraceProbe
}

/**
 * The absence grace, asserted behaviourally (ADR-0003 amendment A4).
 *
 * WHY THIS EXISTS RATHER THAN A COMMENT IN THE SDK. The rule was already stated plainly
 * beside {@link DESCRIBE_ABSENCE_GRACE} and again on `describe()`, and `provider-aws` still
 * shipped without it (rockysurf-gyp1.4): `describe()` believed the first not-found, core
 * wrote `terminated` onto an instance EC2 had `running`, and `terminate()` short-circuits on
 * a terminated row — so the box ran and billed with nothing in the system pointing at it.
 * Eighty-five tests were green, because the only provider any of them exercised was the fake,
 * which implements the grace correctly. A rule that only one implementation is checked
 * against is a rule the next provider author gets to skip by accident.
 *
 * Three assertions, in the order they matter:
 *
 *   1. Absence that turns out to be propagation lag must NOT be reported as `terminated`.
 *      This is the data-loss bug itself, expressed as a test.
 *   2. Absence that persists must be believed only after the full attempt count.
 *   3. Absence AFTER the instance was seen running must be believed on the first read — the
 *      grace exists for ambiguity, and there is none here. Teardown pays nothing for it.
 */
export async function assertDescribeAbsenceGrace(harness: AbsenceGraceHarness): Promise<void> {
  const attempts = harness.grace?.attempts ?? DESCRIBE_ABSENCE_GRACE.attempts
  const where = `[${harness.provider}] describe()`

  check(
    attempts >= DESCRIBE_ABSENCE_GRACE.attempts,
    `${where}: built with a grace of ${attempts} attempts, below DESCRIBE_ABSENCE_GRACE.attempts (${DESCRIBE_ABSENCE_GRACE.attempts}). A provider may lengthen the grace; it may never shorten it.`,
  )

  // 1. THE DATA-LOSS CASE. A create that has not propagated is indistinguishable from a
  //    termination on the first read, so the first read must not be allowed to decide.
  {
    const script: DescribeRead[] = [...Array<DescribeRead>(attempts - 1).fill('absent'), 'running']
    const { view, reads } = await (await harness.neverSeenRunning(script)).run()
    check(
      view.state !== 'terminated',
      `${where}: reported 'terminated' for an instance that was never seen running and answered 'running' on read ${script.length} of a ${attempts}-attempt grace. This is the gyp1.4 data-loss bug: core marks a live, billing instance dead and terminate() then no-ops on it.`,
    )
    check(
      view.state === 'running',
      `${where}: expected 'running' once the instance appeared within the grace, got '${view.state}'`,
    )
    check(
      reads >= script.length,
      `${where}: returned 'running' after ${reads} read(s) of a ${script.length}-read script — the harness is not counting reads of the provider's read path`,
    )
  }

  // 2. The grace is bounded, and it is spent before absence is believed.
  {
    const { view, reads } = await (await harness.neverSeenRunning(['absent'])).run()
    assertInstanceStateValid(view.state)
    check(
      view.state === 'terminated',
      `${where}: absence must map to 'terminated' once the grace is exhausted — core polls this in a loop during teardown, so a vanished instance is a normal outcome, not an error. Got '${view.state}'.`,
    )
    check(
      reads >= attempts,
      `${where}: believed absence after ${reads} read(s); the grace requires at least ${attempts}. A provider that skips it reports a healthy, booting instance dead.`,
    )
  }

  // 3. …and nowhere else. An instance seen running and now absent really is gone.
  {
    const { view, reads } = await (await harness.goneAfterRunning()).run()
    check(
      view.state === 'terminated',
      `${where}: an instance seen running and now absent must be 'terminated', got '${view.state}'`,
    )
    check(
      reads === 1,
      `${where}: spent ${reads} reads on an instance it had already seen running. There is no ambiguity to wait out, and this is the teardown path core polls — the grace would be pure delay on every terminate.`,
    )
  }
}
