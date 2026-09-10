---
KEY: pass-along-home
DATE: 2026-08-21
UPDATED: 2026-09-10
STATUS: active
SOURCE: bd remember, migrated 2026-08-21; owner ruling 2026-09-09 ("as long as we have github issues for those things, no need for the pass along") and 2026-09-10 (remove them from the repo, gitignore the folder)
---

# Session pass-alongs are local files, never committed

A pass-along (what a work session did, what's still open, what to do next) may still be written
to `.pass-along/` on the machine doing the work, but the folder is gitignored and nothing in it
reaches the repository. Until 2026-09-10 pass-alongs were committed to `main` and pruned by hand;
the owner removed them because every open item they carried belongs in a GitHub issue, and a
public hand-off note was one more place a secret could leak.

What this means for a session:

- **Open work goes in a GitHub issue**, one per item, before the session ends. A pass-along is
  not a substitute for filing it.
- **Durable knowledge goes in `docs/memories/`** (a lesson, a ruling, a convention) or in an ADR.
- **A pass-along, if written, is for the next session on this machine only.** Expect it to be
  absent on any other checkout, and never point a memory, an issue, or a document at one.
- The no-secrets rule still applies to everything that *is* committed: `docs/memories/`, ADRs,
  issues, pull requests.
