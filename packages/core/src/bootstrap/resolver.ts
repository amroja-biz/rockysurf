import type { ToolRow } from '../db/schema.js'
import { brandingScript } from './branding.js'
import { PLAN_VERSION, type BootstrapMode, type InstallPlan, type InstallStep } from './plan.js'
import { shellQuote } from './shell.js'

/**
 * Rendering an InstallPlan from pack data.
 *
 * The six-phase order is `docs/bootstrap-contract.md` § Step ordering, and it is not a
 * preference: setup scripts run after clones because a setup script may read `$REPOS`, and
 * branding runs after both because it describes a box that already exists.
 *
 * Determinism is a conformance requirement, not a nicety. A snapshotted plan has to render
 * identically twice or resume across a re-render skips the wrong work — so ties on
 * `installOrder` break on `toolId` ascending, and nothing here reads the clock or a random
 * source. The one genuinely per-attempt value, `runId`, is an input.
 */

export interface ResolvablePack {
  id: string
  /** Tool ids, in any order — `installOrder` decides execution. */
  tools: string[]
  requiresRdp: boolean
  desktop?: string | null
}

export interface ResolveInstallPlanInput {
  serverId: string
  /** Minted by core per bootstrap attempt. See ADR-0002 Decision 6 / amendment E6. */
  runId: string
  mode: BootstrapMode
  /** Required in callback mode. */
  callbackUrl?: string
  pack: ResolvablePack
  /** Every known tool, typically every row the pack loader synced. */
  tools: ToolRow[]
  /** Repository clone URLs the user chose. Ignored when the pack does not want repos. */
  repositories?: string[]
  /** Off only for tests and for a box the operator wants left alone. */
  branding?: boolean
  /**
   * The key the user pasted at create time, normalized (ADR-0008, issue #92). Required
   * together with `managedPublicKey` to render phase 7 — see `suppliedKeyOnlyScript`. Absent
   * for every server with no supplied key, which never gets this step.
   */
  userSuppliedPublicKey?: string
  /**
   * Core's own newly-minted public key line — `ProvisionKeys.sshPublicKeys[0]`. Threaded in
   * from the caller rather than read off the row, because the row never stores the blob, only
   * a fingerprint of it.
   */
  managedPublicKey?: string
}

/** Labels come from the server row's progress vocabulary, and several steps share one. */
const REPORTS = {
  tools: 'installing_tools',
  repos: 'cloning_repos',
  setup: 'tools_installed',
  finishing: 'ready',
} as const

/** Long enough for a desktop environment on a small box, short enough to not hang forever. */
const DEFAULT_TOOL_TIMEOUT_SECONDS = 1800

