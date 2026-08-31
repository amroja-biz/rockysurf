---
KEY: branch-protection-and-pr-workflow
DATE: 2026-08-31
UPDATED: 2026-08-31
STATUS: active
SOURCE: session decision
---

Main is protected on both `rockysurf` and `rockysurf-shop`: an active `protect-main` ruleset
requires a pull request for every change, and blocks force pushes and branch deletion. Nobody —
owner accounts included — pushes to main directly anymore, and the bypass lists are deliberately
empty on `rockysurf`. Direct-to-main commits with `[skip ci]` (the old pass-along habit) are
dead twice over: the push itself is refused, and a commit that skips CI could never satisfy the
required checks anyway.

On `rockysurf` the ruleset also requires four status checks: **Test, Typecheck, Secret scan,
What changed**. These are exactly the CI jobs that run unconditionally on every pull request.
The path-conditional jobs (Lint (structure), Release tarballs, BYO lifecycle) must never be
added as required: they satisfy the rule when they report "skipped", but a job that is
workflow-level path-filtered — or a matrix job, whose reported names vary — never reports at
all on some PRs, and a required check that never reports deadlocks the merge forever. That is
why `rockysurf-shop`'s ruleset has no required checks: its PR jobs only trigger on `packs/**`.

The shop ruleset has one bypass actor: **deploy keys**. The `index publisher` deploy key exists
solely so `index.yml`'s regenerate job can push `index.json` to main after a pack merge; its
private half lives only in the shop's Actions secret `SHOP_INDEX_DEPLOY_KEY` (wired into the
workflow's checkout by shop PR #8). Anyone holding that key can push to the shop's main, so
repo-secret access there is equivalent to merge rights.

The working process for any change to `rockysurf`, including a one-line copy tweak:

```bash
git fetch origin
git checkout -b <fix|feat|copy>/<slug> origin/main
# edit, then:
git add <files> && git commit -m "..."
git push -u origin <branch>
gh pr create --fill
gh pr merge --auto --squash
```

`--auto` merges the PR the moment the required checks pass (~4 minutes; Test is the long pole)
and works because `allow_auto_merge` and `delete_branch_on_merge` were enabled on 2026-08-31 —
both were off by default, and `gh pr merge --auto` fails outright on a repo without the former.
Branch from `origin/main`, never local `main`: local main can no longer receive pushes and
drifts stale. Merged branches delete themselves.

Two recurring traps ride along with this workflow. Landing-page and other UI copy is pinned by
wiring tests (`HomePage.test.tsx` and friends): a reword that touches a pinned phrase must
update the matcher in the same PR, or Test blocks the merge — the fix is always the matcher,
never reverting the prose. And required-check names are CI job *display* names; renaming a job
in `ci.yml` silently orphans the ruleset's requirement and blocks every PR until the ruleset is
updated to match.
