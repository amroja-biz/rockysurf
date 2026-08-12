import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCoreClient, CoreApiError } from './client.js'

/**
 * The core client, against a REAL HTTP server rather than a mock.
 *
 * WHY A REAL SERVER. A mocked client is what hid the bug this file now guards: the SSH key
 * route serves a PEM attachment, `get()` JSON-parses every response, and a mock that handed
 * back a string made the caller look correct while the real client would have produced `{}` —
 * an empty object written to disk as a private key. A stub cannot disagree with the code it
 * was written to satisfy; a server can.
 */

const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----\n'

let server: Server
let baseUrl: string
let seenAuth: string | undefined

beforeEach(async () => {
  seenAuth = undefined
  server = createServer((req, res) => {
    seenAuth = req.headers.authorization
    if (req.url === '/api/v1/servers/srv-a/ssh-key') {
      // Exactly what core sends: a PEM body with an attachment disposition, not JSON.
      res.writeHead(200, {
        'content-type': 'application/x-pem-file',
        'content-disposition': 'attachment; filename="dev-box.pem"',
      })
      res.end(PEM)
      return
    }
    if (req.url === '/api/v1/servers') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ servers: [{ serverId: 'srv-a' }] }))
      return
    }
    if (req.url === '/api/v1/forbidden') {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'nope', code: 'limit_exceeded', reason: 'spend_cap' }))
      return
    }
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('boom')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const client = () => createCoreClient({ baseUrl, token: 'test-token' })

describe('getText', () => {
  it('returns a PEM body intact', () => {
    // The regression: `get()` here would yield `{}` and a caller would write "[object Object]"
    // to disk with mode 0600 and call it a private key.
    return expect(client().getText('/api/v1/servers/srv-a/ssh-key')).resolves.toBe(PEM)
  })

  it('surfaces a non-JSON error body rather than swallowing it', async () => {
    const error = (await client()
      .getText('/api/v1/nothing')
      .catch((e: unknown) => e)) as CoreApiError

    expect(error).toBeInstanceOf(CoreApiError)
    expect(error.status).toBe(500)
    expect(error.body.error).toContain('boom')
  })
})

describe('get and post', () => {
  it('parses a JSON body', async () => {
    expect(await client().get('/api/v1/servers')).toEqual({ servers: [{ serverId: 'srv-a' }] })
  })

  it('keeps a refusal’s machine-readable reason', async () => {
    const error = (await client()
      .get('/api/v1/forbidden')
      .catch((e: unknown) => e)) as CoreApiError

    expect(error.status).toBe(403)
    expect(error.body.reason).toBe('spend_cap')
  })
})

describe('authentication', () => {
  it('sends the bearer token on both paths', async () => {
    await client().get('/api/v1/servers')
    expect(seenAuth).toBe('Bearer test-token')

    seenAuth = undefined
    await client().getText('/api/v1/servers/srv-a/ssh-key')
    expect(seenAuth).toBe('Bearer test-token')
  })
})

describe('an unreachable control plane', () => {
  it('says it is not running, rather than surfacing a socket error', async () => {
    // The most likely failure by far, and an error an agent or a half-awake human can act on.
    const offline = createCoreClient({ baseUrl: 'http://127.0.0.1:1', token: 't' })
    await expect(offline.get('/api/v1/servers')).rejects.toThrow(/Is it running\?/)
  })
})
