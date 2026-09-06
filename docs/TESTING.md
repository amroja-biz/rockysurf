# Testing

How Rocky Surf is tested: what each layer checks, where it runs, and what happens when it fails.
This document describes the arrangement as it stands. The mechanics of running the gates locally
are in [`CONTRIBUTING.md`](../CONTRIBUTING.md); this document is the map of what exists and why.

## Executive summary

Testing is arranged in four bands, ordered by what each one can see and by what it costs to run.

1. **In-process tests** — unit tests, seam tests that boot the real composition, and component
   tests. Milliseconds to seconds, no external dependency. They run in `pnpm run check` and in
   CI's `Test` job on every pull request.
2. **Structural checks** — scripts that assert repository-wide invariants a reviewer would
   otherwise have to remember: core's dependency direction, the published IAM policy against the
   provider, the `npx` install closure, the bundled pack copy, gitignore anchoring. Seconds.
3. **Out-of-process checks** — the ones that need something `pnpm install` does not provide: a
   browser engine, a Docker daemon, an SSH server, a `gitleaks` binary, an npm-style install from
   packed tarballs. Each is its own CI job.
4. **Real-cloud checks** — one scheduled workflow that creates and destroys real servers on
   AWS, GCP, Azure and Hetzner in accounts Amroja LLC keeps for this purpose. It is the only band
   that spends money, and the only one that proves the shipped article works against a real API.

Two rules shape the whole arrangement.

- **A check runs against the shipped artifact wherever it can.** The browser suite, the BYO
  lifecycle, the pack smoke harness and the nightly all drive `packages/rockysurf/dist/bin.js` or
  the built CLI, not the sources and not a re-implementation of the code path.
- **A gap found by an expensive check is pushed down to a cheap one.** When the nightly failed on
  a config key core's schema did not accept, the fix was the nightly's config file plus a
  millisecond-scale parity test on the pull request. The expensive check stays as the backstop.

## In-process tests

### Unit tests

Vitest per package, run by `pnpm -r test`. Node environment everywhere except `packages/web`,
which uses jsdom. Roughly 130 test files across the workspace; `packages/core` holds the majority.

**Why this approach.** One runner and one command across a pnpm workspace keeps the gate a single
verdict, and per-package suites keep a failure attributable to a package rather than to the
workspace.

### Whole-boot and whole-app wiring tests

Every seam where independently tested modules get wired together gets a test that exercises the
real composition — `createApp` at the application level, the real boot path at the configuration
level. `packages/core/src/bootstrap/wiring.test.ts` is the app-level pattern;
`packages/core/src/bootstrap/boot-keys.test.ts` is the boot-level one. Twenty-seven of core's
test files reach for `createApp` rather than assembling their own wiring.

**Why this approach.** A test that builds its own wiring cannot see a missing piece of the real
composition, because it never assembles the real thing — every module in one area of this project
once had passing unit tests while the product could not bootstrap at all. Test at the boot level
rather than the app level when the seam involves configuration, secrets or the filesystem.

### Component tests

React components and pages under `packages/web/src`, in jsdom, using real stub HTTP servers on an
OS-assigned port rather than a mocked fetch. The `*.wiring.test.tsx` files assert a page against
the API it actually calls.

**Why this approach.** A page's behaviour depends on what the API returns, so the seam worth
testing is the request and its response, not a mock's return value. Two of these files run
serially at the end of `check:parallel` because their assertions are about elapsed wall-clock
time; the list and the reason for each entry are in `scripts/check-parallel.mjs`.

### Provider conformance suite

`packages/provider-conformance` holds assertions every provider must satisfy — the describe
absence-grace contract among them — and its own tests prove each assertion rejects a provider that
violates it as well as accepting one that does not.

**Why this approach.** A shared suite is the only thing that makes "implements the SDK" mean the
same thing for every cloud, and a suite that passes everything is not evidence, so the assertions
are themselves tested against deliberately broken stand-ins.

### The nightly config parity test

`packages/rockysurf/src/e2e-config.test.ts` runs the exact `rockysurf.config.yaml` that
`scripts/e2e/lifecycle.mjs` writes through core's real loader, once per cloud for all four, and
separately asserts that core's AWS section accepts every field the AWS provider's own schema
declares. It lives in `packages/rockysurf` because it is the only package permitted
to import both core and a concrete provider.

**Why this approach.** The nightly is the most expensive check in the project and the last to run;
"is this file even valid" costs milliseconds, needs no credential and no network, and belongs on
the pull request that breaks it. Extend it when a provider gains a config key the e2e config
writes.

