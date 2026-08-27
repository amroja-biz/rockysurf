import { describe, expect, it } from 'vitest'
import { SECRET_ENV_KEY_NAMES } from '../bootstrap/server-secrets.js'
import { PACK_INPUTS_MAX_TOTAL_BYTES, resolvePackInputs, summarizePackInputs } from './inputs.js'
import {
  PACK_INPUT_MAX_COUNT,
  PACK_INPUT_MAX_VALUE_BYTES,
  RESERVED_INPUT_NAMES,
  packFileSchema,
  packInputSchema,
  packInputsSchema,
  type PackInput,
} from './schema.js'

/**
 * `inputs`: the pack field that asks the person creating a server for a value, and the
 * validation that decides what a pack may ask and what an answer may be (issue #189, ADR-0013).
 *
 * The three layers are tested here as three things because they fail differently: the SCHEMA
 * refuses a pack (a contributor's problem, caught in CI and by `rockysurf pack lint`), the
 * RESOLVER refuses a request (a caller's problem, caught before a machine is launched), and the
 * SUMMARY is what a browsing operator is shown before consenting to an install.
 */

const input = (over: Partial<PackInput> = {}): PackInput =>
  packInputSchema.parse({ name: 'HEADLONG_HEADLESS', label: 'Headless install', ...over })

describe('the input declaration a pack may write', () => {
  it('accepts the issue\'s own example, defaulting the two booleans', () => {
    const parsed = packInputSchema.parse({
      name: 'HEADLONG_HEADLESS',
      label: 'Headless install',
      description: 'Install without Docker.',
      required: true,
      default: '1',
    })
    expect(parsed).toEqual({
      name: 'HEADLONG_HEADLESS',
      label: 'Headless install',
      description: 'Install without Docker.',
      required: true,
      // Omitted in the file, present in the parsed object — the same treatment `requiresRepos`
      // gets, so no reader has to write `?? false`.
      secret: false,
      default: '1',
    })
  })

  it('refuses a name that is not an environment variable name', () => {
    for (const name of ['headlong', 'Headlong', '1HEADLONG', 'HEAD-LONG', 'HEAD LONG', '']) {
      expect(packInputSchema.safeParse({ name, label: 'x' }).success, name).toBe(false)
    }
  })

  it('refuses a name Rocky Surf already exports to every step', () => {
    // The whole reserved list, so adding a name to it without a test is not possible.
    for (const name of RESERVED_INPUT_NAMES) {
      const result = packInputSchema.safeParse({ name, label: 'x' })
      expect(result.success, name).toBe(false)
    }
  })

  it('refuses the ROCKYSURF_ and GIT_ namespaces, which are variable-length', () => {
    // `ROCKYSURF_GITHUB_TOKEN_<n>` and `GIT_CONFIG_KEY_<n>` are indexed, so an exact-name list
    // could never close them — the check has to be a prefix.
    expect(packInputSchema.safeParse({ name: 'ROCKYSURF_ANYTHING', label: 'x' }).success).toBe(false)
    expect(packInputSchema.safeParse({ name: 'GIT_CONFIG_KEY_9', label: 'x' }).success).toBe(false)
  })

  it('refuses a default on a secret input', () => {
    // A credential written into a pack file everyone can read is not a secret, and prefilling
    // a password field with one would tell the user it was.
    expect(
      packInputSchema.safeParse({ name: 'API_KEY', label: 'Key', secret: true, default: 'sk-live' }).success,
    ).toBe(false)
    // Without the default it is fine.
    expect(packInputSchema.safeParse({ name: 'API_KEY', label: 'Key', secret: true }).success).toBe(true)
  })

  it('refuses an unknown key, like every other object in this format', () => {
    expect(packInputSchema.safeParse({ name: 'A', label: 'x', requried: true }).success).toBe(false)
  })

  it('refuses two entries claiming one name', () => {
    // Two fields writing one variable, with array order deciding which the box receives.
    const result = packInputsSchema.safeParse([
      { name: 'A', label: 'first' },
      { name: 'A', label: 'second' },
    ])
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toMatch(/duplicate input name/)
  })

  it('bounds how many a pack may declare, and how long a default may be', () => {
    const many = Array.from({ length: PACK_INPUT_MAX_COUNT + 1 }, (_, i) => ({ name: `A${i}`, label: 'x' }))
    expect(packInputsSchema.safeParse(many).success).toBe(false)
    expect(
      packInputSchema.safeParse({ name: 'A', label: 'x', default: 'y'.repeat(PACK_INPUT_MAX_VALUE_BYTES + 1) }).success,
    ).toBe(false)
  })

  it('refuses a default with a newline in it, because secrets.env is line-oriented', () => {
    // `agent.sh` re-reads `secrets.env` line by line to learn the NAMES it forwards into
    // unprivileged steps, so a second line would become a second variable name.
    expect(packInputSchema.safeParse({ name: 'A', label: 'x', default: 'one\ntwo' }).success).toBe(false)
  })

  it('rides on a whole pack file, and is optional there', () => {
    const file = {
      version: 1 as const,
      pack: { packId: 'p', name: 'P', tools: ['t'], displayOrder: 1, enabled: true },
      tools: [],
    }
    expect(packFileSchema.parse(file).pack.inputs).toBeUndefined()
    const withInputs = packFileSchema.parse({
      ...file,
      pack: { ...file.pack, inputs: [{ name: 'A', label: 'x' }] },
    })
    expect(withInputs.pack.inputs).toEqual([{ name: 'A', label: 'x', required: false, secret: false }])
  })
})

