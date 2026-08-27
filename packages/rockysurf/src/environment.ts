import { readFileSync } from 'node:fs'
import type { EnvironmentEntry } from '@rockysurf/core'

/**
 * `rockysurf create --env KEY=VALUE` and `--env-file <path>` (issue #197, ADR-0014).
 *
 * The CLI's half of the per-server Environment — the values the USER hands their own box, as
 * opposed to `--input`, which answers what a PACK declared it needs (`pack-inputs.ts`).
 *
 * ONE FORMAT, TWO PLACES A PERSON TYPES IT. `--env-file` reads exactly the text the create
 * form's Environment box takes: `KEY=value` per line, `#` comments, and a `secret:` prefix on a
 * line whose value must be stored encrypted. That is the point of the prefix rather than a
 * `--secret-env` companion flag — the same file works in both surfaces, so moving an
 * environment from the browser to a script is a copy rather than a translation, and a marker
 * cannot drift from the line it marks the way a parallel flag can.
 *
 * NOTHING HERE IS THE AUTHORITY. Core validates every name and value at the create route and
 * 400s what it does not like; this exists so the common mistakes cost a sentence rather than a
 * round trip, and so a value the user must not put on a command line is refused before a shell
 * has written it to a history file. Every check below is one core also makes.
 */

/** The marker that puts a line's value in the encrypted store instead of on the server row. */
export const SECRET_LINE_PREFIX = 'secret:'

/**
 * `[secret:]NAME=VALUE`, split on the FIRST `=` only.
 *
 * The first, because a value may legitimately contain one — a base64 key ends in `=`, a query
 * string is full of them. An empty name, or no `=` at all, is a refusal rather than a guess.
 */
export function parseEnvAssignment(
  raw: string,
): { name: string; entry: EnvironmentEntry } | { refusal: string } {
  const trimmed = raw.trim()
  const secret = trimmed.startsWith(SECRET_LINE_PREFIX)
  const body = secret ? trimmed.slice(SECRET_LINE_PREFIX.length).trim() : trimmed

  const at = body.indexOf('=')
  if (at <= 0) return { refusal: `--env ${raw} is not KEY=VALUE — write --env MY_ENDPOINT=https://example.com` }
  return {
    name: body.slice(0, at).trim(),
    entry: secret ? { value: body.slice(at + 1), secret: true } : { value: body.slice(at + 1) },
  }
}

/**
 * An environment file: `KEY=VALUE` per line, `#` comments, blank lines ignored, `secret:` on the
 * lines that need it, and one optional layer of surrounding quotes stripped.
 *
 * DELIBERATELY NOT A DOTENV LIBRARY, and deliberately not `export`-prefix-aware or
 * `$VAR`-expanding. This file's whole job is to carry values a shell must never see, so a parser
 * that interpolated would reintroduce the shell at the one point the file exists to avoid.
 *
 * A duplicate name is refused rather than resolved: both lines are in a file the user is looking
 * at, and only one of them would ever reach the machine.
 */
export function parseEnvFile(text: string): { entries: Record<string, EnvironmentEntry> } | { refusal: string } {
  const entries: Record<string, EnvironmentEntry> = {}
  const lines = text.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const secret = trimmed.startsWith(SECRET_LINE_PREFIX)
    const body = secret ? trimmed.slice(SECRET_LINE_PREFIX.length).trim() : trimmed

    const at = body.indexOf('=')
    if (at <= 0) return { refusal: `line ${index + 1} is not KEY=VALUE: ${trimmed}` }
    const name = body.slice(0, at).trim()
    let value = body.slice(at + 1).trim()
    // One layer, and only when both ends match. A value genuinely quoted at one end is far more
    // likely to be a value containing a quote than a typo worth silently repairing.
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0]!)) {
      value = value.slice(1, -1)
    }
    if (Object.hasOwn(entries, name)) return { refusal: `line ${index + 1} sets ${name} again — one name, one line` }
    entries[name] = secret ? { value, secret: true } : { value }
  }
  return { entries }
}

export interface CollectEnvironmentArgs {
  /** Repeated `--env [secret:]KEY=VALUE`, in the order they were given. */
  env?: string[]
  /** `--env-file <path>`, the same format the create form's Environment box takes. */
  envFile?: string
}

/**
 * Everything the two sources say, merged, with the refusal a shell-history leak deserves.
 *
 * PRECEDENCE, LEAST TO MOST SPECIFIC: the file, then the flags. A flag is the most deliberate
 * thing a caller can type on this invocation, so it wins; the file is the ambient default a
 * script keeps beside itself. The same shape as `--input` beating `--inputs-file`.
 *
 * THE ONE HARD REFUSAL: a `secret:` value given as `--env`. `rockysurf create` already refuses
 * `--rdp-password <value>` and a secret `--input` on this reasoning — by the time a warning
 * could print, the value is in the shell's history file and has been visible in `ps` to every
 * process on the machine. The way out is named in the refusal, because a refusal with no way
 * out is just an obstacle.
 *
 * THERE IS NO `ROCKYSURF_ENV_<NAME>` COUNTERPART to `ROCKYSURF_INPUT_<NAME>`, deliberately.
 * That one works because the PACK enumerates the names it declares, so the CLI knows exactly
 * which variables to read. Nothing enumerates this field — that is its whole purpose — so the
 * equivalent would have to scan the process environment for a prefix and guess, which is a
 * different mechanism wearing the same name. `--env-file` is the path for a value that must not
 * touch `argv`.
 */
export function collectEnvironment(args: CollectEnvironmentArgs): {
  entries: Record<string, EnvironmentEntry>
  refusal?: string
} {
  const entries: Record<string, EnvironmentEntry> = {}

  if (args.envFile) {
    let text: string
    try {
      text = readFileSync(args.envFile, 'utf8')
    } catch (error) {
      return { entries, refusal: `--env-file ${args.envFile}: ${error instanceof Error ? error.message : String(error)}` }
    }
    const parsed = parseEnvFile(text)
    if ('refusal' in parsed) return { entries, refusal: `--env-file ${args.envFile}: ${parsed.refusal}` }
    Object.assign(entries, parsed.entries)
  }

  for (const raw of args.env ?? []) {
    const parsed = parseEnvAssignment(raw)
    if ('refusal' in parsed) return { entries, refusal: parsed.refusal }
    if (parsed.entry.secret) {
      return {
        entries,
        refusal:
          `${parsed.name} is marked secret, and a secret given on the command line is recorded in your shell ` +
          'history and is readable in `ps` by every process on this machine, so `rockysurf create` will not ' +
          'accept one that way. Put it in a file instead:\n\n' +
          `  printf '${SECRET_LINE_PREFIX}%s=%s\\n' ${parsed.name} '<value>' > ./env.txt\n` +
          '  rockysurf create --pack <id> --env-file ./env.txt\n\n' +
          'Rotate the value you just typed — it is already on disk.',
      }
    }
    entries[parsed.name] = parsed.entry
  }

  return { entries }
}
