import { describe, expect, it, vi } from 'vitest'
import { fetchPublicText, isBlockedAddress, type Resolver } from './safe-fetch.js'

/**
 * The SSRF guard (rockysurf-ftl9.9), tested the way the acceptance criteria demand: with a
 * resolver stub, so "cannot reach RFC1918/link-local/loopback/metadata" is asserted without a
 * network, and with a fetch stub that hands back redirect chains so re-validation per hop is
 * observable — including that the guarded fetch is never even CALLED for a refused hop.
 */

const publicAddr = (address: string): Resolver => async () => [{ address }]

const textResponse = (text: string) => new Response(text, { status: 200 })
const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } })

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '127.8.8.8',
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '100.100.100.200',
    '169.254.169.254',
    '169.254.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.192',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.251',
    '255.255.255.255',
    '::',
    '::1',
    '[::1]',
    'fe80::1',
    'fec0::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::fb',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '64:ff9b::a00:1', // NAT64 embedding 10.0.0.1
    '2002:a00:1::', // 6to4 embedding 10.0.0.1
    '::0a00:0001', // v4-compatible embedding 10.0.0.1
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true)
  })

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '172.15.0.1',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '198.20.0.1',
    '2606:4700::1111',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808', // NAT64 embedding 8.8.8.8
  ])('allows %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false)
  })
})

describe('fetchPublicText', () => {
  it('fetches a URL whose host resolves publicly', async () => {
    const fetchImpl = vi.fn(async () => textResponse('pack: yes'))
    const result = await fetchPublicText('https://example.com/pack.yaml', {
      resolve: publicAddr('93.184.216.34'),
      fetchImpl,
    })
    expect(result).toEqual({ ok: true, text: 'pack: yes' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each(['ftp://example.com/x', 'file:///etc/passwd', 'gopher://example.com/'])(
    'refuses the %s scheme',
    async (url) => {
      const fetchImpl = vi.fn()
      const result = await fetchPublicText(url, { resolve: publicAddr('93.184.216.34'), fetchImpl })
      expect(result.ok).toBe(false)
      expect(fetchImpl).not.toHaveBeenCalled()
    },
  )

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8080/admin',
    'http://10.0.0.5/x',
    'http://[::1]/x',
    'http://[fd00::1]/x',
  ])('refuses the literal address in %s without touching the network', async (url) => {
    const fetchImpl = vi.fn()
    const result = await fetchPublicText(url, { resolve: publicAddr('93.184.216.34'), fetchImpl })
    expect(result.ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a hostname that resolves to a private address', async () => {
    const fetchImpl = vi.fn()
    const result = await fetchPublicText('https://internal.example.com/pack.yaml', {
      resolve: publicAddr('10.1.2.3'),
      fetchImpl,
    })
    expect(result).toEqual({
      ok: false,
      reason: 'Refusing to fetch https://internal.example.com/pack.yaml: internal.example.com resolves to a non-public address',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses when even ONE of several resolved addresses is private', async () => {
    const fetchImpl = vi.fn()
    const resolve: Resolver = async () => [{ address: '93.184.216.34' }, { address: '192.168.0.10' }]
    const result = await fetchPublicText('https://both.example.com/x', { resolve, fetchImpl })
    expect(result.ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails cleanly when the name does not resolve', async () => {
    const resolve: Resolver = async () => {
      throw new Error('ENOTFOUND')
    }
    const result = await fetchPublicText('https://nope.example.com/x', { resolve, fetchImpl: vi.fn() })
    expect(result).toEqual({ ok: false, reason: 'Could not resolve nope.example.com' })
  })

  it('re-validates a redirect and refuses one that points inward', async () => {
    const fetchImpl = vi.fn(async () => redirectTo('http://169.254.169.254/latest/meta-data/'))
    const result = await fetchPublicText('https://example.com/pack.yaml', {
      resolve: publicAddr('93.184.216.34'),
      fetchImpl,
    })
    expect(result.ok).toBe(false)
    // One fetch for the original URL; the metadata hop is refused BEFORE any fetch.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refuses a redirect to a hostname that resolves privately', async () => {
    const answers: Record<string, string> = { 'example.com': '93.184.216.34', 'internal.corp': '10.0.0.9' }
    const resolve: Resolver = async (host) => [{ address: answers[host]! }]
    const fetchImpl = vi.fn(async () => redirectTo('https://internal.corp/x'))
    const result = await fetchPublicText('https://example.com/pack.yaml', { resolve, fetchImpl })
    expect(result.ok).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('follows a public redirect, screening every hop', async () => {
    const resolved: string[] = []
    const resolve: Resolver = async (host) => {
      resolved.push(host)
      return [{ address: '93.184.216.34' }]
    }
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('https://cdn.example.net/pack.yaml'))
      .mockResolvedValueOnce(textResponse('pack: moved'))
    const result = await fetchPublicText('https://example.com/pack.yaml', { resolve, fetchImpl })
    expect(result).toEqual({ ok: true, text: 'pack: moved' })
    expect(resolved).toEqual(['example.com', 'cdn.example.net'])
  })

  it('refuses a redirect to a non-http scheme', async () => {
    const fetchImpl = vi.fn(async () => redirectTo('file:///etc/passwd'))
    const result = await fetchPublicText('https://example.com/x', {
      resolve: publicAddr('93.184.216.34'),
      fetchImpl,
    })
    expect(result).toEqual({ ok: false, reason: 'Only http and https URLs can be imported' })
  })

  it('gives up after too many redirects', async () => {
    const fetchImpl = vi.fn(async () => redirectTo('https://example.com/again'))
    const result = await fetchPublicText('https://example.com/x', {
      resolve: publicAddr('93.184.216.34'),
      fetchImpl,
    })
    expect(result).toEqual({ ok: false, reason: 'Too many redirects' })
  })

  it('fails a redirect that carries no location', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302 }))
    const result = await fetchPublicText('https://example.com/x', {
      resolve: publicAddr('93.184.216.34'),
      fetchImpl,
    })
    expect(result.ok).toBe(false)
  })

  it('reports a non-2xx status as a fetch failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('gone', { status: 404 }))
    const result = await fetchPublicText('https://example.com/x', {
      resolve: publicAddr('93.184.216.34'),
      fetchImpl,
    })
    expect(result).toEqual({ ok: false, reason: 'Could not fetch https://example.com/x' })
  })

  it('caps the body size instead of buffering whatever comes back', async () => {
    const big = new Uint8Array(3 * 1024 * 1024)
    const fetchImpl = vi.fn(async () => new Response(big, { status: 200 }))
    const result = await fetchPublicText('https://example.com/x', {
      resolve: publicAddr('93.184.216.34'),
      fetchImpl,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('import limit')
  })
})
