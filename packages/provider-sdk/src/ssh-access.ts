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
   * One or two plain sentences for a human, including any remediation command.
   *
   * Never a raw provider error: an `AccessDenied` on an adopted security group means the
   * operator's IAM role is missing a permission this release added, and the useful thing to say
   * is which one.
   */
  detail: string
}
