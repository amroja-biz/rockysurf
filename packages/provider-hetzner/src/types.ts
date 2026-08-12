/**
 * Hetzner Cloud API v1 wire types — only the fields this provider reads.
 *
 * Transcribed from the official OpenAPI description (https://docs.hetzner.cloud/cloud.spec.json).
 * Kept deliberately partial: modelling fields nobody uses invites drift with an API that adds
 * them faster than we read them.
 */

export interface HetznerErrorBody {
  error: { code: string; message: string; details?: unknown }
}

export interface HetznerPagination {
  meta?: { pagination?: { next_page: number | null } }
}

export interface HetznerPrice {
  location: string
  price_hourly: { net: string; gross: string }
  price_monthly?: { net: string; gross: string }
}

export interface HetznerServerTypeLocation {
  id?: number
  name: string
  /**
   * Whether this type can be ordered in this location RIGHT NOW.
   *
   * Availability lives ONLY here. `prices[]` still lists locations where the type is sold out
   * — measured on 2026-08-11, every CAX (arm64) type carried prices for fsn1/hel1/nbg1 while
   * being available in none of them, and a direct order attempt in each returned
   * 412 `resource_unavailable`. Filtering on "has a price here" advertises machines that
   * cannot be bought.
   */
  available: boolean
  recommended?: boolean
  deprecation?: { unavailable_after?: string; announced?: string } | null
}

export interface HetznerServerType {
  id: number
  name: string
  description?: string
  cores: number
  memory: number
  disk: number
  /** Per-TYPE deprecation. Note that Hetzner also deprecates per LOCATION; see locations[]. */
  deprecated: boolean
  architecture: 'x86' | 'arm'
  cpu_type?: 'shared' | 'dedicated'
  prices: HetznerPrice[]
  locations?: HetznerServerTypeLocation[]
}

export type HetznerServerStatus =
  | 'running'
  | 'initializing'
  | 'starting'
  | 'stopping'
  | 'off'
  | 'deleting'
  | 'migrating'
  | 'rebuilding'
  | 'unknown'

export interface HetznerServer {
  id: number
  name: string
  status: HetznerServerStatus
  public_net: {
    ipv4: { id?: number; ip: string; dns_ptr?: string } | null
    ipv6?: { ip: string } | null
  } | null
  server_type: { name: string } | null
  labels: Record<string, string>
  created?: string
}

export interface HetznerSshKey {
  id: number
  name: string
  fingerprint: string
  labels: Record<string, string>
}

export interface HetznerAction {
  id: number
  command?: string
  status?: 'running' | 'success' | 'error'
  error?: { code: string; message: string } | null
}
