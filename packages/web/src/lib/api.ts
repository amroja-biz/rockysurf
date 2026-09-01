/**
 * The API client, ported from the SPA of the hosted SaaS this project replaced (see
 * `docs/history/` for that story).
 *
 * Function shapes are preserved deliberately: page components port mechanically as long as
 * `listServers()` still returns `ServerSummary[]`. What changed is the edges.
 *
 * BASE URL. The old client pointed at an API Gateway on another origin, so it needed
 * `VITE_API_BASE_URL` and a CORS policy at the far end. Core serves this bundle from its own
 * process (ADR-0001), so the default is same-origin `/api/v1` and there is no CORS anywhere.
 * The env override survives for `vite dev`, where the SPA runs on 5173 and core on 3000 — see
 * the README; the dev proxy means even that usually goes unused.
 *
 * WHAT IS GONE, and why it is not coming back: billing and Stripe (self-hosted — the operator
 * pays their own cloud bill), server limits and limit requests (no multi-tenant quota), spot
 * instances and `resize` (cut from the provider SDK for want of a second implementation), the
 * S3 image-upload helpers (AWS-coupled), and the GitHub App installation check (no GitHub
 * OAuth in v0.1).
 */

const ENV_BASE = import.meta.env['VITE_API_BASE_URL'] as string | undefined
const API_BASE_URL = (ENV_BASE ?? '/api/v1').replace(/\/$/, '')

/** What `detail` says when the request never reached core at all (status 0). */
export const UNREACHABLE_DETAIL = 'Could not reach Rocky Surf — is it running?'

export class ApiError extends Error {
  status: number
  statusText: string
  data?: unknown

  constructor(status: number, statusText: string, data?: unknown, cause?: unknown) {
    super(`API Error: ${status} ${statusText}`, cause === undefined ? undefined : { cause })
    this.name = 'ApiError'
    this.status = status
    this.statusText = statusText
    this.data = data
  }

  /** True when no server answered — as opposed to core answering with an error. */
  get unreachable(): boolean {
    return this.status === 0
  }

  /** Core's error envelope is `{ error, code }`; fall back to the status line. */
  get detail(): string {
    const body = this.data as { error?: string } | undefined
    return body?.error ?? this.statusText
  }

  /**
   * The field-level half of the envelope, when core sent one.
   *
   * `detail` is the summary sentence; this is the per-field detail behind it, and a form that
   * has fields to attach it to should. The repository preflight (rockysurf-k6xp) is the first
   * thing to send more than one — a create naming four repositories reports every bad URL at
   * once, so the user fixes the form rather than resubmitting four times.
   */
  get issues(): { path: string; message: string }[] {
    const body = this.data as { issues?: { path: string; message: string }[] } | undefined
    return Array.isArray(body?.issues) ? body.issues : []
  }

  /**
   * The nine-code provider taxonomy (ADR-0003), when `code` is one of them (issue #127).
   *
   * A cloud failure's `code` on the wire IS one of {@link PROVIDER_ERROR_CODES} — that is the
   * whole point of the frozen taxonomy — while a validation or lifecycle error uses its own
   * vocabulary (`bad_request`, `conflict`, `limit_exceeded`, …). Checking membership rather
   * than trusting the field's mere presence is what lets a caller tell "this is a cloud
   * provider's own failure, headline it" from "this is core's own refusal, read `detail`
   * plain" without a second flag on the wire.
   */
  get providerErrorCode(): ProviderErrorCode | undefined {
    const body = this.data as { code?: string } | undefined
    const code = body?.code
    return code && (PROVIDER_ERROR_CODES as readonly string[]).includes(code) ? (code as ProviderErrorCode) : undefined
  }

  /** The cloud's own code, verbatim (e.g. Azure's `OperationNotAllowed`), when core forwarded one. */
  get providerCode(): string | undefined {
    const body = this.data as { providerCode?: string } | undefined
    return body?.providerCode
  }
}

/**
 * Mirrors `@rockysurf/provider-sdk`'s frozen `ProviderErrorCode` (ADR-0003) without taking a
 * dependency on that package from the browser bundle — `packages/web` redefines every wire
 * shape it reads rather than importing core's or a provider's own types (see `ProviderInfo`,
 * `Offering` below).
 */
export type ProviderErrorCode = 'auth' | 'quota' | 'capacity' | 'invalid_spec' | 'not_found' | 'rate_limited' | 'conflict' | 'network' | 'unknown'
const PROVIDER_ERROR_CODES: readonly ProviderErrorCode[] = [
  'auth',
  'quota',
  'capacity',
  'invalid_spec',
  'not_found',
  'rate_limited',
  'conflict',
  'network',
  'unknown',
]

let authToken: string | null = null
let onUnauthorized: (() => void) | null = null

export function setAuthToken(token: string | null): void {
  authToken = token
}

export function getAuthToken(): string | null {
  return authToken
}

