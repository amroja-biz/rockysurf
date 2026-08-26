---
KEY: verify-the-checkout-before-you-work
DATE: 2026-08-26
STATUS: active
SOURCE: the Azure real-subscription run (rockysurf-ihtq.8)
---

# Verify which repository and branch you are in before you touch anything

This project has **eleven git worktrees on one machine**, and two GitHub remotes that are easy
to confuse. Several worktrees sit on branches of a repository that is now an **archive**. A
session can open in one of those, look completely normal, and stay wrong for hours.

## What actually happened

A session opened in `~/code/1-open-source-rocky-surf-v0-1`, on a branch of the same name whose
tip commit was six days old. Everything about it looked like a working checkout: the tree built,
the full test suite passed, `git status` was clean apart from the intended edits. Five real bugs
were found and fixed there.

The problem surfaced only at push time:

```
$ git merge-base HEAD origin/main      # (empty — no common ancestor)
$ git rev-list --count origin/main..HEAD
462
```

That branch shares **no history at all** with the public repository. Pushing it would have
dumped 462 commits of internal history — session journals, `.pass-along/` hand-offs, planning
documents — into a public repo whose history was deliberately restarted at v0.1.0.

Worse, the stale checkout was **behind on the code itself**. One of the five bugs
(`rockysurf-1nfc`, a listing that died on a disabled provider's rows) had already been fixed on
`main` by `rockysurf-gg9x`, in a more general way. The fix written against the stale tree was
partly redundant, and its tests asserted a return shape that no longer existed. That was only
discovered by rebuilding and re-running the suite against `origin/main` — a green suite in the
stale worktree proved nothing about the code anyone else would receive.

## The rule

**Before editing, and again before committing, confirm the checkout is current.** One command:

```bash
git rev-list --count origin/main..HEAD && git merge-base HEAD origin/main
```

An empty `merge-base` means unrelated history: you are in the archive. A large count means you
are far from `main` even if the history is shared. Either way, stop and re-cut the branch.

**Do the work on a branch cut from `origin/main`.** When edits already exist in a stale tree,
move them by patch rather than by copying files — the stale versions of those files are usually
*behind* the public ones, so copying silently reverts other people's work:

```bash
git diff HEAD -- <paths> > /tmp/fix.patch
git worktree add -b fix/<topic> ~/code/<dir> origin/main
cd ~/code/<dir> && git apply -3 /tmp/fix.patch
```

Then **rebuild and re-run the full suite in the new worktree.** This is not ceremony; it is the
step that catches the "already fixed upstream" case.

## The remotes, and why they are confusing

For a period, `origin` in these worktrees pointed at `amroja-biz/rockysurf-open` — the **archived,
read-only** private repository — while the live public repository `amroja-biz/rockysurf` was a
second remote named `public-launch`. Because `gh` resolves to `origin` when no `--repo` is given,
every bare `gh issue create` / `gh pr create` targeted the archive and failed with
`Repository was archived so is read-only`.

They have since been renamed so that `origin` is the live repository and `archive` is the old
one. Remotes are shared by every worktree of a repository, so that rename applied to all eleven
at once, and git rewrote each branch's upstream to match. Branches still tracking `archive/*` are
expected: they are branches of the archive, and they cannot be pushed.

**Check `git remote -v` before assuming what `origin` means**, and prefer an explicit
`gh --repo amroja-biz/rockysurf` for anything that creates an issue or a PR.

## The wider point

A stale worktree fails quietly. It builds, it tests green, and it lets you finish hours of work
that cannot be delivered as-is. Nothing in the tree announces the problem — only a comparison
against the remote does. Make that comparison the first thing you do, not the last.
