import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  describeScope,
  newScopedEntry,
  refuseNewEntry,
  scopeChanges,
  scopeTextOf,
  unifiedTokens,
} from './githubTokens'

/**
 * THE MAPPING SEAM, on its own (rockysurf-5qzg, directive 2).
 *
 * The page shows one list of access tokens; the file holds `github.pat` and `github.tokens[]`.
 * This is the whole of the translation between them, and it is tested here rather than only
 * through the DOM because the property that matters is arithmetic: every change it emits names
 * a path the config file already had, so the schema, the route and the credential helper on the
 * box never learn that the page drew one list.
 */

const secret = (state: 'set' | 'unset') => ({ secret: true as const, state })

describe('the unified list', () => {
  it('puts the fallback first, whether or not a token is set', () => {
    const entries = unifiedTokens({ github: { tokens: [] } })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.target).toEqual({ kind: 'fallback' })
    expect(entries[0]!.secret.state).toBe('unset')
    expect(describeScope(entries[0]!.scope, entries[0]!.host, entries[0]!.target)).toBe(
      'All repositories (fallback)',
    )
  })

  it('shows github.pat as an entry of the same list, not a separate kind of setting', () => {
    const entries = unifiedTokens({ github: { pat: secret('set'), tokens: [] } })
    expect(entries[0]!.secret.state).toBe('set')
  })

  it('renders both ways of writing a scoped entry as the same text', () => {
    // The one-string form (rockysurf-ly2n) and the split form are the same entry, so the scope
    // box cannot tell them apart either.
    const entries = unifiedTokens({
      github: {
        tokens: [
          { repo: 'acme/widgets', pat: secret('set') },
          { owner: 'acme', repo: 'widgets', pat: secret('set') },
        ],
      },
    })
    expect(entries[1]!.scope).toBe('acme/widgets')
    expect(entries[2]!.scope).toBe('acme/widgets')
  })

  it('names an account-wide and a forge-wide entry the way an operator would', () => {
    const entries = unifiedTokens({
      github: {
        tokens: [
          { owner: 'acme', pat: secret('set') },
          { host: 'git.example.com', pat: secret('set') },
        ],
      },
    })
    expect(describeScope(entries[1]!.scope, entries[1]!.host, entries[1]!.target)).toBe('acme')
    expect(describeScope(entries[2]!.scope, entries[2]!.host, entries[2]!.target)).toBe(
      'Everything on git.example.com',
    )
  })

  it('survives a file that is not valid, which is the file this editor exists to repair', () => {
    // `repo` with no `owner` is refused by the schema. Showing it as written is what lets the
    // operator see the thing they have to fix.
    expect(scopeTextOf({ repo: 'widgets' })).toBe('widgets')
    expect(unifiedTokens({})).toHaveLength(1)
    expect(unifiedTokens({ github: { tokens: 'nonsense' } })).toHaveLength(1)
  })
})

describe('what a scope box writes back', () => {
  it('writes one repository in the one-string form, and takes the owner key away', () => {
    // Both spellings at once is the one thing the schema will not read: it cannot know which
    // owner was meant, so the page does not offer it the chance to guess.
    expect(scopeChanges(0, 'acme/widgets', { owner: 'acme', repo: 'widgets' })).toEqual([
      { path: ['github', 'tokens', 0, 'owner'], unset: true },
      { path: ['github', 'tokens', 0, 'repo'], value: 'acme/widgets' },
    ])
  })

  it('writes an account on its own as an owner, and removes the repository', () => {
    expect(scopeChanges(1, 'acme', { repo: 'acme/widgets' })).toEqual([
      { path: ['github', 'tokens', 1, 'owner'], value: 'acme' },
      { path: ['github', 'tokens', 1, 'repo'], unset: true },
    ])
  })

  it('emits no unset for a key the entry does not have, so a save adds no empty lines', () => {
    expect(scopeChanges(0, 'acme', {})).toEqual([{ path: ['github', 'tokens', 0, 'owner'], value: 'acme' }])
    expect(scopeChanges(0, '', {})).toEqual([])
  })

  it('clears both halves when the scope is emptied, leaving a host-only entry', () => {
    expect(scopeChanges(2, '  ', { owner: 'acme', host: 'git.example.com' })).toEqual([
      { path: ['github', 'tokens', 2, 'owner'], unset: true },
    ])
  })
})

describe('a new entry', () => {
  it('is one object, so a scope without a token never reaches the file', () => {
    expect(newScopedEntry('acme/widgets', '', '${ACME_PAT}')).toEqual({
      repo: 'acme/widgets',
      pat: '${ACME_PAT}',
    })
    expect(newScopedEntry('acme', 'git.example.com', 'ghp_x')).toEqual({
      host: 'git.example.com',
      owner: 'acme',
      pat: 'ghp_x',
    })
  })

  it('refuses a second entry with no scope, because there is one github.pat', () => {
    const refusal = refuseNewEntry('', '', 'ghp_x', true)
    expect(refusal).toContain('already a token with no scope')
    // And it is allowed when the fallback is empty — that is how the fallback gets filled in.
    expect(refuseNewEntry('', '', 'ghp_x', false)).toBeNull()
  })

  it('refuses an entry with no token, in words rather than as a schema error', () => {
    expect(refuseNewEntry('acme/widgets', '', '   ', false)).toContain('A token is required')
  })

  it('leaves everything else to the schema, which says it better', () => {
    // A scope with a space in it, or a duplicate of an existing entry: both refused server-side,
    // in the schema's own words, rather than restated here where they could drift.
    expect(refuseNewEntry('acme widgets', '', 'ghp_x', true)).toBeNull()
  })
})

/**
 * THE AUTHORITY SEAM, pinned (rockysurf-18lq).
 *
 * This module is where a second implementation of the precedence rules would most plausibly
 * appear: it already knows about scopes, hosts and the fallback, and adding "which of these
 * covers github.com/acme/widgets" to it would feel like a small step. It is not one. The rules
 * live in the shell credential helper (`bootstrap/resolver.ts`), which decides, and in
 * `core/src/git/token-matching.ts`, which predicts and is pinned to the shell differentially.
 * The create screen's live display is a third CONSUMER of the second, over an HTTP endpoint —
 * never a third implementation, because two of them drifting is a screen that confidently
 * describes a box that does not exist.
 *
 * So this asserts what the module is FOR: rendering and editing the settings list, and nothing
 * that answers "which token wins".
 */
describe('what this module is deliberately not', () => {
  it('exports no matcher, and the create page asks core instead', () => {
    // Path through a variable, not a literal: Vite rewrites a literal `new URL(..., import
    // .meta.url)` into an asset URL, which is an http one under jsdom and not a file to read.
    // Same dodge as `DashboardPage.wiring.test.tsx`.
    const self = './githubTokens.ts'
    const source = readFileSync(fileURLToPath(new URL(self, import.meta.url)), 'utf8')
    const exported = [...source.matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1]!)
    // Rendering and editing verbs only. A name like `selectToken`, `matchToken` or
    // `resolveToken` appearing here is the drift this test exists to catch.
    expect(exported.filter((name) => /select|match|resolve|precedence|specificity/i.test(name))).toEqual([])

    const pagePath = '../pages/CreateServerPage.tsx'
    const page = readFileSync(fileURLToPath(new URL(pagePath, import.meta.url)), 'utf8')
    // The page gets its answer from core, and does not import this module at all.
    expect(page).toContain('resolveRepositories')
    expect(page).not.toContain("from '../lib/githubTokens'")
  })
})
