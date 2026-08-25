import { configSchema, type Config, type SecretsStore } from '@rockysurf/core'
import { describe, expect, it, vi } from 'vitest'
import { composeRegistry } from './compose.js'

/**
 * The composition root's contract: which providers end up in the registry, and why each one
 * that does not is left out.
 *
 * What matters here is that a MISCONFIGURED provider never stops the control plane from
 * starting — the operator needs the UI up in order to fix it — and that credential resolution
 * prefers the config file, which is the copy a human can see and roll back.
 */

const config = (overrides: Record<string, unknown> = {}): Config =>
  configSchema.parse({ providers: overrides })

/** A secrets store with only the one method composition uses. */
function store(tokens: Record<string, string> = {}): SecretsStore {
  return { getProviderToken: (id: string) => tokens[id] } as unknown as SecretsStore
}

function compose(cfg: Config, secrets: SecretsStore = store()) {
  const log = vi.fn()
  const result = composeRegistry({ config: cfg, secrets, log })
  return { ...result, log }
}

describe('what ends up in the registry', () => {
  it('loads a provider whose credential is in the config file', () => {
    const { registry, notes } = compose(config({ hetzner: { enabled: true, token: 'hz_from_config' } }))

    expect(registry.ids()).toEqual(['hetzner'])
    expect(registry.get('hetzner').capabilities.stop).toBe(true)
    expect(notes).toContain('hetzner: ready')
  })

  it('loads a provider whose credential the wizard put in the secrets store', () => {
    // The state that was previously INEXPRESSIBLE: the config schema rejected `enabled`
    // without a token, so a pasted credential could never be turned on.
    const { registry, notes } = compose(
      config({ hetzner: { enabled: true } }),
      store({ hetzner: 'hz_from_store' }),
    )

    expect(registry.ids()).toEqual(['hetzner'])
    expect(notes).toContain('hetzner: ready')
  })

  it('prefers the config file over the store, so the file never lies', () => {
    const getProviderToken = vi.fn(() => 'hz_from_store')
    const secrets = { getProviderToken } as unknown as SecretsStore

    compose(config({ hetzner: { enabled: true, token: 'hz_from_config' } }), secrets)

    // Not even read: a decrypt avoided, and the file stays authoritative when it speaks.
    expect(getProviderToken).not.toHaveBeenCalled()
  })

  it('loads a feed-priced provider with pricing disabled — the extras are optional (gh #100)', () => {
    // Every OTHER test in this file runs with `pricing` at its defaults, which already proves
    // the injected `pricesUrl`/`pricesRefreshHours` pass the provider's strict schema. This one
    // pins the opposite path: an air-gapped operator's `pricing.enabled: false` must yield a
    // provider that loads fine and simply lists unpriced.
    const cfg = configSchema.parse({
      providers: { aws: { enabled: true, sshAllowedCidr: '203.0.113.7/32' } },
      pricing: { enabled: false },
    })
    const { registry, notes } = compose(cfg)
    expect(registry.ids()).toEqual(['aws'])
    expect(notes.some((n) => n.startsWith('aws: ready'))).toBe(true)
  })

  it('loads several providers at once', () => {
    const { registry } = compose(
      config({
        hetzner: { enabled: true, token: 'hz' },
        aws: { enabled: true, region: 'us-east-1', sshAllowedCidr: '203.0.113.4/32' },
      }),
    )
    expect(registry.ids().sort()).toEqual(['aws', 'hetzner'])
  })

  it('loads azure, which has no credential field at all', () => {
    // The state this test exists to pin: a fully-configured azure section produces a LIVE
    // provider in the registry. Every part of that wiring has its own unit tests and none of
    // them can see a missing composition (the 55fx.13 lesson).
    const { registry, notes } = compose(
      config({
        azure: {
          enabled: true,
          subscriptionId: '00000000-0000-0000-0000-000000000000',
          resourceGroup: 'rocky-surf-rg',
          location: 'eastus',
          sshAllowedCidr: '203.0.113.4/32',
        },
      }),
    )

    expect(registry.ids()).toEqual(['azure'])
    // The honest capability profile reaches the registry. `ipStableAcrossStop` is the one that
    // differs from AWS: an Azure Standard-SKU address is Static and survives a deallocate.
    expect(registry.get('azure').capabilities).toMatchObject({
      stop: true,
      ipStableAcrossStop: true,
      generatesUserData: true,
    })
    expect(notes).toContain('azure: ready (credentials from the environment)')
  })

  it('strips core’s own fields before the azure provider sees the section', () => {
    // `enabled` and `sizes` are core's — orchestration and a UI allowlist — and the provider's
    // schema is a strictObject, so passing either through is rejected outright. That rejection
    // is the boundary doing its job, and this asserts the composition root honours it.
    const { registry } = compose(
      config({
        azure: {
          enabled: true,
          subscriptionId: '00000000-0000-0000-0000-000000000000',
          resourceGroup: 'rocky-surf-rg',
          sshAllowedCidr: '203.0.113.4/32',
          sizes: ['Standard_B2ps_v2'],
        },
      }),
    )
    expect(registry.ids()).toEqual(['azure'])
  })

  it('reports an azure section missing sshAllowedCidr, in the provider’s own words', () => {
    const { registry, notes } = compose(
      config({
        azure: {
          enabled: true,
          subscriptionId: '00000000-0000-0000-0000-000000000000',
          resourceGroup: 'rocky-surf-rg',
        },
      }),
    )

    // Not fatal: the app comes up so the operator can fix it, and the reason rides into the
    // registry rather than living only in a log line they have already scrolled past.
    expect(registry.ids()).toEqual(['fake'])
    expect(registry.unavailableReason('azure')).toContain('sshAllowedCidr is required')
    expect(notes.find((n) => n.startsWith('azure:'))).toContain('sshAllowedCidr is required')
  })

  it('loads gcp from a config section, with credentials from the environment', () => {
    // THE WIRING TEST FOR rockysurf-ev41.6. A provider package that passes its own unit tests
    // and is not reachable from a config file is a provider nobody can use — the gap
    // rockysurf-55fx.13 named, where every module was green and nothing could be bootstrapped.
    const { registry, notes } = compose(
      config({ gcp: { enabled: true, projectId: 'demo-project', sshAllowedCidr: '203.0.113.4/32' } }),
    )

    expect(registry.ids()).toEqual(['gcp'])
    expect(registry.get('gcp').displayName).toBe('Google Compute Engine')
    // Constructed without touching a key file or the network: Application Default Credentials
    // are resolved on the first authenticated call, not at boot.
    expect(notes).toContain('gcp: ready (credentials from the environment)')
  })

  it('reports gcp as unavailable when its section is refused, rather than failing the boot', () => {
    // `sshAllowedCidr` has no default on purpose, so this is the section an operator most
    // plausibly gets wrong — and the app must still come up to tell them so.
    const { registry, notes } = compose(
      config({
        hetzner: { enabled: true, token: 'hz' },
        gcp: { enabled: true, projectId: 'demo-project' },
      }),
    )

    expect(registry.ids()).toEqual(['hetzner'])
    expect(registry.unavailableReason('gcp')).toContain('sshAllowedCidr')
    expect(notes.find((n) => n.startsWith('gcp:'))).toContain('not loaded')
  })

  it('does not pass core-only fields into the gcp provider schema', () => {
    // `enabled` and `sizes` are core's, and the provider's schema is strict, so leaking either
    // would be rejected outright. That rejection is the boundary doing its job.
    const { registry } = compose(
      config({
        gcp: {
          enabled: true,
          projectId: 'demo-project',
          sshAllowedCidr: '203.0.113.4/32',
          sizes: ['t2a-standard-2'],
        },
      }),
    )
    expect(registry.ids()).toEqual(['gcp'])
  })

  it('loads byo, which has hosts instead of a credential', () => {
    const { registry, notes } = compose(
      config({
        byo: {
          enabled: true,
          identityFile: '/home/op/.ssh/id_ed25519',
          hosts: [{ name: 'workshop', host: '10.0.0.9', fingerprint: 'SHA256:abc' }],
        },
      }),
    )

    expect(registry.ids()).toEqual(['byo'])
    // The honest capability profile reaches the registry: no stop, no user-data, no injected
    // host key. Core branches on these and on nothing else.
    expect(registry.get('byo').capabilities).toMatchObject({ stop: false, generatesUserData: false })
    expect(notes).toContain('byo: ready (credentials from the environment)')
  })

  it('reports a byo section the provider itself rejects, without stopping the boot', () => {
    const { registry, notes } = compose(
      config({
        byo: {
          enabled: true,
          hosts: [
            { name: 'workshop', host: '10.0.0.9' },
            { name: 'workshop', host: '10.0.0.10' },
          ],
        },
      }),
    )

    // Duplicate names are refused by the provider's own constructor — the name is its offering
    // id, its claim key and its managed-resource id at once.
    expect(registry.ids()).toEqual(['fake'])
    expect(notes.find((n) => n.startsWith('byo:'))).toContain('duplicate BYO host name')
  })

  it('leaves out a provider that is disabled', () => {
    const { registry, notes } = compose(config({ hetzner: { enabled: false, token: 'hz' } }))
    expect(registry.ids()).not.toContain('hetzner')
    expect(notes).toContain('hetzner: disabled in config')
  })
})

