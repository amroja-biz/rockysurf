import { configSchema, SHIPPED_PROVIDER_IDS } from '@rockysurf/core'
import type { ProviderFactory } from '@rockysurf/provider-sdk'
import awsProviderFactory from '@rockysurf/provider-aws'
import azureProviderFactory from '@rockysurf/provider-azure'
import byoProviderFactory from '@rockysurf/provider-byo'
import gcpProviderFactory from '@rockysurf/provider-gcp'
import hetznerProviderFactory from '@rockysurf/provider-hetzner'
import { describe, expect, it } from 'vitest'

/**
 * THE OTHER HALF OF TWO CORE PROPERTIES (ADR-0027).
 *
 * `packages/core/src/settings/fields.test.ts` used to prove, by reading `config/schema.ts` as text,
 * that every credential-named field was classified secret in the settings inventory, and that every
 * provider section the schema declares had an `enabled` switch and a section on the page. A
 * provider that DECLARES its settings on its factory carries those rows itself, so core's test
 * names it in `DECLARED_BY_PROVIDER` and stops looking — and this file, in the one package that may
 * import both core and a provider, looks instead. The property is unchanged; its evidence moved.
 *
 * Also the place the declaration is held against core's OWN schema for the section: core validates
 * the config file with a hand-mirrored copy of each shipped provider's fields (the dependency lint
 * forbids importing the provider's), so a declared field core's copy does not know is a control
 * whose save the file would refuse.
 */

/** What core's test says is declared, and by whom — kept in step with `fields.test.ts` by the pin below. */
const DECLARED_BY_PROVIDER: Record<string, ProviderFactory<never>> = {
  hetzner: hetznerProviderFactory as unknown as ProviderFactory<never>,
}

/** A config the provider's own schema accepts, per declared factory. */
const VALID_CONFIG: Record<string, Record<string, unknown>> = {
  hetzner: { token: 'hz_test' },
}

const SHIPPED: Record<string, ProviderFactory<never>> = {
  aws: awsProviderFactory as unknown as ProviderFactory<never>,
  azure: azureProviderFactory as unknown as ProviderFactory<never>,
  gcp: gcpProviderFactory as unknown as ProviderFactory<never>,
  hetzner: hetznerProviderFactory as unknown as ProviderFactory<never>,
  byo: byoProviderFactory as unknown as ProviderFactory<never>,
}

describe('every shipped factory named in DECLARED_BY_PROVIDER really declares its panel', () => {
  for (const [id, factory] of Object.entries(DECLARED_BY_PROVIDER)) {
    it(`${id}: declares settings at all (conformance checks their shape in the provider's own suite)`, () => {
      expect(factory.settings, `${id} is named as declaring settings and declares none`).toBeDefined()
      // A config the factory's own schema accepts — the same one its conformance test uses.
      expect(() => factory.configSchema.parse(VALID_CONFIG[id])).not.toThrow()
    })

    it(`${id}: declares every field core's copy of its section accepts, and nothing core's copy refuses`, () => {
      // Core's section, by the keys its defaults expose plus the optional ones it declares. The
      // schema is strict, so a declared name outside this set would be refused at boot.
      const section = (configSchema.parse({}).providers as Record<string, Record<string, unknown>>)[id] ?? {}
      const coreKeys = new Set(Object.keys(section))
      const declared = factory.settings!.fields.map((f) => f.name)
      for (const name of declared) {
        // Prove core accepts the key by parsing a file that sets it to the declared example.
        const field = factory.settings!.fields.find((f) => f.name === name)!
        const value =
          field.kind === 'number' ? Number(field.example ?? 1) : field.kind === 'boolean' ? true : (field.example ?? 'x')
        expect(() => configSchema.parse({ providers: { [id]: { [name]: value } } }), `core refuses providers.${id}.${name}`).not.toThrow()
      }
      // And every key core's copy carries that is not core's own is declared — the audit's gap D3/D4
      // in the other direction: a field the file accepts and no panel shows.
      for (const key of coreKeys) {
        if (['enabled', 'sizes'].includes(key)) continue
        expect(declared, `providers.${id}.${key} is in core's schema and not declared on the factory`).toContain(key)
      }
    })

    it(`${id}: classifies its credential secret, so the redaction core's scan used to guarantee still holds`, () => {
      const secrets = factory.settings!.fields.filter((f) => f.kind === 'secret').map((f) => f.name)
      if (factory.credentialField) expect(secrets).toContain(factory.credentialField)
      for (const name of factory.settings!.fields.map((f) => f.name)) {
        if (/^(token|pat|password|secret|apikey)$|[a-z0-9](Token|Pat|Password|Secret|ApiKey)$/.test(name)) {
          expect(secrets, `${id}.${name} reads like a credential and is not declared secret`).toContain(name)
        }
      }
    })
  }

  it('names nothing that the shipped set does not have, and matches the ids core declares', () => {
    for (const id of Object.keys(DECLARED_BY_PROVIDER)) expect(SHIPPED_PROVIDER_IDS).toContain(id)
    expect(Object.keys(SHIPPED).sort()).toEqual([...SHIPPED_PROVIDER_IDS].sort())
  })

  it('every shipped factory that declares settings is named here — no silent third home', () => {
    for (const [id, factory] of Object.entries(SHIPPED)) {
      if (factory.settings) expect(Object.keys(DECLARED_BY_PROVIDER), `${id} declares settings but is not in DECLARED_BY_PROVIDER`).toContain(id)
    }
  })
})
