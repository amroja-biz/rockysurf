---
KEY: ui-browser-check-graduation
DATE: 2026-09-01
UPDATED: 2026-09-01
STATUS: active
SOURCE: PR #314; owner delegated the follow-up ("I won't. But you should add a project memory and a note for yourself to check it later")
---

The `UI (browser)` CI job (the Playwright suite from PR #314, issue #310) is always-run but
deliberately NOT in the `protect-main` ruleset's required checks yet. It is new, it boots real
servers and binds real ports, so it gets a few days of green PR runs before it can gate merges.

The graduation is tracked as issue #315: on or after 2026-09-05, if the job has behaved, add
`UI (browser)` to the required checks. If it has been flaky, fix the flake first — never require
a flaky check (the `Test` gate's SettingsPage flake, issue #313, shows what a flaky required
check costs: every firing blocks merges repo-wide). The job is always-run and must stay that
way; path-filtered jobs deadlock required checks (see the branch-protection memory).

The owner explicitly declined to carry this reminder themselves — the agent side owns it. Any
session starting after 2026-09-05: check issue #315 and, if the job's history is green, do the
graduation via `gh api` on the ruleset and close the issue.