describe('a misconfigured provider does not stop the boot', () => {
  it('reports an enabled provider with no credential anywhere, and carries on', () => {
    const { registry, notes } = compose(
      config({
        hetzner: { enabled: true },
        aws: { enabled: true, region: 'us-east-1', sshAllowedCidr: '203.0.113.4/32' },
      }),
    )

    // AWS still loads. The control plane comes up so the operator can fix Hetzner in the UI.
    expect(registry.ids()).toEqual(['aws'])
    const note = notes.find((n) => n.startsWith('hetzner:'))
    expect(note).toContain('no credential found')
    // The message names BOTH places a credential can come from.
    expect(note).toContain('rockysurf.config.yaml')
    expect(note).toContain('setup wizard')
  })

  it('reports a section its own provider schema rejects, and carries on', () => {
    // The real case, not a contrived one: AWS is enabled without `sshAllowedCidr`. Core's
    // schema allows that — the field is optional there on purpose — and the AWS provider
    // REQUIRES it with no default, because a firewall rule is a security decision that should
    // be reviewed rather than inferred. So the provider's own message is what the operator
    // sees, and Hetzner still comes up.
    const { registry, notes } = compose(
      config({
        hetzner: { enabled: true, token: 'hz' },
        aws: { enabled: true, region: 'us-east-1' },
      }),
    )
    expect(registry.ids()).toEqual(['hetzner'])
    expect(notes.find((n) => n.startsWith('aws:'))).toContain('not loaded')

    /**
     * AND THE REASON SURVIVES COMPOSITION (rockysurf-va2l).
     *
     * This case was already tested up to the note — and a note is a string in the boot log,
     * which is where the whole bug lived. The operator saw a working single-cloud app and no
     * way to learn that their second cloud had been dropped. The registry now carries the
     * rejection so `/api/v1/setup` and the create page can say so.
     */
    expect(registry.unavailable().map((p) => p.id)).toEqual(['aws'])
    expect(registry.unavailableReason('aws')).toContain('sshAllowedCidr')
    expect(registry.unavailableReason('hetzner')).toBeUndefined()
  })

  it('states a rejection as a sentence, not as a serialised issue array', () => {
    // A zod error's `.message` is JSON. Fine for a log line nobody reads closely, wrong for the
    // create page, which now shows this text to whoever is trying to pick a cloud.
    const { registry, notes } = compose(
      config({ hetzner: { enabled: true, token: 'hz' }, aws: { enabled: true, region: 'us-east-1' } }),
    )

    const reason = registry.unavailableReason('aws')!
    expect(reason).toContain('sshAllowedCidr is required')
    expect(reason).not.toContain('"code"')
    expect(reason).not.toContain('[')
    // The boot log gets the same sentence, on one line.
    expect(notes.find((n) => n.startsWith('aws:'))).not.toContain('\n')
  })

  it('carries the reason for an enabled provider with no credential too', () => {
    const { registry } = compose(config({ hetzner: { enabled: true } }))
    expect(registry.unavailableReason('hetzner')).toContain('no credential found')
  })

  it('says nothing about a provider the operator turned off', () => {
    // Disabled is a choice, not a failure — reporting it would train people to ignore the list.
    const { registry } = compose(config({ hetzner: { enabled: true, token: 'hz' }, aws: { enabled: false } }))
    expect(registry.unavailable()).toEqual([])
  })

  it('survives a secrets store that throws', () => {
    const secrets = {
      getProviderToken: () => {
        throw new Error('master key unreadable')
      },
    } as unknown as SecretsStore

    const { registry, notes } = compose(config({ hetzner: { enabled: true } }), secrets)
    expect(registry.ids()).toEqual(['fake'])
    expect(notes.find((n) => n.startsWith('hetzner:'))).toContain('no credential found')
  })
})

