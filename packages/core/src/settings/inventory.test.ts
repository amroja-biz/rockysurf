import type { ProviderSettings } from '@rockysurf/provider-sdk'
import { describe, expect, it } from 'vitest'
import { SETTINGS_FIELDS, SETTINGS_SECTIONS } from './fields.js'
import { buildSettingsInventory, PROVIDER_ORDER } from './inventory.js'

/**
 * The inventory a settings page draws from, built per file and per provider (ADR-0026, ADR-0027).
 *
 * Three things are pinned here that used to be pinned on the static tables alone: that a provider's
 * DECLARATION becomes rows the page knows how to draw; that the tabs keep the order an operator has
 * always seen them in, whether a provider is declared or written; and that redaction follows the
 * declaration — a declared string is shown, a declared secret is masked, and an undeclared leaf of
 * a personal section is masked because nobody has vouched for it.
 */

const HETZNER: ProviderSettings = {
  title: 'Hetzner',
  help: 'The quickest provider to start with: an API token from console.hetzner.com is the whole setup.',
  fields: [
    { name: 'token', kind: 'secret', label: 'Token Environment Variable', example: 'HETZNER_TOKEN', help: 'The NAME of an environment variable holding the token.' },
    { name: 'location', kind: 'string', label: 'Location', help: 'Which datacentre new servers are created in.' },
    { name: 'consoleProjectId', kind: 'number', label: 'Console project id', help: 'Optional; used only for the console link.' },
  ],
  offering: { noun: 'server type', example: 'cpx21' },
  advisories: [{ surface: 'create', text: 'ARM types are sold only in three datacentres.' }],
}

const NIMBUS: ProviderSettings = {
  title: 'Nimbus Cloud',
  help: 'A cloud that declares everything a panel needs, firewall included.',
  fields: [
    { name: 'token', kind: 'secret', label: 'API token variable', example: 'NIMBUS_TOKEN', help: 'The NAME of a variable holding the token.' },
    { name: 'region', kind: 'string', label: 'Region', help: 'Which region new servers are created in.' },
    { name: 'sshAllowedCidr', kind: 'sshCidrList', label: 'SSH allowed from', help: 'Which networks may reach SSH on the boxes created here.' },
    { name: 'plan', kind: 'string', label: 'Plan', writable: false, reason: 'Set by the account, edited at the cloud.', help: 'The billing plan the account is on.' },
  ],
  lists: [
    {
      name: 'mirrors',
      label: 'Mirrors',
      help: 'Package mirrors new boxes use, nearest first.',
      itemFields: [
        { name: 'name', label: 'Name', kind: 'string' },
        { name: 'url', label: 'URL', kind: 'string' },
      ],
      add: { noun: 'mirror', example: { name: 'eu', url: 'https://mirror.example' }, required: ['name', 'url'] },
      labelField: 'name',
      empty: 'None yet — boxes use the default archive.',
    },
  ],
  offering: { noun: 'droplet size', example: 'n-small' },
  advisories: [
    { surface: 'settings', text: 'Nimbus is a fixture.' },
    { surface: 'create', text: 'Nothing here is billed.' },
  ],
}

const describeProvider = (id: string) =>
  id === 'hetzner'
    ? { displayName: 'Hetzner Cloud', settings: HETZNER }
    : id === 'nimbus'
      ? { displayName: 'Nimbus Cloud', settings: NIMBUS }
      : id === 'cumulus'
        ? { displayName: 'Cumulus' }
        : undefined

const tree = (personal: Record<string, unknown>) => ({ providers: personal })

const paths = (inv: ReturnType<typeof buildSettingsInventory>) => inv.fields.map((f) => f.path)

