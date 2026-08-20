import { z } from 'zod'

/**
 * The frozen v0.1 pack file format, as a validator.
 *
 * `docs/writing-a-pack.md` is the normative statement of this format and this file must not
 * drift from it — `packs.test.ts` validates every shipped pack against these schemas, and the
 * document's own worked example is checked against them too, so a change here that the
 * document does not describe fails the suite.
 *
 * Everything is `strictObject`: an unrecognised key is an error rather than a silent no-op.
 * A contributor who misspells `requiresRdp` should be told, not ignored, because the failure
 * mode of ignoring it is a pack that quietly asks nobody for a password.
 */

/** Lowercase, hyphens, no spaces — the identity other packs reference. */
const ID = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    error: 'must be lowercase alphanumeric with single hyphens (e.g. "claude-code")',
  })

const NON_EMPTY = z.string().trim().min(1)

/**
 * Scripts are NOT trimmed. `.trim()` in zod is a transform, not a check — it rewrites the
 * value — and a script is content, not a label: stripping its trailing newline changes what
 * the file round-trips to and, in the general case, what actually runs. Only the whitespace
 * inside human-facing strings is worth normalising.
 */
const SCRIPT = z.string().min(1)

/**
 * The pack's post-boot guide: what a user has to do BY HAND once the box is theirs.
 *
 * Trimmed, unlike a SCRIPT, because nothing executes it — the surrounding blank lines of a
 * YAML block scalar are an artifact of writing it, not content. Trimming is also what keeps
 * the round-trip stable: `render` writes the trimmed value and re-parsing trims a no-op.
 */
const GUIDE = z.string().trim().min(1)

export const CATEGORIES = ['agent', 'base'] as const
export const RUN_AS = ['root', 'rocky'] as const
export const DESKTOPS = ['xfce'] as const

export const toolSchema = z.strictObject({
  toolId: ID,
  name: NON_EMPTY,
  description: NON_EMPTY,
  category: z.enum(CATEGORIES),
  url: z.url({ error: 'must be a URL, so a user can see what they are installing' }),
  installScript: SCRIPT,
  setupScript: SCRIPT.optional(),
  enabled: z.boolean(),
  installOrder: z.int(),
  /**
   * Reserved for the tools the runtime guarantees before any plan runs. The contract tells
   * pack authors to set `false` and says review will catch a `true`; it is not a parse error,
   * so an operator editing a row locally is not blocked. `packs.test.ts` asserts every
   * SHIPPED pack uses `false`, which is where that rule actually bites.
   */
  bootstrap: z.boolean(),
  runAs: z.enum(RUN_AS),
})

export const packSchema = z.strictObject({
  packId: ID,
  name: NON_EMPTY,
  tools: z.array(ID).min(1, { error: 'a pack with no tools installs nothing' }),
  displayOrder: z.int(),
  enabled: z.boolean(),
  imageUrl: NON_EMPTY.optional(),
  theme: NON_EMPTY.optional(),
  /**
   * What the user does once the box is ready: how to authenticate the agents this pack
   * installs, and anything else the install could not do on their behalf.
   *
   * Named `guide` rather than `instructions` deliberately. A pack file is already full of
   * instructions — `installScript` and `setupScript` — and every one of them is executed. This
   * field is the opposite: prose, shown to a person, never run. `guide` cannot be mistaken for
   * a fourth kind of script.
   *
   * Displayed verbatim as text, so write it as if for a terminal: short imperative lines and
   * literal commands. It is NOT rendered as markdown or HTML (see `ServerDetailPage`), which
   * is both the sanitisation posture and the reason not to lean on formatting.
   */
  guide: GUIDE.optional(),
  /**
   * Required in the parsed object, optional in the file. The contract documents them as
   * defaulting to false when omitted — requiring two booleans in every hand-written file is
   * friction with no safety benefit, and `false` is the harmless default for both.
   */
  requiresRepos: z.boolean().default(false),
  requiresRdp: z.boolean().default(false),
  desktop: z.enum(DESKTOPS).optional(),
  /**
   * The loopback port of a web UI this pack serves on the box, e.g. 3080 for DeepSeek
   * Harness. Declaring it makes the server page's Connect section render the `ssh -L`
   * command and the localhost URL — the same metadata-not-name-check contract as
   * `requiresRdp` (rockysurf-bbmi). Absent means the pack has no web UI to reach; it says
   * nothing about ports the user's own processes may open later.
   */
  webPort: z.int().min(1).max(65535).optional(),
})

export const packFileSchema = z.strictObject({
  /** The format freezes at v0.1. A future format announces itself here rather than by guess. */
  version: z.literal(1),
  pack: packSchema,
  /** May be empty: a pack composed entirely of tools defined in other files is legitimate. */
  tools: z.array(toolSchema),
})

export type ToolDefinition = z.infer<typeof toolSchema>
export type PackDefinition = z.infer<typeof packSchema>
export type PackFile = z.infer<typeof packFileSchema>
