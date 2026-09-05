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

/**
 * THE OTHER FOUR SHIPPED PROVIDERS, ABBREVIATED (issue #370).
 *
 * They declare too now, so the merged order below is a merge of five declarations rather than one
 * declaration spliced into four static sections. Kept short on purpose: the real prose is the
 * provider's and is held to its own conformance suite; what is pinned here is the SHAPE and the
 * ORDER an operator sees. BYO is the interesting one — a list, no `sizes`, and a lower-case name
 * for the sentences the saved-type cards are made of.
 */
const AWS: ProviderSettings = {
  title: 'AWS',
  help: 'EC2 instances in one region, with no credential to type here.',
  fields: [
    { name: 'region', kind: 'string', label: 'Region', help: 'Which AWS region new instances are created in.' },
    { name: 'sshAllowedCidr', kind: 'sshCidrList', label: 'SSH allowed from', help: 'Which networks may reach SSH on the boxes AWS creates here.' },
  ],
  offering: { noun: 'instance type', example: 't4g.medium' },
}

const AZURE: ProviderSettings = {
  title: 'Azure',
  help: 'Virtual machines in one region, in one resource group you create.',
  fields: [
    { name: 'location', kind: 'string', label: 'Location', help: 'Which Azure region new VMs are created in.' },
    { name: 'sshAllowedCidr', kind: 'sshCidrList', label: 'SSH allowed from', help: 'Which networks may reach SSH on the boxes Azure creates here.' },
  ],
  offering: { noun: 'VM size', example: 'Standard_B2ps_v2' },
}

const GCP: ProviderSettings = {
  title: 'Google Cloud',
  help: 'Compute Engine instances in one zone, in one project you name.',
  fields: [
    { name: 'projectId', kind: 'string', label: 'Project id', help: 'The project every instance lives in.' },
    { name: 'sshAllowedCidr', kind: 'sshCidrList', label: 'SSH allowed from', help: 'Which networks may reach SSH on the boxes GCP creates here.' },
  ],
  offering: { noun: 'machine type', example: 't2a-standard-2' },
}

const BYO: ProviderSettings = {
  title: 'Your own machines',
  help: 'Machines you already have, managed over SSH.',
  fields: [
    { name: 'identityFile', kind: 'string', label: 'Default private key path', help: 'A path to the private key used to log in to every host below.' },
  ],
  lists: [
    {
      name: 'hosts',
      label: 'Hosts',
      help: 'The machines Rocky Surf may claim. Enabling the provider above requires at least one.',
      itemFields: [
        { name: 'name', label: 'Name', kind: 'string' },
        { name: 'user', label: 'Admin login', kind: 'string', help: 'The admin login Rocky Surf claims the machine with.' },
      ],
      add: { noun: 'host', example: { name: 'build-box', host: '10.0.0.1' }, required: ['name', 'host'] },
      labelField: 'name',
      empty: 'None yet. Enabling this provider requires at least one host.',
    },
  ],
  offering: { noun: 'host', example: 'the-nuc-under-the-desk', label: 'your own machines', allowlist: false },
}

const SHIPPED: Record<string, { displayName: string; settings: ProviderSettings }> = {
  hetzner: { displayName: 'Hetzner Cloud', settings: HETZNER },
  aws: { displayName: 'Amazon EC2', settings: AWS },
  azure: { displayName: 'Microsoft Azure', settings: AZURE },
  gcp: { displayName: 'Google Compute Engine', settings: GCP },
  byo: { displayName: 'Bring your own hosts', settings: BYO },
}

const describeProvider = (id: string) =>
  SHIPPED[id] ??
  (id === 'nimbus'
    ? { displayName: 'Nimbus Cloud', settings: NIMBUS }
    : id === 'cumulus'
      ? { displayName: 'Cumulus' }
      : undefined)

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
    // BYO's card is titled by `title` and its sentences named by `offering.label` — the two
    // differ for exactly one provider, and a capitalised title read mid-sentence is why.
    expect(inv.sections.find((s) => s.id === 'preferences.tiers.byo')).toMatchObject({
      title: 'Your own machines',
      help: expect.stringContaining('each size means on your own machines'),
    })
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
    expect(aws.help).toContain('The instance type to use whenever you ask AWS for a small box — t4g.medium, for instance')
    const byo = inv.specFor(['preferences', 'tiers', 'byo', 'small'])!
    expect(byo.help).toContain('The host to use whenever you ask your own machines for a small box')
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

describe('the other four shipped providers, declared (issue #370)', () => {
  const inv = buildSettingsInventory({ tree: tree({}), describeProvider })

  it('gives each firewall cloud the two-act whitelist as one declared kind plus core\u2019s checkbox', () => {
    for (const id of ['aws', 'azure', 'gcp']) {
      expect(inv.specFor(['providers', id, 'sshAllowedCidr'])).toMatchObject({
        kind: 'sshCidrList',
        label: 'SSH allowed from',
      })
      // Core's words, not the provider's — a provider that could word its own confirmation
      // could word it away (ADR-0021's two-act guard).
      expect(inv.specFor(['providers', id, 'allowAllCidr'])).toMatchObject({
        kind: 'boolean',
        help: expect.stringContaining('0.0.0.0/0'),
      })
      expect(paths(inv).indexOf(`providers.${id}.allowAllCidr`)).toBe(
        paths(inv).indexOf(`providers.${id}.sshAllowedCidr`) + 1,
      )
    }
  })

  it('labels the read-only allowlist in each cloud\u2019s own vocabulary', () => {
    expect(inv.specFor(['providers', 'aws', 'sizes'])?.label).toBe('Offered instance types')
    expect(inv.specFor(['providers', 'azure', 'sizes'])?.label).toBe('Offered VM sizes')
    expect(inv.specFor(['providers', 'gcp', 'sizes'])?.label).toBe('Offered machine types')
  })

  it('gives BYO a list and no sizes at all, because its machine types are the hosts', () => {
    expect(paths(inv).filter((p) => p.startsWith('providers.byo.'))).toEqual([
      'providers.byo.enabled',
      'providers.byo.identityFile',
      'providers.byo.hosts.*.name',
      'providers.byo.hosts.*.user',
    ])
    expect(inv.lists.find((l) => l.path === 'providers.byo.hosts')).toMatchObject({
      itemFields: ['name', 'user'],
      labelField: 'name',
      add: { noun: 'host', required: ['name', 'host'] },
      empty: 'None yet. Enabling this provider requires at least one host.',
    })
    // An item field's own sentence when it wrote one, the list's when it did not.
    expect(inv.specFor(['providers', 'byo', 'hosts', 0, 'user'])?.help).toContain('admin login')
    expect(inv.specFor(['providers', 'byo', 'hosts', 0, 'name'])?.help).toContain('Rocky Surf may claim')
    // And the switch reads as a sentence, which is what `offering.label` is for.
    expect(inv.specFor(['providers', 'byo', 'enabled'])?.help).toContain('with your own machines')
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
