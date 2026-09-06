---
KEY: pass-along-home
DATE: 2026-08-21
UPDATED: 2026-09-06
STATUS: active
SOURCE: bd remember, migrated 2026-08-21
---

# Session pass-alongs live in this repository, and they're public

Session hand-off notes ("pass-alongs" — what a work session did, what's still open, what to do
next) are committed to `.pass-along/` in this repository, on `main`.

Because this repository is public, everything under `.pass-along/` is world-readable. The
no-secrets rule is load-bearing, not a formality: no IP addresses, account IDs, tokens, or other
private infrastructure detail belongs in a pass-along. Scan a pass-along for that kind of content
before committing it.

The folder is not append-only. Pass-alongs are pruned periodically (first done 2026-09-06, #339):
anything older than about a day goes, because a pass-along is operational state for the next
session, not a record — what is durable belongs in a memory, an ADR, or `docs/history/DEVLOG.md`.
Expect the oldest surviving pass-along's `PREDECESSOR` to name a file that is no longer in the
tree; that is the prune, not a mistake.
