import type { GithubTokenEntry } from '../config/schema.js'
import { getServerRepositories } from '../db/repositories/servers.js'
import type { ServerRow } from '../db/schema.js'
import { narrowTokensToRepositories } from '../git/token-matching.js'
import type { SecretsStore } from '../secrets/index.js'

/**
 * What a pack's install steps may read out of `secrets.env` (rockysurf-55fx.14).
 *
 * THE KEY NAMES ARE A CONTRACT, and this object is where it is defined. Every name here is a
 * promise to pack authors: a pack that reads `$GITHUB_TOKEN` must keep working, so the set is
 * deliberately small, closed, and documented in `docs/writing-a-pack.md` and the bootstrap
 * contract. Adding a name is a decision; a per-tool namespace is not offered, because it would
 * let packs depend on names core never agreed to and could not keep stable.
 *
 * Nothing was written here before. `loadServerSecrets` was an `AppDeps` hook that production
 * never supplied, so `secrets.env` was written empty in push mode and the callback secrets
 * endpoint served `{}` — meaning a private-repo clone or a remote-desktop pack failed for a
 * reason nothing in the logs explained.
 */
export const SECRET_ENV_KEYS = {
  /**
   * A git forge token, for cloning private repositories.
   *
   * NAMED FOR GITHUB ON PURPOSE, having considered a neutral `GIT_TOKEN`. Three reasons the
   * forge-specific name wins today:
   *
   *  - the credential IS a GitHub PAT everywhere else in the system — `github.pat` in the
   *    config schema, `github-token` as the secret kind, `getGithubToken` in the store — and a
   *    fourth name for the same thing is how a system starts lying about itself;
   *  - `gh`, `git`'s own credential helpers and a great many CI-aware scripts read
   *    `GITHUB_TOKEN` with no configuration, so a pack that shells out to `gh` works with no
   *    extra wiring — which matters on a box whose whole purpose is running coding agents;
   *  - it is honest about scope. Rocky Surf has exactly one forge credential in v0.1.
   *
   * When a second forge lands, the answer is another NAME here (`GITLAB_TOKEN`), not a rename:
   * renaming would break every pack written against this one, and the two can coexist.
   */
  githubToken: 'GITHUB_TOKEN',

  /**
   * The remote-desktop password for a `requiresRdp` pack.
   *
   * Already read by the resolver's `chpasswd` step, which fails loudly when it is missing —
   * so before this hook was supplied, every `requiresRdp` pack failed at that step.
   */
  rdpPassword: 'RDP_PASSWORD',
} as const

export type SecretEnvKey = (typeof SECRET_ENV_KEYS)[keyof typeof SECRET_ENV_KEYS]

/** Every name a pack may rely on, for docs and tests to assert against. */
export const SECRET_ENV_KEY_NAMES: readonly SecretEnvKey[] = Object.values(SECRET_ENV_KEYS)

/**
 * How the per-repository token SET reaches the box (rockysurf-ta7g).
 *
 * DELIBERATELY NOT PART OF `SECRET_ENV_KEYS`, which is the closed set of names packs may rely
 * on. These names carry a variable number of entries and exist for exactly one reader — the
 * git credential helper `bootstrap/resolver.ts` wires into the clone step — so promising them
 * to pack authors would freeze an internal encoding as a public contract. The `ROCKYSURF_`
 * prefix says whose they are; `GITHUB_TOKEN` remains the one name a pack should read, and it
 * still carries the instance-wide fallback and nothing else.
 *
 * SHAPE: `_COUNT` is how many entries follow, then `_1`…`_N` hold the tokens and
 * `_1_SCOPE`…`_N_SCOPE` hold `host/owner/repo` with `*` for "any". Always three segments, so
 * the helper's parsing is three parameter expansions and no loop. Indexed rather than one
 * delimited variable because `secrets.env` is `KEY=value` lines sourced by a shell: a value
 * cannot contain a newline, and one that contained a space would need quoting the writer does
 * not do.
 */
