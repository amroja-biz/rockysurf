import type { McpScope } from '@rockysurf/core'
import { z } from 'zod'
import { CoreApiError, type CoreClient } from './client.js'

/**
 * The six MCP tools, and the scope each one needs (rockysurf-ftl9.1).
 *
 * WHAT THIS FILE IS FOR, stated plainly: it is a translation layer, not a second copy of the
 * business logic. Every tool is an HTTP call to a route a browser also uses, so limits,
 * ownership and error shapes are core's — there is nothing here for them to drift from.
 *
 * TWO THINGS AN AGENT NEVER RECEIVES, both deliberate:
 *
 *  - **key material.** `get_ssh_command` returns a COMMAND, and a pointer to where the key can
 *    be downloaded by a human. Returning a private key would put it in the agent's context,
 *    its transcript, and any log that transcript touches — irreversibly.
 *  - **a credential of any kind.** The core token lives in this process's environment, never
 *    in a tool result.
 *
 * EVERY RESULT CARRIES COST CONTEXT, because an agent that cannot see spend cannot reason
 * about it, and "budget-capped credit card" is the whole product claim.
 */

export interface ToolContext {
  client: CoreClient
  scopes: readonly McpScope[]
}

export interface McpToolDefinition {
  name: string
  title: string
  description: string
  /** The scope a caller must hold. */
  scope: McpScope
  inputSchema: z.ZodType
  run: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>
}

/* ------------------------------------------------------------------------- cost context */

interface CostsResponse {
  monthToDate: { month: string; byCurrency: Record<string, number>; unpricedServers: number }
  cap?: { overCap: boolean; amount: number; currency: string; fraction: number } | null
}

/**
 * The spend picture appended to every tool result.
 *
 * Fetched per call rather than cached: an agent may run for hours, and a stale cap reading is
 * exactly the number it must not reason from. A failure here is swallowed — losing cost
 * context should degrade a result, never fail an operation the user asked for.
 */
async function costContext(client: CoreClient): Promise<Record<string, unknown>> {
  try {
    const costs = await client.get<CostsResponse>('/api/v1/costs')
    return {
      spend: {
        month: costs.monthToDate.month,
        monthToDateByCurrency: costs.monthToDate.byCurrency,
        unpricedServers: costs.monthToDate.unpricedServers,
        ...(costs.cap
          ? {
              cap: {
                amount: costs.cap.amount,
                currency: costs.cap.currency,
                fractionUsed: Number(costs.cap.fraction.toFixed(3)),
                overCap: costs.cap.overCap,
              },
            }
          : { cap: null }),
        note:
          'Estimates from bundled price data, not a bill. Unpriced servers are real spend this ' +
          'figure cannot see.',
      },
    }
  } catch {
    return { spend: { unavailable: 'could not read cost data; the operation itself is unaffected' } }
  }
}

/* ------------------------------------------------------------------------------- tools */

