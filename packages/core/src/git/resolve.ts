import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../app.js'
import { parseConfigLeniently } from '../config/index.js'
import type { GithubTokenEntry } from '../config/schema.js'
import { success } from '../http/responses.js'
import { validate } from '../http/validate.js'
import { DEFAULT_GITHUB_HOST, githubTokenScope } from '../bootstrap/server-secrets.js'
import type { PreflightCode, PreflightResult } from './preflight.js'
import { credentialQueryForText, selectToken } from './token-matching.js'

/**
 * WHICH TOKEN WILL THIS REPOSITORY USE — answered while the user is still typing it
 * (rockysurf-18lq).
 *
 * THE PROBLEM. Every fact that decides the answer lives in core: which tokens are configured,
 * how their scopes are compared, whether the repository is public. A browser can guess at none
 * of them, and the version of this feature that computed it in the SPA would have been a second
 * implementation of the precedence rules — which `token-matching.ts`'s own header, and k6xp's
 * differential test, exist because of. So the display is a READ-ONLY endpoint over the same
 * module, and the SPA renders whatever comes back.
 *
 * ONE AUTHORITY, TWO CONSUMERS, and the choice is worth stating because there was a plausible
 * second candidate. `packages/web/src/lib/githubTokens.ts` (rockysurf-5qzg) is web-side and
 * pure, but it is a RENDERING module — it unifies `github.pat` and `github.tokens` into one
 * settings list and matches nothing, as k6xp found when it went looking for an existing matcher
 * and had to write the port instead. The rules exist in exactly two places: the shell program in
 * `bootstrap/resolver.ts`, which decides, and `git/token-matching.ts`, which predicts and is
 * pinned to the shell by a differential test. This endpoint is a third CONSUMER of the second,
 * never a third implementation. The create-time preflight (k6xp) is the other consumer, and this
 * route calls it directly rather than reimplementing reachability.
 *
 * WHAT IT MAY SAY. Scope identities (`host/owner/repo`) and environment variable NAMES, and
 * nothing else. A `${VAR}` reference is the file's own text and a variable name is not a
 * credential — the settings view returns them in full on exactly that reasoning
 * (`settings/view.ts`) — while an interpolated token value never leaves this process by any
 * route. The scope identities were already visible to every authenticated user through k6xp's
 * refusal message, which names every configured scope when none of them matched; this endpoint
 * says the same class of thing earlier and more usefully. It is therefore session-authenticated
 * rather than admin-only: it is the create form's own feedback, and the create form is not
 * admin-only.
 *
 * IT CANNOT PROBE ANYTHING THE CREATE ROUTE COULD NOT. Every request goes through
 * `preflightRepository`, so a URL is screened by `safe-fetch` exactly as it is at create, and the
 * capability this adds over `POST /api/v1/servers` — which already runs the same probe with the
 * same credentials for any authenticated caller — is a cheaper way to ask, not a new question.
 */

/**
 * A token's IDENTITY as far as a user needs to see it. Never a value, in any field.
 *
 * `kind` distinguishes three genuinely different situations. `scoped` is an entry from
 * `github.tokens` that named this repository, its owner or its host. `fallback` is the
 * instance-wide `github.pat`, which every box carries and which covers whatever nothing else
 * does. `none` is the credential helper's own terminal answer — no opinion, the clone goes out
 * anonymously — and it is the RIGHT answer for a public repository, which is why the display
 * needs the reachability half before it can say whether `none` is good news.
 */
export interface TokenView {
  kind: 'scoped' | 'fallback' | 'none'
  /** `host/owner/repo`, `*` for the segments the entry left open. Absent for `none`. */
  scope?: string
  /** The `${VAR}` the config file draws this token from, when it draws it from one. */
  envVar?: string
  /**
   * False when `envVar` is not set in the environment this process was started from.
   *
   * The state rockysurf-1z5q made reachable: the settings page deliberately accepts a reference
   * to a variable that is not exported yet, so a token entry can be perfectly well saved and
   * still be a restart that will refuse to boot. That is a WARNING and it is not the same thing
   * as no token at all, so it gets its own field rather than being folded into `kind`.
   */
  envVarSet?: boolean
}

export interface RepositoryResolution {
  /** The URL as submitted, trimmed — the same normalization the preflight reports. */
  url: string
  /**
   * What a box created NOW would present for this URL: resolved against the token table THIS
   * PROCESS booted with, because that is the table `secrets.env` is built from.
   */
  live: TokenView
  /**
   * What a box created after the next restart would present — present ONLY when it differs from
   * `live`.
   *
   * The config file is read at boot and not again, so a token added through the settings page is
   * invisible to the running process until it restarts. Without this field the create screen
   * would tell the operator who just added `ACME_PAT` that there is no matching token,
   * which is both false and the least useful thing to say to them.
   */
  pending?: TokenView
  /** The create-time preflight's verdict, run read-only and with nothing written. */
  reachable: 'ok' | 'refused'
  /** The preflight's own sentence, verbatim, when it refused. */
  reason?: string
  code?: PreflightCode
}

