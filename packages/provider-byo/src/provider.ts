import {
  assertHostnameSafeId,
  ProviderError,
  unsupportedOperationError,
  type ComputeProvider,
  type InstanceView,
  type ManagedResource,
  type Offering,
  type ProviderCapabilities,
  type ProviderData,
  type ProvisionResult,
  type ProvisionSpec,
} from '@rockysurf/provider-sdk'
import type { ByoHost, ByoProviderInput } from './config.js'
import { assertSafeAccount, buildPrepareScript, parseHostFacts, PROBE_SCRIPT, type HostFacts } from './prepare.js'
import {
  connectOverSsh,
  fingerprintFromPublicKeyLine,
  HostKeyMismatchError,
  scriptCommand,
  toProviderError,
  type Connector,
  type HostConnection,
} from './ssh.js'

export const BYO_PROVIDER_ID = 'byo'

/**
 * Capabilities, and every one of them is a limitation honestly stated.
 *
 * `stop: false` is the load-bearing one: core does not own the power state of a machine it did
 * not create, so there is nothing to call. Per ADR-0003 (A2) `stop()` and `start()` still EXIST —
 * core branches on this flag and never on whether the method is there — and both throw.
 *
 * `generatesUserData: false` forces `canInjectHostKeys: false`: with no pre-boot document there
 * is nowhere to put a host key before first contact, so the key has to be learned instead. See
 * `ssh.ts` for where that trust decision lives and why it does not live in core.
 */
export const BYO_CAPABILITIES: ProviderCapabilities = {
  stop: false,
  ipStableAcrossStop: true,
  canInjectHostKeys: false,
  userDataMaxBytes: 0,
  generatesUserData: false,
}

/**
 * The opaque handle core persists per server.
 *
 * It is deliberately a complete description of the claim rather than a key into this process's
 * memory. A control plane that restarts has only the database, and `describe()` uses these
 * fields to re-adopt a claim — including the pinned fingerprint, which would otherwise be
 * forgotten and silently downgrade a pinned host back to trust-on-first-use.
 */
export interface ByoData extends ProviderData {
  /** The registered host's `name`. Its identity everywhere: offering id, managed-resource id. */
  hostName: string
  /** Core's server id, so a claim can be re-adopted and attributed after a restart. */
  serverId: string
  address: string
  port: number
  /** The admin account the provider claimed with. */
  adminUser: string
  /** The account core connects as — created by `provision()`, matching core's `sshUser`. */
  sshUser: string
  /** `SHA256:…` this host presented when it was claimed, and must present forever after. */
  hostKeyFingerprint: string
  /**
   * The host key itself, as an OpenSSH public-key line, when this provider has met the box
   * (rockysurf-ftl9.14). Optional: a handle written before this field existed carries only the
   * fingerprint, and re-adoption must still work on one.
   */
  hostPublicKey?: string
}

/** Parse the opaque handle, failing loudly rather than reading `undefined.hostName` later. */
export function asByoData(data: ProviderData): ByoData {
  const hostName = data['hostName']
  const serverId = data['serverId']
  const hostKeyFingerprint = data['hostKeyFingerprint']
  if (typeof hostName !== 'string' || typeof serverId !== 'string' || typeof hostKeyFingerprint !== 'string') {
    throw new ProviderError(
      'invalid_spec',
      'provider data is not a BYO handle: expected { hostName, serverId, hostKeyFingerprint }',
    )
  }
  return {
    hostName,
    serverId,
    hostKeyFingerprint,
    ...(typeof data['hostPublicKey'] === 'string' && data['hostPublicKey']
      ? { hostPublicKey: data['hostPublicKey'] }
      : {}),
    address: typeof data['address'] === 'string' ? data['address'] : '',
    port: typeof data['port'] === 'number' ? data['port'] : 22,
    adminUser: typeof data['adminUser'] === 'string' ? data['adminUser'] : 'root',
    sshUser: typeof data['sshUser'] === 'string' ? data['sshUser'] : 'rocky',
  }
}

