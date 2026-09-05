# The types you will import

Everything here comes from `@rockysurf/provider-sdk`. This page is the field lists and signatures —
the *reasoning* is in the doc comments on the types themselves, which are worth reading and which
this page does not replace.

**The SDK's own README ships inside the tarball**: after installing, it is at
`node_modules/@rockysurf/provider-sdk/README.md`, and the type definitions with their full doc
comments are at `node_modules/@rockysurf/provider-sdk/dist/*.d.ts`. That is the authoritative
contract and you have it whether or not you have a checkout of the repository.

**ESM, `nodenext`**: the SDK is ESM-only and resolved with `nodenext`, so every relative import in
your package needs a `.js` extension even though the file is `.ts` (`from './config.js'`). Removing
those extensions to "tidy up" breaks the build.

## The imports

```ts
import type {
  ComputeProvider, ProviderFactory, ConfigSchema, ProviderData,
  ProvisionSpec, ProvisionResult, InstanceView, InstanceState,
  ManagedResource, ResourceOwnership, Offering, Price, Architecture,
  ProviderCapabilities, ProviderErrorCode,
} from '@rockysurf/provider-sdk'

import {
  ProviderError, isProviderError, PROVIDER_ERROR_CODES,
  unsupportedOperationError, assertHostnameSafeId, isHostnameSafeId,
  INSTANCE_STATES, TERMINAL_INSTANCE_STATES, stillExistsAtProvider,
  isTerminalInstanceState, DESCRIBE_ABSENCE_GRACE, ARCHITECTURES,
  RESOURCE_OWNERSHIPS,
} from '@rockysurf/provider-sdk'
```

## `ComputeProvider` — nine required methods and one optional

```ts
interface ComputeProvider {
  readonly id: string
  readonly displayName: string
  readonly capabilities: ProviderCapabilities

  validateCredentials(): Promise<void>
  validateSpec(spec: ProvisionSpec): Promise<void>
  listOfferings(): Promise<Offering[]>
  provision(spec: ProvisionSpec): Promise<ProvisionResult>
  describe(data: ProviderData): Promise<InstanceView>
  terminate(data: ProviderData): Promise<void>
  listManaged(): Promise<ManagedResource[]>
  stop(data: ProviderData): Promise<void>
  start(data: ProviderData): Promise<void>

  // OPTIONAL — present exactly when capabilities.managesSshAccess is true (ADR-0021).
  syncSshAccess?(options?: SshAccessSyncOptions): Promise<SshAccessSyncResult>
}

interface SshAccessSyncOptions { revoke?: readonly string[] }   // extras the operator confirmed for removal
interface SshAccessSyncResult {
  status: 'updated' | 'unchanged' | 'skipped' | 'failed'
  applied: readonly string[]      // what the cloud allows now; empty on skipped/failed
  reported: readonly string[]     // ranges found and deliberately not touched
  removable?: readonly string[]   // the subset of reported you CAN revoke if confirmed
  detail: string                  // one or two plain sentences, remediation included
}
```

`syncSshAccess()` takes NO CIDR list — the provider reads its own config. The rules it must follow
are in [ssh-access.md](ssh-access.md).

**Who calls `validateSpec`:** core calls it before `provision()`, and **`provision()` must not
assume it was called.** So validate in both places, or have `provision()` call it — double
validation is cheap and the create path is where trap 3's committed-at-create-time failures live.

## `ProviderFactory`, `ConfigSchema` and `ProviderCapabilities`

```ts
interface ProviderFactory<TConfig> {
  readonly id: string            // matches the id of the providers it creates
  readonly displayName: string
  readonly configSchema: ConfigSchema<TConfig>
  createProvider(config: TConfig): ComputeProvider   // synchronous, no I/O

  // Optional (ADR-0026, E18): where a token lands, and the variables it may arrive under when the
  // config field is empty. A chain-auth cloud declares neither, or credentialEnv alone.
  readonly credentialField?: string              // 'token'
  readonly credentialEnv?: readonly string[]     // ['MYCLOUD_TOKEN']

  // Optional (ADR-0027, E19): what the Settings panel shows. See ProviderSettings below.
  readonly settings?: ProviderSettings
}

interface ConfigSchema<TConfig> {
  parse(input: unknown): TConfig   // throws on invalid input
}

interface ProviderCapabilities {
  stop: boolean
  ipStableAcrossStop: boolean
  canInjectHostKeys: boolean      // requires generatesUserData
  userDataMaxBytes: number        // integer >= 0
  generatesUserData: boolean
  // Optional; absent means false. See contract.md for what each one obliges you to.
  simulatedInstances?: boolean    // no machine at the address reported (test doubles only)
  managesSshAccess?: boolean      // a shared firewall object core pushes sshAllowedCidr at; requires syncSshAccess()
  billsWhileStopped?: boolean     // a stopped machine bills at the RUNNING rate
}
```

