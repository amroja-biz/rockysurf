---
KEY: run-pack-url-checker
DATE: 2026-09-01
UPDATED: 2026-09-01
STATUS: active
SOURCE: owner directive, after PR #292 caught a stale tool URL
---

Run `pnpm run check:pack-urls` (`scripts/check-pack-urls.mjs`, added in PR #292) periodically,
and always when creating a new official surge pack — before the pack's PR goes up.

The checker verifies that every tool's user-facing `url:` in the pack files actually resolves.
It exists because nothing else looks at those links: the smoke harness proves install scripts
work, but the home-page URL a user clicks from the UI was unchecked, and the #286 pack audit
found the `beads` tool pointing at a non-canonical repo while its own install script already
used the canonical one ("a redirect is a thing that can be turned off").

It is deliberately NOT a CI gate, because it depends on third-party sites and flakes for
reasons that are not ours — while being written it produced two false positives of its own
(a WAF dropping a browsery user-agent, and Node's 16 KB header cap making a live page look
dead). So it only helps if someone actually runs it: new-pack authors at authoring time, and
anyone doing a periodic sweep. Treat a failure as a lead to verify by hand, not as an
automatic red.
