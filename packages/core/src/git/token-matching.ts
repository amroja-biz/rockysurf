import { DEFAULT_GITHUB_HOST, githubTokenScope } from '../bootstrap/server-secrets.js'
import type { GithubTokenEntry } from '../config/schema.js'

/**
 * WHICH TOKEN WILL THE BOX USE FOR THIS URL — answered in TypeScript, in core.
 *
 * The box picks its own token, and must: one `secrets.env` serves every clone a box will ever
 * run, so core cannot choose per repository even in principle. git hands the credential helper
 * `host=` and `path=` at clone time and the helper takes the most specific matching scope. That
 * design is not changed here and is not up for revision — see `GIT_CREDENTIAL_HELPER` in
 * `bootstrap/resolver.ts`, which is still the only implementation that decides anything.
 *
 * THIS MODULE PREDICTS THAT DECISION, and the distinction is the whole reason it can exist
 * without forking the rules. Its one caller is the create-time preflight (rockysurf-k6xp),
 * which needs to know which credential a URL would be tried with so that "not reachable" can
 * be an honest sentence rather than a guess. A prediction that is wrong costs a misleading
 * error message; it cannot cost a failed clone, because nothing downstream reads it.
 *
 * PORTED, NOT REINVENTED. Every rule below is the shell's, in the shell's order:
 *
 *  1. lowercase `host` and `path` (the helper pipes both through `tr A-Z a-z`, because GitHub
 *     is case-insensitive and `[ = ]` is not);
 *  2. strip ONE trailing `.git` — `p=${p%.git}` — and do it BEFORE splitting;
 *  3. split on the first two segments: `owner` up to the first `/`, `repo` between the first
 *     and second. A path with no `/` is an owner with an empty repo;
 *  4. an entry matches when its host equals the request's host AND its owner is `*` or equal
 *     AND its repo is `*` or equal. `*` is compared as a LITERAL STRING, never as a glob, and
 *     the host never wildcards because `githubTokenScope` always fills one;
 *  5. specificity `n = 1 + (owner !== '*') + (repo !== '*')`, and an entry replaces the
 *     incumbent only on `n > best` — STRICTLY greater, so a specificity tie is won by the
 *     first entry in file order;
 *  6. the fallback (`GITHUB_TOKEN`) is the incumbent at score 0, so any match at all beats it;
 *  7. no match and no fallback means NO OPINION — undefined, not an error. A public clone
 *     through a box that happens to hold tokens for private repositories is unaffected.
 *
 * The one thing this file adds that the shell does not need: a leading `/` is stripped before
 * splitting. git never sends one; `new URL(...).pathname` always does, and the caller here is
 * parsing URLs rather than reading git's stdin.
 *
 * KEEPING IT HONEST. `server-secrets.test.ts` runs the REAL helper string through `/bin/sh` on
 * a table of cases; `token-matching.test.ts` runs this function over the SAME table. A port
 * that only ever tested itself would be exactly the drift this comment is worried about.
 */

/** A credential request in git's own vocabulary: what the helper reads off stdin. */
export interface CredentialQuery {
  host: string
  /** Absent when git was not told to send one — the helper's `useHttpPath` case. */
  path?: string
}

/** The owner/repo a git remote names, normalized the way the helper normalizes them. */
export interface RemoteIdentity {
  host: string
  owner: string
  /** Empty when the path named only an owner. */
  repo: string
}

/**
 * Split a credential query into the fields the scope comparison uses.
 *
 * Rules 1–3 above, and nothing else — no validation, because the helper does none either: it
 * compares whatever it was handed and contributes nothing when nothing matches.
 */
export function identifyRemote(query: CredentialQuery): RemoteIdentity {
  const host = query.host.toLowerCase()
  let path = (query.path ?? '').toLowerCase()
  // A URL pathname carries the leading slash git omits; without this every owner would be ''.
  if (path.startsWith('/')) path = path.slice(1)
  // ONE suffix, and before the split, exactly as `p=${p%.git}` does it.
  if (path.endsWith('.git')) path = path.slice(0, -4)

  const slash = path.indexOf('/')
  if (slash === -1) return { host, owner: path, repo: '' }
  const rest = path.slice(slash + 1)
  const nextSlash = rest.indexOf('/')
  return { host, owner: path.slice(0, slash), repo: nextSlash === -1 ? rest : rest.slice(0, nextSlash) }
}

