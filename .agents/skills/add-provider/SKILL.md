---
name: add-provider
description: Add a cloud to Rocky Surf, or configure one it already supports. Use when the user wants to switch on or configure a provider (AWS, Azure, GCP, Hetzner, BYO) — credentials, region, sshAllowedCidr, the setup wizard, the Settings page — or wants to add support for a cloud Rocky Surf does not have yet by writing a new provider package against @rockysurf/provider-sdk, either as a personal provider installed into their own Rocky Surf or as one shipped in the repository. Triggers on "add a provider", "configure AWS/Azure/GCP/Hetzner", "add DigitalOcean/Vultr/Linode/OVH support", "write a compute provider", "new provider package", "personal provider", "provider credentials", "sshAllowedCidr", "my provider isn't showing up", "provider conformance".
---

# Rocky Surf providers

A provider is the only part of Rocky Surf that knows what a cloud is. Core knows how to boot a
box, install software on it, watch it, bill it and reap it; a provider knows how to make one
exist.

Two different jobs share that word. Ask which one this is before doing anything:

| the user wants | mode | go to |
|---|---|---|
| to switch on or adjust a cloud Rocky Surf already ships — AWS, Azure, GCP, Hetzner, BYO | **Configure** | [references/configuring.md](references/configuring.md) |
| to add a cloud Rocky Surf does not support — DigitalOcean, Vultr, OVH, an internal API | **Author** | the arc below |

## Prerequisites

What has to be on **the user's own computer**. Check what the chosen mode needs, and if something is
missing, tell the user which tool and where it comes from — **do not install it for them**.

| Tool | Why this skill needs it | Check |
|---|---|---|
| Node.js 24+, with npm | a provider is a Node package; `engines.node` is `>=24`, and `npm` is how `@rockysurf/provider-sdk` and `@rockysurf/provider-conformance` reach it | `node --version` |
| Git and pnpm | in-tree work only: `pnpm install && pnpm -r build`, `pnpm run check`, `pnpm pack`. A personal provider needs neither | `git --version`, `pnpm --version` |
| A cloud CLI (`az`, `gcloud`) | only on the Configure routes that use one — `az login`, `az group create`, `gcloud auth application-default login`. Every cloud also has a route that needs no CLI | `az version`, `gcloud version` |

Docker is not needed: conformance is unit tests. `tsc` and `vitest` are devDependencies of the
package, not programs to install onto the machine.
[references/prerequisites.md](references/prerequisites.md) has the install pages for macOS and
Ubuntu, the credential routes that avoid a CLI entirely, and what to say when one is missing.

If the request is ambiguous ("add a provider" often is), the deciding question is whether the
cloud is one of the five already shipped. If it is, they want Configure — writing a package for a
cloud that already has one is nobody's intent. Ask rather than guess when it is a cloud you do not
recognise; some clouds are API-compatible with one already supported, which makes it a Configure
job with a different endpoint rather than a new package.

---

# Authoring a new provider

**The type contract travels with the package.** After installing `@rockysurf/provider-sdk`, the SDK
README is at `node_modules/@rockysurf/provider-sdk/README.md` and the fully commented type
definitions are at `node_modules/@rockysurf/provider-sdk/dist/*.d.ts`. Read them — they are
authoritative, and you have them whether or not you have a checkout of the repository.
[references/types.md](references/types.md) in this skill is the field lists and signatures in one
place, which is what you need to actually write the code.

In a checkout, the workflow standard is
[`docs/writing-a-provider.md`](../../../docs/writing-a-provider.md) and the frozen shape is
[ADR-0003](../../../docs/adr/0003-provider-sdk-shape-and-exclusions.md). **This skill does not
assume you have either.** Where a step below points at something in-tree, it says so, and says what
the out-of-tree equivalent is.

**Where the package lives is not a hard choice any more.** A provider can be a PERSONAL provider —
an npm package the operator installs under their Rocky Surf's data directory and names in the config
file as `providers.<id>.package` — and it gets composed, a Settings panel and a place in the wizard
with no change to this repository (ADR-0026, ADR-0027). That is the default for a cloud one person
needs. A provider that would help others can be promoted into the repository later; the package is
the same either way. See [references/wiring.md](references/wiring.md), "Out of tree".

## The fixed majority and the variable parts

Rocky Surf is a majority-fixed architecture with variable components, and the whole of this skill is
knowing which is which:

- **What core computes with is a typed capability**, never text — `stop`, `ipStableAcrossStop`,
  `billsWhileStopped`, `managesSshAccess`, and the rest of `ProviderCapabilities`. Core branches on
  these and never on a provider's id; that is grep-enforced.
- **What only the human needs to know is an advisory** — a sentence the provider declares and the
  Settings and New Server pages print. Cheap, safe, no core logic.
- **What the operator configures is a declared setting** — fields with kinds, labels and help on the
  factory (`settings`), from which the Settings panel is built.

