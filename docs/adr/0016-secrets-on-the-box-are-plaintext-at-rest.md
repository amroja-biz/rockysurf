# ADR-0016: A provisioned box holds its secrets as owner-only plaintext files

## Status

Accepted — 2026-08-30. Issue #244, PR #246. Complements the
[ADR-0014 amendment](0014-per-server-environment-at-create-time.md) of the same date, which
records *what* now reaches the shell; this ADR records why plaintext-at-rest was chosen over
the alternatives. The mechanism-level choices (profile.d + bash.bashrc over `/etc/environment`,
`PermitUserEnvironment`, `BASH_ENV`) are in
[`bootstrap-contract.md` § The shell environment](../bootstrap-contract.md#the-shell-environment)
and are not repeated here.

## Context

Issue #244's ruling: if a user would expect an environment variable to be on the box, it is on
the box — by default. Implementing that means the creator's Environment lines (the `secret:`
half included), the pack's inputs and `GITHUB_TOKEN` end up somewhere every shell `rocky` gets
can read them. The question this ADR answers is what that "somewhere" may be: Rocky Surf is a
personal productivity tool ([the #192 ruling](../memories/2026-08-27-everyone-who-runs-an-installation-is-its-admin.md):
one engineer, no non-admin user to design for), and engineers need their keys where their tools
run.

## Decision Drivers

- Simplicity is a core principle: no ceremony at login, no unlock step, nothing to opt into.
- The values must survive into every way a person reaches the box — interactive SSH,
  `ssh box 'command'`, tmux, the remote-desktop session — with no network dependency at login.
- The box is single-user and `rocky` holds `sudo`; there is no second local account to defend
  against.

## Considered Options

These four were weighed in the session that produced issue #244 (2026-08-30, owner and agent);
they are the real deliberation, not a reconstruction.

### Option 1: owner-only plaintext file, sourced by the shell  ← chosen
- Pros: zero login ceremony; works offline; survives dotfile replacement (system hooks, user
  files win on conflict); one file to regenerate, so no staleness lifetime of its own.
- Cons: a secret is legible to anyone with a shell as `rocky` — "shown back by nothing" stops
  being a property of the world and becomes a property of the control plane only.

### Option 2: process environment only, never on disk (the pre-#244 behaviour)
- Pros: nothing at rest.
- Cons: the value vanishes after setup — the exact bug #244 rules against. And the protection
  is illusory on a single-user box: any process running as `rocky` can read another `rocky`
  process's environment via `/proc/<pid>/environ`. Same exposure, worse product.

### Option 3: OS keyring or encrypted-at-rest store on the box
- Pros: encrypted at rest.
- Cons: something must unlock it — a passphrase at every SSH login (ceremony the simplicity
  principle forbids on a headless box), or an unlock key stored on the same disk beside the
  data, which is a locked door with the key taped to it.

### Option 4: fetch-on-demand from the control plane at login
- Pros: nothing durable on the box.
- Cons: couples every login to core being reachable; requires a credential *for fetching
  credentials* that lives on the box anyway; strictly more moving parts for the same terminal
  exposure.

### Option 5: external secret manager (Vault, 1Password CLI, cloud SSM)
- Not evaluated in depth — ruled out at the framing stage: right shape for a team product,
  but for a personal tool it outsources the problem to a subscription and a login flow, and
  the agent on the box still holds a plaintext token to reach the manager.

## Decision

Secrets that the user's tools need at runtime live on the box as **plaintext files owned by
`rocky`, mode `0600`** (`~rocky/.config/rockysurf/environment`; `secrets.env` during setup),
sourced into every shell by value-free system hooks. No encryption at rest on the box, no
unlock step, no fetch at login.

## Rationale

The box's disk is the trust boundary. Anyone who can read a `0600` file in `rocky`'s home
already has a shell as `rocky` — at which point they hold the SSH agent, the cloned
repositories, and `~/.config` of every coding harness on the box, which store their own tokens
as plaintext files too (`gh`, `claude`, `aws` all do exactly this). Option 1 does not lower the
bar; it matches where the bar already sits for every tool the box exists to run. Options 2–4
each add ceremony, staleness or coupling while leaving the terminal exposure — a process
running as `rocky` — unchanged.

## Consequences

### Positive
- A harness works at first SSH with no wiring; `gh` is authenticated on a connected box.
- No login-time dependency on core, the network, or a passphrase.

### Negative
- "A secret is shown by nothing" is no longer true of the box; only the control plane refuses
  to show it. Every document and form caveat that phrased the refusal as a property of the
  world was corrected in PR #246/#247 to name the control plane.

### Risks & Mitigations
- Risk: a user pastes a master credential where a scoped one belongs → Mitigation: the create
  form's copy tells the truth about where values land, steering toward fine-grained PATs and
  spend-capped API keys; the platform's own `RDP_PASSWORD` and credential-helper plumbing stay
  out of the shell.
- Risk: a compromised box leaks the keys it holds → Mitigation: unchanged from every other
  tool on the box; the remedy is revocation. Per-box revocation guidance in the docs is the
  cheap future notch if wanted — a different storage mechanism is not.

## Implementation

- `packages/core/src/bootstrap/resolver.ts` (`shellEnvironmentNames`), the `shell-environment`
  step (bootstrap contract phase 6, security invariant 8), `packages/core/bootstrap/agent.sh`.
- PR #246 (`Closes #244`).

## Related Decisions

- [ADR-0013](0013-packs-declare-their-inputs.md) / [ADR-0014](0014-per-server-environment-at-create-time.md):
  the delivery mechanism and its 2026-08-30 amendment.
- The #192 owner ruling (docs/memories): one engineer's own tooling — the premise of the
  threat model above.
