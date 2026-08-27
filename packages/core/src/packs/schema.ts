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

/* ------------------------------------------------------------------------- pack inputs */

/**
 * Every environment variable Rocky Surf itself puts in front of a bootstrap step, and
 * therefore every name a pack's `inputs` may NOT claim (issue #189, ADR-0013).
 *
 * THE LIST IS HERE, IN THE FORMAT FILE, ON PURPOSE. `inputs` is the first pack field whose
 * value becomes a shell variable in the same environment core's own variables live in, so
 * "which names are already taken" is part of the file format rather than a runtime detail.
 * A pack that declared `HOME` would not override anything — `agent.sh` exports its own
 * afterwards — it would simply produce a pack whose install script reads a value nobody sent.
 * Refusing at validation is the only place that failure is cheap.
 *
 * `server-secrets.test.ts` asserts `SECRET_ENV_KEY_NAMES` is a subset of this set, so a future
 * name added to the `secrets.env` contract cannot quietly become claimable by a pack.
 *
 * Sources, in the order a reader should check them:
 *  - `bootstrap/agent.sh`: `ARCH`, `DEBIAN_FRONTEND`, `HOME`, `USER`, `LOGNAME`;
 *  - `bootstrap/server-secrets.ts` `SECRET_ENV_KEYS`: `GITHUB_TOKEN`, `RDP_PASSWORD`;
 *  - `bootstrap/resolver.ts` `setupPreamble`: `REPOS`, and the `GIT_*` names below;
 *  - the shell itself: `PATH`, `SHELL`, `PWD`, `IFS`, and the rest.
 */
export const RESERVED_INPUT_NAMES: ReadonlySet<string> = new Set([
  // the agent's own environment
  'ARCH',
  'DEBIAN_FRONTEND',
  'HOME',
  'USER',
  'LOGNAME',
  // the secrets.env key-name contract
  'GITHUB_TOKEN',
  'RDP_PASSWORD',
  // the setup/user-script preamble
  'REPOS',
  // the shell's own, where a pack's value would break the step rather than reach it
  'PATH',
  'SHELL',
  'PWD',
  'OLDPWD',
  'IFS',
  'LANG',
  'LC_ALL',
  'TERM',
  'BASH_ENV',
  'ENV',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
])

/**
 * Whole NAMESPACES a pack may not claim, checked as prefixes.
 *
 * `ROCKYSURF_` is core's own (`ROCKYSURF_GITHUB_TOKEN_<n>`, `ROCKYSURF_STATE_DIR`,
 * `ROCKYSURF_APT_RETRY_WAIT_S`) and is variable-length, so an exact-name list could never
 * close it. `GIT_` is git's, and the setup preamble already writes four of them
 * (`GIT_TERMINAL_PROMPT`, `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`) —
 * a pack that set one would break the credential path for every private clone on the box.
 */
export const RESERVED_INPUT_PREFIXES: readonly string[] = ['ROCKYSURF_', 'GIT_']

/** A pack input name is an environment variable name, spelled the way shell scripts spell one. */
const INPUT_NAME = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/, {
    error: 'must be an UPPER_SNAKE_CASE environment variable name (e.g. "HEADLONG_HEADLESS")',
  })
  .refine((name) => !RESERVED_INPUT_NAMES.has(name), {
    error: 'is a name Rocky Surf already exports to every step — choose one in your pack\'s own namespace',
  })
  .refine((name) => !RESERVED_INPUT_PREFIXES.some((prefix) => name.startsWith(prefix)), {
    error: `must not start with ${RESERVED_INPUT_PREFIXES.join(' or ')} — those namespaces belong to Rocky Surf and to git`,
  })

/**
 * How much text one input may carry, at rest and on the wire.
 *
 * 4 KiB is generous for what this field is for — a flag, a key, an endpoint, a model name —
 * and small enough that sixteen of them cannot make a server row or a `secrets.env` line
 * unbounded. A pack that wants to hand a box a document wants a repository, not an input.
 */
export const PACK_INPUT_MAX_VALUE_BYTES = 4096

/** How many inputs one pack may declare. A create form is a form, not a questionnaire. */
export const PACK_INPUT_MAX_COUNT = 16

