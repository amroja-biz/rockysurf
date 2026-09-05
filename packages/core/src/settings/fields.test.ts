import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { configSchema, PINNED_PATHS } from '../config/index.js'
import {
  isSecretKeyName,
  isSecretPath,
  RESTART_REQUIRED_PATHS,
  SETTINGS_FIELDS,
  SETTINGS_LISTS,
  SETTINGS_SECTIONS,
  specFor,
} from './fields.js'
import { buildSettingsInventory } from './inventory.js'
import { secretView } from './view.js'

/**
 * THE CLASSIFICATION CANNOT FALL BEHIND THE SCHEMA.
 *
 * `fields.ts` decides which config fields are credentials, and it decides it by hand. Hand-
 * written lists rot: someone adds `providers.digitalocean.token` to `config/schema.ts`, nobody
 * remembers this file, and the settings API starts returning a live token in a JSON body. The
 * failure would be silent, and it would be a leak.
 *
 * So this file reads `config/schema.ts` as text and fails when a credential-named field appears
 * there without a matching entry here. The same shape as `secrets/route-inventory.test.ts`, and
 * for the same reason: a rule enforced against the source tree keeps working while nobody is
 * looking at it.
 */

const SCHEMA_SOURCE = readFileSync(fileURLToPath(new URL('../config/schema.ts', import.meta.url)), 'utf8')

/**
 * Every field declared in the schema, by the name it has there.
 *
 * Matched on the DECLARATION — `name: z.…` or `name: someSchema` — rather than on indentation,
 * which varies with how prettier broke the chain around it (`token:` sits two spaces deeper
 * than `port:` for no reason a rule should care about).
 */
function declaredFields(source: string): string[] {
  const zodFields = [...source.matchAll(/^\s+([A-Za-z][A-Za-z0-9]*):\s+z\b/gm)].map((m) => m[1]!)
  const composed = [...source.matchAll(/^\s+([A-Za-z][A-Za-z0-9]*):\s+[a-z][A-Za-z0-9]*Schema\b/gm)].map(
    (m) => m[1]!,
  )
  return [...new Set([...zodFields, ...composed])]
}

/**
 * Fields whose NAME says credential but whose VALUE is not one, each with its reason.
 *
 * The list is short on purpose. An entry here is a claim that a field named like a secret may
 * be returned to a browser in full, so it costs a sentence explaining why.
 */
const NOT_CREDENTIALS: Record<string, string> = {
  tokens: 'the LIST of per-repository entries — each entry\'s `pat` is classified, the list is not',
}

/**
 * PROVIDERS WHOSE ROWS ARE DECLARED, NOT WRITTEN HERE (ADR-0027).
 *
 * Name → the factory that declares the rows. Two properties in this file consult it — the
 * credential scan and the provider enumeration — and each keeps its other half in the composition
 * root (`packages/rockysurf/src/settings-parity.test.ts`), which can import the factory and assert
 * it declares what this file no longer carries. NOT `DELIBERATELY_ABSENT`: that set means "an
 * operator cannot manage the provider from the page at all", which would be a lie about Hetzner.
 */
const DECLARED_BY_PROVIDER: Record<string, string> = {
  hetzner: 'hetznerProviderFactory.settings in packages/provider-hetzner/src/index.ts declares token, location and consoleProjectId',
}

/** The credential-named fields the declared factories carry; their secrecy is asserted in the composition root. */
const DECLARED_CREDENTIALS = new Set(['token'])

