import { createHash } from 'node:crypto'
import {
  assertHostnameSafeId,
  DESCRIBE_ABSENCE_GRACE,
  ProviderError,
  type ComputeProvider,
  type InstanceState,
  type InstanceView,
  type ManagedResource,
  type Offering,
  type ProviderCapabilities,
  type ProviderData,
  type ProvisionResult,
  type ProvisionSpec,
  type SshAccessSyncOptions,
  type SshAccessSyncResult,
} from '@rockysurf/provider-sdk'
import { DigitaloceanApi } from './api.js'
import { resolveSshCidrs, type DigitaloceanProviderConfig } from './config.js'
import { isNotFound } from './errors.js'
import { decodeTags, encodeTag, encodeTags } from './tags.js'
import type {
  DoAction,
  DoDroplet,
  DoDropletStatus,
  DoFirewall,
  DoInboundRule,
  DoOutboundRule,
  DoSize,
  DoSshKey,
} from './types.js'

/**
 * `@rockysurf/provider-digitalocean` — DigitalOcean droplets, as plain REST calls.
 *
 * Written by running the `add-provider` skill's research protocol against DigitalOcean's own
 * documentation (read 2026-09-04) and mapping every answer to a capability, a field or a setting.
 * Three of those answers are the reason this package exists at all, and each one is a rule
 * somewhere below rather than a comment:
 *
 *  - **A powered-off droplet bills at the full rate.** "You are still billed for bundled-plan CPU
 *    Droplets that are powered off because the compute resources stay reserved on the
 *    hypervisor… To end billing, destroy the Droplet." There is no `deallocate`-shaped action, so
 *    before ADR-0025 both available answers were lies: `stop: true` stopped core's meter while the
 *    cloud kept charging, and `stop: false` denied a capability the API plainly has.
 *    `billsWhileStopped: true` is the honest one.
 *  - **A firewall rule carries no proof of who wrote it.** An inbound rule is
 *    `{ protocol, ports, sources }` and nothing else — no name, no description — so the AWS
 *    ingress stamp and the GCP rule description have no equivalent here. ADR-0021's amendment
 *    rules that authorship belongs to the whole firewall object Rocky Surf created and named, and
 *    `syncSshAccess()` below converges it in ONE write, with `reported` and `removable` always
 *    empty. Azure is the shape it copies.
 *  - **Tags are flat strings with no `=`.** `managed-by=rockysurf` cannot be written, so `tags.ts`
 *    encodes `key:value` and refuses a value it could not round-trip.
 *
 * It is also the reference PERSONAL provider (ADR-0026): nothing in this repository imports it,
 * the composition root does not name it, and an operator installs it under `<dataDir>/providers`
 * and names it in `providers.digitalocean.package`. That is why the package declares no runtime
 * dependencies and why its build bundles the SDK's helpers into `dist/` — see the README.
 */

export const DIGITALOCEAN_PROVIDER_ID = 'digitalocean'

/**
 * Capabilities. EVERY VALUE HERE IS READ FROM DIGITALOCEAN'S DOCUMENTATION AND NONE OF IT HAS
 * BEEN OBSERVED AGAINST THE REAL API — the package was written without a DigitalOcean token, and
 * `docs/providers/capability-matrix.md` daggers the whole column for that reason. The README's
 * "How to verify live" section is the three calls that turn each dagger into a measurement.
 */
const CAPABILITIES: ProviderCapabilities = {
  /**
   * `POST /v2/droplets/{id}/actions` with `type: shutdown` / `power_on`, disk intact.
   */
  stop: true,
  /**
   * "The IPv4 and IPv6 addresses assigned to a Droplet remain static for the life of the Droplet…
   * Once the Droplet is destroyed, the addresses are released back into a pool." So unlike EC2
   * there is nothing for core to re-read after a start.
   */
  ipStableAcrossStop: true,
  /**
   * REASONED, NOT MEASURED. DigitalOcean's Ubuntu images are cloud-init provisioned — "cloud-init
   * consumes the user data, which it can use to perform tasks as the root user during the
   * Droplet's first boot" — and upstream cloud-init's `cc_ssh` writes the host keys a
   * `#cloud-config` `ssh_keys:` block names, before sshd first starts. DigitalOcean documents no
   * override of that module. This is a SECURITY POSTURE rather than a feature toggle: `true`
   * promises there is no trust-on-first-use window on the connection that carries the secrets
   * file, so if a live run disproves it this becomes `false` and the matrix and README change
   * with it.
   */
  canInjectHostKeys: true,
  /**
   * 65,536 — DOCUMENTED, and not the round number it looks like.
   *
   * DigitalOcean's how-to page on user data publishes no ceiling, which is what the skill's
   * research walk-through recorded. The API reference does: the `user_data` property of the
   * droplet-create body is "A string containing 'user data' which may be used to configure the
   * Droplet on first boot… It must be plain text and may not exceed 64 KiB in size." Plain text is
   * the operative half — the document is sent as a JSON string with no base64 step, so unlike
   * Azure's `customData` there is no before-or-after-encoding ambiguity to be conservative about,
   * and the SDK's field (the ceiling on the RENDERED document, before transport encoding) is
   * exactly the documented number. `validateSpec()` enforces it before anything is created.
   */
  userDataMaxBytes: 65_536,
  generatesUserData: true,
  /**
   * One firewall object per installation, named by `firewallName`, targeting the `managed-by` tag,
   * which `syncSshAccess()` converges without provisioning anything (ADR-0021).
   */
  managesSshAccess: true,
  /**
   * The running rate, which is the only thing this flag may mean (ADR-0025). DigitalOcean charges
   * a powered-off droplet the full price and offers no reduced-rate off-state, so core keeps the
   * meter running through `stopped` and the New Server page warns before the machine exists.
   */
  billsWhileStopped: true,
}

