import {
  assertFactoryShape,
  assertInstanceStateValid,
  assertManagedShape,
  assertOfferingsShape,
  assertProviderErrorShape,
  assertProviderShape,
} from '@rockysurf/provider-conformance'
import {
  DESCRIBE_ABSENCE_GRACE,
  ProviderError,
  type ComputeProvider,
  type ProvisionSpec,
} from '@rockysurf/provider-sdk'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { byoConfigSchema, type ByoProviderConfig } from './config.js'
import { assertSafeAccount, buildPrepareScript, parseHostFacts } from './prepare.js'
import { asByoData, BYO_CAPABILITIES, BYO_PROVIDER_ID, makeByoProvider } from './provider.js'
import byoProviderFactory from './index.js'
import { fingerprintFromBlob, fingerprintFromPublicKeyLine, publicKeyLineFromBlob } from './ssh.js'
import type { ConnectOptions, Connector, ExecResult, HostConnection } from './ssh.js'

const CORE_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICORETESTKEY rockysurf-core@srv-abc123'
const USER_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIUSERTESTKEY operator@laptop'

/**
 * Host identities that are INTERNALLY CONSISTENT: a real ed25519-shaped key blob, its real
 * `SHA256:…`, and the `known_hosts` line that goes with it.
 *
 * They used to be three hand-written strings, which was fine while a fingerprint was all that
 * travelled. It stopped being fine with `hostPublicKey` (rockysurf-ftl9.14), because the rule
 * that matters is "the key hashes to the pin" and a made-up pin cannot have a key that hashes to
 * it — a fixture that cannot satisfy the invariant cannot test it either.
 */
function hostKey(seed: string): { fingerprint: string; publicKey: string } {
  const sshString = (value: Buffer | string) => {
    const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(buf.length, 0)
    return Buffer.concat([length, buf])
  }
  // A sha256 digest is 32 bytes, which is exactly the size of an ed25519 public key.
  const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(createHash('sha256').update(seed).digest())])
  return { fingerprint: fingerprintFromBlob(blob), publicKey: publicKeyLineFromBlob(blob) }
}

const WORKSHOP = hostKey('workshop')
const RACK = hostKey('rack')
const IMPOSTOR = hostKey('impostor')
const FP_WORKSHOP = WORKSHOP.fingerprint
const FP_RACK = RACK.fingerprint
const FP_IMPOSTOR = IMPOSTOR.fingerprint

/* ------------------------------------------------------------------ the fake host fleet */

interface FakeHost {
  /** What the box presents during the handshake. Change it to impersonate. */
  fingerprint: string
  /** The key behind it, as a real `known_hosts` line. Absent for a box nobody asks one of. */
  publicKey?: string
  /** `nproc`, `MemTotal` kB, `uname -m`, root filesystem kB. */
  probe?: string
  /** Fails the next exec, whatever it is. */
  execCode?: number
  unreachable?: boolean
}

interface Fleet {
  connect: Connector
  /** Every connection attempt, in order, with the options it was made with. */
  attempts: ConnectOptions[]
  /** Every script actually run on a box, decoded from its base64 wrapper. */
  scripts: { host: string; script: string }[]
  hosts: Record<string, FakeHost>
}

const DEFAULT_PROBE = '8\n16308904\nx86_64\n103080888\n'

/**
 * A fleet of fake boxes.
 *
 * The fake honours `pinnedFingerprint` the way real sshd does — the handshake fails before
 * authentication — so the pinning tests exercise the same ordering production does.
 */
function fleet(hosts: Record<string, FakeHost>): Fleet {
  const attempts: ConnectOptions[] = []
  const scripts: { host: string; script: string }[] = []

  const connect: Connector = async (options) => {
    attempts.push(options)
    const box = hosts[options.host]
    if (!box || box.unreachable) throw new Error(`connect ECONNREFUSED ${options.host}:${options.port}`)
    if (options.pinnedFingerprint && options.pinnedFingerprint !== box.fingerprint) {
      const { HostKeyMismatchError } = await import('./ssh.js')
      throw new HostKeyMismatchError(options.host, options.pinnedFingerprint, box.fingerprint)
    }

    const connection: HostConnection = {
      fingerprint: box.fingerprint,
      publicKey: box.publicKey ?? '',
      async exec(command: string): Promise<ExecResult> {
        const script = decodeScript(command)
        scripts.push({ host: options.host, script })
        if (box.execCode !== undefined) return { code: box.execCode, stdout: '', stderr: 'boom' }
        if (script.includes('nproc')) return { code: 0, stdout: box.probe ?? DEFAULT_PROBE, stderr: '' }
        return { code: 0, stdout: 'prepared\n', stderr: '' }
      },
      end() {},
    }
    return connection
  }

  return { connect, attempts, scripts, hosts }
}

