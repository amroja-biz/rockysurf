import { PACK_INPUT_MAX_VALUE_BYTES, packInputValueSchema, type PackInput } from './schema.js'

/**
 * Checking what a create request sent against what the pack asked for (issue #189, ADR-0013).
 *
 * ONE IMPLEMENTATION, THREE CALLERS. The create route runs it, the CLI runs it before its POST
 * so a typo costs a sentence rather than a round trip, and the tests run it directly. A second
 * copy of these rules anywhere would be a second answer to "is this request valid", and the
 * surfaces would drift apart on exactly the cases that matter — a name off by one letter, a
 * required value the form let through.
 *
 * IT SPLITS THE VALUES AS IT VALIDATES THEM, which is the whole reason it returns two records
 * rather than one. A non-secret value goes on the server row, so a re-render months later
 * produces the same environment and the detail page can show what the box was built with; a
 * secret one goes to the encrypted store beside the desktop password and is never returned by
 * any route. The declaration is the only thing that knows which is which, so the split belongs
 * where the declaration is read — not at the call site, where forgetting it would put a
 * credential in a column.
 */

export interface PackInputIssue {
  /** A path into the request body, so a form can put the message on the field. */
  path: string
  message: string
}

export interface ResolvedPackInputs {
  /** Non-secret values, destined for the server row. Empty is a legitimate answer. */
  values: Record<string, string>
  /** Secret values, destined for the secrets store. Never rendered anywhere. */
  secrets: Record<string, string>
  /** Empty means the request is good. Non-empty means refuse it and say all of this. */
  issues: PackInputIssue[]
}

/**
 * How much a single server's inputs may weigh in total.
 *
 * Bounded separately from the per-value ceiling because sixteen maximum-length values is 64 KiB
 * of `secrets.env` on a box, of JSON in a column, and of request body — each individually
 * within its own limit. The number is the per-value ceiling times four, which is roomier than
 * any real pack and still an order of magnitude below anything that would matter.
 */
export const PACK_INPUTS_MAX_TOTAL_BYTES = PACK_INPUT_MAX_VALUE_BYTES * 4

/**
 * Resolve a create request's `packInputs` against the selected pack's declaration.
 *
 * WHAT AN ABSENT VALUE MEANS, in the three cases that differ:
 *
 *  - declared with a `default` → the default is applied, so the box receives the variable the
 *    pack promised its own scripts even though the user typed nothing;
 *  - declared `required` with no default → refused, because the alternative is a bootstrap that
 *    fails at the pack's own install step after a machine has been launched and billed;
 *  - declared neither → OMITTED ENTIRELY, never sent as the empty string. This is the same rule
 *    `secrets.env` has always had for `RDP_PASSWORD`: an empty value satisfies a naive `-z`
 *    guard and then configures something with nothing, while an absent one lets the script's
 *    own `${FOO:-}` default do its job.
 */
export function resolvePackInputs(
  declared: readonly PackInput[] | undefined,
  submitted: Readonly<Record<string, string>> | undefined,
): ResolvedPackInputs {
  const issues: PackInputIssue[] = []
  const values: Record<string, string> = {}
  const secrets: Record<string, string> = {}

  const declarations = new Map((declared ?? []).map((input) => [input.name, input]))
  const sent = submitted ?? {}

  /*
   * UNKNOWN NAMES ARE REFUSED, NOT IGNORED (ADR-0013).
   *
   * Ignoring one would put a value the caller believes is on the box nowhere at all, and the
   * failure would surface as an install script reading an empty variable — the least
   * debuggable form of this mistake. It is also the check that keeps `inputs` a declaration
   * rather than a free-form env dictionary: a caller cannot set a variable the pack never
   * asked for, so the environment a pack author reasons about is the one they wrote down.
   */
  for (const name of Object.keys(sent)) {
    if (declarations.has(name)) continue
    issues.push({
      path: `packInputs.${name}`,
      message: declarations.size
        ? `this pack does not ask for "${name}". It asks for: ${[...declarations.keys()].join(', ')}`
        : `this pack asks for no inputs, so "${name}" has nowhere to go`,
    })
  }

  let totalBytes = 0
  for (const input of declarations.values()) {
    const supplied = Object.hasOwn(sent, input.name) ? sent[input.name]! : undefined
    const value = supplied ?? input.default

    if (value === undefined || value === '') {
      if (input.required) {
        issues.push({
          path: `packInputs.${input.name}`,
          message: `${input.label} is required by this pack`,
        })
      }
      continue
    }

    const parsed = packInputValueSchema.safeParse(value)
    if (!parsed.success) {
      issues.push({
        path: `packInputs.${input.name}`,
        message: `${input.label}: ${parsed.error.issues[0]?.message ?? 'is not a value this field accepts'}`,
      })
      continue
    }

    totalBytes += Buffer.byteLength(value, 'utf8')
    if (input.secret) secrets[input.name] = value
    else values[input.name] = value
  }

  if (totalBytes > PACK_INPUTS_MAX_TOTAL_BYTES) {
    issues.push({
      path: 'packInputs',
      message: `the values together are ${totalBytes} bytes, and at most ${PACK_INPUTS_MAX_TOTAL_BYTES} are accepted`,
    })
  }

  return { values, secrets, issues }
}

/**
 * What the disclosure and the pack list say a pack will ask for — names and labels, never a
 * value, and `secret` so a reader can see which answer will be stored encrypted.
 *
 * A projection rather than the raw declaration because `default` is deliberately not part of
 * it in every place: the create form needs the default in order to prefill, and a pack listing
 * does not, so the listing gets this and the form gets the whole entry.
 */
export interface PackInputSummary {
  name: string
  label: string
  required: boolean
  secret: boolean
}

export const summarizePackInputs = (inputs: readonly PackInput[] | undefined): PackInputSummary[] =>
  (inputs ?? []).map((input) => ({
    name: input.name,
    label: input.label,
    required: input.required,
    secret: input.secret,
  }))