## Structural checks

`pnpm run lint` runs a set of `scripts/check-*.mjs` programs, each guarding a boundary no test
would otherwise see:

| check | what it asserts |
|---|---|
| `check-core-deps.mjs` | `@rockysurf/core` imports `@rockysurf/provider-sdk` and nothing else in the workspace |
| `check-iam-policy.mjs` | `deploy/aws/iam-role.yaml` and `docs/providers/aws.md` have not drifted apart |
| `check-azure-role.mjs`, `check-gcp-role.mjs` | the same, for the published Azure and GCP roles |
| `check-npx-closure.mjs` | no cloud vendor SDK has arrived in core's production dependency closure |
| `check-packs-bundle.mjs` | `packages/core/packs` still matches `packs/` |
| `check-gitignore-anchors.mjs` | nothing under a package's `src/` is gitignored |
| `check-skills-index.mjs` | `.agents/skills/README.md` lists every skill in `.agents/skills/` |
| `check-package-count.mjs` | the package counts stated in prose match the set `pnpm publish -r` ships |

The lint job also runs `scripts/e2e/audit-credentials-selftest.mjs`, which spawns the nightly
lifecycle twice to watch it refuse to start when its orphan-audit credentials are not distinct
from the identity under test.

**Why this approach.** If a rule matters, breaking it should break the build — these are the rules
reviewers forget, and each has a failure mode that leaves every other signal green.

## Out-of-process checks

### Browser suite (Playwright)

`packages/web/e2e/`, run by `pnpm run test:ui` and by the `UI (browser)` CI job. Each worker
starts a real `rockysurf` from `packages/rockysurf/dist/bin.js` against its own `mkdtemp`
directory holding its own `config.yaml`, database and master key, on an OS-assigned port, with
`HOME` redirected into that directory. The admin password is generated per run. The suite drives
the real login form. Chromium only; failure screenshots, traces and the HTML report are uploaded
as `ui-browser-artifacts`.

**Why this approach.** A list that renders nothing still renders and a disabled button is still in
the DOM, so nothing below this layer can tell whether a control is on screen and usable — two UI
regressions shipped in one day with every other layer green. A change under `packages/web/` is not
verified without this suite or a browser click-through actually performed.

A test marked `test.fail()` is a reproduction: Playwright runs it and the suite is green only
while it fails. When the fix lands the job goes red on purpose, which is the signal to delete the
`test.fail()` line and leave an ordinary regression test behind.

### Pack smoke

`scripts/pack-smoke.mjs`, and `rockysurf pack check` for pack authors outside this repository.
Every pack runs twice inside one stock `ubuntu:24.04` container — no convenience packages, empty
apt lists, no sudo — with `/var/lib/rockysurf/state.json`, the resume journal, deleted between the
two runs. The harness asserts the second run contains no resume-skip line. The CI matrix is every
pack on amd64 and arm64, on native runners for both.

**Why this approach.** The second run is the exercise: the on-box agent skips steps already marked
done, so a harness that merely re-invokes it gets a green run in which no install script executed
twice. Two architectures because a hardcoded `x86_64` in a download URL is the most common pack
bug and is invisible on one of them.

`rockysurf pack lint` is the static half — the mechanical rules of
[`docs/writing-a-pack.md`](writing-a-pack.md), defined once in
`packages/core/src/packs/lint.ts` so this repository and `amroja-biz/rockysurf-shop` enforce the
same rules. Neither command is a security check; what carries that is disclosure of every script
to the operator before consent ([ADR-0006](adr/0006-pack-registry-split-horizon.md)).

### BYO lifecycle against a real sshd

`scripts/e2e/byo-host.mjs` runs the bring-your-own-host provider against a real OpenSSH server in
a container: 75 checks, under two minutes, on a port the script picks rather than 22.

**Why this approach.** It is the only real-infrastructure run with no cloud credential, no secret
and no spend, which is what lets it gate a pull request instead of waiting for the nightly. It
also covers the push bootstrap's NOHUP launcher fallback, which the nightly's cloud runs never
reach because they all boot systemd.

### Release tarballs

`scripts/verify-tarballs.mjs` packs every workspace package as `pnpm publish -r` would, installs
the packed CLI into an empty directory from those tarballs alone with no registry, and runs its
binary.

**Why this approach.** It tests what a published install *unpacks*, as opposed to what it
downloads, which is the closure check's job. Nothing that inspects manifests can see a published
tarball naming versions that do not exist; only an install can.

