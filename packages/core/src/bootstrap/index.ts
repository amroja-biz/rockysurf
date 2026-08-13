import { fileURLToPath } from 'node:url'

/**
 * Bootstrap: the InstallPlan format, the resolver that renders one, and the agent that runs
 * it. The normative spec for all three is `docs/bootstrap-contract.md`.
 */

export {
  BOOTSTRAP_MODES,
  PLAN_VERSION,
  SINGLETON_STEP_IDS,
  STEP_ID_PREFIXES,
  STEP_RUN_AS,
  installPlanSchema,
  installStepSchema,
  parseInstallPlan,
  serializeInstallPlan,
  type BootstrapMode,
  type InstallPlan,
  type InstallStep,
  type StepRunAs,
} from './plan.js'

export {
  repoDirName,
  resolveInstallPlan,
  type ResolvablePack,
  type ResolveInstallPlanInput,
} from './resolver.js'

export { createInternalRoutes, type InternalRoutesDeps } from './internal-routes.js'

/**
 * The create path's plan snapshot and the ticker's push driver (rockysurf-55fx.13) — the two
 * halves that turn everything above into a box with software on it.
 */
export { snapshotInstallPlan, type SnapshotInstallPlanOptions } from './install-plan.js'

export {
  createPushBootstrapSupervisor,
  markBootstrapReady,
  type PushSupervisorDeps,
} from './supervisor.js'

/**
 * The other end of a connection a simulated provider cannot accept (rockysurf-8fkz): the same
 * plan, the same journal, the same promotion, driven in-process for a provider that declares
 * `capabilities.simulatedInstances` (ADR-0003, amendment E15).
 */
export {
  createSimulatedBootstrap,
  DEFAULT_SIMULATED_BOOTSTRAP_MS,
  SIMULATED_BOOTSTRAP_MS_ENV,
  type SimulatedBootstrapOptions,
} from './simulated-bootstrap.js'

export {
  DEFAULT_SSH_USER,
  renderCallbackUserData,
  renderPushUserData,
  UserDataTooLargeError,
  type CallbackUserDataSpec,
  type PushUserDataSpec,
  type RenderResult,
} from './user-data.js'

/**
 * A server whose `bootstrapMode` is `callback` needs both tokens minted before its user-data is
 * rendered, because the document carries them.
 *
 * WIRED (rockysurf-55fx.13): `bootstrapModeHooks` mints these on the create path, and the plan
 * they authenticate is snapshotted alongside them by `snapshotInstallPlan`. This comment used
 * to say nothing called it in production, which was true when it was written and had stopped
 * being true without anyone noticing — the same way the push seam rotted.
 *
 * Re-minting rotates both and resets the budget, which is what a retry of a callback-mode
 * bootstrap needs.
 */
export {
  consumePlanToken,
  mintCallbackTokens,
  PLAN_TOKEN_TTL_MS,
  PLAN_TOKEN_USE_BUDGET,
  retirePlanToken,
  verifyCallbackToken,
  type MintedCallbackTokens,
  type PlanTokenOutcome,
} from '../db/repositories/bootstrap-tokens.js'

/**
 * Absolute path to the agent, for whoever has to move it onto a box.
 *
 * It resolves the same from `src/` and from `dist/` because both sit one level below the
 * package root, and `bootstrap/` is listed in the package's `files` so it survives packing.
 * Push mode scps this file; callback mode compresses it into user-data.
 */
export const AGENT_SCRIPT_PATH = fileURLToPath(new URL('../../bootstrap/agent.sh', import.meta.url))

/** Where the agent keeps its plan, journal, secrets and per-step logs on the box. */
export const AGENT_STATE_DIR = '/var/lib/rockysurf'
