import type { ProviderCapabilities } from './capabilities.js'
import type { InstanceView } from './instance.js'
import type { ManagedResource } from './managed.js'
import type { Offering } from './offering.js'
import type { ProvisionSpec } from './provision.js'
import type { SshAccessSyncResult } from './ssh-access.js'

/**
 * A provider's opaque handle for one instance (ADR-0003, A1).
 *
 * The sketch made `ComputeProvider` generic over this. That failed: `TData` appeared in both
 * input and output position, making the interface invariant, so a registry holding an AWS
 * provider beside a Hetzner one could not be typed at all and every heterogeneous holder
 * degraded to `any` — erasing exactly the safety the generic was added for. The data
 * round-trips through JSON in the database anyway, so a compile-time type here is fiction the
 * moment a row is read back. Providers narrow it internally, at the edge where the fiction
 * ends.
 */
export type ProviderData = Record<string, unknown>

/** What `provision()` hands back (ADR-0003, A6). */
export interface ProvisionResult {
  /** The handle to persist. Passed back to `describe`/`terminate`/`stop`/`start`. */
  data: ProviderData
  /**
   * The instance's state as of the create call.
   *
   * Returned so core does not have to immediately call `describe()` to learn what the create
   * response already told it — an extra round trip on the one call that knows the answer, and
   * on AWS a round trip straight into the eventual-consistency window described on
   * {@link ComputeProvider.describe}.
   */
  initial: InstanceView
}

/**
 * The reference propagation grace for {@link ComputeProvider.describe} (ADR-0003, A4).
 *
 * These are the values proven in the spike. A provider may lengthen the grace; it may never
 * skip it.
 */
export const DESCRIBE_ABSENCE_GRACE = {
  /** Total attempts before absence is believed, including the first. */
  attempts: 4,
  /** Delay between attempts, in milliseconds. */
  delayMs: 2000,
} as const

/**
 * The contract every compute provider implements. Frozen at v0 by ADR-0003.
 *
 * Deliberately absent, and not to be added without a new ADR: `interruptible` /
 * `checkInterruption` and spot instances; `resize`; live pricing APIs; dynamic out-of-tree
 * plugin loading; per-server IAM. Each was cut for the same reason — generalizing from zero
 * implementations, with no out-of-tree consumers, is premature. The spike confirmed nothing
 * had changed.
 */
export interface ComputeProvider {
  /** Stable, lowercase: 'aws', 'hetzner', 'byo'. Core must NEVER branch on this. */
  readonly id: string
  /** Human-facing name for UI. */
  readonly displayName: string
  /** The only thing core branches on. See `ProviderCapabilities`. */
  readonly capabilities: ProviderCapabilities

  /**
   * Prove the configured credentials work, cheaply.
   *
   * Throws `ProviderError('auth')` when they do not. Should be the cheapest authenticated
   * call the API offers, and should also prove the configured region exists.
   */
  validateCredentials(): Promise<void>

  /**
   * Reject a spec this provider cannot satisfy, BEFORE anything is created (ADR-0003, A7).
   *
   * The provider owns its own limits — `userDataMaxBytes` chief among them, which was
   * advisory-only in the sketch, so the failure mode was a vendor-specific rejection at
   * provision time. Throws `ProviderError('invalid_spec')` with a message naming the field.
   *
   * Core calls this before `provision()`; `provision()` must not assume it was called.
   */
  validateSpec(spec: ProvisionSpec): Promise<void>

  /**
   * Machine types this provider can sell, including ones it currently cannot
   * (`available: false` — see `Offering.available`).
   */
  listOfferings(): Promise<Offering[]>

  /**
   * Create one instance.
   *
   * MUST be idempotent on `spec.idempotencyKey`: a replay returns the ORIGINAL instance
   * rather than creating a second one. Providers whose API has no idempotency primitive
   * implement this themselves — Hetzner dedupes on the derived server name.
   *
   * May create SECONDARY resources (SSH key objects, security groups) as a side effect. Those
   * must be reported by `listManaged()` with the right `ownership`, and server-owned ones must
   * be cleaned up by `terminate()` (ADR-0003, D2).
   */
  provision(spec: ProvisionSpec): Promise<ProvisionResult>

  /**
   * Read one instance's current state.
   *
   * **Absence maps to `terminated`, but ONLY after a bounded propagation grace.** This rule is
   * stated here, beside the mapping it modifies, because it is the highest-severity finding of
   * the entire spike (ADR-0003, A4) and a provider written from the mapping alone ships a
   * data-loss bug:
   *
   * - Core polls `describe()` in a loop during teardown, so a vanished instance must be a
   *   normal outcome and NOT an error — hence the mapping.
   * - But `DescribeInstances` is eventually consistent. In `spike/verify-aws.run1.log` a
   *   `describe()` 0.1s after a SUCCESSFUL launch returned not-found. Read literally, that
   *   mapping marks a healthy, booting, billing instance dead and stops tracking it — an
   *   orphan created by core's own bookkeeping.
   *
   * Normative rule: believe absence only after {@link DESCRIBE_ABSENCE_GRACE} (4 attempts,
   * 2s apart), and only for an instance never yet observed running. A provider may lengthen
   * the grace; it may never skip it.
   *
   * Note the asymmetry with {@link listManaged}: a `terminating` instance is reported as
   * `terminating` here and still appears there, because it still exists.
   */
  describe(data: ProviderData): Promise<InstanceView>

