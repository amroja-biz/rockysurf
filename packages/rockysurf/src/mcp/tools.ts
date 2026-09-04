import type { McpScope } from '@rockysurf/core'
import { z } from 'zod'
import { packRequiresRdp, RDP_MIN_LENGTH } from '../rdp.js'
import { CoreApiError, type CoreClient } from './client.js'

/**
 * The MCP tools, and the scope each one needs (rockysurf-ftl9.1).
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

/**
 * One cloud, as `GET /api/v1/providers` reports it (rockysurf-oeay).
 *
 * Declared as the shape this file READS rather than imported from core, which the dependency
 * rule would not allow anyway: `offerings` is already narrowed by the operator's allowlist by
 * the time it arrives, and `offeringsError` is how one cloud having a bad day is reported
 * without failing the others.
 */
export interface ProviderCatalogue {
  id: string
  displayName: string
  offerings: Array<{
    id: string
    cpu: number
    memoryGb: number
    arch: string
    /** `false` means the cloud is out of this type right now — a price is not an offer. */
    available: boolean
  /** The provider's own reason `available` is false, when it has one (Azure: core quota). */
  unavailableReason?: string
    /** `null` means the provider quotes no price. Never render it as free. */
    hourly: { amount: number; currency: string } | null
    region: string
  }>
  offeringsError?: string
}

/**
 * One cloud IN FULL, as `GET /api/v1/providers` reports it — what `list_providers` and
 * `get_provider` pass through (#351).
 *
 * `ProviderCatalogue` above is the same route narrowed to pricing alone, for `list_offerings`'
 * job of picking a `create_server` argument. This is the other job: telling an agent what a
 * cloud CAN DO before it calls `stop_server` or `start_server` there. Neither field is secret —
 * `capabilities` is a fixed set of booleans/numbers core itself is only allowed to branch on
 * (never a credential), and `tierPreferences` names a saved offering id, not a value that
 * unlocks anything.
 */
export interface ProviderRecord extends ProviderCatalogue {
  capabilities: {
    stop: boolean
    ipStableAcrossStop: boolean
    canInjectHostKeys: boolean
    userDataMaxBytes: number
    generatesUserData: boolean
    /**
     * The three OPTIONAL capabilities, absent meaning false — passed through because an agent
     * deciding whether `stop_server` saves money needs `billsWhileStopped` (ADR-0025): on a
     * cloud that sets it, a stopped machine bills at the running rate and only `terminate_server`
     * ends the charge.
     */
    billsWhileStopped?: boolean
    managesSshAccess?: boolean
    simulatedInstances?: boolean
  }
  /** The machine type saved for each size on this cloud (issue #124). Absent if none saved. */
  tierPreferences?: Partial<Record<'small' | 'medium' | 'large', string>>
}

/**
 * One surge pack, as `GET /api/v1/surge-packs` reports it (#278).
 *
 * Declared as the shape this file READS, like `ProviderCatalogue` above and for the same
 * reason — core is not importable from here. Only the fields `list_packs` passes on are
 * named; the route sends more.
 */
