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
} from '@rockysurf/provider-sdk'
import { GceApi, lastSegment } from './api.js'
import { makeAdcTokenSource, type TokenSource } from './auth.js'
import { resolveSshCidr, type GcpProviderConfig } from './config.js'
import { isAlreadyExists, isNotFound } from './errors.js'
import { buildOfferings } from './offerings.js'
import { GCP_TYPES, T2A_ZONES } from './prices.generated.js'
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
  let firewallEnsured = false

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
    if (firewallEnsured) return

    try {
      await api.call<GceFirewall>('GET', firewallPath)
      firewallEnsured = true
      return
    } catch (err) {
      if (!isNotFound(err)) throw err
    }

    try {
      await api.callAndWait('POST', `${api.projectPath}/global/firewalls`, {
        name: config.firewallRuleName,
        description: 'rockysurf: SSH to managed dev boxes. Shared across servers; safe to reuse.',
        network: `projects/${projectId}/global/networks/${config.network}`,
        direction: 'INGRESS',
        priority: 1000,
        sourceRanges: [resolveSshCidr(config)],
        targetTags: [config.firewallRuleName],
        allowed: [{ IPProtocol: 'tcp', ports: ['22'] }],
      })
    } catch (err) {
      // Two concurrent provisions race here; the loser adopts the winner's rule.
      if (!isAlreadyExists(err)) throw err
    }

    firewallEnsured = true
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

  const offerings = () => buildOfferings(zone, config.bootDiskGb)

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
      const offering = offerings().find((o) => o.id === spec.offeringId)
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
        // Not `capacity`: capacity is retryable and means "sold out this afternoon". A T2A
        // machine in a zone that has never offered T2A is a permanent no, and retrying it
        // forever is the wrong behaviour to invite.
        throw new ProviderError(
          'invalid_spec',
          `${offering.id} is not offered in zone ${zone}. Tau T2A (arm64) exists only in ` +
            `${[...T2A_ZONES].join(', ')}.`,
        )
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
  }

  return provider
}

/** Exported for the capability matrix test, which asserts the docs and the constant agree. */
export const GCP_CAPABILITIES = CAPABILITIES

/** Exported so tests can assert the mapping rather than re-deriving it. */
export const GCP_STATE_MAP = STATE_MAP

/** The machine types this package knows about, for callers that want the catalogue statically. */
export const GCP_MACHINE_TYPES = GCP_TYPES