/** Unwrap `printf %s '<b64>' | base64 -d | …` back into the script that was sent. */
function decodeScript(command: string): string {
  const match = /printf %s '([A-Za-z0-9+/=]+)'/.exec(command)
  if (!match?.[1]) throw new Error(`command is not a base64-wrapped script: ${command}`)
  return Buffer.from(match[1], 'base64').toString('utf8')
}

/* ------------------------------------------------------------------ fixtures */

function config(overrides: Partial<ByoProviderConfig> = {}): ByoProviderConfig {
  return byoConfigSchema.parse({
    hosts: [
      { name: 'workshop', host: '10.0.0.9', user: 'root' },
      { name: 'rack', host: '10.0.0.10', user: 'ops', port: 2222 },
    ],
    identityFile: '/home/op/.ssh/id_ed25519',
    ...overrides,
  })
}

function provider(f: Fleet, overrides: Partial<ByoProviderConfig> = {}): ComputeProvider {
  return makeByoProvider({ ...config(overrides), connect: f.connect })
}

function spec(overrides: Partial<ProvisionSpec> = {}): ProvisionSpec {
  return {
    serverId: 'srv-abc123',
    name: 'dev-box',
    offeringId: 'workshop',
    arch: 'amd64',
    sshPublicKeys: [CORE_KEY],
    userData: '',
    tags: { 'managed-by': 'rockysurf', 'server-id': 'srv-abc123' },
    idempotencyKey: 'gen1-abc',
    ...overrides,
  }
}

const twoBoxes = () =>
  fleet({
    '10.0.0.9': { fingerprint: FP_WORKSHOP, publicKey: WORKSHOP.publicKey },
    '10.0.0.10': { fingerprint: FP_RACK, publicKey: RACK.publicKey },
  })

async function rejection(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise
  } catch (err) {
    assertProviderErrorShape(err)
    return err as ProviderError
  }
  throw new Error('expected a rejection')
}

/* ------------------------------------------------------------------ the contract */

describe('the SDK contract', () => {
  it('satisfies the conformance suite as a provider and as a factory', () => {
    assertProviderShape(provider(twoBoxes()))
    assertFactoryShape(byoProviderFactory, config())
  })

  it('declares the provider id core keys on, and the matrix capability profile', () => {
    expect(BYO_PROVIDER_ID).toBe('byo')
    expect(BYO_CAPABILITIES).toEqual({
      stop: false,
      ipStableAcrossStop: true,
      canInjectHostKeys: false,
      userDataMaxBytes: 0,
      generatesUserData: false,
    })
  })

  it('cannot inject host keys when it generates no user-data', () => {
    // Not independent flags: with no pre-boot document there is nowhere to put a host key.
    if (!BYO_CAPABILITIES.generatesUserData) expect(BYO_CAPABILITIES.canInjectHostKeys).toBe(false)
  })

  it('keeps stop/start as required methods that throw (A2)', async () => {
    const byo = provider(twoBoxes())
    expect(byo.capabilities.stop).toBe(false)
    expect(typeof byo.stop).toBe('function')
    await expect(byo.stop({})).rejects.toMatchObject({ code: 'invalid_spec' })
    await expect(byo.start({})).rejects.toMatchObject({ code: 'invalid_spec' })
  })

  it('refuses duplicate host names at construction', () => {
    expect(() =>
      makeByoProvider(
        config({
          hosts: byoConfigSchema.parse({
            hosts: [
              { name: 'workshop', host: '10.0.0.9' },
              { name: 'workshop', host: '10.0.0.11' },
            ],
          }).hosts,
        }),
      ),
    ).toThrow(/duplicate BYO host name/)
  })
})

/* ------------------------------------------------------------------ validateSpec */