/**
 * THE RESERVED LIST AND THE `secrets.env` CONTRACT CANNOT DRIFT.
 *
 * `SECRET_ENV_KEYS` is the closed set of names the platform promises pack authors. Every one of
 * them must be unclaimable as a pack input, or a pack could declare `GITHUB_TOKEN` and its
 * scripts would read whichever of the two the loader happened to write last. The subset is
 * asserted rather than the two lists being one list, because they are different promises with
 * different reasons — see the note above `SECRET_ENV_KEYS`.
 */
describe('the reserved names and the secrets.env contract', () => {
  it('reserves every name the secrets.env contract promises', () => {
    for (const name of SECRET_ENV_KEY_NAMES) expect(RESERVED_INPUT_NAMES.has(name), name).toBe(true)
  })
})

describe('resolving a create request against the declaration', () => {
  it('splits the values by custody, which is the whole point of doing it here', () => {
    const declared = [input({ name: 'FLAG' }), input({ name: 'API_KEY', secret: true })]
    const resolved = resolvePackInputs(declared, { FLAG: '1', API_KEY: 'sk-live' })

    expect(resolved.issues).toEqual([])
    // The row's half.
    expect(resolved.values).toEqual({ FLAG: '1' })
    // The encrypted store's half. Never on a row, never on a route.
    expect(resolved.secrets).toEqual({ API_KEY: 'sk-live' })
  })

  it('refuses a name the pack does not ask for, naming the ones it does', () => {
    const resolved = resolvePackInputs([input({ name: 'FLAG' })], { FLAGG: '1' })
    expect(resolved.issues).toEqual([
      { path: 'packInputs.FLAGG', message: 'this pack does not ask for "FLAGG". It asks for: FLAG' },
    ])
    // And it is not silently carried anywhere.
    expect(resolved.values).toEqual({})
  })

  it('refuses any input at all when the pack declares none', () => {
    const resolved = resolvePackInputs(undefined, { FLAG: '1' })
    expect(resolved.issues[0]?.message).toMatch(/asks for no inputs/)
  })

  it('refuses a required input with no value and no default', () => {
    const resolved = resolvePackInputs([input({ name: 'FLAG', label: 'Headless install', required: true })], {})
    expect(resolved.issues).toEqual([
      { path: 'packInputs.FLAG', message: 'Headless install is required by this pack' },
    ])
  })

  it('treats an empty string as no answer at all', () => {
    // An empty value on the box is worse than a missing one: it satisfies a naive `-z` guard
    // and then configures something with nothing, and it defeats the script's own `${FOO:-}`.
    const resolved = resolvePackInputs([input({ name: 'FLAG', required: true })], { FLAG: '' })
    expect(resolved.issues).toHaveLength(1)
    expect(resolvePackInputs([input({ name: 'FLAG' })], { FLAG: '' }).values).toEqual({})
  })

  it('applies a declared default when the request says nothing', () => {
    const declared = [input({ name: 'FLAG', required: true, default: '1' })]
    const resolved = resolvePackInputs(declared, {})
    expect(resolved.issues).toEqual([])
    expect(resolved.values).toEqual({ FLAG: '1' })
  })

  it('lets an explicit value beat the default, including a deliberate override', () => {
    const declared = [input({ name: 'FLAG', default: '1' })]
    expect(resolvePackInputs(declared, { FLAG: '0' }).values).toEqual({ FLAG: '0' })
  })

  it('omits an optional input nobody answered rather than sending it empty', () => {
    expect(resolvePackInputs([input({ name: 'FLAG' })], {}).values).toEqual({})
  })

  it('measures a value in BYTES, not characters', () => {
    // The ceiling is about what a `secrets.env` line and a column carry. `PACK_INPUT_MAX_VALUE_
    // BYTES` characters of a three-byte glyph is three times the documented number, and zod's
    // own `.max()` on a string would have accepted it.
    const wide = '\u3042'.repeat(PACK_INPUT_MAX_VALUE_BYTES / 3 + 1)
    expect(wide.length).toBeLessThan(PACK_INPUT_MAX_VALUE_BYTES)
    expect(resolvePackInputs([input({ name: 'FLAG' })], { FLAG: wide }).issues).toHaveLength(1)
  })

  it('refuses an oversized value, and an oversized total', () => {
    const tooLong = 'x'.repeat(PACK_INPUT_MAX_VALUE_BYTES + 1)
    expect(resolvePackInputs([input({ name: 'FLAG' })], { FLAG: tooLong }).issues).toHaveLength(1)

    const many = Array.from({ length: 12 }, (_, i) => input({ name: `A${i}` }))
    const big = Object.fromEntries(many.map((i) => [i.name, 'x'.repeat(PACK_INPUT_MAX_VALUE_BYTES)]))
    const resolved = resolvePackInputs(many, big)
    expect(resolved.issues.some((i) => i.path === 'packInputs')).toBe(true)
    expect(PACK_INPUTS_MAX_TOTAL_BYTES).toBeLessThan(12 * PACK_INPUT_MAX_VALUE_BYTES)
  })

  it('refuses a multi-line value, whatever the pack said', () => {
    const resolved = resolvePackInputs([input({ name: 'FLAG' })], { FLAG: 'one\ntwo' })
    expect(resolved.issues[0]?.message).toMatch(/single line/)
  })

  it('reports every problem, not the first', () => {
    // A form puts each message on its own field, so a caller with three mistakes must not have
    // to fix and resubmit three times.
    const declared = [input({ name: 'A', required: true }), input({ name: 'B', required: true })]
    const resolved = resolvePackInputs(declared, { C: 'x' })
    expect(resolved.issues.map((i) => i.path).sort()).toEqual(['packInputs.A', 'packInputs.B', 'packInputs.C'])
  })
})

describe('what a browsing operator is shown', () => {
  it('summarises names, labels and flags — and never a value', () => {
    const summary = summarizePackInputs([input({ name: 'FLAG', default: '1' }), input({ name: 'K', secret: true })])
    expect(summary).toEqual([
      { name: 'FLAG', label: 'Headless install', required: false, secret: false },
      { name: 'K', label: 'Headless install', required: false, secret: true },
    ])
    // The `default` is a value, and this list answers "what will I be asked", not "what will
    // be sent". It is deliberately absent.
    expect(JSON.stringify(summary)).not.toContain('default')
  })

  it('is empty, not undefined, for a pack that asks for nothing', () => {
    expect(summarizePackInputs(undefined)).toEqual([])
  })
})
