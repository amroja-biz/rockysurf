import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'

/**
 * The shape of `rockysurf.config.yaml`, as a zod v4 schema.
 *
 * Two conventions run through the whole file:
 *
 *  - **Every object is strict.** A typo like `porrt: 3000` must be an error at boot, not a
 *    silently-ignored key and a server on the wrong port. This is what makes the
 *    "unknown key" acceptance criterion real.
 *  - **Every section goes through `section()`**, so an omitted section, `section: {}`, and a
 *    bare `section:` with its children commented out all mean "use the defaults".
 *
 * DEPENDENCY NOTE (rockysurf-gonw.4): the provider sections are defined here, in core, rather
 * than imported from each provider package. `scripts/check-core-deps.mjs` forbids core from
 * importing a concrete provider, and `@rockysurf/provider-sdk` is types-only with zero runtime
 * dependencies, so it cannot export a zod schema either. The bead text called for "that
 * provider's exported zod schema"; that is not reachable without either breaking the dependency
 * rule or giving the SDK a runtime dependency on zod. Recorded as friction for whoever revisits
 * provider config validation — the natural fix is a `configSchema` exported by each provider
 * and handed to core at registration time, once providers are loaded through configuration
 * rather than named statically.
 */

/** `~` and `~/…` expand against the current user's home directory. `~user` is not supported. */
export function expandTilde(input: string, home: string = homedir()): string {
  if (input === '~') return home
  if (input.startsWith('~/')) return join(home, input.slice(2))
  return input
}

/** Expand `~`, then make relative paths absolute against `base`. */
function toAbsolutePath(input: string, base: string = process.cwd()): string {
  const expanded = expandTilde(input)
  return isAbsolute(expanded) ? expanded : resolve(base, expanded)
}

/**
 * A config section that may be omitted, written as `{}`, or — the case that bites in a
 * commented-up example file — written as a bare `section:` whose every child is commented out,
 * which YAML parses as `null`. All three mean "use the defaults".
 *
 * Neither zod default covers that on its own: `.prefault({})` handles `undefined` but not
 * `null`, and `.default({})` handles neither properly, because in zod v4 `.default()`
 * short-circuits and hands back the literal value — so the inner field defaults would never
 * materialize and `limits.maxServers` would be `undefined` at runtime.
 */
function section<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === null || value === undefined ? {} : value), schema)
}

const serverSchema = section(
  z.strictObject({
    port: z.coerce.number().int().min(1).max(65535).default(3000),
    /**
     * Which interface the HTTP listener binds (rockysurf-pii7).
     *
     * LOOPBACK BY DEFAULT, and the default is the security decision. This process holds every
     * provider credential and the SSH private key for every server it manages; binding it to
     * `0.0.0.0` because that is what a web framework does by default hands the login form and
     * the `/internal` callback routes to the whole LAN without the operator ever choosing
     * that. Widening it is one line, and it should be a line someone wrote on purpose.
     *
     * `0.0.0.0` (or `::`) is the correct value INSIDE A CONTAINER, where loopback is the
     * container's own and the port would be unreachable from the host. `docker/
     * rockysurf.config.yaml` sets it explicitly for exactly that reason, and compose still
     * publishes on the host's loopback — the network boundary stays where an operator can see
     * it.
     *
     * Not validated beyond "non-empty": any hostname or address the OS can resolve is legal,
     * and a bad one fails loudly at `listen()` with the address in the message.
     */
    host: z.string().trim().min(1).default('127.0.0.1'),
    /** Only needed for callback-mode bootstrap, which requires a core the box can reach. */
    publicUrl: z.url().optional(),
    dataDir: z
      .string()
      .trim()
      .min(1)
      .default('~/.rockysurf')
      .transform((v) => toAbsolutePath(v)),
  }),
)

const authSchema = section(
  z.strictObject({
    mode: z.enum(['local', 'github-device']).default('local'),
  }),
)

const githubSchema = section(
  z.strictObject({
    /** Personal access token for cloning private repos. Prefer `${GITHUB_PAT}` over a literal. */
    pat: z.string().min(1).optional(),
  }),
)

const awsProviderSchema = section(
  z.strictObject({
    enabled: z.boolean().default(false),
    region: z.string().trim().min(1).default('us-east-1'),
    /** Named profile from the shared credentials file. Omit for the default AWS chain. */
    profile: z.string().trim().min(1).optional(),
    /**
     * Who may reach SSH on the shared security group, e.g. `203.0.113.4/32`.
     *
     * Named here because the AWS provider REQUIRES it with no default — deliberately, since a
     * firewall rule is a security decision that should be reviewed rather than inferred at
     * runtime. It was missing from this section until rockysurf-55fx.12, which meant AWS could
     * not be configured from this file at all: the provider's own schema rejected every
     * section core could produce. Optional here so the provider's own error is what an
     * operator sees, in the provider's own words, rather than a duplicate rule drifting from it.
     */
    sshAllowedCidr: z.string().trim().min(1).optional(),
    /** Optional allowlist of instance types offered to users. Omit to offer everything. */
    sizes: z.array(z.string().trim().min(1)).nonempty().optional(),
  }),
)

