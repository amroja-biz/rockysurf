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

/**
 * One entry of `github.tokens` — a PAT and the repositories it is allowed to open
 * (rockysurf-ta7g).
 *
 * THE SCOPE FIELDS ARE CHARACTER-RESTRICTED, and that is a safety rule rather than pedantry.
 * They travel to the box inside `secrets.env`, which the agent loads with `set -a; . file`,
 * so a value containing a space or a quote would not be a bad match — it would be a broken
 * shell source that takes every other secret down with it. The permitted sets are what GitHub
 * itself permits anyway (a port is allowed on `host` for a self-hosted forge), so the rule
 * costs nothing an operator would otherwise have written.
 *
 * LOWERCASED HERE so the box never has to decide. Hosts, owners and repository names are
 * case-insensitive on GitHub, and a clone URL written `github.com/Acme/Widgets` must match an
 * entry written `acme/widgets`. The helper lowercases what git hands it; normalising this end
 * at parse time is what makes the two comparable.
 */
const githubTokenSchema = z
  .strictObject({
    /** Defaults to `github.com`. Set it for a self-hosted forge, with a port if it uses one. */
    host: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9.:-]+$/, 'host may contain only letters, digits, dot, colon and dash')
      .optional(),
    /** The account or organisation, e.g. `acme`. */
    owner: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]+$/, 'owner may contain only letters, digits, dot, underscore and dash')
      .optional(),
    /**
     * A single repository under `owner`, without the `.git` suffix — or the whole thing as
     * `owner/name` in one string, which `splitOwnerSlashRepo` below has already split by the
     * time this rule sees it.
     */
    repo: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]+$/, 'repo may contain only letters, digits, dot, underscore and dash')
      .optional(),
    /** The token this scope uses. Prefer `${SOME_PAT}` over a literal. */
    pat: z.string().min(1),
  })
  // `repo` without `owner` would be "any repository called widgets, anywhere", which is not a
  // thing anyone means; and an entry with no scope at all is `github.pat` written in a longer
  // way, so it is refused rather than silently ranked above the fallback it duplicates.
  .refine((v) => !(v.repo && !v.owner), {
    message: 'repo requires owner — a repository name alone matches nothing',
    path: ['owner'],
  })
  .refine((v) => Boolean(v.host ?? v.owner ?? v.repo), {
    message: 'an entry with no host, owner or repo is the instance-wide token — write it as github.pat',
    path: ['owner'],
  })
  .transform((v) => ({
    ...v,
    ...(v.host ? { host: v.host.toLowerCase() } : {}),
    ...(v.owner ? { owner: v.owner.toLowerCase() } : {}),
    ...(v.repo ? { repo: v.repo.toLowerCase() } : {}),
  }))

/**
 * `repo: "acme/widgets"` written as one string, split into `owner` + `repo` before anything
 * else looks at the entry (rockysurf-ly2n).
 *
 * PARSE-TIME SUGAR AND NOTHING MORE — which is the whole point. It runs ahead of the object
 * schema above, so the two halves go through the very same `owner` and `repo` rules as the
 * split form: the same character sets, the same lowercasing, the same "repo requires owner"
 * (an entry with no slash is not touched here and still needs its `owner` line), the same
 * refusal of two entries covering one scope, the same secrets encoding, the same helper.
 * Nothing downstream can tell which way an entry was written, so
 * `{ repo: "acme/widgets" }` and `{ owner: acme, repo: widgets }` are not
 * merely equivalent — they are the same entry, and writing both is the duplicate this list
 * already refuses.
 *
 * The two ways to get it wrong are caught here rather than downstream, because this is the
 * last place that still has the operator's own text to quote back at them.
 */
function splitOwnerSlashRepo(entry: unknown, ctx: z.core.$RefinementCtx): unknown {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry
  const { owner, repo } = entry as { owner?: unknown; repo?: unknown }
  if (typeof repo !== 'string' || !repo.includes('/')) return entry

  const parts = repo.trim().split('/')
  if (parts.length !== 2) {
    ctx.addIssue({
      code: 'custom',
      input: entry,
      path: ['repo'],
      message: `repo "${repo}" is not a repository — the one-string form is exactly one slash, as owner/name`,
    })
    return entry
  }

  const [slashOwner, slashRepo] = parts
  // A bare `owner:` line parses as null, which names no account and is not a second reading —
  // the slash form simply fills it in.
  if (owner !== undefined && owner !== null) {
    // Both readings are spelled out because only the operator knows which they meant, and a
    // config that names two different owners for one token is not a thing to guess about.
    ctx.addIssue({
      code: 'custom',
      input: entry,
      path: ['repo'],
      message:
        `repo "${repo}" already names an owner, and owner: ${String(owner)} names another — ` +
        `write repo: "${repo}" with no owner to mean ${slashOwner}/${slashRepo}, ` +
        `or owner: ${String(owner)} with repo: ${slashRepo} to mean ${String(owner)}/${slashRepo}`,
    })
    return entry
  }

  return { ...entry, owner: slashOwner, repo: slashRepo }
}