**THE HARD RULE, learned from DigitalOcean's billing:** when the cloud's honest answer to a question
below fits no existing capability, **stop and file the ADR question**. Do not pick the nearest flag.
An approximated capability passes conformance and lies to the spend cap — a conformance-green lie is
the worst kind, because nothing looks broken. `billsWhileStopped` exists because the first author to
hit this stopped rather than shipping `stop: false`.

## Work in this order

The order matters. Steps 1, 2 and 4 are decisions that are expensive to revisit once code exists.

### 1. Research the cloud — the protocol, not an interview

Do not start writing until every question in
[references/research-protocol.md](references/research-protocol.md) has an answer **with a citation
into the cloud's own documentation**, and each answer is mapped to the capability, field or setting
it lands in. The list is fixed on purpose: it is every place two clouds have already been found to
differ. The reference carries a full worked example for DigitalOcean, including the two answers
that needed rulings before an honest provider could exist.

Two of the questions decide the architecture of the package and are the ones to answer first:
**does a stopped machine still bill** (→ `billsWhileStopped`, ADR-0025), and **what is the
firewall model, and can a rule carry proof of who wrote it** (→ `managesSshAccess` and how
`syncSshAccess()` converges, ADR-0021 — see [references/ssh-access.md](references/ssh-access.md)).

And one that decides where the package lives: **in tree or personal?** Personal needs none of the
in-repository edits and no `pnpm run check`; it needs the factory to carry `credentialField`,
`credentialEnv` and `settings`, which an in-tree factory should carry anyway.

### 2. Decide the vendor SDK question — by measuring

**Default to raw REST over `fetch`.** Buy a vendor library only for the part where hand-rolling is
a liability, which in practice means auth.

Do not take this on faith and do not reuse a number from memory: the process is to measure, and
[references/vendor-sdks.md](references/vendor-sdks.md) is the three-step test and how to run it.
The saving is not only disk — a generated client hides the API, and writing the transport by hand
is what makes its real behaviour visible.

### 3. Scaffold the package

[references/scaffold.md](references/scaffold.md) has the skeleton: `package.json`, `config.ts`,
`index.ts` (the factory, with `credentialField`, `credentialEnv` and `settings`), `errors.ts`, and
the conformance test file to start from. It flags the two lines of the manifest that differ in tree
and out of tree — `workspace:*` specifiers and the build script — so copying it out of tree does not
fail on an unsupported URL protocol.

[references/types.md](references/types.md) is the companion: every type you will import, its
fields, the nine error codes, the `ProviderError` constructor, and the dependency seam your tests
will need.

Two rules that are enforced by CI rather than by review:

- **Nothing in the package may import `@rockysurf/core`**, and core will never import it.
  `scripts/check-core-deps.mjs` enforces both directions.
- The package depends on `@rockysurf/provider-sdk`, which has **zero runtime dependencies** on
  purpose — and no export whose meaning depends on object identity, because a personal package
  carries its own copy of it.

### 4. Implement the contract, trap checklist in hand

Nine required methods, one optional method (`syncSshAccess()`, when `managesSshAccess` is true),
and eight capability fields — five required, three optional (`simulatedInstances`,
`managesSshAccess`, `billsWhileStopped`; absent means false).
[references/contract.md](references/contract.md) is the method-by-method guide, and it is mostly a
list of the ways each one has already been got wrong in this repository.

The traps that have actually cost something, in severity order — every one of these must be
**pinned by a test with literal values**, not by a comment, because a comment does not fail CI
when a maintainer "fixes the typo":

1. **The status vocabulary trap.** Your cloud's status strings and the SDK's `InstanceState` may
   share a spelling and mean different things. GCE reports a *stopped* instance as `TERMINATED`;
   Azure's `deallocated` reads like "gone" and is not; DigitalOcean's `off` is `stopped`. Mapping
   any of them onto the SDK's `terminated` tells core a live, billing machine is gone, after which
   `terminate()` no-ops on the row and nothing reaps it.
2. **The absence grace.** `describe()` maps absence to `terminated` only after a propagation
   grace. An eventually consistent API reports a just-created instance as missing; believing the
   first not-found marks a healthy instance dead. This shipped once already.
3. **Ownership labels, and reaping on failure.** A `managed-by` label means "a Rocky Surf made
   this", not "this run made this". Getting `listManaged()` ownership wrong means either an orphan
   that bills forever or a reaper that deletes something in use — a sweep selecting on
   `managed-by` alone once destroyed the repository owner's live server. The create-time half of
   the same rule: refuse a spec whose `managed-by` disagrees with your prefix, and assert
   `serverId` is hostname-safe rather than sanitizing it. Both failures are committed at create
   time and discovered by a bill.
4. **Idempotency.** `terminate()` is idempotent and not-found is success, because reconcilers
   retry.