export interface PublicPackRow {
  packId: string
  name: string
  tools?: Array<{ toolId: string; name: string }>
  requiresRepos?: boolean
  requiresRdp?: boolean
  desktop?: string
  webPort?: number
  inputs?: Array<{ name: string; label: string; required?: boolean; secret?: boolean }>
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

/* ------------------------------------------------------------------- saved ssh keys */

/**
 * One entry from the operator's `ssh.keys` list, as `GET /api/v1/ssh-keys` reports it (#302).
 *
 * Declared as the shape this file READS, like `ProviderCatalogue` above and for the same
 * reason. The route is the New Server page's own option source: not admin-only, mounted
 * unconditionally, and answered from a function that re-reads the config, so a key saved a
 * moment ago is offered on the next call with no restart (ADR-0017).
 */
export interface SavedSshKeyRow {
  name: string
  publicKey: string
}

/**
 * The saved keys, or an empty list.
 *
 * The `Array.isArray` guard is not defensive typing for its own sake: every caller below
 * either maps over this or searches it, and an installation whose route answered something
 * else would otherwise fail a create with a `TypeError` instead of the refusal it deserves.
 * An empty list is a real answer — most installations have saved none — so the callers say
 * that in as many words rather than treating it as an error.
 */
async function savedSshKeys(client: CoreClient): Promise<SavedSshKeyRow[]> {
  const rows = await client.get<unknown>('/api/v1/ssh-keys')
  return Array.isArray(rows) ? (rows as SavedSshKeyRow[]) : []
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
    /**
     * THE PROVIDER LIST, because an agent had no way to see what a cloud CAN DO before calling
     * `stop_server` or `start_server` there (#351).
     *
     * `list_offerings` below reads the same route but narrows it to pricing, for the
     * `create_server` job of picking an `offering_id`. This tool passes `capabilities` and
     * `tierPreferences` on too, for the different job of checking, say, `capabilities.stop`
     * before assuming a box can be paused — some clouds cannot.
     *
     * Read scope for the reason `list_offerings` has it: nothing here spends money or changes
     * anything, and none of it is a credential — `capabilities` is a fixed set of
     * booleans/numbers, never provider-specific, and `tierPreferences` names a saved offering
     * id rather than a secret.
     */
    name: 'list_providers',
    title: 'List configured cloud providers',
    description:
      'Every cloud this installation is configured for, with what it can do (capabilities: ' +
      'whether it supports stop/start, keeps the same IP address across a stop, whether a ' +
      'stopped server still bills at the running rate (billsWhileStopped), and so on), ' +
      'what it sells, and any saved size preference. Use it to check what a cloud supports ' +
      'before calling stop_server or start_server on a server there — on a cloud with ' +
      'billsWhileStopped, stopping saves nothing and only terminate_server ends the charge. ' +
      'Use list_offerings instead if you only need prices for create_server.',
    scope: 'read',
    inputSchema: z.strictObject({}),
    run: async (_args, { client }) => {
      const providers = await client.get<ProviderRecord[]>('/api/v1/providers')
      return { providers }
    },
  },

  {
    name: 'get_provider',
    title: 'Get one cloud provider',
    description:
      'Full detail for one configured cloud — the same information list_providers returns, ' +
      'narrowed to a single provider. Refused, naming the configured clouds, if the id is not ' +
      'one of them.',
    scope: 'read',
    inputSchema: z.strictObject({
      provider: z.string().min(1).describe('The provider id, as list_providers names it.'),
    }),
    run: async (args, { client }) => {
      const wanted = String(args['provider'])
      const providers = await client.get<ProviderRecord[]>('/api/v1/providers')
      const found = providers.find((p) => p.id === wanted)
      // Matches `list_offerings`' treatment of the same miss: name what there is rather than
      // answering with nothing, which would read like a cloud with an empty id.
      if (!found) {
        return { error: `no configured cloud called "${wanted}"`, configured: providers.map((p) => p.id) }
      }
      return { provider: found }
    },
  },

  {
    /**
     * THE CATALOGUE, because `create_server.offering_id` was advertised with no way to learn
     * its values (rockysurf-oeay).
     *
     * `provider` is discoverable — omit it on a multi-cloud installation and the control plane
     * refuses and names the configured ids (rockysurf-va2l). `offering_id` had no equivalent:
     * the six tools were create/get/list/ssh/stop/terminate, none of which exposes a catalogue,
     * so an agent could use the parameter only if a human had already told it an id.
     *
     * Read scope, and that is the whole of the risk assessment: this returns what a cloud sells
     * and what it costs, spends nothing, and changes nothing. Withholding it from an agent that
     * may already list servers and read the spend cap would not protect anything — and seeing
     * prices BEFORE committing is the same argument the spend-cap context won (rockysurf-dec8).
     *
     * Nothing here is hardcoded. The ids come back from `GET /api/v1/providers`, which narrows
     * them by the operator's `providers.<cloud>.sizes` (rockysurf-j10e) — the same allowlist the
     * create path applies — so this cannot advertise a machine the create would refuse.
     */
    name: 'list_offerings',
    title: 'List the machine types a cloud sells',
    description:
      'The machine types this installation can actually create, per configured cloud, with ' +
      'vCPU, memory, architecture and hourly price. Use it to pick an offering_id for ' +
      'create_server, or to compare prices before spending. `available: false` means the cloud ' +
      'is out of that type right now — creating it would be refused. The list is already ' +
      'narrowed to what the operator allows, so anything absent here cannot be created.',
    scope: 'read',
    inputSchema: z.strictObject({
      provider: z
        .string()
        .min(1)
        .optional()
        .describe('Only this cloud. Omit for every configured cloud.'),
    }),
    run: async (args, { client }) => {
      const wanted = args['provider'] === undefined ? undefined : String(args['provider'])
      const providers = await client.get<ProviderCatalogue[]>('/api/v1/providers')
      const matching = wanted ? providers.filter((p) => p.id === wanted) : providers

      // A named provider that does not exist gets the same treatment the create refusal gets:
      // say so, and name what there is, rather than answering with an empty list that reads
      // like a cloud with nothing to sell.
      if (wanted && matching.length === 0) {
        return {
          error: `no configured cloud called "${wanted}"`,
          configured: providers.map((p) => p.id),
        }
      }
      return { providers: matching }
    },
  },