export function setOnUnauthorized(callback: () => void): void {
  onUnauthorized = callback
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }

  // Bearer when we hold a token; the session cookie covers the browser either way, which is
  // why `credentials: 'include'` is unconditional.
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`

  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers,
      credentials: 'include',
    })
  } catch (cause) {
    // `fetch` rejects with a bare TypeError when the request never reached a server — core is
    // not running, the port is wrong, the network dropped. Every form in the SPA renders
    // `err.detail` for an ApiError and a generic "could not save X" for anything else, so
    // without this an operator whose core was simply stopped read "Could not save this tool"
    // and went looking for a validation problem that did not exist. Status 0 is the browser's
    // own convention for "no response", so no caller mistakes it for something core said.
    throw new ApiError(0, UNREACHABLE_DETAIL, undefined, cause)
  }

  if (response.status === 401) {
    onUnauthorized?.()
    throw new ApiError(401, 'Unauthorized')
  }

  if (!response.ok) {
    let data: unknown
    try {
      data = await response.json()
    } catch {
      data = undefined
    }
    throw new ApiError(response.status, response.statusText, data)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/* ------------------------------------------------------------------------------- auth */

export interface User {
  id: string
  username: string
  email?: string | null
  avatarUrl?: string | null
  isAdmin: boolean
}

export interface LoginResponse {
  user: User
  /** Also set as an httpOnly cookie; returned so a non-browser client can use bearer auth. */
  token: string
}

/** Single-admin password login. Replaces the GitHub OAuth redirect entirely. */
export async function login(password: string): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  })
}

export async function logout(): Promise<void> {
  await request<{ ok: boolean }>('/auth/logout', { method: 'POST' })
}

export async function getCurrentUser(): Promise<User> {
  const { user } = await request<{ user: User }>('/auth/me')
  return user
}

/* ---------------------------------------------------------------------------- servers */

export type ProvisioningStep =
  | 'requested'
  | 'instance_launching'
  | 'instance_running'
  | 'installing_tools'
  | 'tools_installed'
  | 'cloning_repos'
  /** The script the user supplied at create time, running on the box (issue #184). */
  | 'running_user_script'
  | 'ready'

/** Hourly price as the SDK models it: a provider may quote in its own currency, or not at all. */
export interface Price {
  amount: number
  currency: string
  fetchedAt: string
}

export interface Server {
  serverId: string
  name: string
  /** The user's own words about what this box is for (issue #46). Absent until they say. */
  description?: string
  /** Provider id — `'aws'`, `'hetzner'`, `'byo'`. The key for a capability lookup, never a
   *  thing to branch on directly. */
  provider: string
  /**
   * The region this box was placed in, when its provider has regions (issue #125). Absent for a
   * BYO host and for any provider that takes no region — never rendered as a guess.
   */
  region?: string
  /**
   * `'custom'` means this server was created by naming an `offeringId` directly, with no
   * t-shirt size behind it at all (rockysurf-kh3u) — render it as `offeringId`, never as the
   * literal word.
   */
  size: 'small' | 'medium' | 'large' | 'custom'
  offeringId: string
  arch: 'amd64' | 'arm64'
  status: 'requested' | 'provisioning' | 'running' | 'stopped' | 'terminated' | 'failed'
  /** The unprivileged account the user SSHes in as. */
  sshUser: string
  /** Absent unless sshd is somewhere other than 22 — a BYO machine core did not configure. */
  sshPort?: number
  /**
   * The key the user brought, when they brought one (issue #41). Absent means Rocky Surf's own
   * generated key is the only one authorized. Rocky Surf's key is authorized too for bootstrap —
   * it installs everything over its own SSH connection — but it is a provisioning tool, not a
   * standing credential (issue #92): see `suppliedKeyOnly`.
   */
  suppliedSshKey?: {
    fingerprint: string
    comment?: string
  }
  /**
   * Whether the key above is now the ONLY key on the box (issue #92). Absent when no key was
   * supplied. `false` while Rocky Surf's own key is still also authorized — mid-bootstrap, or a
   * box that shipped before this existed — `true` once it has been removed.
   */
  suppliedKeyOnly?: boolean
  /**
   * This instance's page in the provider's own management console, when the PROVIDER reported
   * one (ADR-0003, E16). Absent for a provider with no console, and for Hetzner until
   * `providers.hetzner.consoleProjectId` is configured — so the link is rendered only when it
   * is present, and never assembled here from `provider` and an id.
   */
  consoleUrl?: string
  bootstrapMode: 'push' | 'callback'
  hourlyCost?: Price
  estimatedTotalCost: number
  /**
   * Present only when the PROVIDER says this instance is metering and `status` does not say so
   * (rockysurf-4byx) — a row that failed during bootstrap being the case it was built for.
   *
   * Core decides this, not the client: which provider states count as billing is one rule, and
   * three front ends each re-deriving it from a raw state string is three chances to disagree
   * about whether somebody is being charged. Absent on a plain `running` row, where the status
   * already carries the whole truth.
   */
  billing?: {
    live: true
    /** The SDK instance state behind the claim: `pending`, `running`, `stopping`. */
    providerState?: string
    /** When core first CONFIRMED the machine was billing. Not when billing started. */
    since?: string
    /** When that claim was last refreshed against the provider — i.e. how stale it is. */
    confirmedAt?: string
  }
  publicIp?: string
  previousIp?: string
  ipChangedAt?: string
  publicDns?: string
  tools: string[]
  packId?: string
  repositories: string[]
  /**
   * The NON-SECRET pack inputs this box was built with (issue #189, ADR-0013).
   *
   * The answers the creator typed, for a pack that asked. Secret inputs are not here and are
   * not on any other route — core stores them encrypted and returns them nowhere. Absent when
   * the pack asked for nothing.
   */
  packInputs?: Record<string, string>
  /**
   * The NON-SECRET half of the Environment this box's creator typed (issue #197, ADR-0014).
   *
   * Beside `packInputs` and separate from it, because the server page says which of the two a
   * variable came from. Secret lines are in neither and are on no route at all. Absent when the
   * creator typed nothing.
   */
  environment?: Record<string, string>
  /**
   * The git token scopes this box carries, as `host/owner/repo` identities — never values
   * (rockysurf-18lq).
   *
   * A box receives only the tokens its declared repositories selected, so this is a real fact
   * about this machine rather than a restatement of the installation's configuration. Absent
   * when core has no git configuration to answer from, which is not the same claim as `[]`.
   */
  githubTokenScopes?: string[]
  /** Whether the instance-wide `github.pat` — which every box carries — is configured at all. */
  carriesFallbackToken?: boolean
  provisioningStep?: ProvisioningStep
  errorMessage?: string
  /**
   * The complete account of a bootstrap that went wrong (ADR-0010): the failed step by name,
   * why, the decisive lines, the whole captured log, and what core did with the machine — or,
   * on a box that came up, the repositories that did not clone. `errorMessage` is the
   * paragraph; this is the evidence. Absent on a clean row.
   */
  bootstrapReport?: BootstrapReport
  /**
   * Why this row may be STALE: the provider could not be asked just now — expired cloud
   * credentials, a cloud having a bad day — and core served what it last knew instead of
   * failing the whole request (rockysurf-gg9x). The message is the provider's own and names
   * the remedy; for an expired login it contains the exact command to run, so render it
   * verbatim. Absent when the view is fresh. Distinct from `errorMessage`, which is about
   * the SERVER failing, not about core's view of it going stale.
   */
  syncError?: string
  createdAt: string
  startedAt?: string
  stoppedAt?: string
  terminatedAt?: string
  totalUptimeSeconds: number
}

/** Mirrors `bootstrap/failure-report.ts` in core (ADR-0010). */
export type BootstrapFailureCause =
  | 'apt-mirror'
  | 'apt'
  | 'git-auth'
  | 'git-not-found'
  | 'github-rate-limit'
  | 'network'
  | 'disk-full'
  | 'timeout'
  | 'unknown'

export interface StepReport {
  /** The plan's step id: `tool:build-essential`, `repo:my-app`, `branding`. */
  stepId: string
  phase: 'tool' | 'repo' | 'setup' | 'finishing'
  /** The tool's display name, the repository URL, or the step id when neither is known. */
  label: string
  exitCode?: number
  cause: BootstrapFailureCause
  /** Two to four plain sentences: what failed, why, what to do about it. */
  summary: string
  /** The lines that decide the verdict — never the whole log. */
  keyLines: string[]
  /** The step's captured output. Complete in push mode; the agent's tail in callback mode. */
  log: string
  logComplete: boolean
}

export interface BootstrapFailure extends StepReport {
  instance: 'terminated' | 'kept' | 'terminate-failed'
  /** One sentence on what core did with the machine and what that means for the bill. */
  instanceNote: string
}

export interface BootstrapReport {
  /** The required step that stopped the plan. Absent when the box came up with warnings only. */
  failure?: BootstrapFailure
  /** Optional steps that failed while the plan went on — repository clones. */
  warnings: StepReport[]
  agentLogTail?: string
}

/**
 * The list projection. Core returns the same `present()` shape for both list and detail, so
 * this IS `Server` — an alias rather than a second declaration, because the second declaration
 * is what broke (rockysurf-u6af).
 *
 * It used to restate the fields by hand, and had drifted: `uptime` and `estimatedCost` were the
 * old hosted API's names, which core has never sent, alongside `packName`, `packImageUrl` and
 * `ipChangedRecently`, which nothing serves and nothing read. TypeScript cannot catch that —
 * `request<ServerSummary[]>` asserts a shape over a socket rather than checking one — so the
 * dashboard card read `server.uptime`, got `undefined` for every row, and showed a dash for the
 * uptime of a box that had been running for half an hour. The detail page, reading the same
 * data through `Server`, showed it correctly all along. One name for one shape means the two
 * pages cannot disagree again; `DashboardPage.wiring.test.tsx` pins the shape to core's own
 * `present()`.
 */
export type ServerSummary = Server

export interface CreateServerRequest {
  name?: string
  /** Optional free-text purpose, editable later from the server page. */
  description?: string
  /**
   * Optional (rockysurf-kh3u): the machine-type picker sends `offeringId` alone and OMITS
   * this field entirely — picking a specific machine IS the size decision, made concretely.
   * Never `'custom'`; that is a server-side derivation, not a value this client may send. At
   * least one of `size`/`offeringId` is required — core 400s naming both when neither arrives.
   */
  size?: 'small' | 'medium' | 'large'
  packId: string
  /** Provider id. Omit to let core use its default. */
  provider?: string
  /**
   * The concrete offering the size resolved to, or the one the picker chose directly.
   *
   * Sent explicitly so the user gets the machine whose price they were shown. Omitting it
   * lets core choose, which is right for an API caller and wrong for a form that just
   * displayed a number.
   */
  offeringId?: string
  arch?: 'amd64' | 'arm64'
  repositories?: string[]
  sshPublicKey?: string
  rdpPassword?: string
  /**
   * A script the box runs once, at the end of its bootstrap (issue #184).
   *
   * Omitted entirely when the field is empty or whitespace — an empty string would be a request
   * to run nothing, and core would have to decide what that meant. Core bounds it at 16 KiB.
   */
  userScript?: string
  /** Who runs it. Omitted with `userScript`; core defaults it to `rocky`. */
  userScriptRunAs?: 'root' | 'rocky'
  /**
   * The values the selected pack declared as `inputs` (issue #189).
   *
   * A flat `NAME: value` map, sent only for names the pack actually declared — core 400s an
   * unknown one rather than ignoring it, so a value that never reaches a box is a refusal
   * rather than a silence. Omitted entirely when the pack asks for nothing.
   */
  packInputs?: Record<string, string>
  /**
   * The creator's OWN environment for this box — what they typed, not what the pack asked for
   * (issue #197, ADR-0014).
   *
   * Keyed by variable name like `packInputs`, with the one fact no pack file can supply:
   * whether the value is a secret, so core knows to store it encrypted and return it from no
   * route. Omitted entirely when the field is empty.
   */
  environment?: Record<string, ServerEnvironmentEntry>
  /**
   * Create even though a repository URL failed core's preflight (rockysurf-k6xp).
   *
   * The check refuses by default because the alternative costs a boot, a bootstrap and a failed
   * box that goes on billing. This is the way out when the user knows better than the check —
   * a forge that was briefly down, a credential core cannot predict the box will use.
   */
  createAnyway?: boolean
}

/** One `KEY=value` the creator supplied, and whether it is stored encrypted (issue #197). */
export interface ServerEnvironmentEntry {
  value: string
  secret?: boolean
}

export interface CreateServerResponse {
  serverId: string
  name: string
  status: Server['status']
}

export async function listServers(includeTerminated = false): Promise<ServerSummary[]> {
  return request<ServerSummary[]>(`/servers${includeTerminated ? '?includeTerminated=true' : ''}`)
}

export async function getServer(serverId: string): Promise<Server> {
  return request<Server>(`/servers/${serverId}`)
}

/**
 * Edit the display fields — name, description (issue #46). Omitted means "leave it";
 * a description sent as `''` clears it. Returns the row as every other server read serves it.
 */
export async function updateServer(serverId: string, patch: { name?: string; description?: string }): Promise<Server> {
  return request<Server>(`/servers/${serverId}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

