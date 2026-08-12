# Writing a compute provider

A provider is the only part of Rocky Surf that knows what a cloud is. Core knows how to boot a
box, install software on it, watch it, bill it and reap it; a provider knows how to make one
exist.

This page is the **workflow** — what to build, in what order, and what has to be true before it
merges. The **type contract** lives in
[`packages/provider-sdk/README.md`](../packages/provider-sdk/README.md) and in the doc comments
on the types themselves, which carry the reasoning. Read that first; this page assumes it.

The shape is frozen by [ADR-0003](adr/0003-provider-sdk-shape-and-exclusions.md). If your cloud
genuinely does not fit, that is an ADR amendment in the same pull request, not a special case in
core.

## What you are building

A package that default-exports a `ProviderFactory` — an id, a display name, a config schema, and
a synchronous `createProvider(config)` that does no I/O — whose provider implements **nine
methods** and declares five capabilities.

```
packages/provider-<id>/
├── package.json          # depends on @rockysurf/provider-sdk; never on @rockysurf/core
├── src/
│   ├── index.ts          # the default-exported ProviderFactory
│   ├── config.ts         # the config schema (zod, or anything with a throwing parse())
│   ├── provider.ts       # the ComputeProvider implementation
│   └── *.test.ts
└── README.md             # published to npm — say what it is and how it is constructed
```

**Nothing in your package may import `@rockysurf/core`**, and core will never import you.
`scripts/check-core-deps.mjs` enforces both directions in CI. The only thing that knows your
package exists is the composition root.

## The nine methods

| method | the thing to get right |
|---|---|
| `validateCredentials()` | prove the credential, loudly. This is where an unreachable host or a read-only token is reported, not later |
| `validateSpec(spec)` | reject a spec the cloud will reject, before anything is created |
| `listOfferings()` | machine types with prices. A price you do not know is `null` — the SDK defines that as *unknown, never free*, and `0` would render as free |
| `provision(spec)` | create it. Return enough `ProviderData` to find it again |
| `describe(data)` | current state. **See the grace rule below** |
| `terminate(data)` | idempotent — not-found is success. Returning does not mean the resources are gone; expect `terminating` next |
| `listManaged()` | everything you created, each tagged `server-owned` or `shared`. The reconciler deletes the first kind and never the second |
| `stop(data)` / `start(data)` | required **even if you cannot stop** |

Four of those have bitten someone already, which is why they are called out in the SDK README as
well:

1. **`describe()` maps absence to `terminated` only after a propagation grace.** Eventually
   consistent APIs report a just-created instance as missing. Believing that marks a healthy,
   billing instance dead and orphans it. `DESCRIBE_ABSENCE_GRACE` (4 attempts, 2s apart) is the
   floor — lengthen it if your cloud needs it, never skip it.
2. **`terminate()` is idempotent.** Reconcilers retry.
3. **`listManaged()` reports secondary resources**, correctly tagged. Hetzner's provider owns the
   SSH Key objects it creates; AWS's shares one security group across every server. Getting the
   tag wrong means either an orphan that bills forever or a reaper that deletes something another
   server is using.
4. **`stop`/`start` exist even when unsupported.** Throw
   `unsupportedOperationError(this.id, 'stop')` and set `capabilities.stop = false`. Core branches
   on the capability flag and never on `typeof provider.stop === 'function'`, because two ways to
   ask the same question is how they drift apart. `@rockysurf/provider-byo` is the worked example.

## Capabilities are the whole interface core can see

```ts
const capabilities: ProviderCapabilities = {
  stop: true,                 // can it stop and restart with the disk intact?
  ipStableAcrossStop: false,  // does the public IP survive that?
  canInjectHostKeys: true,    // can the box come up presenting a host key core minted?
  userDataMaxBytes: 16384,    // hard ceiling on the rendered document, before transport encoding
  generatesUserData: true,    // does the provider deliver user-data at all?
}
```

**There are zero `provider.id` conditionals in shared code, and tests enforce that.** So this
object is not an implementation detail — it is the complete set of behavioural differences core
is able to see. If core needs to do something differently for your cloud and no flag expresses
it, that is an ADR conversation, not a conditional.

