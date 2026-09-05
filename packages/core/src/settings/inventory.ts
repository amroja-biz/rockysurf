import { personalProviderIdsIn } from '../config/personal-providers.js'
import {
  RESTART_REQUIRED_PATHS,
  SECRET_FIELD_PATHS,
  SETTINGS_FIELDS,
  SETTINGS_LISTS,
  SETTINGS_SECTIONS,
  isSecretKeyName,
  patternOf,
  type FieldSpec,
  type ListSpec,
  type SectionSpec,
} from './fields.js'

/**
 * THE SETTINGS INVENTORY, BUILT PER FILE RATHER THAN DECLARED ONCE (ADR-0026).
 *
 * `fields.ts` is the hand-written inventory of what the Settings page edits, and until this file
 * it was the WHOLE inventory: a config path with no `FieldSpec` renders nowhere, because the page
 * draws from `view.fields` and never from `view.values` (rule 2 in `SettingsPage.tsx`). That was
 * fine while every section of the file was one core had declared. A personal provider is a
 * section core has not heard of, and shipping it invisible would repeat the failure this
 * repository has already paid for twice — a section that exists and cannot be seen.
 *
 * So the inventory is derived from the file: for every `providers.<id>` key that is not one of
 * the shipped five, core contributes what it knows about ANY personal section — `enabled`,
 * `package` and `sizes` — and a section to draw them in. That is enough to switch a personal
 * cloud on and off from the page and to fix a mistyped `package:` from the page the operator was
 * sent to. The provider's OWN fields are edited in the file until the provider declares them
 * (`ProviderFactory.settings`, the next ADR), and the section's help says so.
 *
 * REDACTION DEFAULTS THE OTHER WAY FOR THESE SECTIONS. `fields.ts`'s `SECRET_KEY_NAME` masks a
 * field by its NAME — `token`, `apiKey` — as the backstop for a key the schema does not declare.
 * For a section core knows nothing about that backstop is not enough: `privateKey`,
 * `serviceAccountJson`, `credentials` all slip past it, and the settings view would hand a
 * literal credential back to the browser. So every scalar leaf of a personal section is masked
 * unless core knows it is not a credential (`enabled`, `package`, `sizes`). A declared non-secret
 * field un-masks itself when declared settings arrive; until then the page shows a masked value
 * rather than a leak.
 *
 * Built on every request from the raw tree, not from the parsed config, because the file the page
 * exists to repair is precisely one that may not validate yet.
 */

export interface SettingsInventory {
  fields: readonly FieldSpec[]
  sections: readonly SectionSpec[]
  lists: readonly ListSpec[]
  /** Paths that wait for a restart — `RESTART_REQUIRED_PATHS` plus every personal `package`. */
  restartRequiredPaths: readonly string[]
  /** The inventory entry for a concrete path (`*` for list indexes), if the page edits it. */
  specFor(path: readonly (string | number)[]): FieldSpec | undefined
  /** Whether a value at this path is a credential the view must mask. */
  isSecretPath(path: readonly (string | number)[]): boolean
}

export interface SettingsInventoryDeps {
  /** The file's raw tree — `parseTree(text)` — whose non-shipped `providers.*` keys get panels. */
  tree: unknown
  /** What the composition root knows about a provider id, when it loaded a factory for it. */
  describeProvider?: (id: string) => { displayName: string } | undefined
}

/** Core's three fields of a personal section, the only ones it can vouch are not credentials. */
const PERSONAL_CORE_FIELDS = new Set(['enabled', 'package', 'sizes'])

function personalFields(id: string): FieldSpec[] {
  return [
    {
      path: `providers.${id}.enabled`,
      kind: 'boolean',
      writable: true,
      appliesAt: 'save',
      help:
        `Whether Rocky Surf may create servers with this provider. Every provider is off until you turn it ` +
        'on, so a fresh install cannot spend money by accident.',
    },
    {
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
    },
    {
      path: `providers.${id}.sizes`,
      kind: 'stringList',
      writable: false,
      appliesAt: 'save',
      help:
        'The only machine types this installation will create with this provider — on the New Server ' +
        'page and through the API, the CLI and MCP alike. Unset offers everything it sells.',
      reason: 'An allowlist of machine types, edited in the file — this page does not surface a list editor for it.',
    },
  ]
}

function personalSection(id: string, displayName: string | undefined): SectionSpec {
  return {
    id: `providers.${id}`,
    title: displayName ?? id,
    help:
      `A provider you installed yourself (\`providers.${id}.package\`). It runs with Rocky Surf's full ` +
      'access — install ones you trust. Its own settings are edited in the config file until the ' +
      'provider declares them; this page can switch it on and off and shows the package it loads from.',
  }
}

/**
 * Where a personal provider's tab sits: after the shipped provider sections and before
 * everything else, in the order the file lists them.
 */
function withPersonalSections(personal: readonly SectionSpec[]): SectionSpec[] {
  const out: SectionSpec[] = []
  let inserted = false
  for (const section of SETTINGS_SECTIONS) {
    if (!inserted && !section.id.startsWith('providers.') && out.some((s) => s.id.startsWith('providers.'))) {
      out.push(...personal)
      inserted = true
    }
    out.push(section)
  }
  if (!inserted) out.push(...personal)
  return out
}

export function buildSettingsInventory(deps: SettingsInventoryDeps): SettingsInventory {
  const personalIds = personalProviderIdsIn(deps.tree)
  const fields: FieldSpec[] = [...SETTINGS_FIELDS, ...personalIds.flatMap(personalFields)]
  const sections = withPersonalSections(personalIds.map((id) => personalSection(id, deps.describeProvider?.(id)?.displayName)))
  const restartRequiredPaths = [
    ...RESTART_REQUIRED_PATHS,
    ...personalIds.map((id) => `providers.${id}.package`),
  ]
  const byPattern = new Map(fields.map((field) => [field.path, field]))
  const secretPatterns = new Set(SECRET_FIELD_PATHS)
  const personal = new Set(personalIds)

  return {
    fields,
    sections,
    lists: SETTINGS_LISTS,
    restartRequiredPaths,
    specFor: (path) => byPattern.get(patternOf(path)),
    isSecretPath: (path) => {
      if (secretPatterns.has(patternOf(path))) return true
      // A personal section: everything core cannot vouch for is masked.
      if (path[0] === 'providers' && typeof path[1] === 'string' && personal.has(path[1])) {
        const leaf = path[2]
        return typeof leaf === 'string' && !PERSONAL_CORE_FIELDS.has(leaf)
      }
      const last = path[path.length - 1]
      return typeof last === 'string' && isSecretKeyName(last)
    },
  }
}