export function resolveInstallPlan(input: ResolveInstallPlanInput): InstallPlan {
  const byId = new Map(input.tools.map((t) => [t.id, t]))
  const steps: InstallStep[] = []

  /** (installOrder, toolId) ascending — the documented tie-break. */
  const inExecutionOrder = (rows: ToolRow[]) =>
    [...rows].sort((a, b) => a.installOrder - b.installOrder || a.id.localeCompare(b.id))

  const toolStep = (tool: ToolRow): InstallStep => ({
    id: `tool:${tool.id}`,
    reports: REPORTS.tools,
    runAs: tool.runAs === 'root' ? 'root' : 'rocky',
    run: tool.installScript,
    timeoutSeconds: DEFAULT_TOOL_TIMEOUT_SECONDS,
  })

  /* --- phase 1: runtime-guaranteed base tools, whether or not the pack lists them --- */
  const bootstrapTools = inExecutionOrder(input.tools.filter((t) => t.bootstrap && t.enabled))
  for (const tool of bootstrapTools) steps.push(toolStep(tool))

  /* --- phase 2: the pack's own tools --- */
  const bootstrapIds = new Set(bootstrapTools.map((t) => t.id))
  const packTools = inExecutionOrder(
    input.pack.tools
      .flatMap((id) => {
        const tool = byId.get(id)
        return tool ? [tool] : []
      })
      // A disabled tool is skipped rather than failing the render: an operator disabling a
      // tool should stop it being installed, not stop servers being created.
      .filter((t) => t.enabled && !bootstrapIds.has(t.id)),
  )
  for (const tool of packTools) steps.push(toolStep(tool))

  /* --- phase 3: repository clones --- */
  const repositories = input.repositories ?? []
  for (const url of repositories) {
    steps.push({
      id: `repo:${repoDirName(url)}`,
      reports: REPORTS.repos,
      runAs: 'rocky',
      run: cloneScript(url),
      // A repository that does not clone is not a reason to withhold the machine (owner
      // ruling, ADR-0010): the box comes up with its tools, and the row says plainly which
      // repository is not on it and why — the clone's log is captured as a warning. The user
      // can clone by hand or fix the URL and create again. Contrast a failed TOOL install,
      // which is required and releases the machine.
      optional: true,
      timeoutSeconds: 600,
    })
  }

  /* --- phase 4: setup scripts, in the same order as phase 2 --- */
  for (const tool of [...bootstrapTools, ...packTools]) {
    if (!tool.setupScript) continue
    steps.push({
      id: `tool-setup:${tool.id}`,
      reports: REPORTS.setup,
      runAs: tool.runAs === 'root' ? 'root' : 'rocky',
      // `$REPOS` is documented to setup scripts in writing-a-pack.md, and the frozen plan
      // schema has no env field — so it is exported by the step itself. Data, not a schema
      // change, and it keeps the value visible in the snapshot. The same preamble hands the
      // script the clone step's git credentials; see `setupPreamble`.
      run: `${setupPreamble(repositories)}${tool.setupScript}`,
      timeoutSeconds: DEFAULT_TOOL_TIMEOUT_SECONDS,
    })
  }

  /* --- phase 5: branding --- */
  if (input.branding !== false) {
    steps.push({
      id: 'branding',
      reports: REPORTS.finishing,
      runAs: 'root',
      run: brandingScript(input.serverId),
      // Cosmetic. A box that works but has a plain MOTD is not a failed bootstrap.
      optional: true,
      timeoutSeconds: 60,
    })
  }

  /* --- phase 6: remote desktop password --- */
  if (input.pack.requiresRdp) {
    steps.push({
      id: 'rdp',
      reports: REPORTS.finishing,
      runAs: 'root',
      run: rdpScript(),
      timeoutSeconds: 60,
    })
  }

  /* --- phase 7: retire core's own key once the user supplied one (ADR-0008, issue #92) --- */
  // LAST, after every step that needs SSH — which in push mode is all of them, over the one
  // connection this whole drive holds open. Removing the authorized_keys LINE mid-session does
  // not close that already-authenticated SESSION (sshd only re-checks the file on a NEW
  // connection), so this step can safely be the final thing the plan does.
  if (input.userSuppliedPublicKey && input.managedPublicKey) {
    steps.push({
      id: 'supplied-key-only',
      reports: REPORTS.finishing,
      runAs: 'rocky',
      run: suppliedKeyOnlyScript(input.userSuppliedPublicKey, input.managedPublicKey),
      check: suppliedKeyOnlyCheck(input.userSuppliedPublicKey, input.managedPublicKey),
      timeoutSeconds: 60,
    })
  }

  const plan: InstallPlan = {
    version: PLAN_VERSION,
    serverId: input.serverId,
    mode: input.mode,
    runId: input.runId,
    ...(input.callbackUrl ? { callbackUrl: input.callbackUrl } : {}),
    steps,
  }
  return plan
}

/** `https://github.com/a/b.git` → `b`. The clone directory and the step id both use it. */
export function repoDirName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  const last = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return last.replace(/\.git$/, '') || 'repo'
}

