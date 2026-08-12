import type { McpScope } from '@rockysurf/core'
import { describe, expect, it, vi } from 'vitest'
import { CoreApiError, type CoreClient } from './client.js'
import { MCP_TOOLS, runTool, ScopeDeniedError, visibleTools } from './tools.js'

/**
 * The MCP surface, which is the highest-blast-radius feature in v0.1 and is tested like it.
 *
 * The three things under test are the three ways this can hurt someone: a tool called without
 * its scope, a limit that fails to reach the agent as an actionable reason, and a credential
 * leaking into a tool result.
 */

const COSTS = {
  monthToDate: { month: '2026-08', byCurrency: { USD: 12.5 }, unpricedServers: 1 },
  cap: { overCap: false, amount: 50, currency: 'USD', fraction: 0.25 },
}

function client(overrides: Partial<CoreClient> = {}): CoreClient {
  return {
    get: (async (path: string) => (path === '/api/v1/costs' ? COSTS : { server: {} })) as CoreClient['get'],
    post: vi.fn(async () => ({ server: { serverId: 'srv-abc' } })),
    ...overrides,
  } as CoreClient
}

const ctx = (scopes: McpScope[], c: CoreClient = client()) => ({ client: c, scopes })

describe('scopes', () => {
  it('advertises only the tools this installation granted', () => {
    // A tool an agent cannot call should not be dangled in front of it.
    expect(visibleTools(['read']).map((t) => t.name).sort()).toEqual([
      'get_server',
      'get_ssh_command',
      'list_servers',
    ])
    expect(visibleTools(['read', 'stop']).map((t) => t.name)).toContain('stop_server')
    expect(visibleTools(['read', 'stop']).map((t) => t.name)).not.toContain('create_server')
  })

  it('refuses terminate without the terminate scope, even when create is granted', async () => {
    // "A budget-capped credit card" must never silently include "and a flamethrower".
    await expect(runTool('terminate_server', { server_id: 'srv-a' }, ctx(['read', 'create']))).rejects.toThrow(
      ScopeDeniedError,
    )
  })

  it('refuses create without the create scope', async () => {
    await expect(runTool('create_server', { size: 'small' }, ctx(['read', 'stop']))).rejects.toThrow(
      ScopeDeniedError,
    )
  })

  it('says which scope is missing and where to grant it, rather than just "denied"', async () => {
    const error = await runTool('terminate_server', { server_id: 'srv-a' }, ctx(['read'])).catch((e: unknown) => e) as ScopeDeniedError
    expect(error.required).toBe('terminate')
    expect(error.message).toContain('mcp.scopes')
    expect(error.message).toContain('rockysurf.config.yaml')
  })

  it('checks the scope even for a tool that was never advertised', async () => {
    // "Not listed" is not a security control: a client can call any name it likes.
    const calls = client()
    await expect(runTool('terminate_server', { server_id: 'srv-a' }, ctx([], calls))).rejects.toThrow(
      ScopeDeniedError,
    )
    expect(calls.post).not.toHaveBeenCalled()
  })

  it('the default scope set cannot create or destroy anything', () => {
    // Matches the config default, and this is the assertion that keeps it honest.
    const names = visibleTools(['read', 'stop']).map((t) => t.name)
    expect(names).not.toContain('create_server')
    expect(names).not.toContain('terminate_server')
  })
})

describe('limits reach the agent as something it can act on', () => {
  function refusing(status: number, body: Record<string, unknown>): CoreClient {
    return client({
      post: vi.fn(async () => {
        throw new CoreApiError(status, body)
      }),
    })
  }

  it('passes a spend-cap refusal through with its reason intact', async () => {
    const message =
      'estimated spend this month is 51.20 USD, at or over the configured cap of 50 USD. ' +
      'Running servers are left alone — raise limits.spendCap or terminate something, then try again.'
    const error = await runTool(
      'create_server',
      { size: 'small' },
      ctx(['create'], refusing(403, { error: message, code: 'limit_exceeded', reason: 'spend_cap' })),
    ).catch((e: unknown) => e) as Error

    const payload = JSON.parse(error.message) as Record<string, unknown>
    expect(payload['refused']).toBe(true)
    expect(payload['status']).toBe(403)
    expect(payload['reason']).toBe('spend_cap')
    // The prose survives too: an agent that can read WHY can tell its human what to do.
    expect(payload['message']).toContain('raise limits.spendCap')
  })

  it('passes a create-rate refusal through', async () => {
    const error = await runTool(
      'create_server',
      { size: 'small' },
      ctx(
        ['create'],
        refusing(403, {
          error: 'you have created 4 servers in the last hour and the configured limit is 4 per hour.',
          code: 'limit_exceeded',
          reason: 'create_rate',
        }),
      ),
    ).catch((e: unknown) => e) as Error

    expect((JSON.parse(error.message) as { reason: string }).reason).toBe('create_rate')
  })

  it('passes a maxServers refusal through', async () => {
    const error = await runTool(
      'create_server',
      { size: 'small' },
      ctx(['create'], refusing(403, { error: 'limit is 5', code: 'limit_exceeded', reason: 'max_servers' })),
    ).catch((e: unknown) => e) as Error

    expect((JSON.parse(error.message) as { reason: string }).reason).toBe('max_servers')
  })
})

