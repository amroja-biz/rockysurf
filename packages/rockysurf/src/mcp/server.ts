import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { McpScope } from '@rockysurf/core'
import { createCoreClient, unreachableMessage } from './client.js'
import { describeTool, runTool, visibleTools } from './tools.js'

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
    //
    // `describeTool` does not widen that: it adds the REASON a named-but-absent tool is absent
    // to the description of a tool that is present (#353). Silence about a withheld scope reads
    // as a missing feature; a sentence naming `mcp.scopes` reads as the operator decision it is.
    tools: visibleTools(options.scopes).map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: describeTool(tool, options.scopes),
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
  /** Test seam only. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/** How long the startup preflight waits for `/health` before giving up on it (#350). */
export const PREFLIGHT_TIMEOUT_MS = 1500

/**
 * A NON-FATAL startup probe of core's `/health` (#350, following the #348 evaluation).
 *
 * Before this, `rockysurf mcp` started cleanly, advertised the full tool list, and said nothing
 * was wrong even with nothing listening at ROCKYSURF_URL — the first sign of trouble was the
 * first tool call's refusal. This probes once at startup and, on failure, writes the SAME
 * actionable message `client.ts` already composes for a tool call's own failure, so the
 * first-run signal and the eventual tool-call error read as one voice rather than two.
 *
 * Deliberately unauthenticated — `/health` needs no token — so a fetch that succeeds at all
 * means something is listening, whether or not `ROCKYSURF_TOKEN` turns out to be valid. That is
 * on purpose: a bad token is a different failure, and the first tool call already reports it
 * well; this probe only answers "is anything there".
 *
 * Bounded by `PREFLIGHT_TIMEOUT_MS` so a firewalled host or a proxy that swallows the connection
 * cannot hang this forever — but the call site matters more than the timeout: this runs AFTER
 * the stdio transport has connected, never before. Probing first and letting a hung socket sit
 * there would leave the MCP client waiting on an initialize response that never comes, which is
 * worse than the silent failure this exists to fix.
 *
 * NEVER THROWS, and never gates startup: an MCP client may legitimately launch this process
 * before `rockysurf serve` is up, and every tool call re-fetches and reports its own failure, so
 * the whole design already self-recovers. This is a nudge on stderr, not a refusal to start.
 */
export async function preflightCoreHealth(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS)
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/health`, { signal: controller.signal })
    return response.ok ? undefined : unreachableMessage(baseUrl)
  } catch {
    return unreachableMessage(baseUrl)
  } finally {
    clearTimeout(timer)
  }
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
      ' — requires rockysurf serve listening there' +
      (options.scopes.includes('terminate') ? '  ⚠ terminate is GRANTED — this agent can destroy servers' : ''),
  )

  await server.connect(new StdioServerTransport())

  // AFTER the transport connects, deliberately: see preflightCoreHealth's own doc comment for
  // why probing any earlier would risk stalling MCP initialization on a hung socket.
  const unreachable = await preflightCoreHealth(baseUrl, options.fetchImpl)
  if (unreachable) log(unreachable)

  await new Promise<void>((resolve) => {
    server.onclose = () => resolve()
  })
  return 0
}
