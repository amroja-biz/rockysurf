/**
 * The complete account of a bootstrap that went wrong (ADR-0010, issue #119).
 *
 * Before this, a failed bootstrap left the user one line — `bootstrap failed at step
 * 'tool:build-essential': E: Unable to fetch some archives…` — and a running, billing box to
 * SSH into if they wanted to know more. The owner's ruling turned that around: a failed TOOL
 * install terminates the instance, so the explanation has to be complete enough to stand in for
 * the machine. This module builds that explanation from what the agent journalled and what core
 * read off the box before letting it go, in words a person can act on.
 *
 * Three facts, kept separate because a reader wants them separately:
 *
 *   * WHAT failed — the step, and the tool or repository it stands for, by name;
 *   * WHY — a classified cause with a plain-language summary, the decisive lines pulled out of
 *     the log, and the whole log underneath for whoever wants it;
 *   * WHAT CORE DID with the machine — terminated, kept, or tried and could not — which lives
 *     on the failure entry as `instance`/`instanceNote` and is decided in `failure.ts`.
 *
 * Nothing here talks to a database or a cloud: it is a pure function of the plan, the journal
 * and the logs, which is what makes it testable against the real logs the incidents left behind.
 */

import { NO_MATCHING_TOKEN_PREFIX } from './resolver.js'

/** What went wrong, in the vocabulary the summary is written from. */
export const FAILURE_CAUSES = [
  'apt-mirror',
  'apt',
  'git-auth',
  'git-not-found',
  'github-rate-limit',
  'network',
  'disk-full',
  'timeout',
  'unknown',
] as const
export type FailureCause = (typeof FAILURE_CAUSES)[number]

/** Which phase of the plan a step belongs to — the thing the terminate rule is keyed on. */
export type StepPhase = 'tool' | 'repo' | 'setup' | 'finishing'

export type InstanceOutcome = 'terminated' | 'kept' | 'terminate-failed'

export interface StepReport {
  /** The plan's journal key: `tool:build-essential`, `repo:my-app`, `branding`. */
  stepId: string
  phase: StepPhase
  /** Human name: the tool's display name, the repository URL, or the step id when neither is known. */
  label: string
  /** The script's exit status, when the agent log recorded it. */
  exitCode?: number
  cause: FailureCause
  /** Two to four plain sentences: what failed, why, and what to do about it. */
  summary: string
  /** The lines that decide the verdict — apt's `E:` lines, git's `fatal:` — never the whole log. */
  keyLines: string[]
  /** The step's captured output. Complete in push mode; the agent's tail in callback mode. */
  log: string
  logComplete: boolean
}

export interface FailureReport extends StepReport {
  instance: InstanceOutcome
  /** One sentence on what core did with the machine and what that means for the bill. */
  instanceNote: string
}

export interface BootstrapReport {
  /** The required step that stopped the plan. Absent when the plan completed with warnings only. */
  failure?: FailureReport
  /** Optional steps that failed while the plan went on — repository clones, branding. */
  warnings: StepReport[]
  /** The agent's own log, last lines, when core could read it. */
  agentLogTail?: string
}

export interface CapturedLog {
  log: string
  complete: boolean
}

/** How labels are resolved. Both lookups are optional; the step id is the fallback. */
export interface LabelSources {
  toolName?: (toolId: string) => string | undefined
  repoUrl?: (dirName: string) => string | undefined
}

/* ------------------------------------------------------------------- classification */

export function stepPhase(stepId: string): StepPhase {
  if (stepId.startsWith('tool:')) return 'tool'
  if (stepId.startsWith('repo:')) return 'repo'
  if (stepId.startsWith('tool-setup:')) return 'setup'
  return 'finishing'
}

export function stepLabel(stepId: string, sources: LabelSources = {}): string {
  const phase = stepPhase(stepId)
  if (phase === 'tool') return sources.toolName?.(stepId.slice('tool:'.length)) ?? stepId.slice('tool:'.length)
  if (phase === 'setup') {
    const id = stepId.slice('tool-setup:'.length)
    const name = sources.toolName?.(id) ?? id
    return `${name} (setup script)`
  }
  if (phase === 'repo') return sources.repoUrl?.(stepId.slice('repo:'.length)) ?? stepId.slice('repo:'.length)
  if (stepId === 'branding') return 'login banner'
  if (stepId === 'rdp') return 'remote desktop password'
  // Named in the SECOND PERSON on purpose (issue #184): every other label in this list is
  // something Rocky Surf chose to run, and the whole point of the warning this ends up on is
  // that this one is not — the fix is in the reader's own text, not in a pack.
  if (stepId === 'user-script') return 'your setup script'
  return stepId
}

