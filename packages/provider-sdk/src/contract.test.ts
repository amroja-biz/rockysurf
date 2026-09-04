import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ARCHITECTURES,
  assertHostnameSafeId,
  DESCRIBE_ABSENCE_GRACE,
  INSTANCE_STATES,
  isHostnameSafeId,
  isProviderError,
  isRetryableProviderErrorCode,
  isTerminalInstanceState,
  normalizeSshCidrs,
  opensSshToTheInternet,
  PROVIDER_ERROR_CODES,
  ProviderError,
  RESOURCE_OWNERSHIPS,
  RETRYABLE_PROVIDER_ERROR_CODES,
  stillExistsAtProvider,
  TERMINAL_INSTANCE_STATES,
  unsupportedOperationError,
  type ComputeProvider,
  type ConfigSchema,
  type InstanceState,
  type ManagedResource,
  type Offering,
  type ProviderCapabilities,
  type ProviderData,
  type ProviderErrorCode,
  type ProviderFactory,
  type ProvisionResult,
  type ProvisionSpec,
} from './index.js'

/**
 * A complete provider, written the way a real one would be. It exists to prove at COMPILE
 * time that the frozen interface is implementable without casts, and at run time that the
 * rules the doc comments state are the rules the helpers enforce.
 *
 * It declares `stop: false`, so it also demonstrates the A2 cost the ADR accepted: two
 * required methods that throw.
 */
const CAPABILITIES: ProviderCapabilities = {
  stop: false,
  ipStableAcrossStop: true,
  canInjectHostKeys: false,
  userDataMaxBytes: 16384,
  generatesUserData: true,
}

interface ExampleConfig {
  region: string
}

class ExampleProvider implements ComputeProvider {
  readonly id = 'example'
  readonly displayName = 'Example Cloud'
  readonly capabilities = CAPABILITIES

  private readonly instances = new Map<string, { spec: ProvisionSpec; state: InstanceState }>()
  private readonly byIdempotencyKey = new Map<string, string>()
  private seq = 0

  constructor(private readonly config: ExampleConfig) {}

  async validateCredentials(): Promise<void> {}

  async validateSpec(spec: ProvisionSpec): Promise<void> {
    assertHostnameSafeId(spec.serverId)
    if (Buffer.byteLength(spec.userData, 'utf8') > this.capabilities.userDataMaxBytes) {
      throw new ProviderError('invalid_spec', 'userData exceeds userDataMaxBytes')
    }
    if (spec.tags['managed-by'] !== 'rockysurf') {
      throw new ProviderError('invalid_spec', "tags['managed-by'] disagrees with this provider's prefix")
    }
  }

  async listOfferings(): Promise<Offering[]> {
    return [
      {
        id: 'example-small',
        cpu: 2,
        memoryGb: 4,
        diskGb: 40,
        arch: 'arm64',
        hourly: { amount: 0.01, currency: 'EUR', fetchedAt: '2026-08-12T00:00:00Z' },
        available: true,
        region: this.config.region,
      },
      // A sold-out type is REPORTED, not omitted — the whole point of B1.
      {
        id: 'example-large',
        cpu: 8,
        memoryGb: 16,
        arch: 'amd64',
        hourly: null,
        available: false,
        region: this.config.region,
      },
    ]
  }

  async provision(spec: ProvisionSpec): Promise<ProvisionResult> {
    await this.validateSpec(spec)
    const replayed = this.byIdempotencyKey.get(spec.idempotencyKey)
    if (replayed) return { data: { instanceId: replayed }, initial: { state: 'pending' } }

    const instanceId = `i-${++this.seq}`
    this.instances.set(instanceId, { spec, state: 'pending' })
    this.byIdempotencyKey.set(spec.idempotencyKey, instanceId)
    return { data: { instanceId }, initial: { state: 'pending', offeringId: spec.offeringId } }
  }

  async describe(data: ProviderData): Promise<InstanceViewish> {
    const found = this.instances.get(String(data['instanceId']))
    // Absence maps to terminated — a real provider retries first (DESCRIBE_ABSENCE_GRACE).
    if (!found) return { state: 'terminated' }
    return { state: found.state, offeringId: found.spec.offeringId }
  }

  async terminate(data: ProviderData): Promise<void> {
    const id = String(data['instanceId'])
    const found = this.instances.get(id)
    if (!found) return // not-found is success
    found.state = 'terminating'
  }

