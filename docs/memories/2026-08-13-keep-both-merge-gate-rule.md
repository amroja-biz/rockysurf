---
KEY: keep-both-merge-gate-rule
DATE: 2026-08-13
UPDATED: 2026-08-21
STATUS: active
SOURCE: bd remember, migrated 2026-08-21
---

# Keep-both merge conflicts need a full quality-gate run

When resolving a merge conflict by keeping both sides, the resulting syntax damage can be
invisible to a marker scan or a diff review. Two real examples from this project: two functions
sharing one `/**` doc comment above the conflict marker left the second function's opener
missing; a resolved boundary that fell after a test's last `expect()` attributed the closing
brace to the wrong block.

Both were caught only by the type checker — not by grepping for leftover `<<<<<<<` markers, and
not by reading the diff.

**Rule:** after any keep-both conflict resolution, run the full quality gate (build, typecheck,
tests). A conflict-marker grep proves nothing about correctness.

A related point: the point where two branches get integrated is also where cross-branch gaps get
*fixed*, not just flagged. One integration in this project's history repaired a `Dockerfile` that
had silently lost a workspace-member `COPY` step on another branch — a gap that had been breaking
frozen-lockfile installs.