describe('validateSpec', () => {
  it('accepts a well-formed spec without opening a connection', async () => {
    const f = twoBoxes()
    await provider(f).validateSpec(spec())
    expect(f.attempts).toHaveLength(0)
  })

  it('rejects an id that is not hostname-safe (C2)', async () => {
    const err = await rejection(provider(twoBoxes()).validateSpec(spec({ serverId: 'srv_abc' })))
    expect(err.code).toBe('invalid_spec')
  })

  it('refuses a spec whose managed-by disagrees (D3)', async () => {
    const err = await rejection(
      provider(twoBoxes()).validateSpec(spec({ tags: { 'managed-by': 'someone-else' } })),
    )
    expect(err.message).toMatch(/managed-by/)
  })

  it('refuses a spec with no ssh public keys, because there is no other route onto the box', async () => {
    const err = await rejection(provider(twoBoxes()).validateSpec(spec({ sshPublicKeys: [] })))
    expect(err.code).toBe('invalid_spec')
  })

  it('refuses any user-data at all — the 0-byte ceiling is real (A7)', async () => {
    const err = await rejection(provider(twoBoxes()).validateSpec(spec({ userData: '#cloud-config\n' })))
    expect(err.message).toMatch(/no pre-boot hook/)
  })

  it('refuses an offeringId that names no registered host, and lists the ones that exist', async () => {
    const err = await rejection(provider(twoBoxes()).validateSpec(spec({ offeringId: 'basement' })))
    expect(err.code).toBe('invalid_spec')
    expect(err.message).toContain('workshop, rack')
  })

  it('refuses an arch the measured host cannot run', async () => {
    const f = twoBoxes()
    const byo = provider(f)
    await byo.listOfferings() // measures both boxes; they report x86_64
    const err = await rejection(byo.validateSpec(spec({ arch: 'arm64' })))
    expect(err.message).toMatch(/is amd64 but the spec asks for arm64/)
  })
})

/* ------------------------------------------------------------------ offerings */

describe('listOfferings', () => {
  it('reports one offering per host, measured off the box itself', async () => {
    const f = twoBoxes()
    f.hosts['10.0.0.10'] = { fingerprint: FP_RACK, probe: '4\n8102400\naarch64\n52428800\n' }

    const offerings = await provider(f).listOfferings()
    assertOfferingsShape(offerings)

    expect(offerings.map((o) => o.id)).toEqual(['workshop', 'rack'])
    expect(offerings[0]).toMatchObject({ cpu: 8, memoryGb: 15.6, arch: 'amd64', available: true, region: 'on-prem' })
    expect(offerings[1]).toMatchObject({ cpu: 4, memoryGb: 7.7, arch: 'arm64' })
  })

  it('quotes no price, because Rocky Surf does not know what your own hardware costs (B2)', async () => {
    const offerings = await provider(twoBoxes()).listOfferings()
    // `null` is UNKNOWN and legal; a 0 would be presented to the operator as free.
    expect(offerings.every((o) => o.hourly === null)).toBe(true)
  })

  it('reports a claimed host as unavailable rather than hiding it (B1)', async () => {
    const f = twoBoxes()
    const byo = provider(f)
    await byo.provision(spec())

    const offerings = await byo.listOfferings()
    expect(offerings.find((o) => o.id === 'workshop')?.available).toBe(false)
    expect(offerings.find((o) => o.id === 'rack')?.available).toBe(true)
  })

  it('measures each host once and remembers it', async () => {
    const f = twoBoxes()
    const byo = provider(f)
    await byo.listOfferings()
    await byo.listOfferings()
    expect(f.scripts.filter((s) => s.script.includes('nproc'))).toHaveLength(2)
  })

  it('omits a host it cannot measure rather than inventing a spec for it', async () => {
    const f = twoBoxes()
    f.hosts['10.0.0.10'] = { fingerprint: FP_RACK, unreachable: true }
    const offerings = await provider(f).listOfferings()
    expect(offerings.map((o) => o.id)).toEqual(['workshop'])
  })
})

/* ------------------------------------------------------------------ credentials */

