/**
 * TOKEN BOXES HOLD THE NAME OF AN ENVIRONMENT VARIABLE (rockysurf-4o3o).
 *
 * An owner directive, and the reasoning behind it is worth keeping next to the rule: the config
 * file gets backed up, copied to a second machine, pasted into an issue when something will not
 * start. `${GITHUB_PAT}` survives all of that and carries nothing; a pasted token turns every one
 * of those ordinary acts into a disclosure. Interpolation is already the contract — `config/
 * interpolate.ts` replaces the reference before the file is parsed, and an unset variable is a
 * boot error naming the variable rather than a mysterious empty token — so the GUI has no reason
 * to offer the other option.
 *
 * WHAT THE BOX SHOWS AND WHAT THE FILE GETS. The file's text is `${GITHUB_PAT}`; the box's text
 * is `GITHUB_PAT`. The braces are punctuation belonging to the file format, not something an
 * operator should have to type — but an operator who copies the line out of the file and pastes
 * it in is doing the obvious thing, so the `${...}` form is accepted and normalised rather than
 * refused. Both directions go through this module, so a value cannot round-trip into a different
 * one: what is read as `GITHUB_PAT` is written back as `${GITHUB_PAT}`.
 *
 * ── WHAT THIS CANNOT DO, STATED RATHER THAN PAPERED OVER ───────────────────────────────
 * The check is SYNTACTIC. `ghp_A1b2c3` is a legal environment variable name, so a GitHub token
 * pasted whole is shaped exactly like the thing this box wants and passes. A heuristic over
 * values — known token prefixes, a length cut-off — would catch some of those and refuse some
 * real variable names, which is a guess in both directions; `fields.ts` already rejects that
 * reasoning for the redaction classifier ("NAMES, NOT VALUE PATTERNS") and it is no better here.
 * So the policy is enforced by shape and stated in words, and the operator who is determined to
 * paste a token can still do it — as they always could, by opening the file.
 * ──────────────────────────────────────────────────────────────────────────────────────
 */

/**
 * A POSIX-ish environment variable name: a letter or underscore, then letters, digits and
 * underscores. Deliberately the same alphabet `config/interpolate.ts` matches and `view.ts`
 * accepts as a whole reference, because a name this box takes that the file's own interpolation
 * would not expand is a value that fails at boot instead of here.
 */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The same name written as the file writes it, and nothing else around it. */
const WHOLE_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

/**
 * Why a token box refused what was typed into it — the policy and the reason for it, in one
 * sentence an operator can act on.
 *
 * One constant, shown by every credential box on the page and asserted by name in the tests, so
 * the three boxes cannot drift into three explanations of one rule.
 */
export const ENV_VAR_ONLY =
  'This box takes the NAME of an environment variable, not the token itself — Rocky Surf reads ' +
  'the value from the environment at startup, so the configuration file holds only the reference ' +
  'and a copy of that file carries no credential. Use letters, digits and underscores, starting ' +
  'with a letter or an underscore: GITHUB_PAT, or ${GITHUB_PAT}.'

/**
 * The variable name in what an operator typed, or null when it is not one.
 *
 * Accepts the bare name and the `${...}` form, and trims — a name pasted with a trailing space is
 * still the name, and refusing it would be pedantry over a character nobody can see.
 */
export function envVarName(typed: string): string | null {
  const text = typed.trim()
  const braced = WHOLE_REFERENCE.exec(text)
  if (braced) return braced[1]!
  return ENV_VAR_NAME.test(text) ? text : null
}

/** What the file should hold for what was typed, or null when the box must refuse it. */
export function envVarReference(typed: string): string | null {
  const name = envVarName(typed)
  return name === null ? null : `\${${name}}`
}

/**
 * What the box shows for a reference the file already holds.
 *
 * Anything that is not a whole reference comes back unchanged, because this is display: a file
 * being repaired through this editor is exactly the one whose values do not fit the rule, and
 * blanking the offending text would hide what has to be fixed.
 */
export function envVarDisplay(reference: string): string {
  return envVarName(reference) ?? reference
}
