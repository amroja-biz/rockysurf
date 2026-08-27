# Everyone who runs an installation is its admin — don't design for a member

**Status:** active. Owner ruling, 2026-08-27, during issue #192.

## What happened

Issue #192 asked for a hover popup on official Surge Pack cards carrying **Export**, and for the
pack's YAML on its detail page. Both of those things are admin-only today: the only route that
renders a pack back into its file is `GET /api/v1/admin/surge-packs/:packId/export`, behind
`requireAdmin`. The issue posed the design decision as "either add a non-admin read route for
file-backed packs' YAML (they are shipped files with nothing secret in them — the sensible
answer) or keep those two things admin-only".

A non-admin read route was built, tested and ADR'd. The owner reversed it mid-flight:

> Rocky Surf is self-hosted personal tooling for engineers — every user who runs it is an admin.

So the popup, its Export and the YAML view all read the export route that was already there, and
none of them branch on `isAdmin`.

## The rule that follows

**`isAdmin` is a seam in the code, not a population in the world.** The role exists because core
serves an HTTP API and some of it is dangerous, not because a Rocky Surf installation has two
kinds of user. Do not:

- add a route whose only justification is "so a non-admin can also do this";
- design two versions of a screen, one richer for admins;
- weaken an admin route's authorization to widen its audience.

Do keep the `requireAdmin` middleware and the `/api/v1/admin/*` prefix exactly as they are — they
are what keeps a dangerous route from being reachable by accident, and that value is unchanged.

The public/admin split in the pack API (ADR-0006) is still real for a different reason: what the
PUBLIC list serves is a projection with no filesystem paths, registry URLs or digests in it,
because those are infrastructure detail nobody needs to choose a pack. That is about the shape of
a response, not about who is allowed to ask.

## Cost of getting it wrong

An hour, one route, one ADR and six core tests, all deleted before the PR. The tell was in the
issue itself: the "member" the design was protecting had never been described anywhere in the
product, and `docs/self-hosting.md` addresses a reader who owns the machine, the cloud account
and the bill.
