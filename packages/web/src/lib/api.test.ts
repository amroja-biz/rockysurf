import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, UNREACHABLE_DETAIL, createAdminTool } from './api'

/**
 * A request that never reaches core must surface as an ApiError whose `detail` says so.
 *
 * Every form in the SPA renders `err.detail` for an ApiError and a generic "could not save X"
 * for anything else. `fetch` rejects with a bare TypeError when nothing answered — core
 * stopped, wrong port — which used to land in the generic branch: an operator whose core was
 * simply not running read "Could not save this tool" and went looking for a validation
 * problem. The wrapper now wraps that rejection so the form says what actually happened.
 */

const payload = {
  name: 'Headlong',
  description: 'Microharness for persistent agents',
  url: 'https://headlong.ai',
  category: 'agent' as const,
  runAs: 'rocky' as const,
  installOrder: 40,
  enabled: true,
  bootstrap: false as const,
  installScript: 'curl -fsSL https://headlong.ai/install.sh | bash -s -- --no-init',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a request that never reaches core', () => {
  it('is an ApiError with status 0 whose detail says Rocky Surf could not be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    const err = await createAdminTool(payload).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    const apiErr = err as ApiError
    expect(apiErr.status).toBe(0)
    expect(apiErr.unreachable).toBe(true)
    expect(apiErr.detail).toBe(UNREACHABLE_DETAIL)
    expect(apiErr.detail).toContain('is it running?')
    // The original rejection is kept for anyone debugging, not thrown away.
    expect((apiErr.cause as Error).message).toBe('Failed to fetch')
  })
})

describe('a request core answered with an error', () => {
  it('still carries the status and the envelope, and is not "unreachable"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'a tool with id headlong already exists', code: 'conflict' }), {
          status: 409,
          statusText: 'Conflict',
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    const err = await createAdminTool(payload).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    const apiErr = err as ApiError
    expect(apiErr.status).toBe(409)
    expect(apiErr.unreachable).toBe(false)
    expect(apiErr.detail).toBe('a tool with id headlong already exists')
  })
})