  async listManaged(): Promise<ManagedResource[]> {
    const resources: ManagedResource[] = []
    for (const [instanceId, row] of this.instances) {
      if (!stillExistsAtProvider(row.state)) continue
      resources.push({
        kind: 'instance',
        providerNativeId: instanceId,
        ownership: 'server-owned',
        serverId: row.spec.serverId,
      })
    }
    resources.push({ kind: 'network', providerNativeId: 'net-shared', ownership: 'shared' })
    return resources
  }

  async stop(): Promise<void> {
    throw unsupportedOperationError(this.id, 'stop')
  }

  async start(): Promise<void> {
    throw unsupportedOperationError(this.id, 'start')
  }
}

/** Local alias so the class above reads like a real implementation. */
type InstanceViewish = Awaited<ReturnType<ComputeProvider['describe']>>

/**
 * The zod convention, without zod: a schema is anything with `parse(unknown): TConfig`, so a
 * real provider exports its zod schema here and this package still ships zero dependencies.
 */
const exampleConfigSchema: ConfigSchema<ExampleConfig> = {
  parse(input: unknown): ExampleConfig {
    const region = (input as { region?: unknown } | null)?.region
    if (typeof region !== 'string') throw new Error('region is required')
    return { region }
  },
}

const exampleFactory: ProviderFactory<ExampleConfig> = {
  id: 'example',
  displayName: 'Example Cloud',
  configSchema: exampleConfigSchema,
  createProvider: (config) => new ExampleProvider(config),
}

const spec = (overrides: Partial<ProvisionSpec> = {}): ProvisionSpec => ({
  serverId: 'srv-abc123',
  name: 'dev-box',
  offeringId: 'example-small',
  arch: 'arm64',
  sshPublicKeys: ['ssh-ed25519 AAAA example'],
  userData: '#cloud-config\n',
  tags: { 'managed-by': 'rockysurf', 'server-id': 'srv-abc123' },
  idempotencyKey: 'gen1-abc',
  ...overrides,
})