5. **Exposure posture, and the whitelist that must reach the cloud.** If the cloud has a firewall
   model, `sshAllowedCidr` is a LIST, required with no default; opening SSH to the internet takes a
   second deliberate flag; provision is ADDITIVE and never revokes; and the operator's saved list
   reaches the cloud through `syncSshAccess()`, not only at launch. The whole of this is
   [references/ssh-access.md](references/ssh-access.md).
6. **`canInjectHostKeys` honesty**, and its dependency on `generatesUserData`.
7. **`billsWhileStopped` honesty.** It means the RUNNING rate. A cloud that charges a reduced rate
   while stopped fits no capability — stop and file the ADR question.

### 5. Declare the settings and run conformance

Declare `settings` on the factory — every field an operator sets, with a kind, a label and a
sentence of help; the cloud's machine-type vocabulary; and any advisories — and `credentialField`
/ `credentialEnv` if the cloud takes a token. The Settings panel is built from this, in tree or
out (ADR-0027); nothing in core or the SPA is edited for it. The rules for what may be declared are
in [references/types.md](references/types.md#providersettings).

```sh
npm install --save-dev @rockysurf/provider-conformance
```

It is in the published set, so this is the out-of-tree route too. **Before the first release
nothing is on the registry yet** and that command 404s. Until then you need the two tarballs
(`@rockysurf/provider-sdk` and `@rockysurf/provider-conformance`) from whoever pointed you at this
skill, or produce them yourself with `pnpm pack` in a checkout. They are the same artifacts the
release will publish.

[references/shipping.md](references/shipping.md) covers wiring up the assertions, including the
absence-grace harness — the one check that asserts behaviour rather than shape, the one worth wiring
carefully, and the one whose two probes are **not** symmetrical. `assertFactoryShape` also checks
your declaration against your schema (every example parses) and that an `sshCidrList` comes with
`managesSshAccess`.

Passing is necessary and not sufficient. It cannot know whether the cloud does what you said it
does.

### 6. Wire it in — or install it

**Personal:** `mkdir -p ~/.rockysurf/providers && cd ~/.rockysurf/providers && npm init -y && npm
install <your package>` (or point `package:` at a path while developing), then a `providers.<id>`
section in the config file with `package:` and `enabled: true`. Restart. That is the whole of it —
[references/wiring.md](references/wiring.md), "Out of tree", has the exact section and what to
expect when something is wrong. **The trust model is one sentence and your README should carry it:
a provider runs with Rocky Surf's full access — install ones you trust.**

**In tree:** read [references/wiring.md](references/wiring.md) before starting. Registration is
"one row in `compose.ts`" for the composition root and more than that for the job — core's config
section still has to mirror your fields by hand, and a field missing from it is not merely
undocumented, it is *unusable*. The list is shorter than it was: a declared provider needs no rows
in `fields.ts` and no block in the SPA.

### 7. Ship it

[references/shipping.md](references/shipping.md): the package README in the fixed section order, and
the ADR amendment etiquette for when the SDK genuinely lacks something. In tree, also the
capability-matrix column, the `docs/providers/` page, least-privilege IaC, and — for an OFFICIAL
provider, one composed into `packages/rockysurf/src/compose.ts` — the nightly real-cloud leg,
without which every value in your column is daggered. A personal provider gets no leg: its author
and its installer verify it themselves
([references/wiring.md](references/wiring.md#real-cloud-verification)).

## Before it merges

Everything here is checkable. The first seven apply wherever the provider lives; the last three are
in-tree only, because they are edits to this repository.

- [ ] Every research-protocol question answered with a citation, and each answer mapped to a
      capability, field or setting — or to a filed ADR question. Nothing approximated.
- [ ] Nine methods implemented; `stop`/`start` throw rather than being absent if unsupported;
      `syncSshAccess()` present exactly when `managesSshAccess` is declared.
- [ ] `settings`, `credentialField` and `credentialEnv` declared on the factory.
- [ ] Conformance passes, including the absence-grace harness and the settings check.
- [ ] Status mapping pinned by a test with literal values.
- [ ] A package `README.md` whose capability values match the source constant and which carries the
      trust sentence.
- [ ] A verification section claiming only what has actually been run.
- [ ] *(in tree)* A capability-matrix column, filled in **in the same pull request**, saying how
      each value was established. A value nobody has exercised must say so.
- [ ] *(in tree)* `pnpm run check` green, including the dependency lint and the settings parity
      test.
- [ ] *(in tree)* If a vendor SDK was taken, it did not land in the `npx` install closure, and it
      was taken for a reason the vendor-SDK test allows, with the measurement written down.

## A rule about numbers

If a measurement would strengthen a sentence you are writing — a package size, a line count, a
limit — either measure it in that moment and say where it came from, or write the sentence without
it. A measurement of this repository lives in exactly one dated place and is re-measured rather
than quoted; never write one into the file it measures, because the edit that corrects it
invalidates it. A measurement of an external immutable artifact (an npm tarball at a named
version) is the only kind safe to inline.

This is not a style note. A wrong line count in a provider comment propagated into two other
documents before anyone counted, and the first attempt to fix it in place was false on save.
