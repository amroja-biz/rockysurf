#!/usr/bin/env node
/**
 * Unit test for the SSH-rule cleanup planner (issue #320).
 *
 * The planner is the whole safety argument of the cleanup: it decides what may be revoked from the
 * shared `rockysurf-ssh` group. Get it wrong in the removing direction and CI deletes an operator's
 * live access to every box in the account; get it wrong in the keeping direction and the group
 * silently fills back up to the 60-rule ceiling. So the properties are pinned here rather than left
 * to a reviewer's reading of the entrypoints, which do only I/O around this function.
 *
 * Pure and offline — it imports the planner alone, which carries no AWS SDK import, so this runs
 * without a built `dist/`.
 *
 * Run directly: node --test scripts/e2e/aws-ssh-rules.test.mjs
 * Wired into `pnpm run lint`, same as this repository's other script self-tests.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planSshSweep } from './aws-ssh-rules.mjs'

// The real stamp, spelled out here rather than imported from the built provider package so the test
// stays offline — and so a rename of the constant that forgets this file turns the assertion red.
const STAMP = 'rockysurf sshAllowedCidr'

test('revokes stamped ranges the caller did not ask to keep', () => {
  const plan = planSshSweep({
    ranges: [
      { cidr: '20.1.2.3/32', description: STAMP },
      { cidr: '4.5.6.7/32', description: STAMP },
    ],
    ruleDescription: STAMP,
  })
  assert.deepEqual(plan.revoke, ['20.1.2.3/32', '4.5.6.7/32'])
  assert.deepEqual(plan.kept, [])
  assert.deepEqual(plan.foreign, [])
})

test('never touches a range that does not carry our stamp, whatever its description', () => {
  const plan = planSshSweep({
    ranges: [
      { cidr: '10.0.0.0/8', description: 'added by hand in the console' },
      { cidr: '192.0.2.0/24' }, // no description at all
      { cidr: '20.1.2.3/32', description: STAMP },
    ],
    ruleDescription: STAMP,
  })
  assert.deepEqual(plan.revoke, ['20.1.2.3/32'])
  assert.deepEqual(
    plan.foreign.map((f) => f.cidr).sort(),
    ['10.0.0.0/8', '192.0.2.0/24'],
  )
})

test('keeps a stamped CIDR that is in the live config — the anti-lockout guarantee', () => {
  // The one-time owner cleanup passes the operator's live sshAllowedCidr as `keep`. Even though
  // Rocky Surf stamped it, removing it would cut the operator's own access, so it is preserved.
  const plan = planSshSweep({
    ranges: [
      { cidr: '203.0.113.7/32', description: STAMP }, // operator's real address
      { cidr: '20.1.2.3/32', description: STAMP }, // a stale runner IP
    ],
    keep: ['203.0.113.7/32'],
    ruleDescription: STAMP,
  })
  assert.deepEqual(plan.revoke, ['20.1.2.3/32'])
  assert.deepEqual(plan.kept, ['203.0.113.7/32'])
})

test('an empty group yields nothing to do', () => {
  const plan = planSshSweep({ ranges: [], ruleDescription: STAMP })
  assert.deepEqual(plan, { revoke: [], kept: [], foreign: [] })
})

test('refuses to run without the ownership stamp, rather than treating everything as ours', () => {
  assert.throws(() => planSshSweep({ ranges: [{ cidr: '20.1.2.3/32', description: STAMP }] }), /ownership stamp/)
})
