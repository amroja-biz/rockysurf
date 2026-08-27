import { describe, expect, it } from 'vitest'
import { parseEnvironment } from './environment'

/**
 * The Environment textarea's format (issue #197, ADR-0014).
 *
 * The same text `rockysurf create --env-file` reads, which is the reason the marker is part of
 * the line rather than a checkbox beside it: a person can move an environment between the form
 * and the CLI without translating it.
 *
 * Core re-checks every name and value; what is pinned here is the READING of the text — where a
 * value starts, what a marker means, and which mistakes are worth a sentence before the request
 * goes out.
 */
describe('reading the environment textarea', () => {
  it('reads KEY=value lines', () => {
    expect(parseEnvironment('MY_FLAG=1\nMY_ENDPOINT=https://x').entries).toEqual({
      MY_FLAG: { value: '1' },
      MY_ENDPOINT: { value: 'https://x' },
    })
  })

  it('is empty for an empty box', () => {
    expect(parseEnvironment('')).toEqual({ entries: {}, errors: [] })
    expect(parseEnvironment('\n\n   \n')).toEqual({ entries: {}, errors: [] })
  })

  it('marks a secret: line and leaves the rest plain', () => {
    const { entries } = parseEnvironment('secret:MY_TOKEN=ghp-x\nMY_FLAG=1')
    expect(entries['MY_TOKEN']).toEqual({ value: 'ghp-x', secret: true })
    // Absent rather than `secret: false`, so the wire carries the flag only where it means
    // something.
    expect(entries['MY_FLAG']).toEqual({ value: '1' })
  })

  it('splits on the FIRST = only, so a base64 value survives', () => {
    expect(parseEnvironment('MY_KEY=abc==').entries['MY_KEY']).toEqual({ value: 'abc==' })
    expect(parseEnvironment('MY_URL=https://x?a=b&c=d').entries['MY_URL']).toEqual({ value: 'https://x?a=b&c=d' })
  })

  it('skips comments and blank lines', () => {
    expect(parseEnvironment('# a note\n\nMY_FLAG=1\n  # indented\n').entries).toEqual({ MY_FLAG: { value: '1' } })
  })

  it('strips one matching layer of quotes and nothing else', () => {
    expect(parseEnvironment('A="two words"').entries['A']).toEqual({ value: 'two words' })
    expect(parseEnvironment("B='two words'").entries['B']).toEqual({ value: 'two words' })
    // One end only is far more likely to be a value containing a quote than a typo.
    expect(parseEnvironment('C="unbalanced').entries['C']).toEqual({ value: '"unbalanced' })
  })

  it('expands and runs nothing', () => {
    // This text is bound for a file whose whole purpose is to carry values a shell must never
    // interpret, so a parser that expanded would reintroduce the shell at the one point the
    // file exists to avoid.
    expect(parseEnvironment('A=$(id -u)').entries['A']).toEqual({ value: '$(id -u)' })
    expect(parseEnvironment('B=${HOME}').entries['B']).toEqual({ value: '${HOME}' })
  })

  it('refuses a line with no =, naming the line number', () => {
    const { entries, errors } = parseEnvironment('MY_FLAG=1\nnonsense')
    expect(errors).toEqual(['Line 2 is not KEY=value: nonsense'])
    // The good line is still read: the submit is blocked by the error, not by discarding
    // everything the user typed.
    expect(entries).toEqual({ MY_FLAG: { value: '1' } })
  })

  it('refuses a name given twice rather than letting the last one win', () => {
    // Both lines are visible in the box the user is looking at, and only one of them would ever
    // reach the machine.
    const { errors } = parseEnvironment('MY_FLAG=1\nMY_FLAG=2')
    expect(errors).toEqual(['Line 2 sets MY_FLAG again — one name, one line'])
  })

  it('accepts a value that is deliberately empty', () => {
    // A line the user typed as `FOO=` can only mean "set FOO, empty".
    expect(parseEnvironment('MY_FLAG=').entries['MY_FLAG']).toEqual({ value: '' })
  })
})