describe('secret classification tracks config/schema.ts', () => {
  const fields = declaredFields(SCHEMA_SOURCE)

  it('finds the schema, so an empty scan cannot make this vacuous', () => {
    expect(fields).toContain('port')
    expect(fields).toContain('sshAllowedCidr')
    expect(fields.length).toBeGreaterThan(15)
  })

  it('classifies every credential-named field the schema declares', () => {
    const classifiedNames = new Set(
      SETTINGS_FIELDS.filter((f) => f.kind === 'secret').map((f) => f.path.split('.').pop()!),
    )
    const unclassified = fields.filter(
      (name) =>
        isSecretKeyName(name) && !classifiedNames.has(name) && !(name in NOT_CREDENTIALS) && !DECLARED_CREDENTIALS.has(name),
    )

    expect(
      unclassified,
      `config/schema.ts declares ${unclassified.join(', ')}, which reads like a credential and is not ` +
        "classified in fields.ts. Add a `kind: 'secret'` entry for it — or, if its value is not a " +
        'credential, name it in NOT_CREDENTIALS with the reason.',
    ).toEqual([])
  })

  it('classifies nothing the schema no longer has', () => {
    const declared = new Set(fields)
    const stale = SETTINGS_FIELDS.filter((f) => f.kind === 'secret')
      .map((f) => f.path.split('.').pop()!)
      .filter((name) => !declared.has(name))
    expect(stale, `${stale.join(', ')} is classified secret but no longer declared in the schema`).toEqual([])
  })

  it("names the two credential fields core itself declares — Hetzner's token is declared by its factory", () => {
    expect(SETTINGS_FIELDS.filter((f) => f.kind === 'secret').map((f) => f.path)).toEqual([
      'github.pat',
      'github.tokens.*.pat',
    ])
  })

  it('leaves the path-shaped fields alone — a path to a key is not key material', () => {
    expect(isSecretPath(['providers', 'byo', 'identityFile'])).toBe(false)
    expect(isSecretPath(['providers', 'byo', 'hosts', 0, 'identityFile'])).toBe(false)
    expect(isSecretPath(['providers', 'byo', 'hosts', 0, 'fingerprint'])).toBe(false)
    expect(isSecretPath(['github', 'tokens'])).toBe(false)
  })

  it('masks a credential-named key wherever it turns up, schema or no schema', () => {
    expect(isSecretPath(['providers', 'somecloud', 'token'])).toBe(true)
    expect(isSecretPath(['providers', 'somecloud', 'apiToken'])).toBe(true)
    expect(isSecretPath(['whatever', 'adminPassword'])).toBe(true)
  })
})

describe('the inventory is internally consistent', () => {
  it('gives every read-only field a reason an operator can act on', () => {
    for (const field of SETTINGS_FIELDS.filter((f) => !f.writable)) {
      expect(field.reason, `${field.path} is read-only with no reason`).toBeTruthy()
      expect(field.reason!.length).toBeGreaterThan(40)
    }
  })

  it('describes fields the config schema really has', () => {
    // Every inventory path must resolve against a parsed config — a typo here would render a
    // control for a field that can never be saved.
    const full = configSchema.parse({})
    for (const field of SETTINGS_FIELDS) {
      const [section] = field.path.split('.')
      expect(Object.keys(full), `${field.path} names a section the schema does not have`).toContain(section)
    }
  })

  it('matches a concrete list path back to its spec', () => {
    expect(specFor(['github', 'tokens', 3, 'pat'])?.kind).toBe('secret')
    expect(specFor(['providers', 'byo', 'hosts', 0, 'port'])?.kind).toBe('number')
    expect(specFor(['server', 'nonsense'])).toBeUndefined()
  })

  it('declares an item shape for every list the editor offers', () => {
    for (const list of SETTINGS_LISTS) {
      for (const item of list.itemFields) {
        expect(specFor([...list.path.split('.'), 0, item]), `${list.path}.*.${item} has no spec`).toBeDefined()
      }
    }
  })

  /**
   * THE FORM'S PLACEHOLDERS HAVE TO PARSE (issue #302 follow-up, reshaped by rsui-9sc).
   *
   * Nothing is written on Add any more — the button reveals a blank form, and only what the
   * operator types is saved. But `example` is what that form SHOWS as the model answer, so an
   * example the schema would refuse is the page teaching people to type an unsaveable entry.
   * It is a claim about `config/schema.ts`, so it is checked against `config/schema.ts` rather
   * than eyeballed.
   */
  it('offers example values the config schema actually accepts', () => {
    for (const list of SETTINGS_LISTS) {
      if (!list.add) continue
      const segments = list.path.split('.')
      // The document that has this one list, with the example as its only entry.
      const document = segments.reduceRight<unknown>((inner, key) => ({ [key]: inner }), [list.add.example])
      expect(
        () => configSchema.parse(document),
        `${list.path}'s example is not a value the schema accepts, so its form teaches an unsaveable entry`,
      ).not.toThrow()
    }
  })

  /** The form can only ask for boxes it draws, and can only insist on boxes it asks for. */
  it('names only real item fields in example and required', () => {
    for (const list of SETTINGS_LISTS) {
      if (!list.add) continue
      for (const name of Object.keys(list.add.example)) {
        expect(list.itemFields, `${list.path}'s example names no item field ${name}`).toContain(name)
      }
      for (const name of list.add.required) {
        expect(list.itemFields, `${list.path} requires ${name}, which is not an item field`).toContain(name)
      }
      expect(list.add.noun.length, `${list.path}'s Add button has no noun`).toBeGreaterThan(1)
    }
  })

  it('names an item field that exists as the label for every list', () => {
    for (const list of SETTINGS_LISTS) {
      const label = list.labelField ?? list.itemFields[0]!
      expect(list.itemFields, `${list.path}'s labelField names no item field`).toContain(label)
      expect(list.empty.length, `${list.path} has no sentence for when it is empty`).toBeGreaterThan(24)
    }
  })

  /**
   * Only `github.tokens` may decline to be added to, and it has to keep earning that: a list
   * without an `add` has no Add button on the page, which is a dead end unless something else
   * on that section collects the entry instead.
   */
  it('lets only the token list opt out of a generic Add', () => {
    expect(SETTINGS_LISTS.filter((l) => !l.add).map((l) => l.path)).toEqual(['github.tokens'])
  })
})

