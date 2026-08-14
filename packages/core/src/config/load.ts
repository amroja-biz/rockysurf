import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import {
  interpolateTree,
  interpolateTreeLeniently,
  MissingEnvVarsError,
  referencedEnvVars,
  referencedEnvVarsIn,
} from './interpolate.js'
import { configSchema, type Config } from './schema.js'

export const DEFAULT_CONFIG_FILENAME = 'rockysurf.config.yaml'
export const EXAMPLE_CONFIG_FILENAME = 'rockysurf.config.example.yaml'

/** The durable home: `~/.rockysurf/config.yaml` (rockysurf-8wgm). */
export const HOME_CONFIG_DIRNAME = '.rockysurf'
export const HOME_CONFIG_FILENAME = 'config.yaml'

/**
 * `~/.rockysurf/config.yaml` — where a config file lives when it is not beside a checkout.
 *
 * LITERALLY the home directory, and deliberately NOT `server.dataDir`. The two point at the
 * same place by default, and it is tempting to say "the config lives in the data directory" —
 * but `dataDir` is a SETTING, and the config file is what defines it. Deriving the config
 * location from it would mean reading the file to find out where the file is.
 */
export function homeConfigPath(home: string = homedir()): string {
  return join(home, HOME_CONFIG_DIRNAME, HOME_CONFIG_FILENAME)
}

/**
 * Everything that can go wrong reading a config file, rendered as ONE message a stranger can
 * act on. `message` is the whole thing — a boot path prints it and exits, nothing more.
 */
export class ConfigError extends Error {
  readonly configPath: string

  constructor(message: string, configPath: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ConfigError'
    this.configPath = configPath
  }
}

/** Everything that decides WHICH file is the config file. */
export interface ResolveConfigOptions {
  /** Process arguments to scan for `--config`. Defaults to the real ones. */
  argv?: readonly string[]
  /** Directory the default filename and any relative `--config` resolve against. */
  cwd?: string
  /**
   * The home directory `~/.rockysurf/config.yaml` is under. Defaults to the real one.
   *
   * An option rather than only `$HOME`, so an in-process test can point the third tier at a
   * scratch directory without mutating the environment of every other test in the worker — and
   * without any chance of reading the operator's real config file.
   */
  home?: string
  /**
   * An explicit config path from a caller rather than from `argv` — the programmatic spelling
   * of `--config`, and treated identically: it wins, and a missing file at it is fatal.
   *
   * It exists because `boot({ configPath })` was being passed by two call sites and silently
   * dropped (rockysurf-nb6e): `BootOptions` spread it into `LoadConfigOptions`, which had no
   * such field, and excess-property checking does not see through a spread. The flag appeared
   * to work only because resolution then fell back to `process.argv`, which for the real binary
   * happens to be the same arguments. In-process — a test, an embedder — it was ignored, and
   * resolution against the real `cwd`/home could reach the operator's live config file.
   */
  configPath?: string
}

export interface LoadConfigOptions extends ResolveConfigOptions {
  /** Environment used for `${VAR}` interpolation. */
  env?: NodeJS.ProcessEnv
  /**
   * Where a note to the operator goes — currently only "there is no config file, so these are
   * the defaults" (rockysurf-cf51).
   *
   * Silent by default, so a library caller and every test that loads a config get no output.
   * `loadConfigOrExit`, which is the boot path, defaults it to stderr.
   */
  notice?: (message: string) => void
}

/** How the config file was found — the tier of the search that matched. */
export type ConfigOrigin =
  /** `--config`, or the programmatic `configPath`. */
  | 'flag'
  /** `./rockysurf.config.yaml` in the working directory. */
  | 'cwd'
  /** `~/.rockysurf/config.yaml`. */
  | 'home'
  /** Nothing anywhere: `path` is where a file WOULD go, and defaults are in force. */
  | 'none'