/**
 * The git credential helper the clone step wires in, as the shell program git will run.
 *
 * WHY THE CHOICE IS MADE HERE AND NOT IN CORE (rockysurf-ta7g). One `secrets.env` serves every
 * clone a box will ever run — the ones in its plan, and the ones a user types by hand a month
 * later — so core cannot pick a token per repository even in principle; it does not know the
 * question. The credential protocol does: git writes `protocol=`, `host=` and (with
 * `credential.useHttpPath=true`) `path=` to the helper's stdin and reads a `username=` /
 * `password=` pair back. Selecting on that input is a few lines of shell, and it puts the
 * decision at the only place holding both the URL and the token set.
 *
 * MOST-SPECIFIC WINS: a scope naming host, owner and repo outranks one naming host and owner,
 * which outranks one naming host alone, which outranks `$GITHUB_TOKEN` — the instance-wide
 * fallback, used when no entry matches, which is exactly what every pre-ta7g install did. When
 * nothing matches AND there is no fallback the helper prints NOTHING and exits 0, which git
 * reads as "this helper has no opinion": a public clone through a box that happens to hold
 * tokens for private repositories is unaffected, and no token is offered to a host no one
 * named.
 *
 * POSIX SHELL ONLY, and the constraint is real rather than stylistic: git runs a `!`-prefixed
 * helper through `sh -c`, which on Debian is dash. Hence no arrays (the entries are read with
 * `eval` on a name built from a counter, and only the NAME is ever eval'd — the values arrive
 * through parameter expansion, which is not re-scanned), no `${x,,}` (a `tr` pipe lowercases
 * instead, because GitHub hosts, owners and repositories are case-insensitive while `[ = ]` is
 * not), and no single quotes ANYWHERE in this string, because the whole program is embedded in
 * a single-quoted word in the generated bash. A `'` here would end that word and change the
 * command; `resolver.test.ts` asserts its absence so the next edit cannot introduce one
 * quietly.
 *
 * The token still never reaches argv: it is read from the environment inside the helper, at the
 * moment git asks.
 *
 * THE BODY IS SHARED WITH THE CLONE STEP'S FAILURE DIAGNOSIS (rockysurf-ldo1). When a clone
 * fails auth-shaped, the step needs to know whether ANY delivered token would have been offered
 * for this URL — and the only implementation allowed to answer is this one, because a second
 * copy of the matching rules would have nothing pinning it to the first (`token-matching.ts`
 * ports these rules to TypeScript and a differential test pins the pair; a third would drift).
 * So the generated script defines the same `f` from `GIT_CREDENTIAL_HELPER_BODY` and asks it.
 */
export const GIT_CREDENTIAL_HELPER_BODY = `f() {
  h= p=
  while IFS= read -r l; do
    case $l in
      host=*) h=\${l#host=} ;;
      path=*) p=\${l#path=} ;;
    esac
  done
  h=$(printf %s "$h" | tr A-Z a-z)
  p=$(printf %s "$p" | tr A-Z a-z)
  p=\${p%.git}
  case $p in
    */*) o=\${p%%/*}; r=\${p#*/}; r=\${r%%/*} ;;
    *) o=$p; r= ;;
  esac
  t=\${GITHUB_TOKEN:-} b=0 i=1
  while [ "$i" -le "\${ROCKYSURF_GITHUB_TOKEN_COUNT:-0}" ]; do
    eval s=\\\${ROCKYSURF_GITHUB_TOKEN_\${i}_SCOPE:-} v=\\\${ROCKYSURF_GITHUB_TOKEN_$i:-}
    mh=\${s%%/*}; q=\${s#*/}; mo=\${q%%/*}; mr=\${q#*/}; n=1
    [ "$mo" = "*" ] || n=$((n+1))
    [ "$mr" = "*" ] || n=$((n+1))
    if [ "$mh" = "$h" ] && { [ "$mo" = "*" ] || [ "$mo" = "$o" ]; } && { [ "$mr" = "*" ] || [ "$mr" = "$r" ]; } && [ "$n" -gt "$b" ]; then
      b=$n t=$v
    fi
    i=$((i+1))
  done
  [ -n "$t" ] || exit 0
  printf "username=x-access-token\\npassword=%s\\n" "$t"
}`

export const GIT_CREDENTIAL_HELPER = `!${GIT_CREDENTIAL_HELPER_BODY}; f`

/**
 * Every setup script starts with this. `$REPOS` is the documented part; the rest is what
 * makes `$REPOS` usable when the repositories are private (issue #142).
 *
 * A setup script runs AFTER the clones precisely so it can do per-repository work, and some
 * of that work is git — `gt rig add` clones the repository a second time, bare, on its own.
 * The clone step authenticates through a credential helper it wires in with `-c` for that one
 * git invocation, so nothing of it survives into phase 4: the tokens are in the environment
 * (secrets.env is forwarded to every unprivileged step) but no git run by a setup script had
 * any way to use them. Against a private repository that git hung on a username prompt with
 * no TTY and died with "could not read Username for https://github.com: No such device or
 * address", which is the whole of #142.
 *
 * The remedy is the SAME helper, delivered the only way that reaches git processes the script
 * does not start itself: git's `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`
 * environment (git ≥ 2.31; Ubuntu 24.04 ships 2.43), which every git in the step's process
 * tree reads as if the pairs had been passed with `-c`. The three custody properties the
 * clone step is built on hold unchanged: the token never reaches argv (the helper reads it
 * from the environment at the moment git asks), never reaches any `.gitconfig` or
 * `.git/config` (the environment dies with the step), and a box with no tokens gets plain
 * anonymous git — the `if` is the clone step's own guard, so the two can never disagree about
 * when a helper is offered.
 *
 * `GIT_TERMINAL_PROMPT=0` is there for the failure mode that remains — a private repository
 * on a box that carries no token for it — so it fails in git's stable "terminal prompts
 * disabled" wording instead of the "No such device or address" the user in #142 had to read.
 *
 * Exported as a constant rather than assembled inline so the test that runs REAL git against
 * it cannot drift from the preamble a box receives.
 */
