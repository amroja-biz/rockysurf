# ADR-0010: A failed tool install terminates the box; the report is the diagnosis

## Status

Accepted — 2026-08-26. Amends [ADR-0008](0008-supplied-key-retires-managed-key.md)'s "the box
stays `failed`/diagnosable" for the tool-install case, and retires the `rockysurf-4byx` doctrine
("failed boxes are kept so a person can log in and find out what went wrong") for that case only.
Issue #119.

## Context

Until this ADR a bootstrap failure of any kind left the instance **running and billing**, on
purpose: the box was the diagnosis. A person could SSH in, read `agent.log`, and find out what
went wrong. Core told them one line — `bootstrap failed at step 'tool:build-essential': E: Unable
to fetch some archives…` — and the creation screen's "Setup log" was a live stream that vanished
on reload; the events table kept 25 lines.

Two mirror-503 failures on the evening of 2026-08-25 (issue #117) showed what that costs the
person who clicked Create: a machine they cannot use, a bill that is running, and a sentence that
says where it broke but not why or what to do. The diagnosis-by-SSH the design assumed is not
something a user does; it is something the maintainer did, once, during an exit run.

The owner's ruling, 2026-08-26:

1. A failed **tool install** terminates the instance. Nothing the user made exists on a box before
   `ready`; a half-installed toolchain is worthless and billing.
2. A **repository that fails to clone** is not a terminatable offence. The box is delivered, and the
   user is told clearly which repository is not on it and why.
3. An escape hatch — `bootstrap.onFailure: terminate | keep`, default `terminate` — for a pack
   author who needs a failed box to SSH into.
4. After the machine is gone, the row stays **`Failed`** on the dashboard with its explanation,
   not billing, until the user dismisses it.

Four things were measured before deciding the shape (see `docs/memories/2026-08-26-regional-ubuntu-mirrors-fail-as-a-unit.md`
for the mirror half): a `failed` row whose instance vanishes was being flipped to `terminated` by
`sync`, and `terminated` rows are hidden from the dashboard — so "keep the row visible" needed a
rule change, not just a status; callback-mode failures were not recorded at all until the 30-minute
timeout; the only place the whole step log exists is `/var/lib/rockysurf/steps/<id>.log` on the box;
and `provider.terminate()` on a BYO host is bookkeeping, so the rule is safe on every provider.

## Decision

1. **One failure path for both topologies.** `bootstrap/failure.ts` `failBootstrap()` is the only
   code that decides what happens to a failed bootstrap's machine and row. Push mode reaches it
   from the provision ticker with the journal core read over SSH; callback mode reaches it from the
   box's own status POST, which now carries `stepStatus` and the failed step's `logTail`. A
   callback-mode failure is failed on the spot, with its reason, instead of timing out.

2. **The rule.** `terminatesInstance(failure, policy)` is `failure.phase === 'tool' && policy ===
   'terminate'`. The instance is released FIRST, then the row is failed — the same order as the
   provisioning timeout — so a crash between the two leaves a row the next tick retries, never a
   failed row beside a billing instance. If the provider refuses, the row is failed anyway with
   `instance: 'terminate-failed'` and the user is told the bill may still be running. Every other
   phase keeps the machine, and the report says why.

3. **The report is the diagnosis, so it has to be complete.** `bootstrap/failure-report.ts` builds
   a `BootstrapReport` — what failed (tool or repository by name), why (a classified cause with a
   plain-language summary and the decisive lines), the **whole step log** (push mode reads it over
   SSH before the connection closes, 64 KB tail, with `logComplete` measured rather than guessed;
   callback mode gets the agent's 60-line tail and says so), the agent log's last lines, and what
   core did with the machine in one sentence. It lives on the row (`servers.bootstrap_report`), is
   served by `present()` as `bootstrapReport`, and is rendered by the web `BootstrapReport` component
   on the creation screen and the detail page. `errorMessage` becomes the summary paragraph.

4. **Repository clones are optional plan steps.** The resolver marks `repo:*` steps `optional`, the
   agent journals a failed step's own log tail (`steps[].logTail`), and a box whose plan completed
   with failed optional steps is promoted to `running` with those steps recorded as `warnings` on
   the report. The dashboard card says "1 repository did not clone"; the detail page carries the
   reason and the log. Setup scripts that read `$REPOS` must already tolerate an absent repository.

5. **A `failed` row leaves only through `terminate`.** `lifecycle.sync` no longer promotes
   `failed → terminated` when the provider reports the machine gone; the provider state is still
   recorded (so billing stops and the still-billing notice clears), but the status holds until the
   user's click — labelled **Dismiss** when there is nothing left to terminate. This applies to a
   machine core released and to one the user killed in the provider console alike: the explanation
   outlives the machine either way. Once the release is on the row (`provider_state =
   terminated`), `sync` does not ask the provider about it again (#163): nothing a later
   `describe()` says can change a row that only `terminate` can move, and a describe of an absent
   instance is the slowest read a provider has — the A4 propagation grace, paid per row on every
   dashboard load. A listing of released failures costs zero provider calls.

6. **`bootstrap.onFailure`** is a top-level config section with one key, default `terminate`. It
   applies to tool failures only; no setting makes a repository failure terminate a box.

## Consequences

- The user is told, in words, what failed, why, what Rocky Surf did about it, and what to do next —
  and never has to SSH into a broken machine to find out. For a mirror outage the summary says it is
  not their configuration and to try again later; for a missing token it quotes the clone script's
  own diagnosis and names the Settings page.
- A failed tool install costs the price of the minutes it ran, not the hours until someone notices.
- The `StillBillingNotice` and `failed-billing.test.ts` machinery stays, for the cases that still
  keep a machine: `keep`, a non-tool failure, a terminate the provider refused.
- Pack authors debugging on a real box set `bootstrap.onFailure: keep` — documented in
  `docs/writing-a-pack.md`. Without it, their evidence is the report, which for push mode is the
  complete log.
- `docs/bootstrap-contract.md` gains the per-step `logTail`, the callback body's `stepStatus` and
  `logTail`, two failure-semantics rows and a conformance item.
- A row created before this ADR has no report; the UI falls back to `errorMessage`.

## Rejected

- **Raising apt retries instead of, or before, terminating.** Measured: apt never retries a 503,
  and lengthening its connection retries delays the mirror fallback by minutes per step (#117).
- **Auto-terminating on any bootstrap failure.** The owner drew the line at tool installs; a box
  whose branding step failed is a working box.
- **Sending the report on the SSE event.** It carries whole logs; the row is where it lives, and a
  terminal status is the cue to fetch it.
- **A new status for "failed, machine gone".** The SDK's status set is frozen (ADR-0003) and the
  dashboard already hides `terminated`; holding `failed` with a recorded provider state gives the
  same information without a new state.