export async function createServer(data: CreateServerRequest): Promise<CreateServerResponse> {
  return request<CreateServerResponse>('/servers', { method: 'POST', body: JSON.stringify(data) })
}

/**
 * Which token a repository URL resolves to, and whether it opens (rockysurf-18lq).
 *
 * SCOPE IDENTITIES AND VARIABLE NAMES ONLY. Core decides what may be said and says nothing
 * else; there is deliberately no client-side matching to go with this, because the precedence
 * rules live in one module in core and a second implementation here is how the create screen
 * would come to disagree with the box it is describing.
 */
export interface TokenView {
  kind: 'scoped' | 'fallback' | 'none'
  /** `host/owner/repo`, `*` for the segments the entry left open. */
  scope?: string
  /** The `${VAR}` the config file draws this token from, when it draws it from one. */
  envVar?: string
  /** False when that variable is not set in the environment core was started from. */
  envVarSet?: boolean
}

export interface RepositoryResolution {
  url: string
  /** What a box created now would present for this URL. */
  live: TokenView
  /** What it would present after a restart — present only when the config file has drifted. */
  pending?: TokenView
  reachable: 'ok' | 'refused'
  reason?: string
  code?: string
}

export async function resolveRepositories(urls: string[]): Promise<RepositoryResolution[]> {
  const body = await request<{ resolutions: RepositoryResolution[] }>('/git/resolve-repositories', {
    method: 'POST',
    body: JSON.stringify({ urls }),
  })
  return body.resolutions
}

