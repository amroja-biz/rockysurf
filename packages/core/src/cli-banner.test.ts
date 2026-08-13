import { describe, expect, it } from 'vitest'
import { bannerHost } from './cli.js'

/**
 * The URL in the ready banner, once the listener stopped always binding every interface
 * (rockysurf-pii7).
 *
 * Small, but it is the one line the operator acts on, and it can now be wrong in two
 * directions: printing a wildcard as though it were an address, or printing loopback for a
 * process that deliberately bound somewhere else and therefore is not on loopback at all.
 *
 * Lives in its own file rather than in `cli.test.ts` only to keep two concurrent changes off
 * the same file.
 */
describe('bannerHost', () => {
  it('shows loopback for a wildcard bind, which is not an address anyone can open', () => {
    expect(bannerHost('0.0.0.0')).toBe('127.0.0.1')
    expect(bannerHost('::')).toBe('127.0.0.1')
  })

  it('shows the configured address when the listener bound one specific interface', () => {
    // Loopback here would be a dead link: nothing is listening on it.
    expect(bannerHost('10.0.0.5')).toBe('10.0.0.5')
    expect(bannerHost('rockysurf.internal')).toBe('rockysurf.internal')
  })

  it('brackets an IPv6 literal, which is otherwise unparseable next to the port', () => {
    expect(bannerHost('::1')).toBe('[::1]')
  })

  it('leaves the default alone', () => {
    expect(bannerHost('127.0.0.1')).toBe('127.0.0.1')
  })
})
