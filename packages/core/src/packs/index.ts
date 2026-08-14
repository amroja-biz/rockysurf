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

export { createPackRoutes, type PackRoutesDeps } from './routes.js'

export {
  CATEGORIES,
  DESKTOPS,
  RUN_AS,
  packFileSchema,
  packSchema,
  toolSchema,
  type PackDefinition,
  type PackFile,
  type ToolDefinition,
} from './schema.js'

export { PackValidationError, syncPacksToDb, type SyncResult } from './sync.js'

/** Where shipped packs live, relative to the repository root. */
export const PACKS_DIR_NAME = 'packs'