const hetznerProviderSchema = section(
  z
    .strictObject({
      enabled: z.boolean().default(false),
      token: z.string().min(1).optional(),
      location: z.string().trim().min(1).default('fsn1'),
    })
    // NO enabled-implies-token REFINE (rockysurf-55fx.12).
    //
    // It used to reject `enabled: true` without a token, which read as helpful and was
    // actually a trap: the first-run wizard stores credentials in the ENCRYPTED SECRETS STORE,
    // and the schema cannot see that store. So there was no legal way to express the state the
    // wizard creates — "this provider is on, and its credential lives somewhere the config
    // file does not name" — and a user who pasted a token could never enable the provider.
    //
    // Resolution now happens where both sources are visible: the composition root reads the
    // config first, then the secrets store, and reports a MISSING credential at boot with a
    // message naming both places. A schema-level check could only ever see half the picture.
)

/**
 * One pre-existing machine reachable over SSH. BYO is push-only by construction — a box with no
 * user-data cannot be told anything before boot — so a host is identified by where to connect
 * and as whom. `fingerprint` is optional because BYO records it on first connect when it is not
 * supplied; supplying it turns trust-on-first-use into strict verification.
 *
 * The authoritative shape lands with `@rockysurf/provider-byo`; this is the minimum core needs
 * in order to validate a config file today.
 */
const byoHostSchema = z.strictObject({
  name: z.string().trim().min(1),
  host: z.string().trim().min(1),
  user: z.string().trim().min(1).default('root'),
  port: z.coerce.number().int().min(1).max(65535).default(22),
  fingerprint: z.string().trim().min(1).optional(),
  /**
   * Path to the private key the provider claims this host with. Falls back to the section-level
   * `identityFile`, then to the SSH agent named by `SSH_AUTH_SOCK`.
   *
   * A PATH, never key material: the key stays where the operator's own SSH already keeps it, and
   * nothing copies it into a config file or the database.
   */
  identityFile: z.string().trim().min(1).optional(),
})

const byoProviderSchema = section(
  z
    .strictObject({
      enabled: z.boolean().default(false),
      /** Default private key for every host that does not name its own. */
      identityFile: z.string().trim().min(1).optional(),
      hosts: z
        .array(byoHostSchema)
        .default([])
        // `hosts:` with every entry commented out parses as null, same trap as a section.
        .or(z.null().transform(() => [] as z.output<typeof byoHostSchema>[])),
    })
    .refine((v) => !v.enabled || v.hosts.length > 0, {
      path: ['hosts'],
      error: 'byo is enabled but no hosts are listed',
    }),
)

const providersSchema = section(
  z.strictObject({
    aws: awsProviderSchema,
    hetzner: hetznerProviderSchema,
    byo: byoProviderSchema,
  }),
)

/**
 * Spend cap as `{ amount, currency }` rather than a bare USD number, matching ADR-0003
 * amendment B2: a provider that quotes in EUR cannot honestly report a USD-shaped figure.
 */
const spendCapSchema = z.strictObject({
  amount: z.coerce.number().nonnegative(),
  currency: z
    .string()
    .trim()
    .length(3, { error: 'currency must be a 3-letter ISO 4217 code, e.g. USD or EUR' })
    .transform((v) => v.toUpperCase()),
})

/**
 * MCP server scopes (rockysurf-ftl9.1).
 *
 * THE HIGHEST-BLAST-RADIUS FEATURE IN v0.1, so its permissions are configuration an operator
 * reviews in a file rather than a flag buried in a client's launch command. `create` and
 * `terminate` are each opt-in and separate, because "give your agent a budget-capped credit
 * card" must never silently include "and a flamethrower": destroying a box an agent is
 * mid-task on is not the same risk as making one, and one is not recoverable.
 */
const mcpSchema = section(
  z.strictObject({
    /**
     * What an MCP client may do. `read` covers list/get/ssh-command and is the default;
     * `stop` is reversible so it rides with read; `create` and `terminate` are separate.
     */
    scopes: z
      .array(z.enum(['read', 'stop', 'create', 'terminate']))
      .default(['read', 'stop']),
  }),
)

const limitsSchema = section(
  z.strictObject({
    maxServers: z.coerce.number().int().positive().default(5),
    spendCap: spendCapSchema.optional(),
    /** Blunts terminate-and-recreate loops, especially from the MCP server. */
    createRatePerHour: z.coerce.number().int().positive().default(4),
  }),
)

export const configSchema = section(
  z.strictObject({
    server: serverSchema,
    auth: authSchema,
    github: githubSchema,
    providers: providersSchema,
    limits: limitsSchema,
    mcp: mcpSchema,
  }),
)

export type Config = z.output<typeof configSchema>
export type ServerConfig = Config['server']
export type ProvidersConfig = Config['providers']
export type LimitsConfig = Config['limits']
export type McpConfig = Config['mcp']
export type McpScope = McpConfig['scopes'][number]
export type ByoHost = Config['providers']['byo']['hosts'][number]
