import { describe, expect, it } from 'vitest'
import { SETUP_GIT_AUTH_PREAMBLE } from '../bootstrap/resolver.js'
import { SECRET_ENV_KEY_NAMES } from '../bootstrap/server-secrets.js'
import {
  ENV_TOTAL_MAX_BYTES,
  ENV_VALUE_MAX_BYTES,
  RESERVED_ENV_NAMES,
  RESERVED_ENV_PREFIXES,
  envVarNameSchema,
  envVarValueSchema,
} from './names.js'

/**
 * The one list of names nothing supplied at create time may claim, and the rules a supplied
 * name and value satisfy (issues #189, #197).
 *
 * These used to live in `packs/schema.ts`, where a pack's `inputs` were the only thing that
 * could contribute a variable. They are tested here now because two features consult them —
 * a pack's declaration and a user's own Environment — and a rule that held for one and not the
 * other would be a rule about paperwork rather than about what survives on the box.
 */

describe('a supplied environment variable name', () => {
  it('is UPPER_SNAKE_CASE, starting with a letter', () => {
    for (const name of ['A', 'FOO', 'FOO_BAR_2', 'X9']) {
      expect(envVarNameSchema.safeParse(name).success, name).toBe(true)
    }
    for (const name of ['', 'foo', 'Foo', '9FOO', '_FOO', 'FOO-BAR', 'FOO BAR', 'FOO.BAR', 'FÖÖ']) {
      expect(envVarNameSchema.safeParse(name).success, name).toBe(false)
    }
  })

  it('is at most 64 characters', () => {
    expect(envVarNameSchema.safeParse('A'.repeat(64)).success).toBe(true)
    expect(envVarNameSchema.safeParse('A'.repeat(65)).success).toBe(false)
  })

  it('is never one Rocky Surf already exports to every step', () => {
    // The whole reserved list, so adding a name to it without a test is not possible.
    for (const name of RESERVED_ENV_NAMES) {
      expect(envVarNameSchema.safeParse(name).success, name).toBe(false)
    }
  })

  it('is never inside a namespace Rocky Surf generates with an index', () => {
    for (const prefix of RESERVED_ENV_PREFIXES) {
      expect(envVarNameSchema.safeParse(`${prefix}ANYTHING`).success, prefix).toBe(false)
    }
    expect(envVarNameSchema.safeParse('ROCKYSURF_GITHUB_TOKEN_3').success).toBe(false)
    expect(envVarNameSchema.safeParse('GIT_CONFIG_KEY_0').success).toBe(false)
    expect(envVarNameSchema.safeParse('GIT_CONFIG_VALUE_0').success).toBe(false)
  })

  /*
   * THE NARROWED GIT RESERVATION (issue #197).
   *
   * `GIT_` was refused as a whole prefix, which cost a user `GIT_AUTHOR_NAME` and every other
   * name git reads but Rocky Surf never writes — four variables' worth of protection charged to
   * the entire namespace.
   */
  it('accepts the GIT_ names Rocky Surf does not write', () => {
    for (const name of [
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_NAME',
      'GIT_SSH_COMMAND',
      'GIT_PAGER',
      'GITHUB_ORG',
    ]) {
      expect(envVarNameSchema.safeParse(name).success, name).toBe(true)
    }
  })

  /*
   * THE DRIFT GUARD, and the reason the narrowing is safe to make.
   *
   * Every variable the real setup preamble exports is read out of the preamble itself and
   * asserted unclaimable. A fifth `GIT_*` name added to `resolver.ts` without being reserved
   * fails here rather than on somebody's box, which is precisely the risk of replacing a prefix
   * with a list.
   */
  it('refuses every name the real setup preamble exports', () => {
    const exported = SETUP_GIT_AUTH_PREAMBLE.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('export '))
      .flatMap((line) => [...line.slice('export '.length).matchAll(/(?:^|\s)([A-Z][A-Z0-9_]*)=/g)])
      .map((match) => match[1]!)

    expect(exported).toContain('GIT_TERMINAL_PROMPT')
    expect(exported.length).toBeGreaterThanOrEqual(5)
    for (const name of exported) {
      expect(envVarNameSchema.safeParse(name).success, name).toBe(false)
    }
  })

  /*
   * `SECRET_ENV_KEYS` is the closed set of names the platform promises pack authors. Every one
   * must be unclaimable, or a pack — or a user — could set `GITHUB_TOKEN` and the box would
   * read whichever of the two the loader happened to write last.
   */
  it('refuses every name the secrets.env contract promises', () => {
    for (const name of SECRET_ENV_KEY_NAMES) expect(RESERVED_ENV_NAMES.has(name), name).toBe(true)
  })
})

describe('a supplied environment variable value', () => {
  it('is measured in bytes, not characters', () => {
    // Three-byte glyphs: comfortably under the ceiling by length and over it by weight, which
    // is the distinction the `secrets.env` line and the database column actually care about.
    const wide = 'あ'.repeat(ENV_VALUE_MAX_BYTES / 3 + 1)
    expect(wide.length).toBeLessThan(ENV_VALUE_MAX_BYTES)
    expect(envVarValueSchema.safeParse(wide).success).toBe(false)
    expect(envVarValueSchema.safeParse('x'.repeat(ENV_VALUE_MAX_BYTES)).success).toBe(true)
    expect(envVarValueSchema.safeParse('x'.repeat(ENV_VALUE_MAX_BYTES + 1)).success).toBe(false)
  })

  it('is one line, because the agent re-reads the file line by line for names', () => {
    for (const value of ['a\nb', 'a\rb', '\n']) {
      expect(envVarValueSchema.safeParse(value).success, JSON.stringify(value)).toBe(false)
    }
    // Everything quoting CAN make safe is accepted — refusing these would refuse values people
    // legitimately have (ADR-0013 option G).
    for (const value of ['', 'a b', '$(id -u)', '`id`', "it's", 'https://x/y?a=b&c=d']) {
      expect(envVarValueSchema.safeParse(value).success, value).toBe(true)
    }
  })

  it('bounds a whole environment well above one value and well below anything that matters', () => {
    expect(ENV_TOTAL_MAX_BYTES).toBeGreaterThan(ENV_VALUE_MAX_BYTES)
    expect(ENV_TOTAL_MAX_BYTES).toBeLessThan(12 * ENV_VALUE_MAX_BYTES)
  })
})
