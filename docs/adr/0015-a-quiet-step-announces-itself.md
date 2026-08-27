# ADR-0015: A step that says nothing is announced on the journal while it lasts

## Status

Accepted — 2026-08-27. Issue #205. Complements [ADR-0012](0012-apt-retry-is-the-agents-standard.md),
whose retry is unchanged, and the #129 notice it extends.

## Context

The owner created a personal Surge Pack, launched a server from it, watched "Installing tools"
not move for five minutes with a six-line setup log, and terminated the box (issue #205,
`srv-30514bcda504`). The report says the pack "fails on tool installation". The evidence says
otherwise:

- The journal recorded `tool:build-essential` — the plan's first apt step — as `running` at
  17:17:37 UTC and nothing after it until the owner's terminate at 17:22:41. No failure, no
  retry, no notice, no report: the step had not finished its first attempt.
- On the owner's previous launch that day (`srv-53970c42d082`, a shipped pack, same region and
  architecture) the same step took **4 min 21 s** and then succeeded; the day before it took
  23–29 s. Something between the box and its mirror was slow to answer that afternoon.
- Six log lines is exactly the agent's own preamble plus `==> tool:build-essential`.
  `apt-get update -qq` prints nothing until it has succeeded or given up, and apt's own connect
  and read timeout is 120 seconds per try, with its own retries on top. A mirror that accepts
  the connection and then says nothing costs minutes of silence before apt ever produces the
  `Failed to fetch` line that lets ADR-0012's fallback engage.
- The console errors in the screenshot are `409 Conflict` from `/api/v1/admin/tools` and
  `/api/v1/admin/tools/headlong`: the Tools page refusing to delete a tool that `headlong-pack`
  still uses, and to create one whose id already exists. Both are correct, both are already
  toasted on that page, and neither touches the launch.

