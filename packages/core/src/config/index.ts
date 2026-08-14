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
  HOME_CONFIG_DIRNAME,
  HOME_CONFIG_FILENAME,
  checkConfigText,
  defaultsNotice,
  formatIssues,
  homeConfigPath,
  loadConfig,
  loadConfigLeniently,
  loadConfigLenientlyOrExit,
  loadConfigOrExit,
  loadConfigOrExitWithSource,
  loadConfigWithSource,
  loadedNotice,
  parseConfig,
  parseConfigLeniently,
  parseConfigLenientlyRequiring,
  resolveConfigPath,
  resolveConfigSource,
  unsetVarMessage,
  type ConfigCheck,
  type ConfigIssue,
  type ConfigOrigin,
  type ConfigWarning,
  type ConfigSource,
  type LenientLoadConfigOptions,
  type LoadConfigOptions,
  type LoadedConfig,
  type RequiredSettings,
  type ResolveConfigOptions,
} from './load.js'

export {
  interpolateEnv,
  interpolateTree,
  interpolateTreeLeniently,
  MissingEnvVarsError,
  type LenientInterpolation,
  referencedEnvVars,
  referencedEnvVarsIn,
} from './interpolate.js'

export {
  DEFAULT_REGISTRY_URL,
  REGISTRY_TRUST,
  configSchema,
  expandTilde,
  type ByoHost,
  type Config,
  type LimitsConfig,
  type McpConfig,
  type McpScope,
  type ProvidersConfig,
  type RegistryConfig,
  type RegistrySource,
  type RegistryTrust,
  type ServerConfig,
} from './schema.js'