  /**
   * Destroy the instance and every `server-owned` resource created for it.
   *
   * Idempotent: not-found is SUCCESS, not an error. Returning normally means the provider has
   * accepted the request, not that the resources are gone — expect `terminating` from
   * `describe()` for a while afterwards.
   */
  terminate(data: ProviderData): Promise<void>

  /**
   * Every resource attributable to this installation — the reconciler's whole input.
   *
   * Scoped by a construction-time `managed-by` prefix, which is a documented constraint
   * rather than an accident (ADR-0003, D6): the prefix is not a parameter, so ONE provider
   * instance reconciles ONE prefix, and a process that must reconcile two (staging and prod
   * in one cloud account) constructs two providers. Multi-region and multi-project scoping
   * are deliberately unresolved in v0.
   *
   * Must include instances in every state that still exists at the provider, `terminating`
   * among them, and must include secondary resources.
   */
  listManaged(): Promise<ManagedResource[]>

  /**
   * Stop the instance, preserving its disk.
   *
   * REQUIRED even when `capabilities.stop` is false, in which case it must throw
   * `ProviderError('invalid_spec')` — `unsupportedOperationError` is the whole implementation
   * (ADR-0003, A2). Core branches on the capability flag, never on whether this method
   * exists, because a `typeof p.stop === 'function'` check scattered through core is a second
   * vocabulary for a fact `capabilities` already states.
   */
  stop(data: ProviderData): Promise<void>

  /**
   * Start a stopped instance.
   *
   * Same requirement as `stop()`. On a provider with `ipStableAcrossStop: false` the instance
   * comes back on a DIFFERENT public IP, and core must re-read it afterwards.
   */
  start(data: ProviderData): Promise<void>

  /**
   * Bring the shared SSH-access object in line with this provider's own `sshAllowedCidr`, now,
   * without provisioning anything.
   *
   * REQUIRED when `capabilities.managesSshAccess` is `true`, and absent otherwise — the one
   * optional method on this interface (ADR-0021 amends ADR-0003 E11, whose own text invited
   * exactly this: "Revisit if a second provider needs the same call." Three do).
   *
   * Takes no argument on purpose. The provider reads the config it was constructed with, which
   * after a settings save is the config the operator just approved; handing it a list instead
   * would let a caller push CIDRs the config file does not contain, which is the one thing
   * `sshAllowedCidr` being written down is supposed to prevent.
   *
   * Implementations MUST:
   * - never create the shared object — report `skipped` when it does not exist yet;
   * - never delete it, and never delete-and-recreate it (ADR-0003 D1: it is `ownership: 'shared'`,
   *   so removing it cuts SSH to every box in the account at once);
   * - only remove entries they can prove they created, and `reported` everything else;
   * - authorize what is missing BEFORE removing what is extra, so a failure part-way through
   *   leaves the operator with more access than they had, never less;
   * - own their own deadline, so one unreachable cloud cannot hang the caller.
   */
  syncSshAccess?(): Promise<SshAccessSyncResult>
}

/**
 * A parsed, validated provider configuration. Provider-specific by nature.
 */
export type ProviderConfig = Record<string, unknown>

/**
 * The minimal shape a config schema must satisfy.
 *
 * Deliberately structural, and deliberately tiny: `zod`'s `ZodType` already has a `parse`
 * with this signature, so a provider package can export a zod schema that satisfies this
 * WITHOUT this SDK depending on zod. Zero runtime dependencies is an acceptance criterion of
 * the SDK, and a validation library in the contract would be inherited by every provider and
 * every consumer.
 *
 * @see the README for the full export convention.
 */
export interface ConfigSchema<TConfig> {
  /** Validate and coerce unknown input, throwing on invalid input. */
  parse(input: unknown): TConfig
}

/**
 * What a provider package exports as its default export: how to describe, validate and
 * construct one provider.
 *
 * Keeping construction behind a factory (rather than exporting a class) is what lets core
 * load a provider, show its identity, and validate its configuration BEFORE holding a live
 * instance of it — which matters because `createProvider` receives already-parsed config and
 * must not perform I/O.
 *
 * @typeParam TConfig - the provider's own configuration shape.
 */
export interface ProviderFactory<TConfig = ProviderConfig> {
  /** Matches the `id` of the providers it creates. */
  readonly id: string
  readonly displayName: string
  /**
   * Schema for this provider's configuration — typically a zod schema, structurally typed so
   * that zod stays out of this package's dependencies.
   */
  readonly configSchema: ConfigSchema<TConfig>
  /**
   * Build a provider from already-parsed configuration.
   *
   * Must be synchronous and side-effect free: no network, no filesystem, no credential check.
   * Credentials are proven by `validateCredentials()`, which core calls when it chooses to.
   */
  createProvider(config: TConfig): ComputeProvider
}