/** How specific a `host/owner/repo` scope is: 1, 2 or 3. Rule 5. */
function specificity(owner: string, repo: string): number {
  return 1 + (owner === '*' ? 0 : 1) + (repo === '*' ? 0 : 1)
}

export interface TokenChoice {
  /** The token the box would present. */
  pat: string
  /** `host/owner/repo`, or undefined when the instance-wide fallback won. */
  scope?: string
}

/**
 * WHICH ENTRY wins, as a position in `entries` — the single matching loop everything else here
 * is built on.
 *
 * Split out from `selectToken` when narrowing arrived (rockysurf-18lq), which needs entry
 * IDENTITY rather than a token value: the loop is the precedence rules, and a second copy of it
 * written to return something else is exactly the drift `token-matching.test.ts` exists to
 * catch. `undefined` means no entry matched, which is a different answer from "the fallback
 * won" — the caller decides what that is worth.
 */
function selectEntryIndex(query: CredentialQuery, entries: readonly GithubTokenEntry[]): number | undefined {
  const { host, owner, repo } = identifyRemote(query)

  let best = 0
  let winner: number | undefined

  for (const [index, entry] of entries.entries()) {
    const scope = githubTokenScope(entry)
    const [entryHost = '', entryOwner = '', entryRepo = ''] = scope.split('/')
    if (entryHost !== host) continue
    if (entryOwner !== '*' && entryOwner !== owner) continue
    if (entryRepo !== '*' && entryRepo !== repo) continue

    const n = specificity(entryOwner, entryRepo)
    // STRICTLY greater: on a tie the earlier entry keeps the slot.
    if (n > best) {
      best = n
      winner = index
    }
  }

  return winner
}

/**
 * The token the box's credential helper would print for this query, or undefined for "no
 * opinion" — which is a perfectly good answer and means the clone goes out anonymously.
 *
 * `entries` must be in the order the operator wrote them, because rule 5's tie-break is file
 * order. `config/schema.ts` has already lowercased and character-restricted every scope field
 * and refused duplicate scopes, so nothing here re-validates them.
 */
export function selectToken(
  query: CredentialQuery,
  entries: readonly GithubTokenEntry[],
  fallback?: string,
): TokenChoice | undefined {
  const index = selectEntryIndex(query, entries)
  if (index === undefined) return fallback ? { pat: fallback } : undefined
  const entry = entries[index]!
  return { pat: entry.pat, scope: githubTokenScope(entry) }
}

/**
 * The credential request a repository URL would produce — the ONE place a URL becomes a query
 * (rockysurf-18lq).
 *
 * Both core-side consumers go through it: the create-time preflight, which needs to know which
 * token would be tried, and narrowing, which needs to know which entries a box's repositories
 * select. They used to parse the URL separately and agreed on everything except a trailing
 * slash, which is not a difference anyone would have chosen.
 *
 * `url.host`, NOT `url.hostname` — git's `host=` carries a non-default port and `github.tokens`
 * permits one for exactly that reason, so dropping it would apply a `git.example.com:8443`
 * entry's token to a probe of `git.example.com`.
 *
 * TRAILING SLASHES ARE DROPPED, and this is the one normalization neither the shell nor
 * `identifyRemote` does — correctly, since git never sends one and `identifyRemote` is a port of
 * the shell's rules. A person pasting from a browser does send one, and `.../widgets.git/` would
 * otherwise be read as a repository named `widgets.git`: `.git` is stripped only when it is last,
 * and the slash is. The preflight already strips them when building the discovery URL, so before
 * this the same URL could be probed correctly and matched wrongly.
 */
export function credentialQueryFor(url: URL): CredentialQuery {
  return { host: url.host, path: url.pathname.replace(/\/+$/, '') }
}

/**
 * The same, from text that may not be a URL at all.
 *
 * A string that does not parse, or names a scheme a box cannot clone, gets no query rather than a
 * guess: narrowing must not invent a match for text the preflight would refuse, and `createAnyway`
 * means the create path really does carry such text through to a row.
 */
export function credentialQueryForText(rawUrl: string): CredentialQuery | undefined {
  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  return credentialQueryFor(url)
}

