import type { SecretView, SettingsChange } from './api'

/**
 * ONE LIST OF ACCESS TOKENS, OVER TWO SHAPES IN THE FILE (rockysurf-5qzg, directive 2).
 *
 * `github.pat` and `github.tokens[]` are the same idea written twice: a token, and which
 * repositories it opens. An operator holding four fine-grained PATs does not think of one of
 * them as a different KIND of setting because it happens to be the one that covers everything
 * else — so the page shows a single list, in which **the entry naming no scope is the
 * instance-wide fallback**, and that entry is `github.pat`.
 *
 * ── WHY THE MAPPING LIVES HERE AND NOT IN THE SCHEMA ───────────────────────────────────
 * The obvious alternative is to let `github.tokens[]` hold an unscoped entry and drop `pat`.
 * The schema refuses exactly that (rockysurf-ta7g), and the refusal is right: an entry naming
 * no host, owner or repo "IS github.pat written longer", and allowing both spellings means two
 * places to write one value, with precedence rules to invent for when they disagree.
 *
 * So the unification is a RENDERING decision. Every change this module produces names a path
 * the config file already had — `github.pat`, or `github.tokens.<n>.<key>` — which is what
 * keeps the rest of the system unchanged: the route's field inventory, the zod validation, the
 * yaml Document write, the credential helper on the box. Nothing downstream knows the page drew
 * one list. Loosening the schema would have reached all of them.
 * ──────────────────────────────────────────────────────────────────────────────────────
 *
 * AT MOST ONE UNSCOPED ENTRY, and it is structural rather than a rule to enforce: there is one
 * `github.pat` key. A second unscoped entry has nowhere to go, so `refuseSecondFallback` says so
 * in a sentence instead of letting the schema reject `tokens[]` in words about a field the page
 * never showed.
 */

/** An entry of `github.tokens` as the redacted view hands it over: raw file keys, `pat` masked. */
export type RawTokenEntry = Record<string, unknown>

/** Where an entry of the unified list lives in the file. */
export type TokenTarget = { kind: 'fallback' } | { kind: 'scoped'; index: number }

export interface TokenEntry {
  target: TokenTarget
  /**
   * The scope box's text: `acme/widgets` for one repository, `acme` for an account, empty for
   * the fallback and for an entry scoped by host alone.
   */
  scope: string
  /** The host box's text — a self-hosted forge, or empty for github.com. */
  host: string
  /** What the file holds for this entry's token, already reduced to its state. */
  secret: SecretView
}

/** The dotted key an entry's field is held under, in the page's edit map. */
export function tokenKey(target: TokenTarget, field: 'scope' | 'host' | 'pat'): string {
  if (target.kind === 'fallback') return field === 'pat' ? 'github.pat' : `github.pat.${field}`
  return `github.tokens.${target.index}.${field === 'scope' ? 'repo' : field}`
}

/** The inventory path whose help and warning describe an entry's field. */
export function tokenSpecPath(target: TokenTarget, field: 'scope' | 'host' | 'pat'): string {
  if (target.kind === 'fallback') return 'github.pat'
  return `github.tokens.*.${field === 'scope' ? 'repo' : field}`
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * The scope box's text for a file entry.
 *
 * `repo: "acme/widgets"` (the one-string form, rockysurf-ly2n) is already what the box shows, so
 * it round-trips unchanged; the split `owner:`/`repo:` form renders as the same string. An entry
 * with a `repo` and no `owner` is a file the schema rejects — the box shows it as written,
 * because this editor exists to repair such a file and hiding the offending text would not help.
 */
export function scopeTextOf(entry: RawTokenEntry): string {
  const owner = text(entry['owner'])
  const repo = text(entry['repo'])
  if (repo.includes('/')) return repo
  if (owner && repo) return `${owner}/${repo}`
  return owner || repo
}

/** A secret state from the redacted tree, tolerating a file where the key is simply absent. */
function secretOf(value: unknown): SecretView {
  if (value && typeof value === 'object' && 'secret' in value) return value as SecretView
  return { secret: true, state: 'unset' }
}

/**
 * The unified list: the fallback first, then the scoped entries in file order.
 *
 * The fallback row is drawn whether or not a token is set, because it is a real slot in the file
 * with a real identity, and a list that hid it would leave "the token used for everything else"
 * with nowhere to be typed.
 */
export function unifiedTokens(values: unknown): TokenEntry[] {
  const github = (values as { github?: { pat?: unknown; tokens?: unknown } } | undefined)?.github
  const scoped = Array.isArray(github?.tokens) ? (github.tokens as RawTokenEntry[]) : []
  return [
    { target: { kind: 'fallback' }, scope: '', host: '', secret: secretOf(github?.pat) },
    ...scoped.map((entry, index) => ({
      target: { kind: 'scoped' as const, index },
      scope: scopeTextOf(entry ?? {}),
      host: text((entry ?? {})['host']),
      secret: secretOf((entry ?? {})['pat']),
    })),
  ]
}

/** What the entry is called — on its card, and in the confirmation before it is removed. */
export function describeScope(scope: string, host: string, target: TokenTarget): string {
  if (target.kind === 'fallback') return 'All repositories (fallback)'
  const one = scope.trim()
  const forge = host.trim()
  if (one && forge) return `${one} on ${forge}`
  if (one) return one
  if (forge) return `Everything on ${forge}`
  return 'No scope yet'
}

/**
 * The changes that write a scope box back into the file.
 *
 * TWO KEYS, ONE BOX. `acme/widgets` is written in the one-string form and `owner` is REMOVED,
 * because the schema refuses an entry that names an owner twice — it cannot know which reading
 * was meant, and neither can this page. `acme` is the mirror image. An `unset` is emitted only
 * for a key the entry actually has, so saving a scope does not add empty keys to the file.
 */
export function scopeChanges(index: number, scope: string, current: RawTokenEntry): SettingsChange[] {
  const one = scope.trim()
  const want: { owner?: string; repo?: string } =
    one === '' ? {} : one.includes('/') ? { repo: one } : { owner: one }

  return (['owner', 'repo'] as const).flatMap<SettingsChange>((key) => {
    const value = want[key]
    if (value !== undefined) return [{ path: ['github', 'tokens', index, key], value }]
    const present = current[key] !== undefined && current[key] !== null
    return present ? [{ path: ['github', 'tokens', index, key], unset: true }] : []
  })
}

/** A whole new `github.tokens` entry, written as one change so a half-entry never reaches the file. */
export function newScopedEntry(scope: string, host: string, pat: string): RawTokenEntry {
  const one = scope.trim()
  const forge = host.trim()
  return {
    ...(forge ? { host: forge } : {}),
    ...(one.includes('/') ? { repo: one } : one ? { owner: one } : {}),
    pat,
  }
}

/**
 * Why a new entry cannot be added yet, or null when it can.
 *
 * The two things a page can know without asking the server, said in its own words. Everything
 * else — a scope with a space in it, a duplicate of an existing entry — is the schema's job, and
 * the schema's message is better than anything restated here would be.
 */
export function refuseNewEntry(
  scope: string,
  host: string,
  pat: string,
  fallbackIsSet: boolean,
): string | null {
  if (pat.trim() === '') {
    return 'A token is required — an entry with a scope and no token would stop this file from loading.'
  }
  if (scope.trim() === '' && host.trim() === '' && fallbackIsSet) {
    return (
      'There is already a token with no scope, and it is the one used for everything unmatched. ' +
      'Give this entry a repository, an account or a host — or replace the token on the fallback entry above.'
    )
  }
  return null
}
