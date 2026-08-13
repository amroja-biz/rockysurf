/**
 * `${VAR}` interpolation from the environment.
 *
 * Substitution runs over the PARSED document — every string value in the tree — not over the
 * raw file text. That ordering is load-bearing, and the example config is what proved it:
 *
 *  - a comment explaining the `${VAR}` syntax, or an optional setting commented out with its
 *    variable still written in it, would otherwise be substituted like real config, so merely
 *    *documenting* a variable would demand that it be set;
 *  - a token containing `#`, `:` or a quote could otherwise change the shape of the document
 *    rather than land in a field.
 *
 * The cost is that a reference can no longer expand into YAML *structure* — `${VAR}` is always
 * one string value. Nothing wants that, and the schema coerces the numeric fields, so both
 * `port: ${PORT}` and `port: "${PORT}"` arrive as a number.
 *
 * `$${VAR}` is an escape and yields a literal `${VAR}`.
 */

/** `$${NAME}` (escaped) or `${NAME}`. Anything else — `${}`, `${1A}`, a bare `$` — is left alone. */
const REFERENCE = /\$(\$?)\{([A-Za-z_][A-Za-z0-9_]*)\}/g

export class MissingEnvVarsError extends Error {
  readonly vars: readonly string[]

  constructor(vars: readonly string[]) {
    const list = vars.join(', ')
    super(
      vars.length === 1
        ? `environment variable ${list} is referenced but not set`
        : `environment variables are referenced but not set: ${list}`,
    )
    this.name = 'MissingEnvVarsError'
    this.vars = vars
  }
}

/**
 * What a reference becomes when the variable is not set.
 *
 * `blank` is for a caller that is going to throw anyway, so the substituted value never reaches
 * anyone. `keep` leaves `${NAME}` exactly as written, for a caller that means to CARRY ON with
 * the unset variable — see `interpolateTreeLeniently`.
 */
type UnsetPolicy = 'blank' | 'keep'

/** Substitute one string, recording any unset names in `missing` rather than throwing. */
function substitute(
  text: string,
  env: NodeJS.ProcessEnv,
  missing: string[],
  unsetBecomes: UnsetPolicy = 'blank',
): string {
  return text.replace(REFERENCE, (match, escape: string, name: string) => {
    if (escape === '$') return `\${${name}}`
    const value = env[name]
    if (value === undefined) {
      if (!missing.includes(name)) missing.push(name)
      return unsetBecomes === 'keep' ? match : ''
    }
    return value
  })
}

/**
 * Replace every `${VAR}` in a single string.
 *
 * Reports EVERY missing variable at once rather than failing on the first: someone filling in
 * a fresh config wants one list, not one round trip per variable.
 */
export function interpolateEnv(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const missing: string[] = []
  const result = substitute(text, env, missing)
  if (missing.length > 0) throw new MissingEnvVarsError(missing)
  return result
}

/** Walk a parsed YAML value, applying `visit` to every string. Objects and arrays are rebuilt. */
function mapStrings(value: unknown, visit: (s: string) => string): unknown {
  if (typeof value === 'string') return visit(value)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, visit))
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = mapStrings(item, visit)
    return out
  }
  return value
}

/**
 * Interpolate every string in a parsed config document, collecting missing variables across
 * the whole tree so one pass reports all of them.
 */
export function interpolateTree<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  const missing: string[] = []
  const result = mapStrings(value, (s) => substitute(s, env, missing)) as T
  if (missing.length > 0) throw new MissingEnvVarsError(missing)
  return result
}

/** A document interpolated as far as the environment allows, and what it is still waiting on. */
export interface LenientInterpolation<T> {
  value: T
  /** Names referenced by the document that this environment does not set, in traversal order. */
  unset: readonly string[]
}

/**
 * `interpolateTree`, for a caller that means to CARRY ON with an unset variable.
 *
 * AN UNSET VARIABLE MEANS TWO DIFFERENT THINGS, and that is the whole reason this exists
 * alongside the throwing version (rockysurf-1z5q):
 *
 *  - **At boot it is fatal.** A config naming a token the environment does not hold would
 *    otherwise start a control plane with an empty credential in it, so `interpolateTree`
 *    throws and `loadConfig` prints the list and exits. Nothing about that changes.
 *  - **At save it is ORDINARY.** The settings page asks for variable NAMES rather than for
 *    values (rockysurf-4o3o), so writing the reference and exporting the variable afterwards is
 *    the documented order, not a mistake. The file is ALLOWED to be ahead of the environment;
 *    that is what a reference is for. Refusing the save made the page unable to record the very
 *    thing it asks the operator to type.
 *
 * The reference is left as written rather than replaced with `''`, so the tree stays
 * structurally what the file says it is: a field declared as a non-empty string still holds a
 * non-empty string. A schema check on the result then reports the file's real shape instead of
 * a second error the substitution invented.
 */
export function interpolateTreeLeniently<T>(
  value: T,
  env: NodeJS.ProcessEnv = process.env,
): LenientInterpolation<T> {
  const unset: string[] = []
  const result = mapStrings(value, (s) => substitute(s, env, unset, 'keep')) as T
  return { value: result, unset }
}

/** Every `${VAR}` name in a string, in first-appearance order. Escapes excluded. */
export function referencedEnvVars(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(REFERENCE)) {
    const [, escape, name] = match
    if (escape === '$' || name === undefined) continue
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/** Every `${VAR}` name reachable in a parsed document, in traversal order. */
export function referencedEnvVarsIn(value: unknown): string[] {
  const names: string[] = []
  mapStrings(value, (s) => {
    for (const name of referencedEnvVars(s)) if (!names.includes(name)) names.push(name)
    return s
  })
  return names
}
