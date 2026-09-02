# ADR-0018: A tool file is a sibling of a pack file, not a loosening of it

## Status

Accepted — 2026-09-01. Issue #289. Extends the file formats [ADR-0004](0004-packs-as-pr-able-yaml.md)
froze with a second one; ADR-0004's pack format is untouched, and it remains the only thing the
boot reconcile reads. **The "no `{ url }` arm" clause is superseded by
[ADR-0022](0022-a-tool-can-be-imported-from-a-url-now-that-tools-carry-provenance.md)** (issue
#299), which added the tool provenance columns whose absence was the whole of the objection; the
rest of this ADR stands.

## Context

Rocky Surf has shipped an agent skill for authoring a whole Surge Pack and one for adding a cloud
provider. It had none for the unit people trade most often: a single tool. "Here is how I install
my linter" is a paragraph, not a box, and until now the only shareable artefact was a whole pack.

The issue also asked for a "personal tools registry". Most of that turned out to exist already. A
`tools` table has been first-class since the SPA port, `/api/v1/admin/tools` is full CRUD, and the
Tools page has a nav entry. `sourceFile` is the seam: a row loaded from `packs/*.yaml` carries its
filename and renders read-only, because the next boot rewrites it from disk; a row created here
carries `NULL` and the reconcile leaves it alone. What was missing was not storage. It was a
shareable artefact at tool granularity, and a name for the split the UI already implemented.

One clarification the owner made while this was being designed, because it changes what "personal"
may mean: everyone who runs an installation is its admin
([issue #192](https://github.com/amroja-biz/rockysurf/issues/192)). "Personal" therefore means
*registered on this installation*, not *belonging to one user*. There is no `userId` on a tool and
no per-user visibility to design around.

## Decision

**A tool file is `version: 1` and a list of tools, and it reuses `toolSchema` verbatim.**

```yaml
version: 1
tools:
  - toolId: my-tool
    ...
```

`toolFileSchema` sits beside `packFileSchema` in `packs/schema.ts`. Both are `strictObject`, both
freeze at `version: 1`, and the tool list in each is the *same* `toolSchema` object — not a copy,
not a subset. A tool lifted from a pack file into a tool file is a copy rather than a translation,
so there is no mapping layer to drift.

**`GET /api/v1/admin/tools/:toolId/export`** renders one, for any tool including a file-backed one
— those bytes are already public in the repository, and a shipped tool is exactly what an operator
wants to send a colleague. **`POST /api/v1/admin/tools/import`** takes one back, writes
`sourceFile: NULL`, and refuses an id a file-backed tool owns.

**`bootstrap` stays in the shared shape, and `parseToolFile` refuses `true`.** The field is part of
`toolSchema` and therefore part of both formats; the steps it marks are ones the runtime guarantees
before any plan runs, which is not something a person imports. The refusal reuses the wording of
`lint.ts`'s existing `reserved-field` rule, so a pack author and an importer are told the same
thing in the same words.

**Import takes pasted or uploaded text only — there is no `{ url }` arm.** This is the one place
the two formats deliberately differ. *(Superseded by
[ADR-0022](0022-a-tool-can-be-imported-from-a-url-now-that-tools-carry-provenance.md), issue #299:
the arm exists now that the `tools` table has the provenance columns to record where a URL import
came from — which is exactly what this clause said was missing.)*

## Consequences

A tool reaches a box **only through a pack** (owner ruling, issue #295). Registering a tool makes
it available to put in one; it does not deploy anything. `servers.tools` remains an explicit
per-server selection and now validates its ids at create time rather than silently dropping the
ones it cannot resolve — the plan resolver's leniency is correct for a *render* of an old row and
was wrong as the answer to a *fresh request*, which had been launching and billing a machine that
installed less than was asked for.

The strict schema means an unknown key is a loud refusal on import rather than a silently dropped
promise. That matters most for `alwaysInstall`, the column
[issue #295](https://github.com/amroja-biz/rockysurf/issues/295) proposes: a tool file naming it
must fail rather than import a tool that believes it will be installed everywhere and is not.

That column shipped in [ADR-0020](0020-modifying-an-official-pack-forks-it.md), and the refusal
predicted here holds by construction rather than by a new guard: `alwaysInstall` was added to the
request bodies and never to `toolSchema`, so the tests written here passed unedited.

A tool file records no provenance, and none is faked. *(Still true of the file itself under
[ADR-0022](0022-a-tool-can-be-imported-from-a-url-now-that-tools-carry-provenance.md): the file
carries nothing, but a tool **imported from a URL** now has the installation record where it was
fetched from, in columns the file never sees.)*

## Alternatives considered

**Make `pack` optional in `packFileSchema`.** Rejected: this is the option that actually breaks
ADR-0004's freeze. `packFileSchema` is a `strictObject` whose `pack` every reader dereferences
unconditionally — `loader.ts` reaches for `pack.packId` to compare against the filename before
anything else runs — so making it optional obliges every consumer of a pack file to learn that its
pack might be absent, in exchange for saving one small schema. A sibling costs one object and
changes nothing that already works.

**Wrap the tool in a single-tool pack.** Rejected. It needs a `packId` and a `displayOrder` that
mean nothing, and on import that invented pack appears in the operator's pack picker — a piece of
scaffolding presented as a product. `pack.tools` is also `min(1)`, so the shapes genuinely differ:
a pack must install something, while a tool file is a definition and installs nothing by itself.
The wrapper pack survives as a *verification* device — `references/verifying.md` in the
`register-a-tool` skill generates a throwaway one to run the real Docker harness against — which is
the right place for scaffolding: a temp directory, deleted afterwards.

**An import-from-URL arm, mirroring the pack import.** Rejected for v1. A pack that arrives from a
URL records where it came from — `registrySource`, `registryUrl`, `registrySha256`, `registryTrust`
— because [issue #88](https://github.com/amroja-biz/rockysurf/issues/88) established that "where did
this shell that runs as root on my boxes come from?" is the question an operator needs answered.
The `tools` table has no such columns. A URL import would install root-privileged shell while being
structurally unable to say anything true about its origin, which is the #88 problem restored at a
finer granularity. Adding the columns is its own change; until then, the file travels by hand.
*(That change landed:
[ADR-0022](0022-a-tool-can-be-imported-from-a-url-now-that-tools-carry-provenance.md) (issue #299)
added the columns and then the arm on top of them. The rejection here was always "not without the
columns," never "not ever.")*

**Reusing `tools.bootstrap` to mean "install everywhere".** Rejected, and recorded here because it
is the tempting shortcut: it is reserved by the schema comment, by `lint.ts` and by the tool form,
it runs in the wrong phase (before the base toolchain), and a `bootstrap: true` tool cannot be put
through the smoke harness at all. See issue #295.

**A per-user tools registry.** Rejected on issue #192: there is no non-admin population to design
for, so a `userId` column would describe a scoping that does not exist.
