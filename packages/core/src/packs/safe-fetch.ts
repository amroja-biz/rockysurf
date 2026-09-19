import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Agent } from 'undici'

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
 * The vetted lookup happens before the socket connect, so a DNS server rebinding between the
 * two resolutions could in principle steer the connection inward — the address that answers a
 * second query need not be the one just checked. Closed by pinning the connect itself to the
 * address that was actually vetted: `screenUrl` returns it, and the caller builds a one-shot
 * undici `Agent` whose `connect.lookup` always answers with that exact address, so nothing a
 * DNS server does after screening changes where the socket actually goes. Not needed for a
 * literal-IP URL (nothing is resolved at connect time) or an `allowHosts` name (never screened
 * to begin with — pinning it to an address nobody vetted would be its own bug).
 */

const MAX_REDIRECTS = 5
const MAX_BODY_BYTES = 2 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000

export type ResolvedAddress = { address: string }
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>

/** Every refusal in this module has the same shape, whatever the caller wanted back. */
export type Refusal = { ok: false; reason: string }

export type SafeFetchResult = { ok: true; text: string } | Refusal

/** The bytes as they arrived, plus the URL the last hop actually answered from. */
export type SafeFetchBytesResult = { ok: true; bytes: Buffer; url: string } | Refusal

export interface SafeFetchDeps {
  /** DNS seam for tests: must return every address the name resolves to. */
  resolve?: Resolver
  fetchImpl?: typeof fetch
  /**
   * Hostnames the operator has explicitly vouched for, lowercased, exempt from ADDRESS
   * screening (rockysurf-k6xp).
   *
   * Empty for the pack-import path, which is where this guard started and where nobody has
   * vouched for anything. The repository preflight passes the git hosts named in
   * `github.tokens`, because an operator who wrote `host: git.internal.corp` into their config
   * has already told this installation that the name is a forge of theirs — and screening it
   * out for resolving to RFC1918 would make the check useless on precisely the self-hosted
   * setup the token list exists to serve.
   *
   * SCOPED TO THE HOP THAT NAMES THEM, never inherited. A vouched-for host that redirects to
   * 169.254.169.254 is screened on the next hop like anything else: the operator vouched for a
   * name, not for wherever it chooses to send us.
   */
  allowHosts?: ReadonlySet<string>
  /**
   * The body cap, in bytes. Defaults to the 2 MiB an import gets.
   *
   * Raised by exactly one caller: the provider shop's tarball fetch (ADR-0028), where the thing
   * on the wire is a packed npm package rather than a YAML file. It is still a cap — a
   * "provider" that is a multi-gigabyte tarpit is refused before it reaches the disk — and it
   * is set by the CALLER rather than by the URL, so nothing a registry publishes can raise it.
   */
  maxBytes?: number
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

/**
 * The outcome of screening one hop's URL. `pinnedAddress` is set only when this hop's host was
 * actually resolved here — a literal IP or an `allowHosts` name has nothing to pin, and connects
 * exactly as it always has.
 */
export type ScreenResult = { ok: true; pinnedAddress?: string } | Refusal

/** Rejects unless the URL is http(s) AND every address its host stands for is public. */
async function screenUrl(url: URL, resolve: Resolver, allowHosts?: ReadonlySet<string>): Promise<ScreenResult> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'Only http and https URLs can be imported' }
  }
  const host = url.hostname
  // Vouched for by name, so the address behind it is the operator's business. Checked before
  // the literal-IP branch so that a configured host is exempt however it resolves — but a bare
  // IP can only be exempt if the operator wrote that IP into their config, which is a thing
  // they are entitled to do and a thing nobody can do on their behalf.
  if (allowHosts?.has(host.toLowerCase())) return { ok: true }
  if (isIP(host.startsWith('[') ? host.slice(1, -1) : host)) {
    if (isBlockedAddress(host)) return { ok: false, reason: `Refusing to fetch ${url.href}: ${host} is not a public address` }
    return { ok: true }
  }
  let addresses: ResolvedAddress[]
  try {
    addresses = await resolve(host)
  } catch {
    return { ok: false, reason: `Could not resolve ${host}` }
  }
  const first = addresses[0]
  if (!first) return { ok: false, reason: `Could not resolve ${host}` }
  // ANY blocked address fails the whole name — the attacker does not get to pick which
  // record the socket ends up using.
  if (addresses.some((a) => isBlockedAddress(a.address))) {
    return { ok: false, reason: `Refusing to fetch ${url.href}: ${host} resolves to a non-public address` }
  }
  return { ok: true, pinnedAddress: first.address }
}

/**
 * Node's own `net.LookupFunction` shape (`node:net` declares it but does not export it, so it's
 * reproduced structurally here rather than imported) — a single callback that Node's connect
 * path invokes either `{ all: true }` (Happy Eyeballs, the common case for a dual-stack host) or
 * with one address, depending on how it was asked to resolve.
 */
type NetLookupFunction = (
  hostname: string,
  options: { all?: boolean },
  callback: (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void,
) => void

/**
 * A `lookup` override that ignores the hostname it's asked about and always answers with the one
 * address that was already vetted by `screenUrl` — the actual fix for the resolve-vs-connect gap
 * described above.
 */
function pinnedLookup(address: string): NetLookupFunction {
  const family = isIP(address) === 6 ? 6 : 4
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address, family }])
    } else {
      callback(null, address, family)
    }
  }
}

