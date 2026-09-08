# Fork, branch, edit, validate, pull request

Read this at step 5 of `SKILL.md`, once the release exists and the digest round trip in
`references/release.md` came back matching. Nothing here should be reached by a Provider that
failed one of those: the value of this skill is that the pull request does not exist until the
mechanical questions are answered.

The shop's `main` is pull-request-only and a contributor has no write access to it. Everything
below happens on a fork.

## Fork and clone

```bash
gh repo fork amroja-biz/rockysurf-shop --clone
cd rockysurf-shop
```

`gh repo fork --clone` creates the fork under the authenticated account if it does not exist,
clones it, and sets `upstream` to `amroja-biz/rockysurf-shop`. If the fork already exists it
clones that one — the case on a second contribution, and it may be behind:

```bash
git fetch upstream
git checkout -B main upstream/main
git push origin main
```

Branch from an up-to-date `main`, not from whatever the fork happens to hold. `providers.json` is
a single file that every Provider contribution edits, so a stale base is how a pull request
silently proposes deleting somebody else's entry.

```bash
git checkout -b providers/<providerId>
```

## Add the entry

One object, appended to the `providers` array of `providers.json` — the object
`rockysurf-shop-entry` printed, unedited. Then set `generatedAt` at the top of the file to now, in
the same ISO-8601 form it already has.

By hand in an editor is fine. Scripted, so nothing is retyped:

```bash
node -e '
const fs = require("node:fs")
const listing = JSON.parse(fs.readFileSync("providers.json", "utf8"))
listing.providers.push(JSON.parse(fs.readFileSync(process.argv[1], "utf8")))
listing.generatedAt = new Date().toISOString()
fs.writeFileSync("providers.json", JSON.stringify(listing, null, 2) + "\n")
' /path/to/entry.json
```

**Updating an existing entry** rather than adding one — a new version of a Provider already listed
— is the same thing with `push` replaced by finding the entry with the same `providerId` and
replacing it whole. Replacing it whole, not patching `version`, `tarball` and `sha256`: the
settings summary and the capabilities may have moved too, and the generated entry is what the
artifact says now.

Nothing else in the repository moves. Not the README, not a workflow, not `packs/`. If the
contribution genuinely needs a second file, that is a second pull request.

## Validate

```bash
node scripts/validate-providers.mjs providers.json
```

The first thing the shop's CI runs, and it needs no install — the validator is dependency-free on
purpose. It prints:

```
providers.json: 1 provider entry, all valid
```

or every problem with the field it is in. **Do not open the pull request until it is clean.** What
it checks, and what each finding usually means:

| Finding | Usually |
|---|---|
| `providers[n].<key> is not a field of a provider entry` | a hand-edited entry. The nine keys are fixed; the generator emits exactly those |
| `… — a registry never publishes a trust label` | somebody added `trust` or `tier`. There is no such field, deliberately: a claim about trustworthiness written by the party being trusted is worth nothing |
| `providers[n].providerId does not match …` | the id is not an RFC 1123 label. It is the operator's config section key, so it is lowercase letters, digits and hyphens |
| `providers[n].sha256 does not match …` | not 64 lowercase hex characters — a truncated paste, or the filename `shasum` prints after the digest |
| `providers[n].providerId "x" appears twice` | the entry was appended when it should have replaced an existing one |
| `generatedAt must be an ISO-8601 timestamp` | it was not bumped, or was bumped to a date rather than a timestamp |

The validator is a courtesy pre-check; Rocky Surf's own schema
(`packages/core/src/providers/shop-index.ts`, ADR-0028) is what a control plane will actually
accept. Where the two disagree, the control plane is right and the validator is stale — say so in
the pull request rather than working around it.

## Commit

```bash
git add providers.json
git commit -m "providers: add <providerId> <version>"
```

Path-scoped, one file. `providers: update <providerId> to <version>` for a new version of an entry
already in the registry. Nothing about the tooling that produced the entry belongs in the message;
the commit says what changed in the registry.

## The pull request

Fill in [`assets/pr-body-template.md`](../assets/pr-body-template.md) and pass it as a file rather
than through a shell argument — it contains backticks and newlines that a quoted argument mangles.

```bash
git push -u origin providers/<providerId>
gh pr create --repo amroja-biz/rockysurf-shop --base main \
  --title "providers: add <providerId> <version>" \
  --body-file /tmp/pr-body.md
```

### What the body owes a reviewer

The shop's CONTRIBUTING asks for one thing by name — **the link to the source repository** —
because reading that source is the only review a Provider gets. The template asks for four more,
each because a maintainer would otherwise have to, and each round trip is a day:

1. **Where the source is**, and at which commit the conformance suite passed.
2. **What the Provider talks to**, and with what credential: the cloud, the API, and where the
   token comes from. An operator's first question about a new Provider is what leaves their
   machine.
3. **What was verified, and how.** The suite that ran, whether it has been pointed at real
   infrastructure and when, and what the checks could not cover. A Provider nobody has run against
   the real cloud says exactly that; it is not disqualifying, and pretending otherwise is.
4. **The capability answers worth flagging** — chiefly `billsWhileStopped`, which is how somebody
   learns before installing that a stopped machine on that cloud still costs money.

## Watching the checks

```bash
gh pr checks <number> --repo amroja-biz/rockysurf-shop --watch
```

Once, for the whole set. **It exits 0 even when a check failed** — read the output, not the exit
code. One workflow, `provider listing`, two steps:

| Red step | What to do |
|---|---|
| the validator | reproduce locally with the same command; it is the same script and the same message |
| `Every tarball matches the sha256 the listing publishes` | the release asset is not the file the digest describes. Go back to `references/release.md` step 3 and fix the *release*. Never change the digest to match the asset |
| the digest step failing on an entry this pull request did not touch | not caused by this contribution — somebody else's release moved. Say so to the maintainer in a comment rather than editing their entry |

Push fixes to the same branch; the job re-runs.

## What happens after

A maintainer reads every Provider pull request before it merges, and reads the Provider's source,
because it runs inside an operator's control plane with that process's database, master key and
every cloud credential in its environment. There is no build and no index step: on merge the entry
is live, and operators take `package`, `tarball` and `sha256` from it and follow the shop README's
[Installing one](https://github.com/amroja-biz/rockysurf-shop#installing-one) with their own
hands.