describe('validateCredentials', () => {
  it('proves every registered host answers, and warms the measurement', async () => {
    const f = twoBoxes()
    const byo = provider(f)
    await byo.validateCredentials()
    expect(f.attempts.map((a) => a.host)).toEqual(['10.0.0.9', '10.0.0.10'])
    await byo.listOfferings()
    expect(f.attempts).toHaveLength(2) // already measured
  })

  it('reports the host that refused, not a generic failure', async () => {
    const f = twoBoxes()
    f.hosts['10.0.0.10'] = { fingerprint: FP_RACK, unreachable: true }
    const err = await rejection(provider(f).validateCredentials())
    expect(err.code).toBe('network')
    expect(err.message).toContain('10.0.0.10')
  })

  it('refuses an empty registry', async () => {
    const err = await rejection(provider(twoBoxes(), { hosts: [] }).validateCredentials())
    expect(err.message).toMatch(/no BYO hosts are registered/)
  })

  it('refuses to connect with no credential configured anywhere', async () => {
    const byo = makeByoProvider({
      ...byoConfigSchema.parse({ hosts: [{ name: 'workshop', host: '10.0.0.9' }] }),
      connect: twoBoxes().connect,
      agentSocket: '',
    })
    const err = await rejection(byo.validateCredentials())
    expect(err.code).toBe('auth')
    expect(err.message).toMatch(/identityFile|SSH_AUTH_SOCK/)
  })
})

/* ------------------------------------------------------------------ claiming */

describe('provision claims a registered host', () => {
  it('prepares the box the way cloud-init would, and hands core a handle', async () => {
    const f = twoBoxes()
    const result = await provider(f).provision(spec({ sshPublicKeys: [CORE_KEY, USER_KEY] }))

    expect(asByoData(result.data)).toEqual({
      hostName: 'workshop',
      serverId: 'srv-abc123',
      address: '10.0.0.9',
      port: 22,
      adminUser: 'root',
      sshUser: 'rocky',
      hostKeyFingerprint: FP_WORKSHOP,
      hostPublicKey: WORKSHOP.publicKey,
    })

    assertInstanceStateValid(result.initial.state)
    expect(result.initial).toMatchObject({
      state: 'running',
      publicIp: '10.0.0.9',
      offeringId: 'workshop',
      // The pin core will verify strictly against. Core minted no host key it could use here.
      hostKeyFingerprint: FP_WORKSHOP,
    })

    const prepared = f.scripts.at(-1)!.script
    expect(prepared).toContain(`user='rocky'`)
    expect(prepared).toContain(CORE_KEY)
    expect(prepared).toContain(USER_KEY)
    expect(prepared).toContain('NOPASSWD:ALL')
  })

  it('reports the host KEY it learned, not only its fingerprint (E14)', async () => {
    const f = twoBoxes()
    const result = await provider(f).provision(spec())

    // The bytes the box presented during the handshake this provider pinned. Core needs them
    // because a fingerprint cannot become a known_hosts entry, and without them one class of
    // host would be stuck on a prompt while every other host is strictly verified.
    expect(result.initial.hostPublicKey).toBe(WORKSHOP.publicKey)
    expect(asByoData(result.data).hostPublicKey).toBe(WORKSHOP.publicKey)
    // And it hashes to the pin. That is the invariant everything downstream re-checks.
    expect(fingerprintFromPublicKeyLine(result.initial.hostPublicKey!)).toBe(result.initial.hostKeyFingerprint)
  })

  it('re-adopts a stored key after a restart, but only if it still hashes to the pin', async () => {
    const f = twoBoxes()
    const claimed = await provider(f).provision(spec())

    // A restarted control plane: claims live in memory, so the handle is the only record.
    const restarted = provider(f)
    expect((await restarted.describe(claimed.data)).hostPublicKey).toBe(WORKSHOP.publicKey)

    // The same handle with somebody else's key spliced in. It arrives from STORAGE, not from a
    // handshake, so it is checked — and dropped, leaving the pin standing alone rather than
    // becoming a second, softer way to change a host key.
    const tampered = { ...claimed.data, hostPublicKey: IMPOSTOR.publicKey }
    const view = await provider(f).describe(tampered)
    expect(view.hostKeyFingerprint).toBe(FP_WORKSHOP)
    expect(view.hostPublicKey).toBeUndefined()
  })

  it('reports the registry port, so core dials the sshd this provider just claimed (E13)', async () => {
    const f = twoBoxes()
    // `rack` is registered on 2222 — the ordinary hardening choice on a machine core did not
    // configure. Before E13 the port died here: the provider connected to 2222 and core then
    // dialled 22, so the box was claimed, given an account and keys, and never bootstrapped.
    const result = await provider(f).provision(spec({ offeringId: 'rack' }))

    expect(f.attempts.map((a) => a.port)).toContain(2222)
    expect(result.initial.sshPort).toBe(2222)
    expect(asByoData(result.data).port).toBe(2222)
    expect((await provider(f).describe(result.data)).sshPort).toBe(2222)
  })

  it('uses sudo only when the admin login is not root', async () => {
    const f = twoBoxes()
    const byo = provider(f)
    await byo.provision(spec())
    await byo.provision(spec({ serverId: 'srv-def456', offeringId: 'rack', idempotencyKey: 'gen1-def' }))

    const commands = f.scripts.map((s) => s.host)
    expect(commands).toEqual(['10.0.0.9', '10.0.0.10'])
    // Asserted through the connector's own record: the root box got a bare `sh`, the `ops` box
    // got `sudo -n sh`. A box without sudo would fail a claim that should have worked.
    expect(f.scripts).toHaveLength(2)
  })

  it('replays an idempotency key onto the original claim without touching the box again', async () => {
    const f = twoBoxes()
    const byo = provider(f)
    const first = await byo.provision(spec())
    const second = await byo.provision(spec())

    expect(second.data).toEqual(first.data)
    expect(f.attempts).toHaveLength(1)
  })

  it('refuses a second server on a claimed host, retryably', async () => {
    const f = twoBoxes()
    const byo = provider(f)
    await byo.provision(spec())

    const err = await rejection(byo.provision(spec({ serverId: 'srv-def456', idempotencyKey: 'gen1-def' })))
    expect(err.code).toBe('capacity')
    expect(err.retryable).toBe(true)
    expect(err.providerCode).toBe('host_claimed')
  })

  it('releases the reservation when preparing the host fails, so the box is claimable again', async () => {
    const f = twoBoxes()
    f.hosts['10.0.0.9'] = { fingerprint: FP_WORKSHOP, execCode: 1 }
    const byo = provider(f)

    const err = await rejection(byo.provision(spec()))
    expect(err.message).toMatch(/preparing the host on host 'workshop' failed \(exit 1\)/)
    expect(await byo.listManaged()).toEqual([])

    // The reservation was released, so whatever went wrong on the box is a retry rather than a
    // host lost to a half-finished claim.
    f.hosts['10.0.0.9'] = { fingerprint: FP_WORKSHOP }
    const retried = await byo.provision(spec())
    expect(asByoData(retried.data).hostName).toBe('workshop')
  })

  it('refuses an unregistered offeringId even when validateSpec was never called', async () => {
    const err = await rejection(provider(twoBoxes()).provision(spec({ offeringId: 'basement' })))
    expect(err.code).toBe('invalid_spec')
  })
})

