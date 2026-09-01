import { boot, issueSession, makeFakeProvider, ProviderRegistry, type McpScope } from '@rockysurf/core'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createCommand } from '../cli/commands.js'
import { CoreApiError, createCoreClient, type CoreClient } from './client.js'
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

/**
 * A control plane that REMEMBERS WHAT IT WAS ASKED FOR (#277).
 *
 * `client()` above answers every path with the same canned object, which is exactly the shape
 * that cannot see a wrong route: `stop_server` retargeted at `/terminate` returns the same
 * `{ server: … }`, so every assertion downstream of it still holds while the default-scope,
 * "reversible, disk preserved" tool destroys machines. This one records instead, so the tests
 * below can assert the URL rather than only the reply.
 *
 * `routes` maps a path to what a GET of it returns; anything unlisted gets the canned server,
 * as before. Costs are always answered, because every tool appends cost context.
 */
function recording(routes: Record<string, unknown> = {}) {
  const gets: string[] = []
  const posts: Array<{ path: string; body: unknown }> = []
  const c = client({
    get: (async (path: string) => {
      gets.push(path)
      if (path === '/api/v1/costs') return COSTS
      return path in routes ? routes[path] : { server: {} }
    }) as CoreClient['get'],
    post: (async (path: string, body?: unknown) => {
      posts.push({ path, body })
      return { server: { serverId: 'srv-abc' } }
    }) as CoreClient['post'],
  })
  /** Every path this tool asked for that was not the cost sidecar. */
  const reads = () => gets.filter((p) => p !== '/api/v1/costs')
  return { client: c, gets, posts, reads }
}

