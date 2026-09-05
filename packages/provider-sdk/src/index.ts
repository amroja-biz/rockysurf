/**
 * `@rockysurf/provider-sdk` — the frozen v0 contract every Rocky Surf compute provider
 * implements.
 *
 * Types and a handful of pure helpers. ZERO runtime dependencies, by acceptance criterion:
 * anything this package depends on is inherited by every provider and every consumer. That is
 * the promise, and it is not "no code": `errors.ts`, `instance.ts`, `provision.ts`, `ssh-cidr.ts`
 * and `sizing.ts` are pure functions over the types below, each here because more than one tree
 * has to agree with the others exactly. `sizing.ts` (ADR-0024) is why the browser bundle imports
 * this package as well as core.
 *
 * Frozen by ADR-0003 (`docs/adr/0003-provider-sdk-shape-and-exclusions.md`), written from the
 * de-risking spike's findings memo (`docs/spike/findings.md`). Changes require amending that
 * ADR — the doc comments here carry the reasoning so a provider author never has to guess
 * which rules are load-bearing.
 */

export type { ProviderCapabilities } from './capabilities.js'

export {
  isProviderError,
  isRetryableProviderErrorCode,
  PROVIDER_ERROR_CODES,
  ProviderError,
  RETRYABLE_PROVIDER_ERROR_CODES,
  unsupportedOperationError,
  type ProviderErrorCode,
  type ProviderErrorOptions,
} from './errors.js'

export {
  INSTANCE_STATES,
  isTerminalInstanceState,
  stillExistsAtProvider,
  TERMINAL_INSTANCE_STATES,
  type InstanceState,
  type InstanceView,
} from './instance.js'

export { RESOURCE_OWNERSHIPS, type ManagedResource, type ResourceOwnership } from './managed.js'

export { ARCHITECTURES, type Architecture, type Offering, type Price } from './offering.js'

export {
  archLabel,
  chooseForSize,
  chooseOffering,
  compareOfferingsByPrice,
  meetsRequirements,
  preferenceObstacle,
  requirementsForSize,
  SERVER_SIZES,
  SIZE_REQUIREMENTS,
  type OfferingChoice,
  type OfferingRefusal,
  type PreferenceObstacle,
  type RejectedPreference,
  type Requirements,
  type ServerSize,
  type SizeChoice,
  type SizeChoiceOptions,
} from './sizing.js'

export { normalizeSshCidrs, opensSshToTheInternet } from './ssh-cidr.js'

export {
  RESERVED_PROVIDER_SETTING_NAMES,
  SSH_ALLOW_ALL_FIELD,
  type ProviderAdvisory,
  type ProviderSettingField,
  type ProviderSettingKind,
  type ProviderSettingList,
  type ProviderSettingListItemField,
  type ProviderSettings,
} from './settings.js'

export {
  SSH_ACCESS_SYNC_STATUSES,
  type SshAccessSyncOptions,
  type SshAccessSyncResult,
  type SshAccessSyncStatus,
} from './ssh-access.js'

export {
  assertHostnameSafeId,
  isHostnameSafeId,
  type ProvisionSpec,
} from './provision.js'

export {
  DESCRIBE_ABSENCE_GRACE,
  type ComputeProvider,
  type ConfigSchema,
  type ProviderConfig,
  type ProviderData,
  type ProviderFactory,
  type ProvisionResult,
} from './provider.js'
