---
KEY: regional-ubuntu-mirrors-fail-as-a-unit
DATE: 2026-08-26
UPDATED: 2026-08-27
STATUS: active
SOURCE: issue #117, four outbreaks between 2026-08-20 and 2026-08-25; amended by issue #188
---

# Regional Ubuntu mirrors fail as a unit, and apt does not retry a 503

Every Ubuntu cloud image points apt at a per-region Canonical mirror — `<region>.ec2.archive.
ubuntu.com` / `<region>.ec2.ports.ubuntu.com` on AWS, `azure.archive.ubuntu.com`,
`<region>.gce.archive.ubuntu.com`. It is one hostname behind a load balancer, and when its
backend is sick the index files keep serving while every `.deb` in the pool answers `503`.
`apt-get update` succeeds; the first `apt-get install` fails with `E: Unable to fetch some
archives`. Every box in that region fails the same way at the same step, for hours, while the
neighbouring regions and the global `archive.ubuntu.com` / `ports.ubuntu.com` serve the same
files fine. The arm64 `ports` mirrors are hit far more often than the amd64 `archive` ones.

Two things about apt itself that were easy to get wrong:

- **24.04's apt (2.8.3) already retries — but only connection failures.** Against a
  refused connection it makes three attempts with exponential backoff (measured: 7 seconds,
  1+2+4) before giving up. Raising `Acquire::Retries` only lengthens that, per file, and would
  delay any fallback by minutes on a step with thirty packages.
- **It does not retry an HTTP 503 at all.** Measured against a stub server: one request, then
  the error. No `Acquire::*` setting changes that. So for the actual failure mode there is no
  retry to tune; the only remedy is a different mirror.

The bootstrap agent therefore does what an operator would: on a step whose own output carries
an apt fetch signature, it rewrites any regional mirror in the apt sources to the global one,
refreshes the lists, and re-runs the step, announced in `agent.log`. Do not "improve" this by
tuning `Acquire::*` — see the measurements above — and do not make it fall back to a
neighbouring region: that needs a per-region table and can be sick too.

Two boundaries of the fix worth knowing:

- A pack script that hard-codes a mirror hostname is outside the fallback and was already
  broken on every other cloud (`docs/writing-a-pack.md`).
- A third-party apt repository a pack adds itself (`packages.mozilla.org` "Mirror sync in
  progress") has no global twin to swap to. It gets the retry below and nothing more.

## Amendment, 2026-08-27 (issue #188, ADR-0012)

Two things in the paragraphs above are no longer accurate, and one sentence of the original
advice was too broad:

- **The retry is per STEP now, not once per bootstrap.** The one-retry-per-bootstrap budget
  meant whichever step flaked first spent it and every later step got none — not a standard a
  pack author can rely on. Every step now gets two attempts at an apt fetch failure and no
  more. The regional-mirror REWRITE inside that recovery is still once per bootstrap, because
  after it there is nothing left to swap.
- **"The only remedy is a different mirror" is true of a 503 and false of the second failure
  mode.** On the global archive, an index out of step with its pool answers `404` for one named
  `.deb` for some minutes (`libheif` on 2026-08-26 / #129; `perl-base 5.38.2-3.2ubuntu0.4` on
  2026-08-27 / #188, twice in one day, same package, same mirror IP). There is no other mirror
  to reach for, and the remedy is a wait plus a fresh `apt-get update` — which is what the
  agent now does when there is nothing to swap. So: no `Acquire::*` retries, still; a bounded
  step-level retry, yes.
- **The pack-smoke boundary claim was wrong.** `packages/rockysurf/src/cli/pack-smoke.ts`
  copies core's own `agent.sh` into the container and runs the plan with it (`docker cp
  AGENT_SCRIPT_PATH`, then `docker exec … bash /agent.sh`) — deliberately, so the harness
  cannot certify packs against an executor that is a fork of the real one. Pack smoke therefore
  gets the retry standard for free, and a mirror flake in a smoke leg is the same event a real
  box would see. Rerun is still the remedy for a leg that fails anyway, but it is evidence
  about the mirror, not about the harness.
