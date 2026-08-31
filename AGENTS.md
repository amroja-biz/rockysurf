# Agent Instructions

Orientation for AI coding agents (and anyone using one) working in this repository. This file
points at normative documents rather than repeating them; if it ever disagrees with one of them,
the referenced document wins.

## Issue tracking

[GitHub issues](https://github.com/amroja-biz/rockysurf/issues) are this project's system of
record for bugs and feature work — see the "Issue tracking" section of
[`CONTRIBUTING.md`](CONTRIBUTING.md). File and track work there.

[Beads](https://github.com/gastownhall/beads) (`bd`) is optional, personal working memory. An
agent or contributor may run it locally to decompose a GitHub issue into steps for themselves, but
it is not synced to this repository, not committed anywhere in it, and not the project's tracker.
Treat a local beads database as scratch space that can be wiped between sessions — anything that
needs to survive past your own session belongs in a GitHub issue, a pull request, or
`docs/memories/` (below) instead. If you use beads, run it against your own local/contributor-mode
database; don't expect a shared or repo-tracked one to exist, and don't try to create one.

## Durable knowledge

Cross-session project knowledge that isn't tied to a single issue lives in `docs/memories/` — read
[`docs/memories/llms.txt`](docs/memories/llms.txt) first, it indexes the rest. Session hand-off
notes (what a work session did, what's still open) live in `.pass-along/`.

Both directories are committed to this public repository and are world-readable: never write a
secret, credential, IP address, account ID, or other private infrastructure detail into either
one.

## Everything else

- Architecture decisions: [`docs/adr/`](docs/adr/), indexed at `docs/adr/llms.txt`.
- Contribution mechanics, commit conventions, and the workspace's import rule:
  [`CONTRIBUTING.md`](CONTRIBUTING.md).
- Operator- and contributor-facing contracts: [`docs/self-hosting.md`](docs/self-hosting.md),
  [`docs/writing-a-provider.md`](docs/writing-a-provider.md),
  [`docs/writing-a-pack.md`](docs/writing-a-pack.md).
- Reusable Agent Skills for this repository: [`.agent-skills/`](.agent-skills/), indexed at
  `.agent-skills/README.md`.
