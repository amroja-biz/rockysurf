---
name: contribute-surge-pack
description: Contribute a finished Surge Pack to the Rocky Surf shop — the community registry at amroja-biz/rockysurf-shop — as a pull request that already passes every check its CI runs. Use when someone has a pack file and wants to publish, submit, contribute, share or "get it into the shop"; says "open a PR for my pack", "put my surge pack in the registry", "how do I get my pack to other people", "submit my pack to rockysurf-shop"; or when a pack pull request there has come back red on pack checks, disclose or the index. Runs the shop's own gate locally first — lint, the run-twice Docker check on both architectures, the naming rule, and the index regeneration the pull request must carry — and refuses to open the pull request until each passes. NOT for writing the pack in the first place: that is `create-surge-pack`. NOT for contributing a provider, which is a package of code and a different procedure entirely — that is `add-provider`.
---

# Contribute a Surge Pack to the shop

The shop is [`amroja-biz/rockysurf-shop`](https://github.com/amroja-biz/rockysurf-shop): the
community registry every Rocky Surf control plane reads. A pack merged there reaches other
people's installations without waiting on a Rocky Surf release. Getting one in is a pull request
against that repository — one YAML file in `packs/`, plus the regenerated `index.json` beside it.

Your job here is narrow and mechanical: **take a pack file that already exists and end with a
pull request that a maintainer only has to make a judgement about.** Every question a machine can
answer — is it well-formed, does it survive a resume, does it work on both architectures, is it
named right, does the index match — gets answered on this machine, before the pull request
exists. A maintainer's review round spent on a missing `index.json` is a round nobody gets back.

**You are not writing the pack here.** If the user does not have a working pack file yet, or
wants one changed, that is [`create-surge-pack`](../create-surge-pack/SKILL.md) — the authoring
contract, the four rules, and the smoke harness. Come back when there is a file. If they want to
contribute a *provider* (a package of code that runs inside Rocky Surf, not a YAML file), that is
[`add-provider`](../add-provider/SKILL.md) and a completely different procedure in the shop's
`CONTRIBUTING.md`.

**The normative documents are in two places and neither is this skill.** The shop's
[`CONTRIBUTING.md`](https://github.com/amroja-biz/rockysurf-shop/blob/main/CONTRIBUTING.md) says
what that repository expects; Rocky Surf's
[`docs/surge-pack-contract.md`](https://github.com/amroja-biz/rockysurf/blob/main/docs/surge-pack-contract.md)
is the authoring contract, and
[`docs/writing-a-surge-pack.md`](https://github.com/amroja-biz/rockysurf/blob/main/docs/writing-a-surge-pack.md)
is the guide to it. When either disagrees with what you read here, it wins — say so to the
user and follow it.

## Prerequisites

What has to be on **the user's own computer**. Check all of them before step 1, rather than
discovering at step 3 that the pull request cannot be pushed. If one is missing, tell the user
which and where it comes from — **do not install it for them**, and do not route around it.

| Tool | Why this skill needs it | Check |
|---|---|---|
| Git | the harness is a clone, and the contribution is a branch on a fork | `git --version` |
| Node.js 24+ | the harness is a Node program; Rocky Surf's `engines.node` is `>=24` | `node --version` |
| pnpm | the harness is built from a workspace: `pnpm install && pnpm --filter 'rockysurf...' build` | `pnpm --version` |
| Docker | `pack check` runs the pack twice in a real `ubuntu:24.04` container. Nothing else proves the pack works, and it is the check the shop's CI will run on both architectures | `docker version` (a **Server** line, not just a client) |
| `gh`, logged in | fork, push, open the pull request, and read its checks. It must be authenticated as an account that may fork a public repository | `gh auth status` |
| `jq` | the index comparison below is the same `jq -S 'del(.generatedAt)'` diff the shop's CI runs | `jq --version` |

[`references/prerequisites.md`](references/prerequisites.md) has the install page for each on
macOS and Ubuntu, what a `gh auth status` without fork rights looks like, and what to say when
something is missing.

Everything above is about *this* machine. The `apt-get install` lines inside the pack's
`installScript` run on a Rocky Surf server that starts empty; nothing here installs them locally.

## Step 1 — Get the file, and the harness that judges it

**The pack file.** Ask for its path if you do not have it. Read it, and read
`pack.packId` out of it: that id decides the filename, the branch name, the commit message and
half of the pull request. If the user has no file, stop and go to `create-surge-pack`.

**The harness.** Both checks come from the `rockysurf` CLI, so what you run locally is what CI
runs. Rocky Surf is not on npm yet — the publish is gated behind v0.1.0, and bare `npx rockysurf`
resolves to a placeholder with no `pack` command — so build it from a clone, once:

```bash
git clone --depth 1 https://github.com/amroja-biz/rockysurf /tmp/rockysurf
cd /tmp/rockysurf && pnpm install && pnpm --filter 'rockysurf...' build
```

The binary is then `/tmp/rockysurf/packages/rockysurf/dist/bin.js`, run with `node`. Anchor that
absolute path in every command below — your working directory may reset between tool calls, and
these commands run from the *shop* clone, not this one.

If you are already inside a Rocky Surf checkout, that checkout is the harness; build it in place
rather than cloning a second copy. **This is the pre-release form.** When v0.1.0 publishes, every
command below becomes `npx rockysurf@<version> pack …` and the clone disappears. CI does exactly
the same thing today, in the shop's `.github/actions/pack-harness`.

**Do not pass `--base-packs`.** A built harness carries the packs its own release ships, so the
shared base tool ids a community pack references — `curl`, `git`, `gh`, `nodejs`, `tmux`,
`build-essential` — resolve out of the binary with no flag at all. Naming the flag *replaces*
that default rather than adding to it, which is how a pack that was fine starts failing on a
dangling reference.

## Step 2 — Run the shop's gate, here, and refuse to continue until it passes

The order matters: each check is cheaper than the one after it, and a failure in an early one
usually explains a failure in a later one. **A pack that fails any of these does not get a pull
request.** Tell the user which rule failed and where — the file, the tool id, the line — and fix
it (or hand it back to `create-surge-pack`) rather than opening a pull request that CI will
refuse in public.

Work in a clone of the shop, with the pack file placed where step 3 says it goes, so that every
command below sees exactly what CI will see.

1. **The name.** `packs/<packId>.yaml`, and the filename must equal `pack.packId` — one pack, one
   file. `pack lint` catches a mismatch (`[format] packId "…" does not match the filename`), and
   it matters beyond tidiness: the shop's CI derives the pack id from the *filename*, so a file
   that got past lint under a different name would produce a check job matching no pack, exiting
   2. Then the naming rules from CONTRIBUTING's "Naming", which no tool can check: name it for
   what it does, and never so that it reads as an official Rocky Surf pack or uses the Rocky Surf
   name or logo as branding.
2. **`pack lint packs`** — a second, no Docker. The frozen schema, ids, cross-file references,
   and the mechanical half of the four author rules, across the *whole* registry rather than one
   file: it is the check that catches a duplicate `toolId` or a dangling reference, which a
   per-pack check by construction cannot see.
3. **The tool-definition rules**, from CONTRIBUTING's "Your pack defines its own tools". A pack
   may define any tool it likes — a brand-new tool id nothing has ever heard of is the normal
   case, and nothing needs adding to Rocky Surf first. What it may not do is *redefine* a shared
   base id; those are referenced by id from `pack.tools`. `pack lint` refuses a duplicate, so
   this is mostly lint's job — but read the diff yourself for a script copied out of
   `claude-code.yaml` under a new id, which lint cannot see and a reviewer will ask about.
4. **`pack check packs --pack <id> --arch arm64`** and **`--arch amd64`** — a few minutes each,
   needs Docker. Stock `ubuntu:24.04`, the real install plan, then the resume journal deleted and
   the whole thing run again in the same container. The second run must exit 0 and leave
   `/home/rocky/.bashrc`, `/root/.bashrc` and `/etc/apt/sources.list.d/` byte-identical. **Both
   architectures.** A pack that passes on one and fails on the other fails; there is no
   amd64-only pack, and CI runs both on native runners.
5. **`pack index --source packs --out index.json`** — instant, and the one people forget. Then
   diff it the way CI does. This is the "the pull request carries its own index update" line in
   CONTRIBUTING, and [`references/checks.md`](references/checks.md) explains exactly what that
   means and why the merge-time regeneration is not a substitute.
6. **`pack describe packs --pack <id> --markdown`** — not a gate, but run it now: it is the same
   derivation the shop's `disclose` workflow will post on the pull request, and its URL list goes
   into the pull request body in step 4. Read it before a reviewer does. If it names a URL the
   user did not expect, that is the finding, and it is much cheaper here.

[`references/checks.md`](references/checks.md) has each command in full with the exit codes, what
each one proves and does not prove, and a failure-to-cause table for the ones that fail most.

## Step 3 — Fork, branch, place the file, commit

Follow [`references/pull-request.md`](references/pull-request.md), which has the commands. In
outline:

```bash
gh repo fork amroja-biz/rockysurf-shop --clone     # once; it clones your fork
cd rockysurf-shop
git checkout -b packs/<packId>
cp <the pack file> packs/<packId>.yaml
node /tmp/rockysurf/packages/rockysurf/dist/bin.js pack index --source packs --out index.json
git add packs/<packId>.yaml index.json
git commit -m "packs: add <packId>"
```

**Regenerate the index as the last thing you do**, after the pack file is final. `index.json`
records a `sha256` per pack file, so any later edit to the pack leaves a committed digest
describing the previous version — a state in which `pack lint` and `pack check` both still pass
and only CI's index step fails.

Commit the pack file and `index.json` **together**, path-scoped, and nothing else. A pull request
that also touches a workflow or the README is a different review.

## Step 4 — Open the pull request

[`assets/pr-body-template.md`](assets/pr-body-template.md) is the body to fill in. It says four
things, because they are the four things a maintainer would otherwise have to ask for:

- **What the pack installs** — the tools it defines, and the base ids it borrows.
- **Every URL its scripts fetch**, taken from `pack describe --markdown`, with that command's own
  caveat kept: the list is read out of the scripts, so a URL built from a variable does not
  appear in it, and **the scripts are the ground truth**.
- **How it was tested** — which architectures `pack check` ran on, on what date, and anything the
  checks could not cover.
- **Where the tools come from**, if any of them is a GitHub release asset pinned to a tag — the
  version question CONTRIBUTING's "Review" section says a maintainer will ask about.

```bash
git push -u origin packs/<packId>
gh pr create --repo amroja-biz/rockysurf-shop --base main \
  --title "packs: add <packId>" --body-file <the filled-in body>
```

## Step 5 — Watch the checks once, and fix what is red

```bash
gh pr checks <number> --repo amroja-biz/rockysurf-shop --watch
```

Once, for the whole set — it exits 0 even when a check failed, so read the output rather than the
exit code. Three things run:

| Workflow | What red means |
|---|---|
| `pack checks` → `lint` | the schema, an id, a reference — or **"index.json does not match packs/"**, which is step 2.5 not run or run before the last edit |
| `pack checks` → `check (<id>, amd64/arm64)` | the run-twice container failed. Reproduce it locally with the same `--arch`; do not diagnose it from the log alone |
| `disclose` | it is not a gate and cannot fail your pack — it posts the description comment. A red one is a workflow problem, not yours |

Fix red on the branch and push again; the same jobs re-run. If a job is red for a reason your pack
cannot have caused, say so plainly to the user rather than pushing an empty commit at it.

## Step 6 — Hand it over

End with the pull request URL and this, in one sentence, not softened:

> A maintainer will still read the scripts before merging, because they run as root on an
> operator's server.

That is the whole point of the review the pull request is entering. `pack lint` and `pack check`
prove a pack is well-formed and survives a resume; neither can decide whether an install script
is benign, and nothing in the shop claims otherwise. Tell the user what was actually proven —
which architectures ran, on what date — and what was not.

## Reference files

- [`references/prerequisites.md`](references/prerequisites.md) — the six tools, their install
  pages for macOS and Ubuntu, and what to say when one is missing. Read it when a check above
  came back missing.
- [`references/checks.md`](references/checks.md) — every command in step 2 in full: flags, exit
  codes, what each proves, the index question answered properly, and a failure-to-cause table.
  Read it before running the gate, and again when something fails.
- [`references/pull-request.md`](references/pull-request.md) — fork, branch, place, commit, body,
  and the red-CI triage in detail. Read it at step 3.
- [`references/acceptance.md`](references/acceptance.md) — how this skill itself is verified: the
  live run on a fork, what it must produce, and what the last rehearsal did and did not exercise.
  Read it only if you are changing this skill.
- [`assets/pr-body-template.md`](assets/pr-body-template.md) — the pull request body to fill in.
- [`assets/sample-surge-pack.yaml`](assets/sample-surge-pack.yaml) — the fixture the acceptance run
  contributes. Not a pack to merge.
