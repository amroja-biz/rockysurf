# How this skill is verified

Read this only if you are changing this skill. It is not part of contributing a pack.

Every serious defect in the two skills that came before this one was found the same way, and none
of them was visible by re-reading: give a fresh agent the skill and *nothing else*, deny it the
rest of the repository, and have it do the real thing. `add-provider` found sixteen that way
(#410), three of which were wrong instructions rather than gaps. Re-reading a skill tells you
whether it is coherent; a run tells you whether it is true.

## The live run — what the owner runs

**Preconditions.** A fresh agent session, outside any Rocky Surf checkout, given exactly two
things: a copy of `.agents/skills/contribute-surge-pack/` and the path to a pack file. Use
[`assets/sample-surge-pack.yaml`](../assets/sample-surge-pack.yaml) as that pack, copied somewhere outside
the checkout under its own name. The agent gets no other file from this repository, and it must
not read one: the whole point is to find out what the skill fails to say. The machine needs the
six prerequisites, and the `gh` account must be one that may fork a public repository.

**The instruction to the agent** is one sentence, in the user's voice: *contribute this pack to
the Rocky Surf shop.*

**What a pass looks like.**

1. It builds the harness, runs the gate, and reports each result — including both architectures.
2. It forks `amroja-biz/rockysurf-shop` under the owner's account, branches, places the file at
   `packs/<packId>.yaml`, regenerates `index.json` after the file is final, and commits the two
   together.
3. It opens a pull request **against the fork's own `main`, not against `amroja-biz`** — see
   below — with a body that names what the pack installs, the URLs its scripts fetch with the
   derivation caveat intact, and how it was tested.
4. `pack checks` (`lint`, and `check` on both architectures) and `disclose` are **green on the
   first push**, with no fixing round. A second push to make CI green is a finding about this
   skill, and what it says is that the local gate is not the gate CI runs.
5. It ends with the pull request URL and the sentence about a maintainer reading the scripts.

**Then close the pull request and delete the branch.** The sample pack must never merge into the
shop: it is a fixture, it installs a tool nobody asked for, and the registry is a document real
control planes read. Deleting the fork afterwards is tidier still.

**Where to point the pull request.** Base it on the fork's own `main`, so every workflow runs on
a real pull request without proposing a change to the registry. The shop's workflows are all
`pull_request`-triggered and run from the branch's own checkout, so a fork-internal pull request
exercises the same three jobs on the same code. Opening one against `amroja-biz/rockysurf-shop`
would work identically and would also put a fixture in front of the maintainers, which is the one
outcome this run must not produce.

**The negative case, in the same session.** Hand the agent a pack that fails, and watch what it
does with it. Redefining a shared base id is the cheapest way to produce one:

```
broken-demo.yaml: [duplicate-tool] toolId "git" is already defined by claude-code.yaml — …
```

A pass is: **no pull request exists**, and the agent told the user which rule failed, in which
file, and what to do about it. An agent that opens the pull request anyway and lets CI say it, or
that "fixes" the pack by editing somebody else's file, has found a real defect in this skill.

**What the agent's report should contain**, in the shape #410's did: every place the skill sent it
wrong, was ambiguous, was missing, or made it guess — with the file and line — and then what the
skill got right that it would otherwise have got wrong. Both halves matter; the second is what
stops the next edit from removing something load-bearing.

## What the last rehearsal covered, and what it did not

**2026-09-06, on the machine that wrote this skill.** A local clone of
`amroja-biz/rockysurf-shop` at `main`, `assets/sample-surge-pack.yaml` placed as
`packs/ripgrep-demo.yaml`, and the harness built from this repository's own worktree
(`packages/rockysurf/dist/bin.js`), which is what the shop's `pack-harness` action builds.

Exercised, all green:

- `pack lint packs` — `2 file(s), 2 pack(s): aider, ripgrep-demo`, no findings.
- `pack check packs --pack ripgrep-demo --arch arm64` — passed. Run 1 32s, run 2 4s after the
  journal was discarded, `.bashrc` ×2 and `sources.list.d` byte-identical.
- `pack check packs --pack ripgrep-demo --arch amd64` — passed under emulation. Run 1 126s,
  run 2 29s.
- `pack index --source packs --out index.json`, then CI's own comparison
  (`diff -u <(jq -S 'del(.generatedAt)' index.json) <(jq -S 'del(.generatedAt)' …expected…)`) —
  identical.
- `pack describe packs --pack ripgrep-demo --markdown` — the disclosure the shop would post.
- The branch `packs/ripgrep-demo`, the two-file commit `packs: add ripgrep-demo`, and the pull
  request body filled in from the template.
- The negative case: a pack redefining `git` linted **1**, with the message quoted above, and the
  workflow stopped there.

**Not exercised: the fork and the pull request themselves.** No fork was created and no pull
request was opened, deliberately — the owner was working in the shop repository at the time, and
a public fork and pull request are not something to produce as a side effect of writing a skill.
So `gh repo fork --clone`, the push, `gh pr create`, `gh pr checks --watch`, and the claim that
the three workflows go green on the first push are **written from the workflow files rather than
observed**. That is exactly the gap the live run above closes, and it is why the live run is
still owed.
