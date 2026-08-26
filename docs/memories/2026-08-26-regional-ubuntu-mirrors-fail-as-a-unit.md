---
KEY: regional-ubuntu-mirrors-fail-as-a-unit
DATE: 2026-08-26
UPDATED: 2026-08-26
STATUS: active
SOURCE: issue #117, four outbreaks between 2026-08-20 and 2026-08-25
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
refreshes the lists, and re-runs the step — once per bootstrap, announced in `agent.log`. Do
not "improve" this by adding retries, and do not make it fall back to a neighbouring region:
that needs a per-region table and can be sick too.

Two boundaries of the fix worth knowing:

- The CI pack-smoke harness runs pack scripts directly in a container, not through
  `agent.sh`, so its own mirror flakes (`ports.ubuntu.com` mid-sync 404s, `packages.mozilla.org`
  "Mirror sync in progress") are not covered by the agent's fallback. Rerun is the remedy there.
- A pack script that hard-codes a mirror hostname is outside the fallback and was already
  broken on every other cloud (`docs/writing-a-pack.md`).
