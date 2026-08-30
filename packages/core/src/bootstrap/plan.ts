import { z } from 'zod'

/**
 * The InstallPlan wire format, from `docs/bootstrap-contract.md` § InstallPlan.
 *
 * The plan is DATA. The agent never resolves a pack, queries a database, or talks to a cloud
 * API — everything it needs is in this document, which is what let the per-server IAM role go
 * away. Core renders it at create time and snapshots it on the server row, so a re-push
 * executes the plan the server was created with rather than whatever the pack says today.
 *
 * Version 1 is frozen for v0.1 and anything else is rejected, on both sides: the schema here
 * and an explicit check in `agent.sh`. A plan from a newer core landing on an older box should
 * refuse to run rather than half-understand its own instructions.
 */

export const PLAN_VERSION = 1

export const BOOTSTRAP_MODES = ['push', 'callback'] as const
export type BootstrapMode = (typeof BOOTSTRAP_MODES)[number]

export const STEP_RUN_AS = ['root', 'rocky'] as const
export type StepRunAs = (typeof STEP_RUN_AS)[number]

/**
 * Namespaced step ids. The prefix is not decoration: `id` is the journal's resume key, so it
 * MUST be unique within the plan and stable across re-renders. Namespacing is what keeps a
 * tool called `branding` from colliding with the branding phase.
 */
export const STEP_ID_PREFIXES = ['tool:', 'tool-setup:', 'repo:'] as const
/**
 * `user-script`: ADR-0011 / issue #184, phase 5. `shell-environment`: issue #244, phase 6.
 * `supplied-key-only`: ADR-0008 / issue #92, phase 9 of `docs/bootstrap-contract.md`.
 *
 * Adding an id here does NOT bump `PLAN_VERSION`. What version 1 freezes is the wire FORMAT —
 * the fields of a step and of a plan — and no field changed: `user-script` is one more value in
 * a namespace the format already defines, executed by the agent through the same
 * `run`/`runAs`/`optional`/`timeoutSeconds` path as every other step. An older agent handed a
 * plan containing it runs it correctly without knowing the name, which is the property the
 * freeze exists to protect; a new FIELD would not have that property, and would bump the
 * version.
 */
export const SINGLETON_STEP_IDS = ['branding', 'rdp', 'user-script', 'shell-environment', 'supplied-key-only'] as const

const stepId = z.string().min(1).refine(
  (id) => STEP_ID_PREFIXES.some((p) => id.startsWith(p) && id.length > p.length) || SINGLETON_STEP_IDS.includes(id as never),
  { error: `must be one of ${STEP_ID_PREFIXES.map((p) => `${p}<id>`).join(', ')} or ${SINGLETON_STEP_IDS.join('/')}` },
)

export const installStepSchema = z.strictObject({
  id: stepId,
  /**
   * Core's display vocabulary, deliberately LOSSY — several steps share one label. Core must
   * never infer which step finished from this; that is what `id` is for.
   */
  reports: z.string().min(1),
  runAs: z.enum(STEP_RUN_AS),
  run: z.string().min(1),
  /** Runs as the same user after `run` succeeds. A step is done only when both exit 0. */
  check: z.string().min(1).optional(),
  /** A failed optional step is recorded and the plan continues. */
  optional: z.boolean().optional(),
  /** Enforced with timeout(1) when available. 0 or absent means no timeout. */
  timeoutSeconds: z.int().nonnegative().optional(),
})

export const installPlanSchema = z
  .strictObject({
    version: z.literal(PLAN_VERSION),
    serverId: z.string().min(1),
    mode: z.enum(BOOTSTRAP_MODES),
    /** Identity of THIS bootstrap attempt. The journal echoes it; core ignores foreign runs. */
    runId: z.string().min(1),
    /** Callback mode only. */
    callbackUrl: z.url().optional(),
    steps: z.array(installStepSchema),
  })
  .refine((plan) => plan.mode !== 'callback' || Boolean(plan.callbackUrl), {
    error: 'callback mode requires a callbackUrl',
    path: ['callbackUrl'],
  })
  .refine((plan) => new Set(plan.steps.map((s) => s.id)).size === plan.steps.length, {
    error: 'step ids must be unique within a plan — they are the journal keys',
    path: ['steps'],
  })

export type InstallStep = z.infer<typeof installStepSchema>
export type InstallPlan = z.infer<typeof installPlanSchema>

/** Parse a snapshotted plan back off a server row. Throws with field paths on a bad shape. */
export function parseInstallPlan(value: unknown): InstallPlan {
  return installPlanSchema.parse(typeof value === 'string' ? JSON.parse(value) : value)
}

/**
 * Serialize for the snapshot and for the wire.
 *
 * Deterministic by construction: `JSON.stringify` preserves insertion order, the resolver
 * builds keys in a fixed order, and no field is derived from the clock. Two renders of the
 * same inputs are byte-identical, which is what makes "did the plan change?" answerable by
 * comparing strings.
 */
export function serializeInstallPlan(plan: InstallPlan): string {
  return JSON.stringify(plan, null, 2)
}