### Secret scanning

`gitleaks` runs on every pull request over the full history, using a version and a SHA-256 pinned
in `ci.yml` and the rules in `.gitleaks.toml`. `scripts/gitleaks-selftest.mjs` runs in the same
job immediately before the scan and asserts each rule still fires on a fixture, that none fires on
the near-misses in the live tree, and that no path exemption has outlived the files it excuses.

**Why this approach.** A secret scanner's failure mode is silence — a rule that has stopped
matching passes, and a passing scan looks exactly like a clean tree — so the rules are tested
before they are trusted. The binary is pinned by checksum rather than fetched from an action
because a scan that silently stops running is worse than no scan.

### Container packaging

`scripts/docker-smoke.mjs` answers two questions by doing them: does `docker compose up` from a
clean checkout reach the first-run wizard, and does data survive a container restart — the config
file, the database and a byte-identical `secret.key`. It runs under a compose project name and
host port belonging to the process that started it, and tears down with `down -v` on every exit
path. It is run by hand and is not wired into a workflow.

**Why this approach.** Neither question is provable by reading YAML, and a restart that silently
regenerated `secret.key` would still serve a login page while every stored secret became
unreadable.

## Where each check runs

`pnpm run check` is the reference gate: `lint`, then `pnpm -r typecheck`, then `pnpm -r test`.
`pnpm run check:parallel` runs the same work concurrently and reaches the same verdict; if the two
ever disagree, the serial one is right. Neither runs the browser suite, which needs a browser
binary `pnpm install` does not fetch. A build is required before typecheck or tests, because
workspace packages resolve each other through gitignored `dist/` directories.

For a small change — docs-only, a rename, copy, a config tweak, a single-file fix — run only the
checks that can see it and let the pull request's CI be the full gate
([`docs/memories/2026-09-05-small-changes-run-only-relevant-checks.md`](memories/2026-09-05-small-changes-run-only-relevant-checks.md)).

On a pull request, `ci.yml`'s `What changed` job reads the changed-file list from the pull request
itself and sets one output. A pull request confined to `packages/web/`, `docs/`, `.claude/`,
`.agents/skills/`, `.pass-along/`, `LICENSE` or Markdown runs `Typecheck`, `Test`, `Secret scan`
and `UI (browser)`. Anything beyond that also runs `Lint (structure)`, `Release tarballs` and
`BYO lifecycle (real sshd)`. Pushes to `main` are never filtered. `Pack smoke` is its own workflow
and triggers only on paths that reach a box, testing just the changed packs when a pull request
changes only pack files.

`UI (browser)` is deliberately not path-filtered.

**Why this approach.** A required status check that a path filter skips never reports on the pull
requests it skips, and a required check that never reports deadlocks the merge forever
([`docs/memories/2026-08-31-branch-protection-and-pr-workflow.md`](memories/2026-08-31-branch-protection-and-pr-workflow.md)).
The four required checks on `main` — `Test`, `Typecheck`, `Secret scan`, `What changed` — are
exactly the jobs that run unconditionally, and the path-conditional jobs must never be added to
that list. Required-check names are job display names, so renaming a job in `ci.yml` orphans the
ruleset's requirement.

## The nightly real-cloud run

`.github/workflows/nightly-real-cloud.yml`, at 07:00 UTC daily and on manual dispatch, gated to
`github.repository == 'amroja-biz/rockysurf'`. It runs against cloud accounts, projects and
subscriptions that Amroja LLC maintains for this workflow alone — never an account anyone runs
their own Rocky Surf against.

### What it does

For each cloud it runs `scripts/e2e/lifecycle.mjs`, which boots the built `rockysurf` binary from
a real config file and then drives everything through core's own HTTP API, as the SPA would:

- registers the real provider through the composition root and confirms the offering's advertised
  architecture;
- creates one server, waits for `running` and for the push bootstrap to report `ready`;
- downloads the private key from the API, connects over SSH, and asserts both a tool version from
  the installed pack and the box's actual architecture;
- stops the server, waits for it to settle, starts it again, and waits for it to come back;
- terminates it;
- runs a zero-orphan audit with reconciler semantics: nothing this run created survives, every
  managed resource carries valid ownership, the shared network objects each cloud is designed to
  keep do survive, and on AWS no EBS volume outlived termination.

The matrix is Hetzner on amd64, and AWS, GCP and Azure on both amd64 and arm64 — the same code
path with nothing different but the offering id. `sshAllowedCidr` is resolved at run time and
written into the config file; the provider refuses to infer it.

