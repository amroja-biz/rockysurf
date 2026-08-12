/**
 * `@rockysurf/provider-byo` — the machines the operator already has.
 *
 * The enterprise story, and the only provider with no cloud API behind it: the "API" is sshd on
 * a box that was running before Rocky Surf existed. What that removes is most of a provider —
 * there is nothing to create, nothing to bill, nothing to power-cycle — and what it leaves is a
 * REGISTRY of hosts plus a CLAIM: `provision()` takes a registered host, prepares it, and marks
 * it held; `terminate()` gives it back.
 *
 * Three consequences, each visible in the capabilities and each honest about a limitation:
 *
 *  - **`generatesUserData: false`.** No pre-boot hook, so core renders no `#cloud-config` and
 *    `provision()` does over SSH what cloud-init does before boot: create the account core will
 *    connect as, install core's authorized keys, grant passwordless sudo. Everything after that
 *    is the push bootstrap both clouds already run, which is what makes BYO a subset of the
 *    existing mechanism rather than a second one.
 *  - **`canInjectHostKeys: false`,** which follows: with no user-data there is nowhere to put a
 *    host key before first contact. The key is learned instead — trust-on-first-use inside this
 *    package, pinned from then on, mismatch refused — and what core receives is a fingerprint to
 *    verify strictly, not a trust decision to make. See `ssh.ts`.
 *  - **`stop: false`.** Core does not own the power state of a machine it did not create. Per
 *    ADR-0003 (A2) both methods still exist and both throw.
 *
 * `terminate()` NEVER runs anything on the host. It is the operator's machine; releasing a claim
 * is bookkeeping, not demolition.
 */

export {
  byoConfigSchema,
  byoHostSchema,
  type ByoHost,
  type ByoProviderConfig,
  type ByoProviderInput,
} from './config.js'

export {
  assertSafeAccount,
  buildPrepareScript,
  parseHostFacts,
  PROBE_SCRIPT,
  type HostFacts,
} from './prepare.js'

export {
  asByoData,
  BYO_CAPABILITIES,
  BYO_PROVIDER_ID,
  makeByoProvider,
  type ByoData,
} from './provider.js'

export {
  connectOverSsh,
  fingerprintFromBlob,
  HostKeyMismatchError,
  scriptCommand,
  shellQuote,
  toProviderError,
  type ConnectOptions,
  type Connector,
  type ExecResult,
  type HostConnection,
} from './ssh.js'

import type { ProviderFactory } from '@rockysurf/provider-sdk'
import { byoConfigSchema, type ByoProviderConfig } from './config.js'
import { BYO_PROVIDER_ID, makeByoProvider } from './provider.js'

/**
 * The package's default export. `createProvider` is synchronous and side-effect free — it opens
 * no connection and reads no key file — so core can load this provider and show its identity
 * before anything has been asked of the operator's machines. Reachability is proven separately,
 * by `validateCredentials()`.
 */
export const byoProviderFactory: ProviderFactory<ByoProviderConfig> = {
  id: BYO_PROVIDER_ID,
  displayName: 'Bring your own hosts',
  configSchema: byoConfigSchema,
  createProvider: (config) => makeByoProvider(config),
}

export default byoProviderFactory
