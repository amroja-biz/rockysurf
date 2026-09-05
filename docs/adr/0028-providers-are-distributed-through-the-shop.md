# ADR-0028: Providers are distributed through the shop, and installing one is not running one

## Status

Accepted — 2026-09-05. Implemented by GitHub issue [#374](https://github.com/amroja-biz/rockysurf/issues/374),
item 5 of the direction settled in [#294](https://github.com/amroja-biz/rockysurf/issues/294).

Builds on ADR-0026 (a personal provider is a package named in the config file) and ADR-0027 (a
provider declares its settings). Applies ADR-0006's split-horizon rule to a second kind of
artifact, and amends nothing in it.

## Context

ADR-0026 made a provider Rocky Surf did not ship installable: a package under `<dataDir>/providers`,
a `providers.<id>.package` line in the config file, loaded once before boot with the process's
full access. What it did not give anyone was a way to **find** such a provider, or a way to put
one where somebody else could find it. The instructions were `npm install` in a directory and a
line typed into YAML, which works for the person who wrote the provider and for nobody else.

The owner's ruling on #294 named the missing half plainly: *"A personal provider that would help
others can be promoted to the Rocky Surf shop."* The shop already exists — ADR-0006 built it for
Surge Packs, with a registry of files, a generated listing, digests, a trust label that comes
from the operator's own config file, and an SSRF-guarded fetch that never runs at boot.

Three things about that existing machinery shaped this decision more than the issue text did.

**A provider is a heavier payload than a pack.** A pack is a YAML file describing shell that runs
as root on a box you create. A provider is code that runs *inside the control plane*, with its
database, its master key and every cloud credential in its environment. The trust model is the
same — full trust, stated plainly — but the disclosure before consent has to carry more.

**`registryIndexSchema` is strict.** Adding a `providers` array to `index.json` would make every
shop that published one unreadable by every Rocky Surf already installed: the pack shelf would go
from "here are the packs" to "this is not a pack registry index" on an installation that changed
nothing.

**Nothing about installing a provider can be allowed to run its code.** The loader imports a
personal provider once, before boot. That is the moment the operator chose, and an installer that
ran `npm install` — lifecycle scripts and all — would have moved that moment to "the instant you
clicked a button in a shop listing", which is precisely the consent this design is built around.

## Decision

### 1. A registry publishes providers in a separate document, `providers.json`

Fetched from `<url>/providers.json`, beside `index.json`, from the **same** `registry.sources`
entries. One document per concern, so opening the pack shelves costs no provider fetch and a shop
can begin listing providers without any installed Rocky Surf noticing.

An entry names: the `providerId` (which is the key of the `providers:` section it installs as, and
must be a hostname-safe lowercase label for that reason), a display `name` and `description`, a
`version`, the npm `package` inside the artifact, the `tarball` URL, its `sha256`, a summary of
the `settings` it will ask the operator for, and its `capabilities` answers.

A source that is a single `.yaml` file (ADR-0006's #88 amendment) publishes no providers, and says
so in those words rather than having a sibling URL guessed for it.

### 2. The trust sentence is Rocky Surf's constant, and the schema refuses a trust field

Every provider listing carries, verbatim:

> a provider runs with Rocky Surf's full access — install ones you trust.

It is `PERSONAL_PROVIDER_TRUST_SENTENCE` in `packages/core/src/config/personal-providers.ts`, put
on the response by core and rendered by the client on every entry. **There is no field for it in
`providers.json`, and the strict schema refuses one**, along with any `trust` field.

This is ADR-0006's decision 2 applied to a bigger payload rather than a new one. A trust label
inside a registry's own document is a claim about trustworthiness written by the party being
trusted; a shop that could write this sentence could also soften it or leave it out. The label a
listing DOES wear — `community` or `internal` — is the one the operator wrote next to that source
in their own config file, exactly as for packs, and `official` remains a value no source may claim.

### 3. Installing is fetch, verify, unpack, and two lines in the config file — never execution

In order, and any failure stops before the previous state changes:

1. the `tarball` URL is **https only**, refused at the schema and again at the installer;
2. the fetch goes through the same SSRF guard as pack import, with a 16 MiB wire cap;
3. the bytes are hashed and compared with the listing's `sha256`; a mismatch names both values;
4. the archive is unpacked by a reader written for this (`providers/tarball.ts`) that refuses
   absolute paths, `..`, symlinks, hard links, device nodes, any member outside `package/`, more
   than 4 000 files and more than 64 MiB uncompressed — the gzip-bomb cap the wire cap cannot see;
5. the manifest's `name` must be the package the listing named;
6. the entry point is resolved with **the same resolver the loader will use at the next restart**,
   so a package that installs is a package that can be loaded;
7. every declared runtime dependency must already resolve from `<dataDir>/providers`;
8. the tree is staged in a sibling directory and renamed into place;
9. `providers.<id>.package` and `providers.<id>.enabled: true` are written to the config file
   through the settings write path — the Document API, `checkConfigText`, an atomic write that
   carries the file's mode, then this process adopts it (ADR-0017);
10. the response says a restart is required, and why.

**No npm, no lifecycle scripts, no code from the package, at any point.** `scripts` in a fetched
`package.json` is data that is read and ignored. The consequence, stated as a requirement rather
than left to be discovered: **a provider published to the shop must be self-contained** — zero
runtime dependencies, or its imports bundled — because nothing here will resolve one for it.

### 4. Updating is re-installing; removing is refused while servers still exist

An update is the same operation with a newer artifact: the tree is REPLACED, not merged, so no
file of the old version survives. The version shown as installed is read from the manifest on
disk, never from a record kept elsewhere — an operator may `npm install` in that directory by
hand, which ADR-0026 explicitly permits, and a remembered version would then be a lie.

Removing deletes the package and the whole `providers.<id>` section, after a confirmation naming
both. It is **refused** while any server row on that provider is not `terminated`: a provider
whose package is gone cannot describe, stop or terminate the machines it made, and leaving rows
nothing can act on is worse than refusing.

### 5. The listing lives on the Shop page, and the page is now called Shop

The Surge Packs page gains a fourth tab, Providers, and its title changes from "Surge Packs" to
"Shop". The route is unchanged: `/packs` still opens it, and every link and document naming it
still works. The reason for the rename is the same one that put the tab there rather than on a
page of its own — the shop distributes two kinds of thing from the same registries, an operator
told "it is in the shop" should find both in one place, and three tabs about packs plus a fourth
about providers under a title naming only packs would have been a title that lied.

Nothing is fetched until the tab is opened, which is `docs/self-hosting.md`'s "nothing here is
read at boot" rule with no exception carved for this.

## Considered options

**A `providers` array inside `index.json`.** Rejected on compatibility: the pack index schema is
strict, so publishing the field would break the pack shelf for every installed client. A separate
file is invisible to a client that never asks for it.

**A second source list (`providerRegistry.sources`).** Rejected. It would let two lists disagree
about the same repository and would ask an operator the trust question twice about one decision.
A pack is already root shell on every box created with it; a source is vouched for once.

**Running `npm install` on the installed package.** Rejected outright: it executes lifecycle
scripts at install time, which moves the moment code first runs away from the restart the operator
chose. Requiring a self-contained artifact costs an author one bundler flag and costs the operator
nothing.

**Installing without checking dependencies, and letting the next restart report the failure.**
Rejected. The failure would arrive hours later, phrased as "the provider did not load", for a
reason nobody could act on from that message. The check is cheap and the refusal names the
packages.

**Using a general-purpose tar library.** Rejected. The properties that matter here — no symlinks,
no traversal, no device nodes, bounded output — are options a caller can forget to pass. A reader
with no code path that produces a symlink cannot be optioned into producing one, and it adds no
dependency to a package whose cold start is a feature.

**Signing the artifact.** Deferred, as ADR-0006 deferred signing the index, and for the same
reason: half a signing story is worse than a clearly-labelled unsigned one. The digest is
documented as a pin rather than a signature everywhere it appears, and the honest description of
the chain is "the registry repository's branch, and its host's account controls".

**A sandbox, a second process, or a protocol fence around a provider.** Out of scope by the
owner's ruling on #294 and by ADR-0026: a provider is software, and a fence it could not do its
job behind would be theatre. The obligation that replaces it is the sentence in decision 2.

## Consequences

### Positive

- A provider can be published, found and installed without touching this repository or its
  release cycle — the same property ADR-0006 gave packs.
- The disclosure before consent is complete: what it will ask for, what its machines can do,
  and what installing means, all before the first click.
- The installer and the loader cannot disagree about what a package is, because they share the
  manifest resolver — which moved into core for exactly this reason.
- An update and an install are one operation, so there is no partial-update state to get wrong.
- The registry cannot describe itself as trustworthy, and cannot make the sentence go away.

### Negative

- **A shop provider must be self-contained.** An author who depends on `zod` at runtime has to
  bundle it. `docs/writing-a-provider.md` says so with the `pnpm pack` recipe.
- **The trust label is per source, not per provider.** An operator who adds a registry vouches
  for all of it — ADR-0006's own consequence, and heavier here.
- **The digest is not a signature.** Whoever can write the listing can write both halves.
- **Installing needs a restart**, and always says so. A personal provider's package is imported
  once, before boot; no amount of config adoption changes that.
- **A provider installed from the shop is enabled immediately**, which for an unconfigured one
  means the New Server page reports it as unavailable with the provider's own reason until the
  operator fills in its settings. That state is ADR-0026's and is handled there.

### Risks and mitigations

- **Risk:** an artifact that is not the one the listing describes. **Mitigation:** digest verified
  before the archive is opened, and the manifest's `name` checked against the listing.
- **Risk:** an archive that writes outside its directory. **Mitigation:** the reader refuses
  absolute paths, `..`, links and device nodes before a byte reaches the filesystem, and requires
  every member to sit under `package/`.
- **Risk:** a decompression bomb. **Mitigation:** a wire cap and a separate uncompressed cap.
- **Risk:** an install that half-succeeds — a package on disk the config does not name, or a
  config line pointing at nothing. **Mitigation:** the package is written first and removed again
  if the config write fails; the removal writes the config first and deletes the package after.
- **Risk:** a removal that strands machines. **Mitigation:** refused while any non-terminated row
  names that provider, with the count in the message.

## References

- GitHub issue [#374](https://github.com/amroja-biz/rockysurf/issues/374) — the commission
- GitHub issue [#294](https://github.com/amroja-biz/rockysurf/issues/294) — the settled direction,
  item 5, and the full-trust ruling the sentence comes from
- [`SECURITY.md`](../../SECURITY.md) § Server-side fetch policy, and § Installing a provider from
  the shop
- [`docs/self-hosting.md`](../self-hosting.md) § The pack registry — the operator-facing half
- [`docs/writing-a-provider.md`](../writing-a-provider.md) § Publishing to the shop — the author's

## Related decisions

- ADR-0006 — packs come from two places, and only the operator says which is trusted; the
  split-horizon rule and the no-trust-field rule this applies to a second artifact
- ADR-0026 — a personal provider is a package named in the config file, loaded with full access
- ADR-0027 — a provider declares its settings; what a listing summarises before install
- ADR-0025 — billing while stopped is a capability; one of the answers a listing shows
- ADR-0017 — settings apply on save; the write path an install borrows rather than reinventing
