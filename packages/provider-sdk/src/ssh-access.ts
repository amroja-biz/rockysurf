/**
 * The result of pushing an operator's `sshAllowedCidr` list at the cloud object that enforces it.
 *
 * Issue #304. The inbound CIDR has always come from the config file, and until now the ONLY thing
 * that ever wrote it to a cloud was `provision()` — so an operator who moved from home to a cafe
 * edited the setting, watched the page say "applied", and still could not SSH to anything. The
 * setting was true about the file and false about the firewall.
 *
 * `ComputeProvider.syncSshAccess()` is the call that closes that gap, and this is what it reports.
 * It takes NO argument: the provider reads its OWN config, which is the copy the operator's save
 * has already put in force (ADR-0017). Passing a CIDR list in would create a second source of
 * truth for the one value this whole flow exists to make authoritative.
 *
 * See ADR-0021 and `docs/providers/{aws,azure,gcp}.md` "Who can reach SSH".
 */

/**
 * What happened, in the order a caller should think about it.
 *
 * - `updated` — the cloud object did not match the config and now does.
 * - `unchanged` — it already matched. Not a no-op worth hiding: it is the answer to "did my
 *   earlier save actually land", which is the question the operator is usually asking.
 * - `skipped` — nothing was attempted, and `detail` says why. The two real cases are a provider
 *   that is enabled but whose shared object does not exist yet (it will be created with the right
 *   CIDRs at the first launch — a settings save must not create billable cloud objects in an
 *   account nobody has launched into), and a config reload that did not take, where pushing would
 *   write CIDRs the operator never approved.
 * - `failed` — the call was made and the cloud refused it. `detail` carries the remediation.
 */
export const SSH_ACCESS_SYNC_STATUSES = ['updated', 'unchanged', 'skipped', 'failed'] as const

export type SshAccessSyncStatus = (typeof SSH_ACCESS_SYNC_STATUSES)[number]

/**
 * What an operator has confirmed a sync may do beyond the default, additive push (issue #309).
 *
 * A bare `syncSshAccess()` — no options — is still exactly ADR-0021's release: authorize what the
 * config names and is missing, report what is extra, and revoke NOTHING. That is the safe default
 * and the anti-lockout floor: a sync that only ever widens can never lock anyone out.
 *
 * `revoke` is the operator having stood in front of the keep-or-remove prompt (ADR-0021's
 * "Deliberately unresolved") and picked REMOVE for specific ranges. It is NOT a second source of
 * truth for the whitelist — the reason `syncSshAccess()` otherwise takes no argument (clause 5) —
 * and it deliberately cannot act like one:
 *
 * - a range in `revoke` is removed ONLY if the provider can prove it created it (AWS: the ingress
 *   stamp; GCP: the rule description) AND the range is genuinely an EXTRA — on the cloud, not in
 *   the provider's own `sshAllowedCidr`. So `revoke` can only ever narrow the cloud TOWARD the
 *   config, never past it: a range still in the list is never revoked however it is named here;
 * - a range in `revoke` that the provider CANNOT prove it created is not removed. It is surfaced
 *   as a removal Rocky Surf will not perform, with the command that finishes it by hand — the
 *   loud failure of issue #309 part 3, not a silent no-op.
 *
 * Authorize-before-revoke still holds: whatever is missing is authorized first, so a sync that
 * dies half-way through leaves MORE access than it started with, never less.
 */
export interface SshAccessSyncOptions {
  /** Extras the operator confirmed for removal at the keep-or-remove prompt. Absent means none. */
  revoke?: readonly string[]
}

export interface SshAccessSyncResult {
  status: SshAccessSyncStatus

  /**
   * The CIDRs the provider ended up enforcing — what the cloud allows now.
   *
   * Empty on `skipped` and on `failed`, because in neither case does the provider know that the
   * cloud's state changed.
   */
  applied: readonly string[]

  /**
   * CIDRs the provider found on the shared object and deliberately did NOT touch.
   *
   * This is the honest half of the report and the reason the type has three lists rather than
   * one. Rocky Surf only ever removes rules it can prove it created — on AWS, an ingress range
   * whose description is its own stamp; on GCP, a rule whose description matches the one it
   * writes at create time. Anything else on the object was put there by the operator or by an
   * older Rocky Surf, and removing it silently would be the product deleting access it does not
   * understand.
   *
   * Two distinct situations land here, and both are surfaced to the operator rather than resolved
   * behind their back:
   *
   * - **Extras to adopt.** Stamped ranges that are on the cloud but not in the list — the
   *   accumulation AWS built up before this release, and the `sourceRanges` GCP froze at create
   *   time. The operator is offered "keep" (which adds them to the list) or "remove", and the
   *   default is KEEP, because the alternative is a product that cuts off a network the operator
   *   is possibly sitting on the moment they first save.
   * - **Unstamped duplicates.** A range Rocky Surf cannot prove it created, which is still
   *   authorized after the operator asked for it to be gone. That is a FAILURE TO COMPLETE the
   *   request, not a footnote, and the caller says so with the exact command that finishes it.
   */
  reported: readonly string[]

  /**
   * The subset of `reported` that Rocky Surf CAN revoke, if the operator confirms (issue #309).
   *
   * These are the stamped extras — ranges Rocky Surf can prove it authored and which the config no
   * longer names — that a keep-or-remove prompt should offer, DEFAULT KEEP. They are the "adopt or
   * converge" half of the report: keeping one adds it back to the list, removing one sends it back
   * as `revoke` on a second sync, which authorizes-before-revoke and takes it off the cloud.
   *
   * Always a subset of `reported`. Empty where there is nothing to offer: on a `skipped`/`failed`
   * result, on Azure (which converges in a single whole-rule write, so it never leaves a
   * stamped-by-us leftover), and for the unstamped duplicates that land in `reported` but which
   * Rocky Surf will not touch — those are surfaced, never offered as a one-click removal it cannot
   * actually perform.
   */
  removable?: readonly string[]

  /**
   * One or two plain sentences for a human, including any remediation command.
   *
   * Never a raw provider error: an `AccessDenied` on an adopted security group means the
   * operator's IAM role is missing a permission this release added, and the useful thing to say
   * is which one.
   */
  detail: string
}
