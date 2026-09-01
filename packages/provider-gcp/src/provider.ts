import { createHash } from 'node:crypto'
import {
  DESCRIBE_ABSENCE_GRACE,
  ProviderError,
  type Architecture,
  type ComputeProvider,
  type InstanceState,
  type InstanceView,
  type ManagedResource,
  type Offering,
  type ProviderCapabilities,
  type ProviderData,
  type ProvisionResult,
  type ProvisionSpec,
  type SshAccessSyncResult,
} from '@rockysurf/provider-sdk'
import { GceApi, lastSegment } from './api.js'
import { makeAdcTokenSource, type TokenSource } from './auth.js'
import { resolveSshCidrs, type GcpProviderConfig } from './config.js'
import { isAlreadyExists, isNotFound } from './errors.js'
import { PriceFeedClient, type PriceFeedDoc } from './feed.js'
import { allowedBootDiskTypes, buildOfferings, familyOf } from './offerings.js'
import { C4A_ZONES, GCP_TYPES, T2A_ZONES } from './prices.generated.js'
import type { GceFirewall, GceInstance } from './types.js'

/**
 * Google Compute Engine, as plain REST calls.
 *
 * The shape is `provider-aws`'s: one shared firewall rule instead of one shared security group,
 * an image resolved from a public family instead of an SSM parameter, and no per-server
 * anything. What is genuinely different is on the read side, and it is the reason this file
 * spends more words on a lookup table than on the lifecycle.
 */

const CAPABILITIES: ProviderCapabilities = {
  stop: true,
  /**
   * An ephemeral external IP is released on stop and a different one assigned on start.
   *
   * The same shape as EC2 without an Elastic IP, and the same decision not to fix it: a
   * reserved static address is a per-server resource to create, tag and reap, which is one more
   * orphan class for a problem core already handles through `previousIp`/`ipChangedAt`.
   */
  ipStableAcrossStop: false,
  /**
   * cloud-init's GCE datasource reads the `user-data` metadata key, so `ssh_keys:` places a
   * core-minted host key before the box's first boot.
   *
   * MEASURED. This package was built without GCP credentials, so this value was read from
   * documentation until `rockysurf-ev41.8` ran it against real Compute Engine on 2026-08-14:
   * boxes on both architectures presented exactly the fingerprint core minted on first contact,
   * the same evidence the other clouds' `true` rests on. The failure this comment used to warn
   * about — GCE's guest agent regenerating host keys on boot — does not occur.
   */
  canInjectHostKeys: true,
  /**
   * GCE's documented ceiling on a single metadata VALUE is 256 KB, within a 512 KB total across
   * all entries. `user-data` is one value, and this provider writes two small ones beside it.
   *
   * Sixteen times AWS's limit, which means the ceiling that bit on EC2 — a 19,130-byte
   * in-band agent — would never have been noticed here. That is not a licence to send more:
   * push mode's document is ~2.1KB and constant.
   */
  userDataMaxBytes: 262144,
  generatesUserData: true,
  /**
   * One shared firewall rule per project, whose `sourceRanges` decide who may reach port 22, and
   * `syncSshAccess()` patches it on demand without provisioning anything.
   */
  managesSshAccess: true,
}

/**
 * GCE instance status onto the frozen `InstanceView` vocabulary.
 *
 * THIS TABLE IS THE MOST DANGEROUS TWENTY LINES IN THE PACKAGE, because GCE and the SDK share a
 * word and mean different things by it. Verbatim from the v1 discovery document:
 *
 *  - **`TERMINATED`** — "The instance has stopped (either by explicit action or underlying
 *    failure)." That is the SDK's **`stopped`**: the disk is intact, the instance is
 *    restartable with `instances.start`, and it is still billing for storage. Mapping GCE's
 *    `TERMINATED` onto the SDK's identically-spelled `terminated` would tell core a live,
 *    billing resource is gone — the same data loss amendment A4 exists to prevent, arriving
 *    through a name collision instead of through eventual consistency. Core would stop tracking
 *    a disk the operator keeps paying for, and `terminate()` no-ops on a row already believed
 *    terminated.
 *  - **`DEPROVISIONING`** — "The instance is halted and we are performing tear down tasks like
 *    network deprogramming, releasing quota, IP, tearing down disks etc." That is a real
 *    teardown in progress, so it is **`terminating`** (ADR-0003, A3): irreversibly on its way
 *    out, and still holding resources a reconciler must see.
 *  - **`STOPPING`** — "The instance is currently stopping (either being deleted or killed)."
 *    ONE STATUS FOR TWO SDK STATES, which is the divergence this provider had to solve rather
 *    than look up. See `terminateRequested` below.
 *  - **`SUSPENDED` / `SUSPENDING`** — deliberately `unknown` rather than `stopped`. A suspended
 *    instance is revived by `instances.resume`, not `instances.start`, so calling it `stopped`
 *    would advertise a `start` to core that fails. Rocky Surf never suspends; one of these
 *    means somebody acted out of band, and the SDK's own instruction for that is to report
 *    `unknown` rather than guess on the caller's behalf.
 *  - **`REPAIRING`** — `unknown` for the same reason. It may come back running or it may not,
 *    and neither `pending` nor `failed` is a claim this provider can support.
 */
