# Conformance, docs, the shop listing, IaC, and amending the ADR

## Running conformance

```sh
npm install --save-dev @rockysurf/provider-conformance
```

In the published set, so this is the out-of-tree route too. **Before the first release nothing is on
the registry yet** and that command 404s — until then, `pnpm pack` in `packages/provider-sdk` and
`packages/provider-conformance` from a checkout and install the two tarballs, which are the same
artifacts the release publishes.

It depends only on `@rockysurf/provider-sdk` and is test-framework-free — the assertions take values
and throw `ConformanceError`, so they run under vitest, under `node:test`, or from a plain
verification script.

`assertFactoryShape` ends by calling `assertProviderShape`, so calling both is redundant; call
`assertProviderShape` directly only when you have a provider without a factory to hand. **The same
goes for `assertSettingsShape`**: `assertFactoryShape` runs it for you whenever the factory carries
a declaration, so calling it as well is a duplicated assertion rather than a second check. Call it
directly only to assert a declaration you built somewhere other than on the factory.

| export | asserts |
|---|---|
| `assertFactoryShape(factory, validConfig)` | the factory's identity and schema; that `createProvider()` does no I/O and returns a matching id; `credentialField`/`credentialEnv` well-formed when present; then the whole provider shape, and the settings declaration when present |
| `assertProviderShape(provider)` | id lowercase and non-empty, all nine methods present, the five required capability fields well-typed and the optional ones booleans when declared, `canInjectHostKeys` implies `generatesUserData`, `managesSshAccess` and `syncSshAccess()` agree in both directions |
| `assertSettingsShape(factory, validConfig)` | the declaration (ADR-0027): every `help` a sentence, kinds valid, `reason` behind `writable: false`, the reserved names (`enabled`, `package`, `sizes`) refused, every `example` parsed through `configSchema`, and an `sshCidrList` only on a provider that declares `managesSshAccess` |
| `assertOfferingsShape(offerings)` | positive cpu/memory, known architecture, non-empty region, and prices either `null` or a finite non-negative amount with an ISO 4217 currency and ISO 8601 `fetchedAt` |
| `assertManagedShape(resources)` | non-empty `kind`, string native id, `ownership` from the frozen set |
| `assertProviderErrorShape(err)` | a `ProviderError` with one of the nine frozen codes and a derived boolean `retryable` |
| `assertProvisionNameFromServerId(spec, sent)` | the cloud-side name came from `spec.serverId` and the human's `spec.name` reached no request. `sent` is whatever your fake captured — bodies, paths, query strings; pass the spec a display name with a space in it or the check refuses to run |
| `assertInstanceStateValid(state)` | the state is in the frozen set |
| `assertDescribeAbsenceGrace(harness)` | the absence grace, behaviourally |

### The absence-grace harness

The only check that asserts behaviour, and the one worth wiring carefully. Behaviour cannot be
asserted from the interface alone — it needs your read path stubbed, and only your tests know how.
So you supply the seam.

**The two probes are not symmetrical, and writing them as if they were is the mistake to avoid.**
`neverSeenRunning` hands `describe()` a fresh instance. `goneAfterRunning` must hand it an instance
the provider has **already observed running** — which means calling `describe()` once to establish
that, *then* resetting the read counter, so that reads are counted from the moment it went absent
rather than from the observation that made it `running`.

`DescribeRead` is `'absent' | 'running'` — the only two answers the grace turns on.

**The fake needs two counters, not one.** `reads` is public and the harness resets it; the script
cursor must be separate and private. Sharing one counter means the reset in `goneAfterRunning`
*rewinds the script*, the next `describe()` re-reads `'running'`, and the third assertion fails with
"an instance seen running and now absent must be 'terminated', got 'running'". That is the most
likely way to fail this check, and it looks like a provider bug when it is a fixture bug.

```ts
import { assertDescribeAbsenceGrace, type AbsenceGraceProbe, type DescribeRead } from '@rockysurf/provider-conformance'

const HANDLE = { instanceId: 'i-1' }

/** Answers `script` in order, then repeats the LAST entry forever. */
class FakeApi {
  /** Public: what the harness counts, and what it resets. */
  reads = 0
  /** Private: where we are in the script. NOT reset when `reads` is. */
  #cursor = 0

  constructor(private readonly script: readonly DescribeRead[]) {}

  async getServer(_id: string): Promise<{ status: string } | undefined> {
    const answer = this.script[Math.min(this.#cursor, this.script.length - 1)]
    this.#cursor++
    this.reads++
    return answer === 'running' ? { status: 'RUNNING' } : undefined
  }
}

function scripted(script: readonly DescribeRead[]) {
  const api = new FakeApi(script)
  const provider = makeMycloudProvider(validConfig, { api, grace: { attempts: 4, delayMs: 0 } })
  return { api, provider }
}

await assertDescribeAbsenceGrace({
  provider: 'mycloud',
  // What the provider under test was BUILT with — tests usually shorten delayMs, not attempts.
  grace: { attempts: 4 },

  neverSeenRunning: (script): AbsenceGraceProbe => {
    const { api, provider } = scripted(script)
    return { run: async () => ({ view: await provider.describe(HANDLE), reads: api.reads }) }
  },

  goneAfterRunning: async (): Promise<AbsenceGraceProbe> => {
    const { api, provider } = scripted(['running', 'absent'])
    await provider.describe(HANDLE)   // the observation that makes it "seen running"
    // Count from the moment it went absent, not before. This resets `reads` ONLY — the script
    // cursor keeps its place, which is why the two are separate counters.
    api.reads = 0
    return { run: async () => ({ view: await provider.describe(HANDLE), reads: api.reads }) }
  },
})
```