/**
 * One-shot dispatcher that only ever connects to the vetted address, for exactly one hop's
 * fetch. Cast at the return: `Agent` here and the global `dispatcher` field's `Dispatcher` type
 * are the same runtime shape from undici, declared twice — once by the `undici` package itself,
 * once inside `@types/node`'s bundled `undici-types` — so they are structurally close but not
 * nominally identical. Constructing the dispatcher is fully type-checked against undici's own
 * types above; only this hand-off to the ambient fetch types needs the assertion.
 */
function pinnedDispatcher(address: string): NonNullable<RequestInit['dispatcher']> {
  const agent = new Agent({ connect: { lookup: pinnedLookup(address) } })
  return agent as unknown as NonNullable<RequestInit['dispatcher']>
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer | undefined> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return undefined
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/**
 * Fetch an operator-supplied URL with the SSRF guard applied at every hop, as BYTES.
 *
 * The same walk `fetchPublicText` performs — it is now a thin decoder over this — split out
 * because a provider tarball (ADR-0028) is not text and decoding it as UTF-8 would corrupt it.
 * Never throws; every failure comes back as `{ ok: false, reason }` fit for a 400 body.
 */
export async function fetchPublicBytes(rawUrl: string, deps: SafeFetchDeps = {}): Promise<SafeFetchBytesResult> {
  const resolve = deps.resolve ?? defaultResolver
  const fetchImpl = deps.fetchImpl ?? fetch
  const maxBytes = deps.maxBytes ?? MAX_BODY_BYTES

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, reason: `Not a valid URL: ${rawUrl}` }
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const screened = await screenUrl(url, resolve, deps.allowHosts)
    if (!screened.ok) return screened

    const dispatcher = screened.pinnedAddress ? pinnedDispatcher(screened.pinnedAddress) : undefined
    let response: Response | undefined
    try {
      response = await fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        ...(dispatcher ? { dispatcher } : {}),
      }).catch(() => undefined)
    } finally {
      await dispatcher?.close().catch(() => {})
    }
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
    const bytes = await readCapped(response, maxBytes)
    if (bytes === undefined) return { ok: false, reason: `${url.href} is larger than the ${maxBytes} byte import limit` }
    return { ok: true, bytes, url: url.href }
  }
  return { ok: false, reason: 'Too many redirects' }
}

/**
 * Fetch an operator-supplied URL with the SSRF guard applied at every hop.
 * Never throws — every failure comes back as `{ ok: false, reason }` fit for a 400 body.
 */
export async function fetchPublicText(rawUrl: string, deps: SafeFetchDeps = {}): Promise<SafeFetchResult> {
  const fetched = await fetchPublicBytes(rawUrl, deps)
  return fetched.ok ? { ok: true, text: fetched.bytes.toString('utf8') } : fetched
}

/* -------------------------------------------------------------------------- the probe */

export type SafeProbeResult = { ok: true; status: number; contentType: string | null; url: string } | Refusal

export interface SafeProbeOptions extends SafeFetchDeps {
  /** Sent on the FIRST hop, and on later hops only while the origin has not changed. */
  headers?: Record<string, string>
}

/**
 * Ask a URL what it answers, under the same guard, WITHOUT caring what the body says.
 *
 * Separate from `fetchPublicText` because a preflight (rockysurf-k6xp) needs the opposite half
 * of the response: `fetchPublicText` collapses every non-2xx into one `Could not fetch` refusal,
 * and the status is the entire signal here — a 404 means the URL is wrong, a 401 means the
 * token is, and telling a user the difference is the point of checking at all. The body is
 * drained and discarded; git's `info/refs` says everything needed in its status line and its
 * content type.
 *
 * AUTHORIZATION IS DROPPED ON A CROSS-ORIGIN REDIRECT. Sending an operator's PAT to whatever
 * host a redirect names would turn a reachability check into a credential-disclosure primitive
 * — an `http://` git URL that redirects off-site is not exotic. Same-origin redirects keep it,
 * which is the http→https upgrade that GitHub itself performs.
 */
export async function probePublicUrl(rawUrl: string, options: SafeProbeOptions = {}): Promise<SafeProbeResult> {
  const resolve = options.resolve ?? defaultResolver
  const fetchImpl = options.fetchImpl ?? fetch

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, reason: `Not a valid URL: ${rawUrl}` }
  }
  const origin = url.origin

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const screened = await screenUrl(url, resolve, options.allowHosts)
    if (!screened.ok) return screened

    const dispatcher = screened.pinnedAddress ? pinnedDispatcher(screened.pinnedAddress) : undefined
    let response: Response | undefined
    try {
      response = await fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        ...(options.headers && url.origin === origin ? { headers: options.headers } : {}),
        ...(dispatcher ? { dispatcher } : {}),
      }).catch(() => undefined)
    } finally {
      await dispatcher?.close().catch(() => {})
    }
    if (!response) return { ok: false, reason: `Could not reach ${url.href}` }

    await response.body?.cancel().catch(() => {})

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) return { ok: false, reason: `Redirect from ${url.href} carried no location` }
      try {
        url = new URL(location, url) // next iteration re-screens it, and may drop the header
      } catch {
        return { ok: false, reason: `Redirect from ${url.href} points at an invalid URL` }
      }
      continue
    }

    return { ok: true, status: response.status, contentType: response.headers.get('content-type'), url: url.href }
  }
  return { ok: false, reason: 'Too many redirects' }
}
