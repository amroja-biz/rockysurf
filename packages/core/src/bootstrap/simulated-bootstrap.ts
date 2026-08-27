import type { ServerRow } from '../db/schema.js'
import { parseInstallPlan, type InstallPlan, type InstallStep } from './plan.js'
import { applyAgentState, type PushRunnerDeps, type RunPushBootstrapOptions } from './push-runner.js'
import type { AgentState, AgentStepState, PushResult } from './push.js'

/**
 * The box a simulated provider does not have (rockysurf-8fkz).
 *
 * A provider that declares `capabilities.simulatedInstances` (ADR-0003, amendment E15) reports an
 * address with nothing behind it, so `runPushBootstrap` cannot do its job: it would dial
 * 198.51.100.7, fail auth three times and fail the row — or lose the race to the 30-minute
 * provisioning timeout, which is what the no-cloud trial run actually did. This module is the
 * other end of that connection, and nothing else about bootstrap changes.
 *
 * IT IS AN AGENT, NOT A SHORTCUT, and the distinction is the whole design. It takes the plan the
 * resolver really rendered and snapshotted onto the row, walks it in order, and emits the same
 * `AgentState` journal `state.json` would have carried — then hands each snapshot to
 * `applyAgentState`, the same function the real push runner calls. So progress is recorded by
 * `recordProgress`, the SPA timeline lights up from the same `bootstrap-progress` events, and the
 * row is promoted to `running` by the same `recordProgress('ready')` that promotes a real box.
 * Bootstrap still owns the promotion (rockysurf-55fx.13); there is no second path to it.
 *
 * What is NOT simulated is as important: no step's `run` is executed. A trial run must not
 * `apt-get install` anything on the machine somebody is evaluating Rocky Surf from, which is why
 * the higher-fidelity option — an in-process SSH server driving the real `agent.sh` — was
 * rejected in E15 rather than merely not chosen.
 */

/**
 * How long the whole simulated install takes, in ms — a BUDGET, not a per-step delay.
 *
 * Per-step timing would make the trial run's length a function of how many tools the chosen pack
 * happens to list: `ai-coding-agents` renders about twenty steps and a minimal pack renders four,
 * so the same constant produces a demo that drags or one that blinks. A budget divided across the
 * plan keeps every pack landing in the same watchable window.
 *
 * Twenty seconds is chosen against two consumers: it is long enough that the step timeline is
 * something a first-time user watches happen rather than a flicker they miss, and short enough to
 * sit inside a demo clip and inside anybody's patience.
 */
export const DEFAULT_SIMULATED_BOOTSTRAP_MS = 20_000

/**
 * The floor on a single step, so a large plan stays legible.
 *
 * At twenty steps the budget alone gives each one a second; at sixty it would give a third of
 * that, and a timeline that advances faster than it can be read is no more informative than an
 * instant one.
 */
const MIN_STEP_MS = 250

/** Fast-forward for tests and for a demo tape that supplies its own pacing. `0` runs flat out. */
export const SIMULATED_BOOTSTRAP_MS_ENV = 'ROCKYSURF_SIMULATED_BOOTSTRAP_MS'