One dependency is checked by the conformance suite: `canInjectHostKeys` requires
`generatesUserData`. With no user-data there is no way to place a key before first contact.

`canInjectHostKeys` is a **security posture**, not a feature toggle. `true` means there is no
trust-on-first-use window, and the first connection — the one carrying the secrets file — is
verified against a key core generated itself. If you set it `false`, say plainly in your
provider's docs what the operator is trusting instead;
[`docs/providers/byo.md`](providers/byo.md) is the model.

## Prices and currency

Prices ship **bundled and stamped with `fetchedAt`**; live pricing APIs are out of v0. There is
one documented exception, `@rockysurf/provider-hetzner`, and the reason it is allowed is narrow:
Hetzner returns prices inline on the exact `GET /server_types` call `listOfferings()` already
makes, so preferring a bundled number would mean showing a figure known to be staler than one
already in hand, having saved no request.

Quote the **currency your cloud bills in**, not USD. The spend cap compares per currency and
deliberately does not sum across them — a Hetzner project billed in EUR and an AWS account billed
in USD added together is a fiction.

## Conformance

`@rockysurf/provider-conformance` is the shared suite. It is test-only, resolved **from source**
rather than through `dist/`, and never a runtime dependency.

```ts
import { assertProviderShape, assertFactoryShape, assertOfferingsShape } from '@rockysurf/provider-conformance'
```

It checks the mechanical contract: the id is lowercase and non-empty, all nine methods exist,
the five capability fields have the right types, `canInjectHostKeys` implies `generatesUserData`,
offerings and managed-resource records have the right shape, errors are `ProviderError`s with a
valid code, and `createProvider` does no I/O. It also carries the absence-grace probe, which is
how the `describe()` grace rule gets asserted rather than assumed.

Passing conformance is necessary and not sufficient. It cannot know whether your cloud actually
does what you said it does.

## Wiring it in

One row in `packages/rockysurf/src/compose.ts` — the composition root, and the only file in the
repository allowed to import both core and a provider:

```ts
{
  factory: myProviderFactory,
  section: (config) => config.providers.mycloud,
  credentialField: 'token',              // or null if it needs no credential
  input: ({ enabled: _enabled, ...rest }, credential) => ({ ...rest, ...(credential ? { token: credential } : {}) }),
  credentialHint: 'providers.mycloud.token, or MYCLOUD_TOKEN',
}
```

Two things that row encodes:

- **`enabled` is stripped.** It is core's field — orchestration, not provider configuration — and
  every provider schema is a `strictObject`, so passing it through is rejected outright. That
  rejection is the boundary doing its job.
- **Credentials resolve config-first, then the encrypted secrets store.** A credential written in
  the config file is the one an operator can see, diff and roll back, so it wins; the store holds
  what the first-run wizard pasted, for the operator who does not edit files. A credential pasted
  in the wizard takes effect at the **next restart**, because providers are constructed at boot.

A provider that is enabled but cannot be built is **reported and skipped**, never fatal. The
control plane still starts, because the UI is where an operator fixes it.

## Before it merges

- [ ] Nine methods implemented; `stop`/`start` throw rather than being absent if unsupported.
- [ ] Conformance suite passes.
- [ ] A column in [`docs/providers/capability-matrix.md`](providers/capability-matrix.md), filled
      in **in the same pull request**, with a note on how each value was established. A value
      nobody has exercised must say so — the way the `byo` column does.
- [ ] A package `README.md`. It is published to npm, and a public package with no front page is a
      bad first impression.
- [ ] A page under `docs/providers/` if the provider has operator-facing consequences worth
      stating — what claiming a host does to it, what a minimal IAM policy looks like, what
      `terminate` deliberately does not do.
- [ ] `pnpm run check` green, including the dependency lint.
- [ ] If your package pulls in a vendor SDK, confirm it did not land in the `npx` install closure
      (`scripts/check-npx-closure.mjs`). Core's cold start is a feature.

## Out of tree

Nothing here requires your provider to live in this repository. `@rockysurf/provider-sdk` is
published precisely so it does not have to: depend on it, implement the factory, and construct
your own registry in your own composition root. The SDK has **zero runtime dependencies**, which
is deliberate — anything it depended on would be inherited by every provider and every consumer.
