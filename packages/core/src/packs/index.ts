/**
 * Packs: the frozen file format, the loader that reads `packs/*.yaml`, and the reconcile
 * that keeps the database in step with them.
 *
 * The authoring contract those files must satisfy is `docs/writing-a-pack.md`.
 */

export {
  loadPacksFromDir,
  parsePackFile,
  renderPackFile,
  type LoadResult,
  type LoadedPack,
  type LoadedTool,
  type PackIssue,
} from './loader.js'

export { BUNDLED_PACKS_DIR, bundledPacksDir } from './bundled.js'

export {
  formatFindings,
  isClean,
  lintLoaded,
  lintPacksDir,
  type LintFinding,
  type LintOptions,
  type LintReport,
  type LintRule,
} from './lint.js'

export {
  REGISTRY_INDEX_VERSION,
  RegistryIndexError,
  buildRegistryIndex,
  registryEntrySchema,
  registryIndexSchema,
  renderRegistryIndex,
  sha256File,
  sha256Text,
  type BuildIndexOptions,
  type IndexSourceDir,
  type RegistryEntry,
  type RegistryIndex,
} from './registry-index.js'

export {
  createRegistryClient,
  type FetchedPack,
  type RegistryClient,
  type RegistryClientDeps,
  type RegistryFailure,
  type RegistryListing,
  type RegistryPackResult,
  type ShelfResult,
} from './registry.js'

export {
  describePack,
  urlsIn,
  type DisclosureInput,
  type PackDisclosure,
  type ToolDisclosure,
} from './disclosure.js'

export { createPackRoutes, type PackRoutesDeps } from './routes.js'

export {
  CATEGORIES,
  DESKTOPS,
  PACK_INPUT_MAX_COUNT,
  PACK_INPUT_MAX_VALUE_BYTES,
  RUN_AS,
  packFileSchema,
  packInputSchema,
  packInputValueSchema,
  packInputsSchema,
  packSchema,
  toolSchema,
  type PackDefinition,
  type PackFile,
  type PackInput,
  type ToolDefinition,
} from './schema.js'

export {
  PACK_INPUTS_MAX_TOTAL_BYTES,
  resolvePackInputs,
  summarizePackInputs,
  type PackInputIssue,
  type PackInputSummary,
  type ResolvedPackInputs,
} from './inputs.js'

export { PackValidationError, syncPacksToDb, type SyncResult } from './sync.js'

/** Where shipped packs live, relative to the repository root. */
export const PACKS_DIR_NAME = 'packs'
