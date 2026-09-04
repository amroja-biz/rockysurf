import { describe, expect, it } from 'vitest'
import type { Offering } from './offering.js'
import {
  archLabel,
  chooseForSize,
  chooseOffering,
  compareOfferingsByPrice,
  meetsRequirements,
  preferenceObstacle,
  requirementsForSize,
  SERVER_SIZES,
  SIZE_REQUIREMENTS,
} from './sizing.js'

/**
 * THE ONE RESOLVER, tested where it lives (issue #349).
 *
 * Core's `offering-resolution.test.ts` and the SPA's `requirements.test.ts` used to pin the same
 * case list against two separate copies of this logic — two green suites and no test anywhere
 * that the copies agreed. Both now run through these functions: core's at the wiring level
 * against a real `POST /api/v1/servers`, the SPA's against the browser wrapper that phrases the
 * outcome. This file is what they agree ON.
 *
 * The catalogue below is deliberately the one core's route test uses, so the #124 cases at the
 * bottom read one-for-one against theirs:
 *
 *   fake-small     2 vCPU   4 GB  arm64  $0.01  available
 *   fake-medium    4 vCPU   8 GB  amd64  $0.04  available
 *   fake-sold-out  8 vCPU  16 GB  arm64  $0.08  UNAVAILABLE
 */

const offering = (over: Partial<Offering> & Pick<Offering, 'id' | 'cpu' | 'memoryGb' | 'arch'>): Offering => ({
  available: true,
  hourly: { amount: 0.01, currency: 'USD', fetchedAt: '2026-08-11T00:00:00Z' },
  region: 'fake-1',
  ...over,
})

const CATALOGUE: Offering[] = [
  offering({ id: 'fake-small', cpu: 2, memoryGb: 4, arch: 'arm64', hourly: { amount: 0.01, currency: 'USD', fetchedAt: '2026-08-11T00:00:00Z' } }),
  offering({ id: 'fake-medium', cpu: 4, memoryGb: 8, arch: 'amd64', hourly: { amount: 0.04, currency: 'USD', fetchedAt: '2026-08-11T00:00:00Z' } }),
  offering({
    id: 'fake-sold-out',
    cpu: 8,
    memoryGb: 16,
    arch: 'arm64',
    hourly: { amount: 0.08, currency: 'USD', fetchedAt: '2026-08-11T00:00:00Z' },
    available: false,
  }),
]

describe('the size table', () => {
  it('is a floor per size, ascending', () => {
    expect(SERVER_SIZES).toEqual(['small', 'medium', 'large'])
    expect(SIZE_REQUIREMENTS).toEqual({
      small: { vcpu: 2, memGb: 2 },
      medium: { vcpu: 2, memGb: 4 },
      large: { vcpu: 4, memGb: 8 },
    })
  })

  it('folds an explicit architecture into the floor rather than filtering afterwards', () => {
    // This is what makes arch-only creation possible at all (rockysurf-clf2): the route used to
    // pick the cheapest machine and keep the caller's arch beside it, and the provider refused
    // the contradiction the route had just invented.
    expect(requirementsForSize('large', 'arm64')).toEqual({ vcpu: 4, memGb: 8, arch: 'arm64' })
    expect(requirementsForSize('large')).toEqual({ vcpu: 4, memGb: 8 })
  })

  it('does not mutate the table when an arch is folded in', () => {
    requirementsForSize('small', 'amd64')
    expect(SIZE_REQUIREMENTS.small).toEqual({ vcpu: 2, memGb: 2 })
  })

  it('labels architectures for humans', () => {
    expect(archLabel('arm64')).toBe('ARM64')
    expect(archLabel('amd64')).toBe('x86-64')
  })
})

describe('meetsRequirements', () => {
  it('is a minimum on both dimensions, not an exact match', () => {
    const big = offering({ id: 'big', cpu: 16, memoryGb: 64, arch: 'amd64' })
    expect(meetsRequirements(big, SIZE_REQUIREMENTS.small)).toBe(true)
    expect(meetsRequirements(offering({ id: 'tiny', cpu: 1, memoryGb: 8, arch: 'amd64' }), SIZE_REQUIREMENTS.small)).toBe(false)
  })

  it('treats a named architecture as part of the floor', () => {
    const arm = offering({ id: 'arm', cpu: 8, memoryGb: 32, arch: 'arm64' })
    expect(meetsRequirements(arm, { vcpu: 2, memGb: 2, arch: 'amd64' })).toBe(false)
    expect(meetsRequirements(arm, { vcpu: 2, memGb: 2 })).toBe(true)
  })
})

