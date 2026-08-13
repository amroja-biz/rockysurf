import type { GithubTokenEntry } from '../config/schema.js'
import { probePublicUrl, type SafeProbeOptions } from '../packs/safe-fetch.js'
import { configuredGitHosts, configuredScopes, credentialQueryFor, identifyRemote, selectToken } from './token-matching.js'

/**
 * DOES THIS REPOSITORY URL ACTUALLY OPEN — asked at create, before an instance is launched
 * (rockysurf-k6xp).
 *
 * The owner's live test: one character wrong in a GitHub URL cost a full EC2 boot and the whole
 * bootstrap before failing at the clone, which is nearly the last step. kvkr's doctrine for
 * remote desktops applies unchanged to repositories — "an instance that boots straight to
 * failedStep=rdp costs money and teaches nothing" — and 4byx is what makes the bill for that
 * mistake finally visible. This is the other half: stop spending it.
 *
 * WHAT IT ASKS. The git smart-HTTP discovery request, `GET <repo>.git/info/refs?service=git-
 * upload-pack`, which is the first thing `git clone` itself sends. It is cheap, it is
 * read-only, it needs no working tree, and it answers the exact question — 200 means this
 * credential can read this repository, 404 and 401 mean it cannot and say which way.
 *
 * WHICH CREDENTIAL. The one the BOX would choose, predicted by `token-matching.ts`, which is a
 * port of the credential helper's own rules and is pinned to the real shell program by a
 * differential test. The precedence rules are not forked and not re-decided here: a preflight
 * that authenticated differently from the clone would refuse URLs that work and pass URLs that
 * do not, which is worse than not checking.
 *
 * WHY IT IS ONLY EVER A PREDICTION. Core cannot make the box's choice — one `secrets.env`
 * serves every clone a box will ever run, so selection has to happen at clone time with git's
 * request in hand (ta7g). What is checked here is what WOULD be chosen from the same table,
 * against the same host and path. That is enough to catch a typo, a private repository with no
 * matching token, and a token that has expired; it is not a guarantee, which is why the refusal
 * it produces can be overridden.
 *
 * SSRF. Every probe goes through the pack-import guard's screening (`safe-fetch.ts`), because a
 * repository URL is user-supplied text and a control plane holding cloud credentials must not
 * become a way to knock on 169.254.169.254. The one exemption is by NAME and by the operator's
 * own hand: hosts they have written into `github.tokens`, which is how a self-hosted forge on a
 * private network stays checkable. A redirect off such a host is screened again like anything
 * else, and the Authorization header does not travel across origins.
 */

/** Why a URL was refused. The three the error message names, plus the shape failures. */
export type PreflightCode =
  | 'malformed'
  | 'unsupported_scheme'
  | 'not_a_repository'
  | 'unreachable'
  | 'not_found'
  | 'unauthorized'
  /**
   * No configured token matches this URL, so the clone would go out anonymously and the host
   * refused it (rockysurf-ldo1). Distinct from `unauthorized`, which means a token WAS tried
   * and rejected, and from `not_found`, which is the genuinely ambiguous case — this one core
   * is certain of, having run the box's own selection rules and got nothing back.
   */
  | 'no_matching_token'
  | 'blocked'

export interface PreflightRefusal {
  ok: false
  url: string
  code: PreflightCode
  /** A sentence for a human, naming this URL. Rendered by all three front ends verbatim. */
  reason: string
}

export type PreflightResult = { ok: true; url: string } | PreflightRefusal

export interface PreflightDeps extends SafeProbeOptions {
  /** `github.tokens`, in file order. The precedence tie-break depends on the order. */
  tokens?: readonly GithubTokenEntry[]
  /** The instance-wide `GITHUB_TOKEN` the box would fall back to. */
  fallbackToken?: string
}

/**
 * The three causes worth naming, in the order a user should check them.
 *
 * Named rather than diagnosed, because core genuinely cannot tell them apart: GitHub answers
 * 404 for "no such repository" AND for "a private repository this credential may not see",
 * deliberately, so that a token cannot be used to enumerate private repositories. Guessing
 * between them would be inventing a fact; listing them lets the user recognise their own.
 */
