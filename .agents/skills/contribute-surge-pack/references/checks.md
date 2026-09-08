# The gate, in full

Read this before running step 2 of `SKILL.md`, and again when something fails. Every command
here is the one the shop's CI runs, with the same flags, so a green run locally is a prediction
rather than a hope. The workflows are `.github/workflows/pack-pr.yml` (lint, the index
comparison, and the per-architecture check) and `.github/workflows/disclose.yml` (the
description comment) in the shop.

Throughout, `rs` stands for the harness:

```bash
rs() { npx -y rockysurf@0.1.0 "$@"; }
```

and every command runs from the root of the **shop** clone, with the pack file already at
`packs/<packId>.yaml`.

## Exit codes, for all of them

| exit | meaning |
|---|---|
| 0 | clean |
| 1 | the pack failed the check — a finding, and the thing to fix |
| 2 | the check could not be run at all: no Docker daemon, the wrong directory, a `--pack` id matching nothing |

**A 2 is not a pass.** It is the code that gets misread, because the output above it often looks
like a run that simply had nothing to do. Check for it explicitly.

## 1. The name

CONTRIBUTING's "Where your file goes": one pack, one file in `packs/`, named for its `packId`.

`pack lint` enforces the mechanical half, and its message names both sides:

```
wrong-name.yaml: [format] packId "ripgrep-demo" does not match the filename — rename one so they agree
```

It is worth checking before you run anything, because of what a mismatch would do further down
if it ever got past: the shop's CI derives the pack id from the *filename* (`basename`, extension
stripped) and then runs `pack check --pack <that>`, so the check job would match no pack and exit
2 — the code that means *the check could not be run*, next to a lint that had already gone red
for a different-sounding reason.

The rest of CONTRIBUTING's "Naming" is a judgement, not a command: name the pack for what it
does; do not name it so it reads as an official Rocky Surf pack; do not use the Rocky Surf name
or logo as your own branding. Nothing in the shop is an official pack — those ship inside the
release. Rocky Surf's `TRADEMARK.md` governs the shop too, and accurate descriptive references
like "a Surge Pack for Rocky Surf" are explicitly fine.

## 2. `pack lint` — the whole registry, statically

```bash
rs pack lint packs
```

A second, no Docker, and cheap enough to run after every edit. It validates the frozen v0.1
schema, ids, cross-file references and the mechanical half of the four author rules, **across
every pack in the directory** — which is the point: a duplicate `toolId` or a dangling reference
is a failure of the registry, not of one file, and a per-pack check cannot see it.

CI adds `--allow-empty`, because a registry is legitimately empty until its first contribution
merges. **You should not pass it.** For someone running the command by hand, an empty result
means a mistyped path, and that is a message worth getting.

## 3. The tool-definition rules

From CONTRIBUTING's "Your pack defines its own tools", which is the thing people get backwards on
first contact:

- **A pack may install anything.** A Tool is an id you choose, a description and a shell script
  you wrote. There is no approved list, nothing has to be added to Rocky Surf first, and no
  maintainer has to have heard of it. A pack introducing software this project knows nothing
  about is the *normal* case.
- **The shared plumbing is referenced, never redefined.** `build-essential`, `curl`, `git`, `gh`,
  `tmux`, `unzip`, `nodejs`, `jq`, the Python bits: those are defined in Rocky Surf's own
  `packs/claude-code.yaml` and listed by id in `pack.tools`. Redefining one is refused —
  partly mechanical (a control plane loads its whole catalog together, so a pack that redefines
  `git` can break the catalog for anyone who has both installed) and mostly about review (a
  maintainer should never have to work out whether your `curl` is the real one).
- **Wanting one of them to behave differently is fine** — give it your own id and define it. That
  is allowed, and it is honest about what it is.

`pack lint` refuses a duplicate id, and names the file that got there first:

```
broken-demo.yaml: [duplicate-tool] toolId "git" is already defined by claude-code.yaml —
reference it by id instead of redefining it, or the two definitions collide wherever both are loaded
```

So most of this is enforced. What it cannot see is a script
copied out of a base pack under a *new* id: mechanically legal, and the first thing a reviewer
will ask about. Read the diff for it and have the answer ready in the pull request body.

## 4. `pack check` — the run-twice container, both architectures

```bash
rs pack check packs --pack <packId> --arch arm64
rs pack check packs --pack <packId> --arch amd64
```

A few minutes each, and it needs a Docker daemon. What it does, and why it is stricter than a
laptop: it starts a **stock `ubuntu:24.04` container** — no convenience packages, empty apt
lists, no `sudo` — creates an unprivileged `rocky` user, runs the pack's real install plan, then
**deletes the resume journal and runs the whole thing again in the same container**.

