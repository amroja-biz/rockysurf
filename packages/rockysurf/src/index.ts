/**
 * `rockysurf` — the composition root and the published package.
 *
 * Two jobs, both small:
 *
 *  1. **Wire the providers into the control plane.** Core cannot import a provider package
 *     (the dependency lint forbids it), so somebody allowed to import both has to build the
 *     registry. That is this package, and only this package (rockysurf-55fx.12).
 *  2. **Be the thing people install.** `@rockysurf/core` stays `private: true` — it is an
 *     implementation package with a database, a web build and a bootstrap agent inside it —
 *     while this one carries the npm name and the `rockysurf` binary.
 */
export { composeRegistry, type ComposeResult } from './compose.js'
export { runRockysurfCli } from './cli.js'
/**
 * Personal providers (ADR-0026): how a `providers.<id>.package` becomes a factory. Exported for an
 * embedder building its own boot sequence — load once, then compose synchronously from the result.
 */
export {
  PERSONAL_PROVIDERS_DIRNAME,
  PERSONAL_PROVIDER_TRUST_SENTENCE,
  loadPersonalProviders,
  noPersonalProviders,
  personalProvidersDir,
  type LoadedPersonalProviders,
  type LoadPersonalProvidersOptions,
} from './personal-providers.js'
