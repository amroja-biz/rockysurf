import { readFileSync } from 'node:fs'
import type { PackInput } from '@rockysurf/core'
import type { CoreClient } from './mcp/client.js'

/**
 * `rockysurf create --input NAME=VALUE` and `--inputs-file <path>` (issue #189, ADR-0013).
 *
 * The CLI's half of pack inputs, kept out of `cli/commands.ts` because it is three separable
 * jobs — parse the flags, read the pack's declaration, refuse a secret typed into `argv` — and
 * because the MCP server will want the same reading of a dotenv file when it grows the field.
 *
 * NOTHING HERE IS THE AUTHORITY. Core validates every create against the pack's declaration and
 * 400s what it does not like; this exists so the common mistakes cost a sentence rather than a
 * round trip, and so a value the user must not put on a command line is refused before a shell
 * has written it to a history file. Every check below is one core also makes.
 */

/**
 * Where a secret input is read from when nobody is at a terminal.
 *
 * `ROCKYSURF_INPUT_<NAME>` — the same doctrine as `ROCKYSURF_RDP_PASSWORD` (`rdp.ts`), and for
 * the same reason: a process's environment is readable only by its own user and root, while
 * `argv` is readable by every process on the machine through `ps` and is written to the shell's
 * history file on the way in.
 */
export const INPUT_ENV_PREFIX = 'ROCKYSURF_INPUT_'

interface PublicPack {
  packId: string
  inputs?: PackInput[]
}

/**
 * What this installation says the pack asks for.
 *
 * NEVER THROWS, and answers `undefined` when it cannot tell — the same posture as
 * `packRequiresRdp`, and the same reasoning. Core is the authority; this is a courtesy read
 * that turns a 400 into a local sentence. An unreachable pack list must not block a create,
 * including for the many packs that ask for nothing at all: the POST still goes out, and core's
 * own refusal is what the user reads.
 */
export async function fetchPackInputs(client: CoreClient, packId: string): Promise<PackInput[] | undefined> {
  try {
    const body = await client.get<PublicPack[] | { packs?: PublicPack[] }>('/api/v1/surge-packs')
    const packs = Array.isArray(body) ? body : (body.packs ?? [])
    return packs.find((p) => p.packId === packId)?.inputs
  } catch {
    return undefined
  }
}

/**
 * `NAME=VALUE`, split on the FIRST `=` only.
 *
 * The first, because a value may legitimately contain one — a base64 key ends in `=`, a query
 * string is full of them — and splitting on all of them would corrupt exactly the values people
 * pass this flag for. An empty name, or no `=` at all, is a refusal rather than a guess.
 */
export function parseInputAssignment(raw: string): { name: string; value: string } | { refusal: string } {
  const at = raw.indexOf('=')
  if (at <= 0) return { refusal: `--input ${raw} is not NAME=VALUE — write --input HEADLONG_HEADLESS=1` }
  return { name: raw.slice(0, at), value: raw.slice(at + 1) }
}

/**
 * A dotenv file: `NAME=VALUE` per line, `#` comments, blank lines ignored, and one optional
 * layer of surrounding quotes stripped.
 *
 * DELIBERATELY NOT A DOTENV LIBRARY, and deliberately not `export`-prefix-aware or
 * `$VAR`-expanding. This file's whole job is to carry values a shell must never see, so a
 * parser that interpolates would reintroduce the shell at the one point the file exists to
 * avoid. What it accepts is what people actually write, and nothing that runs.
 *
 * A multi-line value has no spelling here on purpose: the values are bound for `secrets.env`,
 * whose reader is line-oriented, and core refuses a newline in one.
 */
export function parseInputsFile(text: string): { values: Record<string, string> } | { refusal: string } {
  const values: Record<string, string> = {}
  const lines = text.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at <= 0) return { refusal: `line ${index + 1} is not NAME=VALUE: ${trimmed}` }
    const name = trimmed.slice(0, at).trim()
    let value = trimmed.slice(at + 1).trim()
    // One layer, and only when both ends match. A value that is genuinely quoted at one end is
    // far more likely to be a value containing a quote than a typo worth silently repairing.
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0]!)) {
      value = value.slice(1, -1)
    }
    values[name] = value
  }
  return { values }
}

export interface CollectInputsArgs {
  /** Repeated `--input NAME=VALUE`, in the order they were given. */
  inputs?: string[]
  /** `--inputs-file <path>`, dotenv format. */
  inputsFile?: string
}

/**
 * Everything the three sources say, merged, with the refusals a shell-history leak deserves.
 *
 * PRECEDENCE, LEAST TO MOST SPECIFIC: the environment, then the file, then the flags. A flag is
 * the most deliberate thing a caller can type on this invocation, so it wins; the environment is
 * the ambient default a CI job sets once, so it loses. It is the same shape as
 * `--provider` beating `defaultProvider`, and it means a script can export a value and still
 * override it for one run.
 *
 * THE ONE HARD REFUSAL: a value for a SECRET input given as `--input`. `rockysurf create` already
 * refuses `--rdp-password <value>` on this reasoning, and a pack's API key is the same
 * credential in a different coat — by the time a warning could print, the value is in the shell's
 * history file and has been visible in `ps` to every process on the machine. The two ways out
 * are named in the refusal, because a refusal with no way out is just an obstacle.
 *
 * The declaration is what makes this possible, so it is only enforced when core could be
 * reached: with `declared` undefined nothing is known about which names are secret and the POST
 * goes out unchecked, exactly as it did before this flag existed.
 */
export function collectPackInputs(
  args: CollectInputsArgs,
  declared: readonly PackInput[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { values: Record<string, string>; refusal?: string } {
  const values: Record<string, string> = {}

  for (const input of declared ?? []) {
    const fromEnv = env[`${INPUT_ENV_PREFIX}${input.name}`]
    if (fromEnv !== undefined && fromEnv !== '') values[input.name] = fromEnv
  }

  if (args.inputsFile) {
    let text: string
    try {
      text = readFileSync(args.inputsFile, 'utf8')
    } catch (error) {
      return { values, refusal: `--inputs-file ${args.inputsFile}: ${error instanceof Error ? error.message : String(error)}` }
    }
    const parsed = parseInputsFile(text)
    if ('refusal' in parsed) return { values, refusal: `--inputs-file ${args.inputsFile}: ${parsed.refusal}` }
    Object.assign(values, parsed.values)
  }

  const secretNames = new Set((declared ?? []).filter((i) => i.secret).map((i) => i.name))
  for (const raw of args.inputs ?? []) {
    const parsed = parseInputAssignment(raw)
    if ('refusal' in parsed) return { values, refusal: parsed.refusal }
    if (secretNames.has(parsed.name)) {
      return {
        values,
        refusal:
          `${parsed.name} is a secret this pack asks for, and a secret given on the command line is recorded ` +
          'in your shell history and is readable in `ps` by every process on this machine, so ' +
          '`rockysurf create` will not accept one that way. Supply it in a file, or in the environment:\n\n' +
          `  rockysurf create --pack <id> --inputs-file ./inputs.env\n` +
          `  ${INPUT_ENV_PREFIX}${parsed.name}=... rockysurf create --pack <id>\n\n` +
          'Rotate the value you just typed — it is already on disk.',
      }
    }
    values[parsed.name] = parsed.value
  }

  return { values }
}