describe('a declared shipped provider (Hetzner)', () => {
  const inv = buildSettingsInventory({ tree: tree({}), describeProvider })

  it('gets its rows from the declaration, with core’s enabled first and sizes last, and no package', () => {
    const hetzner = paths(inv).filter((p) => p.startsWith('providers.hetzner.'))
    expect(hetzner).toEqual([
      'providers.hetzner.enabled',
      'providers.hetzner.token',
      'providers.hetzner.location',
      'providers.hetzner.consoleProjectId',
      'providers.hetzner.sizes',
    ])
    const token = inv.specFor(['providers', 'hetzner', 'token'])!
    expect(token).toMatchObject({ kind: 'secret', label: 'Token Environment Variable', example: 'HETZNER_TOKEN', writable: true, appliesAt: 'save' })
    expect(inv.specFor(['providers', 'hetzner', 'sizes'])).toMatchObject({ writable: false, reason: expect.stringContaining('server type') })
    expect(inv.specFor(['providers', 'hetzner', 'enabled'])?.help).toContain('with Hetzner')
  })

  it('keeps the provider tabs and the saved-type cards in the order they have always had', () => {
    const ids = inv.sections.map((s) => s.id)
    const providers = ids.filter((id) => id.startsWith('providers.'))
    expect(providers).toEqual([
      'providers.hetzner',
      'providers.aws',
      'providers.azure',
      'providers.gcp',
      'providers.byo',
      'providers.byo.hosts',
    ])
    const tiers = ids.filter((id) => /^preferences\.tiers\./.test(id))
    expect(tiers).toEqual(PROVIDER_ORDER.map((id) => `preferences.tiers.${id}`))
    // And everything around them is where fields.ts puts it.
    expect(ids.indexOf('ssh.keys')).toBeLessThan(ids.indexOf('providers.hetzner'))
    expect(ids.indexOf('providers.byo.hosts')).toBeLessThan(ids.indexOf('limits'))
    expect(ids.indexOf('preferences')).toBeLessThan(ids.indexOf('preferences.tiers.hetzner'))
    expect(ids.indexOf('preferences.tiers.byo')).toBeLessThan(ids.indexOf('registry'))
  })

  it('generates the saved-type fields from the declared vocabulary, with the same sentence the table uses', () => {
    const small = inv.specFor(['preferences', 'tiers', 'hetzner', 'small'])!
    expect(small.help).toContain('The server type to use whenever you ask Hetzner for a small box — cpx21, for instance')
    const aws = inv.specFor(['preferences', 'tiers', 'aws', 'small'])!
    expect(aws.help).toContain('The instance type to use whenever you ask AWS for a small box')
    expect(inv.sections.find((s) => s.id === 'preferences.tiers.hetzner')?.title).toBe('Hetzner')
  })

  it('carries only settings-surface advisories on the section, and none when there are none', () => {
    expect(inv.sections.find((s) => s.id === 'providers.hetzner')?.advisories).toBeUndefined()
  })

  it('masks the declared secret and shows the declared string', () => {
    expect(inv.isSecretPath(['providers', 'hetzner', 'token'])).toBe(true)
    expect(inv.isSecretPath(['providers', 'hetzner', 'location'])).toBe(false)
    expect(inv.isSecretPath(['providers', 'hetzner', 'consoleProjectId'])).toBe(false)
  })
})