/**
 * NO PROVIDER LANDS INVISIBLE (rockysurf-dl2o).
 *
 * The gap this guards against was real: the GCP provider branch added `providers.gcp` to
 * `config/schema.ts`, the azure branch added its own settings entries the same morning, and
 * nobody integrated the two — so the Settings page silently had no GCP section, in a file
 * typecheck cannot defend because nothing requires an inventory entry to exist at all.
 *
 * So the expectation is DERIVED, not hand-listed: every provider section the config schema
 * declares must appear in the settings inventory with at least its `enabled` switch, and must
 * have a section for the page to draw it in. A provider deliberately kept off the page goes in
 * `DELIBERATELY_ABSENT` with a written reason, which is what makes an omission a decision
 * rather than an accident.
 */
describe('every provider the config schema declares appears in the settings inventory', () => {
  /**
   * Provider sections the page deliberately does not cover, name → reason. Empty today: even
   * byo — whose nested `hosts` do not fit the flat field model — has its `enabled` switch and
   * its section, with the hosts drawn as a list. An entry here is a claim that an operator
   * cannot manage the provider from the page at all, so it costs a sentence saying why.
   */
  const DELIBERATELY_ABSENT: Record<string, string> = {}

  const providerNames = Object.keys(configSchema.parse({}).providers)

  it('finds the provider sections, so an empty scan cannot make this vacuous', () => {
    expect(providerNames).toContain('hetzner')
    expect(providerNames).toContain('gcp')
    expect(providerNames.length).toBeGreaterThanOrEqual(5)
  })

  it('gives every provider at least its enabled switch, and a section to draw it in', () => {
    const fieldPaths = new Set(SETTINGS_FIELDS.map((f) => f.path))
    const sectionIds = new Set(SETTINGS_SECTIONS.map((s) => s.id))
    for (const name of providerNames.filter((n) => !(n in DELIBERATELY_ABSENT) && !(n in DECLARED_BY_PROVIDER))) {
      expect(
        fieldPaths.has(`providers.${name}.enabled`),
        `config/schema.ts declares providers.${name}, but fields.ts has no providers.${name}.enabled — ` +
          'the provider exists and the Settings page cannot even turn it on. Add its fields, or name ' +
          'it in DELIBERATELY_ABSENT with the reason.',
      ).toBe(true)
      expect(
        sectionIds.has(`providers.${name}`),
        `providers.${name} has fields but no section, so the page has nowhere to draw them`,
      ).toBe(true)
    }
  })

  it('excludes nothing without a written reason for a provider that exists', () => {
    for (const [name, reason] of Object.entries(DELIBERATELY_ABSENT)) {
      expect(providerNames, `${name} is excluded but the schema no longer declares it`).toContain(name)
      expect(reason.length, `${name} is excluded without a reason worth the name`).toBeGreaterThan(20)
    }
  })

  it('names the factory for every provider whose rows are declared rather than written here', () => {
    for (const [name, reason] of Object.entries(DECLARED_BY_PROVIDER)) {
      expect(providerNames, `${name} is declared-by-provider but the schema no longer declares it`).toContain(name)
      expect(reason, `${name}'s entry must name the factory that declares it`).toMatch(/ProviderFactory/)
      // And nothing static remains for it — two homes would drift.
      expect(SETTINGS_FIELDS.some((f) => f.path.startsWith(`providers.${name}.`)), `${name} still has static rows`).toBe(false)
      expect(SETTINGS_SECTIONS.some((s) => s.id === `providers.${name}`), `${name} still has a static section`).toBe(false)
    }
  })
})

