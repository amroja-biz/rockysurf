/**
 * The API client, ported from `frontend/src/lib/api.ts`.
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

export class ApiError extends Error {
  status: number
  statusText: string
  data?: unknown

  constructor(status: number, statusText: string, data?: unknown) {
    super(`API Error: ${status} ${statusText}`)
    this.name = 'ApiError'
    this.status = status
    this.statusText = statusText
    this.data = data
  }

  /** Core's error envelope is `{ error, code }`; fall back to the status line. */
  get detail(): string {
    const body = this.data as { error?: string } | undefined
    return body?.error ?? this.statusText
  }
}

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

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers,
    credentials: 'include',
  })

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
  /** Provider id — `'aws'`, `'hetzner'`, `'byo'`. The key for a capability lookup, never a
   *  thing to branch on directly. */
  provider: string
  size: 'small' | 'medium' | 'large'
  offeringId: string
  arch: 'amd64' | 'arm64'
  status: 'requested' | 'provisioning' | 'running' | 'stopped' | 'terminated' | 'failed'
  /** The unprivileged account the user SSHes in as. */
  sshUser: string
  /** Absent unless sshd is somewhere other than 22 — a BYO machine core did not configure. */
  sshPort?: number
  bootstrapMode: 'push' | 'callback'
  hourlyCost?: Price
  estimatedTotalCost: number
  publicIp?: string
  previousIp?: string
  ipChangedAt?: string
  publicDns?: string
  tools: string[]
  packId?: string
  repositories: string[]
  provisioningStep?: ProvisioningStep
  errorMessage?: string
  createdAt: string
  startedAt?: string
  stoppedAt?: string
  terminatedAt?: string
  totalUptimeSeconds: number
}

/**
 * The list projection. Core returns the same `present()` shape for both list and detail, so
 * this is `Server` — kept as a distinct name because every page component refers to it.
 */
export interface ServerSummary {
  serverId: string
  name: string
  provider: string
  status: Server['status']
  size: Server['size']
  sshUser: string
  hourlyCost?: Price
  estimatedTotalCost: number
  publicIp?: string
  previousIp?: string
  ipChangedAt?: string
  ipChangedRecently?: boolean
  packId?: string
  packImageUrl?: string
  packName?: string
  tools: string[]
  provisioningStep?: ProvisioningStep
  createdAt: string
  startedAt?: string
  stoppedAt?: string
  terminatedAt?: string
  uptime: number
  estimatedCost: number
}

export interface CreateServerRequest {
  name?: string
  size: Server['size']
  packId: string
  /** Provider id. Omit to let core use its default. */
  provider?: string
  /**
   * The concrete offering the size resolved to.
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

export async function createServer(data: CreateServerRequest): Promise<CreateServerResponse> {
  return request<CreateServerResponse>('/servers', { method: 'POST', body: JSON.stringify(data) })
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

export async function addRepository(serverId: string, repository: string): Promise<Server> {
  return request<Server>(`/servers/${serverId}/repositories`, {
    method: 'POST',
    body: JSON.stringify({ repository }),
  })
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
}

export async function listProviders(): Promise<ProviderInfo[]> {
  return request<ProviderInfo[]>('/providers')
}

/* ------------------------------------------------------------------------ packs & tools */

export interface SurgePackTool {
  toolId: string
  name: string
  description: string
  category: 'agent' | 'base'
  url: string
}

export interface SurgePack {
  packId: string
  name: string
  displayOrder: number
  enabled: boolean
  imageUrl?: string
  theme?: string
  tools: SurgePackTool[]
  /** Added in v0.1 so the UI stops recognising one pack by name (ADR-0004). */
  requiresRepos: boolean
  requiresRdp: boolean
  desktop?: 'xfce'
  /**
   * The YAML file this pack came from, or null for a row created here.
   *
   * File-backed rows are owned by the repository: the boot sync rewrites them from disk
   * (ADR-0004), so an edit made in this UI would silently disappear on the next start. The
   * admin UI shows them read-only for that reason.
   */
  sourceFile?: string | null
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
}

export async function listTools(): Promise<Tool[]> {
  return request<Tool[]>('/tools')
}

/* ----------------------------------------------------------------------------- admin */

export interface AdminTool extends Tool {
  installScript: string
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
  displayOrder: number
  enabled: boolean
  imageUrl?: string
  theme?: string
  requiresRepos: boolean
  requiresRdp: boolean
  desktop?: 'xfce'
  /**
   * The YAML file this pack came from, or null for a row created here.
   *
   * File-backed rows are owned by the repository: the boot sync rewrites them from disk
   * (ADR-0004), so an edit made in this UI would silently disappear on the next start. The
   * admin UI shows those read-only for that reason.
   */
  sourceFile?: string | null
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

/** Where a provider's credential comes from, and therefore whether the UI may edit it. */
export type CredentialSource = 'env' | 'config' | 'stored' | 'none'

export interface ProviderSetupState {
  id: string
  displayName: string
  enabled: boolean
  configured: boolean
  source: CredentialSource
  /** Present in this process's registry, so it can actually be used. */
  loaded: boolean
  /** Set when a pasted credential would be refused, and why. */
  readOnlyReason?: string
}

export interface SetupState {
  /** At least one provider is enabled, credentialed AND loaded. */
  complete: boolean
  /** No provider is enabled at all — the state the wizard exists for. */
  needsProvider: boolean
  providers: ProviderSetupState[]
}

export async function getSetupState(): Promise<SetupState> {
  return request<SetupState>('/setup')
}

/**
 * Hand core a provider credential. Core validates it against the provider BEFORE storing, so a
 * rejection here means the credential is bad — not that it was saved and will fail later.
 */
export async function saveProviderCredential(providerId: string, token: string): Promise<SetupState> {
  const { setup } = await request<{ ok: boolean; setup: SetupState }>(`/setup/providers/${providerId}`, {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
  return setup
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
