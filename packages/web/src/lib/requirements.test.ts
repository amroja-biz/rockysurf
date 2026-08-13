import { describe, expect, it } from 'vitest'
import type { Offering } from './api'
import {
  archLabel,
  availableArchitectures,
  formatHourly,
  formatMonthly,
  formatPricesAsOf,
  resolveOffering,
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