/**
 * EVERY FIELD SAYS WHAT IT IS FOR (rockysurf-5qzg, directive 3).
 *
 * `help` is required by `FieldSpec`, so a field added without it does not compile — that is the
 * real gate, and it is a better one than a test because it fires in the editor rather than in
 * CI. What these cases add is that the string is a SENTENCE rather than a placeholder somebody
 * typed to make the compiler stop, and that the same is true of the sections.
 */
describe('every setting on the page explains itself', () => {
  it('gives every field help an operator could act on', () => {
    for (const field of SETTINGS_FIELDS) {
      expect(field.help, `${field.path} has no help text`).toBeTruthy()
      expect(field.help.length, `${field.path}'s help is too short to say anything`).toBeGreaterThan(24)
      expect(field.help.trim(), `${field.path}'s help should read as a sentence`).toMatch(/[.!?]$/)
      // The reason a read-only field gives is a different message from what the field is FOR,
      // and repeating one as the other would leave a control with nothing said about it.
      if (field.reason) expect(field.help).not.toBe(field.reason)
    }
  })

  /**
   * THE ENV-VAR-ONLY POLICY IS IN THE WORDS, NOT ONLY IN THE PAGE (rockysurf-4o3o).
   *
   * The page refuses a literal; this is what stops the sentence under the box drifting back to
   * describing the field as somewhere a token goes, which would leave the refusal arriving as a
   * surprise after somebody had typed one.
   *
   * NARROWED, NOT DELETED (rockysurf-7fyf.2). The rule now covers the secrets that still take a
   * variable name — Hetzner and the BYO fields — because the owner reversed it for the two
   * GitHub PATs and nothing else. Deleting this case along with the reversal would have let the
   * Hetzner wording rot unwatched, which is why the literal fields get their own case below
   * rather than an exemption from this one.
   */
  it('tells every env-var credential box that it takes a variable name rather than a token', () => {
    // The only env-var credential box a shipped provider has is Hetzner's, and Hetzner declares its
    // rows on its factory (ADR-0027) — so the rule is checked over the inventory the page really
    // draws from, built with the same declaration `settings.test.ts` uses. The words are the
    // provider's now; the rule about them is still core's, and still enforced here.
    const built = buildSettingsInventory({
      tree: {},
      describeProvider: (id) =>
        id === 'hetzner'
          ? {
              displayName: 'Hetzner Cloud',
              settings: {
                title: 'Hetzner',
                help: 'The quickest provider to start with.',
                fields: [
                  {
                    name: 'token',
                    kind: 'secret',
                    label: 'Token Environment Variable',
                    example: 'HETZNER_TOKEN',
                    help:
                      'The NAME of an environment variable holding a read/write API token from console.hetzner.com ' +
                      '— `HETZNER_TOKEN`, not the token itself.',
                  },
                ],
                offering: { noun: 'server type', example: 'cpx21' },
              },
            }
          : undefined,
    })
    const envVarSecrets = built.fields.filter((f) => f.kind === 'secret' && f.accepts !== 'literal')
    expect(envVarSecrets.length, 'the rule has no fields left to govern, which makes this vacuous').toBeGreaterThan(
      0,
    )
    for (const field of envVarSecrets) {
      expect(field.help, `${field.path}'s help does not say it takes a variable NAME`).toContain(
        'NAME of an environment variable',
      )
      expect(field.help, `${field.path}'s help does not say what not to put in it`).toContain(
        'not the token itself',
      )
    }
  })

  /**
   * AND THE OTHER HALF: a box that takes a pasted token has to SAY it takes a pasted token.
   *
   * The failure this guards against is the mirror image of the one above — a `accepts: 'literal'`
   * field left with wording that still tells an operator to type a variable name, so the page
   * accepts the paste and the sentence under it calls that a mistake.
   */
  it('tells every paste box what to paste, and where it ends up', () => {
    const literalSecrets = SETTINGS_FIELDS.filter((f) => f.accepts === 'literal')
    expect(literalSecrets.map((f) => f.path)).toEqual(['github.pat', 'github.tokens.*.pat'])
    for (const field of literalSecrets) {
      expect(field.kind, `${field.path} accepts a literal but is not classified secret`).toBe('secret')
      expect(field.help, `${field.path}'s help still asks for a variable name`).not.toContain(
        'NAME of an environment variable',
      )
      expect(field.help, `${field.path}'s help does not say to paste the token`).toContain('Paste the token')
      expect(field.help, `${field.path}'s help does not say where the token ends up`).toContain(
        'configuration file',
      )
    }
  })

  it('gives every section a title and help', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(section.title, `${section.id} has no title`).toBeTruthy()
      expect(section.help.length, `${section.id}'s help is too short`).toBeGreaterThan(24)
      expect(section.help.trim()).toMatch(/[.!?]$/)
    }
  })

  it('names a section for every part of the file the page draws', () => {
    // Pinned, because the page addresses sections by these ids: dropping one silently leaves a
    // section with no heading and no explanation.
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      'server',
      'github',
      'ssh',
      'ssh.keys',
      // `providers.hetzner` is NOT here: it is declared on the factory and spliced in FIRST by
      // `settings/inventory.ts` (see `inventory.test.ts`, which pins the merged order).
      'providers.aws',
      'providers.azure',
      'providers.gcp',
      'providers.byo',
      'providers.byo.hosts',
      'limits',
      'preferences',
      // Likewise `preferences.tiers.hetzner`.
      'preferences.tiers.aws',
      'preferences.tiers.azure',
      'preferences.tiers.gcp',
      'preferences.tiers.byo',
      'registry',
      'registry.sources',
      'mcp',
      // Not a config path — the Backup/Restore tab (issue #331), whose cards act on the whole
      // installation rather than on a field of the file. See its SectionSpec comment.
      'backup',
    ])
  })

  /**
   * The saved-type fields, held to the same shape as everything else here (issue #124).
   *
   * They are the one block in the inventory generated from a table rather than written out
   * entry by entry, so this checks the generated result is a full inventory entry — one
   * writable string field per (cloud, size), with the cloud's own vocabulary in the help — and
   * not twelve rows of the same placeholder.
   */
  it('offers a saved machine type for every size on every cloud', () => {
    const paths = SETTINGS_FIELDS.filter((f) => f.path.startsWith('preferences.tiers.')).map((f) => f.path)
    for (const cloud of ['aws', 'azure', 'gcp', 'byo']) {
      for (const size of ['small', 'medium', 'large']) {
        const path = `preferences.tiers.${cloud}.${size}`
        const field = SETTINGS_FIELDS.find((f) => f.path === path)
        expect(field, `${path} is missing from the inventory`).toBeDefined()
        expect(field!.kind).toBe('string')
        expect(field!.writable, `${path} would be shown and never written`).toBe(true)
        expect(field!.help, `${path}'s help does not say what happens when it is blank`).toContain('blank')
      }
    }
    // Four clouds in the static table: Hetzner's three come from its declaration (ADR-0027) and
    // are pinned, sentence included, in `inventory.test.ts`.
    expect(paths).toHaveLength(12)
    // Every one of them is a real machine type in that cloud's own words, not "a machine type".
    const examples = ['t4g.medium', 'Standard_B2ps_v2', 't2a-standard-2']
    for (const example of examples) {
      expect(
        SETTINGS_FIELDS.some((f) => f.path.startsWith('preferences.tiers.') && f.help.includes(example)),
        `no saved-type field names ${example}, so its box says nothing about what goes in it`,
      ).toBe(true)
    }
  })

  it('puts every field inside a section the page draws', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id)
    for (const field of SETTINGS_FIELDS.filter((f) => !f.hidden)) {
      const covered = ids.some((id) => field.path === id || field.path.startsWith(`${id}.`))
      expect(covered, `${field.path} belongs to no section, so the page has nowhere to draw it`).toBe(true)
    }
  })
})