describe('a declared personal provider (Nimbus)', () => {
  const inv = buildSettingsInventory({ tree: tree({ nimbus: { package: 'p', enabled: false } }), describeProvider })

  it('gets enabled, package, its declared fields, the implied allowAllCidr, sizes, and its list', () => {
    expect(paths(inv).filter((p) => p.startsWith('providers.nimbus.'))).toEqual([
      'providers.nimbus.enabled',
      'providers.nimbus.package',
      'providers.nimbus.token',
      'providers.nimbus.region',
      'providers.nimbus.sshAllowedCidr',
      'providers.nimbus.allowAllCidr',
      'providers.nimbus.plan',
      'providers.nimbus.sizes',
      'providers.nimbus.mirrors.*.name',
      'providers.nimbus.mirrors.*.url',
    ])
    expect(inv.specFor(['providers', 'nimbus', 'sshAllowedCidr'])).toMatchObject({ kind: 'sshCidrList', label: 'SSH allowed from' })
    expect(inv.specFor(['providers', 'nimbus', 'allowAllCidr'])).toMatchObject({ kind: 'boolean', help: expect.stringContaining('0.0.0.0/0') })
    expect(inv.specFor(['providers', 'nimbus', 'plan'])).toMatchObject({ writable: false, reason: 'Set by the account, edited at the cloud.' })
    expect(inv.specFor(['providers', 'nimbus', 'package'])).toMatchObject({ appliesAt: 'restart' })
    expect(inv.restartRequiredPaths).toContain('providers.nimbus.package')
    expect(inv.lists.find((l) => l.path === 'providers.nimbus.mirrors')).toMatchObject({
      itemFields: ['name', 'url'],
      labelField: 'name',
      add: { noun: 'mirror', required: ['name', 'url'] },
    })
  })

  it('is placed after the shipped providers with its list as a card on its tab, and its saved types after theirs', () => {
    const ids = inv.sections.map((s) => s.id)
    expect(ids.indexOf('providers.nimbus')).toBe(ids.indexOf('providers.byo.hosts') + 1)
    expect(ids[ids.indexOf('providers.nimbus') + 1]).toBe('providers.nimbus.mirrors')
    expect(ids.indexOf('providers.nimbus.mirrors')).toBeLessThan(ids.indexOf('limits'))
    expect(ids.indexOf('preferences.tiers.nimbus')).toBe(ids.indexOf('preferences.tiers.byo') + 1)
    expect(inv.sections.find((s) => s.id === 'providers.nimbus')).toMatchObject({
      title: 'Nimbus Cloud',
      advisories: ['Nimbus is a fixture.'],
    })
  })

  it('shows what the declaration vouches for and masks what it does not', () => {
    expect(inv.isSecretPath(['providers', 'nimbus', 'token'])).toBe(true)
    expect(inv.isSecretPath(['providers', 'nimbus', 'region'])).toBe(false)
    expect(inv.isSecretPath(['providers', 'nimbus', 'sshAllowedCidr'])).toBe(false)
    expect(inv.isSecretPath(['providers', 'nimbus', 'enabled'])).toBe(false)
    // A leaf the file has that the declaration never mentioned: masked, because it could be anything.
    expect(inv.isSecretPath(['providers', 'nimbus', 'privateKey'])).toBe(true)
    expect(inv.isSecretPath(['providers', 'nimbus', 'anythingElse'])).toBe(true)
  })
})

describe('an undeclared personal provider (Cumulus), and one nobody loaded', () => {
  const inv = buildSettingsInventory({ tree: tree({ cumulus: { package: 'p' }, stratus: { package: 'q', secretSauce: 'x' } }), describeProvider })

  it('gets core’s three rows and a section — named by the factory when it loaded, by the id when not', () => {
    expect(paths(inv).filter((p) => p.startsWith('providers.cumulus.'))).toEqual([
      'providers.cumulus.enabled',
      'providers.cumulus.package',
      'providers.cumulus.sizes',
    ])
    expect(inv.sections.find((s) => s.id === 'providers.cumulus')?.title).toBe('Cumulus')
    expect(inv.sections.find((s) => s.id === 'providers.stratus')?.title).toBe('stratus')
    expect(inv.sections.find((s) => s.id === 'providers.stratus')?.help).toContain("runs with Rocky Surf's full access — install ones you trust")
  })

  it('masks every leaf core cannot vouch for, and only those', () => {
    expect(inv.isSecretPath(['providers', 'stratus', 'secretSauce'])).toBe(true)
    expect(inv.isSecretPath(['providers', 'stratus', 'region'])).toBe(true)
    expect(inv.isSecretPath(['providers', 'stratus', 'enabled'])).toBe(false)
    expect(inv.isSecretPath(['providers', 'stratus', 'package'])).toBe(false)
    expect(inv.isSecretPath(['providers', 'stratus', 'sizes'])).toBe(false)
  })
})

describe('with nothing declared and nothing personal', () => {
  it('is exactly the static inventory, minus Hetzner — which has no static rows and is not pretended into existence', () => {
    const inv = buildSettingsInventory({ tree: tree({}) })
    expect(inv.fields).toEqual(SETTINGS_FIELDS)
    expect(inv.sections).toEqual(SETTINGS_SECTIONS)
    expect(inv.specFor(['providers', 'hetzner', 'token'])).toBeUndefined()
    // …but a token is still a token, by name, even in a section with no rows.
    expect(inv.isSecretPath(['providers', 'hetzner', 'token'])).toBe(true)
  })
})