describe('the interface is implementable', () => {
  it('constructs through the factory convention', () => {
    const provider = exampleFactory.createProvider(exampleFactory.configSchema.parse({ region: 'eu-1' }))
    expect(provider.id).toBe('example')
    expect(provider.capabilities).toEqual(CAPABILITIES)
  })

  it('runs a full lifecycle', async () => {
    const provider = exampleFactory.createProvider({ region: 'eu-1' })

    const created = await provider.provision(spec())
    expect(created.initial.state).toBe('pending')
    expect(created.data['instanceId']).toBe('i-1')

    // A6: the create call already answered, so no describe() round trip was needed.
    expect(await provider.describe(created.data)).toMatchObject({ state: 'pending' })

    await provider.terminate(created.data)
    // A3: still terminating, and therefore still present for the reconciler.
    expect((await provider.describe(created.data)).state).toBe('terminating')
    expect((await provider.listManaged()).filter((r) => r.kind === 'instance')).toHaveLength(1)
  })

  it('dedupes on idempotencyKey', async () => {
    const provider = exampleFactory.createProvider({ region: 'eu-1' })
    const first = await provider.provision(spec())
    const second = await provider.provision(spec())
    expect(second.data['instanceId']).toBe(first.data['instanceId'])
  })

  it('terminate is idempotent and not-found is success', async () => {
    const provider = exampleFactory.createProvider({ region: 'eu-1' })
    await expect(provider.terminate({ instanceId: 'i-nope' })).resolves.toBeUndefined()
  })

  it('describe on an unknown instance returns terminated rather than throwing', async () => {
    const provider = exampleFactory.createProvider({ region: 'eu-1' })
    expect(await provider.describe({ instanceId: 'i-nope' })).toEqual({ state: 'terminated' })
  })

  it('reports sold-out offerings instead of hiding them (B1)', async () => {
    const provider = exampleFactory.createProvider({ region: 'eu-1' })
    const offerings = await provider.listOfferings()
    expect(offerings.find((o) => o.id === 'example-large')?.available).toBe(false)
  })

  it('quotes prices in the provider\'s own currency (B2)', async () => {
    const provider = exampleFactory.createProvider({ region: 'eu-1' })
    const small = (await provider.listOfferings()).find((o) => o.id === 'example-small')
    expect(small?.hourly).toEqual({ amount: 0.01, currency: 'EUR', fetchedAt: '2026-08-12T00:00:00Z' })
  })

  it('stop/start exist but throw invalid_spec when the capability is false (A2)', async () => {
    const provider = exampleFactory.createProvider({ region: 'eu-1' })
    expect(provider.capabilities.stop).toBe(false)
    expect(typeof provider.stop).toBe('function')
    expect(typeof provider.start).toBe('function')
    await expect(provider.stop({})).rejects.toMatchObject({ code: 'invalid_spec' })
    await expect(provider.start({})).rejects.toMatchObject({ code: 'invalid_spec' })
  })

  it('leaves billsWhileStopped absent by default, and lets a provider that must declare it do so (E17)', () => {
    // Absent means false — every shipped provider says nothing, and the example provider here
    // is one of them. The literal below is the DigitalOcean shape ADR-0025 was written for, and
    // its whole job is to prove the optional field type-checks beside the five required ones.
    expect(CAPABILITIES.billsWhileStopped).toBeUndefined()
    const stoppedStillBills: ProviderCapabilities = { ...CAPABILITIES, stop: true, billsWhileStopped: true }
    expect(stoppedStillBills.billsWhileStopped).toBe(true)
  })

  it('recognises a ProviderError built by ANOTHER copy of this package (ADR-0026)', () => {
    // A personal provider under <dataDir>/providers carries its own @rockysurf/provider-sdk, so
    // its ProviderError is a different class. The guard is structural: the name and a frozen code.
    class ForeignProviderError extends Error {
      override readonly name = 'ProviderError'
      readonly code = 'quota'
      get retryable() {
        return false
      }
    }
    const foreign: unknown = new ForeignProviderError('over quota')
    expect(isProviderError(foreign)).toBe(true)
    // …and not merely anything with a name: the code has to be one of the nine.
    class LookAlike extends Error {
      override readonly name = 'ProviderError'
      readonly code = 'not_a_code'
    }
    expect(isProviderError(new LookAlike('x'))).toBe(false)
    expect(isProviderError(new Error('plain'))).toBe(false)
    expect(isProviderError(new ProviderError('auth', 'ours'))).toBe(true)
  })

  it('reports shared and server-owned resources distinctly (D1)', async () => {
    const provider = exampleFactory.createProvider({ region: 'eu-1' })
    await provider.provision(spec())
    const managed = await provider.listManaged()
    expect(managed.find((r) => r.kind === 'network')?.ownership).toBe('shared')
    expect(managed.find((r) => r.kind === 'instance')).toMatchObject({
      ownership: 'server-owned',
      serverId: 'srv-abc123',
    })
  })

  it('refuses a spec whose managed-by disagrees with the provider (D3)', async () => {
    const provider = exampleFactory.createProvider({ region: 'eu-1' })
    await expect(provider.validateSpec(spec({ tags: { 'managed-by': 'someone-else' } }))).rejects.toMatchObject({
      code: 'invalid_spec',
    })
  })

  it('validateSpec enforces the provider\'s own userData limit (A7)', async () => {
    const provider = exampleFactory.createProvider({ region: 'eu-1' })
    await expect(provider.validateSpec(spec({ userData: 'x'.repeat(16385) }))).rejects.toMatchObject({
      code: 'invalid_spec',
    })
  })
})

describe('error taxonomy', () => {
  it('freezes exactly nine codes', () => {
    expect(PROVIDER_ERROR_CODES).toHaveLength(9)
    expect([...new Set(PROVIDER_ERROR_CODES)]).toHaveLength(9)
    expect(PROVIDER_ERROR_CODES).toEqual([
      'auth',
      'quota',
      'capacity',
      'invalid_spec',
      'not_found',
      'rate_limited',
      'conflict',
      'network',
      'unknown',
    ])
  })

  it('derives retryable from the code, with no field to contradict it (F2)', () => {
    for (const code of PROVIDER_ERROR_CODES) {
      const err = new ProviderError(code, 'boom')
      expect(err.retryable).toBe(isRetryableProviderErrorCode(code))
      // There is no own `retryable` property to set — it is a getter on the prototype.
      expect(Object.getOwnPropertyNames(err)).not.toContain('retryable')
    }
    expect([...RETRYABLE_PROVIDER_ERROR_CODES].sort()).toEqual(['capacity', 'network', 'rate_limited'])
  })

  it('carries the provider\'s own code verbatim (F1)', () => {
    const err = new ProviderError('conflict', 'server is locked', { providerCode: 'locked' })
    expect(err.providerCode).toBe('locked')
    expect(err.code).toBe('conflict')
  })

  it('keeps the cause and is catchable as a ProviderError', () => {
    const cause = new Error('socket hang up')
    const err = new ProviderError('network', 'request failed', { cause })
    expect(err.cause).toBe(cause)
    expect(err).toBeInstanceOf(Error)
    expect(isProviderError(err)).toBe(true)
    expect(isProviderError(cause)).toBe(false)
    expect(err.name).toBe('ProviderError')
  })

  it('unsupportedOperationError names the provider and the operation', () => {
    const err = unsupportedOperationError('byo', 'stop')
    expect(err.code).toBe('invalid_spec')
    expect(err.message).toContain('byo')
    expect(err.message).toContain('stop')
  })
})

