---
KEY: small-changes-run-only-relevant-checks
DATE: 2026-09-05
UPDATED: 2026-09-05
STATUS: active
SOURCE: owner ruling, 2026-09-05 session, while a docs-only skill rename (#387) sat waiting on the full check:parallel gate
---

For a relatively small change, run only the checks that can see it, and let CI on the pull
request be the full gate. Small means a change whose blast radius is obvious from the diff: a
docs-only edit, a rename, copy or help-text changes, a config or lint tweak, a single-file fix
with its own tests. For those, run the lint that covers the files you touched (the skills-index
check for `.agents/skills/`, the docs link checks for `docs/`), the unit tests of the one package
you changed, and a grep that proves the old name or string is gone. Do not run
`pnpm run check:parallel`, and do not run `pnpm run test:ui` unless the change touches
`packages/web/`.

The reasoning is cost, not doubt about the gate. The full gate takes about a minute on a warm
tree and far longer in a fresh worktree that has to install and build first, and the browser
suite on top of it runs for many minutes. Every pull request already runs the whole set in CI,
so a local full run for a docs rename buys nothing except a stalled agent and an owner waiting
for a PR that could have been open twenty minutes earlier. The owner's words on 2026-09-05:
"it doesn't need to run every test."

Two things this does not relax. A change that touches core, the provider SDK, the composition
root, or more than one package is not small, whatever its line count, and gets the full gate.
And any keep-both merge conflict resolution still gets the full gate regardless of size, because
the syntax damage it can cause is exactly what a narrow check misses
([keep-both-merge-gate-rule](2026-08-13-keep-both-merge-gate-rule.md)).