/** ANSI SGR sequences out — a report is read as text, and `[0;31mError:` helps nobody. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- that is the point
  return text.replace(/\[[0-9;]*m/g, '')
}

/**
 * Most specific first. Order matters where signatures overlap: apt reports a DNS failure as
 * `Failed to fetch … Could not resolve host`, which is a network problem, not a mirror one; and
 * a box that ran out of disk fails whatever it was doing at the time in that thing's own words.
 */
const CAUSE_SIGNATURES: ReadonlyArray<[FailureCause, RegExp]> = [
  ['disk-full', /No space left on device|ENOSPC/i],
  ['timeout', /^--- .*: FAILED \(rc=124\)|Terminated\s*$|Command timed out/im],
  ['github-rate-limit', /api\.github\.com.*\b403\b|API rate limit exceeded|rate limit/i],
  ['git-auth', new RegExp(`${NO_MATCHING_TOKEN_PREFIX}|could not read Username|Authentication failed|Permission denied \\(publickey\\)|Invalid username or (password|token)`, 'i')],
  ['git-not-found', /Repository not found|repository .* (does )?not (exist|found)|remote: Not Found|fatal: remote error: .*not found/i],
  ['network', /Could not resolve host|Temporary failure in name resolution|Network is unreachable|Connection timed out|Could not connect to|Connection refused|Failed to connect to|name or service not known/i],
  ['apt-mirror', /503\s+Service Unavailable|Mirror sync in progress|File has unexpected size|Hash Sum mismatch|engaging the mirror fallback|Unable to fetch some archives|Some index files failed to download|Failed to fetch http/i],
  ['apt', /^E: |apt-get|dpkg|Unable to locate package|Unmet dependencies/im],
]

export function classifyFailure(log: string): FailureCause {
  const text = stripAnsi(log)
  for (const [cause, re] of CAUSE_SIGNATURES) if (re.test(text)) return cause
  return 'unknown'
}

const KEY_LINE = new RegExp(
  `^(E: |W: Failed|fatal:|error:|Error:|ERROR|npm ERR!|curl: \\(|${NO_MATCHING_TOKEN_PREFIX}|.*No space left on device|.*: command not found|.*Permission denied|.*Could not resolve host|.*Connection refused|.*Connection timed out|.*rate limit|.*not found|.*failed)`,
  'i',
)

/**
 * The lines a person needs to read — the verdicts, not the progress bars. At most eight, in
 * order, deduplicated; when nothing matches, the last three non-empty lines, which is where
 * installers put their conclusion.
 */
export function keyLinesOf(log: string, limit = 8): string[] {
  const lines = stripAnsi(log)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
  const picked: string[] = []
  for (const line of lines) {
    if (!KEY_LINE.test(line)) continue
    if (picked.includes(line)) continue
    picked.push(line)
  }
  const chosen = picked.length > 0 ? picked.slice(-limit) : lines.slice(-3)
  return chosen.map((line) => (line.length > 300 ? `${line.slice(0, 300)}…` : line))
}

/** `--- tool:node: FAILED (rc=1)` in the agent's own log is the only place the exit code lives. */
export function exitCodeOf(stepId: string, agentLog: string | undefined): number | undefined {
  if (!agentLog) return undefined
  const escaped = stepId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // No `^`: the agent's `log()` puts a timestamp in front of every line.
  const matches = [...agentLog.matchAll(new RegExp(`--- ${escaped}: FAILED \\(rc=(\\d+)\\)`, 'g'))]
  const last = matches.at(-1)?.[1]
  return last === undefined ? undefined : Number(last)
}

/* ------------------------------------------------------------------- apt fetch URLs */

/**
 * `E: Failed to fetch http://…/perl-base_5.38.2-3.2ubuntu0.4_arm64.deb  404  Not Found [IP: …]`
 * is the only line in a failed install that names the FILE the mirror would not serve, and it
 * is the one thing a person can act on themselves: paste it into a browser or a `curl -I` and
 * find out whether the mirror has caught up yet (issue #188). Everything else apt prints about
 * a fetch failure — "Unable to fetch some archives", the exit code — is the same sentence on
 * every mirror on every box.
 *
 * `W: Failed to fetch` counts: an index that fails to download is reported as a warning and
 * the install then fails on the stale list it already had.
 */
const FETCH_FAILURE_LINE = /^[EW]: Failed to fetch\s+(\S+)(.*)$/gim

export interface AptFetchFailure {
  url: string
  /** The HTTP status apt reported for it, when it reported one. `404`, `503`. */
  status?: string
  /** True when the host is a per-region Canonical mirror rather than the global archive. */
  regional: boolean
}

const REGIONAL_MIRROR_HOST = /^https?:\/\/[a-z0-9-]+\.[a-z0-9.-]*\b(archive|ports)\.ubuntu\.com/i