const STATE_MAP: Record<string, InstanceState> = {
  PROVISIONING: 'pending',
  STAGING: 'pending',
  PENDING: 'pending',
  RUNNING: 'running',
  STOPPING: 'stopping',
  PENDING_STOP: 'stopping',
  STOPPED: 'stopped',
  // GCE's word for "stopped, disk intact". NOT the SDK's `terminated`. See above.
  TERMINATED: 'stopped',
  DEPROVISIONING: 'terminating',
  SUSPENDING: 'unknown',
  SUSPENDED: 'unknown',
  REPAIRING: 'unknown',
}

/**
 * The description Rocky Surf writes on the shared firewall rule at create time — and the ONLY
 * thing that makes the rule safe to modify later.
 *
 * A firewall rule is project-global and named by configuration, so the name alone proves nothing:
 * an operator may have created `rockysurf-ssh` themselves, or repurposed one. Patching a rule
 * Rocky Surf did not create would edit somebody else's access policy on the strength of a name
 * collision, and on GCE that policy governs every instance carrying the tag. So this string is
 * the ownership marker: `syncSshAccess()` patches a rule that carries it, reports one that does
 * not, and never touches anything else.
 *
 * Changing this string orphans the rule every previous release created. Don't.
 */
const SSH_RULE_DESCRIPTION = 'rockysurf: SSH to managed dev boxes. Shared across servers; safe to reuse.'

/**
 * How long a settings save waits for Compute Engine before giving up on it.
 *
 * `syncSshAccess()` is called from a page an operator is sitting in front of, and it may be one
 * of several providers being synced at once — so an unreachable project must cost that operator a
 * bounded wait and an honest message, not a request that never returns. Thirty seconds is
 * comfortably longer than the two round trips this makes even with `GceApi`'s retries, and short
 * enough that a human is still there to read the answer.
 */
const SSH_SYNC_DEADLINE_MS = 30_000

/**
 * Run `work`, and answer with `onExpiry()` if it has not finished in `ms`.
 *
 * The abandoned call is NOT cancelled, and that is deliberate rather than a limitation worked
 * around: a patch already in flight may well land, and there is no way to un-issue it. So the
 * deadline bounds what the CALLER waits for, and the result it returns says only what this
 * provider can honestly claim — which after a timeout is "I do not know", never "applied".
 *
 * `Promise.race` attaches a handler to `work` either way, so a rejection arriving after the
 * deadline is absorbed rather than surfacing as an unhandled rejection.
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

const MANAGED_BY_LABEL = 'managed-by'
const SERVER_ID_LABEL = 'server-id'

/** GCE label rules: lowercase, starting with a letter, and at most 63 characters. */
const LABEL_KEY = /^[a-z]([-_a-z0-9]{0,61}[a-z0-9])?$/
const LABEL_VALUE = /^[-_a-z0-9]{0,63}$/
/** A GCE resource name. Note the leading LETTER, which an SDK-hostname-safe id need not have. */
const RESOURCE_NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/

/**
 * A fixed namespace for the derived request IDs below. Any constant UUID works; this one is
 * arbitrary and never changes, because changing it would break idempotency across versions.
 */
const REQUEST_ID_NAMESPACE = '6ba7b814-9dad-11d1-80b4-00c04fd430c8'

/**
 * Turn core's `idempotencyKey` into something GCE will accept as a `requestId`.
 *
 * The discovery document requires "a valid UUID with the exception that zero UUID is not
 * supported", and `ProvisionSpec.idempotencyKey` is an arbitrary string. So it is hashed into
 * one — as an RFC 4122 **version 5** (name-based) UUID, which is the standard, universally
 * parsed answer for "a UUID derived deterministically from a name".
 *
 * Two properties this must have, and a test pins both: the same key always yields the same
 * UUID (a derivation that varied would make the dedupe decorative), and different keys yield
 * different UUIDs.
 *
 * SHA-1 is used because the UUID specification prescribes it for version 5, not because
 * anything here is a security decision — this is a naming function, and its output travels as a
 * query parameter that identifies a retry.
 */