/**
 * What this installation has tokens for, as the create form's repository picker (rockysurf-mh8f).
 *
 * SAME DISCRETION AS ABOVE, and the same reason for living in core: `kind` is a judgement about
 * what an entry can be turned into — a repository entry names a clone URL, an account entry names
 * an account and no URL exists to insert — and the entry's shape is core's to read. The settings
 * page renders the same entries through `lib/githubTokens.ts`; the create page deliberately does
 * not import that module, because it is a settings-EDITING module and one of these two screens
 * growing an opinion about the other's job is how they drift.
 */
export interface ConfiguredScope {
  kind: 'repository' | 'account' | 'host' | 'fallback'
  /** `host/owner/repo` with `*` for the open segments — the entry's identity, and its React key. */
  scope: string
  /** What to call it: `acme/widgets`, `acme`, `git.example.com`. Absent for the fallback. */
  label?: string
  /** The clone URL this entry names. Present for `repository` and for nothing else. */
  url?: string
  envVar?: string
  envVarSet?: boolean
  /** `pending` when the config file holds the entry and this process has not restarted into it. */
  state: 'live' | 'pending'
}

export async function listConfiguredScopes(): Promise<ConfiguredScope[]> {
  const body = await request<{ scopes: ConfiguredScope[] }>('/git/configured-scopes')
  return body.scopes
}

export async function startServer(serverId: string): Promise<Server> {
  return request<Server>(`/servers/${serverId}/start`, { method: 'POST' })
}

export async function stopServer(serverId: string): Promise<Server> {
  return request<Server>(`/servers/${serverId}/stop`, { method: 'POST' })
}

export async function terminateServer(serverId: string): Promise<Server> {
  return request<Server>(`/servers/${serverId}/terminate`, { method: 'POST' })
}

/**
 * Download the server's private key as a `.pem`.
 *
 * Not routed through `request()` because the body is PEM text rather than JSON, and the point
 * is to hand the file to the browser. This is the one endpoint in the system that returns
 * decrypted material, and core audits the handover.
 */
