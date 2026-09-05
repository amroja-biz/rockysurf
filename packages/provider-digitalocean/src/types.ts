/**
 * DigitalOcean API v2 wire types — only the fields this provider reads.
 *
 * Transcribed from DigitalOcean's public OpenAPI description
 * (https://github.com/digitalocean/openapi, `specification/resources/…`), read on 2026-09-04.
 * Kept deliberately partial: modelling fields nobody uses invites drift with an API that adds
 * them faster than we read them.
 */

/**
 * The shared error body. `id` is documented as "A short identifier corresponding to the HTTP
 * status code returned" — so it is a restatement of the status, not a machine-readable reason,
 * which is what `errors.ts` has to work around.
 */
export interface DoErrorBody {
  id: string
  message: string
  request_id?: string
}

/** `links.pages.next` is the whole of DigitalOcean's pagination contract. */
export interface DoPagination {
  links?: { pages?: { next?: string | null } } | null
}

/**
 * A droplet's status. Four words, and one of them collides with this SDK's vocabulary in the
 * dangerous direction — see `DROPLET_STATE` in `provider.ts`.
 */
export type DoDropletStatus = 'new' | 'active' | 'off' | 'archive'

export interface DoNetworkV4 {
  ip_address: string
  netmask?: string
  gateway?: string
  /** `public` or `private`. A droplet in a VPC has both, and only the public one is reachable. */
  type: 'public' | 'private'
}

export interface DoDroplet {
  id: number
  name: string
  status: DoDropletStatus
  networks?: { v4?: DoNetworkV4[] | null; v6?: unknown[] | null } | null
  size_slug?: string
  region?: { slug?: string } | null
  tags?: string[] | null
  created_at?: string
}

/**
 * A droplet size.
 *
 * There is NO `architecture` field, which is the API's own way of saying what
 * `docs/providers/capability-matrix.md` records: DigitalOcean sells no arm64 droplets.
 */
export interface DoSize {
  slug: string
  memory: number
  vcpus: number
  disk: number
  transfer?: number
  price_monthly?: number
  /** Hourly price in US dollars, inline on the very call `listOfferings()` makes. */
  price_hourly?: number
  /** The region slugs this size can be created in. */
  regions?: string[] | null
  /** "whether new Droplets can be created with this size". */
  available?: boolean
  description?: string
}

/** An asynchronous operation. Every droplet action returns one. */
export interface DoAction {
  id: number
  status: 'in-progress' | 'completed' | 'errored'
  type?: string
  resource_id?: number | null
}

export interface DoSshKey {
  id: number
  fingerprint: string
  public_key?: string
  name: string
}

/**
 * One inbound rule of a cloud firewall.
 *
 * `{ protocol, ports, sources }` and nothing else — there is no `name` and no `description`
 * anywhere on a rule, which is the whole reason this provider is a whole-object-authorship
 * cloud under ADR-0021's amendment.
 */
export interface DoInboundRule {
  protocol: 'tcp' | 'udp' | 'icmp'
  ports: string
  sources: {
    addresses?: string[]
    droplet_ids?: number[]
    load_balancer_uids?: string[]
    kubernetes_ids?: string[]
    tags?: string[]
  }
}

export interface DoOutboundRule {
  protocol: 'tcp' | 'udp' | 'icmp'
  ports: string
  destinations: {
    addresses?: string[]
    droplet_ids?: number[]
    load_balancer_uids?: string[]
    kubernetes_ids?: string[]
    tags?: string[]
  }
}

export interface DoFirewall {
  id: string
  name: string
  status?: 'waiting' | 'succeeded' | 'failed'
  inbound_rules?: DoInboundRule[] | null
  outbound_rules?: DoOutboundRule[] | null
  droplet_ids?: number[] | null
  tags?: string[] | null
}