describe('instance states', () => {
  it('includes terminating (A3) and failed (A5)', () => {
    expect(INSTANCE_STATES).toContain('terminating')
    expect(INSTANCE_STATES).toContain('failed')
    expect(INSTANCE_STATES).toHaveLength(8)
  })

  it('treats terminating as NOT terminal but still present', () => {
    // The distinction the reconciler depends on: nothing more will happen to a terminated
    // instance, but a terminating one still holds resources.
    expect(isTerminalInstanceState('terminating')).toBe(false)
    expect(stillExistsAtProvider('terminating')).toBe(true)
    expect(stillExistsAtProvider('terminated')).toBe(false)
    expect([...TERMINAL_INSTANCE_STATES].sort()).toEqual(['failed', 'terminated'])
  })

  it('every state is classifiable', () => {
    for (const state of INSTANCE_STATES) {
      expect(typeof isTerminalInstanceState(state)).toBe('boolean')
      expect(typeof stillExistsAtProvider(state)).toBe('boolean')
    }
  })
})

describe('hostname-safe ids (C2)', () => {
  it.each(['srv-abc123', 'a', 'a-b-c', `a${'b'.repeat(61)}c`])('accepts %s', (id) => {
    expect(isHostnameSafeId(id)).toBe(true)
  })

  it.each([
    'srv_abc',
    'SRV-ABC',
    '-leading',
    'trailing-',
    '',
    'a'.repeat(64),
    'has space',
    'has.dot',
  ])('rejects %s', (id) => {
    expect(isHostnameSafeId(id)).toBe(false)
    expect(() => assertHostnameSafeId(id)).toThrow(ProviderError)
  })

  it('rejects the exact collision the ADR cites', () => {
    // srv_a and srv-a both fold to srv-a under a non-injective sanitizer.
    expect(isHostnameSafeId('srv_a')).toBe(false)
    expect(isHostnameSafeId('srv-a')).toBe(true)
  })

  it('throws invalid_spec naming the field', () => {
    expect(() => assertHostnameSafeId('bad_id')).toThrow(/hostname-safe/)
    try {
      assertHostnameSafeId('bad_id')
    } catch (err) {
      expect(isProviderError(err) && err.code).toBe('invalid_spec')
    }
  })
})

describe('constants', () => {
  it('states the A4 propagation grace as the spike-proven default', () => {
    expect(DESCRIBE_ABSENCE_GRACE).toEqual({ attempts: 4, delayMs: 2000 })
  })

  it('exposes both architectures and both ownerships', () => {
    expect(ARCHITECTURES).toEqual(['amd64', 'arm64'])
    expect(RESOURCE_OWNERSHIPS).toEqual(['server-owned', 'shared'])
  })
})

