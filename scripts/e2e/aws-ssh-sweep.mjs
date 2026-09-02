#!/usr/bin/env node
/**
 * The nightly's SSH-rule cleanup (issue #320) — the second line of defence for the runner IP the
 * lifecycle authorizes and, by the "provision never revokes" contract, never takes back.
 *
 * WHERE IT RUNS. As an `if: always()` step in the AWS job of .github/workflows/nightly-real-cloud.yml,
 * exactly like the Terminate sweep beside it, and for the same reason: a `finally` in lifecycle.mjs
 * cannot fire when the job is cancelled, times out, or is killed — which is precisely the leak-on-
 * cancel case that let the group climb to 59/60. This step catches those.
 *
 * WHOSE IDENTITY. The CI operator identity — the entry role deployed from deploy/aws/nightly-ci.yaml,
 * whose session the workflow captures BEFORE the role-chaining hop and hands over through
 * ROCKYSURF_E2E_AWS_AUDIT_* (the same seam the orphan volume audit uses). The PUBLISHED provider role
 * deliberately cannot revoke — that permission belongs to issue #309's product path — so the cleanup
 * runs as the operator, exactly as the GCP and Azure sweeps run as their CI-only identities. See
 * scripts/e2e/aws-audit-credentials.mjs.
 *
 * WHAT IT REMOVES. Every port-22 range on the CI `rockysurf-nightly-ssh` group (its name comes from
 * the shared const in scripts/e2e/aws-ci-ssh-sg.mjs that the lifecycle config also uses, so the
 * group filled and the group swept are the same one) carrying Rocky Surf's own description stamp —
 * all of which are the ephemeral runner IPs the nightly authorized and by contract never took back.
 * A range with any other description, or none, is an operator's and is reported, never touched. See
 * scripts/e2e/aws-ssh-rules.mjs for the safety argument.
 *
 * IT DOES NOT FAIL THE JOB. Unlike the Terminate sweep, finding rules to remove here is the NORMAL
 * case, not evidence of a leak: the lifecycle is designed never to revoke, so this is the only thing
 * that ever does. A clean exit keeps the morning green while still doing the work. The one thing it
 * says loudly is a missing permission — until deploy/aws/nightly-ci.yaml is redeployed with the
 * revoke grant, it can see the strays but not remove them, and it prints the one command that fixes
 * that rather than turning red every night in the meantime.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveAuditCredentials } from './aws-audit-credentials.mjs'
import { CI_SSH_SG_NAME } from './aws-ci-ssh-sg.mjs'
import { describePort22Ranges, findSharedSg, planSshSweep, revokeCidr } from './aws-ssh-rules.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const REGION = process.env.AWS_REGION ?? 'us-east-1'
// The CI SG name comes from the shared const the lifecycle config also uses (issue #326), so the
// group this sweep cleans is guaranteed to be the one the run filled. An override stays available
// for a workstation pointed at a differently named group.
const SG_NAME = process.env.ROCKYSURF_SSH_SG_NAME ?? CI_SSH_SG_NAME

const log = (...args) => console.log('[ssh-sweep]', ...args)

/** The AWS SDK, resolved FROM the provider package — the same question lifecycle.mjs asks node. */
async function ec2Sdk() {
  const require = createRequire(join(REPO, 'packages/provider-aws/package.json'))
  return import(pathToFileURL(require.resolve('@aws-sdk/client-ec2')).href)
}

/** UnauthorizedOperation / AccessDenied on the entry role — the "redeploy me" signal, not a bug. */
function isAuthError(err) {
  const code = err?.name ?? err?.Code ?? err?.code ?? ''
  return /Unauthorized|AccessDenied|Forbidden/i.test(code) || err?.$metadata?.httpStatusCode === 403
}

function warnMissingPermission() {
  console.log(
    `::warning::the nightly-ci entry role cannot revoke SSH rules on ${SG_NAME}. Redeploy ` +
      `deploy/aws/nightly-ci.yaml (run ./deploy/aws/setup-nightly.sh) to grant ` +
      `ec2:RevokeSecurityGroupIngress on the shared group. The sweep is a no-op until then.`,
  )
}

async function main() {
  const { EC2Client, DescribeSecurityGroupsCommand, RevokeSecurityGroupIngressCommand } = await ec2Sdk()
  // Never strict here (that flag is the lifecycle's), so this resolves to the captured operator
  // session in CI and to the run's own credentials on a workstation.
  const audit = resolveAuditCredentials(process.env)
  log(`reading ${SG_NAME} in ${REGION} with ${audit.describe}`)
  const ec2 = new EC2Client({ region: REGION, ...audit.clientConfig })

  try {
    const commands = { DescribeSecurityGroupsCommand, RevokeSecurityGroupIngressCommand }
    const groupId = await findSharedSg(ec2, commands, SG_NAME)
    if (!groupId) {
      log(`no ${SG_NAME} group in ${REGION} yet — nothing to clean up.`)
      return
    }

    const { SSH_RULE_DESCRIPTION } = await import(pathToFileURL(join(REPO, 'packages/provider-aws/dist/index.js')).href)
    const ranges = await describePort22Ranges(ec2, commands, groupId)
    const { revoke, foreign } = planSshSweep({ ranges, ruleDescription: SSH_RULE_DESCRIPTION })

    log(`${groupId}: ${ranges.length} port-22 range(s) — ${revoke.length} to remove, ${foreign.length} not ours`)
    for (const f of foreign) log(`  left alone (not our stamp): ${f.cidr} — "${f.description}"`)

    let removed = 0
    for (const cidr of revoke) {
      try {
        await revokeCidr(ec2, commands, groupId, cidr)
        console.log(`::warning::removed stale SSH rule ${cidr} from ${SG_NAME} (${groupId})`)
        removed++
      } catch (err) {
        if (isAuthError(err)) {
          warnMissingPermission()
          return
        }
        throw err
      }
    }
    log(`done — removed ${removed} stale rule(s), ${ranges.length - removed} remain on ${SG_NAME}.`)
  } catch (err) {
    if (isAuthError(err)) {
      warnMissingPermission()
      return
    }
    throw err
  } finally {
    ec2.destroy()
  }
}

main().catch((err) => {
  // A real, non-permission failure. Say so, but do NOT fail the job over a cleanup step: a red
  // here would train everyone to ignore a morning that is otherwise green (the same reasoning the
  // workflow header gives for skipping unwired legs with a notice).
  console.log(`::warning::SSH-rule sweep could not complete: ${err?.message ?? err}`)
})
