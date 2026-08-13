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
    super(typeof url === 'string' && url.startsWith('/') ? new URL(url, globalThis.location.origin) : url, init)
  }
}

globalThis.EventSource = RelativeAwareEventSource as unknown as typeof globalThis.EventSource

if (typeof globalThis.fetch !== 'function') {
  throw new Error('Node 18+ is required: these tests use the platform fetch')
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
    typeof input === 'string' && input.startsWith('/') ? new URL(input, globalThis.location.origin) : input

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
