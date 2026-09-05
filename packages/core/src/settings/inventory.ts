import type { ProviderSettingField, ProviderSettingList, ProviderSettings } from '@rockysurf/provider-sdk'
import { isShippedProviderId, personalProviderIdsIn, SHIPPED_PROVIDER_IDS } from '../config/personal-providers.js'
import {
  RESTART_REQUIRED_PATHS,
  SECRET_FIELD_PATHS,
  SETTINGS_FIELDS,
  SETTINGS_LISTS,
  SETTINGS_SECTIONS,
  isSecretKeyName,
  patternOf,
  tierPreferenceFields,
  tierPreferenceSection,
  type FieldSpec,
  type ListSpec,
  type SectionSpec,
} from './fields.js'

/**
 * THE SETTINGS INVENTORY, BUILT PER FILE AND PER PROVIDER (ADR-0026, ADR-0027).
 *
 * `fields.ts` is the hand-written inventory of what the Settings page edits. It used to be the
 * WHOLE inventory, and a config path with no `FieldSpec` renders nowhere (rule 2 in
 * `SettingsPage.tsx` draws from `view.fields`, never from `view.values`). Two things now add rows
 * to it at request time:
 *
 *  - **A provider's declared settings** (`ProviderFactory.settings`, ADR-0027). The composition
 *    root records what every factory it knows declares — shipped or personal, loaded or not — as a
 *    `ProviderDescriptor` on the registry, and this file turns a declaration into `FieldSpec`s,
 *    `SectionSpec`s and `ListSpec`s the page already knows how to draw. That is how a provider that
 *    is not in this repository gets a Settings panel, and how Hetzner lost its hand-written rows.
 *  - **A personal section with no declaration** (ADR-0026). Core contributes what it knows about
 *    ANY personal section — `enabled`, `package`, `sizes` — so a mistyped `package:` is fixable from
 *    the page and the provider can be switched on; its own fields are edited in the file.
 *
 * WHAT STAYS HAND-WRITTEN. Core's own sections (`server`, `github`, `ssh`, `limits`, `registry`,
 * `mcp`, `backup`) — not provider variability. And the shipped providers that have not yet moved
 * to a declaration (AWS, Azure, GCP, BYO) keep their rows in `fields.ts`; a declared and a static
 * provider look identical to the page, which is the point.
 *
 * ORDER IS PRESERVED, NOT DERIVED. The provider tabs have always run hetzner, aws, azure, gcp,
 * byo, and the saved-type cards under Preferences the same way; ordering them by the schema's key
 * order (aws first) would move Hetzner from the first tab to the fourth. `PROVIDER_ORDER` says the
 * order; declared and static sections slot into it alike, and personal providers follow in the
 * order the file lists them.
 *
 * REDACTION. `fields.ts`'s `SECRET_KEY_NAME` masks a field by its NAME as the backstop for a key
 * the schema does not declare. For a personal section that backstop is not enough — `privateKey`,
 * `serviceAccountJson` slip past it — so every leaf of a personal section is masked unless a
 * declaration says what kind it is, or it is one of core's three. A declared `secret` is masked
 * wherever it is; a declared `string` is shown.
 *
 * Built on every request from the raw tree, not from the parsed config, because the file the page
 * exists to repair is precisely one that may not validate yet.
 */

export interface SettingsInventory {
  fields: readonly FieldSpec[]
  sections: readonly SectionSpec[]
  lists: readonly ListSpec[]
  /** Paths that wait for a restart — `RESTART_REQUIRED_PATHS` plus every declared/personal one. */
  restartRequiredPaths: readonly string[]
  /** The inventory entry for a concrete path (`*` for list indexes), if the page edits it. */
  specFor(path: readonly (string | number)[]): FieldSpec | undefined
  /** Whether a value at this path is a credential the view must mask. */
  isSecretPath(path: readonly (string | number)[]): boolean
}

