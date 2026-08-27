import { z } from 'zod'

/**
 * The names Rocky Surf itself puts in front of a bootstrap step, and the rules any OTHER name
 * that joins that environment has to satisfy.
 *
 * WHY THIS IS ITS OWN MODULE, having started life inside `packs/schema.ts` (issue #189). The
 * list was written as "every name a pack's `inputs` may not claim", which was true while a pack
 * was the only thing that could contribute a variable. Issue #197 adds a second contributor —
 * the person creating the server, through the Environment field — and the two must be refused
 * by exactly the same list: a name that would break `agent.sh` breaks it whoever sent it. One
 * definition, two callers, is the only shape in which that stays true. `packs/schema.ts` is the
 * pack FILE FORMAT; which environment variable names are already taken is a fact about the
 * bootstrap environment, so it lives here and the format file consults it.
 *
 * `bootstrap/server-secrets.test.ts` asserts `SECRET_ENV_KEY_NAMES` is a subset of
 * `RESERVED_ENV_NAMES`, so a future name added to the `secrets.env` contract cannot quietly
 * become claimable by a pack or by a user.
 *
 * Sources, in the order a reader should check them:
 *  - `bootstrap/agent.sh`: `ARCH`, `DEBIAN_FRONTEND`, `HOME`, `USER`, `LOGNAME`;
 *  - `bootstrap/server-secrets.ts` `SECRET_ENV_KEYS`: `GITHUB_TOKEN`, `RDP_PASSWORD`;
 *  - `bootstrap/resolver.ts` `setupPreamble`: `REPOS`, and the `GIT_*` names below;
 *  - the shell itself: `PATH`, `SHELL`, `PWD`, `IFS`, and the rest.
 */
export const RESERVED_ENV_NAMES: ReadonlySet<string> = new Set([
  // the agent's own environment
  'ARCH',
  'DEBIAN_FRONTEND',
  'HOME',
  'USER',
  'LOGNAME',
  // the secrets.env key-name contract
  'GITHUB_TOKEN',
  'RDP_PASSWORD',
  // the setup/user-script preamble
  'REPOS',
  /*
   * THE GIT NAMES THE PREAMBLE ACTUALLY WRITES, and nothing else (issue #197).
   *
   * `GIT_` used to be refused as a whole prefix, which cost a user `GIT_AUTHOR_NAME`,
   * `GIT_AUTHOR_EMAIL`, `GIT_SSH_COMMAND` and every other name git reads but Rocky Surf never
   * writes — refused to protect four variables. These four are the ones
   * `SETUP_GIT_AUTH_PREAMBLE` and the clone step export, and setting one of them really would
   * break the credential path for every private clone on the box, so they stay reserved by
   * exact name. `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` are indexed and therefore stay
   * prefixes below — an exact-name list cannot close a name with a number in it.
   */
  'GIT_TERMINAL_PROMPT',
  'GIT_CONFIG_COUNT',
  // the shell's own, where a supplied value would break the step rather than reach it
  'PATH',
  'SHELL',
  'PWD',
  'OLDPWD',
  'IFS',
  'LANG',
  'LC_ALL',
  'TERM',
  'BASH_ENV',
  'ENV',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
])

/**
 * Whole NAMESPACES nobody may claim, checked as prefixes.
 *
 * A prefix is the right tool for exactly one situation: a name Rocky Surf generates with an
 * INDEX in it, which no exact-name list can enumerate. `ROCKYSURF_` is core's own
 * (`ROCKYSURF_GITHUB_TOKEN_<n>`, `ROCKYSURF_STATE_DIR`, `ROCKYSURF_APT_RETRY_WAIT_S`);
 * `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` are git's environment form of `-c`, written
 * by the setup preamble whenever the box carries a token.
 *
 * Everything else git reads — `GIT_AUTHOR_NAME`, `GIT_SSH_COMMAND`, `GIT_PAGER` — is now
 * ACCEPTED (issue #197). Rocky Surf does not write those, so refusing them protected nothing
 * and cost a user the ability to configure git on their own box.
 */
export const RESERVED_ENV_PREFIXES: readonly string[] = ['ROCKYSURF_', 'GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_']

/**
 * How much text one variable may carry, at rest and on the wire.
 *
 * 4 KiB is generous for what these fields are for — a flag, a key, an endpoint, a model name —
 * and small enough that a boxful of them cannot make a server row or a `secrets.env` line
 * unbounded. Anything that wants to hand a box a document wants a repository, not a variable.
 */
export const ENV_VALUE_MAX_BYTES = 4096

/**
 * How much one server's supplied environment may weigh in total, per source.
 *
 * Bounded separately from the per-value ceiling because a dozen maximum-length values is tens
 * of KiB of `secrets.env` on a box, of JSON in a column, and of request body — each
 * individually within its own limit. The number is the per-value ceiling times four, which is
 * roomier than any real pack or any hand-typed environment and still an order of magnitude
 * below anything that would matter.
 */
export const ENV_TOTAL_MAX_BYTES = ENV_VALUE_MAX_BYTES * 4

/**
 * An environment variable name, spelled the way shell scripts spell one, and not one of ours.
 *
 * The same schema validates a pack's declared `inputs` (issue #189) and a user's own
 * Environment lines (issue #197). Deliberately: the box cannot tell the two apart, so a rule
 * that held for one and not the other would be a rule about paperwork rather than about what
 * survives on the machine.
 */
export const envVarNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/, {
    error: 'must be an UPPER_SNAKE_CASE environment variable name (e.g. "HEADLONG_HEADLESS")',
  })
  .refine((name) => !RESERVED_ENV_NAMES.has(name), {
    error: "is a name Rocky Surf already exports to every step — choose one in your own namespace",
  })
  .refine((name) => !RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)), {
    error: `must not start with ${RESERVED_ENV_PREFIXES.join(' or ')} — Rocky Surf generates those names with an index and cannot list them all`,
  })

/**
 * ONE VALUE, ONE LINE — the constraint the delivery mechanism imposes, stated where the value
 * is validated.
 *
 * Values reach the box through `secrets.env`, which is `KEY=value` lines that `agent.sh`
 * sources and whose NAMES it re-reads line by line to build the explicit environment an
 * unprivileged step receives. A value containing a newline would appear to that reader as a
 * second variable, so the second line of somebody's PEM would become an environment variable
 * name. Values are single-quoted by the writer (`bootstrap/push.ts`), which makes spaces, `$`
 * and backticks safe; a newline it cannot make safe, so it is refused here.
 */
export const envVarValueSchema = z
  .string()
  // BYTES, not characters, and the distinction is the reason this is a refine rather than
  // zod's `.max()`: the ceiling is about what a `secrets.env` line and a database column carry,
  // and a 4096-character value of three-byte glyphs is three times the number quoted here.
  .refine((value) => Buffer.byteLength(value, 'utf8') <= ENV_VALUE_MAX_BYTES, {
    error: `must be at most ${ENV_VALUE_MAX_BYTES} bytes`,
  })
  .refine((value) => !/[\n\r\0]/.test(value), {
    error: 'must be a single line — no newlines or NUL (values travel as KEY=value lines in secrets.env)',
  })