/** Where the config file was looked for, and whether the operator was the one who said so. */
export interface ConfigSource {
  /**
   * Always absolute: every message quotes it, and a relative path in a message is a puzzle.
   *
   * When `origin` is `none` this is the path a file would be CREATED at — the home file, never
   * a cwd file, because `npx rockysurf` must not leave one behind in a directory somebody
   * happened to run it from (rockysurf-cf51) where it would then quietly become the config for
   * whoever `cd`s there next.
   */
  path: string
  /** True when `--config` named it. An absent file is then a typo rather than an absence. */
  explicit: boolean
  origin: ConfigOrigin
  /** The candidates examined, in order. Empty when a flag named the file. For messages. */
  searched: readonly string[]
}

/** `--config <path>` / `--config=<path>` from an argument list, if either is there. */
function configFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === '--config') {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('-')) {
        throw new ConfigError(`--config needs a file path, e.g. --config ./${DEFAULT_CONFIG_FILENAME}`, '')
      }
      return next
    }
    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length)
      if (value === '') {
        throw new ConfigError(`--config needs a file path, e.g. --config=./${DEFAULT_CONFIG_FILENAME}`, '')
      }
      return value
    }
  }
  return undefined
}

/**
 * WHICH FILE IS THE CONFIG FILE. First match wins (rockysurf-8wgm):
 *
 *   1. `--config <path>` (or `configPath`) — explicit, and fatal when there is nothing at it.
 *   2. `<cwd>/rockysurf.config.yaml` — keeps the checkout workflow, and per-directory
 *      multi-instance runs, working exactly as they did.
 *   3. `~/.rockysurf/config.yaml` — the durable home, beside the data, so a config survives
 *      `cd` and does not have to be re-found by whatever directory a terminal is sitting in.
 *
 * Nothing anywhere is not an error: defaults, a notice, and `path` pointing at the home file as
 * the place a first save creates.
 *
 * MIGRATION IS THE ORDER ITSELF. A cwd file still beats a home file, so every existing setup —
 * a checkout with a config beside it, a directory per instance — keeps loading exactly the file
 * it loaded before this changed, whether or not a home file also exists.
 *
 * The `explicit` flag is what lets a missing file mean two different things: nothing found by a
 * search is a first run, and nothing at a path someone typed is a typo.
 */
export function resolveConfigSource(options: ResolveConfigOptions = {}): ConfigSource {
  const cwd = options.cwd ?? process.cwd()
  const named = options.configPath ?? configFlag(options.argv ?? process.argv.slice(2))
  if (named !== undefined) {
    return {
      path: isAbsolute(named) ? named : resolve(cwd, named),
      explicit: true,
      origin: 'flag',
      searched: [],
    }
  }

  const inCwd = resolve(cwd, DEFAULT_CONFIG_FILENAME)
  const inHome = homeConfigPath(options.home ?? homedir())
  const searched = [inCwd, inHome]

  if (existsSync(inCwd)) return { path: inCwd, explicit: false, origin: 'cwd', searched }
  if (existsSync(inHome)) return { path: inHome, explicit: false, origin: 'home', searched }
  return { path: inHome, explicit: false, origin: 'none', searched }
}

/** The path only. */
export function resolveConfigPath(options: ResolveConfigOptions = {}): string {
  return resolveConfigSource(options).path
}

/**
 * A dotted path for an issue.
 *
 * `unrecognized_keys` is the case worth special-casing: zod reports it against the CONTAINING
 * object, with the offending names in `issue.keys` and an empty `path` at the top level. Left
 * alone, a stray top-level key would render with no path at all — precisely the field the
 * reader needs. So the keys get appended.
 */
function issuePath(issue: z.core.$ZodIssue): string {
  const segments = issue.path.map(String)
  if (issue.code === 'unrecognized_keys') {
    const keys = issue.keys
    const base = segments.join('.')
    return keys.map((k) => (base ? `${base}.${k}` : k)).join(', ')
  }
  return segments.join('.') || '(root)'
}

/** Zod issues as one readable block, each line naming the field it is about. */
export function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues.map((issue) => `  ${issuePath(issue)}: ${issue.message}`).join('\n')
}

/** A setting that cannot be read because the variable it names is not in this environment. */
interface UnsetReference {
  variable: string
  /** The dotted path the reference is written at, when the caller knows it. */
  path?: string
}

