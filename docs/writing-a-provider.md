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
methods** (plus the optional `syncSshAccess()`, ADR-0021) and declares five capabilities, with three
optional ones it declares only when true.

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

## Vendor SDKs

**Default to raw REST over `fetch`.** Buy a vendor library for the part where hand-rolling is a
liability, which in practice means auth, and for nothing else.

The numbers behind that default, from the npm registry when `@rockysurf/provider-gcp` made the
call: `@google-cloud/compute@7.1.0` is **110,039,229 bytes** unpacked, a generated GAPIC client
over protobuf. `google-auth-library@11.0.2` is **601,781 bytes**. Roughly 180 to 1. That provider
declined the first and took the second, for Application Default Credentials only.

The test, in order:

1. **Is the API fetch-shaped** — documented REST, JSON bodies? Write the calls by hand.
   `@rockysurf/provider-hetzner` is 1,043 lines of non-test source against a documented REST
   API, and its entire HTTP transport is one 136-line file, `src/api.ts` (`wc -l`, 2026-08-13).
2. **Is some part of it not fetch-shaped** — a signed assertion flow, a credential chain with
   four sources, a token cache with refresh semantics? Buy that part and only that part. GCP's
   ADC spans a service-account keyfile, a `gcloud` user refresh token, the GCE metadata server
   and workload identity federation; an RS256 assertion flow written by hand buys nothing and
   costs a class of bug you cannot debug against somebody else's cloud.
3. **Whatever you take has to be contained.** `scripts/check-npx-closure.mjs` walks core's and
   the CLI's production closures against a `VENDOR_RULES` table — one row per vendor package,
   each `{ id, pattern, provider, label }` — and asserts that every rule's `pattern` is absent
   from core's closure and reaches the CLI only through its own `provider`. Add a row for your
   dependency, with fixture tests in `packages/core/src/npx-closure.test.ts` proving the check
   fails in both directions when it is broken. Core is loaded by every installation, including
   operators who will never call your cloud.

The saving is not only disk. A generated client hides the API, and the GCE work found two things
one would have papered over: HTTP 200 means *accepted*, not *done* — every mutating call returns
a pending Operation, and the failure arrives in the body of a later poll, also HTTP 200 — and GCE
has two separate error vocabularies, HTTP `reason` strings and SCREAMING_SNAKE Operation codes,
both of which have to be mapped. Writing the transport is what made them visible.

### Where a measured number may live

Note the two forms above, because the difference decides where a figure belongs.

**A measurement of this repository lives in exactly one place, dated, and is re-measured rather
than quoted.** Never write one into the file it measures: it goes stale on the next edit,
including the edit that corrects it. `provider-hetzner`'s transport comment claimed "~600 lines"
against a real 1,036, propagated into two other documents before anyone counted, and the first
attempt to fix it in place was false the moment it was saved, because the correction itself
added lines (`rockysurf-z3uz`).
That is why the line counts are here and not in `api.ts`.

