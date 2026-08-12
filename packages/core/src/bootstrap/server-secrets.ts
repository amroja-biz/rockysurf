import type { ServerRow } from '../db/schema.js'
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
): (server: ServerRow) => Promise<Record<string, string>> {
  return async function loadServerSecrets(server: ServerRow): Promise<Record<string, string>> {
    const env: Record<string, string> = {}

    // The git token belongs to the USER — one token, reused across their servers — while the
    // desktop password belongs to the SERVER, because it is set on that box's `rocky` account.
    const githubToken = secrets.getGithubToken(server.userId)
    if (githubToken) env[SECRET_ENV_KEYS.githubToken] = githubToken

    const rdpPassword = secrets.getRdpPassword(server.id)
    if (rdpPassword) env[SECRET_ENV_KEYS.rdpPassword] = rdpPassword

    return env
  }
}
