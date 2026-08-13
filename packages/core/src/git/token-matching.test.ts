import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { GIT_CREDENTIAL_HELPER } from '../bootstrap/resolver.js'
import { GITHUB_TOKEN_SET_ENV, githubTokenScope } from '../bootstrap/server-secrets.js'
import { configSchema } from '../config/index.js'
import type { GithubTokenEntry } from '../config/schema.js'
import { configuredGitHosts, identifyRemote, narrowTokensToRepositories, selectToken } from './token-matching.js'

/**
 * THE PORT IS PINNED TO THE SHELL, DIFFERENTIALLY (rockysurf-k6xp).
 *
 * `selectToken` predicts what the box's credential helper will do. A prediction that drifts is
 * worse than no prediction, because it turns a create-time refusal into a confident lie about a
 * URL that would have cloned fine. `server-secrets.test.ts` already runs the REAL helper string
 * through `/bin/sh` — its own comment says a test that "reasoned about scopes in TypeScript
 * would agree with itself forever while the shell did something else", and that is exactly the
 * trap a port invites.
 *
 * So every case below is run through BOTH: the shell program `resolver.ts` embeds, and the
 * TypeScript port. `agree()` asserts they answer identically and returns the answer, so an
 * assertion about the value is also an assertion that the two implementations match. A case
 * added here is automatically a case for both.
 */

/** The real helper, run the way git runs it — lifted from `server-secrets.test.ts`. */
function askShell(env: Record<string, string>, request: { host: string; path?: string }): string | undefined {
  const stdin = ['protocol=https', `host=${request.host}`]
  if (request.path !== undefined) stdin.push(`path=${request.path}`)

  const result = spawnSync(
    '/bin/sh',
    ['-c', `${GIT_CREDENTIAL_HELPER.slice(1)} "$@"`, 'rockysurf-credential-helper', 'get'],
    {
      input: `${stdin.join('\n')}\n\n`,
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...env },
      encoding: 'utf8',
    },
  )
  expect(result.status, result.stderr).toBe(0)
  return /^password=(.*)$/m.exec(result.stdout)?.[1]
}

/** The environment `server-secrets.ts` builds, so the shell reads what a real box reads. */
function envFor(entries: readonly GithubTokenEntry[], fallback?: string): Record<string, string> {
  const env: Record<string, string> = { [GITHUB_TOKEN_SET_ENV.count]: String(entries.length) }
  if (fallback) env['GITHUB_TOKEN'] = fallback
  entries.forEach((entry, index) => {
    env[GITHUB_TOKEN_SET_ENV.token(index + 1)] = entry.pat
    env[GITHUB_TOKEN_SET_ENV.scope(index + 1)] = githubTokenScope(entry)
  })
  return env
}

/** Ask both implementations, insist they agree, and hand back the answer. */
function agree(
  entries: readonly GithubTokenEntry[],
  fallback: string | undefined,
  request: { host: string; path?: string },
): string | undefined {
  const fromShell = askShell(envFor(entries, fallback), request)
  const fromPort = selectToken(request, entries, fallback)?.pat
  expect(fromPort, `port and shell disagree for ${request.host}/${request.path ?? ''}`).toBe(fromShell)
  return fromShell
}

/** Entries as `config/schema.ts` produces them — lowercased, validated, in file order. */
function parseEntries(yamlish: { host?: string; owner?: string; repo?: string; pat: string }[]): GithubTokenEntry[] {
  return configSchema.parse({ github: { tokens: yamlish } }).github.tokens
}

/**
 * `server-secrets.test.ts`'s own fixture, BROADEST ENTRY FIRST for the reason stated there: a
 * matcher that simply took the first match would pass every case below while implementing no
 * precedence at all, and this order fails that matcher.
 */
const ENTRIES = parseEntries([
  { owner: 'acme', pat: 'ghp_acme' },
  { repo: 'acme/widgets', pat: 'ghp_widgets' },
  { host: 'git.example.com', pat: 'ghp_enterprise' },
])