describe('compareOfferingsByPrice', () => {
  it('sorts an unpriced offering last rather than treating it as free', () => {
    const mystery = offering({ id: 'mystery', cpu: 8, memoryGb: 16, arch: 'arm64', hourly: null })
    const sorted = [mystery, ...CATALOGUE].sort(compareOfferingsByPrice).map((o) => o.id)
    expect(sorted.at(-1)).toBe('mystery')
  })

  it('breaks a price tie on id, so two equal types never resolve differently run to run', () => {
    const price = { amount: 0.02, currency: 'USD', fetchedAt: '2026-08-11T00:00:00Z' }
    const b = offering({ id: 'b', cpu: 2, memoryGb: 2, arch: 'arm64', hourly: price })
    const a = offering({ id: 'a', cpu: 2, memoryGb: 2, arch: 'arm64', hourly: price })
    expect([b, a].sort(compareOfferingsByPrice).map((o) => o.id)).toEqual(['a', 'b'])
  })
})

describe('chooseOffering', () => {
  it('takes the cheapest offering that meets the floor', () => {
    const choice = chooseOffering(CATALOGUE, SIZE_REQUIREMENTS.small)
    expect(choice.ok && choice.offering.id).toBe('fake-small')
  })

  it('does NOT hand back the cheapest machine when a larger one was asked for', () => {
    // THE REGRESSION rockysurf-clf2 fixed: `large` used to come back `fake-small`.
    const choice = chooseOffering(CATALOGUE, SIZE_REQUIREMENTS.large)
    expect(choice.ok && choice.offering.id).toBe('fake-medium')
  })

  it('rounds up rather than refusing when nothing fits exactly', () => {
    const only = [offering({ id: 'only-big', cpu: 16, memoryGb: 64, arch: 'amd64', hourly: null })]
    expect(chooseOffering(only, SIZE_REQUIREMENTS.small).ok).toBe(true)
  })

  it('honours an explicit architecture even though the other one is cheaper', () => {
    const choice = chooseOffering(CATALOGUE, requirementsForSize('small', 'amd64'))
    expect(choice.ok && choice.offering.id).toBe('fake-medium')
  })

  it('reports "not here" and "sold out" as different refusals', () => {
    const unmeetable = chooseOffering(CATALOGUE, { vcpu: 64, memGb: 512 })
    expect(unmeetable).toMatchObject({ ok: false, soldOut: false })

    const soldOut = chooseOffering(CATALOGUE, requirementsForSize('large', 'arm64'))
    // `large` + arm64 matches only fake-sold-out. Worth retrying, unlike the one above.
    expect(soldOut).toMatchObject({ ok: false, soldOut: true })
  })

  it('carries the floor on a refusal, so a caller phrases it without recomputing it', () => {
    const refusal = chooseOffering(CATALOGUE, requirementsForSize('large', 'arm64'))
    expect(refusal.ok).toBe(false)
    if (!refusal.ok) expect(refusal.requirements).toEqual({ vcpu: 4, memGb: 8, arch: 'arm64' })
  })

  it('carries the provider\'s reason only when every candidate gives the SAME one', () => {
    const reason = 'this subscription has no core quota for the Dpsv5 family'
    const unanimous = chooseOffering(
      [
        offering({ id: 'a', cpu: 4, memoryGb: 8, arch: 'arm64', available: false, unavailableReason: reason }),
        offering({ id: 'b', cpu: 8, memoryGb: 16, arch: 'arm64', available: false, unavailableReason: reason }),
      ],
      SIZE_REQUIREMENTS.large,
    )
    expect(unanimous).toMatchObject({ ok: false, soldOut: true, unanimousReason: reason })

    const mixed = chooseOffering(
      [
        offering({ id: 'a', cpu: 4, memoryGb: 8, arch: 'arm64', available: false, unavailableReason: reason }),
        offering({ id: 'b', cpu: 8, memoryGb: 16, arch: 'arm64', available: false }),
      ],
      SIZE_REQUIREMENTS.large,
    )
    expect(mixed.ok).toBe(false)
    if (!mixed.ok) expect(mixed.unanimousReason).toBeUndefined()
  })

  it('fails cleanly on an empty catalogue', () => {
    expect(chooseOffering([], SIZE_REQUIREMENTS.small)).toMatchObject({ ok: false, soldOut: false })
  })

  it('never mutates the catalogue it was handed', () => {
    const order = CATALOGUE.map((o) => o.id)
    chooseOffering(CATALOGUE, SIZE_REQUIREMENTS.small)
    expect(CATALOGUE.map((o) => o.id)).toEqual(order)
  })
})

