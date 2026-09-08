# Write a compute Provider

*For contributors.*

A Provider is the only part of Rocky Surf that knows what a cloud is. Core knows how to boot a
box, install software on it, watch it, bill it and reap it; a Provider knows how to make one
exist.

This page is the **workflow**: what to build, in what order, and what has to be true before it
merges. The **type contract** lives in
[`packages/provider-sdk/README.md`](../packages/provider-sdk/README.md) and in the doc comments
on the types themselves, which carry the reasoning. Read that first; this page assumes it.

[ADR-0003](adr/0003-provider-sdk-shape-and-exclusions.md) freezes the shape. If your cloud
genuinely doesn't fit, amend the ADR in the same pull request rather than adding a special case
to core.

## What you build

A package that default-exports a `ProviderFactory`: an id, a display name, a config schema, and
a synchronous `createProvider(config)` that does no I/O. The Provider it creates implements
**nine methods** (plus the optional `syncSshAccess()`, ADR-0021) and declares five capabilities,
with three optional ones it declares only when true.

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
over protobuf. `google-auth-library@11.0.2` is **601,781 bytes**. Roughly 180 to 1. That Provider
declined the first and took the second, for Application Default Credentials only.

Apply the test in this order:

1. **Is the API fetch-shaped**, with documented REST and JSON bodies? Write the calls by hand.
   `@rockysurf/provider-hetzner` is 1,043 lines of non-test source against a documented REST
   API, and its entire HTTP transport is one 136-line file, `src/api.ts` (`wc -l`, 2026-08-13).
2. **Is some part of it not fetch-shaped**, such as a signed assertion flow, a credential chain
   with four sources, or a token cache with refresh semantics? Buy that part and only that part.
   GCP's ADC spans a service-account keyfile, a `gcloud` user refresh token, the GCE metadata
   server and workload identity federation. An RS256 assertion flow written by hand buys nothing
   and costs a class of bug you can't debug against somebody else's cloud.
3. **Whatever you take has to be contained.** `scripts/check-npx-closure.mjs` walks core's and
   the CLI's production closures against a `VENDOR_RULES` table, one row per vendor package, each
   `{ id, pattern, provider, label }`. It asserts that every rule's `pattern` is absent from
   core's closure and reaches the CLI only through its own `provider`. Add a row for your
   dependency, with fixture tests in `packages/core/src/npx-closure.test.ts` proving the check
   fails in both directions when it's broken. Core is loaded by every installation, including
   operators who will never call your cloud.

The saving isn't only disk. A generated client hides the API, and the GCE work found two things
one would have papered over. HTTP 200 means *accepted*, not *done*: every mutating call returns a
pending Operation, and the failure arrives in the body of a later poll, also HTTP 200. And GCE has
two separate error vocabularies, HTTP `reason` strings and SCREAMING_SNAKE Operation codes, both
of which have to be mapped. Writing the transport is what made them visible.

### Where a measured number belongs

Note the two preceding forms, because the difference decides where a figure belongs.

**A measurement of this repository lives in exactly one place, dated, and is re-measured rather
than quoted.** Never write one into the file it measures: it goes stale on the next edit,
including the edit that corrects it. `provider-hetzner`'s transport comment claimed "~600 lines"
against a real 1,036, propagated into two other documents before anyone counted, and the first
attempt to fix it in place was false the moment it was saved, because the correction itself added
lines (`rockysurf-z3uz`). That's why the line counts are here and not in `api.ts`.

**A measurement of an external artifact may be inlined, if you name the version.** npm tarballs
are immutable once published, so `@google-cloud/compute@7.1.0` is 110,039,229 bytes for good.
"Measured on 2026-08-13" is the weaker form: it doesn't say what `latest` pointed at, so it decays
on the next release. `@rockysurf/provider-gcp`'s `auth.ts` carries its comparison inline for this
reason.

## The nine methods

