import type { InstanceState } from '@rockysurf/provider-sdk'
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * The control plane's schema. SQLite today, Postgres-ready by construction (ADR-0001).
 *
 * "Postgres-ready" is a set of rules, not a hope:
 *
 *  - **Only four column types**: `text`, `integer`, `real`, and `integer({ mode: 'boolean' })`.
 *    No SQLite affinity tricks, no `blob`, no dynamic typing.
 *  - **Timestamps are ISO 8601 `text`**, not epoch integers and not SQLite `datetime`. They
 *    sort correctly as strings, survive the move to `timestamptz` as a cast, and are readable
 *    in a raw `sqlite3` session when someone is debugging at 2am.
 *  - **JSON is `text`, parsed by the application** — required by the bead. Drizzle's `json`
 *    mode would hide a SQLite-specific serialization behind a typed accessor and make the
 *    Postgres move a data migration instead of a type change.
 *  - **Booleans are `integer({ mode: 'boolean' })`**, which is INTEGER 0/1 on disk and casts
 *    cleanly to a Postgres `boolean`.
 *  - **No `AUTOINCREMENT`**: every primary key is an application-generated string id, so
 *    nothing depends on SQLite's rowid semantics.
 *
 * Deliberately absent, per the plan's "AWS nouns deleted": `stackName`, `instanceId`,
 * `keyPairName`, `githubTokenSecretArn`, `rdpPasswordSecretArn`, and every spot-instance and
 * price-markup column. Provider-native identifiers now live inside `servers.providerData`,
 * which is opaque to core by design — that is what makes the row provider-agnostic.
 */

/* ------------------------------------------------------------------ enums (as string unions) */

/**
 * `requested` is new (ADR-0001): the row is written BEFORE the provider is called, so a crash
 * between the two leaves a findable row rather than an orphan nobody can see. The old code
 * provisioned first and wrote the row after.
 */
export const SERVER_STATUSES = ['requested', 'provisioning', 'running', 'stopped', 'terminated', 'failed'] as const
export type ServerStatus = (typeof SERVER_STATUSES)[number]

/**
 * Ported verbatim from the legacy backend's shared types, with exactly one change the plan mandates:
 * `stack_creating` → `requested`, because there is no CloudFormation stack any more. Every
 * other step keeps its name so the UI's progress vocabulary ports unchanged.
 */
export const PROVISIONING_STEPS = [
  'requested',
  'instance_launching',
  'instance_running',
  'installing_tools',
  'tools_installed',
  'cloning_repos',
  'ready',
] as const
export type ProvisioningStep = (typeof PROVISIONING_STEPS)[number]

/** Push is the default and only fully-proven topology; callback is the fallback (ADR-0002). */
export const BOOTSTRAP_MODES = ['push', 'callback'] as const
export type BootstrapMode = (typeof BOOTSTRAP_MODES)[number]

export const SERVER_SIZES = ['small', 'medium', 'large'] as const
export type ServerSize = (typeof SERVER_SIZES)[number]

export const ARCHITECTURES = ['amd64', 'arm64'] as const
export type Architecture = (typeof ARCHITECTURES)[number]

/* ------------------------------------------------------------------ users & sessions */

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    /** GitHub login. The identity the whole app keys on. */
    githubUsername: text('github_username').notNull(),
    githubId: text('github_id').notNull(),
    email: text('email'),
    avatarUrl: text('avatar_url'),
    isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
    /** Concurrent-server cap. Null means "use the instance default from config". */
    serverLimit: integer('server_limit'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('users_github_id_idx').on(t.githubId), uniqueIndex('users_github_username_idx').on(t.githubUsername)],
)

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the session cookie value. The cookie itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
    lastSeenAt: text('last_seen_at'),
  },
  (t) => [uniqueIndex('sessions_token_hash_idx').on(t.tokenHash), index('sessions_user_id_idx').on(t.userId)],
)

/* ------------------------------------------------------------------ servers */