/** An entry of `github.tokens`, in either the split form or the `owner/name` one (ly2n). */
const githubTokenEntrySchema = z.preprocess(splitOwnerSlashRepo, githubTokenSchema)

/**
 * The OAuth App the "Connect GitHub" button runs its device flow against (rockysurf-7fyf.1).
 *
 * THE CLIENT ID IS PUBLIC, which is why it is an ordinary string in a plaintext file rather
 * than a credential with a custody story. The device flow needs no `client_secret` — GitHub's
 * own error taxonomy documents `incorrect_client_credentials` as "client_secret not needed" —
 * so there is nothing here an attacker who reads the file gains: they can start a device flow
 * that only the account holder, typing a code on github.com, can ever complete.
 *
 * NO DEFAULT, deliberately. Rocky Surf could ship a public client id for an app it owns, the
 * way `gh` does, and that was rejected: it would make every self-hosted installation depend on
 * an app registration a third party controls, with tokens that third party could revoke and an
 * authorize screen naming an organisation the operator has no relationship with — in a product
 * whose whole design (ADR-0001) is "runs on your box, phones nobody". Shipping an official app
 * later is a `.default()` on this one line; unwinding one is not. See ADR-0007.
 */
const githubOauthSchema = section(
  z.strictObject({
    /** From an OAuth App with "Enable Device Flow" ticked. Public — safe to commit. */
    clientId: z.string().trim().min(1).optional(),
  }),
)

