# `@rockysurf/provider-sdk`

The frozen v0 contract every Rocky Surf compute provider implements. Types plus a few pure
helpers, with **zero runtime dependencies** — anything this package depends on is inherited by
every provider and every consumer. That is the promise, and it is deliberately not "no code": a
helper lives here when more than one tree has to agree with the others exactly, which is why
`ssh-cidr` and `sizing` are here as well as the types.

This is the package you depend on to write a provider Rocky Surf can drive, whether or not it
lives in the Rocky Surf repository. Nothing here requires it to: depend on this package,
implement the factory, and construct your own registry in your own composition root.

- [What is in it](#what-is-in-it)
- [Writing a provider](#writing-a-provider)
- [Four rules that are expensive to get wrong](#four-rules-that-are-expensive-to-get-wrong)
- [The config schema convention](#the-config-schema-convention)
- [Conformance is the acceptance bar](#conformance-is-the-acceptance-bar)
- [What is deliberately not here](#what-is-deliberately-not-here)
- [Changing the contract](#changing-the-contract)

```bash
pnpm add @rockysurf/provider-sdk
```

## What is in it

| module | what it defines |
|---|---|
| `provider` | `ComputeProvider` (the nine methods), `ProviderFactory`, `ProviderConfig`, `ConfigSchema`, `ProviderData`, `ProvisionResult`, and `DESCRIBE_ABSENCE_GRACE` |
| `capabilities` | `ProviderCapabilities` — the only thing core is allowed to branch on |
| `instance` | `InstanceView`, `InstanceState` and the terminal-state helpers `isTerminalInstanceState` and `stillExistsAtProvider` |
| `offering` | `Offering`, `Price`, `Architecture` |
| `provision` | `ProvisionSpec`, and `assertHostnameSafeId` / `isHostnameSafeId` |
| `managed` | `ManagedResource`, `ResourceOwnership` — what the reconciler reads |
| `errors` | `ProviderError`, its code list, `isRetryableProviderErrorCode`, `unsupportedOperationError` |
| `ssh-cidr` | `normalizeSshCidrs`, `opensSshToTheInternet` — the one place three providers have to agree character-for-character (ADR-0021) |
| `sizing` | The t-shirt size resolver: `SERVER_SIZES`, `SIZE_REQUIREMENTS`, `chooseOffering`, `chooseForSize` and the saved-type rules — shared by core and the browser bundle (ADR-0024) |

The doc comments carry the reasoning, so you can see which rules are load-bearing without
reading the history behind them. The workflow — what to build, in what order, and what has to be
true before it merges — is
[`docs/writing-a-provider.md`](https://github.com/amroja-biz/rockysurf/blob/main/docs/writing-a-provider.md).
For what each shipped provider declares, see
[`docs/providers/capability-matrix.md`](https://github.com/amroja-biz/rockysurf/blob/main/docs/providers/capability-matrix.md).

## Writing a provider

A provider package default-exports a `ProviderFactory`: an id, a display name, a config schema,
and a synchronous `createProvider(config)` that does no I/O. The provider it returns implements
nine required methods (plus the optional `syncSshAccess()`, ADR-0021) and declares five required
capabilities; three more are optional and absent means `false` — `simulatedInstances` (E15),
`managesSshAccess` (ADR-0021) and `billsWhileStopped` (ADR-0025).

```ts
import {
  assertHostnameSafeId,
  ProviderError,
  unsupportedOperationError,
  type ComputeProvider,
  type ProviderCapabilities,
} from '@rockysurf/provider-sdk'

const capabilities: ProviderCapabilities = {
  stop: true,                 // can it stop and restart with the disk intact?
  ipStableAcrossStop: false,  // does the public IP survive that?
  canInjectHostKeys: true,    // can the box come up presenting a host key core minted?
  userDataMaxBytes: 16384,    // hard ceiling on the rendered document, before transport encoding
  generatesUserData: true,    // does the provider deliver user-data at all?
  // Optional, absent means false:
  //   managesSshAccess    — a shared firewall object core can bring in line with sshAllowedCidr
  //   billsWhileStopped   — a stopped instance still bills at the running rate (ADR-0025)
  //   simulatedInstances  — there is no machine at the address reported (test doubles only)
}
```

Capabilities are the whole interface core can see. **There are zero `provider.id` conditionals in
shared code, and tests enforce that**, so if core would need to do something differently for your
cloud and no flag expresses it, that is a contract change rather than a special case.

Three implementations are worth reading as worked examples:
[`@rockysurf/provider-aws`](https://github.com/amroja-biz/rockysurf/tree/main/packages/provider-aws)
(a vendor SDK),
[`@rockysurf/provider-hetzner`](https://github.com/amroja-biz/rockysurf/tree/main/packages/provider-hetzner)
(plain `fetch`), and
[`@rockysurf/provider-byo`](https://github.com/amroja-biz/rockysurf/tree/main/packages/provider-byo)
(no cloud API at all, and the one that says `false` to three capabilities).

## Four rules that are expensive to get wrong

1. **`describe()` maps absence to `terminated` only after a propagation grace.** Eventually
   consistent APIs report a just-created instance as missing; believing that marks a healthy,
   billing instance dead. Use `DESCRIBE_ABSENCE_GRACE` (4 attempts, 2s apart) as the floor. You
   may lengthen it. You may not skip it.
2. **`terminate()` is idempotent** — not-found is success — and returning does not mean the
   resources are gone. Expect `terminating` from `describe()` afterwards.
3. **`listManaged()` reports secondary resources too**, each tagged `server-owned` or `shared`.
   A reconciler deletes the first kind and never the second. Getting the tag wrong means either
   an orphan that bills forever or a reaper that deletes something another server is using.
4. **`stop`/`start` are required even when you cannot stop.** Throw
   `unsupportedOperationError(this.id, 'stop')` and set `capabilities.stop = false`. Core
   branches on the capability, never on whether the method exists, because two ways to ask the
   same question is how they drift apart.

## The config schema convention

`ConfigSchema<T>` is deliberately just `{ parse(input: unknown): T }`. **A zod schema already
satisfies it structurally**, so a provider can use zod while this SDK depends on nothing:

```ts
import { z } from 'zod'
import type { ProviderFactory } from '@rockysurf/provider-sdk'

const configSchema = z.object({
  region: z.string().min(1),
  profile: z.string().optional(),
})

type AwsConfig = z.infer<typeof configSchema>

export const factory: ProviderFactory<AwsConfig> = {
  id: 'aws',
  displayName: 'Amazon EC2',
  configSchema, // structurally a ConfigSchema<AwsConfig> — no import from the SDK needed
  createProvider: (config) => makeAwsProvider(config),
}
```

zod lives in the provider's dependencies, never in the SDK's. Any validator with a throwing
`parse` works just as well, including a hand-written one.

## Conformance is the acceptance bar

[`@rockysurf/provider-conformance`](https://github.com/amroja-biz/rockysurf/tree/main/packages/provider-conformance)
is the shared suite every provider runs against itself. It is test-only and depends only on this
package, so the zero-runtime-dependency promise holds. The assertions take values and throw
`ConformanceError` rather than calling into a test framework, so you can run them from vitest,
from a fixture harness, or from your own verification script:

```ts
import { assertProviderShape, assertFactoryShape, assertOfferingsShape } from '@rockysurf/provider-conformance'
```

It checks the mechanical contract: the id is lowercase and non-empty, all nine methods exist, the
five capability fields have the right types, `canInjectHostKeys` implies `generatesUserData`,
offerings and managed-resource records have the right shape, errors are `ProviderError`s with a
valid code, and `createProvider` does no I/O. `assertDescribeAbsenceGrace` is the probe that
makes rule 1 above an assertion rather than an assumption.

**It is in the published set**, so an out-of-tree provider runs the same bar the in-tree ones do:
`npm install --save-dev @rockysurf/provider-conformance`. Before the first release nothing is on
the registry yet, so until then install it from a packed tarball — `pnpm pack` produces the same
artifact the release publishes.

Passing conformance is necessary and not sufficient. It cannot know whether your cloud does what
you said it does; only a run against real infrastructure can, which is why every shipped provider
publishes what has been run against it and when.

This package's own test suite is the other half of the same argument: it implements a complete
fake provider against the interface, which is what proves at compile time that the contract is
implementable without casts, and it asserts that the exclusions below stay excluded.

## What is deliberately not here

`interruptible` / `checkInterruption` and spot, `resize`, live pricing APIs, dynamic out-of-tree
plugin loading, per-server IAM, and `ProvisionSpec.hostKeys`. The first group was cut because
generalizing from zero implementations with no out-of-tree consumers is premature, and the spike
confirmed nothing had changed. `hostKeys` was removed because no provider ever consumed it: the
public half reaches the box through rendered user-data, and the private half needs an encrypted
home in core, not a trip through a provider.

Bootstrap tokens are absent for a related reason — in push mode, the default topology, no token
goes to the box at all.

## Changing the contract

The shape is frozen by
[ADR-0003](https://github.com/amroja-biz/rockysurf/blob/main/docs/adr/0003-provider-sdk-shape-and-exclusions.md),
written from the de-risking spike's findings memo. **Changing it means amending that ADR in the
same pull request as the code.**

That is a real path rather than a closed door. Six amendments have been accepted since the
freeze, each one driven by a provider that could not tell the truth without it: `hostKeyFingerprint`
and `hostPublicKey` came from the first provider that could not inject a host key, `sshPort` from
a box whose sshd was not on 22, `consoleUrl` from a console link only the provider could build,
`simulatedInstances` from a provider with no machine behind the address it reports, and
`billsWhileStopped` from the first cloud whose powered-off machines still bill (ADR-0025). Every one
is additive and optional, so no existing provider had to change.

What an amendment needs: the case that some cloud's truth is currently unsayable, the field or
flag that says it, and what core does differently once it can read it. A conditional on
`provider.id` in shared code is the alternative being rejected.

## Development

```bash
pnpm --filter @rockysurf/provider-sdk test        # vitest contract suite
pnpm --filter @rockysurf/provider-sdk typecheck   # tsc --noEmit
pnpm --filter @rockysurf/provider-sdk build       # dist/ with .d.ts
```