describe('the port answers what the box will answer', () => {
  it('selects most-specific-first: repo, then owner, then host, then the fallback', () => {
    expect(agree(ENTRIES, 'ghp_fallback', { host: 'github.com', path: 'acme/widgets.git' })).toBe('ghp_widgets')
    expect(agree(ENTRIES, 'ghp_fallback', { host: 'github.com', path: 'acme/other.git' })).toBe('ghp_acme')
    expect(agree(ENTRIES, 'ghp_fallback', { host: 'git.example.com', path: 'anyone/anything' })).toBe('ghp_enterprise')
    expect(agree(ENTRIES, 'ghp_fallback', { host: 'github.com', path: 'stranger/thing' })).toBe('ghp_fallback')
    // A host nobody named gets the fallback, never somebody else's token.
    expect(agree(ENTRIES, 'ghp_fallback', { host: 'gitlab.com', path: 'acme/widgets' })).toBe('ghp_fallback')
  })

  it('matches case-insensitively, because github.com does', () => {
    expect(agree(ENTRIES, 'ghp_fallback', { host: 'GitHub.com', path: 'Acme/Widgets.git' })).toBe('ghp_widgets')
  })

  it('has no opinion when nothing matches and there is no fallback', () => {
    const acmeOnly = parseEntries([{ owner: 'acme', pat: 'ghp_acme' }])
    expect(agree(acmeOnly, undefined, { host: 'github.com', path: 'someone/public' })).toBeUndefined()
    expect(agree(acmeOnly, undefined, { host: 'github.com', path: 'acme/private' })).toBe('ghp_acme')
  })

  it('leaves a path-less request to the fallback rather than guessing', () => {
    expect(agree(ENTRIES, 'ghp_fallback', { host: 'github.com' })).toBe('ghp_fallback')
    // A host-scoped entry needs no path to be sure of itself.
    expect(agree(ENTRIES, 'ghp_fallback', { host: 'git.example.com' })).toBe('ghp_enterprise')
  })

  it('breaks a specificity tie on file order, not on the last one seen', () => {
    // Two owner-scoped entries for one owner cannot both exist — the schema refuses duplicate
    // scopes — so the tie has to be built across hosts that both match nothing more specific.
    const tied = parseEntries([
      { owner: 'acme', pat: 'ghp_first' },
      { owner: 'other', pat: 'ghp_second' },
    ])
    expect(agree(tied, undefined, { host: 'github.com', path: 'acme/anything' })).toBe('ghp_first')
    expect(agree(tied, undefined, { host: 'github.com', path: 'other/anything' })).toBe('ghp_second')
  })

  it('strips exactly one .git, and does it before splitting', () => {
    const dotted = parseEntries([{ repo: 'acme/widgets.git', pat: 'ghp_literally_dot_git' }])
    // `acme/widgets.git.git` strips to `acme/widgets.git`, which is a repository literally
    // named that. Stripping greedily would make this the same request as `acme/widgets`.
    expect(agree(dotted, undefined, { host: 'github.com', path: 'acme/widgets.git.git' })).toBe(
      'ghp_literally_dot_git',
    )
    expect(agree(dotted, undefined, { host: 'github.com', path: 'acme/widgets.git' })).toBeUndefined()
  })

  it('ignores path segments past the repository', () => {
    expect(agree(ENTRIES, undefined, { host: 'github.com', path: 'acme/widgets/tree/main' })).toBe('ghp_widgets')
  })

  it('does not treat a configured * as a wildcard, because a scope field cannot contain one', () => {
    // The schema's character sets make a literal `*` unwritable, so `*` in a scope string is
    // always the encoder's "any" and never an operator's repository name. Guarded here because
    // a port that used a glob library would silently widen every scope.
    expect(() => parseEntries([{ owner: '*', pat: 'ghp_star' }])).toThrow()
  })
})

describe('identifyRemote normalises what a URL parser hands it', () => {
  it('strips the leading slash a URL pathname carries and git never sends', () => {
    // The one thing this port adds to the shell's rules. Without it every owner would be ''.
    expect(identifyRemote({ host: 'github.com', path: '/acme/widgets.git' })).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
    })
  })

  it('reads an owner-only path as an owner with no repository', () => {
    expect(identifyRemote({ host: 'github.com', path: '/acme' })).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: '',
    })
  })
})

describe('the hosts an operator has vouched for', () => {
  it('is github.com plus every host named in the token list', () => {
    expect([...configuredGitHosts(ENTRIES)].sort()).toEqual(['git.example.com', 'github.com'])
  })

  it('always includes github.com, which every unhosted entry inherits', () => {
    expect(configuredGitHosts([]).has('github.com')).toBe(true)
  })
})

