/**
 * The shared logic behind the two SSH-rule cleanups issue #320 asks for:
 *
 *   scripts/e2e/aws-ssh-sweep.mjs   the nightly's own after-the-fact cleanup, run under the CI
 *                                   operator identity on every path including cancellation.
 *   scripts/aws-ssh-cleanup.mjs     the one-time cleanup an owner runs by hand against the live
 *                                   shared group to clear the backlog of stale runner IPs.
 *
 * WHY THIS EXISTS AT ALL. The nightly resolves the GitHub-hosted runner's public IP at run time and
 * writes it into `sshAllowedCidr` so the run can SSH the box it provisions (scripts/e2e/lifecycle.mjs).
 * Those runners live in Azure and every run gets a FRESH IP, and AWS provisioning is additive by
 * design ("provision never revokes" — the anti-lockout rule). So every nightly deposits at least one
 * `/32` into the shared `rockysurf-ssh` group and nothing ever takes it out. At 60 rules — AWS's
 * default inbound ceiling — the next authorize fails, which surfaces either as the nightly going red
 * or, worse, as a real user's Settings save silently failing to reach AWS.
 *
 * THE ONE RULE THAT MAKES REMOVAL SAFE is the same one the provider itself uses: the description
 * stamp. `@rockysurf/provider-aws` writes `SSH_RULE_DESCRIPTION` on every range it authorizes, and
 * that stamp is the ONLY proof that Rocky Surf — not an operator at their console — created a rule.
 * The cleanup here revokes only stamped ranges, and only those a caller has not listed in `keep`;
 * everything else is reported and left exactly where it is. An operator's hand-added office range
 * carries their own description (or none), never ours, so it is never a candidate. See the long
 * comment on that constant in packages/provider-aws/src/provider.ts.
 *
 * COORDINATION WITH #309. Issue #309 gives the PRODUCT a confirmed, itemized revoke on the published
 * provider role — removing a CIDR from the Settings list takes cloud effect. That is a different
 * job from this one, which is CI-scoped and runs as the CI-only operator identity (the published
 * role deliberately cannot revoke). The two share the stamp and nothing else; neither reimplements
 * the other. If #309's revoke primitive is later exposed on the provider, the sweep entrypoint can
 * call it in place of `revokeCidr` below without touching this planner.
 *
 * This module holds NO top-level AWS SDK import on purpose, so the pure planner can be unit-tested
 * (scripts/e2e/aws-ssh-rules.test.mjs) without a built `dist/`. The I/O helpers take the SDK command
 * classes and a client as arguments; the entrypoints resolve those from the provider package the
 * same way scripts/e2e/lifecycle.mjs does.
 */

/**
 * Decide, from the port-22 ranges on a group, which to revoke — WITHOUT touching anything.
 *
 * @param {object} args
 * @param {Array<{ cidr: string, description?: string }>} args.ranges  the group's port-22 IPv4 ranges.
 * @param {readonly string[]} [args.keep]  CIDRs to preserve even when stamped — the caller's live
 *   config. The anti-lockout guarantee: a CIDR the user still wants is never a candidate, no matter
 *   who stamped it. The nightly passes nothing here (its only stamped rules are ephemeral runner
 *   IPs); the one-time owner cleanup passes the CIDRs in the operator's live `sshAllowedCidr`.
 * @param {string} args.ruleDescription  the ownership stamp — `SSH_RULE_DESCRIPTION` from the
 *   provider package. Passed in rather than hardcoded so the two never drift.
 * @returns {{ revoke: string[], kept: string[], foreign: Array<{ cidr: string, description: string }> }}
 *   `revoke` — stamped and not kept, safe to remove. `kept` — stamped but in `keep`, preserved.
 *   `foreign` — not our stamp, reported and never touched.
 */
export function planSshSweep({ ranges, keep = [], ruleDescription }) {
  if (!ruleDescription) throw new Error('planSshSweep requires the ownership stamp (ruleDescription)')
  const keepSet = new Set(keep)
  const revoke = []
  const kept = []
  const foreign = []
  for (const range of ranges) {
    const cidr = range.cidr
    if (!cidr) continue
    if (range.description === ruleDescription) {
      if (keepSet.has(cidr)) kept.push(cidr)
      else revoke.push(cidr)
    } else {
      foreign.push({ cidr, description: range.description ?? '' })
    }
  }
  return { revoke, kept, foreign }
}

/**
 * Find the shared SSH group by name, preferring the one Rocky Surf tagged as its own.
 *
 * Returns `undefined` when no such group exists yet — the group is created at the first launch, so a
 * cleanup that runs before anything has ever provisioned simply has nothing to do.
 */
export async function findSharedSg(ec2, { DescribeSecurityGroupsCommand }, groupName, managedByTag = 'rockysurf') {
  const described = await ec2.send(
    new DescribeSecurityGroupsCommand({ Filters: [{ Name: 'group-name', Values: [groupName] }] }),
  )
  const groups = described.SecurityGroups ?? []
  const owned = groups.find((g) => (g.Tags ?? []).some((t) => t.Key === 'managed-by' && t.Value === managedByTag))
  return (owned ?? groups[0])?.GroupId
}

/** Every port-22 IPv4 range on a group, with whatever description each carries. */
export async function describePort22Ranges(ec2, { DescribeSecurityGroupsCommand }, groupId) {
  const described = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [groupId] }))
  const ranges = []
  for (const permission of described.SecurityGroups?.[0]?.IpPermissions ?? []) {
    if (permission.IpProtocol !== 'tcp' || permission.FromPort !== 22 || permission.ToPort !== 22) continue
    for (const range of permission.IpRanges ?? []) {
      if (range.CidrIp) ranges.push({ cidr: range.CidrIp, description: range.Description })
    }
  }
  return ranges
}

/** Revoke one port-22 IPv4 range from a group. The single mutating call in the whole cleanup. */
export async function revokeCidr(ec2, { RevokeSecurityGroupIngressCommand }, groupId, cidr) {
  await ec2.send(
    new RevokeSecurityGroupIngressCommand({
      GroupId: groupId,
      IpPermissions: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: cidr }] }],
    }),
  )
}
