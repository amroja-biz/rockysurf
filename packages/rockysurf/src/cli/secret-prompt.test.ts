import { afterEach, describe, expect, it } from 'vitest'
import { ttySecretPrompt } from './secret-prompt.js'

/**
 * The terminal half of the desktop-password path (rockysurf-kvkr).
 *
 * WHAT IS TESTED HERE is the branch `commands.ts` depends on: whether a prompt exists at all.
 * `undefined` is not a detail — it is what makes `rockysurf create` say "no terminal is
 * attached, use the environment variable" instead of hanging on a pipe forever, which is the
 * failure mode of every CLI that calls `readline` without checking first.
 *
 * The reading itself is driven in a real pty rather than here, because raw mode, echo
 * suppression and backspace are properties of a terminal and a fake stream proves none of them.
 * See the bead for that run.
 */

const originals = ['isTTY', 'setRawMode'].map(
  (key) => [key, Object.getOwnPropertyDescriptor(process.stdin, key)] as const,
)

/** vitest's own stdin is neither, so both are stubbed rather than assumed either way. */
function stdinLooksLike(isTTY: boolean, setRawMode: unknown) {
  Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true })
  Object.defineProperty(process.stdin, 'setRawMode', { value: setRawMode, configurable: true })
}

afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(process.stdin, key, descriptor)
    else delete (process.stdin as unknown as Record<string, unknown>)[key]
  }
})

describe('ttySecretPrompt', () => {
  it('offers no prompt when nothing is reading a terminal', () => {
    stdinLooksLike(false, () => {})
    // A pipe, a CI job, an editor's task runner: there is nobody to type, and the caller has a
    // better answer than a prompt nothing will ever satisfy.
    expect(ttySecretPrompt()).toBeUndefined()
  })

  it('offers no prompt when the echo cannot be turned off', () => {
    // A stream can claim to be a terminal without offering raw mode. Prompting there would
    // print the password to the screen, which is worse than refusing.
    stdinLooksLike(true, undefined)
    expect(ttySecretPrompt()).toBeUndefined()
  })

  it('offers one when there is a terminal', () => {
    stdinLooksLike(true, () => {})
    expect(typeof ttySecretPrompt()).toBe('function')
  })
})