/**
 * NARROWING, and the one property that makes it safe (rockysurf-18lq).
 *
 * `narrowTokensToRepositories` drops entries a box's declared repositories did not select. The
 * claim that lets it do so without changing behaviour is that removing non-winning entries
 * cannot change a winner — an argument about precedence, and therefore an argument that belongs
 * in front of `agree()`, which asks the real shell program as well as the port. Every case below
 * resolves the SAME url twice, once against the whole table and once against the narrowed one,
 * and insists on the same answer from both implementations both times.
 */
describe('narrowing a box’s token set', () => {
  /** The invariant: narrowing is invisible to a repository the box actually declared. */
  function unchangedBy(repositories: string[], request: { host: string; path?: string }, fallback?: string) {
    const narrowed = narrowTokensToRepositories(ENTRIES, repositories)
    const before = agree(ENTRIES, fallback, request)
    const after = agree(narrowed, fallback, request)
    expect(after).toBe(before)
    return { narrowed, answer: after }
  }

  it('keeps the winner for each declared repository and nothing else', () => {
    const { narrowed } = unchangedBy(['https://github.com/acme/widgets.git'], {
      host: 'github.com',
      path: 'acme/widgets.git',
    })
    expect(narrowed.map(githubTokenScope)).toEqual(['github.com/acme/widgets'])
  })

  it('keeps a broader entry when that is the one a declared repository selects', () => {
    const { narrowed, answer } = unchangedBy(['https://github.com/acme/other'], {
      host: 'github.com',
      path: 'acme/other',
    })
    expect(narrowed.map(githubTokenScope)).toEqual(['github.com/acme/*'])
    expect(answer).toBe('ghp_acme')
  })

  it('keeps every entry a multi-repository box needs, in file order', () => {
    const all = narrowTokensToRepositories(ENTRIES, [
      'https://git.example.com/ops/infra',
      'https://github.com/acme/widgets',
      'https://github.com/acme/other',
    ])
    // File order, not the order the repositories were listed in: the tie-break is file order,
    // and a set that reordered itself would behave differently for reasons nothing stated.
    expect(all.map(githubTokenScope)).toEqual(ENTRIES.map(githubTokenScope))
  })

  it('leaves the fallback answering for a repository nothing scoped covers', () => {
    const { narrowed, answer } = unchangedBy(
      ['https://github.com/stranger/thing'],
      { host: 'github.com', path: 'stranger/thing' },
      'ghp_fallback',
    )
    expect(narrowed).toEqual([])
    expect(answer).toBe('ghp_fallback')
  })

  it('gives nothing at all to a box that declared nothing', () => {
    expect(narrowTokensToRepositories(ENTRIES, [])).toEqual([])
  })

  it('contributes no entry for text that is not a URL a box could clone', () => {
    // `createAnyway` lets junk through to a row. An scp-style remote is the interesting one: it
    // NAMES acme/widgets, and a narrowing that parsed it loosely would hand out ghp_widgets on
    // the strength of a string the preflight refuses outright.
    expect(narrowTokensToRepositories(ENTRIES, ['git@github.com:acme/widgets.git'])).toEqual([])
    expect(narrowTokensToRepositories(ENTRIES, ['ssh://git@github.com/acme/widgets'])).toEqual([])
    expect(narrowTokensToRepositories(ENTRIES, ['acme/widgets'])).toEqual([])
    expect(narrowTokensToRepositories(ENTRIES, [''])).toEqual([])
  })

  it('normalises a URL the way matching does, so a pasted one still narrows', () => {
    expect(narrowTokensToRepositories(ENTRIES, ['https://GitHub.com/Acme/Widgets.git/']).map(githubTokenScope)).toEqual(
      ['github.com/acme/widgets'],
    )
  })

  it('keeps the port, because a forge on another port is another forge', () => {
    const ported = parseEntries([{ host: 'git.example.com:8443', pat: 'ghp_alt' }])
    expect(narrowTokensToRepositories(ported, ['https://git.example.com/ops/infra'])).toEqual([])
    expect(narrowTokensToRepositories(ported, ['https://git.example.com:8443/ops/infra'])).toHaveLength(1)
  })
})
