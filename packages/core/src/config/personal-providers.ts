import { isHostnameSafeId } from '@rockysurf/provider-sdk'
import { z } from 'zod'

/**
 * PERSONAL PROVIDERS IN THE CONFIG FILE (ADR-0026, issue #294).
 *
 * The five providers this distribution ships are declared by name in `providersSchema`, each with
 * its own strict section. A provider Rocky Surf did NOT ship — an npm package the operator
 * installed, or a directory they are developing in — is one more key under `providers:` whose
 * section names the `package` that implements it:
 *
 * ```yaml
 * providers:
 *   digitalocean:
 *     package: "@someone/rockysurf-provider-digitalocean"   # or a path: ~/code/my-provider
 *     enabled: true
 *     token: "${DO_TOKEN}"                                  # the provider's own fields
 *     region: nyc3
 * ```
 *
 * WHY A KEY UNDER `providers:` AND NOT A LIST OF ITS OWN. Everything in core that knows what
 * clouds exist iterates `config.providers` — the setup wizard, `/health`, the composition root,
 * the size allowlist, `preferences.tiers`. A separate `personalProviders:` block would need every
 * one of those taught a second place to look; one more key needs none of them taught anything.
 *
 * WHY `package` IS REQUIRED. `providers` used to be a strict object, so `providers.hetzer:` was a
 * boot error naming the key — the typo protection every other section has. Admitting unknown keys
 * would have lost it. Requiring `package:` keeps it: a non-shipped key WITHOUT `package` is still
 * refused, and the message says what it would take to be a personal provider instead.
 *
 * WHAT CORE VALIDATES, AND WHAT IT DOES NOT. Core knows three fields of a personal section —
 * `enabled` (core's, orchestration), `package` (core's, where to load from) and `sizes` (core's,
 * the allowlist it applies to every catalogue). Everything else belongs to the provider and is
 * validated by the provider's own `configSchema` when the composition root constructs it, exactly
 * as a shipped provider's fields are — a typo there is reported as "not loaded — <the provider's
 * own sentence>" on the New Server page and in the boot log, never fatal.
 *
 * The `providers` type keeps its five declared sections typed and the rest as `unknown`, so no
 * shipped section's type is widened by an index signature. Read personal sections through
 * `personalProviderSections()`, which parses each one through the schema below.
 */

/** The ids `providersSchema` declares by name. Anything else under `providers:` is personal. */
export const SHIPPED_PROVIDER_IDS = ['aws', 'azure', 'gcp', 'hetzner', 'byo'] as const

export type ShippedProviderId = (typeof SHIPPED_PROVIDER_IDS)[number]

export function isShippedProviderId(id: string): id is ShippedProviderId {
  return (SHIPPED_PROVIDER_IDS as readonly string[]).includes(id)
}

/**
 * The instruction a non-shipped key gets when it names no `package`.
 *
 * Written as the thing to do rather than the thing that is wrong, because the operator seeing it
 * is either mistyping a shipped cloud or adding a personal one, and this sentence has to serve
 * both. The did-you-mean half is added separately, ahead of this, when the key is one character
 * away from a shipped id — see `providersSchemaPreprocess`.
 */
export function missingPackageMessage(id: string): string {
  return (
    `providers.${id} is not a provider Rocky Surf ships. A personal provider needs \`package:\` ` +
    'naming the npm package (installed under <dataDir>/providers) or the path that implements it — ' +
    'see docs/self-hosting.md, "Personal providers".'
  )
}

/**
 * The fields core itself reads from a personal section. `loose`, not `strict`: every other key is
 * the provider's own configuration and is validated by the provider's own schema at composition.
 */
export const personalProviderSectionSchema = z.looseObject({
  enabled: z.boolean().default(false),
  /**
   * An npm package name (resolved from `<dataDir>/providers`) or a path (absolute, `./`, `~`).
   * A path is anything the composition root can tell apart from a package name by its first
   * character; the rules are in `packages/rockysurf/src/personal-providers.ts`.
   */
  package: z.string().trim().min(1),
  /** The operator's allowlist, applied by core to this provider's catalogue like any other. */
  sizes: z.array(z.string().trim().min(1)).nonempty().optional(),
})

export type PersonalProviderSection = z.output<typeof personalProviderSectionSchema>