`ConfigSchema` is structural — just something with a throwing `parse` — precisely so the SDK never
depends on a validation library. A zod schema satisfies it; so does a hand-written function.

## `ProviderSettings`

What the Settings page draws for your provider (ADR-0027). A DECLARATION beside the schema, not the
schema: it carries what a page needs and a validator cannot say — labels, sentences, that a `token`
box takes the NAME of a variable, that the SSH whitelist is one control over two fields.

```ts
interface ProviderSettings {
  title: string                      // the panel's title
  help: string                       // one or two sentences under it — a SENTENCE, conformance checks
  fields: readonly ProviderSettingField[]   // in the order the panel draws them
  lists?: readonly ProviderSettingList[]    // the providers.byo.hosts shape
  offering: { noun: string; example: string }   // 'server type' / 'cpx21' — for the saved-type fields
  advisories?: readonly { surface: 'settings' | 'create'; text: string }[]
}

interface ProviderSettingField {
  name: string                       // the key inside providers.<id>, as configSchema expects it
  kind: 'string' | 'number' | 'boolean' | 'secret' | 'stringList' | 'sshCidrList'
  label: string
  help: string                       // a sentence
  warning?: string
  writable?: boolean                 // default true; false needs `reason`
  reason?: string
  appliesAt?: 'save' | 'restart'     // default 'save'; 'restart' needs `restartReason`
  restartReason?: string
  accepts?: 'envVarName' | 'literal' // secret only; default envVarName
  example?: string                   // parsed through configSchema by conformance
}
```