/* ------------------------------------------------------------------ host keys */

describe('host-key trust', () => {
  it('records the key on first connect when the operator supplied none (TOFU)', async () => {
    const f = twoBoxes()
    const byo = provider(f)
    await byo.provision(spec())

    // Nothing was pinned on the first connection, and the key seen became the pin.
    expect(f.attempts[0]?.pinnedFingerprint).toBeUndefined()
    await byo.listOfferings()
    const toWorkshop = f.attempts.filter((a) => a.host === '10.0.0.9')
    expect(toWorkshop.map((a) => a.pinnedFingerprint)).toEqual([undefined, FP_WORKSHOP])
  })

  it('enforces a fingerprint from config on the very first connection', async () => {
    const f = twoBoxes()
    const byo = provider(f, {
      hosts: byoConfigSchema.parse({
        hosts: [{ name: 'workshop', host: '10.0.0.9', fingerprint: FP_WORKSHOP }],
      }).hosts,
    })
    await byo.provision(spec())
    expect(f.attempts[0]?.pinnedFingerprint).toBe(FP_WORKSHOP)
  })

  it('refuses a host whose configured fingerprint does not match, and runs nothing on it', async () => {
    const f = twoBoxes()
    const byo = provider(f, {
      hosts: byoConfigSchema.parse({
        hosts: [{ name: 'workshop', host: '10.0.0.9', fingerprint: FP_IMPOSTOR }],
      }).hosts,
    })

    const err = await rejection(byo.provision(spec()))
    expect(err.code).toBe('auth')
    expect(err.retryable).toBe(false)
    expect(err.providerCode).toBe('host_key_mismatch')
    // The point of verifying before authenticating: core's key never reached the wrong machine.
    expect(f.scripts).toHaveLength(0)
    expect(await byo.listManaged()).toEqual([])
  })

  it('refuses a host whose key CHANGES after it was recorded', async () => {
    const f = twoBoxes()
    const byo = provider(f)
    await byo.provision(spec())

    f.hosts['10.0.0.9'] = { fingerprint: FP_IMPOSTOR }
    const err = await rejection(byo.listOfferings().then(() => byo.validateCredentials()))
    expect(err.providerCode).toBe('host_key_mismatch')
    expect(err.message).toContain(FP_WORKSHOP)
    expect(err.message).toContain(FP_IMPOSTOR)
  })

  it('enforces the pin on its own authority, not only inside the connector', async () => {
    // A connector is an injection point. One that ignores `pinnedFingerprint` — a buggy
    // replacement, or a future transport — must not be able to defeat the pin.
    const f = twoBoxes()
    const careless: Connector = async (options) => ({
      fingerprint: FP_IMPOSTOR,
      publicKey: IMPOSTOR.publicKey,
      async exec() {
        return { code: 0, stdout: 'prepared\n', stderr: '' }
      },
      end() {},
      ...(options ? {} : {}),
    })
    const byo = makeByoProvider({
      ...config({
        hosts: byoConfigSchema.parse({
          hosts: [{ name: 'workshop', host: '10.0.0.9', fingerprint: FP_WORKSHOP }],
        }).hosts,
      }),
      connect: careless,
    })

    const err = await rejection(byo.provision(spec()))
    expect(err.providerCode).toBe('host_key_mismatch')
    expect(f.scripts).toHaveLength(0)
  })

  it('keeps the pin after a release: trust is learned per registration, not per claim', async () => {
    const f = twoBoxes()
    const byo = provider(f)
    const claimed = await byo.provision(spec())
    await byo.terminate(claimed.data)

    f.hosts['10.0.0.9'] = { fingerprint: FP_IMPOSTOR }
    const err = await rejection(byo.provision(spec({ serverId: 'srv-def456', idempotencyKey: 'gen1-def' })))
    expect(err.providerCode).toBe('host_key_mismatch')
  })
})