The identity each leg runs under is the policy this project publishes to self-hosters, deployed
unmodified: AWS assumes the role from `deploy/aws/iam-role.yaml` through an OIDC entry role, GCP
impersonates the service account carrying `deploy/gcp/rockysurf-role.yaml`, and Azure federates
into the app registration carrying `deploy/azure/role.bicep`. Each leg asserts its own identity
before doing any work and fails immediately if it is not the published one. There are no
long-lived cloud credentials for AWS, GCP or Azure; Hetzner uses an API token in a repository
secret. Setup is one idempotent script per cloud under `deploy/<cloud>/setup-nightly.sh`, with a
matching teardown.

Cleanup runs twice. `lifecycle.mjs` terminates in a `finally`, and each job then runs a mandatory
sweep step with `if: always()` that deletes only the resource ids the run recorded to
`$ROCKYSURF_E2E_RUN_IDS_FILE` as it created them. Anything else carrying the shared
`managed-by=rockysurf` label is reported and left alone. On AWS a further step sweeps stale SSH
rules off the CI-only security group. The whole workflow is in one `real-cloud` concurrency group
with `cancel-in-progress: false`, so two runs can never race on the shared group.

### Why it is needed

Unit tests structurally cannot see whether the shipped article works against a real cloud API. The
milestone exit runs found four integration gaps between modules whose own tests were green, plus
two pack steps broken by upstream installers moving their binaries.

The identity arrangement adds a second property that nothing else covers: the least-privilege
policy this project publishes is verified continuously. Without it, adding an API call to a
provider silently makes the published policy wrong, every self-hoster's next launch fails with a
permission error, and CI stays green because the nightly ran under a role unrelated to what is
published.

The orphan audit and sweep run under a *different*, CI-only identity on each cloud, because
listing resources outside the run's own labels is a read the provider never makes and the
published role therefore does not grant. An orphan the credentials under test cannot see is an
orphan the audit calls clean, and a sweep wired through the identity under test goes blind at
exactly the moment that identity is what broke. `audit-credentials-selftest.mjs` in the pull-request
lint job keeps that property from decaying unnoticed.

It is not on `pull_request`: a fork must never be able to bill the account by opening a pull
request, and a per-commit real-cloud run would be slow and expensive.

### How failures and errors become actions

- **Missing configuration is a skip with a notice, not a red run.** The preflight job reports
  whether each cloud's secrets and variables are present without printing them, and a cloud that
  is not wired up is skipped with a `::notice::` and a line in the step summary naming exactly
  what is missing and which setup script sets it. A perpetually red scheduled workflow trains
  everyone to ignore it, and the one morning it is red for a real reason nobody looks.
- **A wrong identity fails the job immediately**, before any resource is created, with error
  annotations naming the repository variable to correct. AWS additionally emits a notice every
  morning when `AWS_PROVIDER_ROLE_ARN` is unset, because that configuration makes the run pass
  while proving nothing about the published policy.
- **A leak cleans up and still fails.** The sweep deletes what the run left behind, then exits
  non-zero with an error annotation listing it. The sweep existing is not permission to leak.
- **Every leg uploads its full lifecycle log as a workflow artifact on every path**, success
  included, so a failure is diagnosable from the run page without re-running anything.
- **A failure becomes a GitHub issue**, which is this project's system of record. The class of
  problem the nightly finds is usually not a one-line fix: it is a provider that needs a
  capability, a published role that needs a permission, or a config file nothing validated. Issue
  numbers appear in the workflow header and in the code the fixes landed in.
- **Where a cheaper check could have caught it, one is added in the same fix.** The parity test
  described above exists because two AWS legs died in two seconds on an unrecognised config key
  for two nights running.

### The other scheduled workflow

`price-feed.yml` runs at 05:30 UTC — offset from the nightly so the two never contend — and
republishes the AWS and Azure price documents to GitHub Pages from credential-free public vendor
feeds. It is a publisher rather than a test, and it is listed here because it is the other thing
that turns red on a schedule. A failed run deploys nothing, so already-published prices keep
serving; installs show `price unknown` only once their cache expires.

## Adding to the arrangement

- A change that adds a component something else must wire up gets a wiring test at the seam.
- A change to a page gets a browser test, not only a component test.
- A change to a provider's config keys extends the nightly parity test.
- A rule worth having is a check that fails when the rule is broken, not a note in a review.
- A test that cannot fail is worse than no test, and assertions cite what was measured rather than
  what was intended.