| Method | What to get right |
|---|---|
| `validateCredentials()` | Prove the credential, loudly, with the cheapest authenticated call the API offers — and prove the configured region too. This is where an unreachable host or a read-only token is reported, not later. Settings calls it whenever an enabled Provider's section is saved and prints the error you throw, verbatim, next to the section |
| `validateSpec(spec)` | Reject a spec the cloud will reject, before anything is created |
| `listOfferings()` | Machine types with prices. A price you don't know is `null` — the SDK defines that as *unknown, never free*, and `0` would render as free |
| `provision(spec)` | Create it. Return enough `ProviderData` to find it again |
| `describe(data)` | Current state. See the grace rule that follows |
| `terminate(data)` | Idempotent: not-found is success. Returning doesn't mean the resources are gone; expect `terminating` next |
| `listManaged()` | Everything you created, each tagged `server-owned` or `shared`. The reconciler deletes the first kind and never the second |
| `stop(data)` / `start(data)` | Required **even if you can't stop** |

Four of those have bitten someone already, which is why the SDK README calls them out as well:

1. **`describe()` maps absence to `terminated` only after a propagation grace.** Eventually
   consistent APIs report a just-created instance as missing. Believing that marks a healthy,
   billing instance dead and orphans it. `DESCRIBE_ABSENCE_GRACE` (4 attempts, 2s apart) is the
   floor. Lengthen it if your cloud needs it, and never skip it.
2. **`terminate()` is idempotent.** Reconcilers retry.
3. **`listManaged()` reports secondary resources**, correctly tagged. Hetzner's Provider owns the
   SSH Key objects it creates; AWS's shares one security group across every Server. Getting the
   tag wrong means either an orphan that bills forever or a reaper that deletes something another
   Server is using.
4. **`stop` and `start` exist even when unsupported.** Throw
   `unsupportedOperationError(this.id, 'stop')` and set `capabilities.stop = false`. Core branches
   on the capability flag and never on `typeof provider.stop === 'function'`, because two ways to
   ask the same question is how they drift apart.

## Capabilities

This object is the complete set of behavioural differences core is able to see. It isn't an
implementation detail: **there are zero `provider.id` conditionals in shared code, and tests
enforce that.** If core needs to do something differently for your cloud and no flag expresses it,
that's an ADR conversation, not a conditional.

```ts
const capabilities: ProviderCapabilities = {
  stop: true,                 // can it stop and restart with the disk intact?
  ipStableAcrossStop: false,  // does the public IP survive that?
  canInjectHostKeys: true,    // can the box come up presenting a host key core minted?
  userDataMaxBytes: 16384,    // hard ceiling on the rendered document, before transport encoding
  generatesUserData: true,    // does the provider deliver user-data at all?
  // Optional — absent means false. Declare one only when it is true of the cloud:
  //   managesSshAccess: true,    // a shared firewall object core pushes sshAllowedCidr at (ADR-0021)
  //   billsWhileStopped: true,   // a stopped machine bills at the running rate (ADR-0025)
  //   simulatedInstances: true,  // there is no reachable machine; core drives it in-process (E15)
}
```

`billsWhileStopped` is the one that decides money. With it, core's meter keeps running through
`stopped` and the Server page says so. It means the RUNNING rate: a cloud that charges a reduced
rate while stopped must not set it, and there's no capability for that case.

`simulatedInstances` says there's no reachable machine, so core drives the instance in-process
instead of over SSH. A Provider must not set it while returning addresses that resolve to real
hosts, because core takes it as permission to skip the SSH drive entirely.

The conformance suite checks one dependency between them: `canInjectHostKeys` requires
`generatesUserData`. With no user-data there's no way to place a key before first contact.

`canInjectHostKeys` is a **security posture**, not a feature toggle. `true` means there's no
trust-on-first-use window, and the first connection, the one carrying the secrets file, is
verified against a key core generated itself. If you set it `false`, say plainly in your
Provider's docs what the operator is trusting instead: which key is recorded, when it is
recorded, and what a later change to it does.

