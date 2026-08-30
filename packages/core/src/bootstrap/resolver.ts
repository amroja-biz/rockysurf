import type { ToolRow } from '../db/schema.js'
import { brandingScript } from './branding.js'
import { PLAN_VERSION, type BootstrapMode, type InstallPlan, type InstallStep, type StepRunAs } from './plan.js'
import { shellQuote } from './shell.js'

/**
 * Rendering an InstallPlan from pack data.
 *
 * The nine-phase order is `docs/bootstrap-contract.md` § Step ordering, and it is not a
 * preference: setup scripts run after clones because a setup script may read `$REPOS`, the
 * user's own script runs after all of those because it is written against the finished box,
 * and branding runs after that because it describes a box that already exists.
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
  /**
   * The script the user supplied at create time, and who they asked to run it (issue #184,
   * ADR-0011). Absent for every server that named none, which gets no such step.
   *
   * Already trimmed and length-checked by the create route — this function renders whatever it
   * is handed and validates nothing, the same as it does for a tool's `installScript`.
   */
  userScript?: { script: string; runAs: StepRunAs }
  /**
   * The NAMES of the pack's inputs and of the creator's Environment lines — both halves of
   * each, plain and secret — so phase 6 can put exactly those into `rocky`'s shell on the box
   * (issue #244). Names only, never values: the values travel in `secrets.env` and the step
   * reads them off the environment the agent already exports, so the plan stays loggable.
   * `GITHUB_TOKEN` is added by the resolver itself; see `SHELL_ENVIRONMENT_PLATFORM_NAMES`.
   * Absent or empty still renders the step, with just the platform names, because whether a
   * name is present on the box is decided there, not here.
   */
  shellEnvironment?: { packInputs: string[]; environment: string[] }
  /** Off only for tests and for a box the operator wants left alone. */
  branding?: boolean
  /**
   * The key the user pasted at create time, normalized (ADR-0008, issue #92). Required
   * together with `managedPublicKey` to render phase 9 — see `suppliedKeyOnlyScript`. Absent
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
  /** The user's own script gets its own word, so the feed can say whose script is running. */
  userScript: 'running_user_script',
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

  /* --- phase 5: the user's own script (issue #184, ADR-0011) --- */
  // AFTER everything the pack does — tools, clones, setup scripts — because that is the box
  // the user wrote their script against: the pack's toolchain is on PATH and `$REPOS` is
  // checked out. BEFORE branding, the desktop password and the key retirement, because those
  // are core's own housekeeping and all three report `ready`, which in callback mode promotes
  // the row and stops it accepting further progress — a user-script report arriving after one
  // of them would be dropped on the floor.
  if (input.userScript) {
    steps.push({
      id: 'user-script',
      reports: REPORTS.userScript,
      runAs: input.userScript.runAs,
      // The SAME preamble a setup script gets, and for the same reasons: `$REPOS` is the only
      // way to find the clones, and a `git` the script runs against a private one needs the
      // clone step's credential helper or it hangs on a username prompt with no TTY (#142).
      // Nothing else is prepended — in particular NOT `set -euo pipefail`, which every pack
      // script is told to open with. This script is the user's, not a pack's: forcing `-e`
      // onto it would change the meaning of a script that already works elsewhere, and EC2
      // user-data — the thing this deliberately mimics — forces nothing either. The step's
      // exit status is the script's own, and `docs/self-hosting.md` says to write `set -e`
      // yourself if that is what you want.
      run: `${setupPreamble(repositories)}${input.userScript.script}`,
      // OPTIONAL, on ADR-0010's own rule (see ADR-0011 clause 3). A failed tool install
      // releases the machine because a half-installed toolchain is worthless; this is the
      // opposite case. Every tool the pack promised is installed and every repository is
      // cloned — the box is exactly what was ordered — and the only thing that failed is text
      // the user typed. Failing the plan would hand them a `failed` row instead of the box
      // they need in order to fix their own script; so the step's whole log is captured as a
      // warning on a running box, exactly as a repository that would not clone is.
      optional: true,
      timeoutSeconds: DEFAULT_TOOL_TIMEOUT_SECONDS,
    })
  }

  /* --- phase 6: the shell environment (issue #244) --- */
  // AFTER the user's script, because this reports `ready` and the user's script must not (see
  // above); before branding, so a plan that is only ever partly finished has done the useful
  // half first. Always rendered: `GITHUB_TOKEN` is a candidate name on every box, and whether
  // any candidate is actually present is decided on the box, where the values are.
  steps.push({
    id: 'shell-environment',
    reports: REPORTS.finishing,
    // Root, and not only because `/etc/profile.d` needs it: a `rocky` step is handed its
    // environment through `sudo … env KEY=value`, and this step's whole subject is values that
    // must not go through argv. A root step inherits the agent's environment instead.
    runAs: 'root',
    run: shellEnvironmentScript(shellEnvironmentNames(input.shellEnvironment)),
    // REQUIRED, like `rdp`: the owner's ruling (#244) is that a box whose shell lacks what setup
    // saw is a bug, so a step that could not write it must not leave a `running` box behind.
    timeoutSeconds: 60,
  })

  /* --- phase 7: branding --- */
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

  /* --- phase 8: remote desktop password --- */
  if (input.pack.requiresRdp) {
    steps.push({
      id: 'rdp',
      reports: REPORTS.finishing,
      runAs: 'root',
      run: rdpScript(),
      timeoutSeconds: 60,
    })
  }

  /* --- phase 9: retire core's own key once the user supplied one (ADR-0008, issue #92) --- */
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
 * THE SHELL ENVIRONMENT (issue #244, the owner's ruling): every Environment line and every
 * pack input the creator gave is in `rocky`'s environment for every way a person reaches the
 * box — an interactive SSH login, `ssh box 'command'`, a tmux session started from either, and
 * the remote-desktop session when the pack has one. Same values setup saw.
 *
 * Rocky Surf's own names stay out, with one exception. `RDP_PASSWORD` and the
 * `ROCKYSURF_GITHUB_TOKEN_*` / `GIT_CONFIG_*` credential-helper plumbing are platform mechanics,
 * not the user's variables, and nothing on the box reads them after setup. `GITHUB_TOKEN` goes
 * IN: it is the one name the docs promise `gh` reads with no wiring, the packs install `gh` for
 * exactly that, and a box whose creator connected GitHub and whose `gh` then answers "not logged
 * in" has hit the bug the ruling describes. Git is unaffected either way — the clone step's
 * helper is per-invocation and dies with the step — but `gh auth setup-git` now works with no
 * login first. The exposure is nil: `rocky` holds `sudo` and could read `secrets.env` anyway.
 */
export const SHELL_ENVIRONMENT_PLATFORM_NAMES: readonly string[] = ['GITHUB_TOKEN']

/** Where the values live on the box, relative to `rocky`'s home. Owner `rocky`, mode `0600`. */
export const SHELL_ENVIRONMENT_FILE = '.config/rockysurf/environment'

/** The hook every login shell reads — `/etc/profile` sources `*.sh` here, for `sh` and bash. */
export const SHELL_ENVIRONMENT_PROFILE_HOOK = '/etc/profile.d/rockysurf-environment.sh'

/**
 * The hook a shell that reads no profile gets: `ssh box 'command'`. Debian's bash, started by
 * sshd with a command, reads `/etc/bash.bashrc` and then `~/.bashrc` — and Ubuntu's stock
 * copies of both return on the first line for a non-interactive shell, so the block goes at
 * the TOP of `/etc/bash.bashrc`, above that guard, between these two marker lines. The system
 * file rather than `~/.bashrc` so the user's own dotfiles are theirs to replace.
 */
export const SHELL_ENVIRONMENT_BASHRC_MARKERS = {
  start: '# >>> rockysurf environment >>>',
  end: '# <<< rockysurf environment <<<',
} as const

/**
 * The names phase 6 puts in the shell, in a fixed order so the plan renders identically twice:
 * the pack's inputs, then the creator's Environment, then the platform's — deduplicated, since
 * the create route already refuses a collision and this only has to be deterministic.
 */
export function shellEnvironmentNames(supplied: ResolveInstallPlanInput['shellEnvironment']): string[] {
  return [...new Set([...(supplied?.packInputs ?? []), ...(supplied?.environment ?? []), ...SHELL_ENVIRONMENT_PLATFORM_NAMES])]
}

/**
 * The shell function that renders the environment file, exported so a test can run it under a
 * real bash and source what it prints — the quoting is the part worth proving rather than
 * reading. `render_shell_environment NAME…` prints one `export NAME='value'` line per name that
 * is SET in the calling environment; an unset name is omitted (a key with no secret behind it,
 * an optional input nobody answered) and an empty one is kept, because `FOO=` typed into the
 * form can only mean "set `FOO`, empty" (ADR-0014 §7). Single quotes with `'\''` for a quote
 * is the POSIX form, so `sh` (which xrdp's session script is) reads the file exactly as bash
 * does; `printf %q` was rejected because it emits `$'…'` for anything non-ASCII under the C
 * locale the agent runs in, and dash cannot read that. The replacement text is held in a
 * variable rather than written inline in the `${…//…/…}`, because bash 3.2 and bash 5 disagree
 * about backslashes in an inline replacement and the test below runs under whichever the
 * developer's machine has; the box's 5.2 and a laptop's 3.2 both read `$q` the same way.
 */
export const SHELL_ENVIRONMENT_RENDER_FN = [
  'render_shell_environment() {',
  `  local name value q="'\\\\''"`,
  '  for name in "$@"; do',
  '    [ -n "${!name+x}" ] || continue',
  '    value=${!name}',
  `    printf "export %s='%s'\\n" "$name" "\${value//\\'/$q}"`,
  '  done',
  '}',
].join('\n')

/**
 * Phase 6. Writes ONE file with the values and TWO hooks with none, all regenerated whole on
 * every run so a resumed or re-pushed box converges rather than accumulating lines.
 *
 * The file: `~rocky/.config/rockysurf/environment`, owner `rocky`, `0600`, `export` lines. The
 * values come off this step's own environment — a root step inherits the agent's, which
 * `set -a; . secrets.env` populated — so they never enter the plan and never touch argv. The
 * NAMES are in the plan, as a bash array literal, which is the plan saying exactly what will be
 * in the shell without saying what it is.
 *
 * The hooks (`SHELL_ENVIRONMENT_PROFILE_HOOK`, `SHELL_ENVIRONMENT_BASHRC_MARKERS`) between them
 * cover the four ways in: `/etc/profile` for an interactive login, tmux (its panes are login
 * shells) and the desktop session (xrdp's `startwm.sh` sources `/etc/profile` under `sh`);
 * `/etc/bash.bashrc` for `ssh box 'command'` and for a terminal opened inside the desktop.
 * Both read the same file and source it only if it is readable, so the hooks are inert for
 * root and for any account that has no file — which is how a value stays `rocky`'s alone
 * without the hook itself carrying anything. A login shell reads both; sourcing twice is
 * harmless. The user's own dotfiles run after either hook, so their `export` wins.
 *
 * `umask 077` first: nothing here is ever readable by anyone else, even between two lines.
 */
export function shellEnvironmentScript(names: string[]): string {
  const { start, end } = SHELL_ENVIRONMENT_BASHRC_MARKERS
  const hookBody = [
    '# Rocky Surf: the pack\'s inputs and this box\'s Environment, for every shell rocky gets.',
    `# The values live in ~/${SHELL_ENVIRONMENT_FILE} (mode 0600); this file holds none.`,
    `if [ -r "\${HOME:-}/${SHELL_ENVIRONMENT_FILE}" ]; then . "\${HOME:-}/${SHELL_ENVIRONMENT_FILE}"; fi`,
  ]
  return [
    'set -euo pipefail',
    'umask 077',
    `names=(${names.map(shellQuote).join(' ')})`,
    'home=$(getent passwd rocky | cut -d: -f6)',
    '[ -n "$home" ] || home=/home/rocky',
    `file="$home/${SHELL_ENVIRONMENT_FILE}"`,
    // `~/.config` is left with whatever mode it has if it exists — it is the user's — and
    // created the conventional way if not; the directory under it is ours and is always 0700.
    '[ -d "$home/.config" ] || install -d -m 0755 -o rocky -g rocky "$home/.config"',
    'install -d -m 0700 -o rocky -g rocky "$(dirname "$file")"',
    SHELL_ENVIRONMENT_RENDER_FN,
    // Whole-file write through a temp file in the same directory, so a shell that starts while
    // this runs reads the old file or the new one, never half of one.
    '{',
    "  echo '# Written by Rocky Surf when this box was set up: the pack'\\''s inputs and the'",
    "  echo '# Environment from the create form, so every shell here sees what setup saw.'",
    "  echo '# Regenerated whole on a re-run; put your own changes in ~/.bashrc, which runs later.'",
    '  render_shell_environment "${names[@]}"',
    '} > "$file.tmp"',
    'chown rocky:rocky "$file.tmp"',
    'chmod 0600 "$file.tmp"',
    'mv -f "$file.tmp" "$file"',
    // Hook 1: every login shell, bash or sh.
    `cat > ${SHELL_ENVIRONMENT_PROFILE_HOOK}.tmp <<'ROCKYSURF_HOOK'`,
    ...hookBody,
    'ROCKYSURF_HOOK',
    `chmod 0644 ${SHELL_ENVIRONMENT_PROFILE_HOOK}.tmp`,
    `mv -f ${SHELL_ENVIRONMENT_PROFILE_HOOK}.tmp ${SHELL_ENVIRONMENT_PROFILE_HOOK}`,
    // Hook 2: the block at the top of /etc/bash.bashrc, above Ubuntu's interactive guard. Any
    // previous block is dropped first, so a second run writes the same bytes as the first.
    '{',
    `  printf '%s\\n' ${shellQuote(start)}`,
    ...hookBody.map((line) => `  printf '%s\\n' ${shellQuote(line)}`),
    `  printf '%s\\n' ${shellQuote(end)}`,
    '  if [ -f /etc/bash.bashrc ]; then',
    `    sed ${shellQuote(`/^${start}$/,/^${end}$/d`)} /etc/bash.bashrc`,
    '  fi',
    '} > /etc/bash.bashrc.tmp',
    'chmod 0644 /etc/bash.bashrc.tmp',
    'mv -f /etc/bash.bashrc.tmp /etc/bash.bashrc',
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