/**
 * "This file names variables you have not set", said the same way wherever it is fatal.
 *
 * One message rather than two, because the two callers are the same sentence at different
 * scopes: boot needs EVERY variable the file names, and `loadConfigLeniently` needs only the
 * ones its command is about to read (rockysurf-dd9q). Which variables are listed differs; what
 * the operator has to do about them does not.
 */
function missingEnvVarsError(
  configPath: string,
  references: readonly UnsetReference[],
  cause?: unknown,
): ConfigError {
  return new ConfigError(
    [
      `${configPath} references environment variables that are not set:`,
      '',
      ...references.map(({ variable, path }) => `  \${${variable}}${path ? `  (${path})` : ''}`),
      '',
      'Set them in your shell or in a .env file, then start again. See .env.example.',
    ].join('\n'),
    configPath,
    { cause },
  )
}

function validationError(error: z.ZodError, configPath: string): ConfigError {
  return invalidConfigError(
    error.issues.map((issue) => ({ path: issuePath(issue), message: issue.message })),
    configPath,
    error,
  )
}

/** The same refusal from a list of issues, for a caller that has already filtered them. */
function invalidConfigError(
  issues: readonly ConfigIssue[],
  configPath: string,
  cause?: unknown,
): ConfigError {
  return new ConfigError(
    [
      `${configPath} is not valid:`,
      '',
      issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n'),
      '',
      `See ${EXAMPLE_CONFIG_FILENAME} in the repository root for a complete working file.`,
    ].join('\n'),
    configPath,
    { cause },
  )
}

/**
 * Interpolate, parse and validate config text that is already in hand.
 *
 * Split out from `loadConfig` so tests can drive every branch without touching the filesystem,
 * and so a future `--config -` (read stdin) has somewhere to land.
 */
export function parseConfig(
  text: string,
  configPath: string = `<${DEFAULT_CONFIG_FILENAME}>`,
  env: NodeJS.ProcessEnv = process.env,
): Config {
  // ORDER: YAML first, then interpolation, then validation. Interpolating the raw text would
  // also substitute inside comments, so documenting `${VAR}` in a comment — or commenting out
  // an optional setting — would demand that the variable be set. See interpolate.ts.
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new ConfigError(`${configPath} is not valid YAML:\n\n  ${detail}`, configPath, { cause })
  }

  let interpolated: unknown
  try {
    interpolated = interpolateTree(raw, env)
  } catch (cause) {
    if (cause instanceof MissingEnvVarsError) {
      throw missingEnvVarsError(
        configPath,
        cause.vars.map((variable) => ({ variable })),
        cause,
      )
    }
    throw cause
  }

  // An empty file parses to null, which should mean "all defaults", not a type error.
  const input = interpolated === null || interpolated === undefined ? {} : interpolated

  const result = configSchema.safeParse(input)
  if (!result.success) throw validationError(result.error, configPath)
  return result.data
}

/** One thing wrong with a config file, addressed to the field it is about. */
export interface ConfigIssue {
  /** Dotted path, as `formatIssues` renders it. `(file)` when the file is not YAML at all. */
  path: string
  message: string
}

/**
 * A file that is well-formed but will not BOOT in this process's environment (rockysurf-1z5q).
 *
 * The distinction a warning draws is between a file that is wrong and a file that is merely
 * ahead of its environment. `${ACME_PAT}` in a token field is not a mistake — it is the
 * exact thing the settings page asks the operator to type — but the process it was typed into
 * cannot see that variable, so the next start would refuse. Saying so, and saving anyway, is
 * the honest version of refusing: the operator gets the reference recorded AND the sentence
 * telling them what has to happen before a restart.
 */
export interface ConfigWarning extends ConfigIssue {
  /** The variable's name with no `${}` around it, so a caller can put it in a sentence. */
  variable: string
}

/**
 * The result of checking a config file.
 *
 * `ok` is about STRUCTURE only — YAML, the schema, the refinements. Warnings ride on both arms
 * because they are orthogonal to it: a file can be structurally perfect and still name a
 * variable nobody exported, and a file can be structurally broken while also naming one.
 *
 * `config` is absent exactly when there is a warning, and that absence is deliberate rather
 * than an oversight. With a variable unset, the values are NOT KNOWABLE — the tree still holds
 * `${ACME_PAT}` where a token belongs — and handing that back as a `Config` would be
 * offering a caller something that looks bootable and is not.
 */
