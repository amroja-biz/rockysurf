import { ENV_TOTAL_MAX_BYTES, envVarNameSchema, envVarValueSchema } from '../env/names.js'
import type { PackInput } from '../packs/schema.js'

/**
 * The Environment a person hands their own box at create time (issue #197, ADR-0014).
 *
 * THE SECOND CONTRIBUTOR TO ONE ENVIRONMENT. A pack's `inputs` (issue #189, ADR-0013) are the
 * PACK author's namespace: declared in the pack file, rendered as labelled fields, and refused
 * when a name is not declared. This is the USER's namespace: nothing declares it, because the
 * whole point is the value the pack did not think of — the token a startup script needs, an
 * endpoint for a tool installed by hand. Both land in the same `secrets.env`, so both are
 * checked by the same name and value rules in `env/names.ts`.
 *
 * IT SPLITS THE VALUES AS IT VALIDATES THEM, exactly as `resolvePackInputs` does and for the
 * same reason: a secret value goes to the encrypted store and a plain one goes on the server
 * row, and the split has to be made once, where the `secret` flag is read, rather than at a
 * call site where forgetting it would put a credential in a column.
 */

/** One line of the Environment field, as it arrives on the wire. */
export interface EnvironmentEntry {
  value: string
  /**
   * Whether this one is stored encrypted and returned by no route.
   *
   * ON THE ENTRY, not inferred from the name. There is no declaration to consult — the user
   * marked the line — so the request is the only thing that can say, and it says it per entry
   * rather than as a second parallel map: two maps would make a name that appeared in both a
   * question nobody has an answer for.
   */
  secret?: boolean
}

export interface EnvironmentIssue {
  /** A path into the request body, so a form can put the message beside the offending line. */
  path: string
  message: string
}

export interface ResolvedEnvironment {
  /** Plain values, destined for the server row and the detail page. */
  values: Record<string, string>
  /** Secret values, destined for the secrets store. Never rendered anywhere. */
  secrets: Record<string, string>
  /** Empty means the request is good. Non-empty means refuse it and say all of this. */
  issues: EnvironmentIssue[]
}

/**
 * How many variables one person may put on one box by hand.
 *
 * Higher than a pack's sixteen because this is a paste target rather than a rendered form — a
 * user moving an existing `.env` onto a box is the case — and low enough that the field is
 * still an environment rather than a configuration file. The total-byte ceiling is the real
 * bound; this one exists so a runaway paste is refused by a sentence about counting rather
 * than by a sentence about bytes.
 */
export const ENVIRONMENT_MAX_ENTRIES = 32

/**
 * Resolve the Environment a create request carried.
 *
 * `declaredInputNames` is the selected pack's `inputs`, and the ONLY thing it is used for is
 * refusing a collision. A name that a pack asks for and the user also sets by hand has two
 * answers and no rule choosing between them; picking one silently is how a box ends up
 * configured with a value nobody can point at. So it is a 400 that names the key and says
 * which field to use instead — the same doctrine as `resolvePackInputs` refusing an unknown
 * name rather than dropping it.
 *
 * The collision is checked against what the pack DECLARES, not against what the user answered.
 * An optional input left blank still owns its name on this box: the form shows a field for it,
 * the pack's guide talks about it, and a second field quietly writing the same variable would
 * be indistinguishable from a bug.
 */
export function resolveServerEnvironment(
  submitted: Readonly<Record<string, EnvironmentEntry>> | undefined,
  declaredInputNames: readonly PackInput[] | undefined,
): ResolvedEnvironment {
  const issues: EnvironmentIssue[] = []
  const values: Record<string, string> = {}
  const secrets: Record<string, string> = {}

  const entries = Object.entries(submitted ?? {})
  if (entries.length === 0) return { values, secrets, issues }

  if (entries.length > ENVIRONMENT_MAX_ENTRIES) {
    issues.push({
      path: 'environment',
      message: `at most ${ENVIRONMENT_MAX_ENTRIES} environment variables can be set on one server, and this request has ${entries.length}`,
    })
    return { values, secrets, issues }
  }

  const declared = new Set((declaredInputNames ?? []).map((input) => input.name))
  let totalBytes = 0

  for (const [name, entry] of entries) {
    const parsedName = envVarNameSchema.safeParse(name)
    if (!parsedName.success) {
      issues.push({
        path: `environment.${name}`,
        message: `"${name}" ${parsedName.error.issues[0]?.message ?? 'is not a name this field accepts'}`,
      })
      continue
    }

    /*
     * THE COLLISION, refused rather than resolved (issue #197).
     *
     * Never a silent precedence: whichever way it went, one of the two things the user filled
     * in would vanish, and the one that vanished would be invisible — the form would still
     * show both, the box would carry one. Naming the key and the other field is the whole
     * remedy, because the user is looking at both fields as they read it.
     */
    if (declared.has(name)) {
      issues.push({
        path: `environment.${name}`,
        message: `${name} is already a setting this pack asks for — set it in the pack's own field above rather than in Environment`,
      })
      continue
    }

    const parsedValue = envVarValueSchema.safeParse(entry.value)
    if (!parsedValue.success) {
      issues.push({
        path: `environment.${name}`,
        message: `${name} ${parsedValue.error.issues[0]?.message ?? 'is not a value this field accepts'}`,
      })
      continue
    }

    /*
     * AN EMPTY VALUE IS A VARIABLE SET TO EMPTY, and it is kept.
     *
     * The opposite of the pack-input rule, deliberately. There, an absent optional answer is
     * omitted so the pack's own `${FOO:-}` default can fire — the pack declared the name and
     * has a fallback for it. Here the user WROTE `FOO=` on a line of their own accord, and the
     * only thing that can mean is "put FOO in the environment, empty". Dropping it would make
     * a line the user typed do nothing at all.
     */
    totalBytes += Buffer.byteLength(entry.value, 'utf8')
    if (entry.secret) secrets[name] = entry.value
    else values[name] = entry.value
  }

  if (totalBytes > ENV_TOTAL_MAX_BYTES) {
    issues.push({
      path: 'environment',
      message: `the environment values together are ${totalBytes} bytes, and at most ${ENV_TOTAL_MAX_BYTES} are accepted`,
    })
  }

  return { values, secrets, issues }
}