/**
 * WHAT DOES NOT RENDER, AND WHY IT IS A SHORT LIST (rockysurf-5qzg, directive 1).
 *
 * The rule an owner stated: a field whose only message is "you cannot use this" should not be on
 * the page at all. The trap is applying it to every read-only field, which would take away two
 * that operators genuinely read. These cases pin the distinction so a later sweep cannot quietly
 * widen it in either direction.
 */
describe('a setting that does not exist yet is not drawn', () => {
  it('hides auth.mode, whose one available edit selects a mode that is not built', () => {
    expect(SETTINGS_FIELDS.filter((f) => f.hidden).map((f) => f.path)).toEqual(['auth.mode'])
  })

  it('keeps hiding it from the page without letting it be written', () => {
    // Hidden is a rendering flag. The route still refuses the path by name, with this reason —
    // which is a better refusal than the "the page does not edit that field" a missing entry
    // would produce.
    const spec = specFor(['auth', 'mode'])!
    expect(spec.hidden).toBe(true)
    expect(spec.writable).toBe(false)
    expect(spec.reason).toContain('lock you out')
  })

  it('still draws the read-only settings that are real, and says where they are edited', () => {
    for (const path of ['server.dataDir', 'providers.aws.sizes']) {
      const spec = SETTINGS_FIELDS.find((f) => f.path === path)!
      expect(spec.writable).toBe(false)
      expect(spec.hidden, `${path} is a working setting and its value is worth reading`).toBeUndefined()
      // Each names the place the edit actually happens, which is what makes it more than a refusal.
      expect(spec.reason).toMatch(/file|edit/i)
    }
  })

  it('never hides a field an operator could edit, which would be a control that vanished', () => {
    for (const field of SETTINGS_FIELDS.filter((f) => f.hidden)) {
      expect(field.writable, `${field.path} is hidden and writable — one of those is wrong`).toBe(false)
      expect(field.reason, `${field.path} is hidden with no reason for the refusal`).toBeTruthy()
    }
  })
})