export interface GitResolveDeps {
  /** `github.tokens` as this process booted with them, in file order. */
  tokens?: readonly GithubTokenEntry[]
  /** `github.pat` as this process booted with it. */
  fallbackToken?: string
  /** k6xp's check, injected so this route composes exactly like the create route does. */
  preflight: (url: string) => Promise<PreflightResult>
  /** The config file `boot()` loaded, for the `pending` half. Absent when there is no file. */
  configPath?: string
  /** The environment `${VAR}` references are checked against. */
  env?: NodeJS.ProcessEnv
}

/** The `host/owner/repo` a URL would match, or undefined when it is not a URL a box can clone. */
function viewFor(
  url: string,
  tokens: readonly GithubTokenEntry[],
  fallback: string | undefined,
): TokenView {
  const query = credentialQueryForText(url)
  if (!query) return { kind: 'none' }
  const choice = selectToken(query, tokens, fallback)
  if (!choice) return { kind: 'none' }
  return choice.scope ? { kind: 'scoped', scope: choice.scope } : { kind: 'fallback' }
}

/** Exactly one `${VAR}` and nothing else — the same rule `settings/view.ts` applies. */
const WHOLE_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

/**
 * The variable a token entry is drawn from, when the file draws it from one.
 *
 * Read off the file rather than the running config, because the running config interpolated its
 * references at boot and no longer remembers where its values came from — and read off a parse
 * that was given NO environment, because a reference to a variable that IS set interpolates
 * away, and the name is exactly what is wanted here. Matched by SCOPE, which is an entry's
 * identity: two entries cannot share one (`config/schema.ts` refuses it).
 */
function referenceFor(
  scope: string | undefined,
  uninterpolated: { pat?: string; tokens: readonly GithubTokenEntry[] },
) {
  const raw = scope === undefined ? uninterpolated.pat : uninterpolated.tokens.find((e) => githubTokenScope(e) === scope)?.pat
  const match = raw === undefined ? null : WHOLE_REFERENCE.exec(raw)
  return match ? match[1]! : undefined
}

/** Two views describe the same situation when every field of them agrees. */
function sameView(a: TokenView, b: TokenView): boolean {
  return a.kind === b.kind && a.scope === b.scope && a.envVar === b.envVar && a.envVarSet === b.envVarSet
}

/** The three token tables an answer is composed from, and the environment they are read against. */
interface TokenTables {
  env: NodeJS.ProcessEnv
  /** What this process booted with — the table `secrets.env` is built from. */
  liveTokens: readonly GithubTokenEntry[]
  liveFallback?: string
  /** What the config FILE holds now. Identical to the live table until somebody saves. */
  fileTokens: readonly GithubTokenEntry[]
  fileFallback?: string
  /** The same file with nothing interpolated, so a `${VAR}` is still its own name. */
  uninterpolated: { pat?: string; tokens: readonly GithubTokenEntry[] }
}

/**
 * The tables, with the config file read TWICE and deliberately.
 *
 * The first parse uses the real environment and answers "what would the next restart load" —
 * scopes resolved, values in place, unset references surviving as their own text. The second is
 * given NO environment at all, so EVERY `${VAR}` survives, and its only job is to say which
 * variable an entry's token comes from. One parse cannot do both: a reference that is set
 * interpolates away in the first, and the name is gone.
 *
 * Absent, unreadable or unparseable is not an error in either case: it costs the `pending` half
 * and the variable names, and the live answer — the one that decides what a box gets — does not
 * depend on the file at all.
 *
 * Shared by both readers on this route (rockysurf-mh8f). The picker asks the same question about
 * the whole table that the per-URL display asks about one repository, and a second copy of this
 * sequence is how the two would come to disagree about which entries exist.
 */
