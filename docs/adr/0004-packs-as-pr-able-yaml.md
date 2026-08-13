# ADR-0004: Packs are PR-able YAML files; the database is a cache and edit layer

## Status

Accepted — 2026-08-11. The file format freezes at v0.1; the author contract is
`rockysurf-q5lm.4`.

## Context

Surge packs — curated bundles of tools installed on a new box — are already the most portable
part of Rocky Surf. Tools and packs are *data*, not code: `Tool { installScript, setupScript,
installOrder, runAs, bootstrap }` and `SurgePack { tools[] }` in `backend/src/lib/types.ts`,
edited through an admin UI and executed by a generic install loop. Nothing about that model is
AWS-specific.

What is not portable is where they live. Today they exist only as DynamoDB rows behind an admin
UI, which means a pack cannot be read, diffed, reviewed, forked, or contributed. The declared
success metric for v0.1 is community adoption, and a pack nobody can send a pull request for is
a pack nobody contributes.

The spike constrains the format in two ways it did not before. First, the install plan is
resolved at create time and snapshotted on the server row, and the bootstrap resumes by
re-reading `/var/lib/rockysurf/state.json` and skipping completed steps — so **every step must
be idempotent or resume silently corrupts state**. Second, "Ubuntu 24.04" turned out not to be a
contract about installed packages: Hetzner's image ships without `jq` and Canonical's AWS AMI has
it, so the agent's defensive bootstrap path fired on exactly one cloud. Meanwhile one identical
plan produced working Claude Code 2.1.228 on both arm64 and amd64 with a single arch-aware line,
which is the evidence that a portable pack format is achievable rather than aspirational.

## Decision

1. **`packs/*.yaml` in the repository are the source of truth for shipped packs**, PR-able on
   launch day. The repo's own packs live there and are what the launch post points at.
2. **The database is a cache and edit layer.** The admin UI keeps its editing capability and
   gains export/import (file or pasted URL), so an edit made in the UI can become a pull
   request.
3. **The file format freezes at v0.1.** `rockysurf pack add <git-or-url>` sugar is deferred to
   v0.2 — the format freeze is what matters for community contributions, not the CLI
   convenience.
4. **A pack-author contract ships at v0.1** (`docs/writing-a-pack.md`, `rockysurf-q5lm.4`) with
   four rules, enforced in CI. Every install and setup script must be:
   - **idempotent** — safe to re-run, required by the `state.json` resume path in ADR-0002;
   - **`$ARCH`-aware** — `agent.sh` exports it; branch per architecture where needed;
   - **non-interactive** — `DEBIAN_FRONTEND=noninteractive`;
   - **`runAs`-honest** — declare the user a step actually needs.
5. **CI runs every repo pack in `ubuntu:24.04` containers on amd64 and arm64, twice in the same
   container**, so idempotency is proven rather than promised.
6. **Packs may assume nothing about the base image** beyond a stock Ubuntu 24.04 userland.
   Anything a pack needs before it can run must be installed by the pack itself. This is
   amendment E10 applied to pack authors rather than to the agent.
7. **`SurgePack` gains `requiresRepos`, `requiresRdp`, and `desktop?: 'xfce'`**, which removes
   the four hardcoded `packId === 'open-claw'` checks — the packs become data again rather than
   data plus four special cases.

## Considered options

- **Keep packs in the database only** (the status quo) — rejected. It blocks the community
  metric outright: no review, no diff, no fork, no pull request.
- **Files only, dropping the admin UI edit path** — not chosen. Editing packs in the UI is an
  existing capability people use, and export/import preserves it while still producing a
  reviewable artifact. This option was not separately debated; it is the natural complement of
  the decision recorded in the plan.

## Consequences

### Positive

- There is a contribution path on launch day, and the repo's own packs are the reference
  implementations for it.
- Freezing the format at v0.1 means a pack written on launch day keeps working.
- Removing the `open-claw` special cases makes pack behaviour describable entirely by pack
  metadata, which is what lets the UI be driven by it.
- CI running each pack twice makes the single most important rule — idempotency — a gate rather
  than a guideline.

### Negative

- Two homes for the same data. Files and database rows can drift, so precedence and the
  import/export flow must be specified rather than assumed.
- CI cost grows with every pack accepted: each one runs twice on two architectures.
- Freezing a format this early risks freezing a mistake; the mitigation is that packs are data
  and a format migration is a script, not a rewrite.

### Risks and mitigations

- **Risk:** pack authors ignore the contract and community packs fail in ways that look like
  Rocky Surf bugs. This is the plan's highest-leverage risk on the community goal.
  **Mitigation:** contract documented and CI-enforced from day one, with the repo packs as
  worked examples.
- **Risk:** a non-idempotent step passes review and corrupts a resumed bootstrap in a way that
  is hard to attribute. **Mitigation:** the run-twice-in-one-container CI check is aimed
  precisely at this, and the run id in ADR-0002 keeps a resumed run from being confused with
  its predecessor.

## References

- `docs/spike/findings.md` — amendment E10 ("Ubuntu 24.04" is not a contract about installed
  packages); exit question 1 (one plan, two architectures)
- `docs/spike/findings-notes.md` #36
- `.plan/1-open-source-rocky-surf-v0-1.md` — "Packs as portable files (the community mechanic)",
  risk 1
- Port anchors: `backend/src/lib/types.ts`, `scripts/seed-tools.sh`,
  `infrastructure/branding/`

## Related decisions

- ADR-0002 — the resume path that makes step idempotency mandatory
- ADR-0001 — the control plane that loads `packs/*.yaml` and seeds the database