export const servers = sqliteTable(
  'servers',
  {
    /**
     * Hostname-safe by construction — an RFC 1123 label (`srv-a1b2c3d4e5f6`), enforced by
     * `newServerId()` in `ids.ts` and by the frozen SDK's `assertHostnameSafeId`.
     *
     * This is amendment C2 and it is not cosmetic: on Hetzner the server NAME is the
     * idempotency mechanism, `srv_a1b2` is not a legal name there, and any sanitizing map a
     * provider would have to apply is non-injective (`srv_a` and `srv-a` both fold to
     * `srv-a`) — a collision means two logical servers fighting over one cloud resource.
     */
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /**
     * What this box is FOR, in the user's own words (issue #46). Display-only, like `name`:
     * the provider identity is `id`, so both are freely editable after create.
     */
    description: text('description'),

    /* --- placement --- */
    /** Provider id, matching `ComputeProvider.id`: 'aws', 'hetzner', 'byo'. */
    provider: text('provider').notNull(),
    /** T-shirt size the user picked; UI sugar over the resolved offering. */
    size: text('size').$type<ServerSize>().notNull(),
    /** Provider-native machine type resolved at create time: 't4g.small', 'cpx12'. */
    offeringId: text('offering_id').notNull(),
    arch: text('arch').$type<Architecture>().notNull(),
    region: text('region'),

    /* --- lifecycle --- */
    status: text('status').$type<ServerStatus>().notNull(),
    provisioningStep: text('provisioning_step').$type<ProvisioningStep>(),
    errorMessage: text('error_message'),

    /* --- provider handle --- */
    /**
     * JSON, parsed by the application. The provider's opaque `ProviderData` — EC2 instance
     * id, Hetzner numeric id and owned SSH key ids, and so on. Replaces the old
     * `stackName`/`instanceId`/`keyPairName` columns: core does not know or care what is in
     * here, which is exactly why the row is provider-agnostic.
     */
    providerData: text('provider_data'),

    /* --- bootstrap --- */
    bootstrapMode: text('bootstrap_mode').$type<BootstrapMode>().notNull().default('push'),
    /** JSON, parsed by the application: the resolved install plan, snapshotted at create. */
    installPlan: text('install_plan'),
    /** The unprivileged user the agent and the human both SSH in as. */
    sshUser: text('ssh_user').notNull().default('rocky'),
    /** Row id in `secrets` holding core's per-server private key material (ADR-0003, E3). */
    managedKeySecretId: text('managed_key_secret_id'),
    /**
     * `SHA256:...` of the host key core minted and cloud-init pinned.
     *
     * With `canInjectHostKeys` this is known BEFORE first contact, so the first SSH
     * connection — the one carrying the secrets file — is verified against a known key. On a
     * provider without the capability this is instead recorded on first contact and any later
     * change is refused (trust-on-first-use).
     */
    hostKeyFingerprint: text('host_key_fingerprint'),
    /**
     * The host key behind that fingerprint, when a provider reported it (ADR-0003, E14).
     *
     * Null for every server core provisioned itself — there the key is core's own, and lives in
     * the secrets store with its private half. This column holds the PUBLIC key of a machine
     * core adopted, so that `/ssh-host-key` can serve a real `known_hosts` entry for it. Never
     * written without checking that it hashes to `hostKeyFingerprint`, which stays the pin.
     */
    hostPublicKey: text('host_public_key'),
    /**
     * The public key the user pasted at create time, normalized (issue #41). Public material,
     * so it lives on the row rather than in the secrets store — every client that renders "how
     * do I connect" needs it, and routing it through the encrypted store would make that a
     * custody exemption (`secrets/route-inventory.test.ts`) bought for a value that is not a
     * secret.
     *
     * Null means the user supplied nothing and core's key is the only way in. Never
     * substituted for core's own key — see `ssh/server-keys.ts` — only appended alongside it.
     */
    userSuppliedPublicKey: text('user_supplied_public_key'),

    /* --- callback-mode credentials (ADR-0002 Decision 5, amendments E8/E9) --- */
    /**
     * SHA-256 of the recurring status token. The token itself is never stored, exactly as
     * with session cookies.
     *
     * Two tokens with two lifetimes, because collapsing them means single-use loses: this one
     * authenticates per-step progress POSTs, so it CANNOT be single-use, and it necessarily
     * lives on the box for the whole bootstrap. Its blast radius is bounded to writing
     * progress strings on this one row, and no route that returns anything secret may accept
     * it.
     */
    callbackTokenHash: text('callback_token_hash'),
    /** SHA-256 of the plan/secrets token — short-lived, budgeted, and far more powerful. */
    planTokenHash: text('plan_token_hash'),
    planTokenExpiresAt: text('plan_token_expires_at'),
    /**
     * Uses spent against the budget. Strict single-use does not survive a lost response —
     * spend the token, lose the reply in transit, and the retry gets 410 with no way to ask
     * for another plan: one dropped packet, one dead box (finding #40).
     */
    planTokenUses: integer('plan_token_uses').notNull().default(0),
    /**
     * When the token was first used a SECOND time. Every use after the first is recorded
     * because it is the only leak signal core ever gets — user-data is readable from the
     * instance metadata service by every process on the box, forever.
     */
    planTokenReplayedAt: text('plan_token_replayed_at'),

    /* --- addressing --- */
    publicIp: text('public_ip'),
    publicDns: text('public_dns'),
    /**
     * The port sshd answers on, when the provider reported one (ADR-0003, E13).
     *
     * Null means 22, which is every machine core provisions itself: core wrote the image's
     * config, so it chose the port. A provider that adopts a machine it did not create reports
     * whatever its operator configured, and this is where that answer lives — for the bootstrap
     * push and for the `ssh` command a human is shown.
     */
    sshPort: integer('ssh_port'),
    /**
     * Where to open this instance in the provider's own console, when the provider reported one
     * (ADR-0003, E16).
     *
     * Null is ordinary: a provider with no console, or one that has not been given the
     * configuration it needs to construct the URL, reports nothing and the UI shows no link.
     * Stored beside the address because it is the same kind of fact — the last thing a provider
     * said about where this instance is — and core never builds one itself.
     */
    consoleUrl: text('console_url'),
    /** Set when the IP moves across a stop/start on a provider with ipStableAcrossStop=false. */
    previousIp: text('previous_ip'),
    ipChangedAt: text('ip_changed_at'),

    /* --- content --- */
    packId: text('pack_id'),
    /** JSON array of tool ids, parsed by the application. */
    tools: text('tools'),
    /** JSON array of repository URLs, parsed by the application. */
    repositories: text('repositories'),

    /* --- idempotency --- */
    /**
     * Deduplication key for the create attempt, written with the row BEFORE the provider is
     * called, then passed to `provision()`.
     *
     * Carries a generation component (amendment C1) so that terminating `dev-box` and
     * recreating it with identical settings does not collide with the dead row forever. The
     * old scheme hashed only (name, provider, offering) and worked around collisions by
     * skipping terminal rows, which is not a design.
     */
    idempotencyKey: text('idempotency_key').notNull(),

    /* --- cost, as a Price (SDK amendment B2) --- */
    /** Hourly amount in `hourlyCostCurrency`. Null means the provider quoted no price. */
    hourlyCostAmount: real('hourly_cost_amount'),
    /** ISO 4217, uppercase. Hetzner quotes in the project's billing currency, often EUR. */
    hourlyCostCurrency: text('hourly_cost_currency'),
    /** When that price was read — bundled prices.json is stamped, so the UI can be honest. */
    hourlyCostFetchedAt: text('hourly_cost_fetched_at'),
    /** Accrued running time, in seconds. */
    totalUptimeSeconds: integer('total_uptime_seconds').notNull().default(0),
    /** Best-effort cost estimate in `hourlyCostCurrency`. An estimate, never a bill. */
    estimatedTotalCost: real('estimated_total_cost').notNull().default(0),

    /* --- what the PROVIDER last said about the machine (rockysurf-4byx) --- */
    /**
     * The instance state the provider reported at `providerStateAt`, in the frozen SDK
     * vocabulary — NOT a second copy of `status`.
     *
     * `status` is an app-level fact ("what is this server to Rocky Surf"); this is a cloud-level
     * one ("is there a machine, and is the meter running"). They disagree in exactly the case
     * this column exists for: a row that failed during bootstrap keeps its instance, by design,
     * so `status: 'failed'` sits beside `providerState: 'running'` and a billing EC2. Accrual
     * follows THIS column, because the provider is the thing sending the bill.
     *
     * Written only by `recordProviderState`, from `lifecycle`'s two provider reads — the
     * `provision()` result and every `describe()`. Core never infers a value here; null means
     * no provider has said anything yet.
     */
    providerState: text('provider_state').$type<InstanceState>(),
    /** When `providerState` was confirmed. Its age is how stale the billing claim is. */
    providerStateAt: text('provider_state_at'),
    /**
     * The first moment core CONFIRMED, from the provider, that this instance was billing.
     *
     * Never inferred and never backfilled — not from `createdAt`, not from `startedAt`. It is
     * the anchor the uptime ticker accrues from for a row whose `status` cannot supply one
     * (a row that failed before `ready` has no `startedAt` at all), and an anchor that guessed
     * would put invented hours on a cost estimate, which is the bug this bead is about rather
     * than a fix for it. The honest consequence, stated where the UI can repeat it: a row whose
     * machine was already billing before core learned to look accrues from when core looked.
     */
    billingSince: text('billing_since'),

    /* --- timestamps, all ISO 8601 --- */
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    /** First moment the server reported ready. */
    startedAt: text('started_at'),
    stoppedAt: text('stopped_at'),
    terminatedAt: text('terminated_at'),
  },
  (t) => [
    uniqueIndex('servers_idempotency_key_idx').on(t.idempotencyKey),
    index('servers_user_id_idx').on(t.userId),
    index('servers_status_idx').on(t.status),
  ],
)