export const GITHUB_TOKEN_SET_ENV = {
  count: 'ROCKYSURF_GITHUB_TOKEN_COUNT',
  /** `ROCKYSURF_GITHUB_TOKEN_<i>` — the PAT for entry `i`, 1-based. */
  token: (index: number) => `ROCKYSURF_GITHUB_TOKEN_${index}`,
  /** `ROCKYSURF_GITHUB_TOKEN_<i>_SCOPE` — `host/owner/repo`, `*` meaning any. */
  scope: (index: number) => `ROCKYSURF_GITHUB_TOKEN_${index}_SCOPE`,
} as const

/** The host an entry that names none is anchored to. A GitHub PAT's home by default. */
export const DEFAULT_GITHUB_HOST = 'github.com'

/**
 * `host/owner/repo`, with `*` for the segments the entry left open.
 *
 * The wildcard is a literal `*` compared as a string, never a glob: the helper tests
 * `[ "$segment" = "*" ]` before comparing, so an owner genuinely called `*` is impossible
 * anyway (the schema's character class forbids it) and no pattern matching ever runs.
 */
export function githubTokenScope(entry: GithubTokenEntry): string {
  return [entry.host ?? DEFAULT_GITHUB_HOST, entry.owner ?? '*', entry.repo ?? '*'].join('/')
}

export interface ServerSecretsOptions {
  /**
   * `github.pat` from the config file — the instance-wide fallback for `GITHUB_TOKEN`
   * (rockysurf-yzae).
   *
   * WHY THE CONFIG VALUE IS PASSED IN RATHER THAN STORED AT BOOT. It would have been one line
   * for `boot()` to call `putGithubToken` with it, and that line would have been a bug: the
   * store would then hold a COPY with its own lifetime, and rotating the token the documented
   * way — edit `rockysurf.config.yaml` or the `${GITHUB_PAT}` it interpolates, restart —
   * would leave the stale row shadowing the new value forever, with the config file reading
   * correctly and every clone still using the old token. This is the same reasoning
   * `PROVIDER_CREDENTIAL_ENV` in `secrets/store.ts` is built on: a credential that arrives as
   * configuration is configuration, and never becomes data. Nothing here writes to the
   * database, so there is no second copy to go stale and no refuse-to-persist rule needed to
   * keep one from appearing.
   *
   * THE STORED TOKEN WINS, and that ordering is deliberate rather than incidental. A row in
   * the store is per-USER and can only exist because someone deliberately put it there;
   * `github.pat` is per-INSTANCE. When a route to store a personal token lands
   * (rockysurf-0rw3), "my token beats the operator's default" is the behaviour that route
   * needs, and it gets it for free. Today no production code calls `putGithubToken`, so this
   * is always the config value.
   *
   * INSTANCE-WIDE MEANS EVERY BOX. In `github-device` auth mode more than one person can hold
   * an account, and this token is handed to whichever of them creates a server. Scope the PAT
   * accordingly — `docs/self-hosting.md` and `SECURITY.md` say so in as many words.
   */
  githubPat?: string