/** What the inventory needs to know about a provider id — a `ProviderDescriptor`'s relevant half. */
export interface DescribedProvider {
  displayName: string
  settings?: ProviderSettings
}

export interface SettingsInventoryDeps {
  /** The file's raw tree — `parseTree(text)` — whose non-shipped `providers.*` keys get panels. */
  tree: unknown
  /** What the composition root knows about a provider id, when it loaded a factory for it. */
  describeProvider?: (id: string) => DescribedProvider | undefined
}

/** The order the provider tabs and the saved-type cards have always had. */
export const PROVIDER_ORDER: readonly string[] = ['hetzner', 'aws', 'azure', 'gcp', 'byo']

/** Core's three fields of a provider section, the only ones it can vouch are not credentials. */
const CORE_PROVIDER_FIELDS = new Set(['enabled', 'package', 'sizes'])

const ENABLED_HELP = (title: string) =>
  `Whether Rocky Surf may create servers with ${title}. Every provider is off until you turn it on, ` +
  'so a fresh install cannot spend money by accident.'

function enabledField(id: string, title: string): FieldSpec {
  return { path: `providers.${id}.enabled`, kind: 'boolean', writable: true, appliesAt: 'save', help: ENABLED_HELP(title) }
}

function packageField(id: string): FieldSpec {
  return {
    path: `providers.${id}.package`,
    kind: 'string',
    writable: true,
    appliesAt: 'restart',
    restartReason:
      'A provider package is loaded when Rocky Surf starts. Changing which package this section ' +
      'names, or adding a new section, takes effect at the next restart.',
    help:
      'The npm package that implements this provider, installed under the data directory\'s ' +
      '`providers` folder — or a path to a built package you are developing. A provider runs with ' +
      "Rocky Surf's full access — install ones you trust.",
  }
}

function sizesField(id: string, noun: string): FieldSpec {
  return {
    path: `providers.${id}.sizes`,
    kind: 'stringList',
    writable: false,
    appliesAt: 'save',
    help:
      `The only ${noun}s this installation will create with this provider — on the New Server page and ` +
      'through the API, the CLI and MCP alike. Unset offers everything it sells.',
    reason: `An allowlist of ${noun}s, edited in the file — this page does not surface a list editor for it.`,
  }
}

/**
 * The second act of the SSH whitelist, beside any declared `sshCidrList` (ADR-0021). Core's
 * control, core's words — the same two sentences the hand-written AWS row carries.
 */
function allowAllCidrField(id: string): FieldSpec {
  return {
    path: `providers.${id}.allowAllCidr`,
    kind: 'boolean',
    writable: true,
    appliesAt: 'save',
    help:
      'Confirms that you mean 0.0.0.0/0 in the list above. Opening SSH to the whole internet is two ' +
      'decisions, not one typo, so the CIDR alone is refused without this.',
    warning:
      'Turning this on lets SSH be reachable from the entire internet. These boxes run ' +
      'agent-authored code and hold your git token. Leave it off unless you have another control ' +
      'in front of them.',
  }
}

function declaredField(id: string, field: ProviderSettingField): FieldSpec {
  return {
    path: `providers.${id}.${field.name}`,
    kind: field.kind,
    writable: field.writable ?? true,
    appliesAt: field.appliesAt ?? 'save',
    help: field.help,
    label: field.label,
    ...(field.example !== undefined ? { example: field.example } : {}),
    ...(field.warning !== undefined ? { warning: field.warning } : {}),
    ...(field.reason !== undefined ? { reason: field.reason } : {}),
    ...(field.restartReason !== undefined ? { restartReason: field.restartReason } : {}),
    ...(field.accepts !== undefined ? { accepts: field.accepts } : {}),
  }
}