Both callbacks may return a promise, which is what makes that priming call possible. The
`await` above belongs inside an `it()`, like any other assertion.

Each probe's `run()` calls `describe()` **once** and returns both the `InstanceView` and **how many
reads of the underlying API it spent**. The read count is the point: honouring the grace and
skipping it produce the same state whenever the instance really is gone, and differ only in how
hard the provider looked. One read means one call to your read path — the create call inside
`provision()` is not part of it.

Zeroing the delay in tests changes what the suite costs, never what it proves; only `attempts` is
asserted. A provider may lengthen the grace and may never shorten it below
`DESCRIBE_ABSENCE_GRACE` — nothing enforces that for you, so enforce it in your own constructor
(see the seam in [types.md](types.md)).

**Passing is necessary and not sufficient.** It checks the mechanical contract and one behavioural
rule. It cannot know whether the cloud does what you said it does.

## The capability matrix column *(in tree)*

`docs/providers/capability-matrix.md`, filled in **in the same pull request**. One column per
provider, with a note on how each value was established.

Out of tree there is no shared matrix to join, but the honesty rule below is the transferable part —
state it in your README's Capabilities section instead.

The convention that makes the table worth reading: **a value nobody has exercised must say so.**
Measured and reasoned values are marked differently — the existing table daggers the individual
values that are inferences from vendor documentation rather than observations, per value rather
than per column, because the undaggered entries are structural and safe to state either way. Two
columns are currently daggered, each naming the owner-gated bead that would settle it.

Do not claim `measured` for a value a test asserts against a fake. A fake asserts that the provider
does what its author believed; only real infrastructure asserts that the belief was right.

## The package README

Your `README.md` is in the `files` allowlist, so it is the page npm shows and the first thing a
stranger reads. Write it for the **operator deciding whether this provider gives them what they
need**, not for the person maintaining it. Development commands, design history and issue ids
belong in the repository, not on the package page.

Every shipped provider uses the same section order, so an operator comparing two clouds can compare
two documents:

| section | what belongs in it |
|---|---|
| title and one paragraph | which cloud, what the provider talks to it with, and what it will not do |
| **How you get it** | in-tree providers ship inside the `rockysurf` CLI and are switched on in configuration; an out-of-tree provider says how it is installed and registered instead |
| **Configuration** | the YAML an operator can paste, then every field with its default. Take both from your own `config.ts` — that schema is what actually parses the section |
| **Credentials** | where the credential comes from and where it is not kept. A token named in the config file is written `${VAR}` |
| **What it needs in your account** | permissions, network prerequisites, host preparation. Link the IaC |
| **Capabilities** | every value the constant declares — the five required and any optional one that is true — and what each costs the operator; a stopped machine that still bills belongs here AND in an advisory |
| **Prices** | live, bundled with a `fetchedAt`, or `null`. Say which, and say the currency |
| **Verified** | what has been run against real infrastructure, and when — the live dry run (`dry-run.md`) with its date and region, and separately any real lifecycle |
| **Writing your own provider** | one line pointing at the SDK README and the standard |

Drop a section with nothing true to put in it; do not reorder the ones you keep.

Two carry rules rather than conventions:

**Capabilities are copied, not summarised.** Print the same values the source declares — the five
required, and every optional one you set — and check them against the `ProviderCapabilities`
constant when you edit either. **And carry the trust sentence** for a personal provider, verbatim:
*a provider runs with Rocky Surf's full access — install ones you trust.* A README that disagrees
with the constant is worse than one that omits the section — core branches on the constant, so the
reader is being told the wrong thing about how their servers will behave.

**A verification section states what has been run and nothing more.** Name the machine type, the
region, the date and where the evidence lives; if a nightly job re-runs it, say so, because a
lifecycle proved once is a lifecycle that was true once. A provider nobody has pointed at real
hardware says exactly that, in those words — `packages/provider-digitalocean`'s status section is
the worked example, in a checkout.

## Listing it in the shop *(personal and community providers)*

**There is a skill for the whole of this: [`contribute-provider`](../../contribute-provider/SKILL.md).**
It follows the shop's `CONTRIBUTING.md` walkthrough step for step — pack, check the tarball,
release it under a tag that stays true in a monorepo, download the asset back and compare the
digest, generate the entry, fork, validate, open the pull request, watch its one check — and it
refuses to open a pull request on a package with runtime dependencies or a digest that does not
match the released asset. Hand off to it once the provider builds and passes conformance. The rest
of this section is what it does at the entry step, kept here because it is also what you need if
you are doing it by hand.