## Declare your settings

A Provider's config schema validates the file; it can't draw a Settings panel. The panel comes from
`factory.settings` ([ADR-0027](adr/0027-a-provider-declares-its-settings-and-the-page-is-built-from-them.md)),
a declaration beside the schema. Conformance holds the two together by parsing every declared
`example` through `configSchema`:

```ts
settings: {
  title: 'My Cloud',
  help: 'What this provider drives, and how it authenticates — one or two sentences.',
  fields: [
    { name: 'token', kind: 'secret', label: 'Token Environment Variable', example: 'MYCLOUD_TOKEN',
      help: 'The NAME of an environment variable holding a read/write API token — not the token itself.' },
    { name: 'region', kind: 'string', label: 'Region', example: 'nyc3', help: 'Which region new servers are created in.' },
    // The two-act SSH whitelist as ONE kind: the list is declared, `allowAllCidr` is implied and
    // drawn beside it. Declaring it requires `capabilities.managesSshAccess` (ADR-0021).
    { name: 'sshAllowedCidr', kind: 'sshCidrList', label: 'SSH allowed from', example: '203.0.113.7/32',
      help: 'Which networks may reach SSH on the boxes created here, as CIDRs.' },
  ],
  offering: { noun: 'droplet size', example: 's-2vcpu-4gb' },   // the saved-type fields speak this
  advisories: [
    { surface: 'create', text: 'A stopped droplet bills at the running rate; only terminating ends the charge.' },
  ],
}
```

The kinds are the controls a settings page draws honestly — `string`, `number`, `boolean`,
`secret`, `stringList`, `sshCidrList` — and nothing else; a shape outside them is edited in the
file. Don't declare `enabled`, `package` or `sizes`: those are the installation's, and every panel
gets them. Use `advisories` for what only the human needs to know, such as a quirk or a caveat.
Anything core has to COMPUTE with is a capability, never a sentence.

Two more knobs on `offering` are optional, and both are for Providers whose panel doesn't read
like a proper noun. Use `label` for how the Provider is named inside a sentence ("whenever you ask
*your own metal* for a small box") when that isn't the `title` over its panel. Set
`allowlist: false` when this Provider has no `sizes` allowlist at all, because its catalogue is
already the operator's own list. No shipped Provider sets either. A list's item fields may also
carry their own `help`; the list's sentence covers them all when they don't.

Every shipped Provider is a worked example. Hetzner (`packages/provider-hetzner/src/index.ts`) is
the token shape, and GCP, AWS and Azure are the firewall shape with no credential field at all.
No shipped Provider declares a `lists` entry today; the shape is there for a Provider whose
configuration is genuinely a repeated sub-object. No Provider rows remain in
`packages/core/src/settings/fields.ts` — it's core's own sections and nothing else — so a new
Provider adds none.

## Prices and currency

Prices ship **bundled and stamped with `fetchedAt`**; live pricing APIs are out of v0. There's one
documented exception, `@rockysurf/provider-hetzner`, and the reason it's allowed is narrow: Hetzner
returns prices inline on the exact `GET /server_types` call `listOfferings()` already makes, so
preferring a bundled number would mean showing a figure known to be staler than one already in
hand, having saved no request.

Quote the **currency your cloud bills in**, not USD. The spend cap compares per currency and
deliberately doesn't sum across them. A Hetzner project billed in EUR and an AWS account billed in
USD added together is a fiction.

## Conformance

`@rockysurf/provider-conformance` is the shared suite. It's test-only and never a runtime
dependency. Inside this workspace it resolves **from source** rather than through `dist/`, so a
Provider's tests never wait on it being built. The published tarball points at `dist/` instead,
which is a `publishConfig` override and the one place a tarball manifest differs from the one in
the repository. Out of tree, run `npm install --save-dev @rockysurf/provider-conformance`, or
install a tarball from `pnpm pack` if the package isn't on the registry.

```ts
import { assertProviderShape, assertFactoryShape, assertOfferingsShape } from '@rockysurf/provider-conformance'
```

It checks the mechanical contract: the id is lowercase and non-empty, all nine methods exist, the
five capability fields have the right types and the optional ones are booleans when declared,
`canInjectHostKeys` implies `generatesUserData`, `managesSshAccess` and `syncSshAccess()` agree,
offerings and managed-resource records have the right shape, errors are `ProviderError`s with a
valid code, and `createProvider` does no I/O.

It also carries the absence-grace probe, which is how the `describe()` grace rule gets asserted
rather than assumed, and `assertProvisionNameFromServerId(spec, sent)`, which takes the requests
your fake captured and holds you to naming the cloud's instance for `spec.serverId` rather than for
the human's `spec.name` (issue #409: a display name with a space in it is refused by the cloud, and
only live).

