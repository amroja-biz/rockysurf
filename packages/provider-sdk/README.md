# `@rockysurf/provider-sdk`

The frozen v0 contract every Rocky Surf compute provider implements. Types plus a few pure
helpers, with **zero runtime dependencies** — anything this package depends on is inherited by
every provider and every consumer.

Frozen by [ADR-0003](../../docs/adr/0003-provider-sdk-shape-and-exclusions.md), written from the
de-risking spike's [findings memo](../../docs/spike/findings.md). **Changing the shape means
amending that ADR.** The doc comments carry the reasoning, so a provider author can see which
rules are load-bearing without reading the history.

See [`docs/providers/capability-matrix.md`](../../docs/providers/capability-matrix.md) for what
each shipped provider declares.

## Writing a provider

```ts
import {
  assertHostnameSafeId,
  ProviderError,
  unsupportedOperationError,
  type ComputeProvider,
  type ProviderCapabilities,
} from '@rockysurf/provider-sdk'

const capabilities: ProviderCapabilities = {
  stop: true,
  ipStableAcrossStop: false,
  canInjectHostKeys: true,
  userDataMaxBytes: 16384,
  generatesUserData: true,
}
```

Implement all nine methods. Four rules are easy to get wrong and expensive to get wrong:

1. **`describe()` maps absence to `terminated` only after a propagation grace.** Eventually
   consistent APIs report a just-created instance as missing; believing that marks a healthy,
   billing instance dead. Use `DESCRIBE_ABSENCE_GRACE` (4 attempts, 2s apart) as the floor. You
   may lengthen it. You may not skip it.
2. **`terminate()` is idempotent** — not-found is success — and returning does not mean the
   resources are gone. Expect `terminating` from `describe()` afterwards.
3. **`listManaged()` reports secondary resources too**, each tagged `server-owned` or `shared`.
   A reconciler deletes the first kind and never the second.
4. **`stop`/`start` are required even when you cannot stop.** Throw
   `unsupportedOperationError(this.id, 'stop')` and set `capabilities.stop = false`. Core
   branches on the capability, never on whether the method exists.

## The config schema convention

A provider package default-exports a `ProviderFactory`: an id, a display name, a config schema,
and a synchronous `createProvider(config)` that does no I/O.

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

## What is deliberately not here

`interruptible` / `checkInterruption` and spot, `resize`, live pricing APIs, dynamic
out-of-tree plugin loading, per-server IAM, and `ProvisionSpec.hostKeys`. The first group was
cut because generalizing from zero implementations with no out-of-tree consumers is premature,
and the spike confirmed nothing had changed. `hostKeys` was removed because no provider ever
consumed it: the public half reaches the box through rendered user-data, and the private half
needs an encrypted home in core, not a trip through a provider.

Bootstrap tokens are absent for a related reason — in push mode, the default topology, no token
goes to the box at all.

## Development

```bash
pnpm --filter @rockysurf/provider-sdk test        # vitest contract suite
pnpm --filter @rockysurf/provider-sdk typecheck   # tsc --noEmit
pnpm --filter @rockysurf/provider-sdk build       # dist/ with .d.ts
```

The contract suite implements a complete fake provider against the interface, which is what
proves at compile time that it is implementable without casts. It also asserts the exclusions
above stay excluded.
