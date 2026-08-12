import { ProviderError } from './errors.js'
import type { Architecture } from './offering.js'

/**
 * An RFC 1123 label: lowercase alphanumerics and hyphens, starting and ending alphanumeric,
 * 63 characters or fewer.
 */
const HOSTNAME_SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Whether an id is safe to use directly as a provider-side resource name (ADR-0003, C2).
 *
 * This is not cosmetic. `srv_a1b2` is not a legal Hetzner server name (RFC 1123 forbids
 * underscores), and on Hetzner the NAME is the idempotency mechanism — so any provider given
 * an unsafe id has to sanitize it, and the sanitizing map must be injective or two logical
 * servers end up fighting over one cloud resource. Folding underscores to hyphens is not
 * injective: `srv_a` and `srv-a` both become `srv-a`.
 *
 * ADR-0003 takes the structural fix — ids are hostname-safe at the source — and explicitly
 * REJECTS the alternative of adding a `dedupeName` field to {@link ProvisionSpec}, which
 * would be one more thing every provider must remember to prefer.
 */
export function isHostnameSafeId(id: string): boolean {
  return HOSTNAME_SAFE_ID.test(id)
}

/**
 * Throws `ProviderError('invalid_spec')` unless `id` is hostname-safe.
 *
 * Providers should call this from `validateSpec`. It is cheap, and the failure it prevents —
 * two servers sharing one cloud resource — is not recoverable by retrying.
 */
export function assertHostnameSafeId(id: string, field = 'serverId'): void {
  if (!isHostnameSafeId(id)) {
    throw new ProviderError(
      'invalid_spec',
      `${field} '${id}' is not hostname-safe: expected an RFC 1123 label ` +
        '(lowercase alphanumerics and hyphens, starting and ending alphanumeric, <=63 chars)',
    )
  }
}

/**
 * Everything a provider needs to create one instance.
 *
 * Note what is NOT here. `hostKeys` was removed by ADR-0003 (E2): no provider ever consumed
 * it, the public half reaches the box through rendered user-data, and the private half needs
 * an encrypted home in core (E3) rather than a trip through a provider. Bootstrap tokens are
 * absent for the same reason — in push mode, the default topology, no token ever goes to the
 * box at all (ADR-0002); in callback mode core renders one INTO `userData` itself.
 */
export interface ProvisionSpec {
  /**
   * Core's server id, used for tagging and — on providers whose dedupe mechanism is the
   * resource name — as the name itself.
   *
   * MUST be hostname-safe; see {@link isHostnameSafeId}. Core guarantees this at id-minting
   * time, and providers should still assert it in `validateSpec` rather than sanitizing.
   */
  serverId: string
  /** Human-facing name. Becomes the hostname in rendered user-data. */
  name: string
  /** Provider-native offering id, from `listOfferings()`. */
  offeringId: string
  arch: Architecture
  /**
   * Public keys the PROVIDER must register with its own API (ADR-0003, E2).
   *
   * Core is the sole owner of key material; this field exists only because some APIs will not
   * take raw key material inline. On Hetzner it is load-bearing: the create call must
   * reference first-class SSH Key objects, so the provider creates them (see
   * `ManagedResource` — those objects are secondary resources it then owns). On cloud-init
   * providers like AWS it is effectively redundant, because keys reach the box through
   * `userData`; the AWS provider merely asserts they appear there and creates no key pair.
   *
   * The same keys are ALSO rendered into `userData` by core. That is not a bug: `userData` is
   * how the box actually authorizes them, and this field is how the provider's API learns
   * about them.
   */
  sshPublicKeys: string[]
  /**
   * The rendered `#cloud-config` document, verbatim, or `''` when
   * `capabilities.generatesUserData` is false.
   *
   * Providers pass this through unchanged (base64-encoding it if their API requires that) and
   * MUST NOT append to it. In push mode it is inert — no `runcmd`, no shell — and constant at
   * ~2.1KB no matter how much software the install plan later adds (ADR-0002).
   */
  userData: string
  /**
   * Tags/labels to apply. Always includes `managed-by=<prefix>` and `server-id=<id>`.
   *
   * A provider MUST refuse a spec whose `managed-by` disagrees with its own configured prefix
   * (ADR-0003, D3): an instance tagged with anything else is invisible to `listManaged()` and
   * therefore an orphan by construction, from the moment it is created.
   */
  tags: Record<string, string>
  /**
   * Deduplication key for this create attempt. The database row exists BEFORE this call.
   *
   * One field, two structurally different mechanisms, both verified against the real APIs and
   * kept as-sketched (ADR-0003, C3): AWS passes it straight through as an EC2 `ClientToken`,
   * while Hetzner has no such concept and dedupes on the derived server name.
   *
   * The key MUST include a generation/epoch component (ADR-0003, C1). Hashing only
   * (name, provider, offering) means a user who terminates `dev-box` and recreates it with
   * identical settings collides with the dead row forever.
   */
  idempotencyKey: string
}