export type ConfigCheck =
  | { ok: true; config?: Config; warnings: readonly ConfigWarning[] }
  | { ok: false; issues: readonly ConfigIssue[]; warnings: readonly ConfigWarning[] }

/** Every dotted path at which `${NAME}` is referenced, so a missing variable lands on a field. */
function pathsReferencing(value: unknown, name: string, prefix: string[] = []): string[] {
  if (typeof value === 'string') {
    return referencedEnvVars(value).includes(name) ? [prefix.join('.') || '(root)'] : []
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => pathsReferencing(item, name, [...prefix, String(i)]))
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => pathsReferencing(item, name, [...prefix, key]))
  }
  return []
}

/**
 * THE FILE AS THE NEXT RESTART WOULD READ IT, with unset `${VAR}` references left as their own
 * text (rockysurf-18lq).
 *
 * Same YAML parse, same interpolation, same `configSchema` as everything else here — the third
 * caller of that sequence and deliberately not a fourth definition of a valid config file. What
 * it does differently is what it does with the result: it hands back the tree even when a
 * variable is missing, because its caller is asking a question boot never asks.
 *
 * THE CALLER IS THE CREATE SCREEN'S LIVE TOKEN DISPLAY. Core resolves a typed repository URL
 * against the tokens THIS PROCESS booted with, because those are the ones a box created now
 * receives. When none of them matches, the next question is whether the operator has already
 * fixed that in the file and simply not restarted — which is the ordinary state of affairs
 * immediately after using the settings page, and the one that made "no matching token — add one
 * in Settings" a lie to the person who just did. Answering it needs the file's table, and an
 * entry saved but not yet exported (`rockysurf-1z5q`) is precisely the case worth naming, so an
 * unset variable cannot be a reason to hand back nothing.
 *
 * A `pat` that survives as `${ACME_PAT}` is therefore a REFERENCE, not a credential, and
 * the caller may name it. It must not, of course, hand back the ones that did interpolate: this
 * function returns a real `Config` and every value in it is treated as key material by everything
 * downstream. `undefined` means the file is not a config file at all — bad YAML, or a shape the
 * schema refuses for a reason no variable would fix.
 */
export function parseConfigLeniently(text: string, env: NodeJS.ProcessEnv = process.env): Config | undefined {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch {
    return undefined
  }
  const { value: interpolated } = interpolateTreeLeniently(raw, env)
  const result = configSchema.safeParse(interpolated === null || interpolated === undefined ? {} : interpolated)
  return result.success ? result.data : undefined
}

/** What a field says when the variable it names is not in this process's environment. */
export function unsetVarMessage(variable: string): string {
  return (
    `\${${variable}} is not set in the environment Rocky Surf was started from. The reference is ` +
    'saved either way; export the variable before the next restart, or that start will refuse.'
  )
}

/** True when an issue is about a field that is waiting on a variable this environment lacks. */
function waitingOnAVariable(path: string, warnings: readonly ConfigWarning[]): boolean {
  return warnings.some((w) => path === w.path || path.startsWith(`${w.path}.`))
}

/**
 * The same read `parseConfig` does, reported as a LIST rather than as one printable block.
 *
 * `parseConfig` exists for the boot path, where the only reader is a human looking at stderr
 * and one paragraph is the right shape. The settings API needs the other shape: an issue per
 * field, so the editor can put each message next to the control that caused it. Both go through
 * the same YAML parse, the same interpolation and the same `configSchema`, so there is exactly
 * one definition of a valid config file and no second validator to drift from it.
 *
 * ONE THING IS DELIBERATELY NOT THE SAME (rockysurf-1z5q). Boot treats an unset `${VAR}` as
 * fatal; here it is a WARNING and the check still passes, because the two are asked at
 * different moments. Boot is asking "can this file run?", to which an unset variable is
 * genuinely no. A save is asking "may this file be written?", and the settings page's own
 * workflow is to type a variable NAME and export the variable afterwards (rockysurf-4o3o) — so
 * an unset variable at save time is the ordinary case, and refusing it made the page unable to
 * record what it had just asked for. Everything else still refuses: bad YAML, a bad variable
 * NAME, a duplicate scope, a value the schema will not have.
 */