The shop is the repository `amroja-biz/rockysurf-shop`. Listing a provider there is one object
added to its `providers.json` in a pull request. **Do not compose that object.** Nine fields, and
seven of them are already inside the artifact — transcribing a settings summary and a capability
struct by hand is how a listing comes to describe a package that no longer looks like that.

Pack, then run the bin the SDK ships:

```sh
npm pack                        # or pnpm pack — writes <name>-<version>.tgz
npx rockysurf-shop-entry <name>-<version>.tgz \
  --tarball-url https://…/<name>-<version>.tgz \
  --description "<one line>"
```

Print exactly what it gives you. **The two values the author must supply are the two options** —
mark them when you show the output:

```json
{
  "providerId": "mycloud",
  "name": "MyCloud",
  "description": "…",          ← you wrote this, on the command line
  "version": "1.0.0",
  "package": "@you/rockysurf-provider-mycloud",
  "tarball": "https://…",      ← you wrote this, on the command line
  "sha256": "…",
  "settings": [ … ],
  "capabilities": { … }
}
```

Everything else was read: `providerId` from `factory.id`, `name` from `settings.title` (falling
back to `displayName`), `version` and `package` from the manifest, `settings` from the declared
fields in declared order, `capabilities` from the provider `createProvider()` returns, and
`sha256` from the bytes of the file named on the command line. Re-run it after any change rather
than editing the entry — that is the whole of keeping a listing in step with its package.

**Where it goes:** open a pull request on `amroja-biz/rockysurf-shop` adding the object to the
`providers` array of `providers.json`, and bump that file's `generatedAt`. The shop's
`provider listing` workflow validates the file and downloads the tarball to compare its digest,
so a URL that is not yet live, or bytes that are not the ones you generated from, fails there.
Its `CONTRIBUTING.md` is the contract; read it, because it is the shop's to change.

Two refusals happen before the pull request, which is the point of running this rather than typing
it: **a package whose manifest declares runtime `dependencies`** is refused with them named — a
provider is installed by unpacking a tarball and nothing resolves a dependency for it — and **a
`--tarball-url` that is not https** is refused, because a provider artifact is code.

Before the first SDK release the command is not on the registry: `pnpm pack` in
`packages/provider-sdk` from a checkout and install that tarball, the same artifact the release
publishes.

## Least-privilege IaC *(in tree)*

`deploy/{aws,gcp,azure}` ship infrastructure-as-code for a least-privilege role, and the pages
under `docs/providers/` document the minimal policy. A new provider whose cloud has a role model
should ship the same.

The pattern worth copying is not the IaC itself but the check beside it: `scripts/check-iam-policy.mjs`,
`check-azure-role.mjs` and `check-gcp-role.mjs` run in `pnpm run lint` and assert that the published
role stays in step with the calls the provider actually makes. A least-privilege policy with no
check drifts into either a broken deploy or a policy quietly wider than it claims.

Grant at the narrowest scope the cloud allows, and do not create the scope for the operator when
the role has to be attached to it — Azure's resource group is created by the operator first,
because a role cannot be scoped to a group that does not exist yet.

## Amending ADR-0003

The SDK shape is frozen. If the cloud genuinely does not fit, that is an **amendment in the same
pull request**, not a special case in core and not a `provider.id` conditional.

The bar is high and it has been cleared eight times (E12–E19, in the ADR — read them if you have a
checkout; E17 is `billsWhileStopped`, the one a cloud like DigitalOcean forced). The shape is
consistent, and the six bullets below are that shape. **The alternative to an amendment is never an
approximation** — a capability set to the nearest available answer passes conformance and lies.

An amendment that will be accepted looks like this:

- **Dated, and attributed to the bead that produced it.**
- **Additive and optional.** Every accepted amendment so far adds a field whose absence means the
  old behaviour, so no existing provider package changed. An amendment that requires edits to
  shipped providers is a much harder argument.
- **It says why a capability or field rather than a conditional.** The struct's own doc comment
  prescribes the answer: *"If core needs to know something a flag here cannot tell it, the answer
  is a new flag, not a special case."* Core is not permitted to learn behaviour from a provider id
  — that is the property the ADR exists to protect.
- **It states what it deliberately does not do.** Every one of E12–E16 carries this section, and it
  is what stops a narrow field becoming a general escape hatch. E15 spends three numbered points on
  it.
- **It names the rejected alternative and why**, including alternatives with better fidelity that
  were rejected for consequences rather than for cost.
- **It states any MUST NOT for providers.** A flag that core takes as permission to skip a safety
  step needs the misuse spelled out.

Before writing one, check the amendment is actually needed: the eight capability fields, `unknown` as
an instance state, `null` as an unknown price, `Offering.available` per offering, and
`ProviderError`'s frozen codes already absorb most of what looks at first like a shape problem. The
research protocol's table says where each answer lands; an answer with no row is the one to file.
