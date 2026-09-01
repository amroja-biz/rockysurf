# ADR-0020: Modifying an official pack forks it, and a tool can ask to be on every box

## Status

Accepted — 2026-09-01. Issue #295, spun out of #289. Builds on
[ADR-0004](0004-packs-as-pr-able-yaml.md) (files are the source of truth, the database is a cache
and edit layer), [ADR-0006](0006-pack-registry-split-horizon.md) (only the operator says what is
trusted, and provenance gets its own columns) and
[ADR-0018](0018-a-tool-file-is-a-sibling-of-a-pack-file.md), which named `alwaysInstall` in advance
as the field that must fail on import.

## Context

Two questions came out of the tool-registration work in #289, and neither had an answer.

A tool reaches a box **only through a pack** — that was the owner's ruling on #289, and ADR-0018
records it. Registering a tool therefore deploys nothing at all. What was missing was the next
step: having registered one, how do you put it on a box? The honest answer was "edit a pack", and
the packs people actually want it in are the official ones, which cannot be edited: `syncPacksToDb`
rewrites every file-backed row from disk on every boot, so an edit made in the UI is gone at the
next restart.

The second question was the owner's own, and it is where the ruling comes from:

> If a user modifies an official surge pack, it becomes a personal version. I think of it like a
> forked repo. Therefore, personalized official surge packs should show up in the Personal surge
> pack page and the official surge pack icons should be visible in the tab but should have a visual
> indicator that it has been modified.

They also asked that a personal tool be addable to chosen packs, and to **all** packs, easily.

## Decision

### Modifying an official pack forks it, and the fork remembers what it forked

Most of this shipped in #204: `StartFromExistingPanel` already derives a personal pack from any
installed pack, seeded from the source's tool **ids**, so the fork keeps tracking the official
tools' scripts as they are updated and only its membership list freezes. What was missing was the
record: a derived pack had no link to its source, so nothing could say "this is your version of
that".

**A `packs.derivedFromPackId` column, recorded at fork time.** A pack id string, with **no foreign
key** — the boot reconcile deletes and recreates every file-backed row on each start, so an FK
would either cascade a user's fork away when a release drops a pack or block the reconcile that
recreates it. It follows ADR-0006's precedent exactly: provenance gets its own column, never
`sourceFile`.

Inferring the relationship instead was weighed and rejected twice over. The `-copy` id and
`(copy)` name are both editable in the form before the fork is saved, so neither survives contact
with a person who renames things. Inferring structurally, from an overlap in tool lists, cannot
tell a one-tool fork from a coincidence and re-decides the question on every render.

**It is provenance, not a sync relationship.** It records where a pack BEGAN. Nothing syncs,
nothing offers an update, and the word "modified" is deliberately not what the UI says: nothing
modifies an official pack. When the parent changes, the fork is unaffected in the way that matters
and already up to date in the way that counts — it references tool ids. When the parent is dropped
from a release, the dangling id stays exactly as it is, because it is still the only true record
of where the pack came from; every reader checks before dereferencing, and the pack's own page
names the missing parent rather than going quiet.

**One hop.** A fork of a fork points at its own parent and no further. Nothing walks a chain, and
there is no reverse link on the parent — the mark on an official pack's card is derived in the
browser from the list it already has, which is what makes it self-healing: delete the fork and the
mark goes with it, with no count to invalidate.

### The delta, and where the artwork may travel

