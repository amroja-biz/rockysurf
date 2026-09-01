---
KEY: plain-spoken-pr-comments
DATE: 2026-08-30
UPDATED: 2026-09-01
STATUS: active
SOURCE: owner ruling, PR #251; extended by owner feedback on PRs #312/#314
---

Every pull request an agent opens gets a plain-spoken comment, posted right after the PR is
created, so the owner can understand what was done without reading the technical body. This
applies to the orchestrator's own PRs as much as to worker agents'.

The comment leads with **"The short version, for the human administrator"** and answers, in
short plain sentences: what this change does, what happens if it is merged right now, what (if
anything) the human must do afterwards, and what it costs if it costs anything. No jargon, no
unexplained acronyms, no selling. If setup is required, the answer should be a command to run,
not a list of steps to copy and paste — see the ruling below.

The ruling came on 2026-08-30, on PR #251 (the Azure nightly leg). The PR body was thorough and
correct, and the owner could not use it: "PR 251 spews so many words that it's nearly impossible
to understand why you did. That's ok but you MUST include a comment in the PR that describes in
very simple terms what now happens and what, if anything, the human administrator needs to do."
And on the six-step manual setup that comment initially summarised: "There's no reason I should
have to copy/paste things into the terminal … write me easy-to-run scripts … All I should have
to provide is my creds." The PR body stays technical — it is for reviewers and for the record.
The comment is for the person who merges. Examples: the comments on #251 and #252.

A second ruling arrived on 2026-09-01, on the comments for PRs #312 and #314. Plain language is
not enough; the comment must also be written for the right audience: **the owner merges PRs and
directs agents — they do not run tests, run setup commands, or arbitrate between tools.** The
failures that prompted this: a "run it yourself" setup command the owner would never need
("you're running these tests for me. If there's a command that has to be executed on my machine,
then I would like you to tell me explicitly that I should run it"); an internal trust rule
between two test gates ("I don't know what I'm supposed to do with that information because I'm
not the one running the tests, the agents are"); and a reassuring paragraph about quarantined
tests that read as a warning ("this paragraph makes me concerned without giving me actionable
information. If something is broken or needs my decision, ask me directly").

So, concretely:
- The "what the human must do" section is binary and explicit: either "Nothing — merging is the
  whole job" or an imperative "You must run X on your machine, because Y." Never an optional
  "if you want to run it yourself".
- Anything the owner is supposed to act on later gets a GitHub issue (or an explicit question in
  the session), not a "remember to" paragraph in a PR comment. A comment is not a tracker.
- Operator-level detail — how gates relate to each other, quarantine mechanics, internal
  verification rules — belongs in the PR body or docs for whoever operates the tooling, not in
  the administrator comment. If a paragraph neither requires action nor changes the merge
  decision, it does not belong in the comment.
- Nothing in the comment may read as a warning unless it actually requires a decision; if it
  does require one, ask the owner directly instead of embedding it.
