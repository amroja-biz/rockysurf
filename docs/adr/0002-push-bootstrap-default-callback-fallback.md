# ADR-0002: Push bootstrap is the default; callback is a scoped fallback

## Status

Accepted — 2026-08-11.

**Condition discharged, 2026-08-11.** This ADR was accepted with callback mode's retention
conditional on `rockysurf-q5lm.5`. That run has since passed on real AWS (commit `5e537b0`,
`spike/recordings/aws-callback-lifecycle.txt`): 26/26 checks, 95s end to end, zero orphans.
Callback mode is **kept**, with its scope narrowed by what the run revealed — see Decision 2.
Finding #44 is closed.

**Amended by [ADR-0008](0008-supplied-key-retires-managed-key.md), 2026-08-24**, for the
supplied-key case only. Everything here about core needing its own key to push, resume, and
recover a bootstrap is unchanged. What ADR-0008 adds is a phase-7 plan step, appended only when
the row carries a user-supplied key, that runs AFTER bootstrap and removes core's key from that
one box once the user's own is confirmed authorized. Every other server — no supplied key — is
untouched by ADR-0008 and core's key remains exactly what this ADR describes.

## Context

Bootstrap is how software gets onto a fresh box. Three topologies were on the table:

- **push** — pre-boot config is inert; core connects outbound and installs;
- **callback** — the box fetches its plan from core and reports progress inward;
- **embedded** — everything travels in user-data.

Embedded was cut during the plan debate: secrets already required an SSH channel, so embedded
collapsed into push with zero capability loss.

The spike proved push on real infrastructure on both clouds. What core sends before boot is
inert `#cloud-config` — creates the `rocky` user, authorizes core's key, pins a core-minted
ed25519 host key — with no `runcmd`, no `bootcmd`, no shell, no cloud vendor SDK, and no
metadata-service dependency. cloud-init consumed core's exact bytes (2130B on AWS, 2138B on
Hetzner, byte-identical to what core sent). Host-key pinning is real rather than
trust-on-first-use: the box presented the core-minted key on first contact, so the very
connection carrying the secrets file was verified against a known key, and a wrong fingerprint
was rejected in under a second. One identical install plan produced Claude Code 2.1.228 on both
arm64 and amd64 with a single arch-aware line.