/** Levenshtein distance, for "did you mean hetzner?" — small inputs, no need for anything clever. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const d: number[][] = Array.from({ length: rows }, (_, i) => [i, ...new Array<number>(cols - 1).fill(0)])
  for (let j = 1; j < cols; j++) d[0]![j] = j
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
    }
  }
  return d[rows - 1]![cols - 1]!
}

/** A shipped id within one edit of `id`, when there is one. */
export function nearestShippedProviderId(id: string): ShippedProviderId | undefined {
  return SHIPPED_PROVIDER_IDS.find((shipped) => editDistance(id.toLowerCase(), shipped) <= 1)
}

/**
 * Validate the non-shipped keys of a raw `providers` block, adding one issue per problem.
 *
 * Runs as a `superRefine` on the providers object, AFTER the five shipped sections have parsed,
 * over the raw values the catchall admitted. Three refusals, in the order an operator would want
 * them:
 *
 *  1. a key one edit away from a shipped id with no `package` — "did you mean hetzner?", because
 *     the most common way to reach this code is a typo and telling that operator to install a
 *     package is confidently wrong advice;
 *  2. a key that is not a lowercase, hostname-safe id — it is the provider id and the key of a
 *     config section, so the rule `ProvisionSpec.serverId` follows applies to it;
 *  3. anything the section schema above refuses, with `package` absent phrased as the instruction.
 */
export function refinePersonalProviderSections(
  providers: Record<string, unknown>,
  ctx: { addIssue: (issue: { code: 'custom'; path: (string | number)[]; message: string }) => void },
): void {
  for (const [id, raw] of Object.entries(providers)) {
    if (isShippedProviderId(id)) continue
    const section = raw === null || raw === undefined ? {} : raw
    const hasPackage =
      typeof section === 'object' && typeof (section as { package?: unknown }).package === 'string'

    if (!hasPackage) {
      const nearest = nearestShippedProviderId(id)
      if (nearest) {
        ctx.addIssue({
          code: 'custom',
          path: [id],
          message: `providers.${id} is not a provider Rocky Surf ships — did you mean ${nearest}?`,
        })
        continue
      }
    }

    if (!isHostnameSafeId(id) || id !== id.toLowerCase()) {
      ctx.addIssue({
        code: 'custom',
        path: [id],
        message:
          `providers.${id}: a provider id is lowercase letters, digits and hyphens, starting with a letter ` +
          '— it names the provider everywhere Rocky Surf shows it and is the key of this section.',
      })
      continue
    }

    const parsed = personalProviderSectionSchema.safeParse(section)
    if (parsed.success) continue
    for (const issue of parsed.error.issues) {
      const missingPackage = issue.path[0] === 'package' && (section as { package?: unknown }).package === undefined
      ctx.addIssue({
        code: 'custom',
        path: [id, ...(issue.path as (string | number)[])],
        message: missingPackage ? missingPackageMessage(id) : issue.message,
      })
    }
  }
}

/**
 * Every personal section in a parsed config, keyed by provider id, with core's three fields
 * parsed and defaulted and the provider's own fields carried through untouched.
 *
 * Cannot throw on a config `configSchema` accepted: the refine above already ran the same schema.
 */
export function personalProviderSections(config: {
  providers: Record<string, unknown>
}): Record<string, PersonalProviderSection> {
  const out: Record<string, PersonalProviderSection> = {}
  for (const [id, raw] of Object.entries(config.providers)) {
    if (isShippedProviderId(id)) continue
    out[id] = personalProviderSectionSchema.parse(raw ?? {})
  }
  return out
}

/**
 * The non-shipped keys of a RAW `providers` tree — a file that may not validate at all.
 *
 * For the settings page, which has to draw a panel for a personal section the operator is in the
 * middle of getting wrong (a mistyped `package:`), and so cannot wait for `configSchema` to
 * accept the file first.
 */
export function personalProviderIdsIn(tree: unknown): string[] {
  const providers = (tree as { providers?: unknown } | null)?.providers
  if (providers === null || typeof providers !== 'object') return []
  return Object.keys(providers as Record<string, unknown>).filter((id) => !isShippedProviderId(id))
}

/** `providers.<id>.enabled` for a shipped or personal id, without caring which. */
export function providerEnabled(config: { providers: Record<string, unknown> }, id: string): boolean {
  const section = config.providers[id]
  return typeof section === 'object' && section !== null && (section as { enabled?: unknown }).enabled === true
}

/** The ids of every provider section in the file, shipped first in schema order, then personal. */
export function providerIdsIn(config: { providers: Record<string, unknown> }): string[] {
  return Object.keys(config.providers)
}
