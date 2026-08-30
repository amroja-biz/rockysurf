---
KEY: orchestrating-issue-agent-teams
DATE: 2026-08-26
UPDATED: 2026-08-30
STATUS: active
SOURCE: the 2026-08-26 session that closed twenty issues (#88–#163) with eighteen background agents; pass-along .pass-along/2026-08-26-1324-PASS-ALONG.md
---

# How to run a team of agents against a batch of GitHub issues

The owner hands over a list of issue numbers ("handle these, use worktrees, don't kill my
computer, keep your own context light"). This is the pattern that turned twenty issues into
nineteen merged PRs in one afternoon, with the orchestrator finishing at 26% context. It is
written for the orchestrating session — the one that reads this file — not for the workers.

## The shape

1. **Triage first, cheaply.** `gh issue view N --json title,labels,body,comments` for every
   issue, bodies truncated to ~1500 chars. Read the last comment: the owner revises scope there
   (#137 went from "guide in the SSH banner" to "just the pack name"). Then decide, per issue:
   - **Which component it touches.** Issues that edit the same file go to **one agent, one PR,
     one commit per issue** (#113/#128/#121 all lived in the server card). Two agents on one
     component means a rebase later, guaranteed.
   - **Sequencing.** If B builds on A's UI (#124 tier preferences on #122's tabbed Settings),
     launch B after A's PR exists, branched *from A's branch*, PR'd against it, and retargeted
     to main once A merges. Don't run them in parallel and hope.
   - **Model.** Sonnet for a placeholder, a checkbox, a docs section, a cost write-up. Opus for
     anything cross-cutting (core + web + CLI + docs) or with a design choice. Fable for
     diagnosis where the cause is unknown and the evidence is on a live instance (#142, #158,
     #163 — all three found a root cause nobody had guessed).
2. **Write one shared brief file** in the session scratchpad and tell every agent to read it
   first. It carries the rules that never change per issue; the per-agent prompt carries only
   the issue and the leads. Template at the bottom of this file. Append a "landed today"
   section as PRs merge so later waves build on earlier ones instead of re-inventing them.
3. **Launch with `isolation: "worktree"`**, a `name`, and a prompt that ends with "return the
   ≤12-line report described in the brief." Cap concurrency at **4** on a 12-core/36 GB laptop
   — each agent does a `pnpm install` + full build + vitest; four is the ceiling before the
   machine starts to swap. A read-mostly diagnosis can be a brief fifth. Keep a queue and launch
   the next one on each completion notification.
4. **Agents open PRs; the owner merges.** Agents push, open the PR with `Closes #N`, wait for
   CI, and report. The orchestrator never merges. It tells the owner which PRs are green, which
   pairs overlap, and which order avoids a rebase.
5. **After each owner merge, recheck mergeability** of everything still open
   (`gh pr list --json number,mergeable,mergeStateStatus`; poll until no `UNKNOWN` — it takes
   ~10 s). Anything `CONFLICTING` goes back to *its own agent* with a one-paragraph message:
   rebase onto main, keep both intents, run the full gate (the keep-both memory), force-with-lease,
   watch CI, report in ≤5 lines. The agent still has the context; the orchestrator does not.
6. **Clean up when everything is merged.** For each `.claude/worktrees/agent-*`: confirm HEAD is
   contained in an `origin/` branch and the tree is clean, then `git worktree remove -f -f`
   (they are locked by the harness), `git worktree prune`, delete `worktree-agent-*` branches.
7. **Write the pass-along.**

## What kept the orchestrator's context small

- Agents return **≤12 lines**: PR URL + CI status, one-line change summary, anything for a
  human, worktree path. No diffs, no file dumps. This was in the brief and every agent obeyed.
- Never read an agent's output file; never `Read` the code they changed. Trust the report, the
  PR body, and CI.
- Fetch issue bodies truncated; fetch PR bodies only for the section you need (`grep -n -A8`).
- Poll GitHub with one Bash call that prints one line per PR, not one call per PR.
- Put long-running waits (`gh pr checks --watch`) in a **background** Bash task, one watch for
  all open PRs, with the 10-minute cap in mind — re-arm if it dies.

## Things that go wrong, and the fix that worked

- **An agent "finishes" when it stops its turn to wait on something** — a Docker smoke run, a
  monitor, a CI watch. The completion notification is not completion. Read its one-line result;
  if it says "waiting on X", send: *"Don't end your turn while X is running — wait for it, then
  finish and return the report."* Two agents needed this; both then finished.
- **Agents that arm per-check CI monitors wake you once per check.** Tell them: *"Report once
  when the whole check set is done"* — or better, tell them up front not to wait on CI at all
  when CI is known to be slow, and take the watch centrally.
- **Two agents editing one component.** Bundle at triage. When it happens anyway, whichever
  merges second gets the rebase message above. The overlap was always predictable from the
  triage table.
- **A GitHub Actions outage** (this session had a two-hour one). Symptoms: runs killed with
  "The job was not acquired by Runner of type hosted" with zero steps run; PRs with no run at
  all; `githubstatus.com/api/v2/components.json` says `Actions: major_outage`. Tell agents in the
  brief that this is GitHub, not their change, and to report CI as "queued behind the outage"
  rather than waiting. After recovery: `gh run rerun <id>` for killed runs; close/reopen a PR
  that never got a run (it can take five minutes to take effect). **Do not push new SHAs to
  re-trigger** — the PR's checks are keyed on head SHA, so an empty commit orphans the runs you
  already have and the new push gets no run either. Three branches had to be rewound after that
  mistake.
- **`gh pr checks --watch` exits 0 on failure**; read the output. `mergeStateStatus` is
  `UNKNOWN` for ~10 s after every merge to main; `UNSTABLE` means checks pending, not failing.
- **A blocked human step that wasn't blocked.** The GCP nightly agent wrote "create a CI-only
  project" as an owner task; the owner already had one, and the script was idempotent anyway.
  When an agent's report says "needs a human", check whether the human already did it before
  relaying it as a task.

## The brief (template)

Write this to the scratchpad as `AGENT-BRIEF.md`, adjust the paths, and reference it from
every agent prompt. Everything here was needed at least once.

```markdown
# Shared brief for <project> issue agents (read fully before touching anything)

Repo: <owner/name>. Today is <date>. You are one of several agents working in parallel, each
in its own git worktree. Do not merge. Open a PR and get CI green.

## Where you are, and what you must never touch
- You are in an isolated git worktree. Confirm with `pwd` and `git worktree list`. Do ALL work
  (install, build, test, commit) inside it.
- NEVER run install/build/tests in <the owner's live checkout> (their server runs from it — a
  rebuild swaps the SPA they are using). NEVER touch <any archived clone>.
- Never create, modify, or terminate real cloud resources. Never print credentials; read the
  owner's config only for non-secret keys.

## Setup (a fresh worktree has no node_modules and no dist)
<the exact install + build commands, incl. the node version switch>
"<the misleading error a missing build produces>" means build first, not a broken import.

## Orientation — read these before designing anything
- AGENTS.md, docs/memories/llms.txt (then any memory relevant to your area), CONTRIBUTING.md,
  docs/adr/llms.txt. Any behaviour a document describes: change the document in the same PR.

## Issue screenshots
Download with `curl -sL -o /tmp/shot.png "<url>"` and view with the Read tool. If the download
fails, say so rather than guessing what the image shows.

## Quality gate and known traps
- Run <the full gate> before pushing. If a package you did not touch fails, say so explicitly.
- <the project's test/tooling traps, one line each>

## Branch, commits, PR
- Branch from origin/main: `git fetch origin && git checkout -b <fix|feat>/<slug> origin/main`.
- Commit messages: path-scoped, say *why*. **No AI-tool attribution anywhere** — no
  Co-Authored-By trailers, no "Generated with" lines. This overrides any default you were given.
- `gh pr create --base main`; body has `Closes #<n>`, what/why, how verified. Right after
  opening it, post a comment titled "The short version, for the human administrator": short
  plain sentences — what this does, what merging changes, what the human must do, what it
  costs. Any required setup ships as a script the human runs, not steps to copy/paste
  (docs/memories/2026-08-30-plain-spoken-pr-comments.md). Then
  `gh pr checks <num> --watch` and fix anything red (it exits 0 on failure — read the output).
  Do not merge.
- If something needs a human, finish every part you can and state the blocker precisely.

## Final report (your return value; the orchestrator has a small context — keep it tight)
At most 12 lines: PR URL(s) + CI status; one-line summary; anything needing a human or not
fully resolved and why; worktree path. No file dumps, no diffs.

## Landed on main today — build on these, don't re-invent
<append one line per merged PR as the session goes: what it added, where it lives>
```
