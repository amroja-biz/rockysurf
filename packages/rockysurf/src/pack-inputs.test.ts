import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PackInput } from '@rockysurf/core'
import { describe, expect, it } from 'vitest'
import {
  collectPackInputs,
  INPUT_ENV_PREFIX,
  parseInputAssignment,
  parseInputsFile,
} from './pack-inputs.js'

/**
 * `rockysurf create --input NAME=VALUE` / `--inputs-file <path>` (issue #189, ADR-0013).
 *
 * The CLI's job is not validation — core does that, and `commands.ts` runs core's own
 * `resolvePackInputs` before the POST so the two cannot disagree. What is tested here is what
 * only this surface can get wrong: reading the flags, reading a file, and refusing to let a
 * credential be typed where `ps` and the shell's history file can read it.
 */

const declared = (over: Partial<PackInput> = {}): PackInput => ({
  name: 'HEADLONG_HEADLESS',
  label: 'Headless install',
  required: false,
  secret: false,
  ...over,
})

const write = (text: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'rockysurf-inputs-')), 'inputs.env')
  writeFileSync(path, text)
  return path
}

describe('parsing one --input assignment', () => {
  it('splits on the FIRST equals, so a base64 value survives', () => {
    // Splitting on all of them would corrupt exactly the values people pass this flag for.
    expect(parseInputAssignment('K=abc==')).toEqual({ name: 'K', value: 'abc==' })
    expect(parseInputAssignment('URL=https://x.test/?a=1&b=2')).toEqual({
      name: 'URL',
      value: 'https://x.test/?a=1&b=2',
    })
  })

  it('accepts an empty value, which is a thing a caller may mean', () => {
    expect(parseInputAssignment('K=')).toEqual({ name: 'K', value: '' })
  })

  it('refuses a flag with no equals, and one with no name', () => {
    expect(parseInputAssignment('HEADLESS')).toHaveProperty('refusal')
    expect(parseInputAssignment('=1')).toHaveProperty('refusal')
  })
})

describe('parsing an --inputs-file', () => {
  it('reads NAME=VALUE lines, skipping blanks and comments', () => {
    const parsed = parseInputsFile('# a comment\n\nA=1\n  B = two  \n')
    expect(parsed).toEqual({ values: { A: '1', B: 'two' } })
  })

  it('strips ONE matched layer of quotes and nothing else', () => {
    expect(parseInputsFile('A="one two"\nB=\'x\'\nC="unbalanced\n')).toEqual({
      values: { A: 'one two', B: 'x', C: '"unbalanced' },
    })
  })

  it('does not expand a variable or run a substitution', () => {
    // The file exists precisely so a value never meets a shell. A parser that interpolated
    // would put the shell back at the one point this avoids it.
    expect(parseInputsFile('A=$HOME\nB=$(id -u)\n')).toEqual({ values: { A: '$HOME', B: '$(id -u)' } })
  })

  it('refuses a line that is not an assignment, naming the line number', () => {
    const parsed = parseInputsFile('A=1\nnonsense\n')
    expect(parsed).toHaveProperty('refusal')
    expect((parsed as { refusal: string }).refusal).toMatch(/line 2/)
  })
})

describe('collecting from the three sources', () => {
  it('lets a flag beat the file, and the file beat the environment', () => {
    const path = write('A=from-file\nB=from-file\n')
    const collected = collectPackInputs(
      { inputs: ['A=from-flag'], inputsFile: path },
      [declared({ name: 'A' }), declared({ name: 'B' }), declared({ name: 'C' })],
      { [`${INPUT_ENV_PREFIX}A`]: 'from-env', [`${INPUT_ENV_PREFIX}C`]: 'from-env' },
    )
    expect(collected.values).toEqual({ A: 'from-flag', B: 'from-file', C: 'from-env' })
  })

  it('reads the environment only for names the pack declared', () => {
    // The environment is ambient; picking names out of it that nobody asked for would send
    // core a request it is obliged to refuse.
    const collected = collectPackInputs({}, [declared({ name: 'A' })], {
      [`${INPUT_ENV_PREFIX}A`]: '1',
      [`${INPUT_ENV_PREFIX}UNDECLARED`]: '2',
    })
    expect(collected.values).toEqual({ A: '1' })
  })

  it('refuses a SECRET value given on the command line, and says where to put it instead', () => {
    // The same ruling `--rdp-password <value>` gets: by the time a warning could print, the
    // value is in the shell's history file and has been readable in `ps`.
    const collected = collectPackInputs({ inputs: ['API_KEY=sk-live'] }, [
      declared({ name: 'API_KEY', secret: true }),
    ], {})
    expect(collected.refusal).toMatch(/will not accept one that way/)
    expect(collected.refusal).toMatch(/--inputs-file/)
    expect(collected.refusal).toMatch(new RegExp(`${INPUT_ENV_PREFIX}API_KEY`))
    // The value is not carried one call deeper than it has to be.
    expect(collected.values['API_KEY']).toBeUndefined()
  })

  it('takes the same secret from a file or the environment without complaint', () => {
    const path = write('API_KEY=sk-live\n')
    expect(collectPackInputs({ inputsFile: path }, [declared({ name: 'API_KEY', secret: true })], {})).toEqual({
      values: { API_KEY: 'sk-live' },
    })
    expect(
      collectPackInputs({}, [declared({ name: 'API_KEY', secret: true })], {
        [`${INPUT_ENV_PREFIX}API_KEY`]: 'sk-live',
      }),
    ).toEqual({ values: { API_KEY: 'sk-live' } })
  })

  it('checks nothing when the declaration could not be fetched, and sends what it was given', () => {
    // Core is the authority; an unreachable pack list must not block a create. Note that a
    // secret cannot be recognised here either — which is stated in `collectPackInputs`.
    expect(collectPackInputs({ inputs: ['ANY=1'] }, undefined, {})).toEqual({ values: { ANY: '1' } })
  })

  it('refuses an unreadable --inputs-file by name rather than throwing an ENOENT', () => {
    const collected = collectPackInputs({ inputsFile: '/no/such/file.env' }, [], {})
    expect(collected.refusal).toMatch(/--inputs-file \/no\/such\/file\.env/)
  })

  it('sends nothing when nothing was given', () => {
    expect(collectPackInputs({}, [declared()], {})).toEqual({ values: {} })
  })
})