/**
 * `preferences.tiers` — the favourite machine type (issue #124).
 *
 * These are the cases core pins through its create route and the SPA pins through its form. The
 * rules they are both pinning are here.
 */
describe('a saved machine type is preferred over the cheapest that fits (issue #124)', () => {
  it('uses the saved type instead of the cheapest that fits', () => {
    const choice = chooseForSize(CATALOGUE, 'small', { preference: 'fake-medium' })
    expect(choice).toMatchObject({ ok: true, preferred: true })
    expect(choice.ok && choice.offering.id).toBe('fake-medium')
    expect(choice.rejected).toBeUndefined()
  })

  it('honours a saved type that does not meet the size floor, because it IS the answer', () => {
    // Re-refusing it against the floor would be the product arguing with a setting it asked the
    // user to make.
    const choice = chooseForSize(CATALOGUE, 'large', { preference: 'fake-small' })
    expect(choice.ok && choice.offering.id).toBe('fake-small')
  })

  it('changes nothing when nothing is saved', () => {
    const choice = chooseForSize(CATALOGUE, 'small')
    expect(choice).toMatchObject({ ok: true, preferred: false })
    expect(choice.ok && choice.offering.id).toBe('fake-small')
  })

  it('falls back and says why when the saved type is unavailable', () => {
    const choice = chooseForSize(CATALOGUE, 'small', { preference: 'fake-sold-out' })
    // NOT A REFUSAL. A preference that cannot be met is a reason to fall back, not a reason to
    // stop someone creating a server — and it is not silent either.
    expect(choice).toMatchObject({ ok: true, preferred: false })
    expect(choice.ok && choice.offering.id).toBe('fake-small')
    expect(choice.rejected).toEqual({ preference: 'fake-sold-out', obstacle: { kind: 'unavailable' } })
  })

  it('carries the provider\'s own reason when it gives one', () => {
    const reason = 'this subscription has no core quota for the Dpsv5 family'
    const catalogue = [...CATALOGUE, offering({ id: 'no-quota', cpu: 4, memoryGb: 8, arch: 'arm64', available: false, unavailableReason: reason })]
    const choice = chooseForSize(catalogue, 'small', { preference: 'no-quota' })
    expect(choice.rejected?.obstacle).toEqual({ kind: 'unavailable', unavailableReason: reason })
  })

  it('falls back when the saved type is not offered here at all', () => {
    const choice = chooseForSize(CATALOGUE, 'small', { preference: 'a-type-that-was-retired' })
    expect(choice.ok && choice.offering.id).toBe('fake-small')
    expect(choice.rejected).toEqual({ preference: 'a-type-that-was-retired', obstacle: { kind: 'not-offered' } })
  })

  it('does not honour a saved type whose arch contradicts the one asked for', () => {
    // An argument the user just made outranks a default they made once.
    const choice = chooseForSize(CATALOGUE, 'small', { preference: 'fake-medium', arch: 'arm64' })
    expect(choice.ok && choice.offering.id).toBe('fake-small')
    expect(choice.rejected?.obstacle).toEqual({ kind: 'arch-mismatch', preferredArch: 'amd64', requestedArch: 'arm64' })
  })

  it('keeps the rejection when the fallback itself fails, so a refusal can explain both', () => {
    const choice = chooseForSize([], 'small', { preference: 'fake-medium' })
    expect(choice.ok).toBe(false)
    expect(choice.rejected?.preference).toBe('fake-medium')
  })
})

describe('preferenceObstacle', () => {
  it('does not check the size floor — that is what makes a saved type an answer', () => {
    // `fake-small` meets neither the `large` floor nor the `medium` one, and this still says
    // there is no obstacle. The floor lives in `chooseOffering`, for callers with no opinion.
    expect(preferenceObstacle(CATALOGUE, 'fake-small', undefined)).toBeUndefined()
  })

  it('is silent when an explicit arch AGREES with the saved type', () => {
    expect(preferenceObstacle(CATALOGUE, 'fake-medium', 'amd64')).toBeUndefined()
  })
})
