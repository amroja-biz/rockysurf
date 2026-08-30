---
KEY: plain-spoken-pr-comments
DATE: 2026-08-30
UPDATED: 2026-08-30
STATUS: active
SOURCE: owner ruling, PR #251
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
