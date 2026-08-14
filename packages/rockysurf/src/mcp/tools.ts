import type { McpScope } from '@rockysurf/core'
import { z } from 'zod'
import { packRequiresRdp, RDP_MIN_LENGTH } from '../rdp.js'
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
  /**
   * `amount`, `currency` and `fraction` are present only when a cap is CONFIGURED — `/costs`
   * sends `{ overCap: false }` and nothing else when it is not, which is the default install.
   * Typing them as required is what made this object's `fraction.toFixed()` throw, and since
   * the throw is swallowed below, every tool result on an uncapped installation lost its spend
   * context and told the agent cost data was unavailable (found by rockysurf-dec8's cap test).
   */
  cap?: { overCap: boolean; amount?: number; currency?: string; fraction?: number } | null
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
        // A cap the agent can reason about needs an amount to compare against; an installation
        // with none configured gets an honest `null` rather than a cap of undefined.
        ...(costs.cap && costs.cap.amount !== undefined
          ? {
              cap: {
                amount: costs.cap.amount,
                currency: costs.cap.currency,
                fractionUsed: Number((costs.cap.fraction ?? 0).toFixed(3)),
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
      size: z
        .enum(['small', 'medium', 'large'])
        .default('small')
        .describe(
          'How big a machine, as a floor rather than an exact type: small is at least 2 vCPU and ' +
            '2 GB, medium at least 2 and 4, large at least 4 and 8. The control plane picks the ' +
            'cheapest machine the chosen cloud sells that meets it, and refuses — naming the ' +
            'shortfall — rather than quietly handing back a smaller one.',
        ),
      /**
       * ARCH, WHICH AN AGENT COULD NOT ASK FOR AT ALL UNTIL NOW (rockysurf-0t2h).
       *
       * The SPA has treated architecture as first-class since it was written; this schema had
       * no way to say it, so an agent asking for an ARM box got whatever resolution landed on
       * — in the confirming run, an amd64 e2-micro. Adding it here was only possible once
       * rockysurf-clf2 fixed the resolver: before that, `arch` reached the API and came back
       * `invalid_spec`, so this parameter would have been a new way to fail rather than a new
       * thing to do.
       *
       * A closed enum, unlike `provider` and `offering_id` below, because the two
       * architectures are the SDK's own frozen list rather than anything an operator
       * configures — the same enum the HTTP API validates against.
       */
      arch: z
        .enum(['amd64', 'arm64'])
        .optional()
        .describe(
          'Which CPU architecture. arm64 is usually the cheaper and faster of the two, and is ' +
            'what the packs are built for first. Omit to let the control plane take the cheapest ' +
            'machine of either that meets the size — it will not silently substitute the other ' +
            'architecture when one is named and unavailable.',
        ),
      // Un-enumerated for the same reason `provider` is: the ids are the cloud's own
      // (`t4g.small`, `cpx12`, `e2-micro`) and narrowed further by the operator's
      // `providers.<cloud>.sizes`, so no list belonging in this file could be right for two
      // installations. Optional, and rarely needed — `size` plus `arch` is the surface meant
      // for an agent, and this is the escape hatch for a human who already knows the type.
      offering_id: z
        .string()
        .min(1)
        .optional()
        .describe(
          "A specific machine type from the cloud's own catalogue, if you already know which " +
            'one you want. Overrides size. The create is refused if this installation does not ' +
            'offer it.',
        ),
      pack_id: z.string().min(1).optional().describe('Which surge pack to install.'),
      repositories: z
        .array(z.string().min(1))
        .optional()
        .describe(
          'Repository URLs to clone, as https:// URLs. Each is checked against the forge before ' +
            'any machine is launched, and the create is refused — naming the URL — if one does ' +
            'not open with the tokens this installation has configured.',
        ),
      create_anyway: z
        .boolean()
        .optional()
        .describe(
          'Create even though a repository URL failed that check. Use it only when the human ' +
            'says the URL is right: the box will still try to clone it, and a box whose clone ' +
            'fails keeps running and keeps billing until it is terminated.',
        ),
      // Optional, and left un-enumerated on purpose: the ids come from the operator's config,
      // not from this file, and hardcoding them here would be the provider-id conditional the
      // rest of the codebase spends its effort avoiding. Omitting it is fine on a
      // single-provider installation; with several configured the control plane refuses and
      // names them, which is the prompt an agent needs to fill this in (rockysurf-va2l).
      provider: z
        .string()
        .min(1)
        .optional()
        .describe('Which configured cloud to create on. Required when more than one is configured.'),
      /**
       * AN ARGUMENT HERE, A PROMPT IN THE CLI, AND THE DIFFERENCE IS DELIBERATE
       * (rockysurf-kvkr). The CLI's caller is a shell, where a value on the command line is
       * written to a history file and readable in `ps`; an MCP client is a program, and this
       * argument travels in a JSON-RPC message over the client's own stdio pipe. What it does
       * cost is context: the value passes through the agent's transcript, which is stated in
       * SECURITY.md rather than hidden. Nothing gives it back — no tool returns it.
       */
      rdp_password: z
        .string()
        .min(RDP_MIN_LENGTH)
        .optional()
        .describe(
          `Password for the box's rocky account, at least ${RDP_MIN_LENGTH} characters. REQUIRED ` +
            'when the chosen pack installs a remote desktop; the create is refused without one ' +
            'rather than building a box that fails its last step. Never returned by any tool — ' +
            'if it is lost, SSH in and run `sudo passwd rocky`.',
        ),
    }),
    run: async (args, { client }) => {
      const packId = args['pack_id'] ? String(args['pack_id']) : undefined
      const rdpPassword = args['rdp_password'] ? String(args['rdp_password']) : undefined

      // Refused BEFORE the create, not after: a desktop pack with no password provisions
      // fully and then fails its injected `rdp` step, which is a running instance the agent
      // has to be told to clean up. Deliberately not the other way round — a password given
      // for a pack that turns out not to need one is still passed through, because the pack
      // list may be unreadable and dropping it would recreate the bug this fixes.
      if (packId && !rdpPassword && (await packRequiresRdp(client, packId))) {
        throw new Error(
          `"${packId}" installs a remote desktop, so create_server needs rdp_password (at least ` +
            `${RDP_MIN_LENGTH} characters) — it becomes the password for the rocky account over ` +
            'RDP. Ask the human which password to use rather than inventing one: they are the ' +
            'only one who will ever see it again, and nothing can read it back.',
        )
      }

      const server = await client.post<unknown>('/api/v1/servers', {
        ...(args['name'] ? { name: args['name'] } : {}),
        size: args['size'] ?? 'small',
        ...(args['arch'] ? { arch: args['arch'] } : {}),
        ...(args['offering_id'] ? { offeringId: args['offering_id'] } : {}),
        ...(packId ? { packId } : {}),
        ...(args['repositories'] ? { repositories: args['repositories'] } : {}),
        ...(args['create_anyway'] ? { createAnyway: true } : {}),
        ...(args['provider'] ? { provider: args['provider'] } : {}),
        ...(rdpPassword ? { rdpPassword } : {}),
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
      // `issues` rides along for the same reason `reason` does (rockysurf-k6xp): the
      // repository preflight refuses a create with one entry per bad URL, and an agent that
      // is told only "one or more repositories could not be opened" has to guess which of the
      // URLs it just sent to fix. The summary names the override; these name the fields.
      const issues = Array.isArray(error.body['issues']) ? error.body['issues'] : undefined
      throw new Error(
        JSON.stringify({
          refused: true,
          status: error.status,
          code: error.body.code ?? 'error',
          ...(error.body.reason ? { reason: error.body.reason } : {}),
          ...(issues ? { issues } : {}),
          message: error.message,
        }),
      )
    }
    throw error
  }
}
