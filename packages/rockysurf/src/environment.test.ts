import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectEnvironment, parseEnvAssignment, parseEnvFile, SECRET_LINE_PREFIX } from './environment.js'

/**
 * `rockysurf create --env [secret:]KEY=VALUE` / `--env-file <path>` (issue #197, ADR-0014).
 *
 * The CLI's job is not validation — core validates every name and value at the create route,
 * and `commands.ts` runs core's own `resolveServerEnvironment` before the POST so the two
 * cannot disagree. What is tested here is what only this surface can get wrong: reading a flag,
 * reading a file in the same format the create form's box takes, and refusing to let a
 * credential be typed where `ps` and the shell's history file can read it.
 */

const write = (text: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'rockysurf-env-')), 'env.txt')
  writeFileSync(path, text)
  return path
}

describe('parsing one --env assignment', () => {
  it('splits on the FIRST equals, so a base64 value survives', () => {
    expect(parseEnvAssignment('K=abc==')).toEqual({ name: 'K', entry: { value: 'abc==' } })
    expect(parseEnvAssignment('URL=https://x.test/?a=1&b=2')).toEqual({
      name: 'URL',
      entry: { value: 'https://x.test/?a=1&b=2' },
    })
  })

  it('reads the secret: marker off the front of the line', () => {
    expect(parseEnvAssignment(`${SECRET_LINE_PREFIX}TOKEN=ghp-x`)).toEqual({
      name: 'TOKEN',
      entry: { value: 'ghp-x', secret: true },
    })
  })

  it('accepts an empty value, which is a thing a caller may mean', () => {
    expect(parseEnvAssignment('K=')).toEqual({ name: 'K', entry: { value: '' } })
  })

  it('refuses a flag with no equals, and one with no name', () => {
    expect(parseEnvAssignment('nonsense')).toEqual({
      refusal: expect.stringContaining('is not KEY=VALUE') as string,
    })
    expect('refusal' in parseEnvAssignment('=value')).toBe(true)
  })
})

describe('parsing an --env-file', () => {
  it('reads the same text the create form takes', () => {
    const parsed = parseEnvFile('# a note\n\nMY_FLAG=1\nsecret:MY_TOKEN=ghp-x\n')
    expect(parsed).toEqual({ entries: { MY_FLAG: { value: '1' }, MY_TOKEN: { value: 'ghp-x', secret: true } } })
  })

  it('strips one matching layer of quotes and expands nothing', () => {
    // A parser that interpolated would reintroduce the shell at the one point this file exists
    // to avoid.
    expect(parseEnvFile('A="two words"\nB=$(id -u)\nC=${HOME}')).toEqual({
      entries: { A: { value: 'two words' }, B: { value: '$(id -u)' }, C: { value: '${HOME}' } },
    })
  })

  it('refuses a bad line by number, rather than skipping it', () => {
    expect(parseEnvFile('A=1\nnonsense\n')).toEqual({ refusal: 'line 2 is not KEY=VALUE: nonsense' })
  })

  it('refuses a name written twice', () => {
    expect(parseEnvFile('A=1\nA=2\n')).toEqual({ refusal: expect.stringContaining('sets A again') as string })
  })
})

describe('collecting the environment from both sources', () => {
  it('lets a flag beat the file, because it is this invocation', () => {
    const path = write('A=from-file\nB=only-file\n')
    expect(collectEnvironment({ envFile: path, env: ['A=from-flag'] }).entries).toEqual({
      A: { value: 'from-flag' },
      B: { value: 'only-file' },
    })
  })

  it('refuses a secret value on the command line, and says where it belongs', () => {
    const result = collectEnvironment({ env: [`${SECRET_LINE_PREFIX}MY_TOKEN=ghp-do-not-leak`] })
    expect(result.refusal).toContain('--env-file')
    expect(result.refusal).toContain('MY_TOKEN')
    // The refusal must not echo the thing it is refusing to let you type.
    expect(result.refusal).not.toContain('ghp-do-not-leak')
    expect(result.entries['MY_TOKEN']).toBeUndefined()
  })

  it('accepts a secret from a file, which is the way out the refusal names', () => {
    const path = write(`${SECRET_LINE_PREFIX}MY_TOKEN=ghp-x\n`)
    expect(collectEnvironment({ envFile: path }).entries).toEqual({ MY_TOKEN: { value: 'ghp-x', secret: true } })
  })

  it('names an unreadable file rather than failing silently', () => {
    const result = collectEnvironment({ envFile: '/nonexistent/env.txt' })
    expect(result.refusal).toContain('/nonexistent/env.txt')
  })

  it('collects nothing when neither flag is given', () => {
    expect(collectEnvironment({})).toEqual({ entries: {} })
  })
})