So nothing in core or the web app failed, and nothing in them *could* have said more: core
learns of a step only when the journal changes, and the journal did not change. The #129
notice ("Ubuntu's package archive is out of sync — waiting 2 min before retrying. Nothing is
stuck.") was built for exactly this feeling, but it covers the wait the agent takes *between*
two attempts, not the silent first attempt where a slow mirror actually spends the user's
time. From the timeline the two are indistinguishable from a hang, and a user who cannot tell
"still working" from "stuck" does what the owner did.

## Decision

1. **The agent announces a quiet step, on the journal, while it lasts.** While a step runs,
   `agent.sh` watches the step's own log. Once it has not grown for `ROCKYSURF_STEP_QUIET_S`
   seconds (default 60) the journal's existing `notice` field carries one line — *"build-essential
   has said nothing for 4 min — usually a download waiting on a mirror that is slow to answer.
   It is still running; if apt gives up, the agent retries it on another mirror. Nothing is
   stuck."* — re-posted every further minute with the elapsed time, so the line under the
   active step is a clock that moves. The first byte the step writes afterwards withdraws it,
   and so does the step ending, on #129's rule that a notice never outlives its cause.

2. **Silence is measured on the step's log, in polls.** The watcher polls five times a second
   (a `sleep 0.2` and a `wc -c`); a second of silence is five polls with the same byte count.
   A poll can only take longer than its sleep, so the count never announces early, and a step
   is released at the first poll after it exits — a step costs at most a fifth of a second more
   than it did. The step runs as a backgrounded pipeline for this, with its exit status carried
   through a file beside its log, because `$PIPESTATUS` does not exist for a background job and
   `wait` would answer for `tee`.

3. **The retry is announced, with the choice it leaves the user** (owner's ruling on #207:
   "if we have to retry installs, we should tell the user what's going on and give them a
   choice of terminating the server and trying on another provider, or waiting"). The moment a
   step's first attempt fails with an apt fetch signature — before ADR-0012's mirror swap or
   wait begins — the journal's `notice` says, in this order: what could not be downloaded, from
   where and with what answer (the first `Failed to fetch <url>  <status>` of that attempt,
   when there is one); what is being done (the swap or the wait, then one more attempt, never
   a third); the bounded worst case, derived rather than guessed (the second attempt is capped
   by the step's own `timeoutSeconds`, plus `ROCKYSURF_APT_RETRY_WAIT_S` when there is no
   mirror to swap — *"it gives up after 32 more minutes at most"*); and the choice — *"You can
   wait, or terminate this server now (Terminate, on this page) and launch it on another
   provider."* It stands for the whole second attempt (the quiet-step clock is appended to it
   rather than replacing it) and is withdrawn when that attempt ends, either way. The
   `apt-mirror` failure report, written when the second attempt fails too and ADR-0010 releases
   the box, ends with the same two options in the same words — *"You can wait and create the
   server again then, or launch it on another provider now."* — so the notice and the report
   agree. The #129 wait notice is subsumed: the retry notice names the wait itself. The
   callback report's `notice` cap rises from 300 to 1000 characters to carry a URL.

4. **The bound, in writing.** A tool step's `timeoutSeconds` is 1800 (`bootstrap/resolver.ts`)
   and `agent.sh` wraps *each attempt* in `timeout`. So the worst case for one tool step is
   two attempts of 30 minutes plus the 2-minute wait plus an `apt-get update`: **62 minutes,
   and then it fails by URL**. A required step that fails twice ends the plan there (ADR-0012),
   so at most one required step ever pays that; core's 15-minute stall guard remains behind it
   for a journal that has truly stopped. Nothing waits indefinitely.

5. **Nothing else changes.** Core forwards the notice exactly as it forwards #129's — same
   field, same progress event, same line under the active step in both bootstrap modes — and
   the retry standard and the 15-minute stall guard are untouched. A step that stays silent to
   its `timeoutSeconds` still fails with its own exit code; it just says "still quiet, N min"
   on the way there.

## Considered options

- **An elapsed-time counter on the web timeline, driven by the browser's clock.** Rejected as
  the *only* fix: it would move, but it could not say *why* — it does not know whether the step
  is talking, and it would tick just as cheerfully under a dead SSH channel. The agent is the
  one thing that can see the step's log not growing. It remains a reasonable addition; it was
  not needed to answer #205.
- **An `/etc/apt/apt.conf.d/` drop-in bounding `Acquire::http::Timeout`, so apt gives up on a
  silent mirror sooner and ADR-0012's fallback engages within a known time.** Not adopted
  here. It is a different knob from the `Acquire::Retries` one ADR-0012 rejected and may well
  be worth having, but it rewrites the box's apt configuration for every later `apt-get` the
  user runs, and the one measurement this repository could make (a black-holed mirror under
  Docker on macOS) fails the connect in 20–37 s at every setting, which says nothing about a
  SYN-dropped connect on EC2. A change to every box's apt wants a number measured on one.
- **Poll the step's log from core, over SSH, and synthesise the notice there.** Rejected: it
  would exist for push mode only (callback mode has no channel to read a log through), and it
  puts a second, mode-specific source of "what the box is doing" beside the journal that the
  bootstrap contract says is the only one.
- **Shorten core's stall timeout so a silent step fails faster.** Rejected: the step was
  *healthy*; failing it sooner would have produced a terminated box with a report blaming a
  stall, on a launch that finished 4 min 21 s later the previous time. The problem was what the
  user was told, not how long they were allowed to wait.

## Consequences

### Positive

- A slow mirror reads as a slow mirror: the timeline says what is happening, how long it has
  been happening, and that it is still happening, in both bootstrap modes, with no core or web
  change and no new field.
- A pack author whose install script is silent for a long stretch — a big `cargo build`, a
  quiet `-qq` — gets the same line for free (`docs/writing-a-pack.md` § Bounded retries now
  says so, and why letting the tools talk is the better answer).

### Negative

- One journal write and one progress event per minute of silence, per quiet step. A 30-minute
  hang is thirty `bootstrap.step` rows. Bounded by the step's own `timeoutSeconds`.
- Every step now costs up to 0.2 s more and spawns a `wc` five times a second while it runs.
  Measured on the agent's own tests: the apt-retry suite, which runs five steps, gained about
  a second.
- Because every re-post bumps `updatedAt`, core's 15-minute stall guard no longer fires for a
  step that is quiet but alive — the step's `timeoutSeconds` (30 minutes for a tool) becomes the
  bound. That is the more honest bound: the guard exists for a journal that stopped, and this
  journal has not stopped.

### Risks and mitigations

- **Risk:** the exit-status file goes missing (the pipeline was killed outright) and a failed
  step reads as `tee`'s zero. **Mitigation:** the agent falls back to `wait`'s status for the
  pipeline, which under `set -o pipefail` is the script's own when the file was not written;
  `quiet-step.test.ts` asserts a silent `exit 3` still fails the plan with `rc=3`.
- **Risk:** a chatty step under heavy load pauses long enough to be announced. **Mitigation:**
  the notice is withdrawn on the next byte and says "still running" in the meantime; a false
  "still quiet" is the harmless direction of error.

## References

- Issue #205; the owner's screenshot; `events` rows for `srv-30514bcda504` and
  `srv-53970c42d082` in the owner's installation.
- `packages/core/bootstrap/agent.sh` — `install_tool`, `watch_quiet`, `retry_notice`,
  `restore_notice`.
- `packages/core/src/bootstrap/failure-report.ts` — the `apt-mirror` summary's closing options.
- `packages/core/src/bootstrap/quiet-step.test.ts` — the real agent, a one-second threshold;
  the retry notice with and without a URL.
- `docs/bootstrap-contract.md` § state.json — the `notice` field.
- `docs/writing-a-pack.md` § Bounded retries.

## Related decisions

- ADR-0012 — amends clause 3: the retry still starts only when apt fails, and this is what the
  user is told until then and during it; the wait's own notice is replaced by the retry notice,
  which names the wait, the bound and the choice.
- ADR-0010 — unchanged: a step that stays silent to its timeout fails as a tool step fails.