**A measurement of an external artifact may be inlined, if you name the version.** npm tarballs
are immutable once published, so `@google-cloud/compute@7.1.0` is 110,039,229 bytes for good.
"Measured on 2026-08-13" is the weaker form: it does not say what `latest` pointed at, so it
decays on the next release. `@rockysurf/provider-gcp`'s `auth.ts` carries its comparison inline
for this reason.

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
  // Optional — absent means false. Declare one only when it is true of the cloud:
  //   managesSshAccess: true,   // a shared firewall object core pushes sshAllowedCidr at (ADR-0021)
  //   billsWhileStopped: true,  // a stopped machine bills at the running rate (ADR-0025)
}
```

`billsWhileStopped` is the one that decides money: with it, core's meter keeps running through
`stopped` and the server page says so. It means the RUNNING rate — a cloud that charges a reduced
rate while stopped must not set it, and needs a capability that does not exist yet.

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

`@rockysurf/provider-conformance` is the shared suite. It is test-only and never a runtime
dependency. Inside this workspace it resolves **from source** rather than through `dist/`, so a
provider's tests never wait on it being built; the published tarball points at `dist/` instead,
which is a `publishConfig` override and the one place a tarball manifest differs from the one in
the repository. Out of tree, `npm install --save-dev @rockysurf/provider-conformance` — or, until the
first release puts it on the registry, a tarball from `pnpm pack`.

```ts
import { assertProviderShape, assertFactoryShape, assertOfferingsShape } from '@rockysurf/provider-conformance'
```

It checks the mechanical contract: the id is lowercase and non-empty, all nine methods exist,
the five capability fields have the right types and the optional ones are booleans when declared,
`canInjectHostKeys` implies `generatesUserData`, `managesSshAccess` and `syncSshAccess()` agree,
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
- **Credentials resolve config-first, then the environment** (issue #280). A credential written
  in the config file is the one an operator can see, diff and roll back, so it wins; with the
  field empty, `PROVIDER_CREDENTIAL_ENV` names the variables the composition root reads
  directly — the path the first-run wizard steers a token cloud to. Nothing is ever stored:
  "Rocky Surf stores no cloud credentials" is unconditional.
- **Composition runs again when the config file changes** (issue #264). Providers are still
  constructed all at once, from one config, and the registry every route holds takes the new set
  in place — so an operator who fixes a region or switches a cloud on gets working clients
  without a restart. Nothing on a provider is closed when it is replaced: the SDK deliberately
  gives a provider no lifecycle, and a client still inside an in-flight call keeps serving that
  call to the end. A credential arriving through an environment variable is the exception,
  because a variable cannot appear inside a running process; it takes effect at the **next
  restart**, which is when composition sees it.

A provider that is enabled but cannot be built is **reported and skipped**, never fatal. The
control plane still starts, because the UI is where an operator fixes it.

## The package README

Your `README.md` is in the `files` allowlist in `package.json`, so it is the page npm shows and
the first thing a stranger reads about your provider. Write it for the operator deciding whether
this provider gives them what they need, not for the person maintaining it. Development commands,
design history and issue ids belong in this repository, not on the package page.

Every shipped provider uses the same section order, so an operator comparing two clouds can
compare two documents:

| section | what belongs in it |
|---|---|
| title and one paragraph | which cloud, what the provider talks to it with, and what it will not do |
| **How you get it** | providers in this repository ship inside the `rockysurf` CLI and are switched on in configuration; an out-of-tree provider says how it is installed and registered instead |
| **Configuration** | the YAML an operator can paste, then every field with its default. Take both from your own `config.ts` — that schema is what actually parses the section |
| **Credentials** | where the credential comes from and where it is not kept. A token named in the config file is written `${VAR}`, an environment reference rather than a literal |
| **What it needs in your account** | permissions, network prerequisites, host preparation. Link the IaC when the repository ships some |
| **Capabilities** | the five `ProviderCapabilities` values and what each one costs the operator |
| **Prices** | live, bundled with a `fetchedAt`, or `null`. Say which, and say the currency |
| **Verified** | what has been run against real infrastructure, and when |
| **Writing your own provider** | one line pointing at the SDK README and this page |

Drop a section your provider has nothing true to put in; do not reorder the ones you keep.

Two of them carry rules rather than conventions.

**Capabilities are copied, not summarised.** Print the same five values the source declares, and
check them against your `ProviderCapabilities` constant when you edit either. A README that
disagrees with the constant is worse than one that omits the section: core branches on the
constant, so the reader is being told the wrong thing about how their servers will behave.

**A verification section states what has been run and nothing more.** Name the machine type, the
region, the date and where the evidence lives; if a nightly job re-runs it, say so, because a
lifecycle proved once is a lifecycle that was true once. A provider nobody has pointed at real
hardware says exactly that —
[`@rockysurf/provider-byo`](../packages/provider-byo/README.md#verified) is the worked example,
and the status block in [`docs/providers/aws.md`](providers/aws.md#the-iam-policy) is the model
for one that has been.

## Before it merges

- [ ] Nine methods implemented; `stop`/`start` throw rather than being absent if unsupported.
- [ ] Conformance suite passes.
- [ ] A column in [`docs/providers/capability-matrix.md`](providers/capability-matrix.md), filled
      in **in the same pull request**, with a note on how each value was established. A value
      nobody has exercised must say so — the way the `byo` column does.
- [ ] A package `README.md` in the section order above, with its capability values matching the
      source and its verification section claiming only what has been run.
- [ ] A page under `docs/providers/` if the provider has operator-facing consequences worth
      stating — what claiming a host does to it, what a minimal IAM policy looks like, what
      `terminate` deliberately does not do.
- [ ] `pnpm run check` green, including the dependency lint.
- [ ] If your package pulls in a vendor SDK, confirm it did not land in the `npx` install closure
      (`scripts/check-npx-closure.mjs`), and that you took it for the reason
      [Vendor SDKs](#vendor-sdks) allows. Core's cold start is a feature.

## Out of tree

Nothing here requires your provider to live in this repository. `@rockysurf/provider-sdk` is
published precisely so it does not have to: depend on it, implement the factory, and construct
your own registry in your own composition root. The SDK has **zero runtime dependencies**, which
is deliberate — anything it depended on would be inherited by every provider and every consumer.

`@rockysurf/provider-conformance` is published for the same reason, so the acceptance bar above is
one you can actually run rather than one you have to take on trust. It depends only on the SDK.

What an out-of-tree provider does *not* get is the wiring: the checklist above assumes a
composition root, a core config section and a settings inventory that are all in this repository.
Building your own registry means you own those decisions instead —
[`.agents/skills/adding-providers/references/wiring.md`](../.agents/skills/adding-providers/references/wiring.md)
lists every in-tree touch point, which doubles as the list of things you are replacing.

## A skill that walks through all of this

`.agents/skills/adding-providers/` is an agent skill covering both jobs the word "provider"
covers: configuring one of the five that ship, and authoring a new one. It carries the procedure
this page describes, the trap checklist, and the full registration list — which is longer than
[Wiring it in](#wiring-it-in) above suggests.
