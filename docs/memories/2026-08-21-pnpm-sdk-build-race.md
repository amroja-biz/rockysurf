---
KEY: pnpm-sdk-build-race
DATE: 2026-08-21
UPDATED: 2026-09-01
STATUS: active
SOURCE: bd remember, migrated 2026-08-21
---

# Shared-worktree build races: a stale dist/ can look like a real bug

Packages that build via `clean && tsc` empty their `dist/` directory before rewriting it. In a
workspace where one package's build can run concurrently with something reading another package's
output (a shared checkout, a CI matrix, etc.), that creates two failure modes:

1. `dist/` momentarily absent → an obviously infrastructural failure ("failed to resolve entry for
   package X").
2. `dist/` present but **stale** relative to in-flight source changes → a failure that looks
   completely real. A test that spawns the built CLI (`dist/bin.js`) can fail with plausible
   assertion errors on stale error strings or exit codes, and get reported as a genuine defect.

**Mitigation used in this repository:** every publishable package builds through
`scripts/build-package.mjs`, which compiles into a separate `dist.build/` directory and then
**renames** it over `dist/`. That shrinks failure mode 1 from "the whole compile duration" down to
"the gap between two rename syscalls" — not a realistic window to land in — and turns failure mode
2 into an all-or-nothing swap: a reader sees the complete old tree or the complete new one, never a
half-written mix. A failed compile leaves the previous `dist/` standing, so a broken build alone
can no longer produce a code-free tarball; `scripts/verify-tarballs.mjs` asserts `dist/` is
non-empty in every published tarball as a backstop.

**Rule that still applies:** in a shared or concurrent build environment, prefer running a full
recursive build before trusting a top-level check command, and re-run a package's own tests before
reporting a failure in a package you didn't touch — staleness relative to someone else's in-flight,
uncommitted source isn't something tooling alone can fully rule out.

**For new packages:** a test-only package that resolves its dependencies from *source* rather than
`dist/` is immune to this whole class of issue by construction. `provider-conformance` does this
deliberately — see the comment in its `package.json`.

## Amended 2026-09-01 (#307): a third failure mode the rename does not cover

Everything above is about **readers of `dist/`**, and for them the atomic rename is a complete
answer. It is not an answer for anything that **enumerates the repository**, because the scratch
directories are real directories for the length of a compile:

3. A walk of the source tree descends into `dist.build/` (or `dist.prev/`), collects paths, and
   then throws `ENOENT` on reading one — because the build renamed the tree into place underneath
   it. Nothing is wrong with the repository; the file it wanted still exists, under `dist/`.

This showed up when `pnpm run check:parallel` began running package suites concurrently on
purpose. `packages/core/src/ssh/routes.test.ts` walks the whole repository to prove
`StrictHostKeyChecking=no` appears nowhere executable, and
`packages/rockysurf/vitest.global-setup.ts` rebuilds the binary before that package's suite — so
the walker met the builder. The skip list had `dist` but not the two transient names beside it.

**The rule:** anything that walks the repository skips `dist.build` and `dist.prev` as well as
`dist`. They are not merely uninteresting, like `node_modules`; they are *ephemeral*, and reading
them is a race by construction. Both names are fixed on purpose (`scripts/build-package.mjs`
explains why) so they can be skipped by name.
