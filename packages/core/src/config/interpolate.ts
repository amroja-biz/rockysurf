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

/** Substitute one string, recording any unset names in `missing` rather than throwing. */
function substitute(text: string, env: NodeJS.ProcessEnv, missing: string[]): string {
  return text.replace(REFERENCE, (_match, escape: string, name: string) => {
    if (escape === '$') return `\${${name}}`
    const value = env[name]
    if (value === undefined) {
      if (!missing.includes(name)) missing.push(name)
      return ''
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
