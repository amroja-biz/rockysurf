import { describe, expect, it } from 'vitest'
import type { Offering } from './api'
import {
  archLabel,
  availableArchitectures,
  formatHourly,
  formatMonthly,
  formatPricesAsOf,
  resolveOffering,
  resolveSize,
  SIZE_REQUIREMENTS,
} from './requirements'

const offering = (over: Partial<Offering> & Pick<Offering, 'id' | 'cpu' | 'memoryGb' | 'arch'>): Offering => ({
  available: true,
  hourly: { amount: 0.01, currency: 'USD', fetchedAt: '2026-08-11T00:00:00Z' },
  region: 'us-east-1',
  ...over,
})

const CATALOGUE: Offering[] = [
  offering({ id: 't4g.small', cpu: 2, memoryGb: 2, arch: 'arm64', hourly: { amount: 0.0168, currency: 'USD', fetchedAt: '2026-08-11T00:00:00Z' } }),
  offering({ id: 't4g.medium', cpu: 2, memoryGb: 4, arch: 'arm64', hourly: { amount: 0.0336, currency: 'USD', fetchedAt: '2026-08-11T00:00:00Z' } }),
  offering({ id: 't3.small', cpu: 2, memoryGb: 2, arch: 'amd64', hourly: { amount: 0.0208, currency: 'USD', fetchedAt: '2026-08-11T00:00:00Z' } }),
  offering({ id: 't3.medium', cpu: 2, memoryGb: 4, arch: 'amd64', hourly: { amount: 0.0416, currency: 'USD', fetchedAt: '2026-08-11T00:00:00Z' } }),
]