  {
    /**
     * THE PACK CATALOGUE, and it is `list_offerings`' argument applied a second time (#278).
     *
     * `create_server.pack_id` was advertised with no way to learn its values — exactly what
     * rockysurf-oeay said about `offering_id`: a parameter usable only by an agent a human had
     * already briefed. The MCP server has been calling this very route internally since
     * rockysurf-kvkr, to decide whether a create needs a desktop password; it simply never
     * told the agent what it saw.
     *
     * Read scope, and the risk assessment is `list_offerings`' in full: it spends nothing,
     * changes nothing, and discloses what an operator has already chosen to install.
     *
     * NARROWED, WHERE `list_offerings` PASSES CORE'S OBJECT THROUGH, and the difference is
     * deliberate rather than an inconsistency. `/api/v1/providers` serves the create path's own
     * vocabulary — ids and prices — so passing it on is the safest thing that can be done with
     * it. `/api/v1/surge-packs` serves a FORM: display order, a theme, an image URL and a
     * post-install guide written for whoever logs into the box. None of that helps an agent
     * choose a pack, and all of it lands in the agent's context on every call. What is kept is
     * what a create is decided by — the id, the name, what gets installed, and the three things
     * that make a create fail if they are not read first.
     */
    name: 'list_packs',
    title: 'List the surge packs that can be installed on a new server',
    description:
      'The surge packs this installation offers, with what each one installs. Use it to pick a ' +
      'pack_id for create_server. Three fields decide whether a create will be refused, and ' +
      'reading them first is the point of this tool: requiresRdp means create_server needs an ' +
      'rdp_password, so ask the human for one BEFORE creating rather than learning it from the ' +
      'refusal; requiresRepos means the box expects at least one repository; and a pack that ' +
      'lists inputs is asking whoever creates the server for those values — create_server ' +
      'cannot send them, so a pack with a required input has to be created from the web UI. ' +
      'Anything absent from this list cannot be installed.',
    scope: 'read',
    inputSchema: z.strictObject({}),
    run: async (_args, { client }) => {
      const packs = await client.get<PublicPackRow[]>('/api/v1/surge-packs')
      return {
        packs: packs.map((pack) => ({
          packId: pack.packId,
          name: pack.name,
          // Ids and names only. A tool's description, category and URL are the Pack Shop's
          // copy, and an agent choosing between packs is choosing between these two words.
          tools: (pack.tools ?? []).map((tool) => ({ toolId: tool.toolId, name: tool.name })),
          requiresRepos: pack.requiresRepos === true,
          requiresRdp: pack.requiresRdp === true,
          ...(pack.desktop ? { desktop: pack.desktop } : {}),
          ...(pack.webPort ? { webPort: pack.webPort } : {}),
          // The QUESTION, never an answer — `default` is dropped along with the rest of the
          // form payload, and a secret input has none by schema. Present only when the pack
          // asks for something, so the field's presence means something.
          ...(pack.inputs?.length
            ? {
                inputs: pack.inputs.map((input) => ({
                  name: input.name,
                  label: input.label,
                  required: input.required === true,
                  secret: input.secret === true,
                })),
              }
            : {}),
        })),
      }
    },
  },

