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

import { fileURLToPath } from 'node:url'

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

/**
 * The single-core guarantee (rockysurf-utjq): `boot()` takes an advisory lock on the data
 * directory and throws `DataDirLockError` — message written to be printed verbatim — when
 * another live core already holds it. Exported so the composition root and embedders can
 * catch the refusal by type, and so tests can name the lock file without duplicating it.
 */
export { DataDirLockError, dataDirLockPath, LOCK_FILENAME } from './boot/data-dir-lock.js'

/** Session issuance, for the composition package's `rockysurf token` (rockysurf-ftl9.1). */
export { issueSession, revokeSession, type IssuedSession } from './auth/sessions.js'

/**
 * Opening the database WITHOUT booting core (rockysurf-o2t5).
 *
 * `rockysurf token` needs one table and one insert while a control plane is RUNNING on the
 * same data directory. It must not call `boot()` for that: boot runs the startup recovery
 * pass, which is a second core passing judgement on the first one's in-flight servers. So the
 * composition root gets the database door on its own, and opens it as a guest — see the
 * comments at that call site for what a guest is not allowed to do.
 */
export { openDatabase, defaultDatabasePath, type Db, type OpenedDatabase } from './db/client.js'

/* ------------------------------------------------------------------------- providers */

export { ProviderRegistry, createDefaultRegistry, type UnavailableProvider } from './providers/registry.js'
export { makeFakeProvider, type FakeProvider, type FakeProviderOptions } from './providers/fake.js'

/* ---------------------------------------------------------------------- configuration */

export {
  DEFAULT_REGISTRY_URL,
  REGISTRY_TRUST,
  configSchema,
  loadConfig,
  loadConfigLenientlyOrExit,
  loadConfigOrExit,
  ConfigError,
  type Config,
  type LimitsConfig,
  type McpConfig,
  type McpScope,
  type ProvidersConfig,
  type RegistryConfig,
  type RegistrySource,
  type RegistryTrust,
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

/* ------------------------------------------------------------------------------ packs */

/**
 * The pack contract, exported so the composition root can offer it as a command and the pack
 * registry (rockysurf-arym) can validate what it fetches with the same code that validates
 * `packs/`. One definition of the format, one definition of the author rules.
 */
export {
  BUNDLED_PACKS_DIR,
  PACKS_DIR_NAME,
  REGISTRY_INDEX_VERSION,
  RegistryIndexError,
  buildRegistryIndex,
  bundledPacksDir,
  createRegistryClient,
  describePack,
  formatFindings,
  isClean,
  registryEntrySchema,
  registryIndexSchema,
  renderRegistryIndex,
  sha256File,
  sha256Text,
  type BuildIndexOptions,
  type DisclosureInput,
  type FetchedPack,
  type PackDisclosure,
  type ToolDisclosure,
  type IndexSourceDir,
  type RegistryClient,
  type RegistryClientDeps,
  type RegistryFailure,
  type RegistryListing,
  type RegistryPackResult,
  type RegistryEntry,
  type RegistryIndex,
  type ShelfResult,
  lintLoaded,
  lintPacksDir,
  loadPacksFromDir,
  parsePackFile,
  renderPackFile,
  type LintFinding,
  type LintOptions,
  type LintReport,
  type LintRule,
  type LoadResult,
  type LoadedPack,
  type LoadedTool,
  type PackDefinition,
  type PackFile,
  type PackIssue,
  type ToolDefinition,
} from './packs/index.js'

/**
 * The plan resolver, exported for the same reason: `rockysurf pack check` runs a pack through
 * the plan a real create would render, not through an approximation of one. A harness that
 * builds its own plan is testing the harness.
 */
export {
  resolveInstallPlan,
  type ResolvablePack,
  type ResolveInstallPlanInput,
} from './bootstrap/resolver.js'
export type { InstallPlan, InstallStep } from './bootstrap/plan.js'
/** The resolver's tool shape. The loader speaks the file format; this is the database's. */
export type { ToolRow } from './db/schema.js'

/**
 * `packages/core/bootstrap/agent.sh` — the on-box executor, resolved from wherever the package
 * was installed. `rockysurf pack check` copies this exact file into its container, because a
 * harness running a different agent than production does is not evidence about production.
 */
export const AGENT_SCRIPT_PATH = fileURLToPath(new URL('../bootstrap/agent.sh', import.meta.url))

/* ---------------------------------------------------------------------- the app itself */

export { createApp, type AppDeps, type AppEnv, type CreatedApp } from './app.js'