describe('the freeze holds its exclusions', () => {
  const src = (name: string) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8')
  const surface = ['index.ts', 'provider.ts', 'capabilities.ts', 'offering.ts', 'provision.ts', 'managed.ts']
    .map(src)
    .join('\n')
    // Strip comments: the files discuss the exclusions at length, and prose must not be
    // mistaken for an export.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it.each(['interruptible', 'checkInterruption', 'resize', 'spot'])('does not declare %s', (name) => {
    expect(surface).not.toContain(name)
  })

  it('removed hostKeys from ProvisionSpec (E2)', () => {
    expect(surface).not.toContain('hostKeys')
  })

  it('renamed canPinHostKey to canInjectHostKeys (E4)', () => {
    expect(surface).not.toContain('canPinHostKey')
    expect(surface).toContain('canInjectHostKeys')
  })

  it('dropped the TData generic (A1)', () => {
    expect(surface).not.toContain('TData')
    expect(surface).toContain('ProviderData')
  })

  it('rejected dedupeName (C2)', () => {
    expect(surface).not.toContain('dedupeName')
  })

  it('replaced hourlyUsd with a currency-carrying price (B2)', () => {
    expect(surface).not.toContain('hourlyUsd')
  })

  it('has no runtime dependencies', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
    // Present and empty, rather than absent: the acceptance criterion asks for an explicit
    // `dependencies: {}` so the zero-dependency promise is a visible, greppable statement
    // instead of an omission nobody can distinguish from an oversight. `toEqual({})` is
    // exactly as strict as `toBeUndefined()` was — any real dependency still fails here.
    expect(pkg.dependencies).toEqual({})
    expect(pkg.peerDependencies).toBeUndefined()
  })

  /**
   * EVERY source file, not only the frozen surface (issue #349).
   *
   * The zero-dependency promise is what the `dependencies: {}` assertion above and this one
   * together mean, and the promise is not "no code": `errors.ts`, `instance.ts`, `provision.ts`,
   * `ssh-cidr.ts` and `sizing.ts` all ship pure functions, each because more than one tree has
   * to agree with the others exactly. `sizing.ts` (ADR-0024) makes that promise load-bearing in
   * a new way — the SPA's bundle imports this package now, so an import added here reaches a
   * browser. Checking only the six frozen files would not have seen it.
   */
  it('imports nothing outside this package, in any source file', () => {
    const sources = readdirSync(fileURLToPath(new URL('.', import.meta.url)))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    expect(sources).toContain('sizing.ts')
    for (const name of sources) {
      const imports = [...src(name).matchAll(/from '([^']+)'/g)].map((m) => m[1]!)
      expect({ name, imports }).toEqual({ name, imports: imports.filter((i) => i.startsWith('./')) })
    }
  })
})

/** Compile-time only: every code is a valid discriminant, checked exhaustively. */
function describeCode(code: ProviderErrorCode): string {
  switch (code) {
    case 'auth':
      return 'credentials'
    case 'quota':
      return 'limit'
    case 'capacity':
      return 'stock'
    case 'invalid_spec':
      return 'request'
    case 'not_found':
      return 'missing'
    case 'rate_limited':
      return 'throttled'
    case 'conflict':
      return 'busy'
    case 'network':
      return 'transport'
    case 'unknown':
      return 'unrecognized'
    default: {
      const exhaustive: never = code
      return exhaustive
    }
  }
}

describe('exhaustiveness', () => {
  it('every code is handled by a switch with a never-default', () => {
    for (const code of PROVIDER_ERROR_CODES) expect(describeCode(code)).toBeTruthy()
  })
})


/**
 * The one place three providers have to agree character-for-character (issue #304).
 *
 * The normalized list is diffed against what each cloud reports, so two providers disagreeing
 * about whether ` 10.0.0.0/8 ` and `10.0.0.0/8` are the same entry would show up as a phantom
 * change that never converges — a sync that reports "updated" forever.
 */
describe('normalizeSshCidrs', () => {
  it('accepts a bare string as a list of one, so an existing config file keeps working', () => {
    expect(normalizeSshCidrs('203.0.113.7/32')).toEqual(['203.0.113.7/32'])
  })

  it('trims, and drops blanks left by an empty box in the editor', () => {
    expect(normalizeSshCidrs([' 203.0.113.7/32 ', '', '   '])).toEqual(['203.0.113.7/32'])
  })

  it('folds an exact repeat but keeps the order the operator wrote', () => {
    expect(normalizeSshCidrs(['198.51.100.0/24', '203.0.113.7/32', '198.51.100.0/24'])).toEqual([
      '198.51.100.0/24',
      '203.0.113.7/32',
    ])
  })

  /**
   * The tempting optimisation, deliberately not taken. A /32 inside a /24 means something to the
   * person maintaining the file — "the office" and "my laptop at the office" — and collapsing
   * them makes removal lossy in a way the UI cannot explain: the entry the operator clicks
   * Remove on would not be the entry that disappears.
   */
  it('never collapses an overlapping range into the one that contains it', () => {
    expect(normalizeSshCidrs(['203.0.113.0/24', '203.0.113.7/32'])).toEqual([
      '203.0.113.0/24',
      '203.0.113.7/32',
    ])
  })
})

describe('opensSshToTheInternet', () => {
  it('is true when ANY entry is 0.0.0.0/0, not only when it is the only one', () => {
    expect(opensSshToTheInternet(['203.0.113.7/32', '0.0.0.0/0'])).toBe(true)
    expect(opensSshToTheInternet(['0.0.0.0/0'])).toBe(true)
  })

  it('is false for a list of ordinary ranges', () => {
    expect(opensSshToTheInternet(['203.0.113.7/32', '10.0.0.0/8'])).toBe(false)
  })
})
