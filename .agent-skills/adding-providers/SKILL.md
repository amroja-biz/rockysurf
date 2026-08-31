---
name: adding-providers
description: Add a cloud to Rocky Surf, or configure one it already supports. Use when the user wants to switch on or configure a provider (AWS, Azure, GCP, Hetzner, BYO) — credentials, region, sshAllowedCidr, the setup wizard, the Settings page — or wants to add support for a cloud Rocky Surf does not have yet by writing a new provider package against @rockysurf/provider-sdk. Triggers on "add a provider", "configure AWS/Azure/GCP/Hetzner", "add DigitalOcean/Vultr/Linode/OVH support", "write a compute provider", "new provider package", "provider credentials", "sshAllowedCidr", "my provider isn't showing up", "provider conformance".
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

If the cloud genuinely does not fit the frozen shape, that is an ADR amendment in the same pull
request, not a special case in core — see the amendment etiquette in
[references/shipping.md](references/shipping.md).

## Work in this order

The order matters. Steps 2 and 4 are decisions that are expensive to revisit once code exists.

### 1. Interview

Do not start writing until these are answered. Most are answered by the cloud's API docs, and
looking them up yourself is faster than asking:

- **Which cloud, and what is its compute API?** Get the actual REST reference open.
- **How does it authenticate?** A bearer token is a different decision from a signed assertion
  flow — this feeds step 2.
- **Can an instance be stopped and restarted with its disk intact?** If not, `capabilities.stop`
  is `false` and `stop`/`start` throw. That is legal and `@rockysurf/provider-byo` is the model.
- **Does the public IP survive a stop?** → `ipStableAcrossStop`.
- **Can it take user-data at create time, and what is the hard size ceiling?** →
  `generatesUserData`, `userDataMaxBytes`. Find the documented limit; do not guess a round number.
- **Can the box come up presenting a host key we minted?** → `canInjectHostKeys`. This is a
  security posture, not a feature flag: `true` means there is no trust-on-first-use window on the
  connection that carries the secrets file. If it is `false`, the provider's docs must say plainly
  what the operator is trusting instead.
- **What currency does it bill in?** Not USD unless it really is USD.
- **How are resources tagged or labelled?** You need a way to find your own instances again, and
  to distinguish *secondary* resources you own from ones you share. See the ownership trap in
  [references/contract.md](references/contract.md).
- **In tree or out of tree?** Ask this early, because it changes steps 3, 5, 6 and 7. In tree means
  a package inside this repository, shipped in the `rockysurf` CLI, with a composition-root row and
  a core config section. Out of tree means your own package, your own registry, your own
  composition root — and none of step 6's edits, none of step 7's in-repo deliverables, and no
  `pnpm run check`.

### 2. Decide the vendor SDK question — by measuring

**Default to raw REST over `fetch`.** Buy a vendor library only for the part where hand-rolling is
a liability, which in practice means auth.

Do not take this on faith and do not reuse a number from memory: the process is to measure, and
[references/vendor-sdks.md](references/vendor-sdks.md) is the three-step test and how to run it.
The saving is not only disk — a generated client hides the API, and writing the transport by hand
is what makes its real behaviour visible.

### 3. Scaffold the package

[references/scaffold.md](references/scaffold.md) has the skeleton: `package.json`, `config.ts`,
`index.ts`, `errors.ts`, and the conformance test file to start from. It flags the two lines of the
manifest that differ in tree and out of tree — `workspace:*` specifiers and the build script — so
copying it out of tree does not fail on an unsupported URL protocol.

[references/types.md](references/types.md) is the companion: every type you will import, its
fields, the nine error codes, the `ProviderError` constructor, and the dependency seam your tests
will need.

Two rules that are enforced by CI rather than by review:

- **Nothing in the package may import `@rockysurf/core`**, and core will never import it.
  `scripts/check-core-deps.mjs` enforces both directions.
- The package depends on `@rockysurf/provider-sdk`, which has **zero runtime dependencies** on
  purpose.

### 4. Implement the contract, trap checklist in hand

Nine methods, five capabilities. [references/contract.md](references/contract.md) is the method-by-
method guide, and it is mostly a list of the ways each one has already been got wrong in this
repository.

The traps that have actually cost something, in severity order — every one of these must be
**pinned by a test with literal values**, not by a comment, because a comment does not fail CI
when a maintainer "fixes the typo":

1. **The status vocabulary trap.** Your cloud's status strings and the SDK's `InstanceState` may
   share a spelling and mean different things. GCE reports a *stopped* instance as `TERMINATED`;
   Azure's `deallocated` reads like "gone" and is not. Mapping either onto the SDK's `terminated`
   tells core a live, billing machine is gone, after which `terminate()` no-ops on the row and
   nothing reaps it.
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
5. **Exposure posture.** If the cloud has a firewall model, `sshAllowedCidr` is required with no
   default, and opening SSH to the internet takes a second deliberate flag.
6. **`canInjectHostKeys` honesty**, and its dependency on `generatesUserData`.

### 5. Run conformance

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
carefully, and the one whose two probes are **not** symmetrical.

Passing is necessary and not sufficient. It cannot know whether the cloud does what you said it
does.

### 6. Wire it in

**Read [references/wiring.md](references/wiring.md) before starting this step.** The standard says
registration is "one row in `compose.ts`". That is true of the composition root and false of the
job: a new in-tree provider touches around sixteen places, and several of them fail in ways that
look like something else — a field missing from core's config section is not merely undocumented,
it is *unusable*, and the operator gets "unrecognized key" instead of the real problem.

Out of tree, you own those decisions instead of editing them; that reference says which is which.

### 7. Ship it

[references/shipping.md](references/shipping.md): the package README in the fixed section order, and
the ADR amendment etiquette for when the SDK genuinely lacks something. In tree, also the
capability-matrix column, the `docs/providers/` page and least-privilege IaC.

## Before it merges

Everything here is checkable. The first six apply wherever the provider lives; the last three are
in-tree only, because they are edits to this repository.

- [ ] Nine methods implemented; `stop`/`start` throw rather than being absent if unsupported.
- [ ] Conformance passes, including the absence-grace harness.
- [ ] Status mapping pinned by a test with literal values.
- [ ] A package `README.md` whose capability values match the source constant.
- [ ] A verification section claiming only what has actually been run.
- [ ] If a vendor SDK was taken, it was taken for a reason the vendor-SDK test allows, and the
      measurement behind that is written down with the version it measured.
- [ ] *(in tree)* A capability-matrix column, filled in **in the same pull request**, saying how
      each value was established. A value nobody has exercised must say so.
- [ ] *(in tree)* `pnpm run check` green, including the dependency lint.
- [ ] *(in tree)* If a vendor SDK was taken, it did not land in the `npx` install closure.

## A rule about numbers

If a measurement would strengthen a sentence you are writing — a package size, a line count, a
limit — either measure it in that moment and say where it came from, or write the sentence without
it. A measurement of this repository lives in exactly one dated place and is re-measured rather
than quoted; never write one into the file it measures, because the edit that corrects it
invalidates it. A measurement of an external immutable artifact (an npm tarball at a named
version) is the only kind safe to inline.

This is not a style note. A wrong line count in a provider comment propagated into two other
documents before anyone counted, and the first attempt to fix it in place was false on save.