export async function downloadSshKey(serverId: string, serverName: string): Promise<void> {
  const headers: Record<string, string> = {}
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`

  const response = await fetch(`${API_BASE_URL}/servers/${serverId}/ssh-key`, {
    headers,
    credentials: 'include',
  })

  if (response.status === 401) {
    onUnauthorized?.()
    throw new ApiError(401, 'Unauthorized')
  }
  if (!response.ok) {
    throw new ApiError(response.status, response.statusText, { error: 'No SSH key available for download' })
  }

  const blob = new Blob([await response.text()], { type: 'application/x-pem-file' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${serverName}.pem`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/* -------------------------------------------------------------------------- providers */

/**
 * What core is allowed to differ on. Every behavioural difference between clouds flows
 * through these flags — the UI reads them and never recognises a provider by name.
 */
export interface ProviderCapabilities {
  stop: boolean
  ipStableAcrossStop: boolean
  canInjectHostKeys: boolean
  userDataMaxBytes: number
  generatesUserData: boolean
}

/**
 * One machine type a provider can sell, as the frozen SDK models it.
 *
 * `available: false` is reported rather than omitted — a price is not an offer, and the size
 * selector needs to say "sold out" rather than silently having nothing to pick.
 */
export interface Offering {
  id: string
  cpu: number
  memoryGb: number
  diskGb?: number
  arch: 'amd64' | 'arm64'
  /** `null` means the provider quoted no price. Unknown, never free. */
  hourly: Price | null
  available: boolean
  /** The provider's own reason `available` is false, when it has one (Azure: core quota). */
  unavailableReason?: string
  region: string
}

export interface ProviderInfo {
  id: string
  displayName: string
  capabilities: ProviderCapabilities
  /** Everything this provider can sell. Empty when `offeringsError` is set. */
  offerings: Offering[]
  /** Present when this provider's catalogue could not be read; the others still work. */
  offeringsError?: string
  /**
   * The machine type saved for each size on this cloud — `preferences.tiers` (issue #124).
   *
   * Rides with the catalogue rather than living at its own endpoint for the same reason the
   * catalogue rides with the provider: the create page resolves a size to a concrete machine
   * BEFORE submit, so it needs the preference and the offering it names in one response.
   * Absent for a cloud with nothing saved, which is every cloud until someone saves one.
   */
  tierPreferences?: Partial<Record<'small' | 'medium' | 'large', string>>
}

export async function listProviders(): Promise<ProviderInfo[]> {
  return request<ProviderInfo[]>('/providers')
}

/**
 * One SSH public key saved by name in Settings (issue #302).
 *
 * `publicKey` is the whole `authorized_keys` line, not a reference to one, and the create form
 * posts it in the same `sshPublicKey` field a pasted key goes in — the picker is a way to fill
 * that box, not a second way to authorize a key. Nothing here is secret: a public key is handed
 * to a cloud provider in the clear on every create.
 *
 * NOT ridden along with `listProviders` the way `tierPreferences` is, because it is not a
 * property of a cloud: the same keys are offered whichever provider is selected, and hanging
 * them off each provider would mean the page holding four copies of one list.
 */
export interface SavedSshKey {
  name: string
  publicKey: string
}

export async function listSshKeys(): Promise<SavedSshKey[]> {
  return request<SavedSshKey[]>('/ssh-keys')
}

/* ------------------------------------------------------------------------ packs & tools */

export interface SurgePackTool {
  toolId: string
  name: string
  description: string
  category: 'agent' | 'base'
  url: string
}

/**
 * One value a pack asks the person creating a server for (issue #189, ADR-0013).
 *
 * The create form renders a field per entry, straight from this declaration and with no
 * per-pack code — the same contract that gives a `requiresRdp` pack a password field. `name` is
 * the environment variable the box's install scripts read; everything else is how to ask for it.
 */
export interface PackInput {
  name: string
  label: string
  description?: string
  required: boolean
  /**
   * Render a password field, and never expect this value back from any route: core stores a
   * secret input encrypted, beside the desktop password, and returns it nowhere.
   */
  secret: boolean
  /** Prefilled on the form. Never present on a `secret` input — core refuses that pack. */
  default?: string
}

export interface SurgePack {
  packId: string
  name: string
  /**
   * The pack this one was forked from, if it was (issue #295).
   *
   * Provenance, not a sync relationship: it says where this pack BEGAN, and nothing is offered
   * to bring it up to date. The Surge Packs page reads it two ways — a fork wears its parent's
   * artwork with a delta over it, and the parent's own card gets the same delta to say a
   * personal version exists — both derived in the browser from this list, so deleting a fork
   * clears the mark with no route to ask.
   *
   * May name a pack that is no longer installed: a release can drop one, and the id is still
   * the truth about where this pack came from. Every reader checks before dereferencing.
   */
  derivedFromPackId?: string
  displayOrder: number
  enabled: boolean
  imageUrl?: string
  theme?: string
  /**
   * Post-boot instructions the pack author wrote: how to authenticate the agents it
   * installs, and whatever else the install could not do for the user. Prose, shown once
   * the server is running — never executed, and never rendered as HTML or markdown.
   */
  guide?: string
  tools: SurgePackTool[]
  /** Added in v0.1 so the UI stops recognising one pack by name (ADR-0004). */
  requiresRepos: boolean
  requiresRdp: boolean
  desktop?: 'xfce'
  /**
   * The loopback port of a web UI this pack serves on the box, or undefined for a pack with
   * none. The server detail page renders the `ssh -L` command from it — same
   * metadata-not-name-check contract as `requiresRdp` (rockysurf-bbmi).
   */
  webPort?: number
  /**
   * What this pack asks the user for at create time (issue #189).
   *
   * Absent for a pack that asks for nothing, which is every pack shipped today — so the
   * create form's inputs section exists only when there is something in it.
   */
  inputs?: PackInput[]
  /**
   * Where the pack came from, in core's words (rockysurf-jn71).
   *
   *  - `official` — shipped with this Rocky Surf release, i.e. backed by a `packs/*.yaml`;
   *  - `registry` — the operator installed it from a pack registry;
   *  - `local` — created or YAML-imported in this installation.
   *
   * Derived server-side and REQUIRED, because the public list computes it for every pack. The
   * Surge Pack picker groups the last two under "Community"; that grouping is this app's, and
   * core deliberately does not make it — a pack the operator wrote themselves is not somebody
   * else's work, and `local` is the value that says so.
   *
   * This replaces a `sourceFile?: string | null` that used to be declared here. It was never
   * populated on this route — the public projection has always withheld the path on disk — so
   * anything branching on it typechecked, read `undefined` for every pack, and was silently
   * wrong. There is no path, URL, digest or trust label on the public list; the Pack Shop page
   * reads those off `AdminSurgePack`, which really does carry them.
   */
  provenance: 'official' | 'registry' | 'local'
}

export async function listSurgePacks(): Promise<SurgePack[]> {
  return request<SurgePack[]>('/surge-packs')
}

export interface Tool {
  toolId: string
  name: string
  description: string
  category: 'agent' | 'base'
  url: string
  /**
   * Installed on every box, whichever pack was chosen (issue #295).
   *
   * On the PUBLIC tool so the create page can be honest about what it is about to install: a
   * box gets its pack's tools plus these, so a preview built from the pack alone understates
   * it. Never part of a pack file or a tool file — it is a fact about this installation, not
   * about the tool (ADR-0020).
   */
  alwaysInstall: boolean
}

export async function listTools(): Promise<Tool[]> {
  return request<Tool[]>('/tools')
}

/* ----------------------------------------------------------------------------- admin */

export interface AdminTool extends Tool {
  installScript: string
  /* `alwaysInstall` is inherited from `Tool` — see the note there. */
  setupScript?: string
  enabled: boolean
  installOrder: number
  bootstrap: boolean
  runAs: 'root' | 'rocky'
  /**
   * Which `packs/*.yaml` defined this tool, or undefined when it was created in the admin UI.
   *
   * Files are the source of truth for shipped packs and the database is a cache and edit
   * layer (ADR-0004), so a file-backed row is overwritten from its file on the next boot. The
   * UI shows this rather than letting an operator make an edit that quietly disappears.
   */
  sourceFile?: string
}

export interface AdminSurgePack {
  packId: string
  name: string
  tools: string[]
  /** The pack this one was forked from. See `SurgePack.derivedFromPackId`. */
  derivedFromPackId?: string
  displayOrder: number
  enabled: boolean
  imageUrl?: string
  theme?: string
  /** The pack's post-boot instructions. See `SurgePack.guide`. */
  guide?: string
  requiresRepos: boolean
  requiresRdp: boolean
  desktop?: 'xfce'
  /** Loopback port of the pack's web UI. See `SurgePack.webPort`. */
  webPort?: number
  /**
   * What this pack asks the person creating a server for. See `SurgePack.inputs`.
   *
   * Core has always sent this on the admin projection; it was missing from this type, which
   * meant a fork of a pack that declares inputs would silently drop the declaration and give
   * the copy a create form with no fields (issue #295).
   */
  inputs?: PackInput[]
  /**
   * The YAML file this pack came from, or null for a row created here.
   *
   * File-backed rows are owned by the repository: the boot sync rewrites them from disk
   * (ADR-0004), so an edit made in this UI would silently disappear on the next start. The
   * admin UI shows those read-only for that reason.
   *
   * NON-NULL ALSO MEANS OFFICIAL. Under the split horizon (ADR-0006), the packs a release ships
   * are exactly the ones backed by a file — a registry install lands as a database row with this
   * null and its origin in `registry` below.
   */
  sourceFile?: string | null
  /**
   * Where a pack installed from a registry came from, or null.
   *
   * A SEPARATE FIELD from `sourceFile` rather than another spelling of it. Registry packs keep
   * `sourceFile` null — that is what stops the boot reconcile from deleting them — so a UI
   * reading provenance out of `sourceFile` would show every installed pack as "database" and
   * lose where it came from entirely.
   *
   * `trust` is snapshotted at install: it records what the operator believed when they
   * consented, not what their config says today.
   */
  registry?: {
    source: string
    url: string | null
    sha256: string | null
    trust: string | null
    installedAt: string | null
  } | null
}

export async function listAdminTools(): Promise<AdminTool[]> {
  return request<AdminTool[]>('/admin/tools')
}

export async function deleteAdminTool(toolId: string): Promise<void> {
  await request<void>(`/admin/tools/${toolId}`, { method: 'DELETE' })
}

export async function createAdminTool(tool: Partial<AdminTool>): Promise<AdminTool> {
  return request<AdminTool>('/admin/tools', { method: 'POST', body: JSON.stringify(tool) })
}

export async function getAdminTool(toolId: string): Promise<AdminTool> {
  return request<AdminTool>(`/admin/tools/${toolId}`)
}

export async function updateAdminTool(toolId: string, updates: Partial<AdminTool>): Promise<AdminTool> {
  return request<AdminTool>(`/admin/tools/${toolId}`, { method: 'PUT', body: JSON.stringify(updates) })
}

export async function listAdminSurgePacks(): Promise<AdminSurgePack[]> {
  return request<AdminSurgePack[]>('/admin/surge-packs')
}

export async function createAdminSurgePack(pack: Partial<AdminSurgePack>): Promise<AdminSurgePack> {
  return request<AdminSurgePack>('/admin/surge-packs', { method: 'POST', body: JSON.stringify(pack) })
}

export async function getAdminSurgePack(packId: string): Promise<AdminSurgePack> {
  return request<AdminSurgePack>(`/admin/surge-packs/${packId}`)
}

export async function updateAdminSurgePack(
  packId: string,
  updates: Partial<AdminSurgePack>,
): Promise<AdminSurgePack> {
  return request<AdminSurgePack>(`/admin/surge-packs/${packId}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  })
}

/* ------------------------------------------------------------------------------ costs */

/**
 * The read-only spend view (rockysurf-hzi7.4). There is no billing API and never will be:
 * this installation spends the operator's own cloud budget, so the only questions are what it
 * has cost so far and how close the configured cap is.
 */
export interface ServerCost {
  id: string
  name: string
  provider: string
  status: string
  totalUptimeSeconds: number
  hourlyCost: { amount: number; currency: string } | null
  estimatedTotalCost: number
  currency: string | null
  /** When the price behind these numbers was fetched. */
  pricedAt: string | null
}

export interface CostsResponse {
  monthToDate: { month: string; byCurrency: Record<string, number>; unpricedServers: number }
  lifetime: { byCurrency: Record<string, number> }
  limits: { maxServers: number; spendCap: { amount: number; currency: string } | null }
  cap: { overCap: boolean; amount?: number; currency?: string; fraction?: number }
  servers: ServerCost[]
  /** Most recent price fetch per provider, for the honesty line. */
  pricedAtByProvider: Record<string, string>
  estimateNote: string
}

export async function getCosts(): Promise<CostsResponse> {
  return request<CostsResponse>('/costs')
}

/* ------------------------------------------------------------------------- first run */

/** Where a provider's credential comes from. Informational: the wizard edits none of them. */
export type CredentialSource = 'env' | 'config' | 'none'

export interface ProviderSetupState {
  id: string
  displayName: string
  enabled: boolean
  configured: boolean
  source: CredentialSource
  /** The environment variable currently supplying the credential, when `source` is `'env'`. */
  envVar?: string
  /** Present in this process's registry, so it can actually be used. */
  loaded: boolean
  /** Why an enabled provider did not load, in the provider's own words. Implies `!loaded`. */
  unavailableReason?: string
}

export interface SetupState {
  /** At least one provider is enabled AND loaded — the app can create servers. */
  complete: boolean
  /** No provider is enabled at all — the state the wizard exists for. */
  needsProvider: boolean
  providers: ProviderSetupState[]
}

export async function getSetupState(): Promise<SetupState> {
  return request<SetupState>('/setup')
}

/**
 * Switch a cloud on (issue #280). The one write the wizard makes: `providers.<id>.enabled` in
 * the config file, which this process adopts before answering. NO CREDENTIAL EVER RIDES ALONG
 * — the route refuses one by name — because every cloud authenticates through the user's own
 * auth path: an environment variable for Hetzner, the standard chains for AWS, Azure and GCP.
 */
export async function enableProvider(providerId: string): Promise<SetupState> {
  const { setup } = await request<{ ok: boolean; setup: SetupState }>(`/setup/providers/${providerId}`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  return setup
}

/* --------------------------------------------------------------------------- settings */

/**
 * The config file, as the settings editor is allowed to see it (rockysurf-m29b).
 *
 * `values` is the FILE's own tree — uninterpolated, so a `${VAR}` is still a `${VAR}` — with
 * every secret-classified field replaced by one of three states. A literal token never crosses
 * this boundary, which is why `SecretView` has no field that could hold one.
 */
export type SecretView =
  | { secret: true; state: 'unset' }
  | { secret: true; state: 'reference'; reference: string }
  | { secret: true; state: 'set' }

export interface SettingsField {
  /** Dotted path; `*` stands for a list index. */
  path: string
  /** `group` is a whole optional block — `limits.spendCap` — written and removed as one. */
  kind: 'string' | 'number' | 'boolean' | 'secret' | 'stringList' | 'group'
  writable: boolean
  /** What the setting is for, in operator language. Rendered under every label (rockysurf-5qzg). */
  help: string
  /** Why the editor will not write this field. Present exactly when `writable` is false. */
  reason?: string
  /** A footgun worth naming next to the control. */
  warning?: string
  /**
   * Known to the server, never drawn by the page: a field whose only message would be "you
   * cannot use this" (rockysurf-5qzg). A save that names it is still refused, with `reason`.
   */
  hidden?: true
  /**
   * What a credential box takes: a pasted token, or the NAME of an environment variable
   * (rockysurf-7fyf.2). Absent means `'envVarName'`, which is rockysurf-4o3o's standing rule and
   * still governs every credential except the two GitHub PATs.
   */
  accepts?: 'literal' | 'envVarName'
  /**
   * When a saved value starts being used (issue #264).
   *
   * `'save'` is the answer for nearly everything: core re-reads the file the moment this page
   * writes it and adopts what it finds. `'restart'` is the small remainder, and
   * `restartReason` is core's own sentence about why — printed beside the control rather than
   * summarised into a banner over the whole page.
   */
  appliesAt: 'save' | 'restart'
  /** Why this one cannot change while Rocky Surf runs. Present when `appliesAt` is 'restart'. */
  restartReason?: string
}

/** A section of the page, with the words for what the whole section is about. */
export interface SettingsSection {
  /** The config path the section covers, and the id the page addresses it by. */
  id: string
  title: string
  help: string
}

export interface SettingsList {
  path: string
  itemFields: string[]
}

export interface SettingsView {
  file: { path: string; exists: boolean; mtimeMs: number | null }
  /** The file's values, secrets masked. Keys absent from the file are absent here. */
  values: Record<string, unknown>
  /** What the loader uses for anything the file does not say. */
  defaults: Record<string, unknown>
  fields: SettingsField[]
  sections: SettingsSection[]
  lists: SettingsList[]
  /** Present when the file on disk does not validate — the state this editor exists to fix. */
  issues?: { path: string; message: string }[]
  /**
   * Present when the file is valid but names environment variables the running core cannot see
   * (rockysurf-1z5q). Saving a reference before exporting the variable is the workflow this
   * page prescribes, so this is not a failure — it is the sentence saying what has to happen
   * before the restart, and it stays on every read until it does.
   */
  warnings?: { path: string; message: string; variable: string }[]
  /**
   * True when one of the restart-required settings has been saved and not yet restarted into
   * (issue #264). Narrower than it used to be: everything else is applied on save, so a save is
   * no longer a reason for a banner.
   */
  drifted: boolean
  /** Exactly which of them are waiting, with core's reason for each. */
  pendingRestart: { path: string; reason: string }[]
  restartHint: string
  /**
   * The same sentence in runs, with the ones the operator types or copies flagged (#232). Core
   * decides which those are; the page only decides that a flagged run is <code>. Without this
   * the page would have to hunt for `./start.sh` inside core's prose to mark it up.
   */
  restartHintSegments: { text: string; code?: boolean }[]
}

/**
 * One edit. Omitting a field means "leave it as it is", which is what makes secrets write-only:
 * a token the operator did not retype is not in the payload and so is not written.
 */
export interface SettingsChange {
  path: (string | number)[]
  value?: unknown
  unset?: true
}

export async function getSettings(): Promise<SettingsView> {
  return request<SettingsView>('/settings')
}

/**
 * Save, guarded by the mtime the caller last read.
 *
 * A 409 means the file changed underneath — someone edited it by hand, or another tab saved —
 * and nothing was written. The caller re-reads rather than retrying with the same token.
 */
/** What a save did, over the paths it carried (issue #264). */
export interface SettingsSaveResult extends SettingsView {
  saved: true
  /** The paths in this save that the running process is already using. */
  applied: string[]
  /** The paths in this save that wait for a restart, each with core's reason. */
  restartRequired: { path: string; reason: string }[]
  /** Present when core could not adopt the file at all — the sentence says why. */
  reloadBlocked?: string
}

export async function saveSettings(mtimeMs: number | null, changes: SettingsChange[]): Promise<SettingsSaveResult> {
  return request<SettingsSaveResult>('/settings', {
    method: 'PUT',
    body: JSON.stringify({ mtimeMs, changes }),
  })
}

/* ---------------------------------------------------------------------- connect github */

/**
 * The Connect GitHub device flow (rockysurf-7fyf.2), which is four calls to CORE and none to
 * GitHub.
 *
 * THE BROWSER NEVER TALKS TO GITHUB. Core holds the device code — whoever has it can redeem the
 * pending grant — and polls github.com itself, so the page only ever sees an opaque `flowId` and
 * a status. That is also what makes these tests honest: mocking this module mocks the whole
 * flow, because there is no second network path to forget about.
 */
export interface GithubConnection {
  /** False when `github.oauth.clientId` is unset — the card renders disabled, not hidden. */
  clientIdConfigured: boolean
  connected: boolean
  /** Null when GitHub would not say whose token it is; absent when not connected. */
  login?: string | null
  scopes?: string[]
  connectedAt?: string
  /** True when `github.pat` is also set in the file, so the page can name the winner. */
  configFallbackSet: boolean
}

export interface GithubDeviceFlowStart {
  flowId: string
  /** What the operator types on github.com. */
  userCode: string
  verificationUri: string
  expiresInSeconds: number
  intervalSeconds: number
}

export type GithubPollResult =
  | { status: 'pending'; intervalSeconds: number; slowDown?: boolean; message: string }
  | { status: 'connected'; login: string | null; scopes: string[]; connectedAt: string; message?: string }
  | { status: 'denied'; message: string }
  | { status: 'expired'; message: string }
  | { status: 'error'; githubCode?: string; message: string }

export interface GithubDisconnected {
  disconnected: true
  /** False when there was nothing stored — disconnecting twice is not an error. */
  removed: boolean
  message: string
}

export async function getGithubConnection(): Promise<GithubConnection> {
  return request<GithubConnection>('/github/connection')
}

export async function startGithubConnect(): Promise<GithubDeviceFlowStart> {
  return request<GithubDeviceFlowStart>('/github/connect', { method: 'POST' })
}

export async function pollGithubConnect(flowId: string): Promise<GithubPollResult> {
  return request<GithubPollResult>(`/github/connect/${encodeURIComponent(flowId)}/poll`, { method: 'POST' })
}

export async function disconnectGithub(): Promise<GithubDisconnected> {
  return request<GithubDisconnected>('/github/connection', { method: 'DELETE' })
}

/** The rendered YAML for one pack, as the export route returns it. */
export async function exportSurgePackYaml(packId: string): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/admin/surge-packs/${packId}/export`, {
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    credentials: 'include',
  })
  if (!response.ok) throw new ApiError(response.status, response.statusText)
  return response.text()
}

/**
 * Import a pack from YAML text or from a URL core fetches on the caller's behalf.
 *
 * SSRF: the URL path makes the CONTROL PLANE issue the request, not the browser, so it can
 * reach anything core can reach — link-local metadata endpoints included. It is admin-only and
 * http/https-restricted today, and rockysurf-ftl9.9 tracks the allowlist or egress policy it
 * needs before release. This call site may have to change or disappear; the file-upload path
 * beside it does not have the problem, because the bytes come from the operator's own disk.
 */
export async function importSurgePack(source: { yaml: string } | { url: string }): Promise<AdminSurgePack> {
  return request<AdminSurgePack>('/admin/surge-packs/import', { method: 'POST', body: JSON.stringify(source) })
}

export async function deleteAdminSurgePack(packId: string): Promise<void> {
  return request<void>(`/admin/surge-packs/${packId}`, { method: 'DELETE' })
}

/** The rendered YAML for ONE tool, as the tool export route returns it (issue #289). */
export async function exportToolYaml(toolId: string): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/admin/tools/${toolId}/export`, {
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    credentials: 'include',
  })
  if (!response.ok) throw new ApiError(response.status, response.statusText)
  return response.text()
}

/**
 * Import tools from a pasted or uploaded tool file.
 *
 * NO URL ARM, unlike `importSurgePack` above — and that is the point rather than an omission.
 * A pack records where a URL import came from; the tools table has no provenance columns, so a
 * URL import would install root-running shell while being unable to say where it had been.
 */
export async function importTools(yaml: string): Promise<AdminTool[]> {
  return request<AdminTool[]>('/admin/tools/import', { method: 'POST', body: JSON.stringify({ yaml }) })
}

/* --------------------------------------------------------------------------- pack shop */

/**
 * The pack registries (rockysurf-arym.5, issue #9).
 *
 * SPLIT HORIZON, which is the thing to hold on to while reading these types. Official packs
 * ship inside the Rocky Surf release and never appear in a registry; a registry holds community
 * packs, and the label on them is the one the OPERATOR wrote next to that registry in their own
 * config file. Nothing a registry publishes says how far it should be trusted — see ADR-0006.
 */

/** What the operator's config says a registry is. `official` is deliberately not a value. */
export type RegistryTrust = 'community' | 'internal'

export interface RegistryPack {
  packId: string
  name: string
  description: string
  path: string
  sha256: string
  /** Tool ids this pack file introduces. */
  definesTools: string[]
  /** Tool ids it uses but does not define; they must resolve against the local catalogue. */
  referencesTools: string[]
  requiresRepos: boolean
  requiresRdp: boolean
  /** The configured source's name — how an installed pack is attributed. */
  sourceName: string
  trust: RegistryTrust
  /** Whether a pack with this id is already in the catalogue, so the button can say so. */
  installed: boolean
}

/** One configured registry: its packs, or its own reason for having none. */
export interface RegistryShelf {
  source: { name: string; url: string; trust: RegistryTrust }
  packs: RegistryPack[]
  fetchedAt: string | null
  /**
   * Present when this registry could not be read. Reported per shelf rather than for the whole
   * request, because one registry being down must not render as a shop that looks empty — an
   * operator needs to know WHICH shelf is empty and why.
   */
  failure: { kind: string; reason: string } | null
}

export interface PackRegistry {
  enabled: boolean
  sources: Array<{ name: string; url: string; trust: RegistryTrust }>
  shelves: RegistryShelf[]
}

export async function getPackRegistry(options: { refresh?: boolean } = {}): Promise<PackRegistry> {
  return request<PackRegistry>(`/admin/pack-registry${options.refresh ? '?refresh=1' : ''}`)
}

/** One tool's contribution to an install, as the operator will read it before consenting. */
export interface ToolDisclosure {
  toolId: string
  name: string
  description: string
  url: string
  runAs: string
  installOrder: number
  /** Rendered as TEXT, never as markup. This is arbitrary shell that will run on a box. */
  installScript: string
  setupScript?: string
  fetchesUrls: string[]
}

export interface PackDisclosure {
  packId: string
  name: string
  tools: ToolDisclosure[]
  /** Tool ids this installation cannot resolve. A pack with any of these would half-install. */
  referencesTools: string[]
  rootStepCount: number
  fetchesUrls: string[]
  guide?: string
  requiresRepos: boolean
  requiresRdp: boolean
  desktop?: string
  /**
   * What this pack will ask the user for at create time (issue #189) — names, labels and
   * whether each is required and secret. Never a value: a `default` is deliberately not part of
   * this projection, because the question a reader is answering here is "what will I be asked",
   * not "what will be sent".
   *
   * Optional on the wire so a disclosure served by an older core still parses.
   */
  inputs?: Array<{ name: string; label: string; required: boolean; secret: boolean }>
  /**
   * ALWAYS FALSE, and the UI must render the caveat rather than the value.
   *
   * The URL list is a pattern match over shell, so a script that builds a URL from variables
   * contributes nothing to it. The scripts above are the ground truth; the summary is a reading
   * aid. A page that shows the summary without saying this is telling the operator they have
   * seen everything, and they have not.
   */
  summaryIsComplete: false
}

export interface RegistryPackDetail {
  entry: RegistryPack
  /** The exact bytes whose sha256 was verified against the registry's index. */
  yaml: string
  disclosure: PackDisclosure
}

export async function getRegistryPack(sourceName: string, packId: string): Promise<RegistryPackDetail> {
  return request<RegistryPackDetail>(
    `/admin/pack-registry/${encodeURIComponent(sourceName)}/${encodeURIComponent(packId)}`,
  )
}

/**
 * Install a pack from a registry.
 *
 * Sends only the ADDRESS of the pack, never its bytes. Core refetches and re-verifies the
 * digest, so what reached the disclosure screen cannot decide what actually runs as root.
 */
export async function installRegistryPack(sourceName: string, packId: string): Promise<AdminSurgePack> {
  return request<AdminSurgePack>(
    `/admin/pack-registry/${encodeURIComponent(sourceName)}/${encodeURIComponent(packId)}/install`,
    { method: 'POST' },
  )
}