  {
    /**
     * THE SAVED-KEY CATALOGUE, and it is `list_offerings`' argument applied a third time (#360).
     *
     * `create_server` gained `ssh_key_name` in the same change, and a parameter whose values an
     * agent cannot learn is the defect rockysurf-oeay named for `offering_id` and #278 named
     * again for `pack_id`: usable only by an agent a human had already briefed. The house answer
     * both times was a read tool over the route the SPA's own picker reads, and this is that
     * answer a third time rather than a new mechanism.
     *
     * WHY NOT THE NAMES IN `create_server`'S DESCRIPTION, which was the cheaper option on the
     * table. A description is composed once, when the client connects, and cached by it for the
     * session — so a key saved afterwards would be invisible until the human restarted their
     * agent, and a name removed afterwards would go on being advertised. An agent told by a
     * stale description to use a key that is no longer saved gets the unknown-name refusal
     * below, which is #355's failure mode wearing a different hat: the roster would be the
     * thing that misled it. A tool call is read fresh, every time, from the same function the
     * form reads.
     *
     * NAMES ONLY, where `list_offerings` passes core's object straight through. A public key is
     * published material and this route is deliberately not admin-only, so withholding the
     * bodies protects nothing — the reason is the two other ones. An agent choosing between
     * saved keys is choosing between their names, which is the whole of what the human says out
     * loud ("use rockysurf-mac"); and the key lines are ~100 characters each of context that
     * decides nothing, on a tool an agent may call before every create. It also keeps
     * SECURITY.md's "no tool result contains key material" sentence true without a footnote
     * about which half.
     *
     * Read scope, for `list_offerings`' reason in full: it spends nothing, changes nothing, and
     * discloses a list of names the operator typed into their own settings page.
     */
    name: 'list_ssh_keys',
    title: 'List the SSH public keys saved by name',
    description:
      'The names of the SSH public keys the human saved under Settings → SSH public keys. Use ' +
      'it to pick an ssh_key_name for create_server — "use my usual key" is answered from this ' +
      'list, and a name that is not on it is refused rather than quietly creating a box without ' +
      'the key. Names only: the key bodies are not returned, because choosing between saved ' +
      'keys is choosing between their names. An empty list means this installation has saved ' +
      'none, which is the common case — a key can still be passed verbatim to create_server as ' +
      'ssh_public_key.',
    scope: 'read',
    inputSchema: z.strictObject({}),
    run: async (_args, { client }) => {
      const keys = await savedSshKeys(client)
      return { sshKeyNames: keys.map((key) => key.name) }
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
      'Stop a running server, preserving its disk. Reversible — start_server brings it back as ' +
      'it was, and so does the web UI. Stopping is the cheap way to pause spend without losing ' +
      'work.',
    scope: 'stop',
    inputSchema: serverIdSchema,
    run: async (args, { client }) => {
      const server = await client.post<unknown>(`/api/v1/servers/${String(args['server_id'])}/stop`)
      return { server, ...(await costContext(client)) }
    },
  },

  {
    /**
     * THE OTHER HALF OF `stop_server` (#278).
     *
     * `stop_server`'s own description called the stop reversible — "start it again from the web
     * UI" — which is an accurate sentence and a broken loop: an agent that stopped a box
     * overnight to save money had to wake a human to get it back. The route has existed since
     * before the MCP server did (`POST /api/v1/servers/:serverId/start`) and already serves the
     * SPA and the CLI; this is the same thin translation `stop_server` is.
     *
     * THE SCOPE IS `stop`, WHICH IS A DECISION AND NOT AN OVERSIGHT. Three options were on the
     * table — `stop`, `create`, or a new `start` scope — and `stop` makes the pair symmetric:
     * the scope that lets an agent pause spend is the scope that lets it resume what it paused.
     * `create` would have read as "resuming is initiating", which is a different claim about a
     * machine that already exists, already counts against `limits.maxServers`, and was
     * authorised by whoever created it. A new scope would be a fourth knob for an operator to
     * reason about, buying separation between two halves of one action.
     *
     * WHAT THAT WIDENS, STATED PLAINLY, because SECURITY.md's blast-radius paragraph has to
     * stay true: an agent holding the DEFAULT scopes can now restart a box a human deliberately
     * stopped, and hourly billing resumes. It is bounded by the fleet that already exists — this
     * creates nothing — but it is not bounded by `limits.spendCap`, which core enforces on the
     * create path only (`checkLimits` is called from `lifecycle.create` and nowhere else). The
     * spend is still MEASURED, and every result here carries the cap reading, so an agent over
     * its cap can see that it is; it is not refused by one.
     */
    name: 'start_server',
    title: 'Start a stopped server',
    description:
      'Start a server that was stopped, with its disk exactly as it was left — the other half ' +
      'of stop_server, so a box paused to save money can be resumed without waking a human. ' +
      'Hourly billing resumes. Refused, with a reason, unless the server is stopped: a box ' +
      'that is still stopping, or already coming up, has to settle first. Starting does not ' +
      'create anything, so it cannot exceed the server limit — but note that the monthly spend ' +
      'cap refuses creates, not starts, so check the spend context on this result rather than ' +
      'assuming a cap will stop you.',
    scope: 'stop',
    inputSchema: serverIdSchema,
    run: async (args, { client }) => {
      const server = await client.post<unknown>(`/api/v1/servers/${String(args['server_id'])}/start`)
      return { server, ...(await costContext(client)) }
    },
  },

  {
    name: 'create_server',
    title: 'Create a server',
    description:
      'Create a new dev box. Subject to the configured limits — maximum servers, creates per ' +
      'hour, and the monthly spend cap — all enforced by the control plane, which will refuse ' +
      'with a reason rather than silently succeeding. To authorize the human\'s own SSH key on ' +
      'the box, pass ssh_key_name (a key they saved by name — list_ssh_keys enumerates them) or ' +
      'ssh_public_key (the key itself). Omit both and the box authorizes only Rocky Surf\'s own ' +
      'managed key, which a human downloads from the web UI to log in.',
    scope: 'create',
    inputSchema: z.strictObject({
      name: z.string().min(1).optional().describe('A name for the server. One is generated if omitted.'),
      size: z
        .enum(['small', 'medium', 'large'])
        .optional()
        .describe(
          'How big a machine, as a floor rather than an exact type: small is at least 2 vCPU and ' +
            '2 GB, medium at least 2 and 4, large at least 4 and 8. The control plane picks the ' +
            'cheapest machine the chosen cloud sells that meets it, and refuses — naming the ' +
            'shortfall — rather than quietly handing back a smaller one. If the human has saved ' +
            'a favourite type for this size on this cloud, that one is used instead, and the ' +
            'result carries a sizeNote when a saved type could not be used. Defaults to small ' +
            'when offering_id is also omitted; omit this and name offering_id instead to ask ' +
            'for a specific machine type rather than a floor.',
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
      /**
       * THE HUMAN'S OWN KEY, WHICH THIS TOOL COULD NOT ASK FOR AT ALL UNTIL NOW (#360).
       *
       * The capability ran end to end in core the whole time — stored on the row, appended to
       * `authorized_keys`, and core's own managed key retired afterwards — and the SPA has
       * offered it since #302. This schema simply had no word for it, so an MCP-created box came
       * up authorized for core's key alone. That still WORKS, through the key download in the
       * web UI, which is exactly why it read as a bug rather than announcing itself.
       *
       * TWO PARAMETERS FOR ONE FIELD, deliberately, and they are the SPA's two controls: a
       * picker over the saved list, and a paste box. Both resolve to the single `sshPublicKey`
       * the New Server page posts, so the wire shape, the validation and the row are one path
       * with no MCP-specific branch anywhere in core. The name is resolved HERE and the KEY goes
       * on the wire — never the name — for #302's reason: a server stays answerable to the key
       * it actually authorized, and editing the settings list later cannot rewrite that.
       *
       * NO PARSING IN THIS FILE. `normalizeUserPublicKey` runs in `lifecycle.create`, before the
       * row is written, and its refusal — including the one that names a pasted PRIVATE key
       * first and by name — comes back as a 400 this layer passes through with its code intact.
       * A second validator here is exactly the parallel path the #348 review said this server
       * must not grow.
       *
       * PUBLIC HALVES ARE NOT A CUSTODY PROBLEM. A public key is published material, handed to
       * a cloud provider in the clear on every create (SECURITY.md), so unlike `rdp_password`
       * above there is nothing here to weigh against the agent's transcript.
       */
      ssh_key_name: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Authorize a key the human saved by name under Settings → SSH public keys — the ' +
            'answer to "use my usual key". Call list_ssh_keys for the names. A name that is not ' +
            'saved is refused, naming the ones that are, and nothing is created. Use ' +
            'ssh_public_key instead for a key that is not saved; naming both is refused.',
        ),
      ssh_public_key: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Authorize a public key given verbatim — one `authorized_keys` line, the contents of ' +
            'a `.pub` file. Passed to the control plane exactly as given and parsed there, which ' +
            'refuses a PRIVATE key by name before it complains about anything else. Prefer ' +
            'ssh_key_name when the key is already saved.',
        ),
    }),
    run: async (args, { client }) => {
      const packId = args['pack_id'] ? String(args['pack_id']) : undefined
      const rdpPassword = args['rdp_password'] ? String(args['rdp_password']) : undefined
      const keyName = args['ssh_key_name'] ? String(args['ssh_key_name']) : undefined
      const verbatimKey = args['ssh_public_key'] ? String(args['ssh_public_key']) : undefined

      // Both named is a caller that does not know which key it wants, and picking one for it
      // would authorize a key nobody chose. Refused rather than resolved by precedence, and
      // refused first, so a create that could go either way never reaches a provider.
      if (keyName && verbatimKey) {
        throw new Error(
          'create_server takes ssh_key_name OR ssh_public_key, not both — they are two ways to ' +
            'name one key and there is no way to tell which was meant. Pass the saved name if ' +
            'the key is saved (list_ssh_keys shows them), otherwise the key itself. Nothing was ' +
            'created.',
        )
      }

      /**
       * THE SAVED NAME, RESOLVED HERE, AND A MISS IS A REFUSAL (#360, the #355 lesson).
       *
       * An unknown name could be dropped and the create allowed through — the UI treats the key
       * as optional, after all — and that is precisely the failure this issue was filed about:
       * a box that comes up without the key still works, so a silent miss reads as a bug in the
       * product rather than a typo in the argument. So it refuses, and the refusal NAMES the
       * saved keys, because "no such key" with no list is a dead end for an agent that has no
       * screen to go and look at.
       *
       * A read failure here is deliberately NOT swallowed: an unreadable list with a name to
       * resolve means the key cannot be honored, and dropping it silently is the whole bug.
       * The route's own error comes back through `runTool`'s `CoreApiError` handling intact.
       */
      let suppliedKey = verbatimKey
      let sshKeyNote: string | undefined
      if (keyName) {
        const saved = await savedSshKeys(client)
        const found = saved.find((key) => key.name === keyName)
        if (!found) {
          throw new Error(
            saved.length
              ? `no SSH public key called "${keyName}" is saved on this installation. Saved keys: ` +
                `${saved.map((key) => key.name).join(', ')}. Pass one of those as ssh_key_name, or ` +
                'pass the key itself as ssh_public_key. Nothing was created.'
              : `no SSH public key called "${keyName}" is saved on this installation — it has ` +
                'saved none at all, so Settings → SSH public keys is empty and there is no name ' +
                'to use. Pass the key itself as ssh_public_key, or ask the human to save it by ' +
                'name first. Nothing was created.',
          )
        }
        // The KEY on the wire, never the name (#302).
        suppliedKey = found.publicKey
      } else if (!verbatimKey) {
        /**
         * NEITHER PARAMETER GIVEN, AND SAVED KEYS EXIST: a note on the result, not a refusal
         * and not a warning (design question 4 of #360, decided here).
         *
         * The UI's optionality is real and stays — a box with core's managed key alone is a
         * legitimate create, and refusing one would break a thing that works. But the UI's
         * reason for staying silent does not carry over: a human omitting the key has just
         * LOOKED at a picker with their own key names in it and decided against it, and an
         * agent has no equivalent glance. Omission by an agent is far more often ignorance of
         * the parameter than a decision about it — which is how this issue got filed.
         *
         * So the result says what happened and what was available, once, after the fact. It
         * cannot fail a create: the read is swallowed, exactly as `costContext` swallows its
         * own, because losing a note must never cost a machine.
         */
        const saved = await savedSshKeys(client).catch(() => [] as SavedSshKeyRow[])
        if (saved.length > 0) {
          sshKeyNote =
            'No SSH public key was requested, so this box authorizes only Rocky Surf\'s own ' +
            'managed key — logging in means a human downloading that key from the web UI. This ' +
            `installation has keys saved by name (${saved.map((key) => key.name).join(', ')}); ` +
            'pass one as ssh_key_name to authorize it as well. Nothing is wrong if that was ' +
            'intended — the key is optional here exactly as it is on the web form.'
        }
      }

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
        /**
         * `small` is the default ONLY when nothing else names a machine (rockysurf-kh3u).
         *
         * The schema used to default `size` to `'small'` unconditionally, so an agent that
         * named `offering_id` alone still sent a `size` the control plane would derive
         * `'custom'` for anyway — harmless, but it made `'custom'` unreachable from this tool.
         * An explicit `size` still wins outright.
         */
        ...(args['size'] ? { size: args['size'] } : args['offering_id'] ? {} : { size: 'small' }),
        ...(args['arch'] ? { arch: args['arch'] } : {}),
        ...(args['offering_id'] ? { offeringId: args['offering_id'] } : {}),
        ...(packId ? { packId } : {}),
        ...(args['repositories'] ? { repositories: args['repositories'] } : {}),
        ...(args['create_anyway'] ? { createAnyway: true } : {}),
        ...(args['provider'] ? { provider: args['provider'] } : {}),
        ...(rdpPassword ? { rdpPassword } : {}),
        // The same field the New Server page posts, whichever parameter named the key — one
        // wire shape, one validator, one column (#302, #360).
        ...(suppliedKey ? { sshPublicKey: suppliedKey } : {}),
      })
      return { server, ...(sshKeyNote ? { sshKeyNote } : {}), ...(await costContext(client)) }
    },
  },

  {
    name: 'terminate_server',
    title: 'Terminate a server',
    description:
      'Destroy a server and its disk. IRREVERSIBLE — anything not committed and pushed is ' +
      'lost. Requires a scope granted separately from create. Safe to retry: terminating a ' +
      'server that is already terminated succeeds rather than reporting a conflict.',
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
 * One tool's description, TOLD WHAT THIS INSTALLATION WITHHELD (#353).
 *
 * THE BUG THIS FIXES IS A DOCUMENTATION BUG WITH A RUNTIME CAUSE. `create_server` has always
 * been implemented, on the `create` scope, which is opt-in — so on a default `[read, stop]`
 * installation `visibleTools` drops it. That much is deliberate and stays. What was not
 * deliberate is that the tools that DO survive that grant go on NAMING it: `list_packs` says
 * "use it to pick a pack_id for create_server", `list_offerings` says "pick an offering_id for
 * create_server", and `list_providers` points at it for prices. An agent reading that roster
 * sees a server documented around a tool it does not ship, and the only conclusion available to
 * it is "registration bug" — which is exactly what the owner's agent concluded, in #353, twice
 * confirmed and wrongly.
 *
 * SILENCE IS THE PART THAT MISLEADS, NOT THE ABSENCE. `server.ts` argues that a tool an agent
 * cannot call should not be dangled in front of it, and that argument is untouched here: no
 * withheld tool is added to the listing, and nothing about the gate changes. This makes the
 * REASON for the absence visible in the roster the agent already reads, at roster time, before
 * a call is spent finding out — so "not offered here" reads as an operator's setting with a
 * named way to change it, rather than as a missing feature to report.
 *
 * Derived from the description text rather than hand-maintained per tool, so a future tool that
 * mentions a scope-gated one inherits the note instead of re-acquiring the bug.
 */
export function describeTool(tool: McpToolDefinition, scopes: readonly McpScope[]): string {
  const withheld = MCP_TOOLS.filter(
    (other) =>
      other.name !== tool.name &&
      !scopes.includes(other.scope) &&
      tool.description.includes(other.name),
  )
  if (withheld.length === 0) return tool.description

  const notes = withheld.map(
    (other) =>
      `${other.name} is named above but is NOT offered by this installation: it needs the ` +
      `"${other.scope}" MCP scope, which an operator grants deliberately in mcp.scopes in ` +
      `rockysurf.config.yaml (Settings → MCP in the web UI), after which this MCP client has ` +
      `to reconnect to see it. That is a setting, not a missing tool and not a bug to report — ` +
      `ask the human to grant the scope, or do that step from the web UI instead.`,
  )
  return `${tool.description}\n\nSCOPE NOTE: ${notes.join(' ')}`
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
