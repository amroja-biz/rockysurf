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
} from '@rockysurf/provider-sdk'
import { HetznerApi } from './api.js'
import type { HetznerProviderInput } from './config.js'
import { hetznerCodeOf, isNotFound } from './errors.js'
import { BUNDLED_PRICES, livePrice, lookupPrice, type PriceTable } from './prices.js'
import type {
  HetznerServer,
  HetznerServerStatus,
  HetznerServerType,
  HetznerSshKey,
} from './types.js'

export const HETZNER_PROVIDER_ID = 'hetzner'

/**
 * Capabilities, all four measured on real infrastructure by the spike capstone. See
 * `docs/providers/capability-matrix.md` for the evidence behind each row.
 */
const CAPABILITIES: ProviderCapabilities = {
  stop: true,
  ipStableAcrossStop: true,
  canInjectHostKeys: true,
  userDataMaxBytes: 32_768,
  generatesUserData: true,
}

/**
 * What this provider persists per instance. Narrowed from `ProviderData` at the edge — the
 * generic that used to carry this shape was dropped in ADR-0003 (A1) because it made the
 * interface invariant, and the value round-trips through JSON in the database anyway.
 */
export interface HetznerData extends ProviderData {
  /** Hetzner's numeric server id. */
  serverId: number
  /** The deduped name. Kept so a reconciler can find the server without the numeric id. */
  name: string
  /**
   * SSH key objects THIS provision created and therefore owns.
   *
   * Keys matched by fingerprint to something that already existed are absent on purpose: they
   * are shared, possibly someone else's, and reaping them with this server would be theft
   * (ADR-0003, D2).
   */
  ownedSshKeyIds: number[]
}

/** Parse the opaque handle, failing loudly rather than reading `undefined.serverId` later. */
export function asHetznerData(data: ProviderData): HetznerData {
  const serverId = data['serverId']
  const name = data['name']
  if (typeof serverId !== 'number' || typeof name !== 'string') {
    throw new ProviderError('invalid_spec', 'provider data is not a Hetzner handle: expected { serverId, name }')
  }
  const owned = data['ownedSshKeyIds']
  return {
    serverId,
    name,
    ownedSshKeyIds: Array.isArray(owned) ? owned.filter((id): id is number => typeof id === 'number') : [],
  }
}

/**
 * Hetzner status → the frozen state machine.
 *
 * `deleting` → `terminating` is the fix for the spike's own finding: with no `terminating`
 * state to map to, the spike provider chose `stopping`, which the app layer read as `running`
 * — a latent bug that would have resurrected a terminating row if anything polled it. The
 * state exists now precisely because two providers independently picked two different wrong
 * answers (ADR-0003, A3).
 */
const STATE: Readonly<Record<HetznerServerStatus, InstanceState>> = {
  running: 'running',
  initializing: 'pending',
  starting: 'pending',
  migrating: 'pending',
  rebuilding: 'pending',
  stopping: 'stopping',
  off: 'stopped',
  deleting: 'terminating',
  unknown: 'unknown',
}

/** Hetzner identifies SSH keys by MD5 fingerprint (`aa:bb:…`) of the raw key blob. */
export function sshFingerprint(publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/)
  const blob = parts.length > 1 ? parts[1]! : parts[0]!
  const hex = createHash('md5').update(Buffer.from(blob, 'base64')).digest('hex')
  return (hex.match(/.{2}/g) ?? []).join(':')
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * A server's page in the Hetzner Console (ADR-0003, E16).
 *
 * The project id is NOT the token's own project as far as the API is concerned — the API never
 * names it — so this returns nothing until an operator configures `consoleProjectId`. That is
 * the whole of the "no config, no link" rule; the alternative is a URL that opens somebody
 * else's project, or a 404 dressed up as a feature.
 */
export function hetznerConsoleUrl(projectId: number | undefined, serverId: number): string | undefined {
  if (projectId === undefined) return undefined
  return `https://console.hetzner.com/projects/${projectId}/servers/${serverId}/overview`
}