describe('cost context', () => {
  it('rides along with every successful result, so an agent can reason about spend', async () => {
    for (const [tool, args, scopes] of [
      ['list_servers', {}, ['read']],
      ['get_server', { server_id: 'srv-a' }, ['read']],
      ['stop_server', { server_id: 'srv-a' }, ['stop']],
      ['create_server', { size: 'small' }, ['create']],
    ] as const) {
      const result = (await runTool(tool, args as Record<string, unknown>, ctx([...scopes]))) as {
        spend: { cap: { fractionUsed: number }; monthToDateByCurrency: Record<string, number> }
      }
      expect(result.spend.monthToDateByCurrency).toEqual({ USD: 12.5 })
      expect(result.spend.cap.fractionUsed).toBe(0.25)
    }
  })

  it('says the estimate is an estimate, and admits what it cannot see', async () => {
    const result = (await runTool('list_servers', {}, ctx(['read']))) as {
      spend: { note: string; unpricedServers: number }
    }
    expect(result.spend.note).toContain('not a bill')
    // An unpriced server is real spend the cap cannot see; hiding that would be the dishonest
    // version of a budget guarantee.
    expect(result.spend.unpricedServers).toBe(1)
  })

  it('degrades rather than failing the operation when costs cannot be read', async () => {
    const c = client({
      get: (async (path: string) => {
        if (path === '/api/v1/costs') throw new Error('costs unavailable')
        return { server: { publicIp: '1.2.3.4', sshUser: 'rocky', status: 'running' } }
      }) as CoreClient['get'],
    })
    const result = (await runTool('get_server', { server_id: 'srv-a' }, ctx(['read'], c))) as {
      spend: { unavailable: string }
    }
    expect(result.spend.unavailable).toContain('unaffected')
  })
})

describe('get_ssh_command never hands over key material', () => {
  it('returns a command and a pointer, not a private key', async () => {
    const c = client({
      get: (async (path: string) =>
        path === '/api/v1/costs'
          ? COSTS
          : { server: { publicIp: '49.13.94.234', sshUser: 'rocky', status: 'running' } }) as CoreClient['get'],
    })
    const result = (await runTool('get_ssh_command', { server_id: 'srv-abc' }, ctx(['read'], c))) as {
      ready: boolean
      command: string
      keyNote: string
    }

    expect(result.ready).toBe(true)
    expect(result.command).toBe('ssh -i ~/.rockysurf/keys/srv-abc.pem rocky@49.13.94.234')
    // A private key in a tool result is a private key in the agent's transcript, forever.
    expect(JSON.stringify(result)).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/)
    expect(result.keyNote).toContain('web UI')
  })

  it('explains itself for a server with no address yet, rather than returning a broken command', async () => {
    const c = client({
      get: (async (path: string) =>
        path === '/api/v1/costs' ? COSTS : { server: { status: 'provisioning' } }) as CoreClient['get'],
    })
    const result = (await runTool('get_ssh_command', { server_id: 'srv-abc' }, ctx(['read'], c))) as {
      ready: boolean
      reason: string
    }
    expect(result.ready).toBe(false)
    expect(result.reason).toContain('provisioning')
  })
})

describe('the tool surface', () => {
  it('is exactly the six tools the bead names, each with a scope', () => {
    expect(MCP_TOOLS.map((t) => t.name).sort()).toEqual([
      'create_server',
      'get_server',
      'get_ssh_command',
      'list_servers',
      'stop_server',
      'terminate_server',
    ])
    expect(MCP_TOOLS.every((t) => ['read', 'stop', 'create', 'terminate'].includes(t.scope))).toBe(true)
  })

  it('warns in the tool description that terminate is irreversible', () => {
    // The model reads this before deciding. It should not have to infer the stakes.
    const terminate = MCP_TOOLS.find((t) => t.name === 'terminate_server')!
    expect(terminate.description).toContain('IRREVERSIBLE')
  })

  it('rejects an unknown argument rather than ignoring it', async () => {
    await expect(runTool('create_server', { size: 'small', sudo: true }, ctx(['create']))).rejects.toThrow()
  })
})