/* ------------------------------------------------------------------ packs & tools */

/**
 * Cache and edit layer over `packs/*.yaml`, which are the source of truth (ADR-0004).
 * A row here can be edited in the admin UI; the file is what ships.
 */
export const tools = sqliteTable('tools', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  /** 'agent' for the AI coding agents a pack exists to deliver; 'base' for supporting software. */
  category: text('category').notNull(),
  url: text('url').notNull(),
  installScript: text('install_script').notNull(),
  setupScript: text('setup_script'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** Ascending, gaps of 10 by convention so a step can be inserted without renumbering. */
  installOrder: integer('install_order').notNull(),
  /** Reserved for tools the runtime guarantees before any plan runs. Packs set false. */
  bootstrap: integer('bootstrap', { mode: 'boolean' }).notNull().default(false),
  runAs: text('run_as').notNull().default('rocky'),
  /** Which pack file this definition came from, for round-tripping edits back to YAML. */
  sourceFile: text('source_file'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const packs = sqliteTable('packs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** JSON array of tool ids, parsed by the application. */
  tools: text('tools').notNull(),
  displayOrder: integer('display_order').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  imageUrl: text('image_url'),
  theme: text('theme'),
  /** Post-boot instructions shown to the user once the server is running. Prose, never run. */
  guide: text('guide'),
  /** The user must choose at least one repository before creating; `$REPOS` is set. */
  requiresRepos: integer('requires_repos', { mode: 'boolean' }).notNull().default(false),
  /** The user is asked for a remote-desktop password at create time. */
  requiresRdp: integer('requires_rdp', { mode: 'boolean' }).notNull().default(false),
  /** 'xfce', or null for a headless box. */
  desktop: text('desktop'),
  /** Loopback port of the pack's web UI, so Connect can render the tunnel. Null: none. */
  webPort: integer('web_port'),
  sourceFile: text('source_file'),
  /**
   * Where a pack installed from a registry came from (rockysurf-arym.4).
   *
   * SEPARATE COLUMNS, AND NOT `sourceFile`, WHICH WOULD DELETE THE PACK. `syncPacksToDb`
   * removes every row with a non-null `sourceFile` whose file the next boot does not find, so
   * recording provenance there — `shop:rust-dev`, say — would make a registry install vanish on
   * the next restart. A registry pack keeps `sourceFile` NULL, exactly like one created in the
   * admin UI, and the boot reconcile leaves it alone by construction.
   *
   * `registrySource` is the configured source's NAME rather than its URL, because that is what
   * the operator wrote and what the UI shows; `registryUrl` is kept beside it so an install
   * still says where it actually came from after a source is renamed or repointed.
   *
   * `registryTrust` is snapshotted at install time on purpose. It records what the operator
   * believed when they consented, which is the question an audit asks — not what the config
   * happens to say today.
   */
  registrySource: text('registry_source'),
  registryUrl: text('registry_url'),
  /** The digest verified at install. Lets the UI say exactly which bytes were accepted. */
  registrySha256: text('registry_sha256'),
  registryTrust: text('registry_trust'),
  /** ISO-8601. When this installation accepted it, which is not when the registry published it. */
  registryInstalledAt: text('registry_installed_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/* ------------------------------------------------------------------ secrets */

/**
 * AES-256-GCM ciphertext rows (ADR-0001). The master key comes from
 * `ROCKYSURF_SECRET_KEY` or an auto-generated `<dataDir>/secret.key`.
 *
 * Plaintext NEVER lands in this table, and the columns are shaped so it cannot: there is
 * nowhere to put it. Nonce and auth tag are stored beside the ciphertext because GCM needs
 * both to decrypt, and they are not secret. Implementation is rockysurf-gonw.6.
 */
export const secrets = sqliteTable(
  'secrets',
  {
    id: text('id').primaryKey(),
    /** What this secret is for: 'server-ssh-key', 'provider-token', 'github-token'. */
    kind: text('kind').notNull(),
    /** The entity it belongs to — a server id, a user id — for cascade cleanup. */
    ownerId: text('owner_id'),
    /** Base64 AES-256-GCM ciphertext. */
    ciphertext: text('ciphertext').notNull(),
    /** Base64 96-bit nonce. Unique per encryption; not secret. */
    nonce: text('nonce').notNull(),
    /** Base64 128-bit GCM authentication tag. Not secret. */
    authTag: text('auth_tag').notNull(),
    /**
     * Which master key sealed this row. Always `'v1'` in v0.1 — there is no rotation
     * machinery — but rotation needs to find the rows still under the old key, and that is a
     * query (`where key_id = 'v1'`), not something to reverse-engineer out of a blob later.
     * Cheap now, unavailable later. Written by rockysurf-gonw.6.
     */
    keyId: text('key_id').notNull().default('v1'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('secrets_owner_id_idx').on(t.ownerId), index('secrets_kind_idx').on(t.kind)],
)

/* ------------------------------------------------------------------ settings */

/** Instance-level key/value settings. Values are JSON text, parsed by the application. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/* ------------------------------------------------------------------ events */

/**
 * Append-only audit and progress log. Feeds the SSE stream that replaces the WebSocket API,
 * and is the forensic record for bootstrap runs.
 *
 * ADR-0002 requires that reports from a SUPERSEDED bootstrap run are recorded but must not
 * move the server row — `runId` is what makes that distinction possible after the fact.
 */
export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    /** 'server.status_changed', 'bootstrap.step', 'server.ip_changed'. */
    type: text('type').notNull(),
    serverId: text('server_id'),
    userId: text('user_id'),
    /** Core-minted id for the bootstrap run this event belongs to (ADR-0002, E6). */
    runId: text('run_id'),
    /** JSON payload, parsed by the application. */
    payload: text('payload'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('events_server_id_idx').on(t.serverId),
    index('events_created_at_idx').on(t.createdAt),
    index('events_type_idx').on(t.type),
  ],
)

/* ------------------------------------------------------------------ server ↔ repo join */

/**
 * Repositories are also denormalized onto `servers.repositories` as JSON for the create-time
 * snapshot; this table is the queryable form for "which servers use this repo".
 */
export const serverRepositories = sqliteTable(
  'server_repositories',
  {
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    repositoryUrl: text('repository_url').notNull(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.repositoryUrl] })],
)

/* ------------------------------------------------------------------ inferred row types */

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Session = typeof sessions.$inferSelect
export type NewSession = typeof sessions.$inferInsert
export type ServerRow = typeof servers.$inferSelect
export type NewServerRow = typeof servers.$inferInsert
export type ToolRow = typeof tools.$inferSelect
export type NewToolRow = typeof tools.$inferInsert
export type PackRow = typeof packs.$inferSelect
export type NewPackRow = typeof packs.$inferInsert
export type SecretRow = typeof secrets.$inferSelect
export type NewSecretRow = typeof secrets.$inferInsert
export type SettingRow = typeof settings.$inferSelect
export type EventRow = typeof events.$inferSelect
export type NewEventRow = typeof events.$inferInsert