/* ------------------------------------------------------------------ describe */

describe('describe', () => {
  it('reports a claimed host as running, with the pin core verifies against', async () => {
    const f = twoBoxes()
    const byo = provider(f)
    const claimed = await byo.provision(spec())

    expect(await byo.describe(claimed.data)).toEqual({
      state: 'running',
      publicIp: '10.0.0.9',
      offeringId: 'workshop',
      hostKeyFingerprint: FP_WORKSHOP,
      hostPublicKey: WORKSHOP.publicKey,
      sshPort: 22,
    })
  })

  it('re-adopts the claim AND the pin after a control-plane restart', async () => {
    const f = twoBoxes()
    const claimed = await provider(f).provision(spec())

    // A fresh provider is a restarted control plane: claims live in memory, and the persisted
    // handle is the only record left.
    const restarted = provider(f)
    expect(await restarted.describe(claimed.data)).toMatchObject({ state: 'running' })
    expect(await restarted.listManaged()).toEqual([
      { kind: 'host', providerNativeId: 'workshop', ownership: 'server-owned', serverId: 'srv-abc123' },
    ])

    // The pin came back with it, so the restart cannot silently downgrade a known host to TOFU.
    f.hosts['10.0.0.9'] = { fingerprint: FP_IMPOSTOR }
    const err = await rejection(restarted.validateCredentials())
    expect(err.providerCode).toBe('host_key_mismatch')
  })

  it('reports a deregistered host as terminated', async () => {
    const f = twoBoxes()
    const claimed = await provider(f).provision(spec())
    const withoutWorkshop = provider(f, {
      hosts: byoConfigSchema.parse({ hosts: [{ name: 'rack', host: '10.0.0.10' }] }).hosts,
    })
    expect(await withoutWorkshop.describe(claimed.data)).toEqual({ state: 'terminated' })
  })

  it('reports terminated for a server that no longer holds the host', async () => {
    const f = twoBoxes()
    const byo = provider(f)
    const first = await byo.provision(spec())
    await byo.terminate(first.data)
    await byo.provision(spec({ serverId: 'srv-def456', idempotencyKey: 'gen1-def' }))

    expect(await byo.describe(first.data)).toEqual({ state: 'terminated' })
  })

  it('rejects a handle that is not a BYO handle', async () => {
    const err = await rejection(provider(twoBoxes()).describe({ instanceId: 'i-123' }))
    expect(err.code).toBe('invalid_spec')
  })
})