export function makeHetznerProvider(input: HetznerProviderInput): ComputeProvider {
  const { location, image, managedBy, consoleProjectId } = input
  const prices: PriceTable = input.prices ?? BUNDLED_PRICES
  const grace = input.absenceGrace ?? DESCRIBE_ABSENCE_GRACE
  const sleep = input.sleep ?? defaultSleep
  const api = new HetznerApi({
    token: input.token,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
    ...(input.retryBaseMs !== undefined ? { retryBaseMs: input.retryBaseMs } : {}),
    ...(input.sleep ? { sleep: input.sleep } : {}),
  })

  /**
   * Instances this provider has observed running, which is what makes the propagation grace
   * on `describe()` cheap where it matters. An instance that was seen running and is now
   * absent really is gone — believe the 404 immediately. One never seen running might just be
   * a create that has not propagated, so it gets the full grace.
   */
  const seenRunning = new Set<number>()

  const labelSelector = () => encodeURIComponent(`managed-by=${managedBy}`)

  function viewOf(server: HetznerServer): InstanceView {
    const state = STATE[server.status] ?? 'unknown'
    const ip = server.public_net?.ipv4?.ip
    const dns = server.public_net?.ipv4?.dns_ptr
    if (state === 'running') seenRunning.add(server.id)
    const consoleUrl = hetznerConsoleUrl(consoleProjectId, server.id)
    return {
      state,
      ...(ip ? { publicIp: ip } : {}),
      ...(dns ? { publicDns: dns } : {}),
      ...(server.server_type?.name ? { offeringId: server.server_type.name } : {}),
      ...(consoleUrl ? { consoleUrl } : {}),
    }
  }

  /**
   * Find or create the SSH Key object the create call must reference.
   *
   * Hetzner will not take raw key material inline, so `provision()` necessarily creates a
   * SECOND kind of cloud resource. A key matched by fingerprint that is not attributable to
   * this server is NOT claimed as owned: it already existed, it may be shared with other
   * servers or belong to someone else entirely, and reaping it on terminate would break them
   * (ADR-0003, D2).
   *
   * OWNERSHIP IS DECIDED BY THE LABELS, NOT BY WHOSE POST RETURNED 201 (rockysurf-rkh3). "Did
   * my create call answer 201?" is the wrong question and the nightly paid for asking it:
   * `call()` retries a POST that got no well-formed answer, so a key this provision genuinely
   * created comes back from the retry as a `uniqueness_error` and is resolved by the lookup
   * below. Answering "not created, therefore not mine" left that key out of `ownedSshKeyIds`,
   * so `terminate()` never reaped it — and nothing else ever would, since v0.1's reconciler
   * reports orphans rather than deleting them. One immortal ssh-key object per lost response,
   * failing every subsequent run's zero-orphan audit.
   *
   * A key carrying both `managed-by=<this installation>` and `server-id=<this server>` cannot
   * be a stranger's: those labels are written by this function and nothing else, and a server
   * id is minted per server. A key that merely matches by fingerprint still is not ours.
   */
  async function ensureSshKey(
    publicKey: string,
    name: string,
    labels: Record<string, string>,
  ): Promise<{ id: number; owned: boolean }> {
    const fingerprint = sshFingerprint(publicKey)
    const query = `/ssh_keys?fingerprint=${encodeURIComponent(fingerprint)}`
    const serverId = labels['server-id']
    const mintedHere = (key: HetznerSshKey) =>
      serverId !== undefined && key.labels?.['managed-by'] === managedBy && key.labels?.['server-id'] === serverId

    const existing = await api.call<{ ssh_keys: HetznerSshKey[] }>('GET', query)
    if (existing.ssh_keys[0]) return { id: existing.ssh_keys[0].id, owned: mintedHere(existing.ssh_keys[0]) }

    try {
      const result = await api.call<{ ssh_key: HetznerSshKey }>('POST', '/ssh_keys', {
        name,
        public_key: publicKey.trim(),
        labels,
      })
      return { id: result.ssh_key.id, owned: true }
    } catch (err) {
      if (hetznerCodeOf(err) !== 'uniqueness_error') throw err
      // Raced with a concurrent provision, retried past a lost response, or a leftover holds
      // the name. The labels tell those apart from a stranger's key; nothing else can.
      const retry = await api.call<{ ssh_keys: HetznerSshKey[] }>('GET', query)
      if (retry.ssh_keys[0]) return { id: retry.ssh_keys[0].id, owned: mintedHere(retry.ssh_keys[0]) }
      const byName = await api.call<{ ssh_keys: HetznerSshKey[] }>(
        'GET',
        `/ssh_keys?name=${encodeURIComponent(name)}`,
      )
      if (byName.ssh_keys[0]) return { id: byName.ssh_keys[0].id, owned: mintedHere(byName.ssh_keys[0]) }
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
   * Delete keys on a path where the caller's own failure is the thing that must reach core.
   *
   * A cleanup that throws would replace the real error — the reason the server was not created
   * — with whatever went wrong tidying up, and core reports that string to the operator. So a
   * key that will not delete is left for `listManaged()` to surface instead, which is exactly
   * the report-and-let-a-human-decide contract the reconciler already has.
   */
  async function reapQuietly(keyIds: number[]): Promise<void> {
    for (const keyId of keyIds) {
      try {
        await deleteIgnoringNotFound(`/ssh_keys/${keyId}`)
      } catch {
        /* reported by listManaged(), never raised over the original failure */
      }
    }
  }

  return {
    id: HETZNER_PROVIDER_ID,
    displayName: 'Hetzner Cloud',
    capabilities: CAPABILITIES,

    async validateCredentials(): Promise<void> {
      // Cheapest authenticated call that also proves the configured location exists — a token
      // that works against a location this project cannot use is not working credentials for
      // any purpose this provider has.
      await api.call<{ servers: HetznerServer[] }>('GET', '/servers?per_page=1')
      try {
        await api.call<{ location: unknown }>('GET', `/locations/${encodeURIComponent(location)}`)
      } catch (err) {
        if (isNotFound(err)) {
          throw new ProviderError('invalid_spec', `hetzner location '${location}' does not exist`, {
            providerCode: hetznerCodeOf(err),
            cause: err,
          })
        }
        throw err
      }
    },

    /**
     * Reject a spec before anything is created (ADR-0003, A7).
     *
     * Every check here failed at provision time in the sketch, as a vendor-specific 4xx that
     * core could not anticipate. Cheap, local, and none of it touches the network.
     */
    async validateSpec(spec: ProvisionSpec): Promise<void> {
      // The name IS the idempotency mechanism on this provider, so an unsafe id is not a
      // cosmetic problem: sanitizing it is not injective and two servers would collide.
      assertHostnameSafeId(spec.serverId)

      const declared = spec.tags['managed-by']
      if (declared !== managedBy) {
        throw new ProviderError(
          'invalid_spec',
          `spec tags managed-by='${declared ?? '(absent)'}' disagrees with this provider's '${managedBy}': ` +
            'the instance would be invisible to listManaged() and an orphan from the moment it is created',
        )
      }

      if (spec.sshPublicKeys.length === 0) {
        throw new ProviderError('invalid_spec', 'at least one ssh public key is required')
      }

      const bytes = Buffer.byteLength(spec.userData, 'utf8')
      if (bytes > CAPABILITIES.userDataMaxBytes) {
        throw new ProviderError(
          'invalid_spec',
          `userData is ${bytes} bytes, over hetzner's ${CAPABILITIES.userDataMaxBytes}-byte ceiling`,
        )
      }
    },

    /**
     * Every type this provider can sell in its location, including sold-out ones.
     *
     * `available: false` rather than omission is amendment B1, and it comes straight from this
     * provider's own measurements: Hetzner publishes prices for types it cannot sell, and at
     * spike time had zero arm64 stock in every ARM location. Omitting them left core unable to
     * tell "this cloud has no ARM" from "ARM is sold out this afternoon" — two situations
     * needing different messages and different fallbacks.
     */
    async listOfferings(): Promise<Offering[]> {
      // Both in one round trip. `/pricing` is only consulted for the CURRENCY: Hetzner quotes
      // in the project's billing currency, and a number without its currency is not a price
      // (amendment B2). A project that cannot read /pricing still gets offerings — it just
      // falls back to the bundled table's currency.
      const [types, currency] = await Promise.all([
        api.collect<HetznerServerType>('/server_types', 'server_types'),
        api
          .call<{ pricing?: { currency?: string } }>('GET', '/pricing')
          .then((body) => body.pricing?.currency)
          .catch(() => undefined),
      ])
      const fetchedAt = new Date().toISOString()

      return types.flatMap<Offering>((type) => {
        // Per-TYPE deprecation means retired everywhere; drop those. Per-LOCATION deprecation
        // is different and lives in locations[] — a type can be `deprecated: false` while
        // carrying an `unavailable_after` for one site.
        if (type.deprecated) return []

        const here = type.locations?.find((l) => l.name === location)
        const soldHere = here !== undefined || type.prices.some((p) => p.location === location)
        if (!soldHere) return []

        // LIVE FIRST (gyp1.3). The price is already in this response; preferring a bundled
        // number would mean showing something we know to be staler, having saved no request.
        const inline = type.prices.find((p) => p.location === location)
        const hourly =
          inline && currency
            ? livePrice(inline.price_hourly.net, currency, fetchedAt)
            : lookupPrice(prices, type.name, location)

        return [
          {
            id: type.name,
            cpu: type.cores,
            memoryGb: type.memory,
            diskGb: type.disk,
            arch: type.architecture === 'arm' ? 'arm64' : 'amd64',
            hourly,
            // Availability lives ONLY in locations[]. An older payload without it is treated
            // as available, which is what the field's absence used to mean.
            available: here?.available ?? true,
            region: location,
          },
        ]
      })
    },

    async provision(spec: ProvisionSpec): Promise<ProvisionResult> {
      const name = spec.serverId
      const labels = { ...spec.tags, 'managed-by': managedBy }

      const sshKeyIds: number[] = []
      const ownedSshKeyIds: number[] = []
      for (let i = 0; i < spec.sshPublicKeys.length; i++) {
        const { id, owned } = await ensureSshKey(spec.sshPublicKeys[i]!, `${name}-key-${i}`, labels)
        sshKeyIds.push(id)
        if (owned) ownedSshKeyIds.push(id)
      }

      try {
        const result = await api.call<{ server: HetznerServer }>('POST', '/servers', {
          name,
          server_type: spec.offeringId,
          image,
          location,
          start_after_create: true,
          ssh_keys: sshKeyIds,
          labels,
          ...(spec.userData ? { user_data: spec.userData } : {}),
        })
        return {
          data: { serverId: result.server.id, name, ownedSshKeyIds } satisfies HetznerData,
          initial: viewOf(result.server),
        }
      } catch (err) {
        if (hetznerCodeOf(err) === 'uniqueness_error') {
          // Provider-side idempotency. Hetzner has no ClientToken equivalent, so the derived
          // NAME is the mechanism (ADR-0003, C3): a replay of the same create resolves to the
          // ORIGINAL server rather than making a second one.
          const found = (
            await api.call<{ servers: HetznerServer[] }>('GET', `/servers?name=${encodeURIComponent(name)}`)
          ).servers[0]

          if (found) {
            // Re-derive ownership from labels: the keys minted for this server carry them, so a
            // replay still knows what it must clean up later.
            const selector = encodeURIComponent(`managed-by=${managedBy},server-id=${spec.serverId}`)
            const keys = await api.call<{ ssh_keys: HetznerSshKey[] }>('GET', `/ssh_keys?label_selector=${selector}`)

            return {
              data: {
                serverId: found.id,
                name,
                ownedSshKeyIds: keys.ssh_keys.map((k) => k.id),
              } satisfies HetznerData,
              initial: viewOf(found),
            }
          }
        }

        // NO SERVER, SO NOTHING WILL EVER COME BACK FOR THE KEYS (rockysurf-rkh3). Every path
        // that reaches here throws, and core's response to a throwing `provision()` is to mark
        // the row `failed` WITHOUT storing a handle — so the keys minted above are unreachable
        // from the database at the moment this error leaves, and only a human reading
        // `listManaged()` would ever find them. They are attributable to this server and to no
        // other, which is what makes deleting them safe.
        await reapQuietly(ownedSshKeyIds)
        throw err
      }
    },

    /**
     * Read one instance.
     *
     * The 404 → `terminated` mapping is load-bearing for teardown polling, and the propagation
     * grace guarding it is the highest-severity rule in the SDK (A4). Worth stating plainly for
     * this provider: **no propagation gap has ever been observed on Hetzner** — its create
     * response is immediately readable, unlike EC2's eventually-consistent `DescribeInstances`,
     * where a describe 0.1s after a successful launch returned not-found. The grace is honoured
     * anyway, because the rule says a provider may lengthen it and may never skip it, and
     * because "we have not seen it happen" is not the same as "it cannot".
     *
     * It is also nearly free: the grace applies only to an instance never observed running, so
     * the teardown loop — where every instance has been running — never pays for it.
     */
    async describe(data: ProviderData): Promise<InstanceView> {
      const { serverId } = asHetznerData(data)
      const attempts = seenRunning.has(serverId) ? 1 : Math.max(1, grace.attempts)

      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const { server } = await api.call<{ server: HetznerServer }>('GET', `/servers/${serverId}`)
          return viewOf(server)
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
      const { serverId, ownedSshKeyIds } = asHetznerData(data)

      // Idempotent: not-found is success. A second call is a no-op, not an error.
      await deleteIgnoringNotFound(`/servers/${serverId}`)
      seenRunning.delete(serverId)

      // Secondary resources this server owns. A crash between the two deletes leaves a key the
      // database no longer references, which is exactly what listManaged() reports so the
      // reconciler can sweep it.
      for (const keyId of ownedSshKeyIds) {
        await deleteIgnoringNotFound(`/ssh_keys/${keyId}`)
      }
    },

    /**
     * Everything attributable to this installation.
     *
     * Instances in EVERY state that still exists are included, `terminating` among them — that
     * is the asymmetry the SDK calls out, and the reason a zero-orphan audit uses
     * `stillExistsAtProvider()` rather than `!isTerminalInstanceState()`.
     *
     * Hetzner has no `shared` resources: unlike AWS's security group, nothing here outlives the
     * servers it serves, so every row is `server-owned`. A key whose `server-id` label is
     * missing reports no `serverId`, which is itself worth surfacing — an owned resource nobody
     * can attribute cannot be safely reaped by server.
     */
    async listManaged(): Promise<ManagedResource[]> {
      const [servers, keys] = await Promise.all([
        api.collect<HetznerServer>(`/servers?label_selector=${labelSelector()}`, 'servers'),
        api.collect<HetznerSshKey>(`/ssh_keys?label_selector=${labelSelector()}`, 'ssh_keys'),
      ])

      const attribute = (labels: Record<string, string> | undefined, fallback?: string) => {
        const serverId = labels?.['server-id'] ?? fallback
        return serverId ? { serverId } : {}
      }

      return [
        ...servers.map<ManagedResource>((server) => ({
          kind: 'instance',
          providerNativeId: String(server.id),
          ownership: 'server-owned',
          ...attribute(server.labels, server.name),
        })),
        ...keys.map<ManagedResource>((key) => ({
          kind: 'ssh-key',
          providerNativeId: String(key.id),
          ownership: 'server-owned',
          ...attribute(key.labels),
        })),
      ]
    },

    /**
     * ACPI shutdown, not `poweroff`: both preserve the disk, but poweroff is a yanked plug and
     * this runs on boxes with an agent mid-install. The returned Action is not awaited —
     * `describe()` is the poller, and blocking here would make a fast call slow for everyone.
     */
    async stop(data: ProviderData): Promise<void> {
      const { serverId } = asHetznerData(data)
      await api.call<unknown>('POST', `/servers/${serverId}/actions/shutdown`, {})
    },

    async start(data: ProviderData): Promise<void> {
      const { serverId } = asHetznerData(data)
      await api.call<unknown>('POST', `/servers/${serverId}/actions/poweron`, {})
      // The IP survives a stop on Hetzner (ipStableAcrossStop: true), so unlike AWS there is
      // nothing for core to re-read afterwards.
    },
  }
}
