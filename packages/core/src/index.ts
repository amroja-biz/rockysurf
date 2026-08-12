/**
 * `@rockysurf/core` — the portable control plane.
 *
 * DEPENDENCY RULE, enforced by `scripts/check-core-deps.mjs` in CI: core may import
 * `@rockysurf/provider-sdk` and NOTHING else from this workspace. Never `provider-aws`,
 * `provider-hetzner`, `provider-byo`, or `web`. Two reasons, both load-bearing:
 *
 *  1. it keeps the SDK honest while it has no out-of-tree consumers — if core can reach into
 *     a concrete provider, the abstraction stops being tested by anything;
 *  2. it keeps the AWS SDK out of core's dependency tree, which is what makes an `npx`
 *     cold start fast.
 *
 * Providers therefore arrive already constructed, through `BootOptions.providers`. The one
 * package allowed to import both sides and fill that seam is `rockysurf` — the composition
 * root (rockysurf-55fx.12). This barrel is the surface it composes against, so everything
 * exported here is deliberately part of that contract.
 */

/** Package identity, so the scaffold has something real to assert on. */
export const CORE_PACKAGE_NAME = '@rockysurf/core'

/* ------------------------------------------------------------------ boot and the CLI */

export {
  boot,
  main,
  type BootedApp,
  type BootOptions,
  type ProviderCompositionContext,
} from './server.js'

export { runCli, type CliIo, type RunCliOptions } from './cli.js'

/** Session issuance, for the composition package's `rockysurf token` (rockysurf-ftl9.1). */
export { issueSession, revokeSession, type IssuedSession } from './auth/sessions.js'

/* ------------------------------------------------------------------------- providers */

export { ProviderRegistry, createDefaultRegistry } from './providers/registry.js'
export { makeFakeProvider, type FakeProvider, type FakeProviderOptions } from './providers/fake.js'

/* ---------------------------------------------------------------------- configuration */

export {
  configSchema,
  loadConfig,
  loadConfigOrExit,
  ConfigError,
  type Config,
  type LimitsConfig,
  type McpConfig,
  type McpScope,
  type ProvidersConfig,
  type ServerConfig,
} from './config/index.js'

/* --------------------------------------------------------------------------- secrets */

export {
  createSecretsStore,
  loadMasterKey,
  type SecretsStore,
  type SecretKind,
  type SecretRef,
} from './secrets/index.js'

/* ---------------------------------------------------------------------- the app itself */

export { createApp, type AppDeps, type AppEnv, type CreatedApp } from './app.js'