export function checkConfigText(text: string, env: NodeJS.ProcessEnv = process.env): ConfigCheck {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return { ok: false, issues: [{ path: '(file)', message: `not valid YAML: ${detail}` }], warnings: [] }
  }

  const { value: interpolated, unset } = interpolateTreeLeniently(raw, env)
  const warnings: ConfigWarning[] = unset.flatMap((variable) => {
    const message = unsetVarMessage(variable)
    const paths = pathsReferencing(raw, variable)
    return (paths.length > 0 ? paths : ['(file)']).map((path) => ({ path, message, variable }))
  })

  const result = configSchema.safeParse(interpolated === null || interpolated === undefined ? {} : interpolated)
  // No warning means the tree really is what this process would boot on, so the parsed config
  // is worth handing back. With one, it is not — see `ConfigCheck`.
  if (result.success) return warnings.length > 0 ? { ok: true, warnings } : { ok: true, config: result.data, warnings }

  /**
   * A FIELD WAITING ON A VARIABLE IS NOT ALSO JUDGED BY THE SCHEMA. `port: ${PORT}` with `PORT`
   * unset is a string where a number belongs — but only because the substitution had nothing to
   * put there, and reporting "expected number" would send the operator to fix a field whose
   * only problem is the warning already sitting on it. Every other issue survives, so a
   * duplicate scope or a bad `owner` in the same entry is still a refusal.
   */
  const issues = result.error.issues
    .map((issue) => ({ path: issuePath(issue), message: issue.message }))
    .filter((issue) => !waitingOnAVariable(issue.path, warnings))

  return issues.length > 0 ? { ok: false, issues, warnings } : { ok: true, warnings }
}

/**
 * What an operator sees when a search found no config file anywhere.
 *
 * Exported so a test can assert the exact text rather than a substring of it: this is the first
 * sentence a stranger reads from `npx rockysurf`, and it has to answer "did something go wrong?"
 * with "no" while still saying where to put a file — now both places, since there are two, and
 * which of them a save from the settings page would create.
 */
export function defaultsNotice(searched: readonly string[]): string {
  return [
    'no config file — starting with defaults. Looked for:',
    ...searched.map((path) => `  ${path}`),
    '',
    `Write either one (see ${EXAMPLE_CONFIG_FILENAME}) to change anything, or point somewhere`,
    'else with --config <path>. Saving from the settings page creates the second.',
  ].join('\n')
}

/**
 * The one line that says which file this process is running on.
 *
 * With three places a config file can come from, "it loaded my settings" stops being something
 * an operator can assume from the fact that it started. One line, on every start, naming the
 * file — so the answer to "is it reading the file I just edited?" is on the screen rather than
 * in a search order somebody has to remember.
 */
export function loadedNotice(configPath: string): string {
  return `config: ${configPath}`
}

/**
 * Read, interpolate, parse and validate the config file.
 *
 * Throws `ConfigError` — with a message meant to be printed verbatim — for every failure a
 * user can cause: bad YAML, a missing `${VAR}`, a schema violation, or a `--config` path with
 * nothing at it.
 *
 * NOT for a missing file at the DEFAULT location (rockysurf-cf51). That used to be fatal, which
 * made `npx rockysurf` exit 1 on the first run it was written for: it contradicted the CLI's own
 * "default: ./rockysurf.config.yaml, if present", it put the fake provider — the thing that lets
 * someone try this with no cloud account — behind copying an example file out of a repository
 * they were never asked to clone, and the container had to seed a file to get past it
 * (docker/entrypoint.sh). Every section defaults, so an absent file means the same thing an
 * empty one already meant. A `--config` path with nothing at it stays fatal: that is a typo, and
 * booting on defaults after someone named a file is how a server comes up with the wrong
 * settings and nobody notices.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  return loadConfigWithSource(options).config
}

/** A config, and the file it came from. */
export interface LoadedConfig {
  config: Config
  source: ConfigSource
}