const THREE_CAUSES =
  'a typo in the URL, a private repository with no token configured for it, or a token that does not have access'

/** `https://host/owner/repo(.git)` → the discovery URL git itself would request. */
function discoveryUrl(url: URL): string {
  const path = url.pathname.replace(/\/+$/, '')
  const withSuffix = path.endsWith('.git') ? path : `${path}.git`
  return `${url.origin}${withSuffix}/info/refs?service=git-upload-pack`
}

/**
 * Check one repository URL. Never throws: every outcome is a value, because this runs inside a
 * create request and a preflight that could 500 would be worse than one that does not exist.
 */
export async function preflightRepository(rawUrl: string, deps: PreflightDeps = {}): Promise<PreflightResult> {
  const trimmed = rawUrl.trim()
  const refuse = (code: PreflightCode, reason: string): PreflightRefusal => ({ ok: false, url: trimmed, code, reason })

  if (!trimmed) return refuse('malformed', 'A repository URL cannot be empty.')

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    // The scp-style form `git@github.com:acme/widgets.git` lands here, and is worth its own
    // sentence: it is not a typo, it is a shape the box cannot use.
    if (/^[^\s/]+@[^\s/]+:/.test(trimmed)) {
      return refuse(
        'unsupported_scheme',
        `${trimmed} is an SSH remote. Boxes clone over HTTPS with a token and are not given an SSH key, ` +
          'so use the https:// form of the URL.',
      )
    }
    return refuse('malformed', `${trimmed} is not a URL.`)
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return refuse(
      'unsupported_scheme',
      `${trimmed} uses ${url.protocol.replace(':', '')}, which boxes cannot clone. Use an https:// URL.`,
    )
  }

  /*
   * The URL becomes a credential query in ONE place, `credentialQueryFor` — which keeps the
   * port (git's `host=` carries a non-default one and `github.tokens` permits one for exactly
   * that reason, so matching on `hostname` would apply a `git.example.com:8443` entry's token to
   * `git.example.com`, a different forge as far as the box is concerned) and drops a trailing
   * slash. Sharing it with narrowing (rockysurf-18lq) is what stops the check and the deployment
   * from disagreeing about the same URL; they differed on `.../widgets.git/` before.
   */
  const query = credentialQueryFor(url)
  const gitHost = query.host
  const { owner, repo } = identifyRemote(query)
  if (!owner || !repo) {
    return refuse('not_a_repository', `${trimmed} does not name a repository — an owner and a repository name are needed.`)
  }

  // Predicted, not chosen. See the header: the box makes the real decision at clone time.
  const tokens = deps.tokens ?? []
  const choice = selectToken(query, tokens, deps.fallbackToken)

  const probe = await probePublicUrl(discoveryUrl(url), {
    ...deps,
    allowHosts: deps.allowHosts ?? configuredGitHosts(tokens),
    headers: {
      // The username git's credential helper prints, so the probe authenticates exactly as the
      // clone will. Basic auth over the wire is what smart HTTP uses.
      ...(choice ? { authorization: `Basic ${Buffer.from(`x-access-token:${choice.pat}`).toString('base64')}` } : {}),
      // Servers behave differently for a client that admits what it is; GitHub in particular
      // will answer the discovery request without it, but a stricter forge may not.
      'user-agent': 'git/rockysurf-preflight',
      accept: 'application/x-git-upload-pack-advertisement',
    },
  })

  if (!probe.ok) {
    // A screening refusal and a dead socket are different facts. The first is this
    // installation's own policy and must say so rather than blaming the user's URL.
    const blocked = /Refusing|not a public address|non-public address|Only http/.test(probe.reason)
    return refuse(
      blocked ? 'blocked' : 'unreachable',
      blocked
        ? `${trimmed} was not checked: ${probe.reason}`
        : `${trimmed} could not be reached (${probe.reason}). If the host is temporarily down you can create anyway.`,
    )
  }

  if (probe.status === 200) return { ok: true, url: trimmed }

  /*
   * NO TOKEN WOULD BE SENT AT ALL — a cause core is CERTAIN of, and the one the owner's live
   * test hit (rockysurf-ldo1).
   *
   * Their config had scoped tokens only: nothing matching the repository's owner, and no fallback `pat`.
   * The helper's terminal rule is `[ -n "$t" ] || exit 0` — no opinion — so git got no
   * credential, prompted for a username, found no TTY, and died with `could not read Username
   * for ...: No such device or address`. Correct, and humanly useless.
   *
   * The point is that this is NOT one of the three ambiguous causes. Core does not have to
   * guess: it ran the same selection rules the box will run and got nothing back. Folding that
   * certainty into a list of three maybes is what made the original message useless, so it
   * leads, and the scopes that WERE available are named — identities only, never values —
   * because "none of these covers it" is the sentence that closes the diagnosis.
   */
  const scopes = configuredScopes(tokens)
  const carried =
    scopes.length > 0
      ? `Tokens are configured for: ${scopes.join(', ')} — none covers ${gitHost}/${owner}/${repo}.`
      : 'No git tokens are configured on this installation at all.'
  const remedy =
    `Add an entry under github.tokens covering ${gitHost}/${owner}/${repo}, or set a fallback ` +
    'github.pat. If the repository is public, the URL is wrong instead.'

  if (probe.status === 401 || probe.status === 403) {
    if (!choice) {
      return refuse(
        'no_matching_token',
        `No configured token matches ${trimmed}, so the box would clone it anonymously — and ` +
          `${gitHost} refused that (HTTP ${probe.status}). ${carried} ${remedy}`,
      )
    }
    // A token WAS selected and the host rejected it: revoked, expired, or without the scope
    // this repository needs. Naming which one was tried is the difference between "check your
    // tokens" and "check this token".
    return refuse(
      'unauthorized',
      `${trimmed} refused the configured token (HTTP ${probe.status}). It is most likely revoked, ` +
        'expired, or missing repository read access. ' +
        (choice.scope
          ? `The token that would be used is the one scoped to ${choice.scope}.`
          : 'The instance-wide github.pat would be used; no scoped entry matches this URL.'),
    )
  }

  if (probe.status === 404) {
    // 404 is genuinely ambiguous even when a token WAS sent — GitHub answers it for "no such
    // repository" and for "private and not yours" alike, deliberately, so that a token cannot
    // be used to enumerate private repositories. So here the causes are listed rather than
    // chosen between. What is NOT ambiguous is which credential was tried, so that is stated.
    if (!choice) {
      return refuse(
        'no_matching_token',
        `${trimmed} was not found, and the request was anonymous because no configured token ` +
          `matches it (HTTP 404). ${carried} ${remedy}`,
      )
    }
    return refuse(
      'not_found',
      `${trimmed} was not found with the configured tokens (HTTP 404). Likely ${THREE_CAUSES}. ` +
        (choice.scope
          ? `The token that would be used is the one scoped to ${choice.scope}.`
          : 'The instance-wide github.pat would be used; no scoped entry matches this URL.'),
    )
  }

  return refuse('unreachable', `${trimmed} answered HTTP ${probe.status} to git's discovery request.`)
}

/** A refusal that remembers WHICH entry of the submitted list it belongs to. */
export interface IndexedRefusal extends PreflightRefusal {
  /** Position in the `repositories` array as submitted, so a form can mark the right field. */
  index: number
}

/**
 * Check every URL and report ALL the bad ones, so a user fixes one form rather than four.
 *
 * In parallel, because a create naming four repositories should not pay four sequential round
 * trips before it is allowed to start — and unlike `lifecycle.list`'s deliberately sequential
 * sync, these are a handful of requests made once, not a poll.
 *
 * The index is carried rather than recovered by searching for the URL afterwards: the refusal
 * reports the TRIMMED url, two entries can be the same repository written differently, and a
 * lookup that missed would silently mark the wrong field.
 */
export async function preflightRepositories(urls: readonly string[], deps: PreflightDeps = {}): Promise<IndexedRefusal[]> {
  const results = await Promise.all(urls.map((url) => preflightRepository(url, deps)))
  return results.flatMap((result, index) => (result.ok ? [] : [{ ...result, index }]))
}