export const SETUP_GIT_AUTH_PREAMBLE = [
  'export GIT_TERMINAL_PROMPT=0',
  'if [ -n "${GITHUB_TOKEN:-}" ] || [ "${ROCKYSURF_GITHUB_TOKEN_COUNT:-0}" -gt 0 ]; then',
  '  export GIT_CONFIG_COUNT=2',
  '  export GIT_CONFIG_KEY_0=credential.useHttpPath GIT_CONFIG_VALUE_0=true',
  `  export GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1='${GIT_CREDENTIAL_HELPER}'`,
  'fi',
  '',
].join('\n')

function setupPreamble(repositories: string[]): string {
  return `export REPOS=${shellQuote(repositories.join(','))}\n${SETUP_GIT_AUTH_PREAMBLE}`
}

/**
 * How the no-matching-token sentence begins, exported so the tests that assert it arrives in a
 * row's `errorMessage` cannot drift from the script that prints it (rockysurf-ldo1).
 */
export const NO_MATCHING_TOKEN_PREFIX = 'no access token matched '

/**
 * Idempotent by construction, because the resume path re-runs an interrupted step: a second
 * run finds the checkout and updates its remote instead of failing the way a bare
 * `git clone` into an existing directory does.
 *
 * PRIVATE REPOSITORIES (rockysurf-55fx.14). When `GITHUB_TOKEN` is present in the environment —
 * delivered through `secrets.env`, see `bootstrap/server-secrets.ts` — the clone authenticates
 * with it. Three properties matter and each rules out a simpler approach:
 *
 *  - the token never reaches **argv**, because `ps` is readable by every unprivileged step this
 *    same agent is about to run. The `-c` value is a shell function that reads the variable at
 *    run time; the secret itself is never a command-line argument;
 *  - the token never reaches **`.git/config`**, because `-c` applies to this invocation only.
 *    Rewriting the remote to `https://token@github.com/…` would persist the credential into
 *    the checkout, where it survives the box outliving its purpose and lands in any backup;
 *  - a PUBLIC clone is unaffected: with no token set the helper contributes nothing and git
 *    proceeds anonymously, so a pack that clones public repos needs no credential at all.
 *
 * ONE TOKEN PER REPOSITORY (rockysurf-ta7g). All three properties survive unchanged, because
 * the only thing that grew is the helper's decision about WHICH token to print — the secrets
 * still arrive in the environment and still never touch argv or `.git/config`. See
 * `GIT_CREDENTIAL_HELPER` for why the selection has to happen here rather than in core.
 *
 * THE NO-MATCHING-TOKEN FAILURE IS TRANSLATED HERE (rockysurf-ldo1), because this is the last
 * place that can put a human sentence where the user will read it: `agent.sh` tees the step's
 * output into the step log, `mark_failed` journals the tail, and the supervisor's `lastLineOf`
 * makes the LAST non-empty line the row's `errorMessage` — so the sentence must be printed
 * after git's own output, and must fit ~200 characters. Three deliberate choices:
 *
 *  - `GIT_TERMINAL_PROMPT=0`, so a failed credential lookup is git's stable "terminal prompts
 *    disabled" instead of the baffling "could not read Username …: No such device or address"
 *    a prompt with no TTY produces;
 *  - the diagnosis is made AT RUN TIME by asking the helper itself — the same `f` git just
 *    consulted, fed the same protocol — so it cannot drift from the decision it explains and
 *    cannot go stale the way a create-time prediction baked into the plan would (a plan is
 *    snapshotted once; this step can run weeks later);
 *  - CUSTODY: the helper prints `password=<PAT>` when something matches, and this step's stdout
 *    becomes a status field broadcast to the SPA. Its output therefore goes NOWHERE but a byte
 *    count — `| wc -c` — and the sentence itself names scope identities only, never values.
 *
 * The sentence is gated on BOTH signals: git failed with auth-shaped output AND the helper
 *  offers nothing for this URL. A bad URL on a 404-ing host, a network failure, or a token that
 * WAS offered and rejected (revoked, say — that is `unauthorized`, a different diagnosis) all
 * fall through and keep git's own last line.
 */
