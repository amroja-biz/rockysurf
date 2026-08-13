# ADR-0001: Replace the AWS-serverless control plane with one portable self-hosted app

## Status

Accepted — 2026-08-11. Owner approved the plan of record; the spike is the evidence.

## Context

Rocky Surf's control plane is 100% AWS serverless: ~48 Lambda handlers, API Gateway REST +
WebSocket, 8 DynamoDB tables, Secrets Manager/SSM, EventBridge, and 8 CloudFormation platform
stacks including a 3,300-line `lambdas.yaml`. Servers are provisioned as per-server
CloudFormation stacks whose ~260-line user-data script reads its install plan back out of
DynamoDB.

The v0.1 goal is a self-hosted tool where users bring their own cloud. That goal is
incompatible with the current shape in a way no amount of refactoring fixes: a control plane
made of Lambdas and DynamoDB tables can only run in an AWS account, so every self-hoster —
including the ones whose compute is Hetzner — would have to open an AWS account and grant a
large IAM surface just to run the manager. The provisioning state machine
(`backend/src/servers/updateServerStatus.ts`) and the tools/packs data model
(`backend/src/lib/types.ts`) are already provider-neutral; it is the plane around them that is
not.

The de-risking spike (`rockysurf-d0no`) built exactly the proposed shape as a throwaway Hono
app and ran full real lifecycles on two clouds from a laptop behind NAT: AWS `t4g.small`
arm64 in 138s and Hetzner `cpx12` amd64 in 81s, both 29/29 checks, zero orphans, first
attempt. Core was never reachable from outside and never needed to be.

## Decision

1. **One portable Node/TS application.** Hono for HTTP, Drizzle + `better-sqlite3` for storage
   (~7 tables, Postgres-ready column types), SSE for live updates, and in-process jobs
   (`setInterval` with an overlap guard): `provisionTicker`, `uptimeTicker` (enforcing
   `spendCapUsd`), the reconciler, and `sessionSweeper`. The web UI is served from the same
   process. Ships as Docker or `npx`.
2. **SSE replaces WebSocket.** The existing WS channel is broadcast-only, so it buys nothing a
   server-sent event stream does not. `broadcastToUser()` keeps its signature.
3. **Providers are plugins behind a static registry**, and a CI dependency lint enforces that
   core imports `provider-sdk` only, never a concrete provider — which keeps the SDK honest
   while it has no out-of-tree consumers, and keeps the AWS SDK out of core's `npx` cold start.
4. **Per-server CloudFormation is dropped entirely.** The per-server IAM role existed only so
   the box could read DynamoDB and Secrets Manager, and the bootstrap in ADR-0002 removes that
   need. The AWS provider becomes `RunInstances` plus one shared, lazily-ensured
   `${prefix}-ssh` security group per region. This deletes `pollStackStatus.ts`, the EventBridge
   stack rules, and the S3-hosted templates.
5. **Create ordering is inverted.** Write the database row first (`status: requested`, with a
   deterministic idempotency key), then provision passing that key. The current
   `createServer.ts` provisions first and writes the row after, so a crash between the two
   leaves an orphan nobody can find.
6. **A startup recovery pass is a v0.1 requirement, not an emergent property.** On boot, every
   server in `requested` or `provisioning` is either re-attached or failed cleanly, and the
   reconciler runs once. This is what makes "your laptop is the control plane" credible.
7. **Secrets are AES-256-GCM rows in SQLite**, with the master key from `ROCKYSURF_SECRET_KEY`
   or an auto-generated `<dataDir>/secret.key` (mode 0600, with a back-it-up warning).

## Considered options

- **Keep the AWS-serverless plane** — rejected. It cannot be self-hosted on another cloud,
  which is the entire premise of v0.1.
- **Keep per-server CloudFormation** — rejected, as above: its only justification disappears
  with the new bootstrap.
- **Postgres and multi-instance from day one** — deferred, not rejected. Column types are kept
  Postgres-ready so this stays a migration rather than a rewrite.

## Consequences

### Positive

- The control plane runs anywhere Node runs, including a laptop behind NAT with no listener —
  proven, not asserted (`docs/spike/findings.md`, exit question 2).
- The IAM policy a self-hoster must grant shrinks to what `RunInstances` and a security group
  need.
- One process means one deploy, one log stream, and an `npx` quickstart.
- Deleting 8 CFN stacks, Stripe, and the per-server stack machinery removes most of the code
  that was owner-specific.

### Negative

- Core must stay alive during a push bootstrap (ADR-0002). Mitigated by the run-id + resume
  path and by the startup recovery pass above, but it is a real change in failure mode: the
  old plane was somebody else's uptime problem.
- Single process, single node. SQLite has one writer, so v0.1 does not scale horizontally.
- In-process jobs need overlap guards, and a tick that hangs blocks its own next tick.

### Risks and mitigations

- **Risk:** a reconciler built on `listManaged()` alone reports falsely clean on AWS for ~60s,
  because a terminal-but-unreaped instance reads as gone.
  **Mitigation:** amendment A3 (`terminating` state, adopted in ADR-0003) makes the interface
  honest; until it lands, audits go behind the interface to raw `DescribeInstances` /
  `DescribeVolumes`, which is what the spike's capstone does (findings.md D5, #37).
- **Risk:** losing `<dataDir>/secret.key` renders every stored credential unrecoverable.
  **Mitigation:** explicit back-it-up warning at generation time; documented in `SECURITY.md`.

## References

- `docs/spike/findings.md` — exit questions 1–4, and the evidence table
- `docs/spike/findings-notes.md` #31 (push needs no inbound anything), #37 (falsely-green sweep)
- `.plan/1-open-source-rocky-surf-v0-1.md` — "Target architecture", "Control plane app",
  "Debate record"
- Spike implementation: `spike/src/app.ts`, `spike/src/server.ts`, `spike/src/store.ts`
- Superseded code: `backend/src/servers/createServer.ts`,
  `infrastructure/templates/ec2-ondemand.yaml`

## Related decisions

- ADR-0002 — the bootstrap this plane drives, and the reason per-server IAM could be deleted
- ADR-0003 — the provider SDK the registry holds