function declaredList(id: string, list: ProviderSettingList): { list: ListSpec; fields: FieldSpec[]; section: SectionSpec } {
  const path = `providers.${id}.${list.name}`
  return {
    list: {
      path,
      itemFields: list.itemFields.map((f) => f.name),
      ...(list.add ? { add: list.add } : {}),
      ...(list.labelField ? { labelField: list.labelField } : {}),
      empty: list.empty,
    },
    fields: list.itemFields.map((item) => ({
      path: `${path}.*.${item.name}`,
      kind: item.kind,
      writable: true,
      appliesAt: 'save',
      help: list.help,
      label: item.label,
    })),
    section: { id: path, title: list.label, help: list.help },
  }
}

interface ProviderRows {
  fields: FieldSpec[]
  sections: SectionSpec[]
  lists: ListSpec[]
  tierFields: FieldSpec[]
  tierSection?: SectionSpec
  /** Declared names, so redaction knows which leaves are spoken for. */
  declared: Set<string>
  secrets: Set<string>
}

/** The rows a DECLARED provider contributes — shipped or personal. */
function declaredRows(id: string, described: DescribedProvider & { settings: ProviderSettings }, personal: boolean): ProviderRows {
  const { settings } = described
  const fields: FieldSpec[] = [enabledField(id, settings.title)]
  if (personal) fields.push(packageField(id))
  const declared = new Set<string>(CORE_PROVIDER_FIELDS)
  const secrets = new Set<string>()
  for (const field of settings.fields) {
    fields.push(declaredField(id, field))
    declared.add(field.name)
    if (field.kind === 'secret') secrets.add(field.name)
    if (field.kind === 'sshCidrList') {
      fields.push(allowAllCidrField(id))
      declared.add('allowAllCidr')
    }
  }
  fields.push(sizesField(id, settings.offering.noun))

  const lists: ListSpec[] = []
  const sections: SectionSpec[] = [
    {
      id: `providers.${id}`,
      title: settings.title,
      help: settings.help,
      ...(settings.advisories?.some((a) => a.surface === 'settings')
        ? { advisories: settings.advisories.filter((a) => a.surface === 'settings').map((a) => a.text) }
        : {}),
    },
  ]
  for (const list of settings.lists ?? []) {
    const built = declaredList(id, list)
    lists.push(built.list)
    fields.push(...built.fields)
    sections.push(built.section)
    declared.add(list.name)
  }

  const cloud = { id, label: settings.title, noun: settings.offering.noun, example: settings.offering.example }
  return { fields, sections, lists, tierFields: tierPreferenceFields(cloud), tierSection: tierPreferenceSection(cloud), declared, secrets }
}

/** The rows a personal section with NO declaration gets: what core knows about any of them. */
function undeclaredPersonalRows(id: string, displayName: string | undefined): ProviderRows {
  const title = displayName ?? id
  return {
    fields: [enabledField(id, title), packageField(id), sizesField(id, 'machine type')],
    sections: [
      {
        id: `providers.${id}`,
        title,
        help:
          `A provider you installed yourself (\`providers.${id}.package\`). It runs with Rocky Surf's full ` +
          'access — install ones you trust. Its own settings are edited in the config file until the ' +
          'provider declares them; this page can switch it on and off and shows the package it loads from.',
      },
    ],
    lists: [],
    tierFields: [],
    declared: new Set(CORE_PROVIDER_FIELDS),
    secrets: new Set(),
  }
}

/**
 * Splice provider sections into the static order: the contiguous run of `providers.*` sections
 * in `SETTINGS_SECTIONS` is replaced by the ordered set (static or declared, hetzner first), and
 * the run of `preferences.tiers.*` cards likewise.
 */