function readTokenTables(deps: GitResolveDeps): TokenTables {
  const env = deps.env ?? process.env
  const liveTokens = deps.tokens ?? []
  const tables: TokenTables = {
    env,
    liveTokens,
    ...(deps.fallbackToken ? { liveFallback: deps.fallbackToken } : {}),
    fileTokens: liveTokens,
    ...(deps.fallbackToken ? { fileFallback: deps.fallbackToken } : {}),
    uninterpolated: { tokens: [] },
  }
  if (!deps.configPath) return tables

  try {
    const text = readFileSync(deps.configPath, 'utf8')
    const parsed = parseConfigLeniently(text, env)
    if (parsed) {
      tables.fileTokens = parsed.github.tokens
      tables.fileFallback = parsed.github.pat
    }
    const named = parseConfigLeniently(text, {})
    if (named) {
      tables.uninterpolated = { ...(named.github.pat ? { pat: named.github.pat } : {}), tokens: named.github.tokens }
    }
  } catch {
    /* no file, or no permission to read it — `pending` simply cannot be answered */
  }
  return tables
}

/** Attach the variable name an entry is drawn from, and whether it is exported. Never a value. */
function decorateWithReference(view: TokenView, tables: TokenTables): TokenView {
  if (view.kind === 'none') return view
  const envVar = referenceFor(view.scope, tables.uninterpolated)
  if (!envVar) return view
  return { ...view, envVar, envVarSet: tables.env[envVar] !== undefined }
}

/**
 * Resolve one URL: which token, and does it open.
 *
 * Never throws. It runs inside a keystroke-driven request, and a display that could 500 would be
 * worse than one that does not exist — the same rule `preflightRepository` is written to.
 */
export async function resolveRepository(url: string, deps: GitResolveDeps): Promise<RepositoryResolution> {
  const tables = readTokenTables(deps)
  const decorate = (view: TokenView) => decorateWithReference(view, tables)

  const live = decorate(viewFor(url, tables.liveTokens, tables.liveFallback))
  const fileView = decorate(viewFor(url, tables.fileTokens, tables.fileFallback))

  const result = await deps.preflight(url)

  return {
    url: result.url,
    live,
    ...(sameView(live, fileView) ? {} : { pending: fileView }),
    ...(result.ok ? { reachable: 'ok' as const } : { reachable: 'refused' as const, reason: result.reason, code: result.code }),
  }
}

/* ------------------------------------------------------- what is configured (rockysurf-mh8f) */

/**
 * One configured token entry, as something the create form can OFFER rather than describe
 * (rockysurf-mh8f).
 *
 * THE BEAD'S OBSERVATION: the Settings entries already NAME repositories, so making the operator
 * retype `https://github.com/acme/private-thing` into the create form is the system refusing to
 * use what it knows. The picker fixes that — and the reason it lives HERE rather than being
 * derived in the SPA from the settings tree is that `kind` below is a judgement about what an
 * entry can be turned into, and the entry's shape is core's to read. `packages/web/src/lib/
 * githubTokens.ts` renders the same entries for the settings editor, but it is a settings-editing
 * module and the create page deliberately does not import it (pinned in its own test).
 *
 * FOUR KINDS, because only one of them names something insertable:
 *
 *  - `repository` — `owner` AND `repo`. This is the entry that names a clone URL, so it carries
 *    one and the form can insert it whole. The only clickable kind.
 *  - `account` — `owner` alone. It names an ACCOUNT, and Rocky Surf v0.1 cannot list what is
 *    under one (there is no GitHub App — the create page's own header says so). So it is stated,
 *    not offered: a button inserting `https://github.com/acme/` would put a line in the box that
 *    is not a repository, and the live display would then have to refuse it — the picker
 *    manufacturing the error state it exists to remove.
 *  - `host` — a forge and nothing else. Same reasoning, one level wider.
 *  - `fallback` — `github.pat`. Names nothing at all; it is the "everything else" row.
 *
 * NAMES, NEVER VALUES, exactly as the per-URL display: `scope` is `githubTokenScope`'s own
 * encoding, `label` is that written the way an operator says it, `envVar` is a variable name.
 * `pat` is never read by anything in this file.
 */
export interface ConfiguredScope {
  kind: 'repository' | 'account' | 'host' | 'fallback'
  /** `host/owner/repo` with `*` for the open segments — the entry's identity, and its key. */
  scope: string
  /** What to call it: `acme/widgets`, `acme`, `git.example.com`. Absent for the fallback. */
  label?: string
  /** The clone URL this entry names. Present for `repository` and for nothing else. */
  url?: string
  /** The `${VAR}` the file draws this token from, when it draws it from one. */
  envVar?: string
  /** False when that variable is not set in the environment core was started from. */
  envVarSet?: boolean
  /**
   * `pending` when the entry is in the config FILE but not in the table this process booted with
   * (rockysurf-1z5q's tense, applied to the list instead of to one URL).
   *
   * Without it the picker would be empty for the operator who has just added a token in Settings
   * — which is precisely the moment they come here to use it.
   */
  state: 'live' | 'pending'
}

