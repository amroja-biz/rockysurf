# ADR-0006: Packs come from two places, and only the operator says which is trusted

## Status

Accepted — 2026-08-14. Implemented by `rockysurf-arym` (GitHub issue #9): the harness commands
(`arym.2`), the registry client (`arym.3`), the install route and provenance columns (`arym.4`),
the shop page (`arym.5`). ADR-0004 stands unamended — see "The format does not change" below.

## Context

ADR-0004 made packs PR-able YAML files in this repository, which gave the community something to
send a pull request *against*. It did not give them anywhere to send it *to*. Every pack still had
to be merged here, by the maintainers of the control plane, alongside the code that runs it — so
"packs are extensible" meant "extensible by us".

Issue #9 asks for the thing agent-skill and MCP ecosystems have: a dedicated registry
(`amroja-biz/rockysurf-shop`), organised so users can tell official packs from community
contributions, loaded **at runtime without restarting the server**, with every pack scanned for
well-formedness and for security.

Three things about the existing code shaped the answer more than the issue text did.

**The runtime-install seam already existed.** `POST /api/v1/admin/surge-packs/import` accepts a
pack file or a URL, validates it against the frozen format, and writes rows that take effect
immediately. Half of "load at runtime" was already built; what was missing was discovery, trust,
and verification in front of it.

**`sourceFile` is load-bearing and easy to misuse.** `syncPacksToDb` deletes every row whose
`sourceFile` is set and whose file the next boot cannot find. The obvious place to record "this
came from the shop" is therefore the one place that would make the pack disappear on restart.

**A published npm install ships no packs at all.** Neither `rockysurf` nor `@rockysurf/core`
includes `packs/` in its `files`, so `resolvePacksDir` falls through to an empty data directory
and a fresh `npx rockysurf` renders the "No Surge Packs are available yet" empty state
(`rockysurf-io02`). That reframed the question of where official packs should live: the npx demo
is fixed by *bundling* packs, not by making it depend on a network fetch.

## Decision

### 1. Split horizon: official packs ship in the tarball, the registry is community only

Official packs stay in this repository's `packs/` and are bundled into the published package.
`amroja-biz/rockysurf-shop` holds community packs and nothing else — no `official/` tier, no
mirror of this repository's packs, no synchronisation between the two.

The control plane's shop page is the unified browsing surface: bundled packs and registry packs
shown together, each labelled with where it came from.

### 2. The trust label comes from the operator, never from the registry

`registry.sources` is a list, each entry carrying a `name`, a `url`, and a `trust` label the
operator wrote:

```yaml
registry:
  sources:
    - name: Rocky Surf Pack Shop
      url: https://raw.githubusercontent.com/amroja-biz/rockysurf-shop/main
      trust: community
```

There is **no trust field in a registry's `index.json`**, and the schema is strict, so an index
carrying one is refused rather than ignored. `official` is not a value `trust` accepts.

A pack's label therefore always comes from something the operator controls: their tarball, or
their config file. Nothing a registry publishes can promote itself.

### 3. Scanning discloses; it does not certify

Two published commands run the pack contract anywhere, so a registry's CI gates a contribution
with the same code this repository gates its own packs with:

- `rockysurf pack lint` — the frozen schema, id resolution, and the mechanical half of the four
  author rules;
- `rockysurf pack check` — the pack installed twice in a stock `ubuntu:24.04` container with the
  resume journal discarded in between, on both architectures.

Neither is described as a security check anywhere in the product, the documentation, or their own
help text. What carries that weight is **disclosure**: before an install, the operator sees every
`installScript` and `setupScript` verbatim, plus which steps run as root and every URL the scripts
fetch. That derived summary carries `summaryIsComplete: false` as a field, so an interface has to
render the caveat.

### 4. Registry provenance gets its own columns; `sourceFile` stays null

A registry install writes `registrySource`, `registryUrl`, `registrySha256`, `registryTrust` and
`registryInstalledAt`, and leaves `sourceFile` null exactly as an admin-created pack does. The
trust label is snapshotted at install time rather than read live.

### 5. The index is fetched as a file, pinned by digest, and the chain is named honestly

A registry publishes a CI-generated `index.json`; the client fetches `<url>/index.json` and then
the paths it names, over plain file GETs through the existing SSRF guard. Never the GitHub API.
Each entry pins its pack by SHA-256, verified after fetch, and a mismatch is refused.

Boot never fetches. `registry.enabled: false` switches the shop off entirely.

## Considered options

**Move all packs to the shop, as issue #9 literally asks.** Rejected by the owner in favour of the
split horizon. It would have put the merge gate on the network — `scripts/pack-smoke.mjs`,
`packs.test.ts` and `bin.e2e.test.ts` all read `packs/` from the checkout — broken air-gapped
Docker, and made the `npx` case worse rather than better, since a fresh install has no packs today
and would have gained a network dependency instead of files.

**Mirror this repository's packs into the shop as an `official/` tier, written by CI.** Proposed,
and rejected by the owner in favour of the split horizon. It would have made `official` a
provenance claim a contributor could not forge — the directory being CI-written was the whole
mechanism — but at the cost of two homes for the same bytes, a drift lint to keep them honest, and
a trust label that still lived in a document the registry itself published. The split horizon gets
the same guarantee more cheaply: official packs are the ones that came with the software, which
needs no mechanism at all.

**A `tier` field in `index.json`.** Rejected. Under the mirror design it was defensible, because
CI wrote it. Once the shop is purely community it becomes a claim about trustworthiness written by
the party being trusted, worth exactly as much as the document containing it.

**Recording provenance in `sourceFile`.** Rejected: it makes the boot reconcile delete the pack.

**Signing the index.** Deferred (`rockysurf-cqrm`), not adopted. Half a signing story is worse than
a clearly-labelled unsigned one; the digest is documented as a pin rather than a signature
everywhere it appears.

**Vendoring the pack checks into the shop's CI.** Rejected. A copy agrees with the contract on the
day it is made and drifts afterwards — accepting packs the control plane rejects, which is the
worst direction for a gate to fail in.

## Consequences

### Positive

- A community pack can be contributed, reviewed and published without touching the control plane's
  repository or its release cycle.
- The trust label cannot be forged by a registry, because no registry writes it.
- Official packs are unaffected by anything in this decision: they ship where they shipped, are
  reviewed where they were reviewed, and gain a bundling fix they needed anyway.
- The install path is the one that already existed, so there is one definition of what a pack
  becomes when it lands in the database.
- Adding an internal registry is a config change, which is where a decision like that belongs.

### Negative

- **A community pack cannot resolve the base toolchain on its own.** Packs reference `curl`,
  `git`, `claude-code` and the rest by id, and those definitions ship with Rocky Surf rather than
  living in the registry. The shop's CI therefore clones this repository to supply `--base-packs`.
  Nothing is committed from that clone, but the registry's checks are coupled to this
  repository's `main`, and a tool removed here turns into a failed check there.
- **The trust label is per registry, not per pack.** An operator who adds a registry vouches for
  all of it. Finer granularity would need per-pack signatures, which is `rockysurf-cqrm`.
- **The digest is not a signature**, and the honest description of the trust chain is "the
  registry repository's branch, and its host's account controls".
- Two places to look for a pack, and the shop page has to make one list of them without
  flattening the distinction it exists to show.

### Risks and mitigations

- **Risk:** an operator reads "scanned" and installs without reading, because the phrase appears
  in the issue that commissioned this. **Mitigation:** it appears nowhere in the product. The
  disclosure is unavoidable in the install flow, `summaryIsComplete` is a rendered field, and the
  documentation says in three places what the checks prove and what they do not.
- **Risk:** a registry serves a pack that differs from the one its index describes.
  **Mitigation:** the digest is verified after fetch and a mismatch is refused with both values
  named; an entry whose `packId` disagrees with the file it points at is refused separately.
- **Risk:** an index points the control plane at an arbitrary URL. **Mitigation:** `path` is
  schema-constrained to a relative path with no traversal, and every fetch goes through the SSRF
  guard.

## The format does not change

A registry pack is the same frozen v0.1 `PackFile` as a pack in `packs/`, parsed by the same
loader, validated against the same schema, and written by the same function. ADR-0004 therefore
needs no amendment: this decision changes where a pack may come from and how much an installation
is willing to say about it, not what a pack is.

## References

- GitHub issue [#9](https://github.com/amroja-biz/rockysurf/issues/9) — the commission, and the
  owner's ruling in its thread
- `rockysurf-io02` — a fresh `npx` install has an empty pack picker; the bundling half of decision 1
- `rockysurf-c6cm` — the unauthenticated GitHub API quota, which is why the index is a file
- `rockysurf-cqrm` — signing the index, deferred
- `packages/core/src/packs/disclosure.ts` — why disclosure carries what scanning cannot
- [`SECURITY.md`](../../SECURITY.md) § Server-side fetch policy — the guard every registry fetch
  goes through

## Related decisions

- ADR-0004 — packs as PR-able YAML; the format this builds on and does not change
- ADR-0001 — the control plane whose boot reconcile provenance must not collide with
