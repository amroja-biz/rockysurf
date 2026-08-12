import type { ToolRow } from '../db/schema.js'
import { PLAN_VERSION, type BootstrapMode, type InstallPlan, type InstallStep } from './plan.js'

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
      // change, and it keeps the value visible in the snapshot.
      run: `${exportRepos(repositories)}${tool.setupScript}`,
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

/** Single-quote for bash, the only form with no escape sequences to reason about. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function exportRepos(repositories: string[]): string {
  return `export REPOS=${shellQuote(repositories.join(','))}\n`
}

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
 */
function cloneScript(url: string): string {
  const dir = `"$HOME"/${repoDirName(url)}`
  // Reads $GITHUB_TOKEN at run time. `x-access-token` is the username GitHub expects for a PAT.
  const credentialHelper =
    "'!f() { printf \"username=x-access-token\\npassword=%s\\n\" \"$GITHUB_TOKEN\"; }; f'"
  return [
    'set -euo pipefail',
    `url=${shellQuote(url)}`,
    `dir=${dir}`,
    'git_auth=()',
    'if [ -n "${GITHUB_TOKEN:-}" ]; then',
    `  git_auth=(-c credential.helper=${credentialHelper})`,
    'fi',
    'if [ -d "$dir/.git" ]; then',
    '  git -C "$dir" remote set-url origin "$url"',
    '  git "${git_auth[@]}" -C "$dir" fetch --all --prune',
    'else',
    '  git "${git_auth[@]}" clone "$url" "$dir"',
    'fi',
    '',
  ].join('\n')
}

/** Whole-file writes, so a re-run converges rather than appending. */
function brandingScript(serverId: string): string {
  return [
    'set -euo pipefail',
    `printf '%s\\n' ${shellQuote(`Rocky Surf — ${serverId}`)} > /etc/motd`,
    'install -d -m 0755 /etc/rockysurf',
    `printf 'serverId=%s\\n' ${shellQuote(serverId)} > /etc/rockysurf/server-info`,
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
