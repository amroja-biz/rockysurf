import { DESCRIBE_ABSENCE_GRACE, type InstanceView } from '@rockysurf/provider-sdk'
import { describe, expect, it } from 'vitest'
import {
  assertDescribeAbsenceGrace,
  ConformanceError,
  type AbsenceGraceHarness,
  type DescribeRead,
} from './index.js'

/**
 * The assertions' own tests (rockysurf-5i28).
 *
 * A conformance suite that passes everything is worse than no suite, because it is evidence
 * that isn't. The four providers below are the failure modes the real one had, or nearly
 * had, so each assertion is shown to REJECT something as well as accept something.
 *
 * `naive` is `provider-aws` as it shipped in rockysurf-gyp1.1 and as the gyp1.4 exit run
 * found it: one read, and absence believed. Verified against the real thing too, by reverting
 * commit 6d35f82 in a working tree — see the bead.
 */

/** A minimal stand-in for a provider's describe(): a scripted read path plus a policy. */
function harnessFor(policy: {
  /** Reads to spend before believing absence, for an instance never seen running. */
  attemptsWhenAmbiguous: number
  /** Reads to spend before believing absence, once the instance has been seen running. */
  attemptsAfterRunning: number
  /** Declared to the suite; defaults to the honest value. */
  declaredAttempts?: number
}): AbsenceGraceHarness {
  const probe = (script: readonly DescribeRead[], attempts: number) => {
    let reads = 0
    const run = async (): Promise<{ view: InstanceView; reads: number }> => {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const answer = script[Math.min(reads, script.length - 1)]
        reads++
        if (answer === 'running') return { view: { state: 'running' }, reads }
      }
      return { view: { state: 'terminated' }, reads }
    }
    return { run }
  }

  return {
    provider: 'stub',
    ...(policy.declaredAttempts === undefined ? {} : { grace: { attempts: policy.declaredAttempts } }),
    neverSeenRunning: (script) => probe(script, policy.attemptsWhenAmbiguous),
    goneAfterRunning: () => probe(['absent'], policy.attemptsAfterRunning),
  }
}

const conforming = () => harnessFor({ attemptsWhenAmbiguous: DESCRIBE_ABSENCE_GRACE.attempts, attemptsAfterRunning: 1 })

/** Absence believed on the first read — the shipped bug, in four words. */
const naive = () => harnessFor({ attemptsWhenAmbiguous: 1, attemptsAfterRunning: 1 })

const failure = async (harness: AbsenceGraceHarness): Promise<ConformanceError> => {
  try {
    await assertDescribeAbsenceGrace(harness)
  } catch (err) {
    expect(err).toBeInstanceOf(ConformanceError)
    return err as ConformanceError
  }
  throw new Error('expected assertDescribeAbsenceGrace to throw, and it passed')
}

describe('assertDescribeAbsenceGrace', () => {
  it('accepts a provider that walks the grace and skips it only where absence is unambiguous', async () => {
    await expect(assertDescribeAbsenceGrace(conforming())).resolves.toBeUndefined()
  })

  it('rejects a provider that believes the first not-found', async () => {
    expect((await failure(naive())).message).toMatch(/data-loss bug/)
  })

  it('rejects a grace one read short of the constant', async () => {
    // The off-by-one is the version of this bug a careful author writes: it looks like a
    // retry loop, and it still reports a live instance dead on the last read of the window.
    const almost = harnessFor({
      attemptsWhenAmbiguous: DESCRIBE_ABSENCE_GRACE.attempts - 1,
      attemptsAfterRunning: 1,
    })
    expect((await failure(almost)).message).toMatch(/data-loss bug/)
  })

  it('rejects a provider that makes teardown wait out a grace it does not need', async () => {
    const slow = harnessFor({
      attemptsWhenAmbiguous: DESCRIBE_ABSENCE_GRACE.attempts,
      attemptsAfterRunning: DESCRIBE_ABSENCE_GRACE.attempts,
    })
    expect((await failure(slow)).message).toMatch(/already seen running/)
  })

  it('rejects a provider that shortens the grace and says so', async () => {
    // Declaring a shorter grace is not a way out: the constant is a floor, and a provider
    // may only lengthen it.
    const short = harnessFor({
      attemptsWhenAmbiguous: 2,
      attemptsAfterRunning: 1,
      declaredAttempts: 2,
    })
    expect((await failure(short)).message).toMatch(/may lengthen the grace; it may never shorten it/)
  })

  it('accepts a provider that lengthens the grace', async () => {
    const long = DESCRIBE_ABSENCE_GRACE.attempts + 3
    const patient = harnessFor({ attemptsWhenAmbiguous: long, attemptsAfterRunning: 1, declaredAttempts: long })
    await expect(assertDescribeAbsenceGrace(patient)).resolves.toBeUndefined()
  })
})
