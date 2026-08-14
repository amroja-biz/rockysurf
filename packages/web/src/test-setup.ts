import { EventSource } from 'eventsource'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

/**
 * jsdom provides neither `EventSource` nor `fetch`, and the SPA is built on both.
 *
 * `fetch` comes from Node, which has had it for years. `EventSource` does not exist in Node
 * 24 at all, so the spec-compliant `eventsource` package supplies it — deliberately a real
 * implementation rather than a hand-rolled stub, because a stub would mean the SSE tests were
 * exercising our idea of the protocol instead of the protocol. Frame parsing, the `connected`
 * named-event dispatch and reconnect behaviour are all the library's, as they are the
 * browser's in production.
 */
class RelativeAwareEventSource extends EventSource {
  // Same relative-URL gap as `fetch` below: the browser resolves against `location`, the
  // Node implementation cannot. Resolving here keeps the SPA's same-origin URL under test.
  constructor(url: string | URL, init?: ConstructorParameters<typeof EventSource>[1]) {
    super(typeof url === 'string' && url.startsWith('/') ? new URL(url, testOrigin()) : url, init)
  }
}

globalThis.EventSource = RelativeAwareEventSource as unknown as typeof globalThis.EventSource

if (typeof globalThis.fetch !== 'function') {
  throw new Error('Node 18+ is required: these tests use the platform fetch')
}

/**
 * Where a relative URL resolves to, when a stub server has claimed one (rockysurf-t215).
 *
 * Normally this is `location.origin` and nothing here has to think about it. But a stub server
 * that binds an EPHEMERAL port cannot be the document's origin, because jsdom fixes that before
 * the suite starts — and an ephemeral port is what stops five test files from fighting over one
 * hardcoded number. So `startStubServer` registers its origin here, and relative URLs resolve
 * to it for the life of that server.
 *
 * What this does NOT change is the thing the same-origin arrangement was protecting: the SPA
 * still writes relative `/api/v1/...` URLs and is never handed a base URL, so the production
 * code path under test is the same one. Only the address the shim maps them onto moves.
 */
let stubOrigin: string | undefined

export function useStubOrigin(origin: string | undefined): void {
  stubOrigin = origin
}

/** The origin a relative URL belongs to: the running stub server, else the document's. */
export function testOrigin(): string {
  return stubOrigin ?? globalThis.location.origin
}

/**
 * Node's `fetch` rejects a relative URL — it has no document to resolve against — while a
 * browser resolves one against `location`. jsdom supplies the `location` but not that
 * behaviour, so this restores it.
 *
 * The alternative was to give the SPA an absolute base URL in tests, which would have meant
 * never exercising the same-origin default that production actually uses. Teaching the test
 * environment one thing the browser does is the smaller lie.
 */
const platformFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const resolved =
    typeof input === 'string' && input.startsWith('/') ? new URL(input, testOrigin()) : input

  // REALM MISMATCH. jsdom installs its own `AbortController`, so any `AbortSignal` made
  // inside the page — including the one `EventSource` creates to cancel its request — is not
  // an instance of the `AbortSignal` Node's fetch checks for, and the call fails with
  // "Expected signal to be an instance of AbortSignal". Dropping it costs only the ability
  // to abort an in-flight request, which nothing in these tests relies on; the alternative
  // was reaching into Node's realm for its constructor, which no supported API offers.
  if (init?.signal) {
    const { signal: _foreignRealmSignal, ...rest } = init
    return platformFetch(resolved, rest)
  }
  return platformFetch(resolved, init)
}) as typeof globalThis.fetch

afterEach(() => {
  cleanup()
})