describe('scopes', () => {
  it('advertises only the tools this installation granted', () => {
    // A tool an agent cannot call should not be dangled in front of it.
    expect(visibleTools(['read']).map((t) => t.name).sort()).toEqual([
      'get_server',
      'get_ssh_command',
      'list_offerings',
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

/**
 * THE ROUTE EACH TOOL CALLS, PINNED (#277).
 *
 * This file's tools are a translation layer, so the translation IS the behaviour — and until
 * these tests existed the whole of it was unasserted for every tool but create. The mutation
 * that survived the suite: swap `/stop` for `/terminate` in `stop_server` and nothing goes red,
 * because the stub answers any path with the same canned server. `stop` is one of only two
 * actions the DEFAULT scope set grants an agent, so that mutation ships an installation whose
 * "pause spend, disk preserved" button destroys machines.
 *
 * Each assertion below is the whole call list, not a `toContain`: a tool that posts to the right
 * route AND a second one is also wrong, and that is the shape a copy-paste edit produces.
 */
describe('the route each tool calls', () => {
  it('stop_server posts to the stop route, and to nothing else', async () => {
    const { client: c, posts } = recording()
    await runTool('stop_server', { server_id: 'srv-9f2c1d3b4a5e' }, ctx(['stop'], c))
    expect(posts).toEqual([{ path: '/api/v1/servers/srv-9f2c1d3b4a5e/stop', body: undefined }])
  })

  it('terminate_server posts to the terminate route, and to nothing else', async () => {
    const { client: c, posts } = recording()
    await runTool('terminate_server', { server_id: 'srv-9f2c1d3b4a5e' }, ctx(['terminate'], c))
    expect(posts).toEqual([{ path: '/api/v1/servers/srv-9f2c1d3b4a5e/terminate', body: undefined }])
  })

  it('create_server posts to the collection route', async () => {
    const { client: c, posts } = recording()
    await runTool('create_server', { size: 'small' }, ctx(['create'], c))
    expect(posts.map((p) => p.path)).toEqual(['/api/v1/servers'])
  })

  it('list_offerings reads the provider catalogue route', async () => {
    // The tool's whole job is to serve back what `/api/v1/providers` narrows; pointed anywhere
    // else it would answer with something the create path never agreed to.
    const { client: c, reads } = recording({ '/api/v1/providers': [] })
    await runTool('list_offerings', {}, ctx(['read'], c))
    expect(reads()).toEqual(['/api/v1/providers'])
  })

  it('list_servers asks for terminated rows only when the agent did', async () => {
    // snake_case argument, camelCase query string — the same translation `createAnyway` gets,
    // and unpinned it could send `include_terminated=true`, which core ignores silently.
    const { client: c, reads } = recording({ '/api/v1/servers': [] })
    await runTool('list_servers', {}, ctx(['read'], c))
    expect(reads()).toEqual(['/api/v1/servers'])

    const withTerminated = recording({ '/api/v1/servers?includeTerminated=true': [] })
    await runTool('list_servers', { include_terminated: true }, ctx(['read'], withTerminated.client))
    expect(withTerminated.reads()).toEqual(['/api/v1/servers?includeTerminated=true'])
  })

  it('get_server and get_ssh_command read the server the agent named', async () => {
    // Not a formality: the stub used to answer every path with the same record, so a tool that
    // fetched `srv-one` while the agent asked about `srv-two` looked correct — the asserted ssh
    // command is built from the id in the ARGUMENTS, and only the address comes from the reply.
    // Two servers with two addresses is what tells them apart.
    const two = {
      '/api/v1/servers/srv-one': { server: { publicIp: '10.0.0.1', sshUser: 'rocky', status: 'running' } },
      '/api/v1/servers/srv-two': { server: { publicIp: '10.0.0.2', sshUser: 'rocky', status: 'running' } },
    }
    const forGet = recording(two)
    await runTool('get_server', { server_id: 'srv-two' }, ctx(['read'], forGet.client))
    expect(forGet.reads()).toEqual(['/api/v1/servers/srv-two'])

    const forSsh = recording(two)
    const result = (await runTool('get_ssh_command', { server_id: 'srv-two' }, ctx(['read'], forSsh.client))) as {
      command: string
    }
    expect(forSsh.reads()).toEqual(['/api/v1/servers/srv-two'])
    expect(result.command).toBe('ssh -i ~/.rockysurf/keys/srv-two.pem rocky@10.0.0.2')
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

  /**
   * The repository preflight's refusal, as an agent receives it (rockysurf-k6xp).
   *
   * This is the case that would have arrived as `[object Object]`. Core's create route was the
   * last caller of the bare `zValidator`, whose 400 puts an OBJECT in `error`; `CoreApiError`
   * passes `body.error` to `super()`, so the agent's whole account of a failed create was that
   * string. Now the envelope is the project's, and this asserts what the agent can act on:
   * which URL, why, and the way past it.
   */
  it('passes a repository-preflight refusal through, with the per-URL detail', async () => {
    const error = await runTool(
      'create_server',
      { size: 'small', repositories: ['https://github.com/a/good.git', 'https://github.com/a/typo.git'] },
      ctx(
        ['create'],
        refusing(400, {
          error:
            'https://github.com/a/typo.git was not found with the configured tokens (HTTP 404). ' +
            'Create it anyway by sending "createAnyway": true.',
          code: 'bad_request',
          issues: [{ path: 'repositories.1', message: 'https://github.com/a/typo.git was not found (HTTP 404).' }],
        }),
      ),
    ).catch((e: unknown) => e) as Error

    const payload = JSON.parse(error.message) as Record<string, unknown>
    expect(payload['refused']).toBe(true)
    expect(payload['status']).toBe(400)
    expect(payload['code']).toBe('bad_request')
    // Not `[object Object]`, which is what this line produced before the envelope was fixed.
    expect(payload['message']).toContain('https://github.com/a/typo.git')
    expect(payload['message']).toContain('createAnyway')
    // And WHICH of the two URLs it sent, so the agent edits one rather than guessing.
    expect(payload['issues']).toEqual([
      { path: 'repositories.1', message: expect.stringContaining('typo.git') },
    ])
  })

  it('sends create_anyway as the field core reads', async () => {
    const posts: Array<{ path: string; body: unknown }> = []
    const client = {
      get: vi.fn(),
      post: vi.fn(async (path: string, body?: unknown) => {
        posts.push({ path, body })
        return {}
      }),
    }
    await runTool(
      'create_server',
      { size: 'small', repositories: ['https://github.com/a/typo.git'], create_anyway: true },
      ctx(['create'], client as never),
    )
    // snake_case at the MCP boundary, camelCase on the wire — the same translation every other
    // argument here makes, and the reason this is asserted rather than assumed.
    expect((posts[0]?.body as Record<string, unknown>)['createAnyway']).toBe(true)
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

  it('still reports spend on an installation with no cap configured', async () => {
    // `/costs` sends `cap: { overCap: false }` and nothing else when none is configured — the
    // default install. Reading `fraction` off that threw, and the throw is swallowed, so every
    // tool result told the agent cost data was unavailable (rockysurf-dec8).
    const uncapped = client({
      get: (async (path: string) =>
        path === '/api/v1/costs'
          ? { monthToDate: { month: '2026-08', byCurrency: { USD: 3.5 }, unpricedServers: 0 }, cap: { overCap: false } }
          : { server: {} }) as CoreClient['get'],
    })
    const result = (await runTool('list_servers', {}, ctx(['read'], uncapped))) as {
      spend: { monthToDateByCurrency: Record<string, number>; cap: null }
    }
    expect(result.spend.monthToDateByCurrency).toEqual({ USD: 3.5 })
    expect(result.spend.cap).toBeNull()
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

/**
 * create_server and the desktop password (rockysurf-kvkr).
 *
 * The MCP client is a program, not a shell, so an argument is the right shape here — there is
 * no history file and no `ps` to leak it into. What must hold is that a pack needing a desktop
 * cannot be created without one, that the value reaches the create body, and that no result
 * hands it back.
 */
describe('create_server and the desktop password', () => {
  const PASSWORD = 'correct horse battery'
  const PACKS = [
    { packId: 'open-claw', name: 'OpenClaw', requiresRdp: true },
    { packId: 'plain', name: 'Plain', requiresRdp: false },
  ]

  const withPacks = (overrides: Partial<CoreClient> = {}) =>
    client({
      get: (async (path: string) => {
        if (path === '/api/v1/costs') return COSTS
        if (path === '/api/v1/surge-packs') return PACKS
        return { server: {} }
      }) as CoreClient['get'],
      ...overrides,
    })

  it('refuses a desktop pack with no password, WITHOUT creating a server', async () => {
    const c = withPacks()
    const error = (await runTool('create_server', { size: 'small', pack_id: 'open-claw' }, ctx(['create'], c)).catch(
      (e: unknown) => e,
    )) as Error

    // The assertion that matters: nothing was created. The pre-fix behaviour built the box in
    // full and failed its last bootstrap step four minutes later, on the clock.
    expect(c.post).not.toHaveBeenCalled()
    expect(error.message).toContain('open-claw')
    expect(error.message).toContain('rdp_password')
  })

  it('carries the password into the create body', async () => {
    const c = withPacks()
    await runTool(
      'create_server',
      { size: 'small', pack_id: 'open-claw', rdp_password: PASSWORD },
      ctx(['create'], c),
    )

    const [, body] = (c.post as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ]
    expect(body['rdpPassword']).toBe(PASSWORD)
    expect(body['packId']).toBe('open-claw')
  })

  it('never hands the password back in the result', async () => {
    const c = withPacks()
    const result = await runTool(
      'create_server',
      { size: 'small', pack_id: 'open-claw', rdp_password: PASSWORD },
      ctx(['create'], c),
    )
    // A password in a tool result is a password in the transcript twice over.
    expect(JSON.stringify(result)).not.toContain(PASSWORD)
  })

  it('rejects a password shorter than eight characters, before any call is made', async () => {
    const c = withPacks()
    await expect(
      runTool('create_server', { size: 'small', pack_id: 'open-claw', rdp_password: 'short' }, ctx(['create'], c)),
    ).rejects.toThrow()
    expect(c.post).not.toHaveBeenCalled()
  })

  it('creates a pack that needs no desktop without asking for one', async () => {
    const c = withPacks()
    await runTool('create_server', { size: 'small', pack_id: 'plain' }, ctx(['create'], c))
    const [, body] = (c.post as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ]
    expect(body['rdpPassword']).toBeUndefined()
  })

  it('passes a password through even when the pack list cannot be read', async () => {
    // Degrading the other way — dropping a password because the list was unreachable — would
    // recreate exactly the bug this fixes.
    const c = client({
      get: (async (path: string) => {
        if (path === '/api/v1/costs') return COSTS
        throw new Error('pack list unavailable')
      }) as CoreClient['get'],
    })
    await runTool(
      'create_server',
      { size: 'small', pack_id: 'open-claw', rdp_password: PASSWORD },
      ctx(['create'], c),
    )
    const [, body] = (c.post as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ]
    expect(body['rdpPassword']).toBe(PASSWORD)
  })
})

/**
 * THE CAP, AGAINST A CORE WHOSE SPEND IS REAL (rockysurf-dec8).
 *
 * Every test above stubs the control plane, which is right for a translation layer — but it
 * means the spend-cap test passes against a core that never refuses anything. And until
 * rockysurf-dec8 that was literally the case: no row was ever priced, so month-to-date spend
 * was permanently zero and `limits.spendCap` could not refuse a create however long the fleet
 * ran. The unit above would have stayed green through all of it.
 *
 * So this one boots a REAL core in-process — real routes, real limits enforcer, real uptime
 * ticker — and drives it through the MCP tools over the same `CoreClient` the MCP server uses,
 * with `app.request` standing in for the socket. The create is priced by the provider's own
 * catalogue, the cost is accrued by the product's own ticker, and the refusal is the product's
 * own. The only thing this test fabricates is how long the box has been up.
 */
describe('the spend cap, against a real control plane', () => {
  const dirs: string[] = []

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  async function bootCore(spendCap: string) {
    const dir = mkdtempSync(join(tmpdir(), 'rockysurf-mcp-cap-'))
    dirs.push(dir)
    const configPath = join(dir, 'rockysurf.config.yaml')
    writeFileSync(configPath, `server:\n  dataDir: ${join(dir, 'data')}\nlimits:\n${spendCap}`)

    const booted = await boot({
      argv: ['--config', configPath],
      listen: false,
      announce: () => {},
      log: () => {},
      providers: () => new ProviderRegistry([makeFakeProvider()]),
    })

    const [admin] = booted.db.sqlite.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').all() as { id: string }[]
    const { token } = issueSession(booted.db.db, admin!.id)
    const client = createCoreClient({
      baseUrl: 'http://core.test',
      token,
      fetchImpl: ((input: string, init?: RequestInit) => booted.app.request(input, init)) as unknown as typeof fetch,
    })
    return { booted, client }
  }

  /** The one simulated fact: this box has been up for an hour. Everything else is the product. */
  function hasBeenRunningForAnHour(booted: Awaited<ReturnType<typeof bootCore>>['booted'], serverId: string): void {
    const startedAt = new Date(Date.now() - 3_600_000).toISOString()
    booted.db.sqlite
      .prepare("UPDATE servers SET status = 'running', provisioning_step = 'ready', started_at = ? WHERE id = ?")
      .run(startedAt, serverId)
  }

  it("refuses an agent's create once real accrued spend passes the cap", async () => {
    // 0.005 USD against the fake provider's 0.01/hour: one hour of uptime is over it.
    const { booted, client } = await bootCore('  spendCap:\n    amount: 0.005\n    currency: USD\n')
    try {
      const scopes: McpScope[] = ['read', 'create']

      const created = (await runTool('create_server', { size: 'small' }, { client, scopes })) as {
        server: { serverId: string; hourlyCost?: { amount: number; currency: string } }
        spend: { monthToDateByCurrency: Record<string, number>; cap: { overCap: boolean } }
      }
      // The agent is told what this box costs, because core priced the row it just wrote.
      expect(created.server.hourlyCost).toMatchObject({ amount: 0.01, currency: 'USD' })
      expect(created.spend.cap.overCap).toBe(false)

      hasBeenRunningForAnHour(booted, created.server.serverId)
      await booted.jobs.runAllNow()

      // Cost context an agent can act on, computed from a real price and real uptime.
      const listed = (await runTool('list_servers', {}, { client, scopes })) as {
        spend: { monthToDateByCurrency: Record<string, number>; cap: { overCap: boolean; fractionUsed: number } }
      }
      expect(listed.spend.monthToDateByCurrency['USD']).toBeCloseTo(0.01, 4)
      expect(listed.spend.cap.overCap).toBe(true)
      expect(listed.spend.cap.fractionUsed).toBeGreaterThan(1)

      const error = (await runTool('create_server', { size: 'small' }, { client, scopes }).catch(
        (e: unknown) => e,
      )) as Error
      const payload = JSON.parse(error.message) as Record<string, unknown>
      expect(payload['refused']).toBe(true)
      expect(payload['status']).toBe(403)
      expect(payload['reason']).toBe('spend_cap')
      expect(String(payload['message'])).toContain('raise limits.spendCap')

      // The doctrine's other half: the running server was not touched to pay for the refusal.
      const [survivor] = booted.db.sqlite
        .prepare('SELECT status FROM servers WHERE id = ?')
        .all(created.server.serverId) as { status: string }[]
      expect(survivor?.status).toBe('running')
    } finally {
      await booted.close()
    }
  })

  it('creates freely on the same core when no cap is configured, so the refusal above was the cap', async () => {
    const { booted, client } = await bootCore('  maxServers: 5\n')
    try {
      const scopes: McpScope[] = ['read', 'create']
      const created = (await runTool('create_server', { size: 'small' }, { client, scopes })) as {
        server: { serverId: string }
      }
      hasBeenRunningForAnHour(booted, created.server.serverId)
      await booted.jobs.runAllNow()

      const second = (await runTool('create_server', { size: 'small' }, { client, scopes })) as {
        spend: { monthToDateByCurrency: Record<string, number>; cap: null }
      }
      // Spend is still measured and reported; there is simply nothing configured to refuse.
      expect(second.spend.monthToDateByCurrency['USD']).toBeCloseTo(0.01, 4)
      expect(second.spend.cap).toBeNull()
    } finally {
      await booted.close()
    }
  })
})

/**
 * STOP AND TERMINATE, AGAINST A REAL CONTROL PLANE (#277).
 *
 * The recording stub above pins the URL string. This pins what the URL DOES — the tools are
 * driven against a real booted core, real routes, a real lifecycle, and the assertion is the
 * row's status afterwards. It is the leg that would still fail if core renamed a route, or if
 * `/stop` and `/terminate` were ever wired to the same handler: a suite that only compares a
 * string to a string agrees with itself.
 *
 * `create` and `list` already had this treatment; these two are the pair that did not, and one
 * of them is in the default scope set.
 */
describe('stop and terminate, against a real control plane', () => {
  const dirs: string[] = []

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  async function bootCore() {
    const dir = mkdtempSync(join(tmpdir(), 'rockysurf-mcp-lifecycle-'))
    dirs.push(dir)
    const configPath = join(dir, 'rockysurf.config.yaml')
    writeFileSync(configPath, `server:\n  dataDir: ${join(dir, 'data')}\nlimits:\n  maxServers: 5\n`)

    const booted = await boot({
      argv: ['--config', configPath],
      listen: false,
      announce: () => {},
      log: () => {},
      providers: () => new ProviderRegistry([makeFakeProvider()]),
    })
    const [admin] = booted.db.sqlite.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').all() as { id: string }[]
    const { token } = issueSession(booted.db.db, admin!.id)
    const client = createCoreClient({
      baseUrl: 'http://core.test',
      token,
      fetchImpl: ((input: string, init?: RequestInit) => booted.app.request(input, init)) as unknown as typeof fetch,
    })
    return { booted, client }
  }

  const SCOPES: McpScope[] = ['read', 'create', 'stop', 'terminate']

  const statusOf = (booted: Awaited<ReturnType<typeof bootCore>>['booted'], serverId: string) =>
    (booted.db.sqlite.prepare('SELECT status FROM servers WHERE id = ?').get(serverId) as { status: string }).status

  /**
   * The one fabricated fact, and the same one the cap tests fabricate: core promotes a row to
   * `running` when its on-box bootstrap reports ready, and no box is booting here. Everything
   * after this line is the product's own — stop refuses a row that is not `running`.
   */
  function reportsReady(booted: Awaited<ReturnType<typeof bootCore>>['booted'], serverId: string): void {
    booted.db.sqlite
      .prepare("UPDATE servers SET status = 'running', provisioning_step = 'ready' WHERE id = ?")
      .run(serverId)
  }

  async function createRunning(
    booted: Awaited<ReturnType<typeof bootCore>>['booted'],
    client: CoreClient,
    name: string,
  ): Promise<string> {
    const created = (await runTool('create_server', { size: 'small', name }, { client, scopes: SCOPES })) as {
      server: { serverId: string }
    }
    reportsReady(booted, created.server.serverId)
    return created.server.serverId
  }

  it('stop_server stops the box and preserves it, which is what its description promises', async () => {
    const { booted, client } = await bootCore()
    try {
      const serverId = await createRunning(booted, client, 'to-stop')

      const stopped = (await runTool('stop_server', { server_id: serverId }, { client, scopes: SCOPES })) as {
        server: { serverId: string; status: string }
      }

      // Stopped, not destroyed. A `stop_server` pointed at `/terminate` reaches this line with
      // `terminated` — the whole reason this test exists.
      expect(stopped.server.serverId).toBe(serverId)
      expect(stopped.server.status).toBe('stopped')
      expect(statusOf(booted, serverId)).toBe('stopped')
    } finally {
      await booted.close()
    }
  })

  it('stops the box the agent named and leaves the other one running', async () => {
    const { booted, client } = await bootCore()
    try {
      const target = await createRunning(booted, client, 'target')
      const bystander = await createRunning(booted, client, 'bystander')

      await runTool('stop_server', { server_id: target }, { client, scopes: SCOPES })

      expect(statusOf(booted, target)).toBe('stopped')
      expect(statusOf(booted, bystander)).toBe('running')
    } finally {
      await booted.close()
    }
  })

  it('terminate_server destroys the box, and says so twice without a conflict', async () => {
    const { booted, client } = await bootCore()
    try {
      const serverId = await createRunning(booted, client, 'to-terminate')

      const terminated = (await runTool('terminate_server', { server_id: serverId }, { client, scopes: SCOPES })) as {
        server: { status: string }
      }
      expect(terminated.server.status).toBe('terminated')
      expect(statusOf(booted, serverId)).toBe('terminated')

      // The description promises a retry is safe. An agent that lost a response retries, and a
      // 409 there would send it looking for a machine that no longer exists.
      const again = (await runTool('terminate_server', { server_id: serverId }, { client, scopes: SCOPES })) as {
        server: { status: string }
      }
      expect(again.server.status).toBe('terminated')
    } finally {
      await booted.close()
    }
  })

  it("passes core's refusal back when the box is in no state to be stopped", async () => {
    const { booted, client } = await bootCore()
    try {
      // Still provisioning: never marked ready, so core refuses rather than stopping a box
      // mid-bootstrap. The agent needs the reason, not "request failed".
      const created = (await runTool('create_server', { size: 'small' }, { client, scopes: SCOPES })) as {
        server: { serverId: string }
      }
      const error = (await runTool('stop_server', { server_id: created.server.serverId }, {
        client,
        scopes: SCOPES,
      }).catch((e: unknown) => e)) as Error

      const payload = JSON.parse(error.message) as Record<string, unknown>
      expect(payload['refused']).toBe(true)
      expect(String(payload['message'])).toContain('not running')
      // And the box was left alone rather than half-acted-on.
      expect(statusOf(booted, created.server.serverId)).toBe('provisioning')
    } finally {
      await booted.close()
    }
  })
})

/**
 * AN AGENT ASKING FOR AN ARM BOX (rockysurf-0t2h).
 *
 * `create_server` took name/size/pack_id/repositories/create_anyway/provider/rdp_password and
 * nothing else, so there was no way for an agent to say `arm64` — while the SPA has treated
 * architecture as first-class since it was written. The confirming run went out over MCP and
 * came back an amd64 e2-micro.
 *
 * The ordering mattered and is worth recording: this parameter could not be added until
 * rockysurf-clf2 fixed the resolver. Before that, an `arch` reaching the API was ignored by
 * the chooser and then refused by the provider as a mismatch, so a tool argument added first
 * would have been a new way to fail rather than a new thing an agent could do. Hence the
 * real-core leg below rather than only a body assertion: it is the resolver these arguments
 * depend on, and stubbing it would prove nothing about the bug.
 */
describe('create_server can express architecture', () => {
  const dirs: string[] = []

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('advertises arch as a closed choice, so an agent can discover it', () => {
    // Unlike `provider` and `offering_id`, whose values come from the operator's config, the
    // two architectures are the SDK's own frozen list — so this one CAN be enumerated, and an
    // agent reading the schema learns that arm64 is on the menu without being told.
    const schema = MCP_TOOLS.find((t) => t.name === 'create_server')!.inputSchema
    const parsed = schema.parse({ size: 'small', arch: 'arm64' }) as Record<string, unknown>
    expect(parsed['arch']).toBe('arm64')
    expect(() => schema.parse({ size: 'small', arch: 'sparc' })).toThrow()
  })

  it('carries arch and offering_id into the create body, under the API\'s own names', async () => {
    const c = client()
    await runTool('create_server', { size: 'large', arch: 'arm64', offering_id: 'fake-sold-out' }, ctx(['create'], c))
    const [, body] = (c.post as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ]
    expect(body['arch']).toBe('arm64')
    // snake_case at the tool boundary, camelCase on the wire — the translation this layer is for.
    expect(body['offeringId']).toBe('fake-sold-out')
  })

  it('sends neither field when the agent named neither', async () => {
    const c = client()
    await runTool('create_server', { size: 'small' }, ctx(['create'], c))
    const [, body] = (c.post as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ]
    // Absent, not null: the control plane reads absence as "you choose", and a null would be
    // a value it has to have an opinion about.
    expect(body).not.toHaveProperty('arch')
    expect(body).not.toHaveProperty('offeringId')
  })

  async function bootCore() {
    const dir = mkdtempSync(join(tmpdir(), 'rockysurf-mcp-arch-'))
    dirs.push(dir)
    const configPath = join(dir, 'rockysurf.config.yaml')
    writeFileSync(configPath, `server:\n  dataDir: ${join(dir, 'data')}\nlimits:\n  maxServers: 5\n`)

    const booted = await boot({
      argv: ['--config', configPath],
      listen: false,
      announce: () => {},
      log: () => {},
      providers: () => new ProviderRegistry([makeFakeProvider()]),
    })
    const [admin] = booted.db.sqlite.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').all() as {
      id: string
    }[]
    const { token } = issueSession(booted.db.db, admin!.id)
    const client = createCoreClient({
      baseUrl: 'http://core.test',
      token,
      fetchImpl: ((input: string, init?: RequestInit) => booted.app.request(input, init)) as unknown as typeof fetch,
    })
    return { booted, client }
  }

  const machineOf = (booted: Awaited<ReturnType<typeof bootCore>>['booted'], serverId: string) =>
    booted.db.sqlite.prepare('SELECT offering_id, arch FROM servers WHERE id = ?').get(serverId) as {
      offering_id: string
      arch: string
    }

  it('gets the agent the architecture it asked for, against a real control plane', async () => {
    const { booted, client } = await bootCore()
    try {
      const scopes: McpScope[] = ['read', 'create']

      // The fake catalogue's cheapest machine is arm64 fake-small, so amd64 is the request
      // that used to be impossible: resolution took the cheapest, kept the agent's `amd64`
      // beside it, and the provider refused the pair it had just been handed.
      const amd = (await runTool('create_server', { size: 'small', arch: 'amd64' }, { client, scopes })) as {
        server: { serverId: string }
      }
      expect(machineOf(booted, amd.server.serverId)).toMatchObject({ arch: 'amd64', offering_id: 'fake-medium' })

      const arm = (await runTool(
        'create_server',
        { size: 'small', arch: 'arm64', name: 'arm-box' },
        { client, scopes },
      )) as { server: { serverId: string } }
      expect(machineOf(booted, arm.server.serverId)).toMatchObject({ arch: 'arm64', offering_id: 'fake-small' })
    } finally {
      await booted.close()
    }
  })

  it('gets the agent the SIZE it asked for, which was the other half of the same clip', async () => {
    const { booted, client } = await bootCore()
    try {
      const created = (await runTool('create_server', { size: 'large' }, {
        client,
        scopes: ['read', 'create'] as McpScope[],
      })) as { server: { serverId: string } }
      // An MCP create asking for a size used to land on the cheapest machine in the catalogue
      // whatever it asked for — the e2-micro the confirming run got.
      expect(machineOf(booted, created.server.serverId).offering_id).toBe('fake-medium')
    } finally {
      await booted.close()
    }
  })

  it('refuses, rather than substituting, when the cloud cannot serve the request', async () => {
    const { booted, client } = await bootCore()
    try {
      // large + arm64 matches only the deliberately-unavailable fake-sold-out. An agent has to
      // be told that, not handed an amd64 box and left to discover it when its binaries fail.
      const error = (await runTool('create_server', { size: 'large', arch: 'arm64' }, {
        client,
        scopes: ['read', 'create'] as McpScope[],
      }).catch((e: unknown) => e)) as Error
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toMatch(/sold out/i)
      expect(booted.db.sqlite.prepare('SELECT COUNT(*) AS n FROM servers').get()).toMatchObject({ n: 0 })
    } finally {
      await booted.close()
    }
  })
})

describe('the tool surface', () => {
  it('is the six tools the bead names plus list_offerings, each with a scope', () => {
    // `list_offerings` is the seventh, added by rockysurf-oeay: `create_server.offering_id` was
    // advertised with no way to learn its values, which made the parameter usable only by an
    // agent a human had already briefed.
    expect(MCP_TOOLS.map((t) => t.name).sort()).toEqual([
      'create_server',
      'get_server',
      'get_ssh_command',
      'list_offerings',
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

  /**
   * NO PROVIDER OR OFFERING ID IS COMPILED INTO THE TOOL DEFINITIONS (rockysurf-oeay).
   *
   * The whole reason `provider` and `offering_id` are un-enumerated strings is that their values
   * belong to the operator's clouds and their `providers.<cloud>.sizes`. A helpful example
   * hardcoded into a description is the provider-id conditional the rest of the codebase spends
   * its effort avoiding — and it would be wrong for any installation that does not run that
   * cloud. `list_offerings` exists precisely so the values can be discovered instead.
   */
  it('names no concrete cloud or machine type in any tool description or schema', () => {
    const surface = MCP_TOOLS.map((t) => `${t.description} ${JSON.stringify(t.inputSchema.description ?? '')}`).join(' ')
    for (const forbidden of ['t4g.', 'cpx', 'e2-micro', 'aws', 'hetzner', 'gcp', 'azure']) {
      expect(surface.toLowerCase()).not.toContain(forbidden)
    }
  })
})

/**
 * `list_offerings` (rockysurf-oeay).
 *
 * The catalogue arrives already narrowed by the operator's allowlist, because the route narrows
 * it (rockysurf-j10e) — so the test that matters is that this tool passes it through rather than
 * re-deriving, re-filtering or decorating it into something the create path would refuse.
 */
describe('list_offerings', () => {
  const CATALOGUE = [
    {
      id: 'fake',
      displayName: 'Fake Cloud',
      offerings: [{ id: 'f1.small', cpu: 2, memoryGb: 2, arch: 'arm64', available: true, hourly: null, region: 'r1' }],
    },
    { id: 'other', displayName: 'Other Cloud', offerings: [] },
  ]
  const catalogueClient = () =>
    client({ get: (async () => CATALOGUE) as CoreClient['get'] })

  it('is readable with the read scope alone', async () => {
    // It spends nothing and changes nothing; withholding it from an agent that may already list
    // servers would not protect anything, and seeing prices before committing is the point.
    const result = (await runTool('list_offerings', {}, ctx(['read'], catalogueClient()))) as {
      providers: typeof CATALOGUE
    }
    expect(result.providers.map((p) => p.id)).toEqual(['fake', 'other'])
  })

  it('narrows to one cloud when asked', async () => {
    const result = (await runTool('list_offerings', { provider: 'fake' }, ctx(['read'], catalogueClient()))) as {
      providers: typeof CATALOGUE
    }
    expect(result.providers.map((p) => p.id)).toEqual(['fake'])
  })

  it('names the configured clouds when asked for one that is not configured', async () => {
    // An empty list would read as "this cloud sells nothing", which is a different claim.
    const result = (await runTool('list_offerings', { provider: 'nope' }, ctx(['read'], catalogueClient()))) as {
      error: string
      configured: string[]
    }
    expect(result.error).toContain('nope')
    expect(result.configured).toEqual(['fake', 'other'])
  })
})

/**
 * NARROWING REACHES EVERY FRONT END IDENTICALLY (rockysurf-18lq), against a real control plane.
 *
 * A box is built with the git tokens its declared repositories select, and nothing else. That
 * decision is made in one place — `narrowTokensToRepositories`, called where `secrets.env` is
 * built — so all three front ends get it by construction, exactly as they get the create-time
 * preflight (k6xp). "By construction" is a claim about composition, though, and the way
 * composition claims fail is that one caller never reaches the composed thing at all: the CLI
 * could not send a repository AT ALL until rockysurf-81wo, so for it this was true and empty.
 *
 * So this creates the same box twice, once through the MCP tool and once through the CLI
 * command, over a real booted core with a real token table, and insists the two agree with each
 * other AND that the narrowing really narrowed.
 *
 * `create_anyway` throughout: the point here is the token set, and letting the preflight run
 * would put a test on the network, aimed at github.com.
 */
describe('the tokens a box is built with, through MCP and through the CLI', () => {
  const dirs: string[] = []

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  /** Broadest entry first, so a naive first-match narrowing would pick the wrong one. */
  const GITHUB = [
    'github:',
    '  pat: ghp_fallback',
    '  tokens:',
    '    - owner: acme',
    '      pat: ghp_acme',
    '    - repo: "acme/widgets"',
    '      pat: ghp_widgets',
    '    - host: git.example.com',
    '      pat: ghp_enterprise',
    '',
  ].join('\n')

  async function bootCore() {
    const dir = mkdtempSync(join(tmpdir(), 'rockysurf-mcp-tokens-'))
    dirs.push(dir)
    const configPath = join(dir, 'rockysurf.config.yaml')
    writeFileSync(configPath, `server:\n  dataDir: ${join(dir, 'data')}\n${GITHUB}`)

    const booted = await boot({
      argv: ['--config', configPath],
      listen: false,
      announce: () => {},
      log: () => {},
      providers: () => new ProviderRegistry([makeFakeProvider()]),
    })
    const [admin] = booted.db.sqlite.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').all() as { id: string }[]
    const { token } = issueSession(booted.db.db, admin!.id)
    const coreClient = createCoreClient({
      baseUrl: 'http://core.test',
      token,
      fetchImpl: ((input: string, init?: RequestInit) => booted.app.request(input, init)) as unknown as typeof fetch,
    })
    return { booted, coreClient }
  }

  /** What core says this box carries — names only, and the same function that fills secrets.env. */
  async function scopesOf(coreClient: CoreClient, serverId: string): Promise<string[] | undefined> {
    const body = (await coreClient.get(`/api/v1/servers/${serverId}`)) as {
      githubTokenScopes?: string[]
      carriesFallbackToken?: boolean
    }
    return body.githubTokenScopes
  }

  it('narrows to the declared repository, and agrees across both front ends', async () => {
    const { booted, coreClient } = await bootCore()
    try {
      const repositories = ['https://github.com/acme/widgets']

      const viaMcp = (await runTool(
        'create_server',
        { size: 'small', name: 'from-mcp', repositories, create_anyway: true },
        { client: coreClient, scopes: ['read', 'create'] as McpScope[] },
      )) as { server: { serverId: string } }

      const lines: string[] = []
      const code = await createCommand(
        { client: coreClient, out: (l) => lines.push(l), err: () => {}, env: {} },
        { name: 'from-cli', repositories, createAnyway: true },
      )
      expect(code).toBe(0)
      const viaCli = (await coreClient.get('/api/v1/servers')) as Array<{ serverId: string; name: string }>
      const cliId = viaCli.find((s) => s.name === 'from-cli')!.serverId

      // One entry, the most specific one — NOT the owner-scoped entry written above it, and not
      // the enterprise host's token, which this box has no business holding.
      expect(await scopesOf(coreClient, viaMcp.server.serverId)).toEqual(['github.com/acme/widgets'])
      // ...and the CLI's box is the same box. That is the parity claim, stated as one equality.
      expect(await scopesOf(coreClient, cliId)).toEqual(await scopesOf(coreClient, viaMcp.server.serverId))
    } finally {
      await booted.close()
    }
  })

  it('gives a box that declared no repositories no scoped tokens through either', async () => {
    const { booted, coreClient } = await bootCore()
    try {
      const viaMcp = (await runTool(
        'create_server',
        { size: 'small', name: 'bare-mcp' },
        { client: coreClient, scopes: ['read', 'create'] as McpScope[] },
      )) as { server: { serverId: string } }

      await createCommand({ client: coreClient, out: () => {}, err: () => {}, env: {} }, { name: 'bare-cli' })
      const all = (await coreClient.get('/api/v1/servers')) as Array<{ serverId: string; name: string }>
      const cliId = all.find((s) => s.name === 'bare-cli')!.serverId

      expect(await scopesOf(coreClient, viaMcp.server.serverId)).toEqual([])
      expect(await scopesOf(coreClient, cliId)).toEqual([])
    } finally {
      await booted.close()
    }
  })
})
