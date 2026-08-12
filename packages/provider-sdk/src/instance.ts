/**
 * What a provider reports about one instance.
 */

/**
 * The frozen instance state machine.
 *
 * Two states here were added by ADR-0003 because the spike proved the sketch's union could
 * not describe reality:
 *
 * - `terminating` (A3) — EC2 sits in `shutting-down` for 30-120s and Hetzner in `deleting`
 *   for seconds. With nowhere to put that, the two spike providers picked two DIFFERENT wrong
 *   answers: AWS reported `terminated` (honest about intent, but it made zero-orphan audits
 *   falsely green for a minute while the instance still existed) and Hetzner reported
 *   `stopping`, which the app layer read as `running` — a latent bug that would resurrect a
 *   terminating row if anything polled it.
 * - `failed` (A5) — a provider-side failed instance previously read as `unknown`,
 *   indistinguishable from "the API was weird".
 */
export type InstanceState =
  /** Accepted and coming up. Not yet reachable. */
  | 'pending'
  /** Running. Usable, and billing. */
  | 'running'
  /** On its way to `stopped`. */
  | 'stopping'
  /** Stopped with its disk intact. Restartable via `start()`. Usually still billing for storage. */
  | 'stopped'
  /**
   * Irreversibly on its way out, but NOT gone yet (ADR-0003, A3).
   *
   * The instance may still exist, still hold its IP, and still bill. Core must treat this as
   * terminal for scheduling — it is never coming back — while a reconciler must treat it as
   * STILL PRESENT, because the resources have not been released.
   */
  | 'terminating'
  /** Gone. The provider has released the resources. */
  | 'terminated'
  /**
   * The provider itself reports the instance as failed (ADR-0003, A5).
   *
   * Distinct from `unknown`: this is the cloud saying the instance is broken, not the SDK
   * failing to find out. See {@link InstanceView.failureReason}.
   */
  | 'failed'
  /** The provider returned a state this SDK does not model. Never guess on the caller's behalf. */
  | 'unknown'

export const INSTANCE_STATES = [
  'pending',
  'running',
  'stopping',
  'stopped',
  'terminating',
  'terminated',
  'failed',
  'unknown',
] as const satisfies readonly InstanceState[]

/**
 * States with no further transitions. `terminating` is deliberately NOT here — it is going to
 * become `terminated`, and until it does the resources still exist.
 */
export const TERMINAL_INSTANCE_STATES: ReadonlySet<InstanceState> = new Set<InstanceState>([
  'terminated',
  'failed',
])

/** Whether this instance will never change state again. */
export function isTerminalInstanceState(state: InstanceState): boolean {
  return TERMINAL_INSTANCE_STATES.has(state)
}

/**
 * States where the instance still exists at the provider and may still cost money.
 *
 * This is the predicate a reconciler and a zero-orphan audit want — NOT
 * `!isTerminalInstanceState`, which would call a `terminating` instance gone while it is still
 * holding resources. ADR-0003 (D5) records that audits built on the interface alone were
 * falsely green on AWS for ~60s for exactly this reason; `terminating` plus this helper is
 * what retires that workaround.
 */
export function stillExistsAtProvider(state: InstanceState): boolean {
  return state !== 'terminated'
}

/** A provider's answer about one instance. */
export interface InstanceView {
  state: InstanceState
  /** Present once the provider has assigned one and the instance is far enough along. */
  publicIp?: string
  publicDns?: string
  /** The offering the instance is actually running, which may differ from what was requested. */
  offeringId?: string
  /**
   * `SHA256:…` of the host key this instance presents, when the PROVIDER knows it and core did
   * not mint it.
   *
   * Additive, and only ever populated by a provider with `canInjectHostKeys: false`. On the two
   * cloud providers core generates the host key before the server exists and ships it in
   * user-data, so core already knows the answer and this field stays absent. A provider with no
   * pre-boot hook — BYO — cannot be given a key to present, so it LEARNS the box's own key
   * (trust-on-first-use on the provider's own connection, pinned and refused-on-change from then
   * on) and reports it here.
   *
   * The distinction this field preserves is worth stating, because it is the reason it exists at
   * all rather than core growing a trust-on-first-use path: what travels to core is a PIN, not a
   * decision. Core still verifies strictly, on its first connection, against a fingerprint it was
   * told beforehand — `docs/bootstrap-contract.md` push #15 stays literally true, and the one
   * connection carrying the secrets file is still verified.
   *
   * Core folds a reported value onto the server row exactly as it folds `publicIp`. A CHANGED
   * value is a refusal, never an update.
   */
  hostKeyFingerprint?: string
  /**
   * The host key ITSELF, as an OpenSSH public-key line, when the provider has met the box
   * (ADR-0003 amendment E14).
   *
   * Additive and optional, and populated only alongside {@link hostKeyFingerprint} by a provider
   * with `canInjectHostKeys: false`. The fingerprint remains the PIN — the value core verifies
   * its own connections against — and this is only ever the bytes that hash to it. Core must
   * re-check that they do before storing or serving this, because a fingerprint arrives from a
   * handshake the provider completed while this may arrive from storage.
   *
   * It exists because a fingerprint cannot become a `known_hosts` entry: ssh will not verify
   * against one non-interactively. Without the key, a client connecting to an adopted machine
   * had to fall back to a prompt, which is a weaker posture for one class of host than ADR-0002
   * requires of every other (`rockysurf-ftl9.14`).
   */
  hostPublicKey?: string
  /**
   * The TCP port sshd listens on, when it is not 22 (ADR-0003 amendment E13).
   *
   * Additive and optional; absent means 22, which is what every cloud image core provisions
   * actually uses. It exists for the same reason `hostKeyFingerprint` does: a machine core did
   * not create was configured by somebody else, and on a fleet of those, sshd on 2222 is
   * ordinary. The provider is the only party that knows — it is holding the registry entry — and
   * before this field there was nowhere to put the answer, so core dialled 22 and a host on any
   * other port was claimed, given an account and keys, and then never bootstrapped
   * (`rockysurf-ftl9.12`).
   *
   * Core folds it onto the server row exactly as it folds `publicIp`, and every connection core
   * makes to the box — the bootstrap push, and the `ssh` command it shows a human — uses it.
   */
  sshPort?: number
  /**
   * Why the instance is `failed`, in the provider's own words (ADR-0003, A5).
   *
   * Only meaningful when `state === 'failed'`. Free text for humans; never branch on it.
   */
  failureReason?: string
}