const serverIdSchema = z.strictObject({
  server_id: z.string().min(1).describe('The server id, e.g. srv-9f2c1d3b4a5e'),
})

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'list_servers',
    title: 'List servers',
    description:
      'List the servers you own, with status, address and hourly cost. Includes month-to-date ' +
      'spend and the configured cap.',
    scope: 'read',
    inputSchema: z.strictObject({
      include_terminated: z.boolean().default(false).describe('Include servers already terminated.'),
    }),
    run: async (args, { client }) => {
      const query = args['include_terminated'] ? '?includeTerminated=true' : ''
      const servers = await client.get<unknown[]>(`/api/v1/servers${query}`)
      return { servers, ...(await costContext(client)) }
    },
  },

  {
    name: 'get_server',
    title: 'Get a server',
    description: 'Full detail for one server, including provisioning progress and cost so far.',
    scope: 'read',
    inputSchema: serverIdSchema,
    run: async (args, { client }) => {
      const server = await client.get<unknown>(`/api/v1/servers/${String(args['server_id'])}`)
      return { server, ...(await costContext(client)) }
    },
  },

  {
    name: 'get_ssh_command',
    title: 'Get the SSH command for a server',
    description:
      'The ssh command to reach a running server. Returns the COMMAND only — the private key ' +
      'is never returned and must be downloaded by a human from the web UI.',
    scope: 'read',
    inputSchema: serverIdSchema,
    run: async (args, { client }) => {
      const id = String(args['server_id'])
      const { server } = await client.get<{
        server: { publicIp?: string; sshUser?: string; sshPort?: number; status: string }
      }>(`/api/v1/servers/${id}`).then((body) => ({ server: (body as { server?: unknown }).server ?? body })) as {
        server: { publicIp?: string; sshUser?: string; sshPort?: number; status: string }
      }

      if (!server.publicIp) {
        return {
          ready: false,
          status: server.status,
          reason: `server ${id} has no public address yet (status: ${server.status})`,
          ...(await costContext(client)),
        }
      }

      const user = server.sshUser ?? 'rocky'
      // Present only when the box is not on 22 — a provider that adopted a machine it did not
      // create reports whatever its operator configured (ADR-0003, E13).
      const port = server.sshPort ? `-p ${server.sshPort} ` : ''
      return {
        ready: true,
        // The key path is where the CLI writes it; the agent is told where, not given it.
        command: `ssh ${port}-i ~/.rockysurf/keys/${id}.pem ${user}@${server.publicIp}`,
        keyNote: `Download the key from the web UI (Servers → ${id} → SSH key) if you do not have it yet.`,
        ...(await costContext(client)),
      }
    },
  },

  {
    name: 'stop_server',
    title: 'Stop a server',
    description:
      'Stop a running server, preserving its disk. Reversible — start it again from the web UI. ' +
      'Stopping is the cheap way to pause spend without losing work.',
    scope: 'stop',
    inputSchema: serverIdSchema,
    run: async (args, { client }) => {
      const server = await client.post<unknown>(`/api/v1/servers/${String(args['server_id'])}/stop`)
      return { server, ...(await costContext(client)) }
    },
  },

  {
    name: 'create_server',
    title: 'Create a server',
    description:
      'Create a new dev box. Subject to the configured limits — maximum servers, creates per ' +
      'hour, and the monthly spend cap — all enforced by the control plane, which will refuse ' +
      'with a reason rather than silently succeeding.',
    scope: 'create',
    inputSchema: z.strictObject({
      name: z.string().min(1).optional().describe('A name for the server. One is generated if omitted.'),
      size: z.enum(['small', 'medium', 'large']).default('small'),
      pack_id: z.string().min(1).optional().describe('Which surge pack to install.'),
      repositories: z.array(z.string().min(1)).optional().describe('Repository URLs to clone.'),
    }),
    run: async (args, { client }) => {
      const server = await client.post<unknown>('/api/v1/servers', {
        ...(args['name'] ? { name: args['name'] } : {}),
        size: args['size'] ?? 'small',
        ...(args['pack_id'] ? { packId: args['pack_id'] } : {}),
        ...(args['repositories'] ? { repositories: args['repositories'] } : {}),
      })
      return { server, ...(await costContext(client)) }
    },
  },

  {
    name: 'terminate_server',
    title: 'Terminate a server',
    description:
      'Destroy a server and its disk. IRREVERSIBLE — anything not committed and pushed is ' +
      'lost. Requires a scope granted separately from create.',
    scope: 'terminate',
    inputSchema: serverIdSchema,
    run: async (args, { client }) => {
      const server = await client.post<unknown>(`/api/v1/servers/${String(args['server_id'])}/terminate`)
      return { server, ...(await costContext(client)) }
    },
  },
]

/* --------------------------------------------------------------------------- execution */

export class ScopeDeniedError extends Error {
  constructor(
    readonly tool: string,
    readonly required: McpScope,
    readonly granted: readonly McpScope[],
  ) {
    super(
      `"${tool}" needs the "${required}" MCP scope, which this installation has not granted. ` +
        `Granted: ${granted.length ? granted.join(', ') : '(none)'}. ` +
        `Add it to mcp.scopes in rockysurf.config.yaml and restart — deliberately a file an ` +
        `operator edits, not something a client can ask for.`,
    )
    this.name = 'ScopeDeniedError'
  }
}

/** Tools a given scope set may see. A tool it cannot call is not advertised. */
export function visibleTools(scopes: readonly McpScope[]): McpToolDefinition[] {
  return MCP_TOOLS.filter((tool) => scopes.includes(tool.scope))
}

/**
 * Run one tool, gate first.
 *
 * The gate is re-checked here even though `visibleTools` already hid it: a client may call a
 * name it was never offered, and "not listed" is not a security control.
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<unknown> {
  const tool = MCP_TOOLS.find((t) => t.name === name)
  if (!tool) throw new Error(`unknown tool: ${name}`)
  if (!context.scopes.includes(tool.scope)) throw new ScopeDeniedError(name, tool.scope, context.scopes)

  const parsed = tool.inputSchema.parse(args)
  try {
    return await tool.run(parsed as Record<string, unknown>, context)
  } catch (error) {
    if (error instanceof CoreApiError) {
      // Core's refusal, passed through with its machine-readable reason intact. A limit
      // rejection is information an agent can act on — "wait an hour", "terminate something
      // first" — and flattening it to "request failed" would throw that away.
      throw new Error(
        JSON.stringify({
          refused: true,
          status: error.status,
          code: error.body.code ?? 'error',
          ...(error.body.reason ? { reason: error.body.reason } : {}),
          message: error.message,
        }),
      )
    }
    throw error
  }
}