Passing conformance is necessary and not sufficient. It can't know whether your cloud actually does
what you said it does.

## Wire it in

Add one row in `packages/rockysurf/src/compose.ts`, the composition root and the only file in the
repository allowed to import both core and a Provider:

```ts
{
  factory: myProviderFactory,
  section: (config) => config.providers.mycloud,
  credentialField: 'token',              // or null if it needs no credential
  input: ({ enabled: _enabled, ...rest }, credential) => ({ ...rest, ...(credential ? { token: credential } : {}) }),
  credentialHint: 'providers.mycloud.token, or MYCLOUD_TOKEN',
}
```

That row encodes three things:

- **`enabled` is stripped.** It's core's field — orchestration, not Provider configuration — and
  every Provider schema is a `strictObject`, so passing it through is rejected outright. That
  rejection is the boundary doing its job.
- **Credentials resolve config-first, then the environment** (issue #280). A credential written in
  the config file is the one an operator can see, diff and roll back, so it wins. With the field
  empty, `PROVIDER_CREDENTIAL_ENV` names the variables the composition root reads directly, which
  is the path the first-run wizard steers a token cloud to. Nothing is ever stored: "Rocky Surf
  stores no cloud credentials" is unconditional.
- **Composition runs again when the config file changes** (issue #264). Providers are still
  constructed all at once, from one config, and the registry every route holds takes the new set in
  place, so an operator who fixes a region or switches a cloud on gets working clients without a
  restart. Nothing on a Provider is closed when it's replaced: the SDK deliberately gives a
  Provider no lifecycle, and a client still inside an in-flight call keeps serving that call to the
  end. A credential arriving through an environment variable is the exception, because a variable
  can't appear inside a running process. It takes effect at the **next restart**, which is when
  composition sees it.

A Provider that's enabled but can't be built is **reported and skipped**, never fatal. The control
plane still starts, because the UI is where an operator fixes it.

## The package README

Your `README.md` is in the `files` allowlist in `package.json`, so it's the page npm shows and the
first thing a stranger reads about your Provider. Write it for the operator deciding whether this
Provider gives them what they need, not for the person maintaining it. Development commands, design
history and issue ids belong in this repository, not on the package page.

Every shipped Provider uses the same section order, so an operator comparing two clouds can compare
two documents:

| Section | What belongs in it |
|---|---|
| Title and one paragraph | Which cloud, what the Provider talks to it with, and what it won't do |
| **How you get it** | Providers in this repository ship inside the `rockysurf` CLI and are switched on in configuration; an out-of-tree Provider says how it's installed and registered instead |
| **Configuration** | The YAML an operator can paste, then every field with its default. Take both from your own `config.ts` — that schema is what actually parses the section |
| **Credentials** | Where the credential comes from and where it isn't kept. A token named in the config file is written `${VAR}`, an environment reference rather than a literal |
| **What it needs in your account** | Permissions, network prerequisites, host preparation. Link the IaC when the repository ships some |
| **Capabilities** | The five `ProviderCapabilities` values and what each one costs the operator |
| **Prices** | Live, bundled with a `fetchedAt`, or `null`. Say which, and say the currency |
| **Verified** | What has been run against real infrastructure, and when |
| **Writing your own Provider** | One line pointing at the SDK README and this page |

Drop a section your Provider has nothing true to put in; don't reorder the ones you keep.

Two of them carry rules rather than conventions.

**Copy capabilities, don't summarise them.** Print the same five values the source declares, and
check them against your `ProviderCapabilities` constant when you edit either. A README that
disagrees with the constant is worse than one that omits the section: core branches on the
constant, so the reader is being told the wrong thing about how their Servers will behave.

**A verification section states what has been run and nothing more.** Name the machine type, the
region, the date and where the evidence lives. If a nightly job re-runs it, say so, because a
lifecycle proved once is a lifecycle that was true once. A Provider whose values are mostly still
inferences says exactly that:
[`@rockysurf/provider-digitalocean`](../packages/provider-digitalocean/README.md#verified) is the
worked example — it names the three calls a token has actually met, with dates, and states in its
first sentence that the rest have not — and the status block in
[`docs/providers/aws.md`](providers/aws.md#the-iam-policy) is the model for a Provider that has
been run end to end.

## Before it merges

- [ ] Nine methods implemented; `stop` and `start` throw rather than being absent if unsupported.
- [ ] `factory.settings` declared, so the Provider has a Settings panel; `credentialField` and
      `credentialEnv` declared if it takes a token.
- [ ] Conformance suite passes (it checks the declaration against the schema).
- [ ] A column in [`docs/providers/capability-matrix.md`](providers/capability-matrix.md), filled
      in **in the same pull request**, with a note on how each value was established. A value
      nobody has exercised must say so, the way the `digitalocean` column does.
- [ ] A package `README.md` in the preceding section order, with its capability values matching the
      source and its verification section claiming only what has been run.
- [ ] A page under `docs/providers/` if the Provider has operator-facing consequences worth
      stating: what claiming a host does to it, what a minimal IAM policy looks like, what
      `terminate` deliberately doesn't do.
- [ ] `pnpm run check` green, including the dependency lint.
- [ ] Know which kind of verification your Provider gets. **A nightly real-cloud leg is for
      OFFICIAL Providers**, the ones composed into `packages/rockysurf/src/compose.ts`. A
      **personal Provider gets none**: it ships a fully daggered column, verified by its author and
      by whoever installs it against their own account, the way the `digitalocean` column reads.
      Don't file a nightly leg for one, and don't promise a nightly in its README.
- [ ] If your package pulls in a vendor SDK, confirm it didn't land in the `npx` install closure
      (`scripts/check-npx-closure.mjs`), and that you took it for the reason
      [Vendor SDKs](#vendor-sdks) allows. Core's cold start is a feature.

## Out of tree: a personal Provider

Nothing here requires your Provider to live in this repository, and since
[ADR-0026](adr/0026-a-personal-provider-is-a-package-named-in-the-config-file.md) nothing requires
a fork to run it either. `@rockysurf/provider-sdk` is published precisely so a Provider doesn't
have to be here: depend on it, implement the factory, publish or build the package, and an operator
names it in their config file.

```yaml
providers:
  mycloud:
    package: "@you/rockysurf-provider-mycloud"   # installed under <dataDir>/providers, or a path
    enabled: true
    token: "${MYCLOUD_TOKEN}"
```

Rocky Surf loads it at start, composes it beside the shipped five, and gives it a Settings panel
with its Enabled switch.

> **Warning:** A Provider runs with Rocky Surf's full access. Install ones you trust. That's the
> whole trust model, and your README should say it too.

**The worked example is `packages/provider-digitalocean`** (issue #368): a complete Provider that
lives in this repository, is built and tested by CI, and is deliberately not wired into
`compose.ts`. It's installed the way any personal Provider is. Read it rather than starting from a
blank file.

**Nobody here will verify it for you.** The nightly real-cloud workflow drives the official
Providers, the ones composed into `packages/rockysurf/src/compose.ts`. A personal Provider ships a
fully daggered capability column and is verified by its author and by whoever installs it, against
their own cloud account. The `digitalocean` column is the model for what that looks like written
down — it is the column of the Provider named just above, and every dagger still standing in it is
a value nobody has run yet.
Record what you ran, on what date, against which region: that record is the evidence, and it's the
only thing that takes a dagger off. (Owner ruling, 2026-09-05.)

The cheap half of that verification is the live dry run in the `add-provider` skill
([`.agents/skills/add-provider/references/dry-run.md`](../.agents/skills/add-provider/references/dry-run.md)):
`provision()` against the real account under an intercepted `fetch`, every write refused unless
allowed and the instance create refused by name, every request logged with the cloud's answer. It
exists because the first personal Provider passed its whole unit suite and failed on its first real
create, on a precondition the fake didn't model (#405). Run it before publishing. The fake it sits
behind must start empty and refuse references to objects nobody created, with one test that
provisions the whole chain from nothing (the skill's `scaffold.md`).

Five things a personal package has to get right that an in-tree one gets for free:

- **The default export is the factory**, and `factory.id` equals the config key the operator will
  use. A mismatch is reported as "rename the section to providers.<id>".
- **Your manifest's entry must resolve.** Use `exports` (import-only is fine, and every shipped
  Provider is import-only), `module`, or `main`. Rocky Surf reads your manifest rather than asking
  `require` to resolve you.
- **Credentials.** Declare `credentialField` (the config key your schema expects, such as
  `'token'`) and `credentialEnv` (the variables it may arrive under) on the factory. A value in the
  config file wins; with the field empty, the composition root reads the first non-empty variable
  and hands it to your schema under that field. Nothing is stored. A chain-auth cloud declares
  neither, or `credentialEnv` alone for the wizard's detection.
- **Errors are `ProviderError`s from YOUR copy of the SDK**, which is a different class from the
  one core imported. Core's `isProviderError` is structural — the name and one of the nine codes —
  so this works. Don't rely on `instanceof` across the boundary in your own code either.
- **Prefer a package that installs with no package manager.** An operator who runs `npm install` in
  `<dataDir>/providers` gets your dependencies resolved for them. An installer that only extracts a
  tarball, which is the shape a Provider shop takes, doesn't, and it refuses an install whose
  manifest names a dependency it can't resolve. `@rockysurf/provider-digitalocean` declares **no
  runtime dependencies at all**: its config schema is hand-written rather than zod (the SDK's
  `ConfigSchema<T>` is structurally `{ parse }` precisely so that's allowed), and
  `scripts/build-bundled-package.mjs` bundles the SDK's runtime helpers into its `dist/` with the
  SDK kept as a devDependency. That's safe to do because the SDK has no runtime dependencies of its
  own and no export whose meaning depends on object identity.

The SDK has **zero runtime dependencies**, which is deliberate, because anything it depended on
would be inherited by every Provider and every consumer. It also has no export whose meaning
depends on object identity, for the reason just given.

`@rockysurf/provider-conformance` is published for the same reason, so the preceding acceptance bar
is one you can actually run rather than one you have to take on trust. It depends only on the SDK.

A personal Provider doesn't get a Settings panel for its **own** fields until it declares them.
Until then they're edited in the file, and the panel says so. The operator-facing side is in
[`docs/self-hosting.md`, "Personal Providers"](self-hosting.md#personal-providers).

## Publish to the shop

A personal Provider that would help other people can be listed in a Rocky Surf registry, the same
`amroja-biz/rockysurf-shop` that distributes Surge Packs
([ADR-0028](adr/0028-providers-are-distributed-through-the-shop.md), amended by issues #394
and #426). What you publish is an **npm-style tarball** plus a **listing entry** that points
at it.

**`.agents/skills/contribute-provider/` does all of this**, and it's the shorter route. It packs,
checks the tarball carries `dist/` and resolves nothing at install, releases it under a tag that
stays true in a monorepo (`provider-<id>-v<version>`), downloads the asset back to compare the
digest, generates the entry, and opens the pull request on the registry with its one check green.
It refuses to open one on a package with runtime dependencies or a digest that doesn't match the
released asset. The rest of this section is the same procedure written for a person.

**Rocky Surf fetches that listing.** An operator opens the Rocky Surf Shop tab, reads your entry,
and presses Install. Rocky Surf fetches the tarball over https, checks the digest, unpacks it under
`<dataDir>/providers`, writes the two config lines, and says a restart is needed. Nothing from your
package runs until that restart, when the loader imports it and the Settings page draws its panel.
The command-line install in [`docs/self-hosting.md`,
"Personal Providers"](self-hosting.md#personal-providers) does the same steps by hand and remains
the alternative. Either way, everything that follows about keeping the entry accurate is about what
the installer, or a person, will do with it.

### Make the artifact self-contained

**Rocky Surf never runs npm.** The installer fetches your tarball, verifies it, unpacks it under
`<dataDir>/providers` and stops. There's no `npm install`, no lifecycle scripts, and nothing from
your package executed at any point. Your code first runs when the operator restarts and the loader
imports it.

The consequence is a hard requirement: **nothing may be left for a package manager to resolve.**
The installer reads your manifest's `dependencies` and refuses the install, naming them, if there
are any at all (issue #426). It refuses them not only when one is missing, because a copy that
happens to be under `<dataDir>/providers` today is one that breaks when it's removed by hand.

This is the fifth item in the preceding list, and `@rockysurf/provider-digitalocean` is the worked
example of satisfying it: no runtime dependencies at all, a hand-written config schema rather than
zod, and `scripts/build-bundled-package.mjs` compiling the SDK's runtime helpers into its `dist/`
with the SDK kept as a devDependency. Copy that shape. `devDependencies` are irrelevant here,
because they aren't in the published manifest's `dependencies` and aren't checked.

### Produce the tarball

```bash
pnpm -C packages/provider-mycloud build          # or npm run build
pnpm -C packages/provider-mycloud pack           # writes you-rockysurf-provider-mycloud-1.0.0.tgz
```

You don't need to hash it yourself. The command in [The listing entry](#the-listing-entry) digests
the file it reads, which is the only digest worth publishing.

`pnpm pack` and `npm pack` produce exactly the archive the installer expects and an operator
unpacks by hand: gzipped, ustar, every member under `package/`, which is what
`--strip-components=1` assumes. Check what came out before you publish it, with `tar -tzf <file>`,
and confirm the file your `exports` point at is in the list. A tarball carrying a manifest and no
`dist/` is the most common way a publish goes wrong, and the installer refuses it with "is the
package built?" rather than installing something that can't load.

Then host it somewhere reachable over **https**: an npm registry's tarball URL, a GitHub release
asset, or any static host. The listing format and the installer both refuse `http`.

### The listing entry

Send a pull request to the registry adding one object to its `providers.json`. **Don't type that
object.** It has nine fields, and only two of them are facts your artifact doesn't already hold, so
`@rockysurf/provider-sdk` puts a command on your path that reads the other seven out of the tarball
you just packed:

```bash
npx rockysurf-shop-entry you-rockysurf-provider-mycloud-1.0.0.tgz \
  --tarball-url https://github.com/you/mycloud/releases/download/v1.0.0/you-rockysurf-provider-mycloud-1.0.0.tgz \
  --description "MyCloud compute, one API token, four regions."
```

It prints the entry to stdout and nothing else, so it pipes into `pbcopy`, into `jq`, or straight
into your editor. The output is similar to the following:

```json
{
  "providerId": "mycloud",
  "name": "MyCloud",
  "description": "MyCloud compute, one API token, four regions.",
  "version": "1.0.0",
  "package": "@you/rockysurf-provider-mycloud",
  "tarball": "https://github.com/you/mycloud/releases/download/v1.0.0/you-rockysurf-provider-mycloud-1.0.0.tgz",
  "sha256": "227011c38b5a4033cfafbf7797692d763ba81c25ef5e6141f90d03705236723d",
  "settings": [
    { "name": "token", "label": "API token variable", "kind": "secret" },
    { "name": "region", "label": "Region", "kind": "string" }
  ],
  "capabilities": {
    "stop": true,
    "ipStableAcrossStop": false,
    "canInjectHostKeys": false,
    "generatesUserData": false,
    "userDataMaxBytes": 0,
    "managesSshAccess": true,
    "billsWhileStopped": true
  }
}
```

It also refuses two things here rather than letting the registry's CI find them: a package whose
manifest declares runtime `dependencies`, naming them, and a `--tarball-url` that isn't https.

Where each value came from, because you're still the one signing the pull request:

| Field | Read from |
|---|---|
| `providerId` | `factory.id`. It's also the config section key the operator ends up with, so it's what your `package:` line will sit under |
| `name` | `settings.title`, the heading over these very fields once the Provider is installed; `displayName` when nothing is declared |
| `description` | **You**, on the command line. The one line a person reads before installing |
| `version` | Your manifest's `version` |
| `package` | Your manifest's `name`. It's what the operator writes on the `package:` line |
| `tarball` | **You**, on the command line. https only |
| `sha256` | The digest of the bytes it just read — the file you're about to host, not a file like it |
| `settings` | Your declared fields, in declared order, reduced to name, label and kind. It's a summary, so an operator can decide before installing; the real panel is built from the declaration that arrives with the package (ADR-0027) |
| `capabilities` | The Provider `createProvider()` returns, constructed from your declared fields' own `example` values. This is where an operator learns that a stopped machine still bills before they install, rather than after |

Two of those are worth saying out loud. **The command reads the settings summary and the capability
struct out of the artifact rather than transcribing them**, so they can't drift from the package the
way a hand-copied one silently does. Re-running the command after a change is the whole of keeping
the entry current. And **the digest is of the artifact the command read**: pack, generate, then
upload that same file.

There's deliberately **no trust or tier field**, and the format refuses one. Every listing already
carries, from Rocky Surf rather than from the registry, the sentence this document opened with: *a
Provider runs with Rocky Surf's full access, so install ones you trust.* Nothing you write can
soften it, and nothing you write has to repeat it.

### Publish a new version

Bump the version, build, pack, host, and **re-run `rockysurf-shop-entry` on the new tarball**. The
entry is regenerated rather than edited, so the version, the digest, the settings summary and the
capabilities all move together.

An operator's Update button on the Rocky Surf Shop tab re-fetches and **replaces** the installed
package, so a file you dropped between versions is genuinely gone. An operator updating by hand
unpacks the new tarball over the installed directory, where nothing deletes the old file for them,
so say in your release notes if a file has moved.

Keep the `sha256` in step with the artifact. A mismatch is refused with both values named, and a
stale one turns a good release into a refused one.

## Skills that walk through this

`.agents/skills/add-provider/` is an agent skill covering both jobs the word "provider" covers:
configuring one of the five that ship, and authoring a new one. It carries the procedure this page
describes, the trap checklist, and the full registration list, which is longer than
[Wire it in](#wire-it-in) suggests.

`.agents/skills/contribute-provider/` picks up where it ends: a Provider that builds and passes
conformance, through the release and the digest round trip, to a pull request on the shop.