/**
 * Every distinct URL apt could not fetch, in the order it gave up on them. Deduplicated by
 * URL, because a step that installs thirty packages against a sick mirror prints the same
 * host thirty times and a summary that lists all of them is not a summary.
 */
export function aptFetchFailures(log: string, limit = 3): AptFetchFailure[] {
  const seen = new Set<string>()
  const found: AptFetchFailure[] = []
  for (const match of stripAnsi(log).matchAll(FETCH_FAILURE_LINE)) {
    const url = match[1]
    if (!url || seen.has(url)) continue
    seen.add(url)
    const status = /\b(\d{3})\b/.exec(match[2] ?? '')?.[1]
    found.push({ url, ...(status ? { status } : {}), regional: REGIONAL_MIRROR_HOST.test(url) })
    if (found.length >= limit) break
  }
  return found
}

/* -------------------------------------------------------------------------- summary */

function firstKeyLine(keyLines: string[]): string {
  return keyLines[0] ?? ''
}

function withPeriod(text: string): string {
  const trimmed = text.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/**
 * The summary is written for the person who clicked Create, not for whoever reads the log:
 * what could not be done, why in one clause, and what they can do about it.
 */
export function summarize(input: {
  phase: StepPhase
  label: string
  cause: FailureCause
  keyLines: string[]
  exitCode?: number
  /**
   * The step's whole log, when the caller has it. Only the `apt-mirror` case reads it, to name
   * the URLs that would not serve; `keyLines` is the fallback so every existing caller keeps
   * working and a callback-mode tail still yields what it can.
   */
  log?: string
}): string {
  const { phase, label, cause, keyLines, exitCode } = input
  const thing =
    phase === 'repo'
      ? `The repository ${label} could not be cloned onto the box`
      : phase === 'setup'
        ? `The setup script for ${label} failed`
        : phase === 'tool'
          ? `${label} could not be installed`
          : `The ${label} step failed`
  const evidence = firstKeyLine(keyLines)

  switch (cause) {
    case 'apt-mirror': {
      // The URL is the whole point of this branch (#188): it is the one fact in the report the
      // user can check themselves, and checking it is what tells them whether to create again
      // now or in an hour. Without one — a mirror failure whose lines apt phrased some other
      // way — the advice degrades to the generic outage sentence rather than inventing a URL.
      const failures = aptFetchFailures(input.log ?? keyLines.join('\n'), 2)
      const first = failures[0]
      const what = first?.regional
        ? "Ubuntu's package mirror for this region"
        : "Ubuntu's package archive"
      const statusPhrase = first?.status ? ` answered HTTP ${first.status}` : ' would not serve it'
      const alsoPhrase = failures.length > 1 ? ` (and ${failures.length - 1} more file${failures.length > 2 ? 's' : ''})` : ''
      // What the agent's second attempt actually did, which differs by case: a regional mirror
      // is swapped for the global one, and a box already on the global one is only waited for.
      const retried = first?.regional
        ? 'Rocky Surf already retried the step once on the global mirror and got the same answer.'
        : 'Rocky Surf already retried the step once, waiting first for the archive to catch up, and got the same answer.'
      const diagnosis = first?.status === '404'
        ? "The mirror's package index is naming files it is no longer serving — this is a fault on the mirror side, not in your pack or your settings, and it usually clears within the hour."
        : 'This is an outage on the mirror side, not a problem with your pack or your settings; it usually clears within a few hours.'

      if (!first) {
        return (
          `${thing}: ${what} was not serving packages ` +
          `(${evidence.includes('503') ? 'HTTP 503' : 'missing or mismatched files'}). ` +
          'Rocky Surf already retried the step once and got the same answer. ' +
          `${diagnosis} Create the server again once it is back.`
        )
      }
      return (
        `${thing}: ${what} would not serve a file the install needs — ${first.url}${statusPhrase}${alsoPhrase}. ` +
        `${retried} ${diagnosis} ` +
        `Check it yourself — \`curl -I ${first.url}\` answering 200 means the mirror has caught up — then create the server again.`
      )
    }
    case 'apt':
      return `${thing}: apt reported ${withPeriod(evidence || 'an error')} If the package name is wrong the pack needs fixing; otherwise create the server again.`
    case 'git-auth': {
      // The clone script's own diagnosis (rockysurf-ldo1) names which token was missing and
      // where to add it; when it is there it IS the explanation, and git's `fatal:` above it
      // is noise. Without it, the generic advice.
      const diagnosis = keyLines.find((line) => line.startsWith(NO_MATCHING_TOKEN_PREFIX))
      if (diagnosis) return `${thing}: ${withPeriod(diagnosis)}`
      return (
        `${thing}: git could not authenticate${evidence ? ` (${evidence})` : ''}. ` +
        'Add a token that matches this repository (Settings → GitHub), or make the repository public, then create again — or clone it by hand on the box.'
      )
    }
    case 'git-not-found':
      return (
        `${thing}: git reports the repository does not exist or is not visible from the box. ` +
        'Check the URL for a typo and that the token, if any, can see it.'
      )
    case 'github-rate-limit':
      return (
        `${thing}: GitHub refused the request with 403 — the unauthenticated API rate limit from this box's address was exhausted. ` +
        "Wait an hour and create again, or change the install script to fetch a pinned release instead of resolving 'latest'."
      )
    case 'network':
      return `${thing}: the box could not reach the network${evidence ? ` (${evidence})` : ''}. Create the server again; if it recurs, check the provider's outbound networking for this region.`
    case 'disk-full':
      return `${thing}: the box ran out of disk space. Create it again with a larger size.`
    case 'timeout':
      return `${thing}: the step ran past its time limit and was stopped. Create the server again; if it recurs, the pack's script may be waiting on something that never arrives.`
    default:
      return (
        `${thing}${exitCode !== undefined ? ` (the script exited with code ${exitCode})` : ''}` +
        `${evidence ? `: ${withPeriod(evidence)}` : '.'} The full log below has the details.`
      )
  }
}

export function explainStep(input: {
  stepId: string
  captured: CapturedLog
  agentLog?: string
  labels?: LabelSources
}): StepReport {
  const phase = stepPhase(input.stepId)
  const label = stepLabel(input.stepId, input.labels)
  const log = stripAnsi(input.captured.log)
  const keyLines = keyLinesOf(log)
  const exitCode = exitCodeOf(input.stepId, input.agentLog)
  const cause = exitCode === 124 ? 'timeout' : classifyFailure(log)
  return {
    stepId: input.stepId,
    phase,
    label,
    ...(exitCode !== undefined ? { exitCode } : {}),
    cause,
    summary: summarize({ phase, label, cause, keyLines, log, ...(exitCode !== undefined ? { exitCode } : {}) }),
    keyLines,
    log,
    logComplete: input.captured.complete,
  }
}

/** What core did with the machine, in one sentence that also says what it means for the bill. */
export function describeInstance(outcome: InstanceOutcome, detail?: string): string {
  switch (outcome) {
    case 'terminated':
      return 'Rocky Surf terminated the machine, so it is not billing.'
    case 'kept':
      return detail ?? 'The machine was left running so you can SSH in and look; it is still billing until you terminate it.'
    case 'terminate-failed':
      return `Rocky Surf tried to terminate the machine and could not${detail ? ` (${detail})` : ''}. It may still be billing — terminate it from the provider console.`
  }
}

/* ---------------------------------------------------------------- from the journal */

/** The subset of the agent's journal this module reads, spelled here to keep the import graph one-way. */
export interface JournalLike {
  status: 'running' | 'done' | 'failed'
  failedStep?: string
  step: string
  logTail?: string
  steps: Array<{ id: string; status: string; logTail?: string }>
}

/**
 * Build the report from a terminal journal. `stepLogs` are what core read off the box (push
 * mode); a step with no captured log falls back to the journal's own tail, which is how
 * callback mode gets its evidence. The instance verdict is left for `failure.ts`, which is the
 * only place that knows what happened to the machine.
 */
export function buildStepReports(input: {
  journal: JournalLike
  stepLogs?: Record<string, CapturedLog>
  agentLog?: string
  labels?: LabelSources
}): { failure?: StepReport; warnings: StepReport[] } {
  const { journal } = input
  const captured = (stepId: string, fallback?: string): CapturedLog =>
    input.stepLogs?.[stepId] ?? { log: fallback ?? '', complete: false }

  const failedId = journal.status === 'failed' ? (journal.failedStep ?? journal.step) : undefined
  const failure = failedId
    ? explainStep({
        stepId: failedId,
        captured: captured(failedId, journal.logTail ?? journal.steps.find((s) => s.id === failedId)?.logTail),
        ...(input.agentLog ? { agentLog: input.agentLog } : {}),
        ...(input.labels ? { labels: input.labels } : {}),
      })
    : undefined

  const warnings = journal.steps
    .filter((s) => s.status === 'failed' && s.id !== failedId)
    .map((s) =>
      explainStep({
        stepId: s.id,
        captured: captured(s.id, s.logTail),
        ...(input.agentLog ? { agentLog: input.agentLog } : {}),
        ...(input.labels ? { labels: input.labels } : {}),
      }),
    )

  return { ...(failure ? { failure } : {}), warnings }
}
