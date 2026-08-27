import { describe, expect, it } from 'vitest'
import { ENV_TOTAL_MAX_BYTES, ENV_VALUE_MAX_BYTES } from '../env/names.js'
import type { PackInput } from '../packs/schema.js'
import { ENVIRONMENT_MAX_ENTRIES, resolveServerEnvironment } from './environment.js'

/**
 * The user's own Environment, resolved against nothing but the rules and the pack's declared
 * names (issue #197, ADR-0014).
 *
 * The counterpart of `packs/inputs.test.ts`. The interesting cases are the ones where this
 * DIFFERS from pack inputs, because the sameness is carried by shared code: there is no
 * declaration to check a name against, an empty value is a real answer, and a name the pack
 * already asks for is a refusal rather than a merge.
 */

const declare = (name: string, over: Partial<PackInput> = {}): PackInput => ({
  name,
  label: name,
  required: false,
  secret: false,
  ...over,
})

describe('resolving the environment a create request carried', () => {
  it('splits the values by custody, which is the whole point of doing it here', () => {
    const resolved = resolveServerEnvironment(
      { ENDPOINT: { value: 'https://x' }, API_KEY: { value: 'sk-live', secret: true } },
      undefined,
    )
    expect(resolved.issues).toEqual([])
    expect(resolved.values).toEqual({ ENDPOINT: 'https://x' })
    expect(resolved.secrets).toEqual({ API_KEY: 'sk-live' })
  })

  it('treats an absent field and an empty object identically', () => {
    for (const submitted of [undefined, {}]) {
      const resolved = resolveServerEnvironment(submitted, [declare('FLAG')])
      expect(resolved).toEqual({ values: {}, secrets: {}, issues: [] })
    }
  })

  it('accepts any name the rules allow, because nothing declares this field', () => {
    // The opposite of a pack input, where an undeclared name is refused. Here the whole point
    // is the value the pack never thought of.
    const resolved = resolveServerEnvironment({ ANYTHING_AT_ALL: { value: '1' } }, [declare('FLAG')])
    expect(resolved.issues).toEqual([])
    expect(resolved.values).toEqual({ ANYTHING_AT_ALL: '1' })
  })

  it('keeps an empty value, because the user wrote the line', () => {
    // A pack input left blank is omitted so the pack's own `${FOO:-}` default can fire. A line
    // the user typed as `FOO=` can only mean "set FOO, empty" — dropping it would make what
    // they typed do nothing.
    const resolved = resolveServerEnvironment({ FOO: { value: '' } }, undefined)
    expect(resolved.issues).toEqual([])
    expect(resolved.values).toEqual({ FOO: '' })
  })

  it('refuses a name Rocky Surf exports, naming it', () => {
    const resolved = resolveServerEnvironment({ HOME: { value: '/tmp' } }, undefined)
    expect(resolved.issues).toHaveLength(1)
    expect(resolved.issues[0]!.path).toBe('environment.HOME')
    expect(resolved.issues[0]!.message).toContain('HOME')
    expect(resolved.values).toEqual({})
  })

  it('accepts GIT_AUTHOR_NAME and still refuses GIT_CONFIG_COUNT (issue #197)', () => {
    expect(resolveServerEnvironment({ GIT_AUTHOR_NAME: { value: 'Ada' } }, undefined).issues).toEqual([])
    expect(resolveServerEnvironment({ GIT_CONFIG_COUNT: { value: '9' } }, undefined).issues).toHaveLength(1)
  })

  it('refuses a lower-case or otherwise malformed name', () => {
    const resolved = resolveServerEnvironment({ 'my key': { value: '1' } }, undefined)
    expect(resolved.issues).toHaveLength(1)
    expect(resolved.issues[0]!.message).toContain('my key')
  })

  /*
   * THE COLLISION (issue #197). The one thing the pack's declaration is consulted for.
   */
  it('refuses a name the pack already asks for, and says which field to use', () => {
    const resolved = resolveServerEnvironment({ HEADLONG_API_KEY: { value: 'sk', secret: true } }, [
      declare('HEADLONG_API_KEY', { secret: true }),
    ])
    expect(resolved.issues).toHaveLength(1)
    expect(resolved.issues[0]!.message).toContain('HEADLONG_API_KEY')
    expect(resolved.issues[0]!.message).toMatch(/pack/i)
    expect(resolved.secrets).toEqual({})
  })

  it('refuses the collision even when the pack input was left blank', () => {
    // The pack owns the name on this box whether or not the optional field was answered: the
    // form shows a field for it and the pack's guide talks about it, so a second field quietly
    // writing the same variable would be indistinguishable from a bug.
    const resolved = resolveServerEnvironment({ FLAG: { value: '1' } }, [declare('FLAG')])
    expect(resolved.issues).toHaveLength(1)
  })

  it('reports every problem rather than the first, so a form can mark each line', () => {
    const resolved = resolveServerEnvironment(
      { HOME: { value: '/tmp' }, lower: { value: '1' }, FLAG: { value: '1' }, FINE: { value: 'ok' } },
      [declare('FLAG')],
    )
    expect(resolved.issues).toHaveLength(3)
    // The good line survives: a refusal is per key, and the request is refused as a whole by
    // the route rather than by discarding everything here.
    expect(resolved.values).toEqual({ FINE: 'ok' })
  })

  it('refuses a multi-line value, which secrets.env cannot carry', () => {
    const resolved = resolveServerEnvironment({ KEY: { value: 'line one\nline two' } }, undefined)
    expect(resolved.issues).toHaveLength(1)
    expect(resolved.issues[0]!.message).toContain('single line')
  })

  it('bounds one value and the whole environment', () => {
    const tooBig = resolveServerEnvironment({ KEY: { value: 'x'.repeat(ENV_VALUE_MAX_BYTES + 1) } }, undefined)
    expect(tooBig.issues).toHaveLength(1)

    const many = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`K${i}`, { value: 'x'.repeat(ENV_VALUE_MAX_BYTES) }]),
    )
    const heavy = resolveServerEnvironment(many, undefined)
    expect(heavy.issues.some((issue) => issue.path === 'environment')).toBe(true)
    expect(8 * ENV_VALUE_MAX_BYTES).toBeGreaterThan(ENV_TOTAL_MAX_BYTES)
  })

  it('refuses a runaway paste by counting before it validates', () => {
    const many = Object.fromEntries(
      Array.from({ length: ENVIRONMENT_MAX_ENTRIES + 1 }, (_, i) => [`K${i}`, { value: '1' }]),
    )
    const resolved = resolveServerEnvironment(many, undefined)
    expect(resolved.issues).toHaveLength(1)
    expect(resolved.issues[0]!.path).toBe('environment')
    expect(resolved.values).toEqual({})
  })
})