describe('a reference is only a reference when it is the whole value', () => {
  it('reads a bare reference as one', () => {
    expect(secretView('${HETZNER_TOKEN}')).toEqual({
      secret: true,
      state: 'reference',
      reference: '${HETZNER_TOKEN}',
    })
  })

  it('masks anything with a literal half, which is where a leak would hide', () => {
    expect(secretView('tok_live_${SUFFIX}').state).toBe('set')
    expect(secretView('${A}${B}').state).toBe('set')
    expect(secretView(' ${A}').state).toBe('set')
    expect(secretView('$${ESCAPED}').state).toBe('set')
  })

  it('reads absence and emptiness as not set', () => {
    expect(secretView(undefined).state).toBe('unset')
    expect(secretView(null).state).toBe('unset')
    expect(secretView('').state).toBe('unset')
  })

  it('masks a non-string, rather than assuming a number cannot be a credential', () => {
    expect(secretView(12345).state).toBe('set')
  })
})

/**
 * WHEN A SAVED VALUE STARTS BEING USED (issue #264).
 *
 * The page's promise and the mechanism behind it live in two files, so these hold them together.
 * `config/live-config.ts` pins four paths to what this process booted with; every one of them
 * must be marked `appliesAt: 'restart'` here, or the page would say "applied" about a value that
 * is deliberately being ignored — the exact lie this classification exists to prevent. The
 * reverse is NOT asserted: `mcp.scopes` needs a restart of somebody else's process and is not
 * pinned, because nothing in core reads it.
 */
describe('appliesAt — the restart classification', () => {
  it('states it for every field, so nothing acquires a silent default', () => {
    for (const field of SETTINGS_FIELDS) {
      expect(['save', 'restart'], `${field.path}`).toContain(field.appliesAt)
    }
  })

  it('gives a reason for every field that needs a restart, in a sentence', () => {
    for (const field of SETTINGS_FIELDS.filter((f) => f.appliesAt === 'restart')) {
      const reason = field.restartReason ?? ''
      expect(reason.length, `${field.path} needs a restart and does not say why`).toBeGreaterThan(40)
      expect(reason.trim().endsWith('.'), `${field.path}: ${reason}`).toBe(true)
    }
  })

  it('marks a field for every path the config store pins to its booted value', () => {
    for (const path of PINNED_PATHS) {
      expect(RESTART_REQUIRED_PATHS, `${path} is pinned but the page claims it applies on save`).toContain(path)
    }
  })

  it('keeps the list short, and names it — a restart is the exception now', () => {
    expect([...RESTART_REQUIRED_PATHS].sort()).toEqual([
      'auth.mode',
      'mcp.scopes',
      'server.dataDir',
      'server.host',
      'server.port',
    ])
  })

  it('does not put a restart note on a field it also says applies on save', () => {
    for (const field of SETTINGS_FIELDS.filter((f) => f.appliesAt === 'save')) {
      expect(field.restartReason, `${field.path}`).toBeUndefined()
    }
  })
})
