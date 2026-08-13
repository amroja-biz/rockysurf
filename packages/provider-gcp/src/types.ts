/**
 * The slices of the Compute Engine v1 resources this provider actually reads.
 *
 * Deliberately partial. These are hand-written from the published discovery document
 * (`https://www.googleapis.com/discovery/v1/apis/compute/v1/rest`) rather than generated,
 * because the generated surface is the 110MB client this package exists to avoid — and because
 * a provider that reads eleven endpoints does not need a type for all 1,300 of them.
 *
 * Everything is optional, which is not laziness: these come off the wire as JSON, so the
 * compiler's opinion about them is a claim about a remote server rather than a fact. The
 * provider narrows at the point of use and reports `unknown` rather than guessing.
 */

/** `GET /projects/{p}/zones/{z}/instances/{name}` */
export interface GceInstance {
  id?: string
  name?: string
  /** See STATE_MAP in provider.ts — GCE's `TERMINATED` is the SDK's `stopped`, not `terminated`. */
  status?: string
  statusMessage?: string
  zone?: string
  machineType?: string
  labels?: Record<string, string>
  tags?: { items?: string[]; fingerprint?: string }
  metadata?: { fingerprint?: string; items?: { key?: string; value?: string }[] }
  networkInterfaces?: {
    networkIP?: string
    accessConfigs?: { natIP?: string; name?: string; type?: string }[]
  }[]
  selfLink?: string
  creationTimestamp?: string
}

/** One item from a failed operation or an HTTP error body. */
export interface GceErrorDetail {
  /** Present on HTTP error bodies. */
  reason?: string
  /** Present on Operation errors, in a separate SCREAMING_SNAKE vocabulary. */
  code?: string
  message?: string
  location?: string
}

/**
 * A zonal or global Operation.
 *
 * Every mutating call in this provider returns one of these rather than the resource, which is
 * the single biggest structural difference from both EC2 and Hetzner: HTTP 200 means ACCEPTED,
 * not DONE, and the failure — out of stock, over quota, name taken — arrives in `error` on a
 * later poll.
 */
export interface GceOperation {
  name?: string
  /** `PENDING` | `RUNNING` | `DONE`. Only `DONE` says anything about success. */
  status?: string
  operationType?: string
  targetLink?: string
  targetId?: string
  /** Present on a DONE operation that failed. */
  error?: { errors?: GceErrorDetail[] }
  httpErrorStatusCode?: number
  httpErrorMessage?: string
  statusMessage?: string
  zone?: string
  region?: string
  selfLink?: string
}

/** `GET /projects/{p}/zones/{z}/instances` */
export interface GceInstanceList {
  items?: GceInstance[]
  nextPageToken?: string
}

/** `GET /projects/{p}/global/firewalls` */
export interface GceFirewall {
  id?: string
  name?: string
  network?: string
  sourceRanges?: string[]
  targetTags?: string[]
  allowed?: { IPProtocol?: string; ports?: string[] }[]
  description?: string
  selfLink?: string
}

export interface GceFirewallList {
  items?: GceFirewall[]
  nextPageToken?: string
}

/** `GET /projects/{p}/zones/{z}` — the cheapest authenticated call this provider makes. */
export interface GceZone {
  name?: string
  status?: string
  region?: string
}

/** The HTTP error body shape: `{ error: { code, message, errors: [...] } }`. */
export interface GceErrorBody {
  error?: {
    code?: number
    message?: string
    errors?: GceErrorDetail[]
    status?: string
  }
}
