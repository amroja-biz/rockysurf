import { assertDescribeAbsenceGrace, type AbsenceGraceHarness, type DescribeRead } from '@rockysurf/provider-conformance'
import {
  DESCRIBE_ABSENCE_GRACE,
  type ComputeProvider,
  type InstanceView,
  type ProviderData,
  type ProvisionSpec,
} from '@rockysurf/provider-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeProvider } from './fake.js'

/**
 * The shared absence-grace conformance case, run against the fake (rockysurf-5i28).
 *
 * The fake is the reference implementation of amendment A4 — and it is also the reason the
 * rule went unenforced everywhere else. Every core-level test drives this provider, which
 * honours the grace, so 85 green tests said nothing about `provider-aws`, which did not
 * (rockysurf-gyp1.4). Running the fake through the SAME suite as the real providers is what
 * makes "the fake gets it right" a checked fact rather than an assumption.
 *
 * WHY THIS FILE OWNS A CLOCK. The fake's grace is real `setTimeout` against
 * `DESCRIBE_ABSENCE_GRACE.delayMs`, with no injection seam — deliberately, since it is the
 * reference for a rule stated in wall-clock terms. Eight seconds of unit test is not worth
 * paying, so the harness drives vitest's fake timers instead, and gets the read count for
 * free: the fake reads once, then once more per elapsed grace delay.
 */

const SPEC: ProvisionSpec = {
  serverId: 'srv-fake-1',
  name: 'dev-box',
  offeringId: 'fake-small',
  arch: 'arm64',
  sshPublicKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTKEY rockysurf@core'],
  userData: '#cloud-config\n',
  tags: { 'managed-by': 'rockysurf', 'server-id': 'srv-fake-1' },
  idempotencyKey: 'idem-fake-1',
}

/**
 * Run one `describe()` to completion, and report how many reads it took.
 *
 * Microtasks are drained first so a describe that never sleeps settles without the clock
 * moving — that distinction is exactly what assertion 3 (teardown pays no grace) measures.
 */
async function describeUnderFakeClock(
  provider: ComputeProvider,
  data: ProviderData,
): Promise<{ view: InstanceView; reads: number }> {
  let settled = false
  const pending = provider.describe(data).finally(() => {
    settled = true
  })
  const drain = async () => {
    for (let i = 0; i < 16; i++) await Promise.resolve()
  }

  await drain()
  let advances = 0
  while (!settled) {
    if (advances > DESCRIBE_ABSENCE_GRACE.attempts) {
      throw new Error(`describe() still had not settled after ${advances} grace delays`)
    }
    await vi.advanceTimersByTimeAsync(DESCRIBE_ABSENCE_GRACE.delayMs)
    advances++
    await drain()
  }

  return { view: await pending, reads: advances + 1 }
}

describe('conformance: describe() absence grace', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const harness: AbsenceGraceHarness = {
    provider: 'fake',
    async neverSeenRunning(script: readonly DescribeRead[]) {
      const appearsAt = script.indexOf('running')
      if (appearsAt === -1) {
        // The script never yields the instance, so neither does the fake: an id it has never
        // heard of is absent for good.
        const provider = makeFakeProvider()
        const data = { instanceId: 'i-fake-never-existed' }
        return { run: () => describeUnderFakeClock(provider, data) }
      }

      // The propagation window IS the script: invisible until the read at `appearsAt`, which
      // lands one grace delay after the read before it.
      const provider = makeFakeProvider({ propagationMs: appearsAt * DESCRIBE_ABSENCE_GRACE.delayMs })
      const { data } = await provider.provision(SPEC)
      return { run: () => describeUnderFakeClock(provider, data) }
    },
    async goneAfterRunning() {
      const provider = makeFakeProvider()
      const { data } = await provider.provision(SPEC)
      expect((await provider.describe(data)).state).toBe('running')

      // `reset()` rather than `terminate()`, and the difference is the whole assertion
      // (rockysurf-r5qn). After `terminate()` the fake still HOLDS the instance, answering
      // `terminated` from its own records, so describe() returns on the first read whether or
      // not the grace is implemented correctly — the case passed for a reason that had nothing
      // to do with the rule. `reset()` drops the record entirely, as if the account were wiped,
      // which is the only way to reach the branch the contract is actually about: an instance
      // this provider has SEEN RUNNING and can no longer find.
      //
      // The real providers reach that branch on every teardown, because a terminated instance
      // eventually drops out of the cloud's own listing. The fake needed the harsher hook to
      // get there, which is why the divergence survived a green conformance run.
      provider.reset()
      return { run: () => describeUnderFakeClock(provider, data) }
    },
  }

  it('honours the shared absence-grace contract', async () => {
    await assertDescribeAbsenceGrace(harness)
  })

  it('reports the instance dead only after the last attempt, not the first', async () => {
    // The harness's read accounting, checked against the constant rather than against itself:
    // if this ever reads once and answers `terminated`, the fake has stopped being a
    // reference implementation and every core test that trusts it is measuring nothing.
    const provider = makeFakeProvider()
    const { view, reads } = await describeUnderFakeClock(provider, { instanceId: 'i-fake-never-existed' })
    expect(view.state).toBe('terminated')
    expect(reads).toBe(DESCRIBE_ABSENCE_GRACE.attempts)
  })
})