/**
 * DigitalOcean's status vocabulary → the frozen state machine. Pinned by a test with literal
 * values, because this mapping is the single most dangerous line in any provider.
 *
 * **`off` IS `stopped`, NEVER `terminated`.** It is the word DigitalOcean uses for a droplet that
 * has been powered off with its disk intact and can be started again — and, on this cloud, one
 * that is still being charged at the full rate. Reading it as the SDK's `terminated` would tell
 * core a live, billing machine is gone, after which `terminate()` no-ops on the row and nothing
 * reaps it. `terminated` is reached by ABSENCE here, and only after the propagation grace.
 *
 * `archive` maps to `unknown` rather than to a guess: it is the state of a droplet whose disk has
 * been archived off the hypervisor, `start()` is not the call that revives it, and calling it
 * `stopped` would advertise core a resume that fails. `describe()` carries DigitalOcean's own word
 * in `failureReason` when it lands there, because that is exactly the case where a human needs the
 * cloud's untranslated vocabulary.
 */
export const DROPLET_STATE: Readonly<Record<DoDropletStatus, InstanceState>> = {
  new: 'pending',
  active: 'running',
  off: 'stopped',
  archive: 'unknown',
}

/** What this provider persists per instance. */
export interface DigitaloceanData extends ProviderData {
  /** DigitalOcean's numeric droplet id. */
  dropletId: number
  /** The droplet name, which is `spec.serverId`. Kept so a reconciler can find it without the id. */
  name: string
  /**
   * SSH key objects THIS provision created and therefore owns.
   *
   * A key matched by fingerprint to something that already existed is absent on purpose: it is
   * shared, possibly somebody else's, and reaping it with this droplet would be theft
   * (ADR-0003, D2).
   */
  ownedSshKeyIds: number[]
}

/** Parse the opaque handle, failing loudly rather than reading `undefined.dropletId` later. */
export function asDigitaloceanData(data: ProviderData): DigitaloceanData {
  const dropletId = data['dropletId']
  const name = data['name']
  if (typeof dropletId !== 'number' || typeof name !== 'string') {
    throw new ProviderError(
      'invalid_spec',
      'provider data is not a DigitalOcean handle: expected { dropletId, name }',
    )
  }
  const owned = data['ownedSshKeyIds']
  return {
    dropletId,
    name,
    ownedSshKeyIds: Array.isArray(owned) ? owned.filter((id): id is number => typeof id === 'number') : [],
  }
}

/**
 * A droplet's page in the DigitalOcean control panel.
 *
 * Unlike Hetzner, everything the URL needs is the droplet id, which every response carries — so
 * this is always available and needs no configuration.
 */
export function digitaloceanConsoleUrl(dropletId: number): string {
  return `https://cloud.digitalocean.com/droplets/${dropletId}`
}

/**
 * The name of an SSH key object this provider owns, and the only place its ownership can be
 * written down.
 *
 * DIGITALOCEAN SSH KEYS CARRY NO TAGS OR LABELS. The model is `{ id, fingerprint, public_key,
 * name }`, and `name` is documented only as "A human-readable display name". So the labels
 * Hetzner uses to answer "did a Rocky Surf make this, and for which server?" have exactly one
 * home here, and it is the display name. Encoding the same `key:value` pairs into it keeps one
 * answer to that question rather than two:
 *
 *   `managed-by:rockysurf server-id:dev-box #0`
 *
 * Whitespace-separated, so the pairs decode by the same function that decodes a droplet's tags,
 * and a key that does not carry both is not ours — which is the rule that stops a reaper deleting
 * a stranger's key, and stops `listManaged()` claiming one.
 */
export function sshKeyName(managedBy: string, serverId: string, index: number): string {
  return `${encodeTag('managed-by', managedBy)} ${encodeTag('server-id', serverId)} #${index}`
}