Callback was initially proven only locally, in a harness that enforces the topology structurally
(the box container publishes no ports and has no sshd, both asserted at runtime). Its one
unproven leg was the one that mattered — cloud-init actually executing the callback user-data on
a real provider (findings.md #44).

**That leg is now proven, and proving it produced the strongest argument in this ADR.** The
q5lm.5 run confirmed real cloud-init executes the document: `write_files` and `runcmd` both ran,
the gz+b64 agent decoded to the exact bytes core compressed (sha256 match, 14,185B on box), the
box fetched its own plan with the single-use token, that token was then refused with 410 and the
replay recorded, 7 progress reports arrived across all 3 steps each carrying the run id core
minted, and the box reached `ready` gated on its own `claude --version` (2.1.228, node v24.19.0,
arm64).

But **callback mode requires core to be reachable *from* the box**, and core in that run was a
NAT'd laptop — so the ingress path had to be an SSH reverse tunnel: core connected out to the
box and asked its sshd to forward a port back (recording, 23.9s). Making callback work therefore
required exactly the connectivity push mode needs and callback was supposed to eliminate. That
is not a flaw in the test; it is the finding. Callback earns its keep only where core is
*already* publicly reachable.

A timing detail worth carrying into the bootstrap contract: sshd comes up in cloud-init's init
stage while `runcmd` runs in the final stage, which is what gave core a window to open the
tunnel at 23.9s before the box's first report at 25.9s.

## Decision

1. **Push is the default and only fully-proven topology.** Pre-boot config stays inert
   `#cloud-config`. Everything else arrives over one outbound SSH connection: core scps
   `agent.sh`, the install plan, and secrets, launches the agent under a transient `systemd-run`
   unit decoupled from the SSH session, and reads progress from `/var/lib/rockysurf/state.json`.
   Adopts amendment **E1**.
2. **Callback is kept as the documented fallback for deployments where core is already publicly
   reachable — a hosted control plane — and not as a general answer to unreachable boxes.**
   q5lm.5 proved it viable rather than merely plausible, so it ships. But the same run showed
   that a NAT'd core has to open an SSH reverse tunnel for callback to work at all, which means
   **for the self-hosted-on-a-laptop case callback is strictly worse than push**: it needs the
   same outbound SSH connection push needs, and then additionally leaves a credential on the box
   and grows its user-data. Documentation must say this plainly rather than presenting the two
   modes as equal-cost alternatives.
3. **One plan and one executor serve both modes.** The callback branch in `agent.sh` is inert
   unless `callback.env` exists, and the same agent produced identical results on both paths.
   Two topologies must not become two implementations.
4. **Embedded mode stays cut.**
5. **Compression is a rule, not an optimization (E5).** Anything large going into user-data uses
   cloud-init's native `gz+b64`, and the size check stays in the renderer. This is not
   hypothetical, and it is now measured twice. In the local harness, a callback document with
   `agent.sh` embedded verbatim came to **19,130 bytes against EC2's 16,384-byte ceiling** — a
   provider-side 400 at provision time, on AWS only, invisible to unit tests and to Hetzner's
   32KB limit. On real AWS, the shipped document — a 14,185-byte agent carried `gz+b64` —
   measured **11,752 bytes, 72% of the ceiling**, and cloud-init decoded it back to core's exact
   bytes (sha256 match). (The two figures are separate measurements taken at different times, not
   a before-and-after on identical input: the agent grew between them. Read them as "verbatim does
   not fit" and "compressed fits, at 72%", not as a compression ratio.) So callback fits *only*
   compressed, and it starts at roughly five times push's user-data and grows with the agent,
   while push stays constant at ~2.1KB no matter what the plan installs. Paired with `validateSpec()` (amendment A7, ADR-0003) so the provider owns
   its own limit rather than the renderer guessing it.
6. **Two tokens, two lifetimes — and no strict single-use (E8, E9).** The plan token ships in
   user-data, which every process on the box can read from the instance metadata service
   forever, so its exposure window must be short. The status token authenticates per-step
   progress POSTs and therefore cannot be single-use. Collapsing them means single-use loses and
   a metadata-readable credential stays valid for the life of the server. Further: **strict
   single-use and at-least-once delivery do not compose** — spend the token, lose the response
   in transit, and the retry gets 410 with no way to ask for another plan. One dropped packet,
   one dead box. We therefore adopt a **short TTL with a small use budget** rather than strict
   single-use. Control-plane credentials never share a file with the environment exported to
   install steps, and never appear in argv where `ps` can read them.
7. **Every bootstrap run has a core-minted run id (E6).** The box echoes it on every report.
   Without it, a push to an already-bootstrapped box reads the *previous* run's terminal state
   and reports success before the agent has started — and a retry of a failed bootstrap reports
   the old failure as the new result. Reports from a superseded run are recorded for forensics
   but must not move the row.
8. **Watch the launcher, not just the progress file, and introspect it with privilege (E7).** A
   file-staleness timeout cannot tell a slow `apt-get` from a SIGKILLed agent. `systemctl
   is-active` on the transient unit answers that directly — and must run through `sudo`, because
   unprivileged `systemctl is-active` fails with "Failed to connect to bus" whenever dbus is
   unreachable, which reads as "not running" to any caller checking the exit code. That is how
   core declared a healthy bootstrap dead during the spike.
9. **The agent may assume nothing about the base image (E10).** Both clouds ran "Ubuntu 24.04"
   and they are not the same image: Hetzner's ships without `jq`, Canonical's AWS AMI has it, so
   the agent's defensive bootstrap path fired on exactly one cloud. Anything the agent needs
   before it can parse its own plan must be bootstrapped per-image.

## Consequences

### Positive

- Push needs no inbound anything: no public core URL, no listener, no callback token on the
  box, nothing leakable through instance metadata.
- Push user-data is **constant at ~2.1KB no matter how much software the plan installs**;
  callback's grows with the agent.
- Host-key pinning gives strict verification on the first connection, with no TOFU window.
- `userDataMaxBytes` stops being load-bearing in the default path.

### Negative

- Core must stay alive during the install. Mitigated by the run id plus `state.json` resume
  (idempotent re-push skips completed steps with timestamps untouched, and resume after
  `SIGKILL` mid-plan is verified) and by ADR-0001's startup recovery pass — but it is a genuine
  cost that the old fire-and-forget user-data design did not have.
- Callback leaves a core credential on the box for the whole bootstrap, readable via instance
  metadata, and reintroduces the shell that push mode deleted — user-data cannot be inert if
  something has to start the process (confirmed on real cloud-init: the shipped document carries
  a `runcmd`).
- Callback does not actually remove the need for outbound reachability in the self-hosted case,
  so it buys less than its existence suggests. Keeping it is a bet on hosted deployments.
- Two supported topologies means two code paths, two token stories, and two sets of tests — held
  down, but not eliminated, by the one-plan-one-executor rule in Decision 3.

### Risks and mitigations

- **Risk:** callback is offered to self-hosted users as if it solved unreachability, and they
  discover it needs the same outbound SSH push already needs. **Mitigation:** Decision 2 scopes
  it to hosted cores explicitly, and the bootstrap contract (q5lm.3) must carry that scoping into
  user-facing docs rather than listing two equal modes.
- **Risk:** callback's user-data grows past the AWS ceiling as the agent grows — it is already at
  72% compressed. **Mitigation:** the renderer's size check plus `validateSpec()` (A7) turn that
  into a build-time failure rather than a provision-time 400; a growing agent is a signal to move
  work out of user-data, not to raise the limit.
- **Risk:** a lost response still strands a box even with a use budget.
  **Mitigation:** retry only connection failures, 5xx, and 429 — never replay a 4xx — and fetch
  only when the box has no plan, so a systemd restart cannot re-spend.

## Deliberately unresolved

Per the memo, and not decided here:

- ~~Whether callback mode survives at all~~ — **resolved** by q5lm.5 (see Status). It survives,
  scoped to hosted cores.
- **The exact TTL and use budget for the plan token.** The shape is settled; the numbers depend
  on observed cloud-init timing across providers.
- **BYO provider shape.** BYO is push-only by construction — a box with no user-data cannot be
  told anything before boot — but `generatesUserData: false` has never been exercised end to
  end.

## References

- `docs/spike/findings.md` — exit questions 1–2; "The two things a literal reader of the sketch
  will ship wrong" #2; amendments E1, E5–E10
- `docs/spike/findings-notes.md` #39–#45 (callback), #28–#35 (push topology), #36 (base image)
- `.plan/1-open-source-rocky-surf-v0-1.md` — "Bootstrap (two modes, one executor)"
- Spike implementation: `spike/src/push.ts`, `spike/src/callback.ts`, `spike/bootstrap/agent.sh`,
  `spike/bootstrap/cloud-config.yaml.tpl`
- Evidence: `spike/recordings/aws-lifecycle.txt`, `spike/recordings/hetzner-lifecycle.txt`,
  `pnpm run verify:push`, `pnpm run verify:callback`
- Real-cloud callback evidence (`rockysurf-q5lm.5`, commit `5e537b0`):
  `spike/recordings/aws-callback-lifecycle.txt`, `spike/verify-aws-callback.ts`

## Related decisions

- ADR-0001 — the control plane that must stay alive during a push, and its recovery pass
- ADR-0003 — `validateSpec()` (A7), the SDK hook for Decision 5
- ADR-0004 — install steps must be idempotent because of the resume path in Decision 1
