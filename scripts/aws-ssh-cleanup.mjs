#!/usr/bin/env node
/**
 * ONE-TIME cleanup of the stale runner IPs on the shared `rockysurf-ssh` security group (issue #320).
 *
 * This is an OWNER action, run BY HAND, and it is the only piece of #320 that touches a live cloud
 * resource — which is why it is a script you run, dry-run by default, and never something CI executes
 * on your behalf. It clears the ~55 stale one-off `/32`s the nightly deposited before it learned to
 * clean up after itself, so the group drops back from 59/60 to just the addresses you actually use.
 *
 * WHAT IT REMOVES, and the safety rule it will not break: only port-22 ranges stamped with Rocky
 * Surf's own description (`SSH_RULE_DESCRIPTION`) AND not listed in `--keep`. A range you added by
 * hand carries a different description, or none, and is reported but never removed. A range you DO
 * still use — your home or office address — you pass in `--keep`, and it is preserved even though
 * Rocky Surf stamped it. Removing a CIDR that is in your live config is the one thing this must never
 * do (the anti-lockout rule), so in `--apply` mode it refuses to run unless you have either named the
 * CIDRs to keep or said `--keep-none` out loud.
 *
 *   # See what WOULD be removed — changes nothing (the default):
 *   node scripts/aws-ssh-cleanup.mjs --profile sandbox --keep 203.0.113.7/32
 *
 *   # Actually remove them, keeping your live address:
 *   node scripts/aws-ssh-cleanup.mjs --profile sandbox --keep 203.0.113.7/32 --apply
 *
 * Options:
 *   --profile <name>   AWS named profile to use            (default: sandbox)
 *   --region <code>    region the group lives in           (default: us-east-1)
 *   --sg-name <name>   the shared group's name             (default: rockysurf-ssh)
 *   --keep a,b,c       CIDRs to preserve even when stamped — your live sshAllowedCidr
 *   --keep-none        acknowledge that NO stamped rule is kept (required to --apply with no --keep)
 *   --apply            actually revoke; without it, this only prints the plan
 *
 * Requires the profile to allow ec2:DescribeSecurityGroups and, for --apply,
 * ec2:RevokeSecurityGroupIngress on the group.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describePort22Ranges, findSharedSg, planSshSweep, revokeCidr } from './e2e/aws-ssh-rules.mjs'

const REPO = fileURLToPath(new URL('..', import.meta.url))

function parseArgs(argv) {
  const opts = { profile: 'sandbox', region: 'us-east-1', sgName: 'rockysurf-ssh', keep: [], keepNone: false, apply: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') opts.apply = true
    else if (a === '--keep-none') opts.keepNone = true
    else if (a === '--profile') opts.profile = argv[++i]
    else if (a === '--region') opts.region = argv[++i]
    else if (a === '--sg-name') opts.sgName = argv[++i]
    else if (a === '--keep') opts.keep = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else {
      console.error(`unknown argument: ${a}`)
      process.exit(2)
    }
  }
  return opts
}

async function ec2Sdk() {
  const require = createRequire(join(REPO, 'packages/provider-aws/package.json'))
  return import(pathToFileURL(require.resolve('@aws-sdk/client-ec2')).href)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  // The guard that keeps a hasty run from cutting your own access: to actually revoke, you must have
  // decided what to keep. Naming nothing is allowed, but only when you say so deliberately.
  if (opts.apply && opts.keep.length === 0 && !opts.keepNone) {
    console.error(
      'Refusing to --apply with no --keep: that would remove EVERY Rocky Surf-stamped rule, ' +
        'including your own live address if it is on the group.\n' +
        'Pass --keep <your live sshAllowedCidr> to preserve it, or --keep-none to confirm you mean ' +
        'to remove all stamped rules.',
    )
    process.exit(2)
  }

  const { EC2Client, DescribeSecurityGroupsCommand, RevokeSecurityGroupIngressCommand } = await ec2Sdk()
  const { SSH_RULE_DESCRIPTION } = await import(pathToFileURL(join(REPO, 'packages/provider-aws/dist/index.js')).href)
  const commands = { DescribeSecurityGroupsCommand, RevokeSecurityGroupIngressCommand }
  const ec2 = new EC2Client({ region: opts.region, profile: opts.profile })

  try {
    console.log(`profile=${opts.profile} region=${opts.region} group=${opts.sgName} ${opts.apply ? 'APPLY' : 'DRY-RUN'}`)
    const groupId = await findSharedSg(ec2, commands, opts.sgName)
    if (!groupId) {
      console.log(`No ${opts.sgName} group found in ${opts.region}. Nothing to do.`)
      return
    }

    const ranges = await describePort22Ranges(ec2, commands, groupId)
    const { revoke, kept, foreign } = planSshSweep({ ranges, keep: opts.keep, ruleDescription: SSH_RULE_DESCRIPTION })

    console.log(`\n${groupId} has ${ranges.length} port-22 range(s):`)
    console.log(`  ${revoke.length} stale, stamped rule(s) to remove`)
    console.log(`  ${kept.length} kept (in --keep): ${kept.join(', ') || 'none'}`)
    console.log(`  ${foreign.length} not Rocky Surf's — reported, never removed:`)
    for (const f of foreign) console.log(`    ${f.cidr} — "${f.description}"`)

    if (revoke.length === 0) {
      console.log('\nNothing stale to remove.')
      return
    }

    if (!opts.apply) {
      console.log(`\nWould remove (re-run with --apply to do it):`)
      for (const cidr of revoke) console.log(`  ${cidr}`)
      return
    }

    console.log('\nRemoving:')
    for (const cidr of revoke) {
      await revokeCidr(ec2, commands, groupId, cidr)
      console.log(`  removed ${cidr}`)
    }
    console.log(`\nDone. ${opts.sgName} now has ${ranges.length - revoke.length} rule(s).`)
  } finally {
    ec2.destroy()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