/**
 * Why `assertDescribeAbsenceGrace` from `@rockysurf/provider-conformance` is NOT wired into this
 * provider (rockysurf-5i28 raised it as an open question; this block is the answer, asserted
 * rather than argued).
 *
 * The grace exists for one ambiguity: on an eventually consistent API, a create that has not
 * propagated is indistinguishable from a termination on the first read, and believing that read
 * marks a live, billing instance dead — the gyp1.4 data-loss bug. **BYO has no create.** The host
 * predates Rocky Surf, the claim is written to memory by the process that reads it, and a restart
 * re-adopts from the persisted handle. There is no read path to retry against, so supplying the
 * harness an absent-then-present script would be scripting a window that cannot open.
 *
 * What IS worth asserting is the property the grace buys, which BYO gets structurally instead —
 * AND the premise that reasoning rests on, which is the first test below.
 */
describe('the absence grace (A4) has nothing to guard here', () => {
  /**
   * THE PREMISE, PINNED (raised by rockysurf-5i28 while auditing the decision above).
   *
   * Everything else in this block follows from `describe()` doing no I/O — and that is a
   * property of the current implementation, not of BYO's nature. "Is the box actually up?" is a
   * plausible future ask for a provider whose instances are somebody's hardware, and a
   * reachability probe here would make absence TRANSIENT the moment it landed. Worse than the
   * cloud case, in fact: a propagation window opens once after a create, while a rebooting host
   * or a flaky link recurs for the life of the box.
   *
   * So this is not a restatement of the rule. It is the fact the rule rests on, made
   * load-bearing: add a probe to `describe()` and this fails, which is the signal to wire
   * `assertDescribeAbsenceGrace` rather than to update the comment.
   */
  it('opens no connection, which is what makes absence here a decision rather than a read', async () => {
    const f = twoBoxes()
    const byo = provider(f)
    const claimed = await byo.provision(spec())
    const afterClaim = f.attempts.length

    await byo.describe(claimed.data)
    await provider(f).describe(claimed.data) // the restarted control plane, which re-adopts
    await provider(f, {
      hosts: byoConfigSchema.parse({ hosts: [{ name: 'rack', host: '10.0.0.10' }] }).hosts,
    }).describe(claimed.data) // and the deregistered host, which reports terminated

    expect(f.attempts).toHaveLength(afterClaim)
  })

  it('never reports a just-claimed host as terminated, on the very first read', async () => {
    const f = twoBoxes()
    const byo = provider(f)
    const claimed = await byo.provision(spec())

    // The data-loss case, in BYO's terms. One read, no retries, and it cannot answer 'absent'
    // because the claim became visible synchronously.
    expect((await byo.describe(claimed.data)).state).toBe('running')

    // And on a restarted control plane, where a cloud provider would be at its most ambiguous:
    // the handle is re-adopted rather than read as absence.
    expect((await provider(f).describe(claimed.data)).state).toBe('running')
  })

  it('believes absence immediately, because absence here is an operator edit', async () => {
    const f = twoBoxes()
    const claimed = await provider(f).provision(spec())
    const deregistered = provider(f, {
      hosts: byoConfigSchema.parse({ hosts: [{ name: 'rack', host: '10.0.0.10' }] }).hosts,
    })

    // Durable, not propagation delay: someone edited the config. Retrying four times two seconds
    // apart would delay a definite answer, not improve it — so the grace is not skipped here,
    // there is simply nothing to wait for.
    const started = Date.now()
    expect((await deregistered.describe(claimed.data)).state).toBe('terminated')
    expect(Date.now() - started).toBeLessThan(DESCRIBE_ABSENCE_GRACE.delayMs)
  })
})

/* ------------------------------------------------------------------ terminate */