function orderedSections(
  providerIds: readonly string[],
  sectionsByProvider: Map<string, SectionSpec[]>,
  tierSectionsByProvider: Map<string, SectionSpec>,
): SectionSpec[] {
  const staticProviderSections = new Map<string, SectionSpec[]>()
  const staticTierSections = new Map<string, SectionSpec>()
  for (const section of SETTINGS_SECTIONS) {
    const provider = section.id.match(/^providers\.([^.]+)/)?.[1]
    if (provider) {
      const list = staticProviderSections.get(provider) ?? []
      list.push(section)
      staticProviderSections.set(provider, list)
      continue
    }
    const tier = section.id.match(/^preferences\.tiers\.([^.]+)$/)?.[1]
    if (tier) staticTierSections.set(tier, section)
  }

  const providerRun = providerIds.flatMap((id) => sectionsByProvider.get(id) ?? staticProviderSections.get(id) ?? [])
  const tierRun = providerIds.flatMap((id) => {
    const section = tierSectionsByProvider.get(id) ?? staticTierSections.get(id)
    return section ? [section] : []
  })

  const out: SectionSpec[] = []
  let providersDone = false
  let tiersDone = false
  for (const section of SETTINGS_SECTIONS) {
    if (section.id.startsWith('providers.')) {
      if (!providersDone) out.push(...providerRun)
      providersDone = true
      continue
    }
    if (/^preferences\.tiers\./.test(section.id)) {
      if (!tiersDone) out.push(...tierRun)
      tiersDone = true
      continue
    }
    out.push(section)
  }
  if (!providersDone) out.push(...providerRun)
  if (!tiersDone) out.push(...tierRun)
  return out
}

export function buildSettingsInventory(deps: SettingsInventoryDeps): SettingsInventory {
  const personalIds = personalProviderIdsIn(deps.tree)
  const providerIds = [...PROVIDER_ORDER.filter((id) => (SHIPPED_PROVIDER_IDS as readonly string[]).includes(id)), ...personalIds]

  const fields: FieldSpec[] = [...SETTINGS_FIELDS]
  const lists: ListSpec[] = [...SETTINGS_LISTS]
  const sectionsByProvider = new Map<string, SectionSpec[]>()
  const tierSectionsByProvider = new Map<string, SectionSpec>()
  const restart: string[] = [...RESTART_REQUIRED_PATHS]
  const declaredByProvider = new Map<string, Set<string>>()
  const secretsByProvider = new Map<string, Set<string>>()

  for (const id of providerIds) {
    const described = deps.describeProvider?.(id)
    const personal = !isShippedProviderId(id)
    let rows: ProviderRows | undefined
    if (described?.settings) rows = declaredRows(id, { ...described, settings: described.settings }, personal)
    else if (personal) rows = undeclaredPersonalRows(id, described?.displayName)
    if (!rows) continue // a shipped provider with no declaration keeps its hand-written rows

    fields.push(...rows.fields, ...rows.tierFields)
    lists.push(...rows.lists)
    sectionsByProvider.set(id, rows.sections)
    if (rows.tierSection) tierSectionsByProvider.set(id, rows.tierSection)
    for (const field of rows.fields) if (field.appliesAt === 'restart') restart.push(field.path)
    declaredByProvider.set(id, rows.declared)
    secretsByProvider.set(id, rows.secrets)
  }

  const byPattern = new Map(fields.map((field) => [field.path, field]))
  const staticSecrets = new Set(SECRET_FIELD_PATHS)
  const personal = new Set(personalIds)

  return {
    fields,
    sections: orderedSections(providerIds, sectionsByProvider, tierSectionsByProvider),
    lists,
    restartRequiredPaths: restart,
    specFor: (path) => byPattern.get(patternOf(path)),
    isSecretPath: (path) => {
      if (staticSecrets.has(patternOf(path))) return true
      if (path[0] === 'providers' && typeof path[1] === 'string' && typeof path[2] === 'string') {
        const id = path[1]
        const leaf = path[2]
        if (secretsByProvider.get(id)?.has(leaf)) return true
        // A personal section: everything core cannot vouch for, or the provider did not declare,
        // is masked. Declared non-secrets are shown.
        if (personal.has(id)) return !(declaredByProvider.get(id)?.has(leaf) ?? false)
      }
      const last = path[path.length - 1]
      return typeof last === 'string' && isSecretKeyName(last)
    },
  }
}
