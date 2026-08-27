import type { ServerEnvironmentEntry } from './api'

/**
 * The Environment field on the create form: `KEY=value` lines, some marked `secret:`
 * (issue #197, ADR-0014).
 *
 * WHY A LINE PREFIX AND NOT A CHECKBOX LIST. The alternative in the issue was a row of
 * checkboxes beside the parsed lines. It needs a stable identity per line to hang state on, and
 * a textarea has none: a name typed one character at a time is a different name on every
 * keystroke, a reordered paste re-associates every box, and a deleted line leaves a checkbox
 * pointing at nothing. `secret:` is one control instead of two, it survives a paste and a
 * reload because it is part of the text, and it is the SAME format `--env-file` reads — so a
 * person can move an environment between the form and the CLI without translating it. The
 * marker cannot be mistaken for a name, because a name is UPPER_SNAKE_CASE and this is not.
 *
 * NOTHING HERE IS THE AUTHORITY. Core re-checks every name and value at the create route and
 * 400s what it does not like; this exists so the common mistakes cost a sentence rather than a
 * round trip, and so the page can send structure rather than a blob.
 */

/** The marker that puts a line's value in the encrypted store instead of on the row. */
export const SECRET_LINE_PREFIX = 'secret:'

export interface ParsedEnvironment {
  /** Keyed by variable name — the shape `POST /api/v1/servers` takes. */
  entries: Record<string, ServerEnvironmentEntry>
  /** One sentence per bad line, each naming the line number. Empty means the text is good. */
  errors: string[]
}

/**
 * Parse the textarea.
 *
 * Blank lines and `#` comments are skipped, a name is trimmed, and a value has one optional
 * layer of surrounding quotes stripped — the same reading `--env-file` gives the same text.
 * Nothing is expanded and nothing is run: this text is bound for a file whose whole purpose is
 * to carry values a shell must never interpret.
 *
 * A duplicate name is an ERROR rather than a last-one-wins, because both lines are visible in
 * the box the user is looking at and only one of them would reach the machine.
 */
export function parseEnvironment(text: string): ParsedEnvironment {
  const entries: Record<string, ServerEnvironmentEntry> = {}
  const errors: string[] = []

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return

    const secret = line.startsWith(SECRET_LINE_PREFIX)
    const body = secret ? line.slice(SECRET_LINE_PREFIX.length).trim() : line

    // The FIRST `=`, because a value may legitimately contain one — a base64 key ends in `=`,
    // a query string is full of them.
    const at = body.indexOf('=')
    if (at <= 0) {
      errors.push(`Line ${index + 1} is not KEY=value: ${line}`)
      return
    }

    const name = body.slice(0, at).trim()
    let value = body.slice(at + 1).trim()
    // One layer, and only when both ends match. A value quoted at one end only is far more
    // likely to be a value containing a quote than a typo worth silently repairing.
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0]!)) {
      value = value.slice(1, -1)
    }

    if (Object.hasOwn(entries, name)) {
      errors.push(`Line ${index + 1} sets ${name} again — one name, one line`)
      return
    }

    entries[name] = secret ? { value, secret: true } : { value }
  })

  return { entries, errors }
}