describe('terminate releases the record and touches nothing', () => {
  it('opens no connection and runs no command — the machine is the operator\'s', async () => {
    const f = twoBoxes()
    const byo = provider(f)
    const claimed = await byo.provision(spec())

    const connectionsBefore = f.attempts.length
    const scriptsBefore = f.scripts.length
    await byo.terminate(claimed.data)

    expect(f.attempts).toHaveLength(connectionsBefore)
    expect(f.scripts).toHaveLength(scriptsBefore)
    expect(await byo.listManaged()).toEqual([])
  })

  it('releases the host for the next server', async () => {
    const f = twoBoxes()
    const byo = provider(f)
    const claimed = await byo.provision(spec())
    await byo.terminate(claimed.data)

    const next = await byo.provision(spec({ serverId: 'srv-def456', idempotencyKey: 'gen1-def' }))
    expect(asByoData(next.data).hostName).toBe('workshop')
  })

  it('is idempotent, and not-found is success', async () => {
    const f = twoBoxes()
    const byo = provider(f)
    const claimed = await byo.provision(spec())
    await byo.terminate(claimed.data)
    await expect(byo.terminate(claimed.data)).resolves.toBeUndefined()
    expect(f.attempts).toHaveLength(1)
  })

  it('never releases a claim another server now holds', async () => {
    const f = twoBoxes()
    const byo = provider(f)
    const stale = await byo.provision(spec())
    await byo.terminate(stale.data)
    const current = await byo.provision(spec({ serverId: 'srv-def456', idempotencyKey: 'gen1-def' }))

    await byo.terminate(stale.data) // a replayed teardown of the OLD server
    expect(await byo.describe(current.data)).toMatchObject({ state: 'running' })
  })
})

/* ------------------------------------------------------------------ the reconciler's view */

describe('listManaged', () => {
  it('reports claimed hosts, attributed to the server holding them', async () => {
    const f = twoBoxes()
    const byo = provider(f)
    await byo.provision(spec())
    await byo.provision(spec({ serverId: 'srv-def456', offeringId: 'rack', idempotencyKey: 'gen1-def' }))

    const managed = await byo.listManaged()
    assertManagedShape(managed)
    expect(managed).toEqual([
      { kind: 'host', providerNativeId: 'workshop', ownership: 'server-owned', serverId: 'srv-abc123' },
      { kind: 'host', providerNativeId: 'rack', ownership: 'server-owned', serverId: 'srv-def456' },
    ])
  })

  it('does not report unclaimed registered hosts', async () => {
    // The reconciler's list is what this installation created and could leak. A machine that was
    // already there is neither; the only thing BYO can leak is a claim.
    expect(await provider(twoBoxes()).listManaged()).toEqual([])
  })
})

/* ------------------------------------------------------------------ the scripts themselves */

describe('the prepare script', () => {
  it('appends keys instead of rewriting authorized_keys', () => {
    const script = buildPrepareScript('rocky', [CORE_KEY])
    // An operator locked out of their own machine by a dev-box installer would be unforgivable,
    // so the truncating single `>` must never appear against that file.
    expect(script).not.toMatch(/[^>]>\s*"\$home\/\.ssh\/authorized_keys"/)
    expect(script).toContain('>> "$home/.ssh/authorized_keys"')
    expect(script).toContain('grep -qxF')
  })

  it('is safe to re-run: every step is conditional or idempotent', () => {
    const script = buildPrepareScript('rocky', [CORE_KEY])
    expect(script).toContain('if ! id -u "$user"')
    expect(script).toContain('mkdir -p "$home/.ssh"')
    expect(script).toContain('chmod 600 "$home/.ssh/authorized_keys"')
  })

  it('quotes key material that contains a single quote', () => {
    const script = buildPrepareScript('rocky', [`ssh-ed25519 AAAA o'brien@laptop`])
    expect(script).toContain(`'ssh-ed25519 AAAA o'\\''brien@laptop'`)
  })

  it('refuses an account name that could smuggle a sudoers path', () => {
    expect(() => assertSafeAccount('../../etc/passwd')).toThrow(ProviderError)
    expect(() => assertSafeAccount('rocky rm -rf')).toThrow(ProviderError)
    expect(() => assertSafeAccount('rocky')).not.toThrow()
  })
})

describe('parseHostFacts', () => {
  it('reads cores, memory, architecture and disk', () => {
    expect(parseHostFacts('8\n16308904\nx86_64\n103080888\n')).toEqual({
      cpu: 8,
      memoryGb: 15.6,
      arch: 'amd64',
      diskGb: 98,
    })
  })

  it('maps aarch64 onto arm64', () => {
    expect(parseHostFacts('2\n2048000\naarch64\n')).toMatchObject({ arch: 'arm64' })
  })

  it('refuses to guess an unrecognised architecture', () => {
    // Defaulting to amd64 would install binaries the machine cannot run, and the failure would
    // surface an hour later inside a pack.
    expect(() => parseHostFacts('2\n2048000\nriscv64\n')).toThrow(/unsupported machine architecture/)
  })

  it('refuses nonsense rather than reporting a zero-core box', () => {
    expect(() => parseHostFacts('\n\n\n')).toThrow(/cpu count/)
  })
})