/** The `key:value` pairs written into an SSH key's display name, if it carries any. */
export function decodeSshKeyName(name: string): Record<string, string> {
  return decodeTags(name.split(/\s+/).filter(Boolean))
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * How long a settings save waits for DigitalOcean before giving up on it.
 *
 * `syncSshAccess()` is called from a page an operator is sitting in front of, and it can be one of
 * several providers being synced at once — so an unreachable cloud must cost that operator a
 * bounded wait and an honest message, not a request that never returns.
 */
const SSH_SYNC_DEADLINE_MS = 30_000

/**
 * Run `work`, and answer with `onExpiry()` if it has not finished in `ms`.
 *
 * The abandoned call is NOT cancelled, deliberately: a PUT already in flight may well land, and
 * aborting it mid-flight would leave the firewall in a state nobody can describe. The deadline
 * bounds what the CALLER waits for, and the result says only what this provider can honestly
 * claim — which after a timeout is "I do not know", never "applied".
 */
async function withDeadline<T>(ms: number, work: () => Promise<T>, onExpiry: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onExpiry()), ms)
  })
  try {
    return await Promise.race([work(), expiry])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** The transport, narrowed to what the provider uses, so a test can substitute one. */
export type DigitaloceanApiLike = Pick<DigitaloceanApi, 'call' | 'collect'>

/**
 * The dependency seam. `createProvider(config)` calls this with no deps, so the public contract
 * stays one-argument (`scaffold.md`, "A fake for the cloud, not a mock of your own code").
 */
export interface DigitaloceanProviderDeps {
  /** A whole transport, for a test that wants to count calls without speaking HTTP. */
  api?: DigitaloceanApiLike
  /** `fetch`, for a test that wants the REAL transport over a fake cloud. The preferred seam. */
  fetchImpl?: typeof fetch
  baseUrl?: string
  maxRetries?: number
  retryBaseMs?: number
  sleep?: (ms: number) => Promise<void>
  /** The `describe()` propagation grace. May be lengthened, never shortened. */
  grace?: { attempts: number; delayMs: number }
  /** The deadline `syncSshAccess()` gives the cloud. */
  syncDeadlineMs?: number
}

/**
 * Outbound rules that let the box reach the internet.
 *
 * NOT OPTIONAL, AND NOT A DEFAULT DIGITALOCEAN SUPPLIES. A cloud firewall with no outbound rules
 * blocks ALL outgoing traffic, so a firewall created with only the SSH inbound rule would produce
 * a droplet that cannot fetch a package, clone a repository or call home — the agent would time
 * out with nothing in the logs pointing at the firewall. AWS's default security group allows
 * egress and this one does not, which is the kind of difference that is invisible until a box is
 * silently useless.
 */
const OUTBOUND_RULES: DoOutboundRule[] = [
  { protocol: 'tcp', ports: '0', destinations: { addresses: ['0.0.0.0/0', '::/0'] } },
  { protocol: 'udp', ports: '0', destinations: { addresses: ['0.0.0.0/0', '::/0'] } },
  { protocol: 'icmp', ports: '0', destinations: { addresses: ['0.0.0.0/0', '::/0'] } },
]

/** The one inbound rule this provider writes: SSH, from exactly these networks. */
function sshInboundRule(cidrs: readonly string[]): DoInboundRule {
  return { protocol: 'tcp', ports: '22', sources: { addresses: [...cidrs] } }
}

/** The addresses a firewall's SSH rule allows right now, whatever else is on the object. */
export function sshSourcesOf(firewall: DoFirewall | undefined): string[] {
  const rules = firewall?.inbound_rules ?? []
  const out: string[] = []
  for (const rule of rules) {
    if (rule.protocol !== 'tcp' || rule.ports !== '22') continue
    for (const address of rule.sources?.addresses ?? []) if (!out.includes(address)) out.push(address)
  }
  return out
}

export function makeDigitaloceanProvider(
  config: DigitaloceanProviderConfig,
  deps: DigitaloceanProviderDeps = {},
): ComputeProvider {
  const { region, image, managedBy, firewallName, vpcUuid } = config
  const grace = deps.grace ?? DESCRIBE_ABSENCE_GRACE
  // A provider may LENGTHEN the grace and never shorten it. The guard floors `attempts` only:
  // zeroing the delay changes what a suite costs and never what it proves.
  if (grace.attempts < DESCRIBE_ABSENCE_GRACE.attempts) {
    throw new ProviderError(
      'invalid_spec',
      `a describe() grace of ${grace.attempts} attempts is below the SDK floor of ${DESCRIBE_ABSENCE_GRACE.attempts}`,
    )
  }
  const sleep = deps.sleep ?? defaultSleep
  const deadlineMs = deps.syncDeadlineMs ?? SSH_SYNC_DEADLINE_MS
  const api: DigitaloceanApiLike =
    deps.api ??
    new DigitaloceanApi({
      token: config.token,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
      ...(deps.maxRetries !== undefined ? { maxRetries: deps.maxRetries } : {}),
      ...(deps.retryBaseMs !== undefined ? { retryBaseMs: deps.retryBaseMs } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    })

  const managedByTag = encodeTag('managed-by', managedBy)

  /**
   * Droplets this provider has observed running, which is what makes the propagation grace cheap
   * where it matters: an instance seen running and now absent really is gone, so the 404 is
   * believed immediately, and the teardown loop core polls pays nothing.
   */
  const seenRunning = new Set<number>()

  /**
   * Droplets this provider has ASKED DigitalOcean to destroy.
   *
   * Recorded BEFORE the delete is issued, the way `provider-gcp` records it, so a `describe()`
   * racing the delete reads `terminating` rather than `running`. DigitalOcean has no status word
   * for a teardown in progress — a droplet is `active` right up until it is absent — so without
   * this, the window between "delete accepted" and "gone" reports a machine core would treat as
   * healthy. It is in-memory and lost on restart, which is the safe direction: after a restart
   * such a droplet reports `running` until it disappears, which is slower to converge and never
   * wrong.
   */
  const terminateRequested = new Set<number>()

  function viewOf(droplet: DoDroplet): InstanceView {
    const mapped = DROPLET_STATE[droplet.status] ?? 'unknown'
    const state: InstanceState = terminateRequested.has(droplet.id) ? 'terminating' : mapped
    if (state === 'running') seenRunning.add(droplet.id)
    const publicIp = (droplet.networks?.v4 ?? []).find((net) => net.type === 'public')?.ip_address
    return {
      state,
      ...(publicIp ? { publicIp } : {}),
      ...(droplet.size_slug ? { offeringId: droplet.size_slug } : {}),
      consoleUrl: digitaloceanConsoleUrl(droplet.id),
      // The cloud's own word, only where this SDK had nothing to map onto.
      ...(mapped === 'unknown' ? { failureReason: `DigitalOcean reports this droplet as '${droplet.status}'` } : {}),
    }
  }

  async function getDroplet(dropletId: number): Promise<DoDroplet | undefined> {
    try {
      return (await api.call<{ droplet: DoDroplet }>('GET', `/droplets/${dropletId}`)).droplet
    } catch (err) {
      if (isNotFound(err)) return undefined
      throw err
    }
  }

  const byTag = (key: string, value: string) => `/droplets?tag_name=${encodeURIComponent(encodeTag(key, value))}`

  /** The droplet a previous attempt at this same create already made, if there is one. */
  async function findByServerId(serverId: string): Promise<DoDroplet | undefined> {
    const droplets = await api.collect<DoDroplet>(byTag('server-id', serverId), 'droplets')
    return droplets[0]
  }

  /** The one firewall object this installation owns, by name. */
  async function findFirewall(): Promise<DoFirewall | undefined> {
    const firewalls = await api.collect<DoFirewall>('/firewalls', 'firewalls')
    return firewalls.find((firewall) => firewall.name === firewallName)
  }

  /**
   * Write the firewall whole, to exactly `cidrs`.
   *
   * ONE WRITE, AND IT IS THE ONLY WAY THIS CLOUD CAN CONVERGE (ADR-0021's amendment for issue
   * #294's gap S2). A DigitalOcean inbound rule has no description and no name, so there is no
   * per-CIDR authorship to consult and nothing to stamp: the provider cannot tell a range it
   * wrote from a range somebody else wrote, entry by entry. Authorship therefore belongs to the
   * whole object — one firewall, created only by a launch, named for Rocky Surf, holding only
   * SSH — and `PUT /v2/firewalls/{id}` replaces it in a single call. DigitalOcean's own note on
   * that endpoint is why the body below is complete rather than partial: "The request should
   * contain a full representation of the firewall including existing attributes. Note that any
   * attributes that are not provided will be reset to their default values."
   *
   * A firewall an operator made themselves is never the one this converges: it is found by NAME,
   * and a name that does not match is not touched.
   */
  async function putFirewall(firewall: DoFirewall, cidrs: readonly string[]): Promise<void> {
    await api.call<{ firewall: DoFirewall }>('PUT', `/firewalls/${firewall.id}`, {
      name: firewall.name,
      inbound_rules: [sshInboundRule(cidrs)],
      outbound_rules: OUTBOUND_RULES,
      droplet_ids: firewall.droplet_ids ?? [],
      // Targeting the tag rather than each droplet is what makes a new droplet protected from the
      // moment it exists, with no second call between the create and the first boot.
      tags: [managedByTag],
    })
  }

  /**
   * Make sure the firewall exists and allows AT LEAST the configured networks.
   *
   * PROVISION IS ADDITIVE AND NEVER REVOKES (ADR-0021). The write below is the union of what the
   * firewall already allows and what the config names, so a launch can only ever widen access —
   * an operator whose saved list has drifted from the cloud is never locked out by starting a box.
   * Narrowing to exactly the configured list is `syncSshAccess()`'s job, and it happens only when
   * a human asked for it.
   */
  async function ensureFirewall(): Promise<void> {
    const desired = resolveSshCidrs(config)
    const existing = await findFirewall()

    if (!existing) {
      await api.call<{ firewall: DoFirewall }>('POST', '/firewalls', {
        name: firewallName,
        inbound_rules: [sshInboundRule(desired)],
        outbound_rules: OUTBOUND_RULES,
        tags: [managedByTag],
      })
      return
    }

    const current = sshSourcesOf(existing)
    const union = [...current, ...desired.filter((cidr) => !current.includes(cidr))]
    // The tag is what makes the firewall apply to the droplet about to be created, so a firewall
    // that has lost it is rewritten even when its CIDRs already match.
    const tagged = (existing.tags ?? []).includes(managedByTag)
    if (union.length === current.length && tagged) return
    await putFirewall(existing, union)
  }

  /**
   * Find or create the SSH key object the create call must reference.
   *
   * DigitalOcean's create takes "the IDs or fingerprints of the SSH keys", not raw key material,
   * so `provision()` necessarily creates a second kind of cloud resource. A key matched by
   * fingerprint that this provider cannot prove it minted is NOT claimed as owned: it already
   * existed, it may be embedded in somebody else's droplets, and reaping it on terminate would
   * break them.
   *
   * OWNERSHIP IS DECIDED BY THE NAME, NOT BY WHOSE POST RETURNED 201. "Did my create call answer
   * 201?" is the wrong question, and Hetzner's nightly paid for asking it: `call()` retries a POST
   * whose response was lost, so a key this provision genuinely created comes back from the retry
   * as a conflict and is resolved by the lookup — and answering "not created, therefore not mine"
   * leaves an immortal key object behind, failing every subsequent zero-orphan audit.
   */
  async function ensureSshKey(
    publicKey: string,
    name: string,
  ): Promise<{ id: number; owned: boolean }> {
    const fingerprint = fingerprintOf(publicKey)
    const mintedHere = (key: DoSshKey) => {
      const pairs = decodeSshKeyName(key.name ?? '')
      return pairs['managed-by'] === managedBy && pairs['server-id'] === decodeSshKeyName(name)['server-id']
    }

    const existing = await lookupSshKey(fingerprint)
    if (existing) return { id: existing.id, owned: mintedHere(existing) }

    try {
      const created = await api.call<{ ssh_key: DoSshKey }>('POST', '/account/keys', {
        name,
        public_key: publicKey.trim(),
      })
      return { id: created.ssh_key.id, owned: true }
    } catch (err) {
      // Raced with a concurrent provision, retried past a lost response, or a leftover holds the
      // name. DigitalOcean answers 422 for a duplicate key, which `errors.ts` maps to
      // `invalid_spec`; the lookup is what tells that apart from a genuinely bad key.
      const retry = await lookupSshKey(fingerprint)
      if (retry) return { id: retry.id, owned: mintedHere(retry) }
      throw err
    }
  }

  /** `GET /v2/account/keys/{fingerprint}` — the identifier may be an id or a fingerprint. */
  async function lookupSshKey(fingerprint: string): Promise<DoSshKey | undefined> {
    try {
      return (await api.call<{ ssh_key: DoSshKey }>('GET', `/account/keys/${encodeURIComponent(fingerprint)}`)).ssh_key
    } catch (err) {
      if (isNotFound(err)) return undefined
      throw err
    }
  }

  async function deleteIgnoringNotFound(path: string): Promise<void> {
    try {
      await api.call<void>('DELETE', path)
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
  }

  /**
   * Delete keys on a path where the CALLER's failure is the thing that must reach core.
   *
   * A cleanup that throws would replace the real error — the reason the droplet was not created —
   * with whatever went wrong tidying up, and core reports that string to the operator. So a key
   * that will not delete is left for `listManaged()` to surface instead.
   */
  async function reapQuietly(keyIds: readonly number[]): Promise<void> {
    for (const keyId of keyIds) {
      try {
        await deleteIgnoringNotFound(`/account/keys/${keyId}`)
      } catch {
        /* reported by listManaged(), never raised over the original failure */
      }
    }
  }

  async function validateSpec(spec: ProvisionSpec): Promise<void> {
    // The droplet NAME is `serverId`, and the name is what a replayed create is deduped against.
    // Sanitizing would need an injective map and cannot have one, so this asserts instead.
    assertHostnameSafeId(spec.serverId)

    const declared = spec.tags['managed-by']
    if (declared !== managedBy) {
      throw new ProviderError(
        'invalid_spec',
        `spec tags managed-by='${declared ?? '(absent)'}' disagrees with this provider's '${managedBy}': ` +
          'the droplet would be invisible to listManaged() and an orphan from the moment it is created',
      )
    }

    // Throws on the first pair that cannot be written as a DigitalOcean tag — see tags.ts.
    encodeTags(spec.tags)

    if (spec.sshPublicKeys.length === 0) {
      throw new ProviderError('invalid_spec', 'at least one ssh public key is required')
    }

    const bytes = Buffer.byteLength(spec.userData, 'utf8')
    if (bytes > CAPABILITIES.userDataMaxBytes) {
      throw new ProviderError(
        'invalid_spec',
        `userData is ${bytes} bytes, over DigitalOcean's documented ${CAPABILITIES.userDataMaxBytes}-byte (64 KiB) user_data ceiling`,
      )
    }
  }

  /**
   * Issue a droplet action, treating "it is already in that state" as success.
   *
   * DigitalOcean refuses `shutdown` on a droplet that is already off, and `power_on` on one that
   * is already on, with a 422 — which `errors.ts` maps to `invalid_spec`. Core calls `stop()` on a
   * row it believes is running and reconcilers retry, so surfacing that refusal would turn a
   * converged state into an error. The state is re-read rather than assumed, so a 422 that means
   * something else still reaches the caller.
   *
   * The Action returned is NOT awaited. Every DigitalOcean action is asynchronous and `describe()`
   * is the poller core already runs; blocking here would make a fast call slow for every caller,
   * and the state it would wait for is the one `describe()` reports anyway.
   */
  async function act(dropletId: number, type: 'shutdown' | 'power_on', settled: DoDropletStatus): Promise<void> {
    try {
      await api.call<{ action: DoAction }>('POST', `/droplets/${dropletId}/actions`, { type })
    } catch (err) {
      const droplet = await getDroplet(dropletId)
      if (droplet?.status === settled) return
      throw err
    }
  }

  return {
    id: DIGITALOCEAN_PROVIDER_ID,
    displayName: 'DigitalOcean',
    capabilities: CAPABILITIES,

    async validateCredentials(): Promise<void> {
      // The cheapest authenticated call there is; a bad or read-only token fails here rather than
      // half-way through a create.
      await api.call<{ account: unknown }>('GET', '/account')

      // …and that the configured region exists and is open for business, because a token that
      // works against a region this account cannot use is not working credentials for any purpose
      // this provider has.
      const regions = await api.collect<{ slug: string; available?: boolean }>('/regions', 'regions')
      const here = regions.find((candidate) => candidate.slug === region)
      if (!here) {
        throw new ProviderError(
          'invalid_spec',
          `digitalocean region '${region}' does not exist — pick one of ${regions.map((r) => r.slug).join(', ')}`,
        )
      }
      if (here.available === false) {
        throw new ProviderError(
          'capacity',
          `digitalocean region '${region}' is not currently accepting new droplets`,
        )
      }
    },

    validateSpec,

    /**
     * Every size DigitalOcean sells in this region, including the ones it has withdrawn.
     *
     * TWO ANSWERS FROM THE RESEARCH PROTOCOL LIVE HERE.
     *
     * `arch` is `amd64` on every row, and that is not a shrug: DigitalOcean sells no arm64
     * droplets at all, and its size model has no `architecture` field to read. Reporting the
     * catalogue it does sell — rather than omitting anything — is what lets core say "this cloud
     * sells no ARM", which is a different sentence from "ARM is sold out this afternoon".
     *
     * The price is LIVE. `GET /v2/sizes` returns `price_hourly` in US dollars inline, on the very
     * call this method already makes, so the Hetzner exception applies: preferring a bundled
     * number would mean showing a figure known to be staler than one already in hand, having
     * saved no request. A missing or non-finite price is `null` — unknown, never free.
     */
    async listOfferings(): Promise<Offering[]> {
      const sizes = await api.collect<DoSize>('/sizes', 'sizes')
      const fetchedAt = new Date().toISOString()

      return sizes.flatMap<Offering>((size) => {
        // A size that does not list this region is not sold here at all, which is different from
        // sold out and is the one case where omission is right.
        if (!(size.regions ?? []).includes(region)) return []
        const price = size.price_hourly
        return [
          {
            id: size.slug,
            cpu: size.vcpus,
            // DigitalOcean reports memory in megabytes; the SDK's field is gigabytes.
            memoryGb: size.memory / 1024,
            diskGb: size.disk,
            arch: 'amd64',
            hourly:
              typeof price === 'number' && Number.isFinite(price)
                ? { amount: price, currency: 'USD', fetchedAt }
                : null,
            // Withdrawn plans keep their row and lose their availability, rather than vanishing.
            available: size.available !== false,
            region,
          },
        ]
      })
    },

    async provision(spec: ProvisionSpec): Promise<ProvisionResult> {
      // Core calls validateSpec() before this, and this must not assume it did: the create path is
      // where the committed-at-create-time failures live, and double validation is cheap.
      await validateSpec(spec)

      // Before anything is created, so a droplet is inside the firewall from its first boot rather
      // than reachable-by-nobody or reachable-by-everybody in between.
      await ensureFirewall()

      // DigitalOcean has no client-token equivalent, so dedupe is a pre-create lookup on the
      // server-id tag — the shape an API with no idempotency primitive forces.
      const replayed = await findByServerId(spec.serverId)
      if (replayed) {
        const keys = await api.collect<DoSshKey>('/account/keys', 'ssh_keys')
        const owned = keys.filter((key) => {
          const pairs = decodeSshKeyName(key.name ?? '')
          return pairs['managed-by'] === managedBy && pairs['server-id'] === spec.serverId
        })
        return {
          data: {
            dropletId: replayed.id,
            name: replayed.name,
            ownedSshKeyIds: owned.map((key) => key.id),
          } satisfies DigitaloceanData,
          initial: viewOf(replayed),
        }
      }

      const sshKeyIds: number[] = []
      const ownedSshKeyIds: number[] = []
      try {
        for (let i = 0; i < spec.sshPublicKeys.length; i++) {
          const { id, owned } = await ensureSshKey(spec.sshPublicKeys[i]!, sshKeyName(managedBy, spec.serverId, i))
          sshKeyIds.push(id)
          if (owned) ownedSshKeyIds.push(id)
        }

        const created = await api.call<{ droplet: DoDroplet }>('POST', '/droplets', {
          name: spec.serverId,
          region,
          size: spec.offeringId,
          image,
          ssh_keys: sshKeyIds,
          tags: encodeTags({ ...spec.tags, 'managed-by': managedBy }),
          backups: false,
          monitoring: false,
          ...(vpcUuid ? { vpc_uuid: vpcUuid } : {}),
          // Passed through unchanged. Base64 is not wanted here: DigitalOcean documents user_data
          // as plain text, and appending to it would break the host key core minted.
          ...(spec.userData ? { user_data: spec.userData } : {}),
        })

        return {
          data: {
            dropletId: created.droplet.id,
            name: created.droplet.name,
            ownedSshKeyIds,
          } satisfies DigitaloceanData,
          initial: viewOf(created.droplet),
        }
      } catch (err) {
        // NO DROPLET, SO NOTHING WILL EVER COME BACK FOR THE KEYS. Core's response to a throwing
        // `provision()` is to mark the row failed WITHOUT storing a handle, so the keys minted
        // above are unreachable from the database the moment this error leaves. They are
        // attributable to this server and to no other, which is what makes deleting them safe.
        await reapQuietly(ownedSshKeyIds)
        throw err
      }
    },

    /**
     * Read one droplet.
     *
     * The absence → `terminated` mapping is load-bearing for teardown polling, and the propagation
     * grace guarding it is the highest-severity rule in the SDK. DigitalOcean's create is
     * asynchronous — a droplet is `new` before it is anything else — and a read that races the
     * create can answer 404, so the grace is honoured at the SDK floor. It costs nothing where it
     * would hurt: an instance already seen running spends exactly one read.
     */
    async describe(data: ProviderData): Promise<InstanceView> {
      const { dropletId } = asDigitaloceanData(data)
      const attempts = seenRunning.has(dropletId) ? 1 : Math.max(1, grace.attempts)

      for (let attempt = 1; attempt <= attempts; attempt++) {
        const droplet = await getDroplet(dropletId)
        if (droplet !== undefined) return viewOf(droplet)
        if (attempt < attempts) await sleep(grace.delayMs)
      }

      // Absence, believed. A vanished droplet is a normal teardown outcome, never an error: core
      // polls this in a loop and throwing would make success an error path.
      terminateRequested.delete(dropletId)
      seenRunning.delete(dropletId)
      return { state: 'terminated' }
    },

    async terminate(data: ProviderData): Promise<void> {
      const { dropletId, ownedSshKeyIds } = asDigitaloceanData(data)

      // Recorded BEFORE the call that acts on it, so a describe() racing this delete reads
      // `terminating` rather than `running`.
      terminateRequested.add(dropletId)

      // Idempotent: not-found is success. A second call is a no-op, not an error.
      await deleteIgnoringNotFound(`/droplets/${dropletId}`)
      seenRunning.delete(dropletId)

      // Secondary resources this droplet owns. A crash between the two deletes leaves a key the
      // database no longer references, which is exactly what listManaged() reports.
      for (const keyId of ownedSshKeyIds) {
        await deleteIgnoringNotFound(`/account/keys/${keyId}`)
      }
    },

    /**
     * Everything attributable to this installation.
     *
     * Droplets in every state that still exists are included — a `terminating` droplet holds its
     * disk and still bills, so a reconciler must see it. The firewall is `shared`: one object
     * serves every droplet in the account, and deleting it would cut SSH to all of them at once,
     * including the operator's own box.
     */
    async listManaged(): Promise<ManagedResource[]> {
      const [droplets, keys, firewall] = await Promise.all([
        api.collect<DoDroplet>(`/droplets?tag_name=${encodeURIComponent(managedByTag)}`, 'droplets'),
        api.collect<DoSshKey>('/account/keys', 'ssh_keys'),
        findFirewall(),
      ])

      const ours = keys.filter((key) => decodeSshKeyName(key.name ?? '')['managed-by'] === managedBy)

      return [
        ...droplets.map<ManagedResource>((droplet) => {
          const serverId = decodeTags(droplet.tags)['server-id'] ?? droplet.name
          return {
            kind: 'droplet',
            providerNativeId: String(droplet.id),
            ownership: 'server-owned',
            ...(serverId ? { serverId } : {}),
          }
        }),
        ...ours.map<ManagedResource>((key) => {
          // A key with no server-id in its name is legal and is a FINDING: an owned resource
          // nobody can attribute cannot be safely reaped by server.
          const serverId = decodeSshKeyName(key.name ?? '')['server-id']
          return {
            kind: 'ssh-key',
            providerNativeId: String(key.id),
            ownership: 'server-owned',
            ...(serverId ? { serverId } : {}),
          }
        }),
        ...(firewall
          ? [{ kind: 'firewall', providerNativeId: firewall.id, ownership: 'shared' } satisfies ManagedResource]
          : []),
      ]
    },

    /**
     * ACPI shutdown, not `power_off`: both preserve the disk and only one gives the box a chance
     * to finish what it is doing, and these run an agent that may be mid-install.
     */
    async stop(data: ProviderData): Promise<void> {
      const { dropletId } = asDigitaloceanData(data)
      await act(dropletId, 'shutdown', 'off')
    },

    async start(data: ProviderData): Promise<void> {
      const { dropletId } = asDigitaloceanData(data)
      await act(dropletId, 'power_on', 'active')
      // The address survives a power cycle on DigitalOcean (`ipStableAcrossStop: true`), so unlike
      // EC2 there is nothing for core to re-read afterwards.
    },

    /**
     * Push the operator's saved whitelist at the firewall, without provisioning anything.
     *
     * WHOLE-OBJECT AUTHORSHIP, WHICH IS WHAT MAKES THIS ONE WRITE (ADR-0021, amended for issue
     * #294's gap S2). There is no per-CIDR proof to consult on this cloud, so there is no stamped
     * extra to offer back and no unstamped entry to keep: `reported` and `removable` are ALWAYS
     * empty, and removing a CIDR from the list takes effect here in a single step rather than
     * through the keep-or-remove prompt. `options.revoke` is accepted and has nothing to act on
     * for the same reason — a range is either in the configured list, and stays, or it is not, and
     * this write removes it.
     *
     * Anti-lockout is unchanged and is not weakened by any of that: the object is created ONLY by
     * a launch, never here; it is never deleted; provision is additive; and a firewall the
     * operator made themselves is never the one this touches, because it is found by name.
     */
    async syncSshAccess(_options?: SshAccessSyncOptions): Promise<SshAccessSyncResult> {
      const desired = resolveSshCidrs(config)

      return await withDeadline<SshAccessSyncResult>(
        deadlineMs,
        async () => {
          const firewall = await findFirewall()

          // A SETTINGS SAVE MUST NOT CREATE IT. Creating the firewall here would put an object
          // into the account of an operator who has only ever opened the Settings page, and the
          // honest answer is that there is nothing to update yet.
          if (!firewall) {
            return {
              status: 'skipped',
              applied: [],
              reported: [],
              removable: [],
              detail:
                `No ${firewallName} firewall exists in this DigitalOcean account yet, so there is ` +
                'nothing to update. Rocky Surf creates it at the first launch, with these networks ' +
                'already in it.',
            }
          }

          const existing = sshSourcesOf(firewall)
          await putFirewall(firewall, desired)

          const removed = existing.filter((cidr) => !desired.includes(cidr))
          const added = desired.filter((cidr) => !existing.includes(cidr))
          const changed = added.length > 0 || removed.length > 0

          return {
            status: changed ? 'updated' : 'unchanged',
            applied: desired,
            reported: [],
            removable: [],
            detail: changed
              ? `${firewallName} now allows ${desired.join(', ')} on port 22.` +
                (removed.length > 0
                  ? ` ${removed.join(', ')} no longer appears in sshAllowedCidr and was removed from the firewall.`
                  : '')
              : `${firewallName} already allowed ${desired.join(', ')} on port 22.`,
          }
        },
        () => ({
          status: 'failed',
          applied: [],
          reported: [],
          removable: [],
          detail:
            `DigitalOcean did not answer within ${Math.round(deadlineMs / 1000)}s, so Rocky Surf ` +
            `cannot say whether ${firewallName} now allows ${desired.join(', ')}. Nothing was ` +
            'deleted. Check the token is valid and the API reachable, and save again.',
        }),
      )
    },
  }
}

/**
 * The MD5 fingerprint DigitalOcean identifies an SSH key by, as `aa:bb:…` of the raw key blob.
 *
 * `GET /v2/account/keys/{identifier}` takes "either the ID or the fingerprint", which is the only
 * lookup this provider needs — there is no query-by-fingerprint on the list endpoint.
 */
export function fingerprintOf(publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/)
  const blob = parts.length > 1 ? parts[1]! : parts[0]!
  const hex = createHash('md5').update(Buffer.from(blob, 'base64')).digest('hex')
  return (hex.match(/.{2}/g) ?? []).join(':')
}