That deletion is the entire test. Rocky Surf's on-box agent resumes an interrupted install by
skipping every step already marked done, so re-invoking it without clearing the journal proves
nothing. With the journal gone every script runs again for real, and the second run must exit 0
and leave `/home/rocky/.bashrc`, `/root/.bashrc` and `/etc/apt/sources.list.d/` **byte-identical**.

**Both architectures, and a pass on one is not a result.** CI runs `amd64` and `arm64` on native
runners and fails the pull request if either fails. There is no amd64-only pack. If this machine
can only run one of them, say exactly that in the pull request body rather than implying both.

`--keep` leaves the container and logs behind when you need to look inside one.

### What fails, and what it means

| Symptom on run 2 | Cause |
|---|---|
| `.bashrc` not byte-identical | an unguarded `>>`. Guard every append with `grep -qF … \|\| echo …` |
| `sources.list.d` not byte-identical | an apt repository or key written unconditionally. Write it only when absent |
| exit non-zero on run 2, fine on run 1 | the script assumes something the first run created and the second run cannot recreate — a directory it makes with `mkdir` rather than `mkdir -p`, a `git clone` into a path that now exists |
| a step failed with "command not found" | the box is stock: it has nothing you did not install or reference. `curl` is a base id to list, not an assumption |
| a `runAs: rocky` step failed on permission | it wanted root. That is two Tools, not a `sudo` — the container has none, and neither does a real box |
| "nothing was skipped as already-done" absent | the journal was not discarded and the run proved nothing. It is checked; you should not see this |

Anything deeper than this table is `create-surge-pack`'s `references/verifying.md` — the pack is
being *authored* again at that point, which is that skill's job, not this one's.

## 5. The index — what "the pull request carries its own index update" means

```bash
rs pack index --source packs --out index.json
```

Instant, and the one people forget. `index.json` is the listing every Rocky Surf control plane
reads: a pack that is not in it reaches nobody. Each entry records the pack's path and a
`sha256` of the file.

**Two different things regenerate it, and they are not alternatives.**

- **`pack-pr.yml`'s `lint` job compares.** It regenerates into a temporary file and diffs it
  against the committed `index.json` with `generatedAt` stripped. It never writes anything. A
  pull request that does not carry a regenerated index fails there, with the command to run.
- **`index.yml` regenerates on push to `main`, after a merge, and commits.** That is `main`'s
  safety net — it also proves the merged registry can be indexed at all — **not the
  contributor's step**. When the pull request carried its index, that run finds nothing to commit
  beyond `generatedAt` and says so. Leaving it to do the work means `main` publishes a stale
  index for however long the pull request sits open, which is the state CONTRIBUTING is refusing.

So: regenerate and commit `index.json` alongside the pack, always.

**Regenerate as the last edit.** The recorded `sha256` describes the file as it was when the
index was written, so editing the pack afterwards leaves a digest describing the previous
version — a state where `pack lint` and `pack check` both still pass and only CI's index step
fails. That is the whole failure mode, and it costs a review round every time.

Run CI's own comparison before you push. `generatedAt` moves on every run and is not part of what
you are being asked to keep in step, so a moved timestamp alone is not drift:

```bash
rs pack index --source packs --out /tmp/index.expected.json
diff -u <(jq -S 'del(.generatedAt)' index.json) <(jq -S 'del(.generatedAt)' /tmp/index.expected.json)
```

Do not hand-edit `index.json`, ever. A hand-edited index describes files it no longer matches,
and it is the client-visible half of the registry.

## 6. `pack describe` — what CI will say about the pack in public

```bash
rs pack describe packs --pack <packId> --markdown
```

Not a gate: nothing here can fail. The shop's `disclose` workflow runs exactly this on every
changed pack and posts the result as one comment on the pull request, updated in place. It says
how many steps the pack runs, how many run as root, every URL its scripts fetch, and the scripts
it introduces in full — the same derivation a control plane shows an operator before they consent
to an install.

Run it before you open the pull request, for two reasons. Its URL list is what the body owes a
reviewer, and it is the cheapest possible place to notice "this downloads from somewhere I did
not expect" — cheaper than review, and much cheaper than a user noticing.

The list carries a caveat that travels inside the rendered output and must be kept when you quote
it: it is read out of the scripts, so a URL built from a variable does not appear. **The scripts
are the ground truth.**

## What none of this proves

An `installScript` is arbitrary shell that runs as **root** on other people's machines. No schema
check and no pattern match can decide whether it is benign, and nothing in the shop claims to.
`pack lint` and `pack check` prove that a pack is well-formed and survives a resume — nothing
more. What carries the rest is a maintainer reading the scripts, the label an operator's own
config puts on this registry, and the control plane showing them every script verbatim before
they consent to run it.
