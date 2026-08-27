# ADR-0012: The agent retries an apt fetch failure twice for every step, then fails the launch by URL

## Status

Accepted — 2026-08-27. Issue #188. Amended by [ADR-0015](0015-a-quiet-step-announces-itself.md) (clause 3: the wait notice became the retry notice, with the bound and the choice). Complements [ADR-0010](0010-failed-tool-install-terminates-the-box.md),
whose terminate rule is unchanged: a tool step that fails after its retries still releases the box.

## Context

A Rocky Surf box downloads its whole toolchain during bootstrap, from Ubuntu mirrors that are
occasionally sick. A required tool step that fails terminates the instance (ADR-0010), so a
transient mirror answer that nobody retried costs the user a machine and a second attempt at
creating it. Two mirror failure modes have been seen repeatedly, and they need different
remedies:

- **A sick per-region mirror** (issue #117, four outbreaks in a week). The regional hostname
  cloud-init writes — `us-east-1.ec2.ports.ubuntu.com`, `azure.archive.ubuntu.com` — keeps
  serving its index while every `.deb` in its pool answers `503`. Every box in the region dies
  at `build-essential`. The remedy is a different mirror.
- **An archive out of step with itself** (issues #129, #188). On the *global* archive, an index
  names a `.deb` its pool no longer has, so one named file answers `404` for some minutes:
  `libheif 1.17.6-1ubuntu4.8` (2026-08-26), `perl-base 5.38.2-3.2ubuntu0.4` (2026-08-27, twice
  in one day, both arm64 Pack smoke legs, same package, same version, same mirror IP). There is
  no other mirror to reach for. The remedy is time and a fresh `apt-get update`.

The agent has had a remedy for both since #117/#129, but as **one retry for the whole
bootstrap**: whichever step failed first spent it, and every later step got none. That is not
something a pack author can rely on — whether tool nine is retried depends on whether tool two
happened to flake — and it is not what the packs were told. Packs already carry bounded `curl`
retries and cite a "rule 3" for them that `docs/writing-a-pack.md` never actually stated; apt,
the thing that fails most, was documented only in the bootstrap contract, where no pack author
reads.

The other half is what the user is told when the retries do not help. `bootstrap/failure-report.ts`
already turned an apt failure into prose, but the prose said "Ubuntu's package mirror for this
region was not serving packages … it usually clears within a few hours — create the server
again later." On the #188 failure every clause of that is wrong or unusable: the box was on the
global archive, not a regional mirror; the `404` clears in minutes, not hours; and the one fact
the user could have acted on — the URL of the file that would not serve — was in the log
underneath but nowhere in the explanation.

The owner's ruling, 2026-08-27:

> it's fine to add a retry, we already do that on another mirror. That should be a tool install
> standard. If it fails twice, then it sounds like the server launch should fail and the user to
> be told what happened and what to do. In the case of a bad mirror, maybe the guidance is to
> tell the user the URL and have them test it themselves. Then, once back up, the user can retry
> the server launch.

## Decision

1. **Two attempts per step, and no more.** A step whose own output carries an apt fetch
   signature gets a second and final attempt. The budget is **per step**, not per bootstrap: a
   step's retry does not depend on what any other step already used. A step that fails twice has
   failed; the plan stops (or continues, if the step is optional) exactly as before.

2. **The retry lives in the agent, so every pack gets it and no pack writes one.**
   `packages/core/bootstrap/agent.sh` owns it, which means it applies to every shipped and
   community pack without a line of YAML, to the agent's own `jq` bootstrap, and to the CI Pack
   smoke harness — which runs this same `agent.sh` in its containers, so CI gets the standard
   for free with no CI-only workaround. `docs/writing-a-pack.md` § Bounded retries states the
   promise and forbids pack-level apt retry loops; `curl` retries, which the agent cannot see
   inside, stay the script's own job at `--retry 3 --retry-delay 2 --retry-all-errors`.

3. **Between the attempts the agent does what an operator would.** Swap a regional Canonical
   mirror for the global one if there is one to swap — **at most once per bootstrap**, because
   after that there is nothing left to swap — otherwise wait `ROCKYSURF_APT_RETRY_WAIT_S`
   seconds (default 120) for the archive to catch up. Either way, `apt-get update` before the
   retry. While it waits, the journal carries a one-line notice so the timeline does not look
   hung, and the notice is cleared the moment the wait ends.

4. **When it still fails, the report names the URL.** `bootstrap/failure-report.ts` extracts the
   URLs from apt's `E:`/`W: Failed to fetch <url>  <status>` lines and the `apt-mirror` summary
   says, in this order: which file would not serve and with what status; that Rocky Surf already
   retried; that the fault is the mirror's, not the pack's or the user's settings; and to check
   the URL themselves (`curl -I <url>` answering 200 means it is back) and create the server
   again. It stays the one reporting path — the same `summarize()` the web card, the CLI and the
   API already render.

## Considered options

- **An `/etc/apt/apt.conf.d/` drop-in setting `Acquire::Retries`, written before any step runs**
  — the issue's own first suggestion. **Rejected on this repository's own measurements**
  (`docs/memories/2026-08-26-regional-ubuntu-mirrors-fail-as-a-unit.md`): on 24.04's apt 2.8.3
  the default is already three attempts with exponential backoff, it covers *connection*
  failures only, and neither a `503` nor a `404` is retried at any setting. It would therefore
  have been a no-op against both failure modes we actually see. Worse, it retries the transfer
  *inside one apt invocation*, against the index apt already holds — and a stale index is
  precisely what a `404` means, so the retry that matters is the one that happens **after** a
  fresh `apt-get update` and after some time has passed. Only the agent can spend either.
- **Keep the one-retry-per-bootstrap budget and only fix the report.** Rejected: it leaves the
  standard unstatable. "Your step may or may not be retried, depending on earlier steps" is not
  a promise `docs/writing-a-pack.md` can make, and the pack author's rational response to it is
  to write their own loop, which is what clause 2 exists to prevent.
- **More than two attempts, or exponential backoff across attempts.** Rejected on the owner's
  wording ("if it fails twice … the server launch should fail"). A third attempt at a mirror
  that has failed twice buys minutes of a user's time for a small chance, and the honest failure
  with a URL they can poll is worth more than a longer wait.
- **Retry the whole plan rather than the step.** Rejected: steps are idempotent individually
  (rule 1), and re-running earlier successful steps to get at a later one wastes the journal
  that exists to prevent exactly that.
- **Let the pack authors retry apt themselves, and just document how.** Rejected: it is
  forgettable by construction, it would have to be re-reviewed in every community pack, and a
  pack-level loop cannot refresh the lists or swap the mirror — the two things that work.

## Consequences

### Positive

- A transient mirror flake costs a step's second attempt, not a terminated box, at any point in
  the plan rather than only at the first apt step.
- Pack authors have one stated rule for apt (do nothing) and one for `curl` (bound at three), and
  CI runs the same agent, so a pack that passes smoke has the standard applied to it.
- A user who does get the failure is handed a URL, a way to test it, and a reason to try again
  soon rather than "in a few hours".

### Negative

- A bootstrap can now spend up to two minutes of wait per apt step that flakes on a global-mirror
  box, where before it spent at most two minutes in total. In practice this is bounded by the
  plan itself: a *required* step that fails twice ends the plan there, so at most one required
  step ever pays the wait, and optional steps are repository clones, which are git and never
  match an apt fetch signature.
- The summary is longer than the sentence it replaced, and carries a URL that can be 120
  characters. It is prose in a `<p>`, so it wraps, but it is no longer a one-liner.
- One more place that parses apt's English output. It degrades to the previous generic sentence
  when no line named a URL, rather than guessing.

### Risks and mitigations

- **Risk:** a step whose script prints something matching the fetch signature for an unrelated
  reason pays a two-minute wait it cannot benefit from. **Mitigation:** the signature is checked
  against **only this attempt's** output (the log's line count is taken before the attempt), and
  the strings are apt's own verdicts, not substrings of ordinary output. A step that fails for
  its own reasons is not retried at all — asserted in `apt-retry.test.ts`.
- **Risk:** the retry masks a genuinely broken pack by making every failure take twice as long.
  **Mitigation:** only fetch failures are retried; a wrong package name (`Unable to locate
  package`) is not a fetch signature and fails on the first attempt.
- **Risk:** apt changes the wording of `E: Failed to fetch`. **Mitigation:** the URL extraction
  is additive — when it finds nothing the summary falls back to the previous outage sentence —
  and the classifier already matches on several independent signatures.

## References

- Issue #188 (this decision), #129 and #117 (the two failure modes), #119 / ADR-0010 (what a
  failed tool install does to the box).
- `packages/core/bootstrap/agent.sh` — `apt_fetch_failed`, `apt_recover`, `run_plan`.
- `packages/core/src/bootstrap/failure-report.ts` — `aptFetchFailures`, `summarize`.
- `packages/core/src/bootstrap/apt-retry.test.ts` — the standard, against the real shell.
- `scripts/agent-smoke.sh` runs 5–7 — the same behaviours in a real `ubuntu:24.04` container,
  including the mirror rewrite a unit test cannot reach.
- `docs/bootstrap-contract.md` § Failure semantics — the normative row.
- `docs/writing-a-pack.md` § Bounded retries — the same contract, stated to pack authors.
- `docs/memories/2026-08-26-regional-ubuntu-mirrors-fail-as-a-unit.md` — the apt measurements
  this decision rests on.

## Related decisions

- ADR-0010 — complements. The terminate rule is untouched; this decision only changes how many
  attempts a step gets before it applies, and what the user reads afterwards.
- ADR-0004 — complements. Packs stay data; the retry policy is the agent's, not the pack's, so
  no pack file changes to gain it.
