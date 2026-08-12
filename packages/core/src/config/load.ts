import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { interpolateTree, MissingEnvVarsError } from './interpolate.js'
import { configSchema, type Config } from './schema.js'

export const DEFAULT_CONFIG_FILENAME = 'rockysurf.config.yaml'
export const EXAMPLE_CONFIG_FILENAME = 'rockysurf.config.example.yaml'

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

export interface LoadConfigOptions {
  /** Process arguments to scan for `--config`. Defaults to the real ones. */
  argv?: readonly string[]
  /** Environment used for `${VAR}` interpolation. */
  env?: NodeJS.ProcessEnv
  /** Directory the default filename and any relative `--config` resolve against. */
  cwd?: string
  /**
   * Where a note to the operator goes — currently only "there is no config file, so these are
   * the defaults" (rockysurf-cf51).
   *
   * Silent by default, so a library caller and every test that loads a config get no output.
   * `loadConfigOrExit`, which is the boot path, defaults it to stderr.
   */
  notice?: (message: string) => void
}

/** Where the config file was looked for, and whether the operator was the one who said so. */
export interface ConfigSource {
  /** Always absolute: every message quotes it, and a relative path in a message is a puzzle. */
  path: string
  /** True when `--config` named it. An absent file is then a typo rather than an absence. */
  explicit: boolean
}

/**
 * `--config <path>` or `--config=<path>`, else `<cwd>/rockysurf.config.yaml`.
 *
 * The `explicit` flag is what lets a missing file mean two different things: nothing to read at
 * the default location is a first run, and nothing to read at a path someone typed is a typo.
 */
export function resolveConfigSource(
  argv: readonly string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): ConfigSource {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === '--config') {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('-')) {
        throw new ConfigError(
          `--config needs a file path, e.g. --config ./${DEFAULT_CONFIG_FILENAME}`,
          '',
        )
      }
      return { path: isAbsolute(next) ? next : resolve(cwd, next), explicit: true }
    }
    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length)
      if (value === '') {
        throw new ConfigError(
          `--config needs a file path, e.g. --config=./${DEFAULT_CONFIG_FILENAME}`,
          '',
        )
      }
      return { path: isAbsolute(value) ? value : resolve(cwd, value), explicit: true }
    }
  }
  return { path: resolve(cwd, DEFAULT_CONFIG_FILENAME), explicit: false }
}

/** The path only. */
export function resolveConfigPath(
  argv: readonly string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): string {
  return resolveConfigSource(argv, cwd).path
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

function validationError(error: z.ZodError, configPath: string): ConfigError {
  return new ConfigError(
    [
      `${configPath} is not valid:`,
      '',
      formatIssues(error.issues),
      '',
      `See ${EXAMPLE_CONFIG_FILENAME} in the repository root for a complete working file.`,
    ].join('\n'),
    configPath,
    { cause: error },
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
      throw new ConfigError(
        [
          `${configPath} references environment variables that are not set:`,
          '',
          ...cause.vars.map((v) => `  \${${v}}`),
          '',
          'Set them in your shell or in a .env file, then start again. See .env.example.',
        ].join('\n'),
        configPath,
        { cause },
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

/**
 * What an operator sees when there is no config file to read at the default location.
 *
 * Exported so a test can assert the exact text rather than a substring of it: this is the first
 * sentence a stranger reads from `npx rockysurf`, and it has to answer "did something go wrong?"
 * with "no" while still saying where to put a file.
 */
export function defaultsNotice(configPath: string): string {
  return [
    `no ${DEFAULT_CONFIG_FILENAME} here — starting with defaults.`,
    '',
    `Write ${configPath} (see ${EXAMPLE_CONFIG_FILENAME}) to change anything, or point`,
    'somewhere else with --config <path>.',
  ].join('\n')
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
  const cwd = options.cwd ?? process.cwd()
  const source = resolveConfigSource(options.argv ?? process.argv.slice(2), cwd)
  const configPath = source.path

  let text: string
  try {
    text = readFileSync(configPath, 'utf8')
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    if (code === 'ENOENT' && !source.explicit) {
      options.notice?.(defaultsNotice(configPath))
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

  return parseConfig(text, configPath, options.env ?? process.env)
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
  try {
    return loadConfig({ ...options, notice: options.notice ?? ((message) => console.error(message)) })
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  }
}
