import { describe, expect, it } from 'vitest'
import { ENV_VAR_ONLY, envVarDisplay, envVarName, envVarReference } from './envRef'

/**
 * THE ROUND TRIP IS THE WHOLE CONTRACT (rockysurf-4o3o).
 *
 * The file says `${GITHUB_PAT}` and the box says `GITHUB_PAT`; whatever the box says next has to
 * arrive back in the file with its braces on. A value that changed shape on the way through would
 * either write a name the interpolation cannot expand — a boot error the operator did not cause —
 * or double the braces into a reference to a variable nobody exported.
 */

describe('what a token box accepts', () => {
  it('takes the bare name, which is what the label asks for', () => {
    expect(envVarName('GITHUB_PAT')).toBe('GITHUB_PAT')
    expect(envVarReference('GITHUB_PAT')).toBe('${GITHUB_PAT}')
  })

  it('takes the ${...} form too, because copying the line out of the file is the obvious move', () => {
    expect(envVarName('${WIDGETS_PAT}')).toBe('WIDGETS_PAT')
    expect(envVarReference('${WIDGETS_PAT}')).toBe('${WIDGETS_PAT}')
  })

  it('ignores surrounding whitespace rather than refusing over a character nobody can see', () => {
    expect(envVarReference('  WIDGETS_PAT  ')).toBe('${WIDGETS_PAT}')
    expect(envVarReference(' ${WIDGETS_PAT} ')).toBe('${WIDGETS_PAT}')
  })

  it('accepts the whole POSIX-ish alphabet, including the names nobody writes in capitals', () => {
    for (const name of ['_', '_x', 'a', 'Token9', 'GITHUB_PAT_2']) {
      expect(envVarName(name), `${name} is a legal variable name`).toBe(name)
    }
  })
})

describe('what a token box refuses', () => {
  it('refuses anything that is not a variable name', () => {
    // The shapes a pasted credential actually arrives in: dashes, dots, slashes, colons, spaces.
    for (const typed of ['ghp-live-abc', 'tok.live.1', 'a/b', 'Bearer abc', 'two words', '9LEADING']) {
      expect(envVarName(typed), `${typed} is not a variable name`).toBeNull()
      expect(envVarReference(typed)).toBeNull()
    }
  })

  it('refuses a half-interpolated value, which is a literal with a variable in it', () => {
    expect(envVarName('tok_live_${SUFFIX}')).toBeNull()
    expect(envVarName('${A}${B}')).toBeNull()
    expect(envVarName('$${ESCAPED}')).toBeNull()
    expect(envVarName('${}')).toBeNull()
  })

  it('refuses an empty box, so nothing can be normalised into a reference to nothing', () => {
    expect(envVarName('')).toBeNull()
    expect(envVarName('   ')).toBeNull()
  })

  it('says why, in a sentence naming the policy and the reason for it', () => {
    expect(ENV_VAR_ONLY).toContain('NAME of an environment variable')
    expect(ENV_VAR_ONLY).toContain('holds only the reference')
    expect(ENV_VAR_ONLY).toContain('${GITHUB_PAT}')
  })

  /**
   * The limitation, pinned so it is a known property rather than a surprise. A GitHub token is
   * shaped like a legal variable name, and no syntactic rule can tell them apart — see the note
   * in `envRef.ts` for why a guess over values would be worse than admitting this.
   */
  it('cannot tell a token that happens to be a legal variable name from a variable name', () => {
    expect(envVarName('ghp_A1b2c3')).toBe('ghp_A1b2c3')
  })
})

describe('what a token box displays', () => {
  it('shows a reference from the file as its bare name', () => {
    expect(envVarDisplay('${GITHUB_PAT}')).toBe('GITHUB_PAT')
  })

  it('shows anything else exactly as the file wrote it, because this editor repairs such files', () => {
    expect(envVarDisplay('tok_live_${SUFFIX}')).toBe('tok_live_${SUFFIX}')
  })
})