/**
 * The entries a box whose declared repositories are `repositories` actually needs — per-server
 * NARROWING (rockysurf-18lq), and a deliberate amendment to ta7g's instance-wide doctrine.
 *
 * WHAT CHANGES AND WHAT DOES NOT. ta7g put the whole configured set on every box, with scoping
 * narrowing what a token is USED FOR rather than who receives it. That is still true of the
 * fallback `github.pat`, which is instance-wide by definition and still ships everywhere
 * (`server-secrets.ts` states why). What changes is the SCOPED set: a box now receives only the
 * entries its own declared repositories select, so a token for `acme/widgets` no longer lands on
 * a box that was never told about `acme/widgets`. The blast radius of one compromised box shrinks
 * from "every private repository this installation can reach" to "the ones it was built to clone".
 *
 * WHY IT CANNOT CHANGE ANY CLONE'S OUTCOME for a declared repository. The box re-runs the same
 * precedence rules over whatever set it holds. Removing entries that did NOT win for a URL cannot
 * change which entry wins for it — `selectEntryIndex` only ever replaces the incumbent on strictly
 * greater specificity, so the winner is the maximum and dropping non-maxima leaves it the maximum.
 * That is asserted end-to-end against the real shell helper rather than argued here.
 *
 * WHAT IT DOES COST, stated rather than hidden: a repository cloned BY HAND on the box a month
 * later, which nobody declared at create, now gets the fallback or nothing where before it might
 * have got a scoped token. There is no re-push — a box's `secrets.env` is written once — so the
 * remedy is terminate and recreate with the repository declared, or authenticate that clone by
 * hand. The server detail page says so in as many words.
 *
 * ORDER IS PRESERVED, because file order is the tie-break and the box's helper reads whatever it
 * is given as a table in order. A narrowed set that reordered entries would be a set whose
 * behaviour differed from the file's for reasons nothing had stated.
 */
export function narrowTokensToRepositories(
  entries: readonly GithubTokenEntry[],
  repositories: readonly string[],
): GithubTokenEntry[] {
  const keep = new Set<number>()
  for (const repository of repositories) {
    const query = credentialQueryForText(repository)
    if (!query) continue
    const index = selectEntryIndex(query, entries)
    if (index !== undefined) keep.add(index)
  }
  return entries.filter((_, index) => keep.has(index))
}

/**
 * The scope IDENTITIES this installation carries, in file order — `host/owner/repo` strings.
 *
 * NAMES ONLY, NEVER VALUES. `githubTokenScope` reads `host`/`owner`/`repo` off the entry and
 * never touches `pat`, which is the whole reason the encoding exists: the box needs to be told
 * which token covers what without the scope string ever being a place a secret could hide. Its
 * one caller is the preflight's refusal message, which is user-facing text.
 *
 * Used to answer the question the owner could only answer by having built the feature: not
 * "which token was used" but "which tokens were there to choose from, and why did none of them
 * match" (rockysurf-ldo1).
 */
export function configuredScopes(entries: readonly GithubTokenEntry[]): string[] {
  return entries.map((entry) => githubTokenScope(entry))
}

/**
 * Every host the operator has named in configuration, lowercased, WITHOUT the port.
 *
 * Used by the preflight to decide which hosts its SSRF screening may exempt. An operator who
 * has written `host: git.internal.corp` into `github.tokens` has already told this installation
 * that the name is a git forge of theirs; refusing to probe it because it resolves to RFC1918
 * would make the check useless on exactly the self-hosted-forge setup the token list exists
 * for. `github.com` is included unconditionally because it is the default every unhosted entry
 * inherits.
 *
 * THE PORT IS STRIPPED because screening is about the address a name stands for, and a name
 * does not resolve differently per port — `safe-fetch` looks at `URL.hostname`, which never
 * carries one. Scope MATCHING keeps the port, because git's `host=` does; the two questions are
 * asked of the same config field and want different halves of it.
 */
export function configuredGitHosts(entries: readonly GithubTokenEntry[]): Set<string> {
  const strip = (host: string) => host.toLowerCase().replace(/:\d+$/, '')
  return new Set([DEFAULT_GITHUB_HOST, ...entries.map((entry) => strip(entry.host ?? DEFAULT_GITHUB_HOST))])
}
