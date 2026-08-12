import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * A fetch for operator-supplied URLs that refuses to talk to anything internal.
 *
 * The pack import endpoint (rockysurf-ftl9.9) fetches a URL an admin typed into a control
 * plane that holds cloud credentials — classic SSRF shape. The guard here is: every hostname
 * is resolved first and EVERY resolved address must be publicly routable (loopback, RFC1918,
 * CGNAT, link-local — including 169.254.169.254 — multicast, and their IPv6 equivalents and
 * v4-embedded forms are all refused), redirects are not followed blindly but re-validated
 * hop by hop under the same rule, and the body is capped so a "pack file" cannot be a
 * multi-gigabyte tarpit.
 *
 * Residual risk, stated rather than hidden: the vetted lookup happens before the socket
 * connect, so a DNS server rebinding between the two resolutions could still steer the
 * connection inward. Closing that fully needs a connect-time lookup override (an undici
 * Agent), which is a dependency this endpoint — admin-only, behind a session — does not
 * currently justify. Revisit if the endpoint ever loosens.
 */

const MAX_REDIRECTS = 5
const MAX_BODY_BYTES = 2 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000

export type ResolvedAddress = { address: string }
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>

export type SafeFetchResult = { ok: true; text: string } | { ok: false; reason: string }

export interface SafeFetchDeps {
  /** DNS seam for tests: must return every address the name resolves to. */
  resolve?: Resolver
  fetchImpl?: typeof fetch
}

/* ------------------------------------------------------------------- address screening */

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    value = value * 256 + octet
  }
  return value
}

// [network, prefix bits] — everything an import fetch has no business reaching.
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT (includes Alibaba's 100.100.100.200 metadata)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, includes 169.254.169.254 cloud metadata
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
]

function isBlockedV4(value: number): boolean {
  return BLOCKED_V4.some(([network, bits]) => {
    const shift = 32 - bits
    return value >>> shift === ipv4ToInt(network)! >>> shift
  })
}

function ipv6ToBigInt(ip: string): bigint | undefined {
  let s = ip
  // An embedded dotted quad ("::ffff:10.0.0.1") becomes two hex groups first.
  const lastColon = s.lastIndexOf(':')
  if (s.slice(lastColon + 1).includes('.')) {
    const v4 = ipv4ToInt(s.slice(lastColon + 1))
    if (v4 === undefined) return undefined
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return undefined
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const groups =
    halves.length === 2 ? [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail] : head
  if (groups.length !== 8) return undefined
  let value = 0n
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined
    value = (value << 16n) | BigInt(parseInt(group, 16))
  }
  return value
}

const inV6 = (value: bigint, network: bigint, bits: number) => value >> BigInt(128 - bits) === network >> BigInt(128 - bits)

function isBlockedV6(value: bigint): boolean {
  if (value === 0n || value === 1n) return true // :: and ::1
  // Forms that embed an IPv4 address defer to the IPv4 verdict on the embedded bits.
  if (inV6(value, 0xffff00000000n, 96)) return isBlockedV4(Number(value & 0xffffffffn)) // ::ffff:0:0/96 v4-mapped
  if (inV6(value, 0x0064ff9bn << 96n, 96)) return isBlockedV4(Number(value & 0xffffffffn)) // 64:ff9b::/96 NAT64
  if (inV6(value, 0x2002n << 112n, 16)) return isBlockedV4(Number((value >> 80n) & 0xffffffffn)) // 2002::/16 6to4
  if (value < 1n << 32n) return isBlockedV4(Number(value & 0xffffffffn)) // ::/96 v4-compatible (deprecated)
  if (inV6(value, 0xfe80n << 112n, 10)) return true // link-local
  if (inV6(value, 0xfec0n << 112n, 10)) return true // site-local (deprecated, still routed by some stacks)
  if (inV6(value, 0xfc00n << 112n, 7)) return true // unique local
  if (inV6(value, 0xff00n << 112n, 8)) return true // multicast
  return false
}

/** True when the address is loopback/private/link-local/metadata-shaped — or not an IP at all. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address
  const family = isIP(bare)
  if (family === 4) {
    const value = ipv4ToInt(bare)
    return value === undefined || isBlockedV4(value)
  }
  if (family === 6) {
    const value = ipv6ToBigInt(bare)
    return value === undefined || isBlockedV6(value)
  }
  return true
}

/* -------------------------------------------------------------------------- the fetch */

const defaultResolver: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true })

/** Rejects unless the URL is http(s) AND every address its host stands for is public. */
async function screenUrl(url: URL, resolve: Resolver): Promise<SafeFetchResult | undefined> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'Only http and https URLs can be imported' }
  }
  const host = url.hostname
  if (isIP(host.startsWith('[') ? host.slice(1, -1) : host)) {
    if (isBlockedAddress(host)) return { ok: false, reason: `Refusing to fetch ${url.href}: ${host} is not a public address` }
    return undefined
  }
  let addresses: ResolvedAddress[]
  try {
    addresses = await resolve(host)
  } catch {
    return { ok: false, reason: `Could not resolve ${host}` }
  }
  if (addresses.length === 0) return { ok: false, reason: `Could not resolve ${host}` }
  // ANY blocked address fails the whole name — the attacker does not get to pick which
  // record the socket ends up using.
  if (addresses.some((a) => isBlockedAddress(a.address))) {
    return { ok: false, reason: `Refusing to fetch ${url.href}: ${host} resolves to a non-public address` }
  }
  return undefined
}

async function readCapped(response: Response): Promise<string | undefined> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {})
      return undefined
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Fetch an operator-supplied URL with the SSRF guard applied at every hop.
 * Never throws — every failure comes back as `{ ok: false, reason }` fit for a 400 body.
 */
export async function fetchPublicText(rawUrl: string, deps: SafeFetchDeps = {}): Promise<SafeFetchResult> {
  const resolve = deps.resolve ?? defaultResolver
  const fetchImpl = deps.fetchImpl ?? fetch

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, reason: `Not a valid URL: ${rawUrl}` }
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const refusal = await screenUrl(url, resolve)
    if (refusal) return refusal

    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).catch(() => undefined)
    if (!response) return { ok: false, reason: `Could not fetch ${url.href}` }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {})
      const location = response.headers.get('location')
      if (!location) return { ok: false, reason: `Redirect from ${url.href} carried no location` }
      try {
        url = new URL(location, url) // next loop iteration re-screens it
      } catch {
        return { ok: false, reason: `Redirect from ${url.href} points at an invalid URL` }
      }
      continue
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return { ok: false, reason: `Could not fetch ${url.href}` }
    }
    const text = await readCapped(response)
    if (text === undefined) return { ok: false, reason: `${url.href} is larger than the ${MAX_BODY_BYTES} byte import limit` }
    return { ok: true, text }
  }
  return { ok: false, reason: 'Too many redirects' }
}
