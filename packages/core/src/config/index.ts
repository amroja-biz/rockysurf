/**
 * Config loading for `@rockysurf/core` (rockysurf-gonw.4).
 *
 * `rockysurf.config.yaml` → `${VAR}` interpolation → YAML → zod v4 → a typed `Config`.
 * Every user-caused failure surfaces as a `ConfigError` whose `message` is meant to be
 * printed verbatim and acted on without reading any source.
 */
export {
  ConfigError,
  DEFAULT_CONFIG_FILENAME,
  EXAMPLE_CONFIG_FILENAME,
  defaultsNotice,
  formatIssues,
  loadConfig,
  loadConfigOrExit,
  parseConfig,
  resolveConfigPath,
  resolveConfigSource,
  type ConfigSource,
  type LoadConfigOptions,
} from './load.js'

export {
  interpolateEnv,
  interpolateTree,
  MissingEnvVarsError,
  referencedEnvVars,
  referencedEnvVarsIn,
} from './interpolate.js'

export {
  configSchema,
  expandTilde,
  type ByoHost,
  type Config,
  type LimitsConfig,
  type McpConfig,
  type McpScope,
  type ProvidersConfig,
  type ServerConfig,
} from './schema.js'