/**
 * ONE VALUE, ONE LINE — the constraint the delivery mechanism imposes, stated in the format.
 *
 * Inputs reach the box through `secrets.env`, which is `KEY=value` lines that `agent.sh`
 * sources and whose NAMES it re-reads line by line to forward into unprivileged steps. A value
 * containing a newline would appear to that reader as a second variable, so the second line of
 * somebody's PEM would become an environment variable name. Values are single-quoted by the
 * writer (`bootstrap/push.ts`), which makes spaces, `$` and backticks safe; a newline it cannot
 * make safe, so it is refused here and by the create route.
 */
export const packInputValueSchema = z
  .string()
  // BYTES, not characters, and the distinction is the reason this is a refine rather than
  // zod's `.max()`: the ceiling is about what a `secrets.env` line and a database column carry,
  // and a 4096-character value of three-byte glyphs is three times the number quoted here.
  .refine((value) => Buffer.byteLength(value, 'utf8') <= PACK_INPUT_MAX_VALUE_BYTES, {
    error: `must be at most ${PACK_INPUT_MAX_VALUE_BYTES} bytes`,
  })
  .refine((value) => !/[\n\r\0]/.test(value), {
    error: 'must be a single line — no newlines or NUL (values travel as KEY=value lines in secrets.env)',
  })

/**
 * One value a pack asks the person creating a server for (issue #189).
 *
 * WHY THIS IS PACK-LEVEL AND NOT TOOL-LEVEL. The declaration exists so a form can ask, and the
 * thing a user chooses on that form is a PACK. A tool-level list would have to be flattened
 * into one form section anyway (a tool the pack references from another file contributes its
 * inputs too), collisions between two tools' identical names would need a resolution rule
 * nobody asked for, and the delivery is pack-wide regardless: `secrets.env` is one file, read
 * by every step of every tool on the box. Declaring at the level the value is actually scoped
 * to is the honest shape. A tool that needs a value says so in the pack that ships it.
 */
export const packInputSchema = z
  .strictObject({
    /** The environment variable the install script reads. */
    name: INPUT_NAME,
    /** The form's field label. Required — an unlabelled field asks a question in code. */
    label: NON_EMPTY,
    /** Rendered as the field's hint. Say what the value does and what a good one looks like. */
    description: NON_EMPTY.optional(),
    /**
     * Required in the parsed object, optional in the file — the same treatment `requiresRepos`
     * and `requiresRdp` get, and for the same reason: `false` is the harmless default and
     * spelling two booleans in every entry is friction with no safety benefit.
     */
    required: z.boolean().default(false),
    /**
     * A password field on the form, never returned by any route, never in the plan snapshot,
     * and stored the way the desktop password is (ADR-0013).
     */
    secret: z.boolean().default(false),
    /** Prefilled on the form and applied by the route when the request omits the name. */
    default: packInputValueSchema.optional(),
  })
  .refine((input) => !(input.secret && input.default !== undefined), {
    error: 'a secret input cannot have a default — a credential shipped in a pack file is not a secret',
    path: ['default'],
  })

/**
 * A pack's inputs, as they appear on the pack.
 *
 * Refuses duplicates rather than letting the last one win: two entries for one name means the
 * form renders two fields writing one variable, and which of them the box receives would be
 * decided by array order.
 */
export const packInputsSchema = z
  .array(packInputSchema)
  .max(PACK_INPUT_MAX_COUNT, { error: `a pack may declare at most ${PACK_INPUT_MAX_COUNT} inputs` })
  .superRefine((inputs, ctx) => {
    const seen = new Set<string>()
    inputs.forEach((input, index) => {
      if (seen.has(input.name)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate input name "${input.name}" — one name, one field`,
          path: [index, 'name'],
        })
      }
      seen.add(input.name)
    })
  })

export type PackInput = z.infer<typeof packInputSchema>

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
  /**
   * Values this pack needs from the person creating the server, delivered to every bootstrap
   * step as environment variables (issue #189, ADR-0013).
   *
   * The same metadata-not-name-check contract `requiresRdp` established: the create form
   * renders one field per entry from this declaration and no code anywhere compares a
   * `packId`. Absent means the pack asks for nothing, which is every pack shipped today.
   *
   * The values themselves never appear in a pack file and never appear in the install plan —
   * they travel in `secrets.env`, the 0600 file `agent.sh` sources before the first step. This
   * field is the QUESTION; the answer belongs to one server.
   */
  inputs: packInputsSchema.optional(),
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
