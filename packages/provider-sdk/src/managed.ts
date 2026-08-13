/**
 * What the reconciler sees. Every resource a provider created and could leak.
 */

/**
 * Who a managed resource belongs to, and therefore who may delete it (ADR-0003, D1).
 *
 * This was the third of three divergences the spike found living in prose comments rather
 * than in the type, and it cuts both ways:
 *
 * - AWS's shared `rocky-surf-ssh` security group carries the managed-by tag but intentionally
 *   outlives every server. A reconciler treating `listManaged()` as a delete-list would tear
 *   it out from under running instances.
 * - Hetzner's SSH Key objects must be reaped WITH the server that owns them. A reconciler
 *   treating the list as append-only would orphan them forever.
 *
 * One list, two opposite correct behaviours, and nothing in the old type to tell them apart.
 */
export type ResourceOwnership =
  /**
   * Created for one server and reaped with it. `serverId` identifies which.
   *
   * A resource of this kind with no live server is an orphan and the reconciler should
   * delete it.
   */
  | 'server-owned'
  /**
   * Shared infrastructure that outlives individual servers — a security group, a network.
   *
   * The reconciler MUST NOT delete these as part of server teardown. They are reported so
   * that an audit can account for them, not so that it can reap them.
   */
  | 'shared'

export const RESOURCE_OWNERSHIPS = ['server-owned', 'shared'] as const satisfies readonly ResourceOwnership[]

/**
 * One provider-side resource attributable to this installation.
 *
 * `listManaged()` returns these, and it must cover SECONDARY resources too, not just
 * instances (ADR-0003, D2). Hetzner's API refuses raw key material inline, so `provision()`
 * has to create a first-class SSH Key object first — and a crash between those two calls
 * orphans a key the database never references. Only a sweep that knows about the secondary
 * kind can find it.
 *
 * Two rules that follow, both learned the hard way:
 *
 * 1. A provider must NOT claim pre-existing resources it merely matched (Hetzner keys dedupe
 *    by fingerprint, so an unrelated key with the same fingerprint is someone else's).
 * 2. Block-storage providers must specify volume lifecycle explicitly (ADR-0003, D4). Sizing
 *    an EC2 root volume requires the AMI's own `RootDeviceName`; guessing `/dev/sda1`
 *    silently attaches a SECOND volume that survives termination and is invisible to any
 *    audit that only walks instances.
 */
export interface ManagedResource {
  /**
   * Provider-native resource kind: `instance`, `volume`, `security-group`, `ssh-key`.
   *
   * Free-form by design — the set of kinds a cloud has is not something this SDK can
   * enumerate. Core does not branch on it; it is for audit output and for the provider's own
   * `terminate()` to interpret.
   */
  kind: string
  /** The provider's id for this resource, as its API would accept it. */
  providerNativeId: string
  /** Who owns it, and therefore whether the reconciler may delete it. */
  ownership: ResourceOwnership
  /**
   * The server this resource belongs to, from its tags/labels.
   *
   * Expected whenever `ownership === 'server-owned'` and the resource is attributable. Absent
   * for `shared` resources, and absent for a server-owned resource whose tag is missing —
   * which is itself a finding worth surfacing, since an unattributable owned resource cannot
   * be safely reaped by server.
   */
  serverId?: string
}