/**
 * `loadConfig`, reporting WHICH file it read.
 *
 * `boot()` needs both — the settings editor must write the file this process is running on, and
 * on a fresh install that is the home file the search would create rather than the cwd file it
 * looked at first. One resolution, one answer, rather than resolving a second time somewhere
 * else and hoping the two agree.
 */
export function loadConfigWithSource(options: LoadConfigOptions = {}): LoadedConfig {
  const { text, source } = readConfigFile(options)
  return { config: parseConfig(text, source.path, options.env ?? process.env), source }
}

/**
 * Resolve the file, read it, and say the operator's half of it — everything up to the parse.
 *
 * Shared by `loadConfigWithSource` and `loadConfigLeniently`, which differ ONLY in how strictly
 * they read the text. Which file wins, what an absent file means, and which notice is printed
 * are the same question for both, and a second copy of that answer is a second thing to drift.
 */
function readConfigFile(options: LoadConfigOptions): { text: string; source: ConfigSource } {
  const source = resolveConfigSource(options)
  const configPath = source.path

  let text: string
  let read = true
  try {
    text = readFileSync(configPath, 'utf8')
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    if (code === 'ENOENT' && !source.explicit) {
      read = false
      options.notice?.(defaultsNotice(source.searched))
      // '' parses to null, which parseConfig already reads as "all defaults" — the same path an
      // empty file takes, rather than a second construction of a default Config to drift from it.
      text = ''
    } else if (code === 'ENOENT') {
      throw new ConfigError(
        [
          `no config file at ${configPath}`,
          '',
          `--config named that file, and there is nothing there. Check the path, or omit`,
          `--config to start with defaults and no config file at all.`,
        ].join('\n'),
        configPath,
        { cause },
      )
    } else {
      const detail = cause instanceof Error ? cause.message : String(cause)
      throw new ConfigError(`cannot read ${configPath}: ${detail}`, configPath, { cause })
    }
  }

  // A file was really read: say which one, once, before anything else is printed.
  if (read) options.notice?.(loadedNotice(configPath))

  return { text, source }
}

/**
 * What a command promises to read, keyed by the dotted path each value is written at.
 *
 * The VALUES are what is checked, and the paths are only for the message — so a field renamed
 * without renaming its key here produces a slightly stale sentence, never a check that silently
 * stops checking. A dotted string used to LOOK the value up would have the opposite failure.
 */
export type RequiredSettings = (config: Config) => Record<string, unknown>

export interface LenientLoadConfigOptions extends LoadConfigOptions {
  /** The settings this command actually reads. Everything else may still name an unset variable. */
  requires: RequiredSettings
}

/**
 * The config file, read by a command that consumes PART of it (rockysurf-dd9q).
 *
 * AN UNSET VARIABLE IS FATAL ONLY WHERE IT IS READ. `loadConfig` demands every `${VAR}` the
 * file names, which is right for `boot()`: the control plane goes on to use all of it, and a
 * provider credential silently interpolated to `''` is worse than a refusal. It is wrong for
 * `rockysurf token` and `rockysurf mcp`, which read one table and one config value
 * respectively — and, crucially, run in somebody ELSE'S environment. An MCP client launches
 * `rockysurf mcp` from a `.mcp.json` with only the variables that file sets, so an installation
 * whose config references `${ACME_PAT}` for a repository token could not start its MCP server
 * at all without copying every unrelated secret into the client's environment: the precise
 * opposite of handing an agent the narrowest thing that works.
 *
 * So: interpolate leniently (the seam built for rockysurf-1z5q), then demand `requires` and
 * nothing else. A reference the command never reads is left as its own text in the returned
 * `Config` — which is why `requires` is not optional. A caller that reads a field it did not
 * name gets `${ACME_PAT}` where a token belongs, and this returns a real `Config` that no type
 * can distinguish from a booted one.
 *
 * ONE RESIDUAL, stated rather than shaded: a reference in a field the SCHEMA must coerce —
 * `port: ${PORT}`, `mcp.scopes: ${SCOPES}` — is fatal here even when the command does not read
 * it, because `${PORT}` left as written is not a number and there is no `Config` to hand back.
 * The message names the variable and the field rather than reporting "expected number", which
 * would send the operator to fix a field whose only problem is the variable. In practice the
 * references operators write are secrets, and every one of those is a string.
 */
