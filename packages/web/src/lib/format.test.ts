import { describe, expect, it } from 'vitest'
import { formatTimestamp } from './format'

/**
 * `formatTimestamp` is the whole of issue #121's second half, and it is the one display helper
 * with a shape a test can pin exactly: every other formatter here delegates to `Intl` and is
 * therefore a statement about the runner's locale rather than about this code.
 *
 * EVERY CASE IS BUILT FROM LOCAL PARTS. `new Date(2026, 7, 26, 14, 5)` is 14:05 wherever the
 * suite runs, so the expectation below holds in CI's UTC and on the owner's machine alike —
 * writing the input as a UTC literal would make this pass in one timezone and fail in the next.
 */
describe('formatTimestamp', () => {
  it('writes YYYY-MON-DD HH:MI with the month named in capitals', () => {
    expect(formatTimestamp(new Date(2026, 7, 26, 14, 5).toISOString())).toBe('2026-AUG-26 14:05')
  })

  it('zero-pads the day, the hour and the minute, so the column stays one width', () => {
    expect(formatTimestamp(new Date(2026, 0, 3, 9, 7).toISOString())).toBe('2026-JAN-03 09:07')
  })

  it('uses a 24-hour clock, so midnight and noon are not the same string', () => {
    expect(formatTimestamp(new Date(2026, 11, 31, 0, 0).toISOString())).toBe('2026-DEC-31 00:00')
    expect(formatTimestamp(new Date(2026, 11, 31, 12, 0).toISOString())).toBe('2026-DEC-31 12:00')
  })

  it('renders a UTC instant in the reader’s own timezone, not in UTC', () => {
    // Core sends UTC; the owner is comparing this against the clock on their own wall. Read the
    // expected parts back off the same Date rather than hard-coding an offset the runner may
    // not have.
    const instant = '2026-08-26T18:05:00.000Z'
    const local = new Date(instant)
    const pad = (value: number) => String(value).padStart(2, '0')
    expect(formatTimestamp(instant)).toBe(
      `${local.getFullYear()}-${['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][local.getMonth()]}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}`,
    )
  })

  it('is a dash for a missing or unparseable value, never "Invalid Date"', () => {
    expect(formatTimestamp(undefined)).toBe('—')
    expect(formatTimestamp(null)).toBe('—')
    expect(formatTimestamp('')).toBe('—')
    expect(formatTimestamp('not a date')).toBe('—')
  })
})