export interface SimulatedBootstrapOptions {
  /** Total wall-clock budget for the whole plan. Overrides the environment. */
  totalMs?: number
  /** Read for `ROCKYSURF_SIMULATED_BOOTSTRAP_MS`. Defaults to the real environment. */
  env?: NodeJS.ProcessEnv
  /** Injected by tests that do not want to wait. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const realSleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

/**
 * Budget from the caller, then the environment, then the default — and never a negative.
 *
 * An unparseable value falls back rather than throwing: this is a pacing knob on a trial run, and
 * a typo in it should not be the reason somebody's first server fails to bootstrap.
 */
export function resolveBudgetMs(options: SimulatedBootstrapOptions = {}): number {
  if (options.totalMs !== undefined) return Math.max(0, options.totalMs)
  const raw = (options.env ?? process.env)[SIMULATED_BOOTSTRAP_MS_ENV]
  if (raw === undefined || raw.trim() === '') return DEFAULT_SIMULATED_BOOTSTRAP_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SIMULATED_BOOTSTRAP_MS
}

/**
 * Build a drop-in replacement for `runPushBootstrap`.
 *
 * Same signature deliberately: the supervisor chooses between the two by capability and knows
 * nothing else about either, so neither can grow a special case about the other.
 */
export function createSimulatedBootstrap(
  options: SimulatedBootstrapOptions = {},
): (deps: PushRunnerDeps, row: ServerRow, runOptions?: RunPushBootstrapOptions) => Promise<PushResult> {
  const sleep = options.sleep ?? realSleep
  const now = options.now ?? (() => Date.now())

  return async function runSimulatedBootstrap(deps, row, runOptions = {}): Promise<PushResult> {
    // The same refusal the real runner makes, for the same reason: a row created before plans
    // were snapshotted has nothing to install, and inventing a plan here would hide that.
    if (!row.installPlan) throw new Error(`server ${row.id} has no install plan`)
    const plan: InstallPlan = parseInstallPlan(JSON.parse(row.installPlan))

    const started = now()
    const budget = resolveBudgetMs(options)
    const perStep = plan.steps.length > 0 ? Math.max(MIN_STEP_MS, Math.floor(budget / plan.steps.length)) : 0
    const stepMs = budget === 0 ? 0 : perStep

    const journal: AgentStepState[] = plan.steps.map((step) => ({
      id: step.id,
      reports: step.reports,
      status: 'pending',
    }))

    const emit = (state: AgentState): void => {
      applyAgentState(deps, row, state)
    }

    const log = (line: string): void => {
      runOptions.onLog?.(line)
      // Fire-and-forget, exactly as the push runner streams the box's journal: a stream nobody
      // is reading must not pace the install.
      void deps.events.broadcastToUser(row.userId, {
        type: 'bootstrap-log',
        serverId: row.id,
        line,
      } as never)
    }

    let state: AgentState = snapshot(plan, journal, plan.steps[0]?.id ?? 'ready', 'running', now)

    for (const [index, step] of plan.steps.entries()) {
      const entry = journal[index]!
      entry.status = 'running'
      entry.startedAt = new Date(now()).toISOString()
      state = snapshot(plan, journal, step.id, 'running', now)
      emit(state)
      log(`[trial] ${describe(step)}`)

      await sleep(stepMs)

      entry.status = 'done'
      entry.finishedAt = new Date(now()).toISOString()
      state = snapshot(plan, journal, step.id, 'running', now)
      emit(state)
    }

    // Terminal. The last step's `reports` is `ready` on every plan the resolver renders, and
    // core deliberately does NOT promote on that report (rockysurf-1c8z) — the supervisor's own
    // `markBootstrapReady` does it when the drive completes. This emits the finished journal;
    // the promotion follows, in the same order a real push settles in.
    state = snapshot(plan, journal, plan.steps.at(-1)?.id ?? 'ready', 'done', now)
    emit(state)
    log('[trial] simulated install finished; this box exists only in this process')

    return {
      launcher: 'simulated',
      state,
      durationMs: now() - started,
      runId: plan.runId,
      // Nothing is ever resumed: the journal lives in this closure and dies with the drive, so a
      // retried simulation honestly re-runs every step rather than claiming to have skipped work.
      skipped: [],
    }
  }
}

/** The journal as `state.json` would hold it at this instant. */
function snapshot(
  plan: InstallPlan,
  steps: AgentStepState[],
  step: string,
  status: AgentState['status'],
  now: () => number,
): AgentState {
  return {
    planVersion: plan.version,
    serverId: plan.serverId,
    runId: plan.runId,
    step,
    status,
    updatedAt: new Date(now()).toISOString(),
    // Cloned so a caller holding an earlier snapshot does not watch it mutate underneath them.
    steps: steps.map((entry) => ({ ...entry })),
  }
}

/**
 * A log line that says what the step is, without pretending a command ran.
 *
 * The step id already carries the vocabulary a user recognises — `tool:claude-code`,
 * `repo:my-project` — so it is the honest thing to print. The install script is not printed at
 * all: it is the one piece of the plan that did NOT happen here.
 */
function describe(step: InstallStep): string {
  const [kind, ...rest] = step.id.split(':')
  const name = rest.join(':')
  switch (kind) {
    case 'tool':
      return `installing ${name}`
    case 'tool-setup':
      return `configuring ${name}`
    case 'repo':
      return `cloning ${name}`
    // A singleton id, so `split(':')` leaves the whole thing in `kind` (issue #184). Worth a
    // sentence of its own because it is the one step a trial user recognises as theirs.
    case 'user-script':
      return 'running your script (not really — nothing on this box is real)'
    default:
      return `${step.id}`
  }
}
