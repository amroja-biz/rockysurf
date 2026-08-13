import { createHash } from 'node:crypto'
import { isSecretPath } from './fields.js'

/**
 * THE REDACTED VIEW: what the settings API is allowed to say about a config file.
 *
 * The custody rule for this feature, and the reason `secrets/route-inventory.test.ts` needs no
 * new exemption: **a literal credential never leaves this process.** The GET does not decrypt
 * anything — it never touches the secrets store at all — but the config file itself may hold a
 * pasted token, and handing that back to a browser would be the same leak by a different route.
 * So every secret-classified field arrives at the client as one of three states and nothing
 * more.
 *
 * A `${VAR}` REFERENCE IS NOT A SECRET. It is the name of a variable, the file's own text, and
 * an operator who wants to point a field at a different variable has to be able to read the one
 * it points at now. So a reference travels verbatim, flagged as a reference so the editor can
 * render it as one — and, crucially, so a save writes the reference back rather than baking in
 * whatever the variable expanded to at boot.
 *
 * THE WHOLE VALUE, OR NOTHING. `"${HETZNER_TOKEN}"` is a reference. `"tok_live_${SUFFIX}"` is
 * not — it is a literal with a variable in it, and returning it verbatim would hand back the
 * literal half. Mixed values are therefore masked as `set`, which costs an operator the ability
 * to see a half-interpolated value in the browser and costs nobody a leak.
 */

/** Exactly one reference and nothing else. Deliberately stricter than `interpolate.ts`'s. */
const WHOLE_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/

export type SecretView =
  | { secret: true; state: 'unset' }
  | { secret: true; state: 'reference'; reference: string }
  | { secret: true; state: 'set' }

export function secretView(value: unknown): SecretView {
  if (value === undefined || value === null || value === '') return { secret: true, state: 'unset' }
  if (typeof value === 'string' && WHOLE_REFERENCE.test(value)) {
    return { secret: true, state: 'reference', reference: value }
  }
  return { secret: true, state: 'set' }
}

/**
 * A parsed config tree with every secret-classified value replaced by its state.
 *
 * Applied to the file's raw tree AND to the schema's defaults, so there is no second path by
 * which a value could reach a response unmasked. Structure is preserved exactly — including
 * keys the schema does not recognise, because a file the editor is being used to REPAIR is
 * precisely one that does not validate, and a view that dropped the offending key would hide
 * the thing the operator has to fix.
 */
export function redactTree(value: unknown, path: readonly (string | number)[] = []): unknown {
  if (path.length > 0 && isSecretPath(path)) return secretView(value)
  if (Array.isArray(value)) return value.map((item, i) => redactTree(item, [...path, i]))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = redactTree(item, [...path, key])
    return out
  }
  return value
}

/**
 * A fingerprint of a config file's VALUES — the cheap half of restart honesty.
 *
 * Taken once when the app is built (which is boot) and again on every read, so the page can say
 * whether the file on disk still matches what the running process loaded. Two consequences,
 * both wanted:
 *
 *  - a comment-only edit does not count as drift, because this hashes the parsed tree rather
 *    than the bytes;
 *  - a successful save DOES, permanently, until a restart. That is not a wart — it is the same
 *    fact the restart banner states, arriving by a route that survives a page reload. The
 *    banner is not a toast that a refresh can lose; it is a property of the file.
 *
 * The hash is one-way and never returned; the tree it is taken over is the file's own, secrets
 * included, because a fingerprint that ignored the fields most worth noticing a change in would
 * be worth very little.
 */
export function fingerprint(tree: unknown): string {
  return createHash('sha256').update(stableJson(tree)).digest('hex').slice(0, 16)
}

/** JSON with object keys sorted, so re-ordering a map is not reported as a value change. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
