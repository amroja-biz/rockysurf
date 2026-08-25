import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePriceFeedDoc, PriceFeedClient } from './feed.js'

// NOTE: `packages/provider-aws/src/feed.test.ts` and `packages/provider-azure/src/feed.test.ts`
// are this file's twins, same as the module they test. Change one, change all three. The extra
// `transcribedAt` cases at the end cover this copy's one documented divergence and have no
// counterpart there.

const DOC = {
  schemaVersion: 1,
  fetchedAt: '2026-08-25T05:30:00.000Z',
  currency: 'USD',
  transcribedAt: { 't2a-standard-2': '2026-08-13T00:00:00.000Z', 'c4a-standard-4': '2026-08-21T00:00:00.000Z' },
  regions: { 'us-central1': { 't2a-standard-2': 0.077, 'c4a-standard-4': 0.1796 } },
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parsePriceFeedDoc', () => {
  it('accepts a well-formed v1 document, dropping nothing', () => {
    expect(parsePriceFeedDoc(DOC)).toEqual({
      fetchedAt: DOC.fetchedAt,
      currency: 'USD',
      regions: DOC.regions,
      transcribedAt: DOC.transcribedAt,
    })
  })

  it('rejects any other schema version outright — /v2/ is a different contract, not a superset', () => {
    expect(parsePriceFeedDoc({ ...DOC, schemaVersion: 2 })).toBeNull()
    expect(parsePriceFeedDoc({ ...DOC, schemaVersion: undefined })).toBeNull()
  })

  it('rejects the WHOLE document on one bad price, never serving the rest', () => {
    // The spend cap consumes these numbers: a tampered or corrupted feed must degrade to
    // UNPRICED, never to WRONG — and partial acceptance would be a wrong-number vector.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '0.08', null]) {
      const doc = { ...DOC, regions: { 'us-central1': { 't2a-standard-2': 0.077, evil: bad } } }
      expect(parsePriceFeedDoc(doc)).toBeNull()
    }
  })

  it('rejects structural nonsense rather than throwing on it', () => {
    for (const junk of [null, [], 'html error page', { schemaVersion: 1 }, { ...DOC, regions: 7 }]) {
      expect(parsePriceFeedDoc(junk)).toBeNull()
    }
  })
})

describe('PriceFeedClient', () => {
  it('returns null without fetching when no URL is configured', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const client = new PriceFeedClient(undefined, 6)
    expect(await client.get()).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fetches once and serves from cache until the refresh window lapses', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(DOC))
    vi.stubGlobal('fetch', fetchSpy)
    let now = 0
    const client = new PriceFeedClient('https://feed.test/gcp.json', 6, () => now)

    expect((await client.get())?.regions['us-central1']?.['t2a-standard-2']).toBe(0.077)
    now += 5 * 3_600_000
    await client.get()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    now += 2 * 3_600_000 // past the 6h window
    await client.get()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight fetch between concurrent callers', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(DOC))
    vi.stubGlobal('fetch', fetchSpy)
    const client = new PriceFeedClient('https://feed.test/gcp.json', 6, () => 0)
    const [a, b] = await Promise.all([client.get(), client.get()])
    expect(a).toEqual(b)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('degrades to null on HTTP failure, and remembers the failure briefly', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse('nope', 503))
    vi.stubGlobal('fetch', fetchSpy)
    let now = 0
    const client = new PriceFeedClient('https://feed.test/gcp.json', 6, () => now)

    expect(await client.get()).toBeNull()
    now += 60_000 // within the 5-minute failure window: no second attempt
    expect(await client.get()).toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    now += 5 * 60_000
    await client.get()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('degrades to null on a malformed body and on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ schemaVersion: 999 })))
    expect(await new PriceFeedClient('https://feed.test/gcp.json', 6, () => 0).get()).toBeNull()

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))))
    expect(await new PriceFeedClient('https://feed.test/gcp.json', 6, () => 0).get()).toBeNull()
  })
})

/**
 * GCP's one divergence from the AWS/Azure twins. No counterpart there — those providers'
 * numbers are machine-read on every publish and need no per-row provenance.
 */
describe('transcribedAt', () => {
  it('accepts a document without it — the stamp is advisory, not required', () => {
    const { transcribedAt: _omitted, ...bare } = DOC
    expect(parsePriceFeedDoc(bare)?.transcribedAt).toBeUndefined()
    expect(parsePriceFeedDoc(bare)?.regions).toEqual(DOC.regions)
  })

  it('rejects the whole document when the stamp is malformed, rather than dropping it', () => {
    // A provenance claim shown beside a price. A corrupted one must not quietly fall back to
    // the document-level date and look ordinary — same reject-whole rule as the prices.
    for (const bad of [7, 'yesterday', null, { 't2a-standard-2': 20260813 }, { 't2a-standard-2': '' }]) {
      expect(parsePriceFeedDoc({ ...DOC, transcribedAt: bad })).toBeNull()
    }
  })
})