Rules conformance enforces: every `help` is a sentence; every `example` parses through
`configSchema` (a secret's substituted with a placeholder — it is a variable NAME); `enabled`,
`package` and `sizes` are NOT declared (they are the installation's, added to every panel);
`sshCidrList` is named `sshAllowedCidr`, implies the `allowAllCidr` checkbox (do not declare it), and
requires `capabilities.managesSshAccess`. `advisories` are for what only a human needs to know —
anything core computes with is a capability, never a sentence.

`provider.id` must be **lowercase and non-empty**; conformance checks it. Decide it at scaffold
time, because it is the key of your config section and the name in every error message.

## `ProviderData` — the handle

```ts
type ProviderData = Record<string, unknown>
```

Whatever you need to find the instance again. It is persisted by core and **round-trips through
JSON in a database**, so it must be plain serialisable data — and `describe()` cannot write back to
it. See "where the seen-running memory lives" below, because that constraint decides it.

## `ProvisionSpec`

```ts
interface ProvisionSpec {
  serverId: string          // core's id. MUST be hostname-safe — assert, never sanitize
  name: string              // human-facing; becomes the hostname in rendered user-data
  offeringId: string        // provider-native, from listOfferings()
  arch: Architecture
  sshPublicKeys: string[]   // keys the PROVIDER must register with its own API
  userData: string          // the rendered #cloud-config, verbatim, or '' when !generatesUserData
  tags: Record<string, string>   // always includes managed-by=<prefix> and server-id=<id>
  idempotencyKey: string    // dedupe key for this create attempt
}
```

Four obligations hide in there:

- **Assert `serverId`, do not sanitize it.** Call `assertHostnameSafeId(spec.serverId)` from
  `validateSpec`. Sanitizing would need an injective map and cannot have one — two different
  logical servers would collide onto one cloud resource.
- **`sshPublicKeys` exists because some APIs will not take raw key material inline.** Core is the
  sole owner of key material. On a cloud-init provider these keys also reach the box through
  `userData`, so the field is near-redundant and you merely assert they appear; on Hetzner it is
  load-bearing, because the create call must reference first-class SSH Key objects — which the
  provider then *owns and must reap* (this is where trap 3's `server-owned` resources come from).
- **Pass `userData` through unchanged** — base64-encode it if the API demands that, but never
  append to it.
- **Refuse a spec whose `managed-by` tag disagrees with your configured prefix.** An instance
  tagged with anything else is invisible to your own `listManaged()`, and therefore an orphan from
  the moment it is created. This is the same incident as trap 3.

`idempotencyKey` maps onto whatever the cloud offers: AWS passes it straight through as an EC2
`ClientToken`; Hetzner has no such concept and dedupes on the derived server name. The key includes
a generation component, so terminating `dev-box` and recreating it with identical settings does not
collide with the dead row forever.

## `ProvisionResult`

```ts
interface ProvisionResult {
  data: ProviderData     // the handle to persist
  initial: InstanceView  // the state as of the create call
}
```

Returning the handle alone is a type error, and `initial` is not busywork: it saves core an
immediate `describe()` — an extra round trip on the one call that already knows the answer, and on
an eventually consistent cloud a round trip straight into the propagation window.

## `InstanceView`

```ts
interface InstanceView {
  state: InstanceState
  publicIp?: string
  publicDns?: string
  offeringId?: string            // what it is actually running, if that can differ
  failureReason?: string         // the cloud's own words — see below
  hostKeyFingerprint?: string    // ONLY from a canInjectHostKeys: false provider
  hostPublicKey?: string         // only alongside the fingerprint
  sshPort?: number               // absent means 22
}
```

Populate `failureReason` when `state` is `unknown` or `failed` and the API gave you a
human-readable message. That is exactly the case where somebody needs the cloud's untranslated
words, because your mapping had nothing to say.

The last three are for providers that adopt machines they did not create. If
`canInjectHostKeys` is `true`, core minted the host key and shipped it in user-data, so it already
knows the answer and those fields stay absent.

## `InstanceState`

```ts
const INSTANCE_STATES = ['pending','running','stopping','stopped','terminating','terminated','failed','unknown']
```

Helpers, so you do not re-implement the predicates:

```ts
stillExistsAtProvider(state)   // state !== 'terminated' — what a reconciler must ask
isTerminalInstanceState(state) // terminated | failed — terminating is deliberately NOT terminal
TERMINAL_INSTANCE_STATES
```

Those two are different questions and the difference is the point: a `terminating` instance is
terminal for *scheduling* and still present for *reaping*.

## `ManagedResource`

```ts
interface ManagedResource {
  kind: string               // free-form: 'instance' | 'volume' | 'security-group' | 'ssh-key'
  providerNativeId: string   // as the cloud's API would accept it
  ownership: ResourceOwnership   // 'server-owned' | 'shared'
  serverId?: string          // from the tags; expected when server-owned and attributable
}
```

`kind` is free-form on purpose — the set of kinds a cloud has is not something the SDK can
enumerate — and core does not branch on it. A `server-owned` resource with no `serverId` is legal
and is a finding: it cannot be safely reaped by server.

## `Offering` and `Price`

```ts
interface Offering {
  id: string          // provider-native: 't4g.small', 'cpx12'
  cpu: number
  memoryGb: number
  diskGb?: number
  arch: Architecture  // ARCHITECTURES: 'amd64' | 'arm64'
  hourly: Price | null    // null means UNKNOWN, never free
  available: boolean
  region: string
}

interface Price { amount: number; currency: string; fetchedAt: string }  // ISO 4217, ISO 8601
```

**Return sold-out types with `available: false` rather than omitting them.** Omitting them leaves
core unable to distinguish "this cloud has no ARM" from "ARM is sold out this afternoon", and those
need different messages and different fallbacks. Hetzner publishes prices for sold-out types, and
at one point had zero arm64 stock everywhere — a price is not an offer.

## Errors

```ts
const PROVIDER_ERROR_CODES = [
  'auth', 'quota', 'capacity', 'invalid_spec',
  'not_found', 'rate_limited', 'conflict', 'network', 'unknown',
]

new ProviderError(code, message, { providerCode, cause })
```

- **`retryable` is a derived getter, not a field.** There is no way to set it and therefore no way
  for it to disagree with `code`. `unknown` is deliberately *not* retryable.
- **Keep the cloud's own code in `providerCode`.** Flattening onto nine codes loses information
  that the operator reading the message needs back.
- **`isProviderError(err)` is the narrowing helper for `catch` blocks**, which receive `unknown`.
  It is STRUCTURAL (the name `ProviderError` plus one of the nine codes), not `instanceof`: a
  personal provider carries its own copy of the SDK, so its `ProviderError` is a different class
  from core's. Do not rely on `instanceof` across that boundary in your own code either.
- `unsupportedOperationError(providerId, 'stop')` builds the `invalid_spec` error a
  `capabilities.stop: false` provider throws from `stop`/`start`.

## Where the "seen running" memory lives

Trap 2's third sub-rule needs `describe()` to know whether this instance has ever been observed
running. That state cannot live in `ProviderData` — `describe()` receives the handle and cannot
write back to it — so it lives **in memory on the provider instance**, typically a `Set` of native
ids captured in the closure that `makeMycloudProvider` returns.

Two consequences worth building for rather than discovering:

- **It is lost on restart**, and providers are constructed at boot. After a restart, an instance
  mid-teardown pays the full grace once more. That is the safe direction to fail — slower, never
  wrong — but it means the optimisation holds within a process lifetime, not forever.
- **Record the intent before the call that acts on it.** GCP adds the id to its
  "terminate requested" set *before* issuing the delete, so a `describe()` racing the delete still
  reads `terminating` rather than `stopping`.

## The dependency seam your tests need

The conformance harness wants the delay zeroed and a fake cloud underneath, and a one-argument
factory has nowhere to hang either. Give the constructor an options parameter that only tests pass:

```ts
export function makeMycloudProvider(
  config: MycloudProviderConfig,
  deps: { api?: MycloudApi; grace?: { attempts: number; delayMs: number } } = {},
): ComputeProvider {
  const api = deps.api ?? new MycloudApi(config.token)
  const grace = deps.grace ?? DESCRIBE_ABSENCE_GRACE
  // A provider may LENGTHEN the grace and never shorten it. Enforce it here, where it is one line.
  if (grace.attempts < DESCRIBE_ABSENCE_GRACE.attempts) {
    throw new ProviderError('invalid_spec', `grace of ${grace.attempts} is below the SDK floor`)
  }
  …
}
```

`createProvider(config)` in the factory calls it with no deps, so the public contract stays
one-argument.

**The guard floors `attempts` only, never `delayMs`.** Zeroing the delay changes what the suite
costs and never what it proves, and your own tests pass `delayMs: 0` — a guard that also floored the
delay would reject every one of them.

## A worked `describe()` with the grace

Written as a closure, which is the shape the scaffold's factory uses — `seenRunning`, `api` and
`grace` are all captured from `makeMycloudProvider`, so there is no `this` anywhere:

```ts
// Inside makeMycloudProvider(config, deps), alongside `api` and `grace`:
const seenRunning = new Set<string>()

async function describe(data: ProviderData): Promise<InstanceView> {
  const id = asMycloudData(data).instanceId

  // Absence is ambiguous ONLY for an instance never seen running. Once it has been running,
  // absence really is absence — and this is the path core polls during teardown.
  const attempts = seenRunning.has(id) ? 1 : grace.attempts

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const server = await api.getServer(id)      // returns undefined for not-found
    if (server !== undefined) {
      const state = STATE_MAP[server.status] ?? 'unknown'
      if (state === 'running') seenRunning.add(id)
      return {
        state,
        ...(server.ip !== undefined && { publicIp: server.ip }),
        // The cloud's own words, only where this SDK had nothing to map onto.
        ...(state === 'unknown' && server.message !== undefined && { failureReason: server.message }),
      }
    }
    if (attempt < attempts) await sleep(grace.delayMs)
  }

  // The grace is spent. Absence is a normal teardown outcome, not an error.
  return { state: 'terminated' }
}
```

**One read of the read path is one call to it** — one `getServer` here. That is what
`assertDescribeAbsenceGrace` counts, and the create call inside `provision()` is not part of it.
