import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { unreachableMessage } from './client.js'
import { PREFLIGHT_TIMEOUT_MS, preflightCoreHealth } from './server.js'

/**
 * The startup preflight (#350), tested against real listeners rather than a mocked fetch — the
 * same choice client.test.ts makes and for the same reason: a mock cannot disagree with the code
 * it was written to satisfy, and "refused" vs "hangs" are facts about a socket, not a stub.
 *
 * NEVER FATAL, NEVER BLOCKING is the whole point of this function, so what each test below
 * pins is exactly that: a reachable core reports nothing, an unreachable one reports the same
 * message `client.ts` already composes for a failed tool call, and a socket that never answers
 * gives up at the bound rather than hanging the process.
 */

let server: Server | undefined

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
  }
})

describe('preflightCoreHealth', () => {
  it('reports nothing when core answers /health', async () => {
    server = createServer((req, res) => {
      expect(req.url).toBe('/health')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    await expect(preflightCoreHealth(baseUrl)).resolves.toBeUndefined()
  })

  it('reports the same actionable message client.ts composes, when nothing is listening', async () => {
    // Nothing bound to this port — refused immediately, no server ever started.
    const baseUrl = 'http://127.0.0.1:1'

    await expect(preflightCoreHealth(baseUrl)).resolves.toBe(unreachableMessage(baseUrl))
  })

  it('gives up at the timeout rather than hanging forever, when the socket never answers', async () => {
    // A server that accepts the connection and then says nothing — the case a plain
    // ECONNREFUSED test cannot exercise, and the one the implementation trap in #350 is about.
    server = createServer(() => {
      // Never call res.end / res.writeHead: the request just sits open.
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    vi.useFakeTimers()
    try {
      const result = preflightCoreHealth(baseUrl)
      await vi.advanceTimersByTimeAsync(PREFLIGHT_TIMEOUT_MS)
      await expect(result).resolves.toBe(unreachableMessage(baseUrl))
    } finally {
      vi.useRealTimers()
    }
  })

  it('never throws, whatever the fetch implementation does', async () => {
    const throwing = (() => Promise.reject(new Error('boom'))) as typeof fetch
    await expect(preflightCoreHealth('http://127.0.0.1:1', throwing)).resolves.toContain('Is it running?')
  })
})