function cloneScript(url: string): string {
  const dir = `"$HOME"/${repoDirName(url)}`
  return [
    'set -euo pipefail',
    'export GIT_TERMINAL_PROMPT=0',
    `url=${shellQuote(url)}`,
    `dir=${dir}`,
    'git_auth=()',
    // Wired when there is anything at all to contribute — an instance-wide token, a scoped
    // set, or both. With neither, the array stays empty and git clones anonymously.
    'if [ -n "${GITHUB_TOKEN:-}" ] || [ "${ROCKYSURF_GITHUB_TOKEN_COUNT:-0}" -gt 0 ]; then',
    // `useHttpPath` is what makes per-repo selection possible AT ALL: git omits `path=` from
    // the helper's stdin unless it is set, so without this line every request would look like
    // "something on github.com" and only the fallback could ever be chosen.
    `  git_auth=(-c credential.useHttpPath=true -c credential.helper='${GIT_CREDENTIAL_HELPER}')`,
    'fi',
    // `|| rc=$?` keeps `set -e` from aborting before the failure can be explained; the step
    // still exits with git's own status. Output is captured so the auth-shaped test can read
    // it, and re-printed verbatim so the step log holds exactly what it always held.
    'rc=0',
    // `${git_auth[@]+…}`, the same idiom agent.sh uses for SECRET_NAMES: under `set -u` an
    // EMPTY array expansion is "unbound" on bash < 4.4, and the anonymous-clone path is
    // exactly the one with an empty array.
    'if [ -d "$dir/.git" ]; then',
    '  git -C "$dir" remote set-url origin "$url"',
    '  out=$(git ${git_auth[@]+"${git_auth[@]}"} -C "$dir" fetch --all --prune 2>&1) || rc=$?',
    'else',
    '  out=$(git ${git_auth[@]+"${git_auth[@]}"} clone "$url" "$dir" 2>&1) || rc=$?',
    'fi',
    "printf '%s\\n' \"$out\"",
    'if [ "$rc" -ne 0 ]; then',
    '  case $out in',
    '    *"terminal prompts disabled"* | *"could not read Username"* | *"Authentication failed"* | *"Invalid username or password"*)',
    // The same helper git ran, defined from the same source string — see
    // GIT_CREDENTIAL_HELPER_BODY for why no second implementation is allowed to answer this.
    `      ${GIT_CREDENTIAL_HELPER_BODY}`,
    // The URL split mirrors git's own credential request: host after the scheme (userinfo
    // dropped), path with trailing slashes dropped — `credentialQueryFor` in core does the same.
    '      rest=${url#*://}',
    '      host=${rest%%/*}; host=${host##*@}',
    '      rpath=${rest#*/}; [ "$rpath" != "$rest" ] || rpath=',
    '      while [ "${rpath%/}" != "$rpath" ]; do rpath=${rpath%/}; done',
    // CUSTODY: `f` prints the winning PAT. It is piped straight into a byte count and reaches
    // neither stdout nor the step log; only "did it offer anything" survives.
    '      offered=$(printf \'host=%s\\npath=%s\\n\' "$host" "$rpath" | f | wc -c)',
    '      if [ "$offered" -eq 0 ]; then',
    '        scopes= i=1',
    '        while [ "$i" -le "${ROCKYSURF_GITHUB_TOKEN_COUNT:-0}" ]; do',
    '          eval sc=\\${ROCKYSURF_GITHUB_TOKEN_${i}_SCOPE:-}',
    '          scopes="${scopes:+$scopes, }$sc"',
    '          i=$((i+1))',
    '        done',
    '        if [ -n "$scopes" ]; then carries="tokens scoped to $scopes"; else carries="no GitHub tokens"; fi',
    // Printed LAST and kept under ~200 chars: `lastLineOf` in supervisor.ts takes the final
    // non-empty line of the journalled tail as the row's errorMessage. Scope names only.
    `        echo "${NO_MATCHING_TOKEN_PREFIX}$host/\${rpath%.git}; this box carries $carries — add a matching token or a fallback pat in Settings, then create again"`,
    '      fi',
    '      ;;',
    '  esac',
    'fi',
    'exit "$rc"',
    '',
  ].join('\n')
}