describe('the no-cloud fallback', () => {
  it('offers the fake provider when nothing real is configured', () => {
    // What makes `npx rockysurf` usable on a machine with no cloud account: create a server,
    // watch it boot, terminate it, THEN decide whether to paste a token.
    const { registry, notes } = compose(config())
    expect(registry.ids()).toEqual(['fake'])
    expect(notes.some((n) => n.startsWith('fake:'))).toBe(true)
  })

  it('disappears the moment a real provider loads, so it cannot be picked by accident', () => {
    const { registry } = compose(config({ hetzner: { enabled: true, token: 'hz' } }))
    expect(registry.ids()).not.toContain('fake')
  })
})

describe('the boot log', () => {
  it('says one thing per provider, so a failed wiring is visible without a debugger', () => {
    const { log } = compose(
      config({
        hetzner: { enabled: true, token: 'hz' },
        aws: { enabled: true, region: 'us-east-1', sshAllowedCidr: '203.0.113.4/32' },
      }),
    )
    const lines = log.mock.calls.map(([line]) => line as string)
    expect(lines.every((l) => l.startsWith('[providers] '))).toBe(true)
    expect(lines.some((l) => l.includes('hetzner: ready'))).toBe(true)
    expect(lines.some((l) => l.includes('aws: ready'))).toBe(true)
  })
})