const githubSchema = section(
  z.strictObject({
    /** Personal access token for cloning private repos. Prefer `${GITHUB_PAT}` over a literal. */
    pat: z.string().min(1).optional(),
    oauth: githubOauthSchema,
    /**
     * Per-repository tokens, most-specific match wins (rockysurf-ta7g).
     *
     * `pat` above stays the instance-wide fallback, used for anything no entry matches — which
     * is what keeps every existing config working unchanged. Fine-grained PATs are issued per
     * repository, so a self-hoster who follows GitHub's own advice ends up holding several, and
     * one `pat:` line cannot express that.
     *
     * The easy way to write an entry is `repo: "acme/widgets"`, which is the way a repository
     * is named everywhere else; the split `owner:`/`repo:` form is the same entry (ly2n).
     */
    tokens: z
      .array(githubTokenEntrySchema)
      // Two entries for the same scope is the one mistake this list makes easy: precedence is
      // by specificity, so a duplicate ties, the tie is broken by file order, and the second
      // token is simply never used. Rotating by pasting a new entry above the old one would
      // then appear to do nothing. Refused by name instead, in the same spirit as the strict
      // objects above.
      .refine(
        (entries) => {
          const scopes = entries.map((e) => `${e.host ?? 'github.com'}/${e.owner ?? '*'}/${e.repo ?? '*'}`)
          return new Set(scopes).size === scopes.length
        },
        { message: 'two entries cover the same host/owner/repo — only the first would ever be used' },
      )
      .default([]),
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
    /**
     * Required alongside `sshAllowedCidr: 0.0.0.0/0` — opening SSH to the internet is two
     * decisions, enforced by the provider's own schema. Missing from this section until
     * rockysurf-p5jr: core's strictObject rejected the exact line SECURITY.md, the provider
     * doc and the example config all tell operators to write, so there was no legal way to
     * express 0.0.0.0/0 at all. Optional here so the provider's own two-decisions message is
     * what an operator sees.
     */
    allowAllCidr: z.boolean().optional(),
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
      /**
       * The numeric project id, used for one thing: linking a server to its page in the Hetzner
       * Console (ADR-0003, E16). The Cloud API never reports it, so it can only be configured,
       * and without it there is simply no link — never a guessed one.
       *
       * Declared here as well as in the provider package for the reason recorded at the top of
       * this section: core validates the config file, and the dependency lint forbids it from
       * importing the provider's own schema to do it.
       */
      consoleProjectId: z.coerce.number().int().positive().optional(),
      /** Optional allowlist of server types offered to users. Omit to offer everything. */
      sizes: z.array(z.string().trim().min(1)).nonempty().optional(),
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

const azureProviderSchema = section(
  z.strictObject({
    enabled: z.boolean().default(false),

    /** The subscription every resource is created in. The provider requires it with no default. */
    subscriptionId: z.string().trim().min(1).optional(),

    /**
     * The ONE resource group this provider owns, which you create and Rocky Surf does not:
     * `az group create --name rocky-surf-rg --location eastus`.
     *
     * A provider that creates its own scope cannot be granted a role scoped to it, and the
     * published Azure role is granted at exactly this group — see docs/providers/azure.md.
     */
    resourceGroup: z.string().trim().min(1).optional(),

    location: z.string().trim().min(1).default('eastus'),

    /**
     * Who may reach SSH on the shared network security group, e.g. `203.0.113.4/32`.
     *
     * Named here because the Azure provider REQUIRES it with no default, for the same reason the
     * AWS provider does. Optional at THIS level so the provider's own error is what an operator
     * sees, in the provider's own words, rather than a duplicate rule drifting from it.
     */
    sshAllowedCidr: z.string().trim().min(1).optional(),

    /**
     * Required alongside `sshAllowedCidr: 0.0.0.0/0` — the same two-decisions rule, enforced by
     * the provider's own schema. Declared for the reason recorded on the aws section
     * (rockysurf-p5jr): a field missing here is not undocumented, it is unusable.
     */
    allowAllCidr: z.boolean().optional(),

    /**
     * Whether the credential chain may fall back to `az account get-access-token`.
     *
     * Declared here for the SAME reason as `allowAllCidr` directly above, and it is worth noting
     * that the lesson had to be learned twice: docs/providers/azure.md tells an operator to
     * harden a server with `allowAzureCli: false`, and until rockysurf-ihtq.8 ran for real this
     * strict object rejected the key, so the documented hardening was unusable. A field missing
     * here is not undocumented, it is unusable — and this one is a trust boundary, so the
     * failure mode was a control plane silently keeping a wider credential source than the
     * operator believed they had turned off.
     */
    allowAzureCli: z.boolean().optional(),

    /** Optional allowlist of VM sizes offered to users. Omit to offer everything. */
    sizes: z.array(z.string().trim().min(1)).nonempty().optional(),
  }),
  // NO enabled-implies-credential REFINE, for the reason recorded on the Hetzner section — and
  // doubly so here, because an Azure credential may be a MANAGED IDENTITY, which appears in no
  // file and no environment variable. A schema-level check could only ever see part of the
  // picture; the composition root resolves it where every source is visible.
)

/**
 * Google Compute Engine (`@rockysurf/provider-gcp`).
 *
 * EVERY FIELD THE PROVIDER ACCEPTS IS DECLARED HERE, including the ones with defaults, and that
 * completeness is the point rather than thoroughness for its own sake. This section is a
 * `strictObject` and it is what validates the operator's file, so a provider field missing from
 * this list is not merely undocumented — it is UNUSABLE, and the operator's error names an
 * unrecognized key rather than the real problem. That is `rockysurf-p5jr` on the AWS section,
 * where a missing `allowAllCidr` made the one procedure three documents describe impossible to
 * express. Declared preventively here so the GCP section never has that shape.
 *
 * Fields are optional here even when the provider requires them, so that the provider's own
 * worded refusal is what an operator sees rather than a duplicate rule drifting from it. The
 * exception is nothing: even `projectId`, which the provider requires, is optional at this
 * layer for exactly that reason.
 */
const gcpProviderSchema = section(
  z.strictObject({
    enabled: z.boolean().default(false),
    /** The project every resource lives in. The provider requires it; there is no default. */
    projectId: z.string().trim().min(1).optional(),
    /**
     * The single zone this provider manages.
     *
     * `us-central1-a` rather than `-c` is deliberate on the provider side: arm64 (Tau T2A)
     * exists in only eight zones and `us-central1-c` is not one of them.
     */
    zone: z.string().trim().min(1).default('us-central1-a'),
    /**
     * Path to a service-account key file. A PATH, never key material.
     *
     * Omit it and the provider uses Application Default Credentials, which is the recommended
     * path: `gcloud auth application-default login`, `GOOGLE_APPLICATION_CREDENTIALS`, workload
     * identity federation, or the metadata server when core itself runs on GCP.
     */
    keyFile: z.string().trim().min(1).optional(),
    /** Who may reach SSH on the shared firewall rule. The provider REQUIRES it, with no default. */
    sshAllowedCidr: z.string().trim().min(1).optional(),
    /** Required alongside `sshAllowedCidr: 0.0.0.0/0`. Opening SSH to the internet is two decisions. */
    allowAllCidr: z.boolean().optional(),
    /** Value of the `managed-by` label, and the prefix of every instance name. */
    managedBy: z.string().trim().min(1).optional(),
    /** Name of the shared SSH firewall rule, which doubles as the network tag it matches on. */
    firewallRuleName: z.string().trim().min(1).optional(),
    /** The VPC network instances join. */
    network: z.string().trim().min(1).optional(),
    /** Boot disk size in GB. GCE bills this separately from the instance. */
    bootDiskGb: z.coerce.number().int().positive().optional(),
    bootDiskType: z.enum(['pd-balanced', 'pd-standard', 'pd-ssd']).optional(),
    /** The project publishing the base image, and the image family without its arch suffix. */
    imageProject: z.string().trim().min(1).optional(),
    imageFamilyPrefix: z.string().trim().min(1).optional(),
    /** Optional allowlist of machine types offered to users. Omit to offer everything. */
    sizes: z.array(z.string().trim().min(1)).nonempty().optional(),
  }),
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
    azure: azureProviderSchema,
    gcp: gcpProviderSchema,
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

/**
 * Trust labels an operator may put on a registry, in their own config file.
 *
 * `official` is not in this list and cannot be. It means "shipped in the Rocky Surf tarball",
 * which is a thing no registry can be — the split-horizon ruling on issue #9. Letting a config
 * entry claim it would let an operator (or anything that could edit their config) dress a
 * third-party registry up as first-party, which is precisely the confusion the labels exist to
 * prevent.
 */
export const REGISTRY_TRUST = ['community', 'internal'] as const
export type RegistryTrust = (typeof REGISTRY_TRUST)[number]

/** The shop, which is the only registry an installation has until an operator adds one. */
export const DEFAULT_REGISTRY_URL = 'https://raw.githubusercontent.com/amroja-biz/rockysurf-shop/main'

const registrySourceSchema = z.strictObject({
  /** Shown in the UI and used to attribute an installed pack. Unique within the list. */
  name: z.string().trim().min(1),
  /**
   * The base a pack's `path` is resolved against, so `<url>/index.json` is the listing and
   * `<url>/<path>` is the file.
   *
   * raw.githubusercontent.com and NOT api.github.com for the default (rockysurf-c6cm): the
   * unauthenticated GitHub API allows 60 requests per hour shared across everything on one
   * source IP, and a control plane behind a corporate NAT would exhaust that before it had
   * listed the shop once. The raw host is a CDN with no such quota, which is also why a registry
   * publishes a generated index rather than expecting a client to walk a tree.
   */
  url: z
    .url({ error: 'a registry source url must be an http(s) URL' })
    // A trailing slash would produce `…//index.json`, which most servers tolerate and some do
    // not. Normalised once here rather than at each call site.
    .transform((v) => v.replace(/\/+$/, '')),
  /**
   * WHAT THE OPERATOR SAYS THIS REGISTRY IS, and the only place a registry's trustworthiness is
   * recorded.
   *
   * Deliberately not a field in the registry's own `index.json`. A trust label published by a
   * registry is a claim about trustworthiness written by the party being trusted, and it can
   * only ever be as good as the document containing it. Here it is a line in a file the operator
   * owns, alongside the URL they chose to add — so an internal shop can be labelled `internal`
   * and mean it, and nothing a registry publishes can promote itself.
   */
  trust: z.enum(REGISTRY_TRUST).default('community'),
})

/**
 * The pack registries this installation browses (rockysurf-arym.3).
 *
 * A LIST, with the community shop as the sole default, so an organisation can add an internal
 * registry without giving up the public one. Config-only for now: there is no UI for adding a
 * registry, because a registry is a thing an operator should have to write down.
 *
 * NOTHING HERE IS READ AT BOOT. The registries are fetched when an admin opens the shop, never
 * during startup. A control plane behind a proxy, or with no route off the machine at all, must
 * boot exactly as fast and as successfully as it does now — a network call on the startup path
 * would turn every outage of a third party into an outage of this one. The owner has waived the
 * offline concern for the product's main job; this is not that, and the boot path stays clean.
 *
 * SWITCHABLE OFF, because an air-gapped installation is a supported way to run this. `enabled:
 * false` means the shop reports a disabled registry; it does not mean a failed fetch, and an
 * operator should be able to tell those apart. Packs bundled in the tarball and packs created in
 * the admin UI are unaffected either way.
 */
const registrySchema = section(
  z.strictObject({
    enabled: z.boolean().default(true),
    sources: z
      .array(registrySourceSchema)
      .default([{ name: 'Rocky Surf Pack Shop', url: DEFAULT_REGISTRY_URL, trust: 'community' }])
      // `registry: { sources: }` with nothing after it parses as null, and an operator who
      // wrote that meant "none", not "give me the default back".
      .or(z.null().transform(() => [] as z.output<typeof registrySourceSchema>[]))
      .refine((list) => new Set(list.map((s) => s.name)).size === list.length, {
        error: 'two registry sources share a name; names identify where an installed pack came from',
      }),
    /**
     * How long a fetched index is reused before the next request refetches it, in seconds.
     *
     * Browsing the shop is several requests over a minute or two, and one HTTP call per page
     * view would be rude to a CDN and slow for the operator. Short enough that a merged pack
     * shows up while somebody is still waiting for it; a manual refresh exists for when it is
     * not short enough.
     */
    cacheTtlSeconds: z.coerce.number().int().nonnegative().default(300),
  }),
)

/**
 * Where the AWS/Azure price tables the feed workflow publishes are served from.
 *
 * The default is the feed this repository's own `price-feed` workflow republishes daily to
 * GitHub Pages (gh issue #100, ADR-0009). Overridable for a self-hosted mirror; `enabled:
 * false` for an air-gapped install that would rather not attempt doomed fetches. Either way
 * off the default path, prices simply show as unavailable — there is deliberately NO bundled
 * fallback (owner ruling): a reachable feed is the same reachability bar as GitHub itself,
 * and everything except the price labels keeps working without it.
 */
export const DEFAULT_PRICE_FEED_URL = 'https://amroja-biz.github.io/rockysurf/prices/v1'

const pricingSchema = section(
  z.strictObject({
    enabled: z.boolean().default(true),
    feedUrl: z.url().default(DEFAULT_PRICE_FEED_URL),
    /** How often an installed copy re-reads the feed. The publish cadence is the workflow's. */
    refreshHours: z.coerce.number().positive().max(720).default(6),
  }),
)

export const BOOTSTRAP_ON_FAILURE = ['terminate', 'keep'] as const

/**
 * What core does with the instance when a TOOL install fails during bootstrap (ADR-0010,
 * issue #119).
 *
 * `terminate` (the default, owner ruling 2026-08-26): nothing the user made exists on a box
 * before `ready`, and a half-installed toolchain is a machine nobody can use and everybody is
 * paying for. The complete install log is captured over SSH before the instance is released,
 * so the explanation survives the machine. `keep` is the escape hatch for a pack author who
 * needs to SSH into the failed box; the row then carries the still-billing notice until they
 * terminate it themselves. Failures in any other phase — a repository clone, branding, the
 * remote-desktop password — never terminate, whatever this says.
 */
const bootstrapSchema = section(
  z.strictObject({
    onFailure: z.enum(BOOTSTRAP_ON_FAILURE).default('terminate'),
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
    registry: registrySchema,
    pricing: pricingSchema,
    bootstrap: bootstrapSchema,
  }),
)

export type Config = z.output<typeof configSchema>
export type BootstrapConfig = Config['bootstrap']
export type BootstrapOnFailure = BootstrapConfig['onFailure']
export type ServerConfig = Config['server']
export type GithubTokenEntry = Config['github']['tokens'][number]
export type ProvidersConfig = Config['providers']
export type LimitsConfig = Config['limits']
export type McpConfig = Config['mcp']
export type RegistryConfig = Config['registry']
export type RegistrySource = RegistryConfig['sources'][number]
export type McpScope = McpConfig['scopes'][number]
export type ByoHost = Config['providers']['byo']['hosts'][number]
export type PricingConfig = Config['pricing']