export function loadConfigLeniently(options: LenientLoadConfigOptions): LoadedConfig {
  const { text, source } = readConfigFile(options)
  return {
    config: parseConfigLenientlyRequiring(text, options.requires, source.path, options.env ?? process.env),
    source,
  }
}

/** `loadConfigLeniently`, printing the message and exiting rather than throwing — see `loadConfigOrExit`. */
export function loadConfigLenientlyOrExit(options: LenientLoadConfigOptions): Config {
  try {
    return loadConfigLeniently({
      ...options,
      notice: options.notice ?? ((message) => console.error(message)),
    }).config
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  }
}

/**
 * `parseConfig`, demanding only the variables `requires` names. The text half of
 * `loadConfigLeniently`, split out for the same reason `parseConfig` is: every branch is
 * reachable without a filesystem.
 */
export function parseConfigLenientlyRequiring(
  text: string,
  requires: RequiredSettings,
  configPath: string = `<${DEFAULT_CONFIG_FILENAME}>`,
  env: NodeJS.ProcessEnv = process.env,
): Config {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new ConfigError(`${configPath} is not valid YAML:\n\n  ${detail}`, configPath, { cause })
  }

  const { value: interpolated, unset } = interpolateTreeLeniently(raw, env)
  const result = configSchema.safeParse(interpolated === null || interpolated === undefined ? {} : interpolated)

  if (!result.success) {
    // Two kinds of issue are mixed together here and only one is the file's fault. `port:
    // ${PORT}` is a string where a number belongs solely because the substitution had nothing to
    // put there — the distinction `checkConfigText` already draws, drawn again because this path
    // must not answer "expected number" for a field whose only problem is a variable.
    const waiting = unset.flatMap((variable) =>
      pathsReferencing(raw, variable).map((path) => ({ variable, path })),
    )
    const structural: ConfigIssue[] = []
    const references: UnsetReference[] = []
    for (const issue of result.error.issues) {
      const at = issuePath(issue)
      const blamed = waiting.filter((w) => at === w.path || at.startsWith(`${w.path}.`))
      if (blamed.length === 0) structural.push({ path: at, message: issue.message })
      else references.push(...blamed)
    }
    if (structural.length > 0) throw invalidConfigError(structural, configPath, result.error)
    throw missingEnvVarsError(configPath, references)
  }

  const missing = Object.entries(requires(result.data)).flatMap(([path, value]) =>
    // Intersected with `unset` rather than trusted on its own: `$${LITERAL}` is an escape that
    // yields the text `${LITERAL}`, which a scan cannot tell from a reference nobody resolved.
    referencedEnvVarsIn(value)
      .filter((variable) => unset.includes(variable))
      .map((variable) => ({ variable, path })),
  )
  if (missing.length > 0) throw missingEnvVarsError(configPath, missing)

  return result.data
}

/**
 * Boot-path wrapper: load, or print the message and exit non-zero.
 *
 * A bad config is a user error, not a crash, so it gets a plain message on stderr rather than
 * a stack trace. Anything that is NOT a `ConfigError` is a real bug and is rethrown.
 *
 * This is also where the no-config-file notice is printed, for the same reason: it is the
 * wrapper that exists to talk to the operator. `loadConfig` itself stays silent.
 */
export function loadConfigOrExit(options: LoadConfigOptions = {}): Config {
  return loadConfigOrExitWithSource(options).config
}

/** `loadConfigOrExit`, reporting which file it read — what `boot()` uses. */
export function loadConfigOrExitWithSource(options: LoadConfigOptions = {}): LoadedConfig {
  try {
    return loadConfigWithSource({
      ...options,
      notice: options.notice ?? ((message) => console.error(message)),
    })
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  }
}