/** One host held by one server. The whole of BYO's "provisioning". */
interface Claim {
  hostName: string
  serverId: string
  idempotencyKey: string
  hostKeyFingerprint: string
  /** Empty until this process has met the box; see the `keys` map. */
  hostPublicKey: string
  claimedAt: string
}

export function makeByoProvider(input: ByoProviderInput): ComputeProvider {
  const { hosts, sshUser, managedBy, region } = input
  const connect: Connector = input.connect ?? connectOverSsh
  const agentSocket = input.agentSocket ?? process.env['SSH_AUTH_SOCK']

  assertSafeAccount(sshUser)
  assertUniqueNames(hosts)

  /** Claims, by host name. One host, at most one server. */
  const claims = new Map<string, Claim>()

  /**
   * Pinned host keys, by host name — seeded from configuration and then never weakened.
   *
   * A pin OUTLIVES the claim on purpose. Trust-on-first-use means the key is learned once, for
   * the registration, not once per server: forgetting it on `terminate()` would reopen the
   * unverified-first-connection window every time a host is recycled, which is precisely the
   * window TOFU exists to close after the first pass through it.
   */
  const pins = new Map<string, string>()
  for (const host of hosts) if (host.fingerprint) pins.set(host.name, host.fingerprint)

  /**
   * The host KEYS behind those pins, by host name (rockysurf-ftl9.14).
   *
   * Deliberately a second map rather than a richer `pins` value, because the two are not learned
   * at the same time and must not be confused: a pin can come from configuration, where the
   * operator supplies a fingerprint and no key. A key only ever arrives from a completed
   * handshake this provider made, and only after the pin agreed. Nothing here is ever trusted
   * because it is in this map; the pin decides, always.
   */
  const keys = new Map<string, string>()

  /** Probed hardware, by host name. Hardware does not change under a running process. */
  const facts = new Map<string, HostFacts>()

  const hostByName = (name: string): ByoHost | undefined => hosts.find((host) => host.name === name)
  const registered = () => hosts.map((host) => host.name).join(', ') || '(none)'

  /**
   * Connect, honouring the pin — or learn it.
   *
   * The check after the handshake is not redundant with the verifier inside the connector. The
   * connector is an injection point, and a pin enforced only inside the thing a caller can
   * replace is not enforced at all; this is the provider refusing on its own authority.
   */
  async function connectTo(host: ByoHost): Promise<HostConnection> {
    const identityFile = host.identityFile ?? input.identityFile
    if (!identityFile && !agentSocket) {
      throw new ProviderError(
        'auth',
        `no SSH credential for host '${host.name}': set identityFile on the host or the provider, ` +
          'or run an SSH agent (SSH_AUTH_SOCK) that already holds the key you log in with',
      )
    }

    const pinned = pins.get(host.name)
    let connection: HostConnection
    try {
      connection = await connect({
        host: host.host,
        port: host.port,
        user: host.user,
        ...(pinned ? { pinnedFingerprint: pinned } : {}),
        ...(identityFile ? { identityFile } : {}),
        ...(agentSocket ? { agentSocket } : {}),
        ...(input.connectTimeoutMs !== undefined ? { timeoutMs: input.connectTimeoutMs } : {}),
      })
    } catch (err) {
      throw toProviderError(err, host.host)
    }

    if (pinned && connection.fingerprint !== pinned) {
      connection.end()
      throw toProviderError(new HostKeyMismatchError(host.host, pinned, connection.fingerprint), host.host)
    }
    // First contact on a host whose fingerprint the operator did not supply. Record it; every
    // connection from here on is strict against this value.
    if (!pinned) pins.set(host.name, connection.fingerprint)
    // The key is recorded only HERE — after the pin above either matched or was just learned, so
    // by construction it hashes to the pin. That is the invariant core re-checks before it hands
    // the key to anybody (rockysurf-ftl9.14).
    if (connection.publicKey) keys.set(host.name, connection.publicKey)
    return connection
  }

  async function run(host: ByoHost, connection: HostConnection, script: string, what: string): Promise<string> {
    // Root needs no sudo, and asking for it on a box without the binary fails a claim that would
    // otherwise have worked.
    const result = await connection.exec(scriptCommand(script, host.user !== 'root'))
    if (result.code !== 0) {
      throw new ProviderError('unknown', `${what} on host '${host.name}' failed (exit ${result.code}): ${lastLine(result)}`, {
        providerCode: `exit_${result.code}`,
      })
    }
    return result.stdout
  }

  /** Read a host's hardware once, and remember it. */
  async function measure(host: ByoHost): Promise<HostFacts> {
    const known = facts.get(host.name)
    if (known) return known

    const connection = await connectTo(host)
    try {
      const stdout = await run(host, connection, PROBE_SCRIPT, 'reading hardware')
      const measured = parseHostFacts(stdout)
      facts.set(host.name, measured)
      return measured
    } catch (err) {
      if (err instanceof ProviderError) throw err
      throw new ProviderError('unknown', `could not read hardware from host '${host.name}': ${String(err)}`, { cause: err })
    } finally {
      connection.end()
    }
  }

  function viewOf(host: ByoHost, fingerprint: string, publicKey = keys.get(host.name)): InstanceView {
    return {
      // A claimed host is running. BYO has no control plane to ask, and the claim IS the state:
      // there is no API that could report `pending`, and a box that is powered off looks exactly
      // like one that is up until something connects to it. Liveness is bootstrap's problem —
      // it is the thing that actually opens a connection — and the provisioning timeout is what
      // bounds a host that never answers.
      state: 'running',
      publicIp: host.host,
      offeringId: host.name,
      hostKeyFingerprint: fingerprint,
      // The key behind that fingerprint, when this provider has actually met the box (E14). It
      // is what lets core serve a `known_hosts` entry for a machine it did not key, so that no
      // generated ssh config has to settle for anything weaker than strict verification.
      ...(publicKey ? { hostPublicKey: publicKey } : {}),
      // The registry's port, so core dials the same sshd this provider just claimed (E13). The
      // operator configured this box; 22 is a default here, never an assumption.
      sshPort: host.port,
    }
  }

  function dataOf(host: ByoHost, claim: Claim): ByoData {
    return {
      hostName: host.name,
      serverId: claim.serverId,
      address: host.host,
      port: host.port,
      adminUser: host.user,
      sshUser,
      hostKeyFingerprint: claim.hostKeyFingerprint,
      ...(claim.hostPublicKey ? { hostPublicKey: claim.hostPublicKey } : {}),
    }
  }

  return {
    id: BYO_PROVIDER_ID,
    displayName: 'Bring your own hosts',
    capabilities: BYO_CAPABILITIES,

    /**
     * There is no credential to validate — so this proves the hosts instead.
     *
     * On a cloud provider this is "the cheapest authenticated call that also proves the region
     * exists". The BYO equivalent is the only thing an operator actually needs told before they
     * create a server: that every registered box answers, presents the key it is supposed to, and
     * lets us in. It also warms the hardware cache, so the first `listOfferings()` is free.
     */
    async validateCredentials(): Promise<void> {
      if (hosts.length === 0) {
        throw new ProviderError('invalid_spec', 'no BYO hosts are registered: add entries under providers.byo.hosts')
      }
      for (const host of hosts) await measure(host)
    },

    /**
     * Reject a spec before anything is claimed (ADR-0003, A7).
     *
     * All local, none of it opens a connection — which is the point of having it separate from
     * `provision()`, since the expensive part of a BYO provision is the SSH round trip.
     */
    async validateSpec(spec: ProvisionSpec): Promise<void> {
      assertHostnameSafeId(spec.serverId)

      const declared = spec.tags['managed-by']
      if (declared !== managedBy) {
        throw new ProviderError(
          'invalid_spec',
          `spec tags managed-by='${declared ?? '(absent)'}' disagrees with this provider's '${managedBy}': ` +
            'the host would be invisible to listManaged() and an orphan from the moment it is claimed',
        )
      }

      if (spec.sshPublicKeys.length === 0) {
        // Fatal here in a way it is not elsewhere: user-data is how the cloud providers get their
        // keys onto a box, and BYO has none, so this list is the ONLY route by which core's
        // identity reaches the machine.
        throw new ProviderError('invalid_spec', 'at least one ssh public key is required')
      }

      if (spec.userData !== '') {
        throw new ProviderError(
          'invalid_spec',
          `userData is ${Buffer.byteLength(spec.userData, 'utf8')} bytes and byo accepts none: ` +
            'there is no pre-boot hook on a machine that is already running',
        )
      }

      const host = hostByName(spec.offeringId)
      if (!host) {
        // Deterministic rather than "any free host": an operator who asked for the box in the
        // corner should not get the one in the rack because the first was busy.
        throw new ProviderError(
          'invalid_spec',
          `offeringId '${spec.offeringId}' is not a registered BYO host. Registered hosts: ${registered()}`,
        )
      }

      const measured = facts.get(host.name)
      if (measured && measured.arch !== spec.arch) {
        throw new ProviderError(
          'invalid_spec',
          `host '${host.name}' is ${measured.arch} but the spec asks for ${spec.arch}: ` +
            'the install plan would fetch binaries this machine cannot run',
        )
      }
    },

    /**
     * One offering per registered host, because on BYO the host IS the machine type.
     *
     * `available: false` for a claimed host is amendment B1 in its BYO form — reported rather
     * than hidden, so a size selector can say "in use by another server" instead of leaving a box
     * the operator can see mysteriously missing from the list.
     *
     * A host that cannot be measured is omitted, and that is the one place this provider chooses
     * silence: the alternative is inventing a core count and a memory size to satisfy the
     * `Offering` shape, and a fabricated spec is worse than an absent one. `validateCredentials()`
     * is where an unreachable host is reported loudly.
     */
    async listOfferings(): Promise<Offering[]> {
      const offerings: Offering[] = []
      for (const host of hosts) {
        let measured: HostFacts
        try {
          measured = await measure(host)
        } catch {
          continue
        }
        offerings.push({
          id: host.name,
          cpu: measured.cpu,
          memoryGb: measured.memoryGb,
          ...(measured.diskGb !== undefined ? { diskGb: measured.diskGb } : {}),
          arch: measured.arch,
          // `null` is "unknown", never "free" (see `Price`). Rocky Surf has no idea what the
          // operator's own hardware, power and rack space cost them, and a 0 here would be
          // presented as a price.
          hourly: null,
          available: !claims.has(host.name),
          region,
        })
      }
      return offerings
    },

    /**
     * Claim a registered host and make it look like a freshly provisioned one.
     *
     * The claim is RESERVED before the SSH work and released if it fails, so two concurrent
     * creates cannot both walk away believing they own the same box. Re-running the preparation
     * is safe — the script is idempotent — so a released claim costs a retry, not a broken host.
     */
    async provision(spec: ProvisionSpec): Promise<ProvisionResult> {
      // A replay returns the ORIGINAL claim and touches nothing. `provision()` must not assume
      // `validateSpec()` was called, so this runs before any of the checks that follow.
      for (const claim of claims.values()) {
        if (claim.idempotencyKey !== spec.idempotencyKey) continue
        const host = hostByName(claim.hostName)
        if (!host) break
        return { data: dataOf(host, claim), initial: viewOf(host, claim.hostKeyFingerprint) }
      }

      const host = hostByName(spec.offeringId)
      if (!host) {
        throw new ProviderError(
          'invalid_spec',
          `offeringId '${spec.offeringId}' is not a registered BYO host. Registered hosts: ${registered()}`,
        )
      }
      if (spec.sshPublicKeys.length === 0) {
        throw new ProviderError('invalid_spec', 'at least one ssh public key is required')
      }

      const held = claims.get(host.name)
      if (held && held.serverId !== spec.serverId) {
        // `capacity`, and therefore retryable: the pool has no stock right now, which is exactly
        // what a claimed host is. Nothing about the request is wrong.
        throw new ProviderError(
          'capacity',
          `host '${host.name}' is already claimed by server ${held.serverId}`,
          { providerCode: 'host_claimed' },
        )
      }

      const reservation: Claim = {
        hostName: host.name,
        serverId: spec.serverId,
        idempotencyKey: spec.idempotencyKey,
        hostKeyFingerprint: pins.get(host.name) ?? '',
        hostPublicKey: keys.get(host.name) ?? '',
        claimedAt: new Date().toISOString(),
      }
      claims.set(host.name, reservation)

      try {
        const connection = await connectTo(host)
        try {
          await run(host, connection, buildPrepareScript(sshUser, spec.sshPublicKeys), 'preparing the host')
          reservation.hostKeyFingerprint = connection.fingerprint
          reservation.hostPublicKey = connection.publicKey
        } finally {
          connection.end()
        }
      } catch (err) {
        claims.delete(host.name)
        throw err
      }

      return { data: dataOf(host, reservation), initial: viewOf(host, reservation.hostKeyFingerprint) }
    },

    /**
     * Report the claim, and re-adopt it when this process has forgotten it.
     *
     * The adoption is what makes BYO survive a control-plane restart. Claims live in memory —
     * there is no cloud to hold them — so after a restart the only record is the handle core
     * persisted, and a `describe()` that reported "gone" would hand the host to the next create
     * while a server was still using it. The pinned fingerprint is re-adopted with it, so a
     * restart cannot quietly downgrade a pinned host back to trust-on-first-use.
     *
     * ON THE PROPAGATION GRACE (A4), and why `assertDescribeAbsenceGrace` is deliberately NOT
     * wired here (rockysurf-5i28 asked; this is the answer):
     *
     * The grace guards a specific ambiguity — a create that has not propagated is
     * indistinguishable, on the first read, from a termination. **BYO has no create.** The host
     * existed before Rocky Surf did, the claim is written into an in-memory map by the same
     * process that reads it, and after a restart the persisted handle is re-adopted above rather
     * than read as absence. So the window the grace exists to survive cannot open, and there is
     * no read path to retry against: scripting one absent-then-present sequence to satisfy the
     * harness would be asserting a fiction.
     *
     * The two ways this method reports absence are both DURABLE facts, not propagation delay: an
     * operator deregistered the host, or another server holds the claim. Four retries two seconds
     * apart would delay a definite answer, not improve it. `provider.test.ts` asserts the
     * property the grace would otherwise buy — a just-claimed host is never reported terminated,
     * on the first read.
     *
     * THE PREMISE HAS AN EXPIRY, so it is pinned by a test rather than left to this comment. All
     * of the above rests on this method doing NO I/O, which is a property of the implementation
     * and not of BYO's nature — "is the box actually up?" is a plausible future ask for a
     * provider whose instances are somebody's hardware. A reachability probe here would make
     * absence transient, and worse than the cloud case: a propagation window opens once after a
     * create, a rebooting host recurs for the life of the box. `provider.test.ts` fails if this
     * method ever opens a connection, and that failure is the signal to wire
     * `assertDescribeAbsenceGrace` — not to edit this paragraph.
     */
    async describe(data: ProviderData): Promise<InstanceView> {
      const handle = asByoData(data)
      const host = hostByName(handle.hostName)
      // Deregistered by the operator. Core stops managing it; the machine itself is untouched.
      if (!host) return { state: 'terminated' }

      if (!pins.has(host.name) && handle.hostKeyFingerprint) pins.set(host.name, handle.hostKeyFingerprint)
      // The key comes back from STORAGE here, not from a handshake, so it is checked against the
      // pin before it is believed (rockysurf-ftl9.14). A stored key that does not hash to the
      // pin is dropped in silence rather than adopted: the pin was verified during a real
      // handshake and this was not, so on disagreement the pin is the one that survives, and the
      // next connection re-learns the key from the box itself.
      const adopted = handle.hostPublicKey
      if (adopted && !keys.has(host.name) && fingerprintFromPublicKeyLine(adopted) === pins.get(host.name)) {
        keys.set(host.name, adopted)
      }

      const claim = claims.get(host.name)
      if (!claim) {
        claims.set(host.name, {
          hostName: host.name,
          serverId: handle.serverId,
          idempotencyKey: '',
          hostKeyFingerprint: handle.hostKeyFingerprint,
          hostPublicKey: keys.get(host.name) ?? '',
          claimedAt: new Date().toISOString(),
        })
        return viewOf(host, handle.hostKeyFingerprint)
      }

      // Someone else holds it. This server no longer has a machine, and saying so is what lets
      // core move the row to a terminal state instead of bootstrapping a box it does not own.
      if (claim.serverId !== handle.serverId) return { state: 'terminated' }

      return viewOf(host, claim.hostKeyFingerprint)
    },

    /**
     * Release the claim. **Nothing runs on the machine — not one command, not one connection.**
     *
     * This is the sharpest difference between BYO and a cloud provider, and it is a rule rather
     * than an omission. `terminate()` on EC2 destroys a machine Rocky Surf created; the machine
     * here is the operator's, was running before Rocky Surf existed, and may be running someone
     * else's work. Deleting the `rocky` account, revoking sudo or removing authorized keys on the
     * way out would be Rocky Surf reaching into infrastructure it does not own — and doing it
     * from a background reconciler sweep, at that.
     *
     * That rule is also what makes `listManaged()` safe to report as `server-owned`: an
     * unmatched claim reads to the reconciler as a reap candidate, and reaping it costs a claim
     * record, never a machine.
     *
     * Idempotent by contract: a claim that is not there is success, not an error.
     */
    async terminate(data: ProviderData): Promise<void> {
      const handle = asByoData(data)
      const claim = claims.get(handle.hostName)
      if (!claim) return
      // Never release someone else's claim: a stale handle for a recycled host would otherwise
      // evict the server that legitimately holds it.
      if (claim.serverId !== handle.serverId) return
      claims.delete(handle.hostName)
      // The pin stays. See `pins` — trust is learned per registration, not per claim.
    },

    /**
     * Claimed hosts, and nothing else.
     *
     * An UNCLAIMED registered host is not reported: `listManaged()` is the reconciler's list of
     * things this installation created and could leak, and a machine that was already there is
     * neither. A claim is the only thing BYO can leak, so a claim is the only thing here.
     */
    async listManaged(): Promise<ManagedResource[]> {
      return [...claims.values()].map<ManagedResource>((claim) => ({
        kind: 'host',
        providerNativeId: claim.hostName,
        ownership: 'server-owned',
        serverId: claim.serverId,
      }))
    },

    /**
     * Required, and throwing, because `capabilities.stop` is false (ADR-0003, A2).
     *
     * Core does not own the power state of a machine it did not create. There is no BYO API that
     * could halt it, and reaching for `shutdown -h now` over SSH would be the provider taking a
     * decision about someone else's hardware that the capability flag says it cannot take.
     */
    async stop(): Promise<void> {
      throw unsupportedOperationError(BYO_PROVIDER_ID, 'stop')
    },

    async start(): Promise<void> {
      throw unsupportedOperationError(BYO_PROVIDER_ID, 'start')
    },
  }
}

function assertUniqueNames(hosts: readonly ByoHost[]): void {
  const seen = new Set<string>()
  for (const host of hosts) {
    if (seen.has(host.name)) {
      // The name is the offering id, the claim key and the managed-resource id all at once, so a
      // duplicate is not a cosmetic problem: two rows would fight over one record.
      throw new ProviderError('invalid_spec', `duplicate BYO host name '${host.name}': names identify hosts everywhere`)
    }
    seen.add(host.name)
  }
}

/** The last thing a failing script said. Installers put their verdict on the final line. */
function lastLine(result: { stdout: string; stderr: string }): string {
  const text = result.stderr.trim() || result.stdout.trim()
  const line = text.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '(no output)'
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}