/**
 * The password arrives in the environment from the pushed secrets file and goes to `chpasswd`
 * on STDIN. Never argv: everything in argv is readable through `ps` by every unprivileged
 * step this same agent is about to run.
 */
function rdpScript(): string {
  return [
    'set -euo pipefail',
    'if [ -z "${RDP_PASSWORD:-}" ]; then',
    '  echo "RDP_PASSWORD is not set — the pack requires a remote desktop password" >&2',
    '  exit 1',
    'fi',
    'printf \'rocky:%s\\n\' "$RDP_PASSWORD" | chpasswd',
    '',
  ].join('\n')
}

/**
 * Retire core's own managed key from `authorized_keys`, once the user's supplied key is
 * confirmed to already be there (ADR-0008, issue #92: "the user asked for their key, two
 * standing keys is not what they asked for; RS's key is a provisioning tool, not a standing
 * credential").
 *
 * SURGICAL, NOT A REWRITE. The tempting version — overwrite the file with just the supplied
 * key — is wrong in general: a BYO host's `authorized_keys` may already hold the operator's OWN
 * pre-existing access from before Rocky Surf ever touched the box (`provider-byo/prepare.ts`
 * appends to it for exactly that reason, and `docs/self-hosting.md` documents it), and this
 * step has no way to tell that access apart from noise. So it removes exactly the one line it
 * knows the exact bytes of, because it minted them, and leaves every other line — however it
 * got there — alone.
 *
 * THE GUARD IS WHAT MAKES "NEVER LOCK THE USER OUT" TRUE. `grep -qxF` on the user's line runs
 * BEFORE anything is removed, under `set -euo pipefail`, so a guard that does not match aborts
 * the script before the `grep -v`/`mv` pair ever runs — core's key stays authorized.
 *
 * REQUIRED, NOT OPTIONAL (unlike `branding`). If the guard fails, this step fails, and because
 * it carries no `optional: true` that fails the WHOLE plan. That is deliberate: the guard
 * failing at all means the box does not have the key core was told to also authorize, which is
 * not a state worth finishing past silently. Two failure shapes reach core, and both leave the
 * box with both keys still authorized and `failed`/diagnosable rather than losing anyone's
 * access — a step BEFORE this one failing (this step never runs) and this step's own guard
 * failing (it runs and refuses) look identical from core's side. Core only retires its OWN
 * stored private key (`retireManagedUserKey`, `ssh/server-keys.ts`) when the whole plan —
 * including this step — reports success, so a failed guard here also means core keeps holding
 * a key it can still use if a human has to intervene.
 */
function suppliedKeyOnlyScript(userPublicKey: string, managedPublicKey: string): string {
  return [
    'set -euo pipefail',
    'auth="$HOME"/.ssh/authorized_keys',
    `user_line=${shellQuote(userPublicKey.trim())}`,
    `managed_line=${shellQuote(managedPublicKey.trim())}`,
    // -x -F: a whole-line literal match, so core's key can never be read as a prefix or
    // substring of some other line, and the user's key can never be "found" inside a longer one.
    'grep -qxF -- "$user_line" "$auth"',
    'grep -vxF -- "$managed_line" "$auth" > "$auth.tmp"',
    'mv "$auth.tmp" "$auth"',
    '',
  ].join('\n')
}

/**
 * Independent re-verification after `suppliedKeyOnlyScript` runs, the same discipline every
 * other step's `check` applies: `run` exiting 0 says the script didn't error, not that the file
 * ended up the way it was supposed to.
 */
function suppliedKeyOnlyCheck(userPublicKey: string, managedPublicKey: string): string {
  const auth = '"$HOME"/.ssh/authorized_keys'
  const userLine = shellQuote(userPublicKey.trim())
  const managedLine = shellQuote(managedPublicKey.trim())
  return `grep -qxF -- ${userLine} ${auth} && ! grep -qxF -- ${managedLine} ${auth}`
}
