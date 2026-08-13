import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { McpScope } from '@rockysurf/core'
import { createCoreClient } from './client.js'
import { runTool, visibleTools } from './tools.js'

/**
 * The MCP server: `rockysurf mcp` (rockysurf-ftl9.1).
 *
 * Stdio, because that is what a local agent client speaks and because it means the server has
 * no listening socket of its own to secure. It authenticates to the control plane with a token
 * from the environment, so a server started without one is inert rather than dangerous.
 *
 * WHERE THE REAL ENFORCEMENT IS, and it is not here. Scopes below stop an agent from calling a
 * tool it was not granted, which is a guardrail against mistakes and prompt injection. It is
 * NOT a sandbox: an agent with shell access on this machine can read the same token out of the
 * environment and call the HTTP API directly. What stops it there is core — `maxServers`,
 * `createRatePerHour` and the spend cap are enforced on the create path itself, for every
 * caller. That asymmetry is stated in the threat model rather than papered over, because the
 * honest claim is "budget-capped", not "sandboxed".
 */

export const MCP_TOKEN_ENV = 'ROCKYSURF_TOKEN'
export const MCP_BASE_URL_ENV = 'ROCKYSURF_URL'

export interface McpServerOptions {
  scopes: readonly McpScope[]
  baseUrl: string
  token: string
  fetchImpl?: typeof fetch
}

/** Build the server without connecting it, so tests can drive the handlers directly. */
export function createMcpServer(options: McpServerOptions): Server {
  const client = createCoreClient({
    baseUrl: options.baseUrl,
    token: options.token,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })
  const context = { client, scopes: options.scopes }

  const server = new Server(
    { name: 'rockysurf', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    // Only what this installation granted. A tool an agent cannot call should not be dangled
    // in front of it — that is how a model spends a turn discovering it is not allowed.
    tools: visibleTools(options.scopes).map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema, { io: 'input' }) as Record<string, unknown>,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>
    try {
      const result = await runTool(request.params.name, args, context)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    } catch (error) {
      // `isError` rather than a thrown protocol error: the model should SEE the refusal and be
      // able to act on it ("the cap is reached, ask the human"), not have the turn fail.
      return {
        isError: true,
        content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
      }
    }
  })

  return server
}

export interface RunMcpServerOptions {
  scopes: readonly McpScope[]
  env?: NodeJS.ProcessEnv
  /** Where messages to the operator go. NEVER stdout: stdout is the MCP transport. */
  log?: (message: string) => void
}

/**
 * Start the stdio server. Resolves when the transport closes.
 *
 * NOTHING MAY BE PRINTED TO STDOUT by anything in this process — stdout is the protocol
 * channel, and a stray `console.log` corrupts the stream in a way that presents as an
 * unexplained client disconnect.
 */
export async function runMcpServer(options: RunMcpServerOptions): Promise<number> {
  const env = options.env ?? process.env
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`))

  const token = env[MCP_TOKEN_ENV]
  if (!token) {
    log(
      `${MCP_TOKEN_ENV} is not set, so this MCP server has no way to reach Rocky Surf.\n` +
        '\n' +
        '  rockysurf token          # mint one, printed once\n' +
        '\n' +
        `Then set ${MCP_TOKEN_ENV} in your MCP client's configuration.`,
    )
    return 1
  }

  const baseUrl = env[MCP_BASE_URL_ENV] ?? 'http://127.0.0.1:3000'
  const server = createMcpServer({ scopes: options.scopes, baseUrl, token })

  log(
    `rockysurf mcp → ${baseUrl} (scopes: ${options.scopes.join(', ') || 'none'})` +
      (options.scopes.includes('terminate') ? '  ⚠ terminate is GRANTED — this agent can destroy servers' : ''),
  )

  await server.connect(new StdioServerTransport())
  await new Promise<void>((resolve) => {
    server.onclose = () => resolve()
  })
  return 0
}
