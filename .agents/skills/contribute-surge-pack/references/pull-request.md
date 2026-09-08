# Fork, branch, commit, pull request

Read this at step 3 of `SKILL.md`, once the gate in `references/checks.md` is green. Nothing here
should be reached by a pack that failed a check: the value of this skill is that the pull request
does not exist until the mechanical questions are answered.

The shop's `main` is pull-request-only, and a contributor has no write access to it. Everything
below happens on a fork.

## Fork and clone

```bash
gh repo fork amroja-biz/rockysurf-shop --clone
cd rockysurf-shop
```

`gh repo fork --clone` creates the fork under the authenticated account if it does not exist,
clones it, and sets `upstream` to `amroja-biz/rockysurf-shop`. If the fork already exists it
clones that one — which is the case on a second contribution, and it may be behind:

```bash
git fetch upstream
git checkout -B main upstream/main
git push origin main
```

Branch from an up-to-date `main`, not from whatever the fork happens to hold. A pack file added
on top of a stale `main` merges fine, but the `index.json` it carries was regenerated against a
`packs/` that is missing whatever landed in the meantime — and CI's index comparison catches it
as drift you did not cause.

```bash
git checkout -b packs/<packId>
```

## Place the file

```bash
cp <the author's pack file> packs/<packId>.yaml
```

One pack, one file, named for its `packId`. Nothing else moves: not the README, not a workflow,
not another pack. If the contribution genuinely needs a second file, that is a second pull
request.

## Regenerate the index, last

```bash
npx -y rockysurf@0.1.0 pack index --source packs --out index.json
```

After the pack file is final — see `references/checks.md` §5 for why the order matters and for
CI's own comparison, which is worth running here before the push.

## Commit

```bash
git add packs/<packId>.yaml index.json
git commit -m "packs: add <packId>"
```

Path-scoped, and the two files together: the index update belongs to the change that made it
necessary, and splitting them produces one commit that fails CI on its own. `packs: update
<packId>` for a change to a pack already in the registry.

Nothing about the authoring tooling belongs in the message. The commit says what changed in the
registry.

## The pull request

Fill in [`assets/pr-body-template.md`](../assets/pr-body-template.md) and pass it as a file
rather than pasting a body through a shell argument — the description output contains backticks
and newlines that a quoted argument mangles.

```bash
git push -u origin packs/<packId>
gh pr create --repo amroja-biz/rockysurf-shop --base main \
  --title "packs: add <packId>" \
  --body-file /tmp/pr-body.md
```

### What the body owes a reviewer

The four sections in the template exist because they are what a maintainer would otherwise have
to ask for, and each round trip is a day:

1. **What it installs.** The tools the pack defines, one line each, and the base ids it borrows.
   A reviewer reading a diff sees YAML; this is the sentence version.
2. **Every URL its scripts fetch**, copied from `pack describe --markdown`, with that command's
   caveat kept intact: the list is derived by reading the scripts and cannot be complete, because
   a URL built from a variable does not appear in it. **The scripts are the ground truth.** Do
   not paraphrase the caveat away — CI posts the same one, and a body that sounds more certain
   than the tool is worse than no body.
3. **How it was tested.** Which architectures `pack check` ran on and when; whether the author
   ran it on a real Rocky Surf box; anything the checks could not cover. If only one architecture
   ran locally, say which, and say that CI runs both.
4. **Where each tool comes from.** CONTRIBUTING's "Review" section says a maintainer will ask:
   anything on a quota-free registry (npm, PyPI via `pipx`) installs **unversioned**; anything
   that ships only as a GitHub release asset stays **pinned to a tag and checked against a
   `sha256`**, because the only endpoint that answers "what is latest" there is rate-limited per
   source IP. Either way: no piping a vendor's `install.sh` to `bash`, and no cache-busting a
   download URL. If the pack does one of those anyway and there is a real reason, the body is
   where the reason goes.

Two more the reviewer will look for, and which cost one line each if they apply: **which steps
need root** (`runAs` declared honestly — a `runAs: rocky` step that reaches for `sudo` fails the
check and would fail the same way on a real box), and **the `guide` field**, which is shown to
the user verbatim and should say what they have to do by hand once the box is theirs.

## Watching the checks

```bash
gh pr checks <number> --repo amroja-biz/rockysurf-shop --watch
```

Once, for the whole set. **It exits 0 even when a check failed** — read the output, not the exit
code.

| Red job | What to do |
|---|---|
| `lint` with `index.json does not match packs/` | regenerate and commit the index; you edited the pack after generating it, or branched from a stale `main` |
| `lint` with a schema, id or reference finding | reproduce locally with `rs pack lint packs`; it is the same command and the same message |
| `check (<id>, arm64)` or `(<id>, amd64)` | reproduce with `rs pack check packs --pack <id> --arch <that one>`. Do not diagnose a run-twice failure from the log alone — the container is reproducible, so reproduce it |
| `disclose` | not a gate and it cannot fail the pack. It posts the description comment. Red here is a workflow problem to report, not something to fix in the pack |

Push fixes to the same branch; the jobs re-run. Do not push an empty commit at a job that is red
for a reason the pack cannot have caused — say so to the user instead, precisely.

## What happens after

A maintainer reads every community pull request before it merges, and reads the scripts, because
they run as root on an operator's server. On merge, the shop's `index.yml` regenerates
`index.json` on `main` — a no-op if the pull request carried it — and the pack is live in the
registry the moment that lands.
