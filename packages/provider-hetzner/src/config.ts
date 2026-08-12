import { z } from 'zod'

/**
 * Hetzner provider configuration.
 *
 * Structurally a `ConfigSchema<HetznerProviderConfig>` from the SDK — zod's `parse` already
 * has that signature — which is how a provider gets a real validator while the SDK keeps zero
 * runtime dependencies.
 *
 * REGISTRATION FRICTION, recorded rather than solved here (and previously recorded from the
 * other side, in core's `src/config/schema.ts`): core's own config schema defines the
 * `providers.hetzner` section itself, because the dependency lint forbids core from importing
 * a concrete provider and the types-only SDK cannot export a zod schema. So THIS schema and
 * core's section describe the same thing in two places and can drift. The fix is a
 * registration-time handoff — core validates the raw section with the schema the provider
 * package exports, at the point where it constructs the provider — which needs providers to
 * be loaded through configuration rather than named statically. Out of scope for this task;
 * the factory below exports exactly what that handoff will need.
 */
export const hetznerConfigSchema = z.strictObject({
  /**
   * API token, read/write. Comes from the secrets store at runtime, never from a config file
   * in plaintext — `${HETZNER_TOKEN}` in the config file resolves before it reaches here.
   */
  token: z.string().min(1, { error: 'a Hetzner API token is required' }),

  /**
   * Default location. fsn1/nbg1/hel1 (EU), ash/hil (US), sin (Singapore).
   *
   * ONE location per provider instance, matching `listManaged()`'s construction-time scoping
   * (ADR-0003, D6): multi-region is deliberately unresolved in v0, and a process that needs
   * two regions constructs two providers.
   */
  location: z.string().trim().min(1).default('fsn1'),

  /** Base image. Overridable because pack authors may want a different Ubuntu LTS. */
  image: z.string().trim().min(1).default('ubuntu-24.04'),

  /**
   * The `managed-by` label value this provider owns.
   *
   * Everything it creates carries it, `listManaged()` filters on it, and `validateSpec()`
   * REFUSES a spec whose `managed-by` disagrees (ADR-0003, D3) — an instance tagged with
   * anything else is invisible to the reconciler and therefore an orphan from birth.
   */
  managedBy: z.string().trim().min(1).default('rockysurf'),
})

export type HetznerProviderConfig = z.output<typeof hetznerConfigSchema>

/** The parsed config plus the injection points tests and callers may override. */
export type HetznerProviderInput = HetznerProviderConfig & {
  fetchImpl?: typeof fetch
  baseUrl?: string
  maxRetries?: number
  retryBaseMs?: number
  sleep?: (ms: number) => Promise<void>
  /** Overrides the bundled price table. `rockysurf-gyp1.3` wires the config-file override. */
  prices?: import('./prices.js').PriceTable
  /** Overrides the describe() propagation grace. Never to skip it — only to lengthen it. */
  absenceGrace?: { attempts: number; delayMs: number }
}