describe('resolving a t-shirt size to a concrete offering', () => {
  it('picks the cheapest offering that meets the requirements', () => {
    const result = resolveOffering(CATALOGUE, SIZE_REQUIREMENTS.small)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.offering.id).toBe('t4g.small')
  })

  it('rounds up rather than failing when nothing matches exactly', () => {
    // 3 GB is not a size anyone sells; the 4 GB type satisfies it.
    const result = resolveOffering(CATALOGUE, { vcpu: 2, memGb: 3 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.offering.memoryGb).toBe(4)
  })

  it('honours an explicit architecture', () => {
    const result = resolveOffering(CATALOGUE, { ...SIZE_REQUIREMENTS.small, arch: 'amd64' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.offering.id).toBe('t3.small')
  })

  it('offers the runners-up as alternatives, cheapest first', () => {
    const result = resolveOffering(CATALOGUE, SIZE_REQUIREMENTS.small)
    if (!result.ok) throw new Error('expected a resolution')
    expect(result.alternatives.map((o) => o.id)).toEqual(['t3.small', 't4g.medium', 't3.medium'])
  })

  it('sorts an unpriced offering last rather than treating it as free', () => {
    const withUnpriced = [...CATALOGUE, offering({ id: 'mystery', cpu: 8, memoryGb: 16, arch: 'arm64', hourly: null })]
    const result = resolveOffering(withUnpriced, { vcpu: 2, memGb: 2 })
    if (!result.ok) throw new Error('expected a resolution')
    expect(result.offering.id).toBe('t4g.small')
    expect(result.alternatives.at(-1)?.id).toBe('mystery')
  })

  it('distinguishes "sold out" from "not offered here"', () => {
    // Everything ARM is sold out — exactly what Hetzner looked like during the spike.
    const soldOut = CATALOGUE.map((o) => (o.arch === 'arm64' ? { ...o, available: false } : o))
    const result = resolveOffering(soldOut, { ...SIZE_REQUIREMENTS.small, arch: 'arm64' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.soldOut).toBe(true)
      expect(result.reason).toMatch(/sold out/i)
    }
  })

  it('says so plainly when the requirements cannot be met at all', () => {
    const result = resolveOffering(CATALOGUE, { vcpu: 64, memGb: 512 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.soldOut).toBe(false)
      expect(result.reason).toMatch(/No machine type/i)
    }
  })

  it('fails cleanly on an empty catalogue', () => {
    const result = resolveOffering([], SIZE_REQUIREMENTS.small)
    expect(result.ok).toBe(false)
  })
})

describe('architecture options', () => {
  it('lists arm64 first, because it is first-class here', () => {
    expect(availableArchitectures(CATALOGUE)).toEqual(['arm64', 'amd64'])
  })

  it('lists only what the provider actually sells', () => {
    expect(availableArchitectures(CATALOGUE.filter((o) => o.arch === 'amd64'))).toEqual(['amd64'])
  })

  it('labels architectures for humans', () => {
    expect(archLabel('arm64')).toBe('ARM64')
    expect(archLabel('amd64')).toBe('x86-64')
  })
})

describe('price formatting', () => {
  it('formats small hourly amounts with enough precision to be meaningful', () => {
    expect(formatHourly({ amount: 0.0168, currency: 'USD' })).toBe('$0.0168/hr')
  })

  it('uses the provider\'s own currency', () => {
    expect(formatHourly({ amount: 0.0216, currency: 'EUR' })).toBe('€0.0216/hr')
    expect(formatHourly({ amount: 1.5, currency: 'GBP' })).toBe('1.50 GBP/hr')
  })

  it('says the price is unavailable rather than showing zero', () => {
    expect(formatHourly(null)).toBe('price unavailable')
    expect(formatMonthly(null)).toBeNull()
  })

  it('estimates a month at 730 hours', () => {
    expect(formatMonthly({ amount: 0.01, currency: 'USD' })).toBe('$7.30')
  })

  it('dates the price, so nobody reads a stale number as current', () => {
    const note = formatPricesAsOf('2026-08-11T00:00:00Z')
    expect(note).toMatch(/^prices as of /)
    expect(note).toMatch(/2026/)
  })

  it('omits the note rather than printing an invalid date', () => {
    expect(formatPricesAsOf(undefined)).toBeNull()
    expect(formatPricesAsOf('not a date')).toBeNull()
  })
})

/**
 * `resolveSize` — the size resolver with the user's saved type in it (issue #124).
 *
 * The browser's copy of `packages/core/src/servers/offerings.ts`, and it has to agree with it
 * exactly: the page quotes the price of the machine IT resolved, and if the two disagreed the
 * user would be shown one number and billed another. The cases below are the same cases core's
 * `offering-resolution.test.ts` pins, asked of this copy.
 */
describe('a saved machine type is preferred over the cheapest that fits (issue #124)', () => {
  it('uses the saved type', () => {
    const result = resolveSize(CATALOGUE, 'small', { preference: 't4g.medium' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.offering.id).toBe('t4g.medium')
      expect(result.preferred).toBe(true)
    }
    expect(result.note).toBeUndefined()
  })

  it('resolves as it always did when nothing is saved', () => {
    const result = resolveSize(CATALOGUE, 'small')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.offering.id).toBe('t4g.small')
      expect(result.preferred).toBe(false)
    }
  })

  it('honours a saved type that does not meet the size floor', () => {
    // `large` is 4 vCPU / 8 GB and nothing in this catalogue meets it — so the default here is
    // a refusal, and the saved type still wins. Saving a type IS the opinion; the floor exists
    // for people who have not expressed one.
    const result = resolveSize(CATALOGUE, 'large', { preference: 't4g.small' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.offering.id).toBe('t4g.small')
  })

  it('falls back and says why when the saved type is sold out', () => {
    const catalogue = [...CATALOGUE, offering({ id: 'c7g.large', cpu: 2, memoryGb: 4, arch: 'arm64', available: false })]
    const result = resolveSize(catalogue, 'small', { preference: 'c7g.large' })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.offering.id).toBe('t4g.small')
      expect(result.preferred).toBe(false)
    }
    expect(result.note).toContain('c7g.large')
    expect(result.note).toContain('t4g.small')
  })

  it('quotes the provider’s own reason when it has one', () => {
    const catalogue = [
      ...CATALOGUE,
      offering({
        id: 'no-quota',
        cpu: 2,
        memoryGb: 4,
        arch: 'arm64',
        available: false,
        unavailableReason: 'this subscription has no core quota for the Dpsv5 family',
      }),
    ]
    // Azure's second gate (#139): the remedy is a portal request, not waiting for stock, so
    // "sold out" would send the user to wait for something that is never coming.
    expect(resolveSize(catalogue, 'small', { preference: 'no-quota' }).note).toContain('no core quota')
  })

  it('falls back when the saved type is not in the catalogue at all', () => {
    const result = resolveSize(CATALOGUE, 'small', { preference: 'a-type-that-was-retired' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.offering.id).toBe('t4g.small')
    expect(result.note).toContain('a-type-that-was-retired')
  })

  it('does not honour a saved type whose arch contradicts an explicit one', () => {
    // An argument the user just made outranks a default they made once.
    const result = resolveSize(CATALOGUE, 'small', { preference: 't3.small', arch: 'arm64' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.offering.arch).toBe('arm64')
    expect(result.note).toMatch(/x86-64/)
  })

  it('keeps the note when the fallback itself fails, so the refusal explains both', () => {
    const result = resolveSize([], 'small', { preference: 't4g.medium' })
    expect(result.ok).toBe(false)
    expect(result.note).toContain('t4g.medium')
  })
})