A fork **inherits its parent's `imageUrl`**, with a small bright delta over the top right of the
mark (owner's ruling). That is what makes a fork recognisable at a glance on the Personal tab
rather than looking like an unrelated pack that happens to hold the same tools. The same delta
appears on the parent's own card, saying a personal version of it exists and naming it — naming
rather than asserting a bare relationship, so the claim is checkable and so a reused pack id cannot
make the mark say something false.

It is a mark on the icon and **not a second badge**: the card deliberately spends itself on the
mark, the name and one badge (issue #192). It is decoration only. Nothing filters, disables or
intercepts a click, so the Official tab stays pristine and every official pack stays exactly as
selectable as before — and nothing is ever written to the official row, which the reconcile would
erase anyway.

**An exported fork carries no inherited artwork.** Provenance does not export — `derivedFromPackId`
is not in `packSchema` and never was — so the delta cannot be drawn on the far side, and official
artwork with no delta, on an installation that never forked anything, is a personal pack wearing a
first-party face. That is ADR-0006's concern about who gets to look official, arriving by the back
door. The recipient gets the monogram every from-scratch pack gets. The rule keys off the fork
relationship rather than off the image, because by the time it reaches the row an image the
operator chose is indistinguishable from an inherited one — and of the two possible mistakes,
withholding an image someone picked is recoverable in a text editor while shipping borrowed
official art is not.

### "Add it to all packs" is one flag, not a loop over packs

**A `tools.alwaysInstall` boolean, unioned into the resolved tool list in `resolvePack`, AFTER its
three-way branch.** The branch has three outcomes — an explicit per-server selection, the pack's
own list, or no pack at all — and "install this on every box I create" means all three, so a union
written inside any one of them is a rule with two silent holes in it. It goes there rather than in
`resolveInstallPlan` so that function stays a pure function of its inputs; `resolvePack` is the
seam that already knows about the database and the only place the three outcomes meet. The
resolver's existing phase 2 drops disabled rows and de-duplicates for free, ordering is unaffected
(steps sort by `installOrder` then `toolId`), and `PLAN_VERSION` stays 1 because no field is added
to the plan.

Writing the tool into all ten official packs instead would fork all ten — the outcome this issue
exists to avoid — and a personal pack made tomorrow still would not have it.

**Not `tools.bootstrap`.** Recorded again because it is the tempting shortcut: it is reserved by the
schema comment, by `lint.ts` and by the tool form, it runs in the wrong phase (before the base
toolchain), and a `bootstrap: true` tool cannot be put through the smoke harness at all.

**`alwaysInstall` is installation state, not file content**, and it is therefore absent from
`toolSchema` — which is what makes both file formats refuse it by construction rather than by a
guard someone has to maintain. `tool-file.test.ts` pinned that refusal in #298, before the column
existed, and those tests pass unedited. A shared file that promised "installs everywhere" would be
making a promise about someone else's machine. A round trip through export and import therefore
lands on `false`, which is the point rather than a rough edge.

It follows that this is **the one field of a file-backed tool an operator may edit**. Everything
else on a shipped tool is rewritten from its YAML at the next boot, so offering to edit it would be
offering an edit that disappears; where a tool installs on *this* machine was never the
repository's to decide. The Tools page's read-only hint now says which half is read-only.

### Two omitted-means-leave-it-alone contracts, both load-bearing

`upsertTool` and `upsertPack` treat an omitted `alwaysInstall` / `derivedFromPackId` as "leave what
is there", the same contract `registry` already had. Neither is tidiness.

`syncPacksToDb` re-upserts every file-backed tool from its YAML on every start and passes no
`alwaysInstall`, because no file format has one — so an unconditional assignment would reset an
operator's choice on every shipped tool at every restart, and reset it *silently*: nothing errors,
the tool stays listed, it simply stops arriving on new boxes.

The admin pack PUT builds a whole row from the form, so an unconditional assignment there would
erase a fork's parent the first time somebody added a tool to it — which is the single most likely
thing anyone will ever do to a fork. This is the `sshPublicKey`/`rdpPassword` scar in
`servers/routes.ts` a second time: a full-row literal quietly dropping a column nobody remembered
was on the row.

### The blast radius is disclosed, twice

An always-install tool runs on **every** box regardless of pack, so it cannot lean on anything a
pack might not have installed — and under [ADR-0010](0010-failed-tool-install-terminates-the-box.md)
a failed tool install terminates the machine. One mis-ordered tool here is therefore every new
server failing, not one. Both the tool form and the confirmation before switching it on say so, in
those terms; the confirmation is given the same care as the delete warning, and for the same reason.

The delete warning exists because core's in-use guard is structurally blind here: it refuses to
delete a tool a pack lists, by scanning `packs.tools`, and an always-install tool is on every box
precisely *without* any pack listing it. The 409 never fires, so the confirmation is the only thing
between the operator and quietly ending an install they set up deliberately.

The create page discloses it too, listing what will be installed whichever pack is picked, minus
anything the chosen pack already lists. Without that, a preview built from the pack alone
understates what is about to run as root on the machine, and disclosing what will run before it
runs is this repository's whole posture on packs.

## Consequences

The Personal tab now holds forks that are recognisably versions of official packs, and the Official
tab is unchanged except for a mark. Both halves of the owner's ruling are served without an
official pack ever being written to.

`pack lint` and `pack check` are unaffected, and that is a property rather than an accident: both
new fields live in the database and in neither file format, so the file remains the whole truth
about what a pack installs, and a pack can still be smoke-tested in CI on a machine with no
installation on it. This is the test the rejected overlay table would have failed — see below.

A fork whose parent has been dropped from a release keeps a dangling id. That is intended, and the
UI is written to expect it.

## Alternatives considered

**An overlay table — database-side additions to file-backed packs.** Rejected on four grounds, and
recorded here because it is the design that looks cheapest. It reopens the deliberately-closed door
on editing official packs in the UI. It is invisible to `pack check`, `pack describe` and export, so
the composition it creates cannot be smoke-tested — the gates would certify a pack that no longer
describes what it installs, with no way to tell. Every pack reader would have to merge or lie,
including the security-load-bearing `describePack`. And it is "amend" where `create-surge-pack`'s
own doctrine says derive.

**Inferring the fork relationship** from the `-copy` suffix or from tool-set overlap. Rejected
above: both are guesses, and one of them re-guesses on every render.

**A `derived_from` join table.** Rejected: one parent, recorded once. A table buys a history nobody
asked for and a second thing the boot reconcile has to reason about.

**Caching the parent's name beside its id.** Rejected: the id is stable and readable, and a cached
name is a second copy that goes stale in silence. The pack's page names a missing parent by id,
which is honest and costs nothing.

**Backfilling parents for personal packs that already exist.** Rejected: nothing recorded them, and
guessing from `-copy` suffixes would invent provenance. Old forks carry no mark, which is the
correct amount to claim about them.

**Marking only official packs, not community ones.** The owner ruled on official packs; community
forks get the mark too, because it is one predicate and an inconsistency would be the surprise.