  /**
   * `github.tokens` from the config file — a PAT per repository, owner or host
   * (rockysurf-ta7g).
   *
   * SAME CUSTODY AS `githubPat`, for the same reason: read at boot, passed here, never
   * written to the store, so rotation stays "edit the file and restart" and there is no second
   * copy to shadow it. Nothing new is persisted and no route returns any of it.
   *
   * PRECEDENCE IS SPECIFICITY FIRST, then provenance. A repo-scoped entry beats an
   * owner-scoped one beats a host-scoped one beats the unscoped fallback; within one tier, a
   * value someone deliberately STORED beats one that came from configuration. Today the store
   * holds only unscoped per-user rows, so the rule reduces to yzae's `stored ?? config.pat`
   * for the fallback tier and leaves the scoped tiers to configuration — which is also what
   * makes rockysurf-0rw3 compose rather than collide: a stored token that later gains a scope
   * enters the tier it names and wins there, without this rule changing.
   *
   * The selection itself happens BOX-SIDE, in the credential helper, because that is the only
   * place that knows which URL git is actually asking about: the helper protocol hands it the
   * host and path on stdin. Core cannot choose here — one `secrets.env` serves every clone the
   * box will ever run, including ones a user adds by hand afterwards.
   *
   * WHAT REACHES ONE BOX IS NARROWED (rockysurf-18lq). Core still cannot make the box's choice,
   * and does not try to: what it can do is decline to hand a box tokens for repositories nobody
   * told it about. The set written into this server's `secrets.env` is
   * `narrowTokensToRepositories(githubTokens, server.repositories)` — see that function for why
   * this cannot change the outcome of any declared repository's clone, and for what it does
   * cost.
   */
  githubTokens?: readonly GithubTokenEntry[]
}

/**
 * Build the `loadServerSecrets` hook production runs.
 *
 * Both topologies use the same function, which is the point: push writes the result to
 * `secrets.env` at 0600, and the callback endpoint serves the same material to a box that
 * fetched its own plan. One source means the two cannot drift into offering different
 * environments for the same pack.
 *
 * ABSENT KEYS ARE OMITTED, never emitted empty. `RDP_PASSWORD=` would satisfy the resolver's
 * `-z` guard and then set an empty desktop password; a missing key makes that step fail with
 * the message it already has.
 */
export function createServerSecretsLoader(
  secrets: SecretsStore,
  options: ServerSecretsOptions = {},
): (server: ServerRow) => Promise<Record<string, string>> {
  return async function loadServerSecrets(server: ServerRow): Promise<Record<string, string>> {
    const env: Record<string, string> = {}

    // The git token belongs to the USER — one token, reused across their servers — while the
    // desktop password belongs to the SERVER, because it is set on that box's `rocky` account.
    const githubToken = secrets.getGithubToken(server.userId) ?? options.githubPat
    if (githubToken) env[SECRET_ENV_KEYS.githubToken] = githubToken

    /*
     * The scoped set rides ALONGSIDE the fallback rather than replacing it: a box configured
     * with per-repo tokens and no `github.pat` gets no `GITHUB_TOKEN`, and a pack that shells
     * out to `gh` correctly finds nothing rather than a token for someone else's repository.
     *
     * THE FALLBACK IS NOT NARROWED, and that is the ruling rather than an oversight
     * (rockysurf-18lq). Narrowing asks "which of these tokens does this box's work need"; the
     * fallback's answer is always yes, because it is not a token for a repository — it is the
     * instance's general-purpose GitHub credential, and it is the one every pack guide promises
     * (`docs/writing-a-pack.md`: `gh auth setup-git` works "when configured"). Shipping it only
     * when some declared repository failed to match a scoped entry would make that promise
     * depend on which repositories a user happened to type, and would silently break `gh` on
     * exactly the boxes with the tidiest configuration — every private repo covered by a scoped
     * entry, therefore no fallback, therefore no `GITHUB_TOKEN`. It ships whenever it is
     * configured, as it always has.
     *
     * The SCOPED entries are narrowed to the ones this server's declared repositories select.
     */
    const tokens = narrowTokensToRepositories(options.githubTokens ?? [], getServerRepositories(server))
    if (tokens.length > 0) {
      env[GITHUB_TOKEN_SET_ENV.count] = String(tokens.length)
      tokens.forEach((entry, i) => {
        env[GITHUB_TOKEN_SET_ENV.token(i + 1)] = entry.pat
        env[GITHUB_TOKEN_SET_ENV.scope(i + 1)] = githubTokenScope(entry)
      })
    }

    const rdpPassword = secrets.getRdpPassword(server.id)
    if (rdpPassword) env[SECRET_ENV_KEYS.rdpPassword] = rdpPassword

    return env
  }
}