export function requestIdFor(idempotencyKey: string): string {
  const namespace = Buffer.from(REQUEST_ID_NAMESPACE.replace(/-/g, ''), 'hex')
  const hash = createHash('sha1').update(namespace).update(idempotencyKey, 'utf8').digest()
  const bytes = Buffer.from(hash.subarray(0, 16))

  // Version 5 in the high nibble of byte 6, RFC 4122 variant in the top bits of byte 8.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80

  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * The instance name for a server id.
 *
 * A GCE name must match RFC 1035 **and start with a letter**, which is strictly narrower than
 * the SDK's `isHostnameSafeId` (that allows a leading digit, because RFC 1123 does). The
 * configured `managedBy` prefix — itself validated as a legal resource name — is what closes
 * that gap structurally rather than by sanitizing, which ADR-0003 (C2) rejects because a
 * sanitizing map has to be injective and usually is not.
 *
 * The name is also this provider's second idempotency mechanism: GCE names are unique per zone.
 */
export function composeInstanceName(managedBy: string, serverId: string): string {
  return `${managedBy}-${serverId}`
}

/**
 * Where a human can open this instance in the Google Cloud console (ADR-0003, E16).
 *
 * GCP is the easy case, like AWS and unlike Hetzner: the project, zone and instance name are
 * all things this provider already holds, so a link is constructible for every instance it has
 * ever created and there is no configuration that can be missing. The project is carried in the
 * query string because the console resolves the resource against the currently-selected
 * project otherwise, which lands an operator on "not found" for a machine that exists.
 */
export function gceConsoleUrl(projectId: string, zone: string, name: string): string | undefined {
  if (!projectId || !zone || !name) return undefined
  return `https://console.cloud.google.com/compute/instancesDetail/zones/${zone}/instances/${name}?project=${projectId}`
}

export interface GcpProviderOptions {
  config: GcpProviderConfig
  /** Injected by tests; production builds one from the config. */
  api?: GceApi
  tokenSource?: TokenSource
  /** Injected by tests, so the propagation grace costs no wall-clock time. */
  absenceGrace?: { attempts: number; delayMs: number }
  sleep?: (ms: number) => Promise<void>
  /** Injected by tests; production builds a `PriceFeedClient` from the config. */
  priceFeed?: { get(): Promise<PriceFeedDoc | null> }
  /**
   * How long `syncSshAccess()` waits for Compute Engine. Injected by tests; production uses the
   * constant.
   *
   * Overridable because a deadline nothing can shorten is a deadline no test can prove exists,
   * and this one is the difference between an operator seeing an honest failure and a settings
   * save that never returns.
   */
  sshSyncDeadlineMs?: number
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function makeGcpProvider(options: GcpProviderOptions): ComputeProvider {
  const { config } = options
  const { projectId, zone } = config

  const api =
    options.api ??
    new GceApi({
      projectId,
      tokenSource:
        options.tokenSource ?? makeAdcTokenSource({ keyFile: config.keyFile, projectId: config.projectId }),
    })

  const grace = options.absenceGrace ?? DESCRIBE_ABSENCE_GRACE
  const sleep = options.sleep ?? defaultSleep
  const deadlineMs = options.sshSyncDeadlineMs ?? SSH_SYNC_DEADLINE_MS

  /**
   * Instances this provider has observed running, which is what keeps the propagation grace
   * cheap where it cannot matter. An instance seen running and now absent really is gone.
   */
  const seenRunning = new Set<string>()

  /**
   * Instances this provider has itself asked GCE to delete.
   *
   * THIS IS HOW `STOPPING` GETS DISAMBIGUATED. GCE reports one status for two different
   * outcomes — "stopping so it can be `stopped`" and "stopping on the way to being deleted" —
   * and nothing on the instance resource distinguishes them (there is no deletion timestamp).
   * A delete this process issued is a fact this process knows, so it is remembered, exactly the
   * way `seenRunning` remembers the other in-process fact that makes a read more precise.
   *
   * It is deliberately NOT persisted. After a restart the set is empty and a mid-delete
   * instance reads as `stopping` rather than `terminating`, which is a true statement about a
   * GCE instance that is stopping and costs nothing that matters: `stopping` is not a terminal
   * state, so core keeps polling, `DEPROVISIONING` follows within seconds, and the instance is
   * still reported by `listManaged()` throughout. The alternative — persisting a second
   * lifecycle store to sharpen a transient reading — is more machinery than the fact is worth.
   */
  const terminateRequested = new Set<string>()

  /** Per-process caches. Everything here is cheap to rebuild and safe to lose. */
  const imageCache = new Map<Architecture, string>()

  const instancePath = (name: string) => `${api.projectPath}/zones/${zone}/instances/${name}`

  /**
   * Resolve the boot image through its FAMILY rather than pinning a version.
   *
   * `…/global/images/family/ubuntu-2404-lts-arm64` always resolves to the current image in that
   * family, so a machine created next month gets that month's patched image without this
   * package being republished. The family names end in exactly the SDK's own architecture
   * words, which is why the arch is appended rather than mapped.
   */
  async function resolveImage(arch: Architecture): Promise<string> {
    const cached = imageCache.get(arch)
    if (cached) return cached

    const family = `${config.imageFamilyPrefix}-${arch}`
    const image = await api.call<{ selfLink?: string; name?: string }>(
      'GET',
      `/projects/${config.imageProject}/global/images/family/${family}`,
    )
    const selfLink = image.selfLink
    if (!selfLink) {
      throw new ProviderError('not_found', `image family ${config.imageProject}/${family} resolved to no image`)
    }

    imageCache.set(arch, selfLink)
    return selfLink
  }

  const firewallPath = `${api.projectPath}/global/firewalls/${config.firewallRuleName}`

  /**
   * One shared SSH firewall rule per project, created on first provision and reused after.
   *
   * A GCE firewall rule is VPC-global and selects instances by NETWORK TAG rather than by
   * membership, so this is one rule plus a tag on every instance — the analogue of AWS's one
   * shared security group, and `shared` in `listManaged()` for the identical reason (ADR-0003,
   * D1): a reconciler treating the managed list as a delete-list would otherwise cut SSH to
   * every running box at once.
   *
   * The ingress comes from CONFIGURATION, never from a runtime lookup of the caller's own
   * address. See `config.ts` for why that matters.
   */
  async function ensureFirewall(): Promise<void> {
    /*
     * NO PROCESS-LIFETIME LATCH (issue #304).
     *
     * This used to open with `if (firewallEnsured) return`, set after the first successful
     * check and never cleared. Combined with the early return below — the rule exists, so
     * nothing is written — it meant `sourceRanges` was written EXACTLY ONCE, at create time, and
     * then never again for the life of the rule. An operator who changed `sshAllowedCidr` and
     * launched a new box got the old ranges; an operator who deleted the rule to start over got
     * a process that believed it was still there. This was the worst of the three clouds: on
     * EC2 and on Azure the setting at least reached the cloud on the next provision.
     *
     * The latch bought one GET per boot. The GET is what makes this function honest, and it is
     * nothing beside the minutes that follow it building a machine.
     */
    try {
      await api.call<GceFirewall>('GET', firewallPath)
      return
    } catch (err) {
      if (!isNotFound(err)) throw err
    }

    try {
      await api.callAndWait('POST', `${api.projectPath}/global/firewalls`, {
        name: config.firewallRuleName,
        description: SSH_RULE_DESCRIPTION,
        network: `projects/${projectId}/global/networks/${config.network}`,
        direction: 'INGRESS',
        priority: 1000,
        // EVERY configured CIDR, not the first one. The setting became a list in #304 because
        // the operator it exists for is the one who moves, and a rule that could hold one
        // network made "add the cafe" mean "lose the office".
        sourceRanges: resolveSshCidrs(config),
        targetTags: [config.firewallRuleName],
        allowed: [{ IPProtocol: 'tcp', ports: ['22'] }],
      })
    } catch (err) {
      // Two concurrent provisions race here; the loser adopts the winner's rule.
      if (!isAlreadyExists(err)) throw err
    }
  }

  function viewOf(instance: GceInstance): InstanceView {
    const raw = instance.status ?? ''
    const name = instance.name ?? ''
    const state = STATE_MAP[raw] ?? 'unknown'
    if (state === 'running' && name) seenRunning.add(name)

    const natIp = instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP
    const consoleUrl = name ? gceConsoleUrl(projectId, zone, name) : undefined

    return {
      state,
      ...(natIp ? { publicIp: natIp } : {}),
      ...(instance.machineType ? { offeringId: lastSegment(instance.machineType) } : {}),
      ...(consoleUrl ? { consoleUrl } : {}),
      // GCE has no `failed` instance state — a launch that fails fails on the Operation, which
      // the API client already turns into a ProviderError. `statusMessage` is carried only when
      // the status is one this SDK does not model, which is the case where a human needs the
      // cloud's own words.
      ...(state === 'unknown' && instance.statusMessage ? { failureReason: instance.statusMessage } : {}),
    }
  }

  const priceFeed = options.priceFeed ?? new PriceFeedClient(config.pricesUrl, config.pricesRefreshHours)
  const offerings = async () => buildOfferings(zone, config.bootDiskGb, await priceFeed.get())

  /** Both label halves have to be legal or GCE rejects the whole create (ADR-0003, A7). */
  function assertLabelsAreLegal(tags: Record<string, string>): void {
    for (const [key, value] of Object.entries(tags)) {
      if (!LABEL_KEY.test(key)) {
        throw new ProviderError(
          'invalid_spec',
          `tag key '${key}' is not a legal GCE label key: lowercase letters, digits, hyphens and ` +
            'underscores, starting with a letter, at most 63 characters',
        )
      }
      if (!LABEL_VALUE.test(value)) {
        throw new ProviderError(
          'invalid_spec',
          `tag '${key}' has value '${value}', which is not a legal GCE label value: lowercase letters, ` +
            'digits, hyphens and underscores, at most 63 characters',
        )
      }
    }
  }

  const provider: ComputeProvider = {
    id: 'gcp',
    displayName: 'Google Compute Engine',
    capabilities: CAPABILITIES,

    async validateCredentials() {
      // `zones.get` is the cheapest authenticated Compute call there is, and it proves four
      // things at once: the credential is live, the project exists with the Compute Engine API
      // enabled, the caller can read it, and the configured zone is real.
      await api.call('GET', `${api.projectPath}/zones/${zone}`)
    },

    async validateSpec(spec: ProvisionSpec) {
      const offering = (await offerings()).find((o) => o.id === spec.offeringId)
      if (!offering) {
        throw new ProviderError('invalid_spec', `no such offering: ${spec.offeringId}`)
      }
      if (offering.arch !== spec.arch) {
        throw new ProviderError(
          'invalid_spec',
          `arch ${spec.arch} does not match offering ${offering.id} (${offering.arch})`,
        )
      }
      if (!offering.available) {
        // Not `capacity`: capacity is retryable and means "sold out this afternoon". An arm64
        // family in a zone that has never offered it is a permanent no, and retrying it forever
        // is the wrong behaviour to invite. Named per family, because the two arm64 families
        // have different zone lists and naming the wrong one would send an operator looking in
        // the wrong ~70 zones.
        const family = familyOf(offering.id)
        const [label, zones] =
          family === 'c4a' ? (['C4A (arm64)', C4A_ZONES] as const) : (['Tau T2A (arm64)', T2A_ZONES] as const)
        throw new ProviderError(
          'invalid_spec',
          `${offering.id} is not offered in zone ${zone}. ${label} exists only in ${[...zones].join(', ')}.`,
        )
      }

      // Amendment (rockysurf-ev41.9 / rockysurf-h6mb): boot disk type is per MACHINE FAMILY, not
      // just per configuration. C4A has no Persistent Disk option at all; every other family
      // this provider ships has no Hyperdisk option (yet). A mismatch is refused HERE, naming the
      // constraint, rather than surfacing as a Compute API 400 on `disks.insert` after the rest
      // of provisioning has already started.
      const family = familyOf(offering.id)
      if (family) {
        const allowed = allowedBootDiskTypes(family)
        if (!allowed.includes(config.bootDiskType)) {
          const label = family === 'c4a' ? 'C4A' : family.toUpperCase()
          const supports = family === 'c4a' ? 'Hyperdisk only' : 'Persistent Disk only (pd-balanced/pd-standard/pd-ssd)'
          throw new ProviderError(
            'invalid_spec',
            `${offering.id} is a ${label} machine type. ${label} supports ${supports}, but this provider is ` +
              `configured with bootDiskType '${config.bootDiskType}'. Set bootDiskType to ${allowed
                .map((t) => `'${t}'`)
                .join(' or ')} to provision ${label} machines.`,
          )
        }
      }

      if (spec.sshPublicKeys.length === 0) {
        throw new ProviderError('invalid_spec', 'at least one ssh public key is required')
      }
      if (!spec.idempotencyKey) {
        throw new ProviderError('invalid_spec', 'idempotencyKey is required — it becomes the GCE requestId')
      }

      const bytes = Buffer.byteLength(spec.userData, 'utf8')
      if (bytes > CAPABILITIES.userDataMaxBytes) {
        throw new ProviderError(
          'invalid_spec',
          `userData is ${bytes}B against GCE's ${CAPABILITIES.userDataMaxBytes}B per-metadata-value ceiling. ` +
            'Move work out of user-data rather than raising the limit.',
        )
      }

      // Amendment D3. Without this an instance can be created that `listManaged()` will never
      // see, which makes it an orphan from birth.
      const managedBy = spec.tags[MANAGED_BY_LABEL]
      if (managedBy !== undefined && managedBy !== config.managedBy) {
        throw new ProviderError(
          'invalid_spec',
          `tags['${MANAGED_BY_LABEL}'] is '${managedBy}' but this provider reconciles '${config.managedBy}'`,
        )
      }

      assertLabelsAreLegal(spec.tags)

      // The name is checked HERE rather than being sanitized at create time, because it is also
      // the dedupe mechanism: a name silently truncated to fit would collide two servers onto
      // one machine.
      const name = composeInstanceName(config.managedBy, spec.serverId)
      if (!RESOURCE_NAME.test(name) || name.length > 63) {
        throw new ProviderError(
          'invalid_spec',
          `instance name '${name}' (managedBy + serverId) is not a legal GCE name: it must match ` +
            'RFC 1035, start with a letter, and be at most 63 characters',
        )
      }
    },

    async listOfferings(): Promise<Offering[]> {
      return offerings()
    },

    async provision(spec: ProvisionSpec): Promise<ProvisionResult> {
      await provider.validateSpec(spec)

      const name = composeInstanceName(config.managedBy, spec.serverId)
      const [sourceImage] = await Promise.all([resolveImage(spec.arch), ensureFirewall()])

      const labels = {
        ...spec.tags,
        [MANAGED_BY_LABEL]: config.managedBy,
        [SERVER_ID_LABEL]: spec.serverId,
      }

      const body = {
        name,
        machineType: `zones/${zone}/machineTypes/${spec.offeringId}`,
        labels,
        // The tag is what the shared firewall rule matches on. Without it the box comes up
        // with no SSH ingress at all and the bootstrap times out against a closed port.
        tags: { items: [config.firewallRuleName] },
        disks: [
          {
            boot: true,
            autoDelete: true,
            initializeParams: {
              sourceImage,
              diskSizeGb: String(config.bootDiskGb),
              diskType: `zones/${zone}/diskTypes/${config.bootDiskType}`,
              labels,
            },
          },
        ],
        networkInterfaces: [
          {
            network: `projects/${projectId}/global/networks/${config.network}`,
            // An ephemeral external IP. Requesting no `natIP` is what keeps this off
            // `compute.addresses.use`, which only a reserved static address needs.
            accessConfigs: [{ name: 'External NAT', type: 'ONE_TO_ONE_NAT' }],
          },
        ],
        metadata: {
          items: [
            // The cloud-init document, verbatim. cloud-init's GCE datasource reads exactly this
            // key, and the provider must not append to it (ADR-0003, ProvisionSpec.userData).
            { key: 'user-data', value: spec.userData },
            // Project-wide SSH keys must not open a box that holds a git token and runs
            // agent-authored code. Core's own access does not come through this mechanism at
            // all — cloud-init writes the authorized key — so blocking it costs nothing and
            // closes a door the operator may not know is open.
            { key: 'block-project-ssh-keys', value: 'TRUE' },
          ],
        },
        // NO `serviceAccounts` FIELD, and its absence is the decision. On the REST API omitting
        // it creates an instance with NO service account, so these boxes carry no Google Cloud
        // identity at all — the same posture as the AWS provider's "no instance profile, no
        // iam:* anywhere". It also keeps `compute.instances.setServiceAccount` and
        // `iam.serviceAccounts.actAs` out of the published role. (`gcloud` differs here: it
        // attaches the default service account unless told otherwise.)
      }

      let created: GceInstance | undefined
      try {
        await api.callAndWait(
          'POST',
          `${api.projectPath}/zones/${zone}/instances?requestId=${requestIdFor(spec.idempotencyKey)}`,
          body,
        )
      } catch (err) {
        // THE SECOND IDEMPOTENCY MECHANISM. `requestId` dedupes a retry, but its retention
        // window is undocumented, so a replay arriving later gets a plain name collision
        // instead. GCE names are unique per zone, so that collision IS the dedupe — but only
        // for a machine that is ours. A name held by somebody else's instance is a conflict to
        // report, never a resource to adopt (ADR-0003 forbids claiming pre-existing resources
        // a provider merely matched).
        if (!isAlreadyExists(err)) throw err

        const existing = await api.call<GceInstance>('GET', instancePath(name))
        const labelledFor = existing.labels?.[SERVER_ID_LABEL]
        const labelledBy = existing.labels?.[MANAGED_BY_LABEL]
        if (labelledBy !== config.managedBy || labelledFor !== spec.serverId) {
          throw new ProviderError(
            'conflict',
            `an instance named '${name}' already exists in ${zone} and is not managed by this installation ` +
              `(${MANAGED_BY_LABEL}=${labelledBy ?? 'none'}, ${SERVER_ID_LABEL}=${labelledFor ?? 'none'})`,
            { providerCode: 'alreadyExists', cause: err },
          )
        }
        created = existing
      }

      const data = { instanceName: name, zone, projectId }

      // A6 wants an initial view without a round trip, and on EC2 that round trip lands in the
      // eventual-consistency window A4 exists to survive. GCE's `instances.get` is documented
      // as strongly consistent, so the read is affordable here and buys core the external IP
      // immediately. It is still best-effort: a create that succeeded must not be reported as
      // a failure because the follow-up read was unlucky.
      if (!created) {
        created = await api.call<GceInstance>('GET', instancePath(name)).catch(() => undefined)
      }

      if (created) return { data, initial: viewOf(created) }

      const consoleUrl = gceConsoleUrl(projectId, zone, name)
      return { data, initial: { state: 'pending', ...(consoleUrl ? { consoleUrl } : {}) } }
    },

    /**
     * Read one instance's state.
     *
     * ABSENCE IS NOT PROOF OF TERMINATION, AND THE RETRY LIVES HERE. GCE's documentation says
     * `instances.get` is strongly consistent, which is an argument for this grace being cheap
     * rather than an argument for skipping it — and skipping is not on the table: ADR-0003 says
     * a provider may lengthen the grace and may never skip it. The consistency claim is read
     * from a document; no run of ours has tested it, because this package was written without
     * GCP credentials. `provider-aws` shipped without the grace with eighty-five tests green
     * (rockysurf-gyp1.4), and the only implementation any of them exercised was the fake.
     */
    async describe(data: ProviderData): Promise<InstanceView> {
      const name = String(data['instanceName'] ?? '')
      // An instance already seen running gets no grace: its absence is a real termination, and
      // waiting eight seconds to confirm a teardown core polls in a loop is pure delay.
      const attempts = seenRunning.has(name) ? 1 : Math.max(1, grace.attempts)

      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const instance = await api.call<GceInstance>('GET', instancePath(name))
          const view = viewOf(instance)
          // The `STOPPING` disambiguation. GCE uses one status for "stopping to stopped" and
          // "stopping on the way out"; a delete this process issued is the evidence that says
          // which, and without it core would read an irreversible teardown as a reversible
          // pause.
          if (view.state === 'stopping' && terminateRequested.has(name)) {
            return { ...view, state: 'terminating' }
          }
          return view
        } catch (err) {
          if (!isNotFound(err)) throw err
          if (attempt < attempts) {
            await sleep(grace.delayMs)
            continue
          }
          // Absence, believed. A vanished instance is a normal teardown outcome, never an
          // error: core polls this in a loop and throwing would make success an error path.
          return { state: 'terminated' }
        }
      }

      return { state: 'terminated' }
    },

    async terminate(data: ProviderData): Promise<void> {
      const name = String(data['instanceName'] ?? '')
      // Recorded BEFORE the call, so a describe() racing the delete still reads `terminating`
      // rather than `stopping`.
      terminateRequested.add(name)
      try {
        await api.callAndWait('DELETE', instancePath(name))
      } catch (err) {
        if (isNotFound(err)) return // idempotent: not-found is success
        throw err
      }
    },

    async listManaged(): Promise<ManagedResource[]> {
      const resources: ManagedResource[] = []

      const filter = encodeURIComponent(`labels.${MANAGED_BY_LABEL}=${config.managedBy}`)
      const instances = await api.collect<GceInstance>(
        `${api.projectPath}/zones/${zone}/instances?filter=${filter}`,
      )

      for (const instance of instances) {
        if (!instance.name) continue
        // NOTHING IS FILTERED OUT HERE, and that is correct rather than an omission. On EC2 a
        // `terminated` instance lingers in DescribeInstances for about an hour and has to be
        // skipped; GCE removes a deleted instance from this listing entirely, and no GCE status
        // maps to the SDK's `terminated` (its own `TERMINATED` means stopped). So everything
        // this call returns still exists and still costs money, which is exactly the
        // reconciler's input.
        resources.push({
          kind: 'instance',
          providerNativeId: instance.name,
          ownership: 'server-owned',
          ...(instance.labels?.[SERVER_ID_LABEL] ? { serverId: instance.labels[SERVER_ID_LABEL] } : {}),
        })
      }

      // The shared SSH firewall rule. Reported so an audit can account for it, NOT so a
      // reconciler can reap it — deleting this closes port 22 on every running instance.
      try {
        const firewall = await api.call<GceFirewall>('GET', firewallPath)
        if (firewall.name) {
          resources.push({ kind: 'firewall', providerNativeId: firewall.name, ownership: 'shared' })
        }
      } catch (err) {
        // A rule that does not exist yet is not a failure to report the ones that do.
        if (!isNotFound(err)) throw err
      }

      return resources
    },

    async stop(data: ProviderData): Promise<void> {
      const name = String(data['instanceName'] ?? '')
      await api.callAndWait('POST', `${instancePath(name)}/stop`)
    },

    async start(data: ProviderData): Promise<void> {
      const name = String(data['instanceName'] ?? '')
      await api.callAndWait('POST', `${instancePath(name)}/start`)
    },

    /**
     * Bring the shared firewall rule in line with `sshAllowedCidr`, without provisioning anything.
     *
     * The call issue #304 exists for, and GCE is where it was most needed: `ensureFirewall()`
     * writes `sourceRanges` only when it CREATES the rule, so before this method a changed
     * `sshAllowedCidr` had never once reached Compute Engine for the life of an existing rule —
     * not on the next launch, not on a restart, not ever.
     *
     * PATCH, NEVER DELETE-AND-RECREATE. The obvious way to change a GCE firewall rule's ranges is
     * to delete it and insert a new one, and it is the one thing this must not do: the rule is
     * project-global, it is `ownership: 'shared'` for exactly this reason (ADR-0003, D1), and for
     * the seconds between the two calls port 22 is closed on EVERY box in the project at once.
     * `compute.firewalls.patch` changes the one field in place, and a patch that fails changes
     * nothing.
     */
    async syncSshAccess(): Promise<SshAccessSyncResult> {
      const desired = resolveSshCidrs(config)

      /** The one command that finishes, by hand, whatever this could not do itself. */
      const command = (ranges: readonly string[]) =>
        `gcloud compute firewall-rules update ${config.firewallRuleName} ` +
        `--source-ranges=${ranges.join(',')} --project=${projectId}`

      return await withDeadline<SshAccessSyncResult>(
        deadlineMs,
        async () => {
          let rule: GceFirewall | undefined
          try {
            rule = await api.call<GceFirewall>('GET', firewallPath)
          } catch (err) {
            if (!isNotFound(err)) throw err
          }

          // A settings save MUST NOT create the rule. Creating cloud objects in a project nobody
          // has launched into is the product acting on an intention the operator has not formed
          // yet; the first launch creates it, with these CIDRs already in it.
          if (!rule) {
            return {
              status: 'skipped',
              applied: [],
              reported: [],
              detail:
                `No ${config.firewallRuleName} firewall rule exists in ${projectId} yet, so there ` +
                'is nothing to update. Rocky Surf creates it at the first launch, with these ' +
                'CIDRs already in it.',
            }
          }

          const existing = rule.sourceRanges ?? []

          // THE OWNERSHIP CHECK. The rule is found by NAME, and a name proves nothing about who
          // wrote it — an operator may have created `rockysurf-ssh` themselves, or reused one
          // from something else. The description Rocky Surf stamps at create time is the only
          // evidence of authorship there is, so a rule without it is left exactly as found.
          //
          // `failed` rather than `skipped`, deliberately: the operator asked for their list to be
          // in force and it is NOT, and nothing Rocky Surf can do will change that. `skipped`
          // reads as "there was nothing to do", which would be the second time this setting told
          // somebody it had applied when it had not.
          if (rule.description !== SSH_RULE_DESCRIPTION) {
            const keep = [...desired, ...existing.filter((cidr) => !desired.includes(cidr))]
            return {
              status: 'failed',
              applied: [],
              reported: existing,
              detail:
                `${config.firewallRuleName} in ${projectId} was not created by Rocky Surf — its ` +
                'description does not match the one Rocky Surf writes — so it has been left ' +
                `exactly as it is, still allowing ${existing.join(', ') || 'nothing'}. To apply ` +
                'your list yourself, keeping what the rule already allows, run: ' +
                `${command(keep)}`,
            }
          }

          // Anything on the rule the config no longer names. On GCE these are not stray edits:
          // `sourceRanges` was frozen when the rule was created, so they are the CIDRs of an
          // OLDER config — quite possibly the network the operator is sitting on right now.
          const extras = existing.filter((cidr) => !desired.includes(cidr))
          const missing = desired.filter((cidr) => !existing.includes(cidr))

          // WIDEN ONLY, FOR NOW. Patching to exactly `desired` would drop `extras`, and the first
          // thing an operator does with this feature is save it from a network the frozen rule
          // may be the only reason they can reach. So the patch carries the union, the extras are
          // `reported`, and the detail says how to remove them. Converging to exactly-the-list is
          // deferred until the operator has been offered keep-or-remove and picked one — the same
          // report-don't-revoke stance `provider-aws` takes on an unstamped ingress range.
          const target = [...desired, ...extras]

          if (missing.length > 0) {
            try {
              // Only `sourceRanges` is sent. A patch body carrying the whole rule would re-assert
              // the network, the target tags and the ports as a side effect of changing who may
              // connect, and the moment those drift from the config that becomes a second,
              // invisible change riding along with this one.
              await api.callAndWait('PATCH', firewallPath, { sourceRanges: target })
            } catch (err) {
              // A 403 here is a PLAIN failure, not an optional extra: Rocky Surf creates this
              // rule and expects to own it, so a role that cannot update it cannot deliver the
              // setting. Named permission plus the command that does the same job by hand.
              if (err instanceof ProviderError && err.code === 'auth') {
                return {
                  status: 'failed',
                  applied: [],
                  reported: extras,
                  detail:
                    `Compute Engine refused to update ${config.firewallRuleName}: this credential ` +
                    'is missing the compute.firewalls.update permission. Grant it, or run: ' +
                    `${command(target)}`,
                }
              }
              throw err
            }
          }

          const kept =
            extras.length > 0
              ? ` ${extras.join(', ')} was already on the rule and is not in your list; it has ` +
                'been KEPT, because it may be the network you are reading this from. To remove ' +
                `it, run: ${command(desired)}`
              : ''

          return {
            status: missing.length > 0 ? 'updated' : 'unchanged',
            applied: desired,
            reported: extras,
            detail:
              (missing.length > 0
                ? `Added ${missing.join(', ')} to ${config.firewallRuleName}, which now allows ` +
                  `${target.join(', ')} on port 22.`
                : `${config.firewallRuleName} already allowed ${desired.join(', ')} on port 22.`) + kept,
          }
        },
        () => ({
          status: 'failed',
          applied: [],
          reported: [],
          detail:
            `Compute Engine did not answer within ${Math.round(deadlineMs / 1000)}s, so Rocky Surf ` +
            `cannot say whether ${config.firewallRuleName} now allows ${desired.join(', ')}. ` +
            'Nothing was deleted. Check the project is reachable and save again.',
        }),
      )
    },
  }

  return provider
}

/** Exported for the capability matrix test, which asserts the docs and the constant agree. */
export const GCP_CAPABILITIES = CAPABILITIES

/** Exported so tests can assert the mapping rather than re-deriving it. */
export const GCP_STATE_MAP = STATE_MAP

/** The machine types this package knows about, for callers that want the catalogue statically. */
export const GCP_MACHINE_TYPES = GCP_TYPES