/**
 * The clone URL an `owner`/`repo` entry names.
 *
 * HTTPS ALWAYS, because HTTPS is the only scheme a box can use: it clones with a token in a Basic
 * header and is never given an SSH key, which is why k6xp refuses `git@…` outright and why this
 * form's placeholder was changed to stop teaching it. A `host` carrying a port is written through
 * unchanged — that is the operator's own text and the forge's own address.
 */
function describeEntry(entry: GithubTokenEntry, state: 'live' | 'pending'): ConfiguredScope {
  const host = entry.host ?? DEFAULT_GITHUB_HOST
  const scope = githubTokenScope(entry)
  const common = { scope, state }

  // A repository: the one entry that names a URL, so it carries one.
  if (entry.owner && entry.repo) {
    const named = `${entry.owner}/${entry.repo}`
    return {
      ...common,
      kind: 'repository',
      label: host === DEFAULT_GITHUB_HOST ? named : `${named} on ${host}`,
      url: `https://${host}/${entry.owner}/${entry.repo}`,
    }
  }
  // An account, and then a forge: each names something real and neither names a repository.
  if (entry.owner) {
    return {
      ...common,
      kind: 'account',
      label: host === DEFAULT_GITHUB_HOST ? entry.owner : `${entry.owner} on ${host}`,
    }
  }
  return { ...common, kind: 'host', label: host }
}

/**
 * Every configured entry, in file order, live ones first.
 *
 * THE UNION OF BOTH TABLES, keyed by scope. An entry the running process holds is `live`; one only
 * the file holds is `pending`; one in both is `live`, because that is what a box created now
 * carries. An entry the process holds and the file no longer does is still `live` and still
 * offered — a box created now really does get it — and the per-URL display says the rest when its
 * URL is added, which is the right place for a sentence about one repository.
 */
export function describeConfiguredScopes(deps: GitResolveDeps): ConfiguredScope[] {
  const tables = readTokenTables(deps)
  const decorate = (view: TokenView) => decorateWithReference(view, tables)

  const byScope = new Map<string, ConfiguredScope>()
  for (const [entries, state] of [
    [tables.liveTokens, 'live'],
    [tables.fileTokens, 'pending'],
  ] as const) {
    for (const entry of entries) {
      const described = describeEntry(entry, state)
      if (!byScope.has(described.scope)) byScope.set(described.scope, described)
    }
  }

  const scoped = [...byScope.values()].map((described) => {
    // The same decoration the per-URL display uses, so a chip and the line it inserts name the
    // same variable. `referenceFor` matches by scope, which is an entry's identity.
    const { envVar, envVarSet } = decorate({ kind: 'scoped', scope: described.scope })
    return { ...described, ...(envVar ? { envVar, envVarSet } : {}) }
  })

  /*
   * The fallback, listed only when there IS one. An installation with no `github.pat` and no
   * entries yields an empty list, and the create form then shows no picker and no new chrome at
   * all — the empty state the bead asks for is this array being empty, not a component deciding
   * to hide itself.
   */
  const fallbackState = tables.liveFallback ? 'live' : tables.fileFallback ? 'pending' : undefined
  if (!fallbackState) return scoped

  const { envVar, envVarSet } = decorate({ kind: 'fallback' })
  return [...scoped, { kind: 'fallback' as const, scope: '*', state: fallbackState, ...(envVar ? { envVar, envVarSet } : {}) }]
}

/**
 * At most this many URLs per request.
 *
 * The create form sends only the lines it has not already resolved, and a repositories box with
 * more than a handful of lines is not the case this feature is for. A cap keeps one request from
 * becoming a fan-out of outbound probes.
 */
const MAX_URLS = 10

const resolveBody = z.strictObject({
  urls: z.array(z.string()).min(1).max(MAX_URLS),
})

export function createGitRoutes(deps: GitResolveDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.post('/api/v1/git/resolve-repositories', validate('json', resolveBody), async (c) => {
    const { urls } = c.req.valid('json')
    // In parallel, for the same reason `preflightRepositories` is: these are a handful of
    // requests made once, and a user typing a fourth line should not wait out three round trips.
    const resolutions = await Promise.all(urls.map((url) => resolveRepository(url, deps)))
    return success(c, { resolutions })
  })

  /*
   * The create form's repository picker (rockysurf-mh8f). Reads configuration and probes nothing,
   * so unlike its sibling above it costs one file read and no outbound request. Session-
   * authenticated on the same reasoning: these scope identities are already visible to every
   * authenticated user through k6xp's refusal message, which names every configured scope when
   * none of them matched.
   */
  routes.get('/api/v1/git/configured-scopes', (c) => success(c, { scopes: describeConfiguredScopes(deps) }))

  return routes
}
