# Contributing

Thanks for looking. Rocky Surf is small and opinionated, and most of the opinions are written
down — if something in the code looks arbitrary, there is usually an ADR or a doc comment saying
why.

## Setup

**Node 24 or newer** (`engines.node` is `>=24`, and the `rockysurf` binary checks at startup
rather than failing later with a syntax error) and **pnpm**. The repository is a pnpm workspace.

```bash
nvm use 24          # or however you manage node versions
pnpm install
pnpm -r build       # required — see below
pnpm run check      # lint + typecheck + test across the workspace
```

**`pnpm -r build` before typecheck or tests is not optional.** Workspace packages resolve each
other through `dist/`, which is gitignored, so a fresh clone fails typecheck with `TS2307` on
every internal import until something has been built. Both CI jobs build first for exactly this
reason.

`pnpm run check` is the gate. It is three things:

| step | what it is |
|---|---|
| `pnpm run lint` | `check-core-deps.mjs`, `check-iam-policy.mjs`, `check-gitignore-anchors.mjs`, `check-packs-bundle.mjs`, `check-npx-closure.mjs` |
| `pnpm -r typecheck` | `tsc --noEmit` per package |
| `pnpm -r test` | vitest per package |

The lint scripts are structural checks a reviewer would have to remember otherwise: core's
dependency direction, the published AWS IAM policy matching what the provider actually calls, the
AWS SDK staying out of the `npx` install closure, the bundled packs matching `packs/`, and — the
newest, and a scar — that nothing under a package's `src/` is gitignored.

That last one is `rockysurf-ys0i`. A bare `packs/` in `packages/core/.gitignore` matched
`src/packs/` too, because a pattern with no slash matches at any depth; a new file there was
reported as *ignored* rather than untracked, `git add -A` skipped it silently, and a branch was
pushed importing a module it did not contain. Every visible signal said fine. Anchor directory
patterns in a per-package `.gitignore` to where the generated thing actually is — `/packs/`, not
`packs/`.

### The checks `pnpm run check` does not run

Three gates are CI-only, each because it needs something a `pnpm run check` cannot assume — a
Docker daemon, or a `gitleaks` binary. All three are runnable locally when you have those.

| check | command | what it needs |
|---|---|---|
| pack smoke | `node scripts/pack-smoke.mjs --pack <id> --arch arm64` | Docker |
| pack lint | `rockysurf pack lint packs/` | a built workspace — and `pnpm run check` runs it anyway |
| BYO lifecycle | `node scripts/e2e/byo-host.mjs` | Docker, and `127.0.0.1:22` free |
| release tarballs | `node scripts/verify-tarballs.mjs` | ~30s, packs and npm-installs |
| secret scan | `gitleaks git . --config .gitleaks.toml` | the `gitleaks` binary |

**The pack smoke test runs each pack twice in one container and deletes the resume journal in
between.** That deletion is the test. The on-box agent is contracted to skip any step already
marked done, so re-invoking it without clearing `/var/lib/rockysurf/state.json` produces a green
run in which not one install script executed a second time. If you are adding a pack, run the
harness before opening the PR — it is the same code CI runs, and it takes a couple of minutes
per architecture. See [`docs/writing-a-pack.md`](docs/writing-a-pack.md).

**Every leg of the pack-smoke matrix is green, so a red one is about your branch.** It did not
start that way, and the history is the reason to trust the gate: the first time the harness ran
it found two real pack bugs, each of which failed identically on a real cloud box. `gas-town`
needed a `dolt` binary that nothing in `packs/` installed (`rockysurf-nekl`), and `open-claw`
stopped at `openclaw onboard`'s interactive prompt with no TTY, which is rule 3
(`rockysurf-5av5`). Both were fixed rather than skipped, and both packs reach `ready` twice in a
row now.

Don't disable a leg to get a green tick.

## Layout

```
packages/
├── provider-sdk/          # the frozen v0 provider contract — types only, ZERO runtime deps
├── core/                  # the control plane: Hono + Drizzle/SQLite + SSE + in-process jobs
├── provider-aws/          # AWS EC2 — plain RunInstances, no CloudFormation
├── provider-hetzner/      # Hetzner Cloud — plain fetch, no vendor SDK
├── provider-byo/          # bring-your-own hosts over SSH
├── provider-conformance/  # the shared provider test suite; resolved from source in-workspace
├── rockysurf/             # the composition root: the CLI, the MCP server, the npm name
└── web/                   # React SPA; its build output is bundled into core
packs/                     # PR-able pack + tool definitions as YAML
deploy/                    # IaC a self-hoster deploys into their own account (the AWS IAM role)
docs/                      # ADRs, the provider and pack contracts, self-hosting, history
scripts/                   # repo tooling, including the three structural lints
spike/recordings/          # transcripts from the de-risking spike — evidence, not code
```

`spike/recordings/` is all that is left of the throwaway de-risking spike. Its sources were deleted
once the rewrite they de-risked was finished; what survives is the reason the directory existed in
the first place — two real cloud lifecycle transcripts, a callback transcript, and the capability
comparison that became the ADRs. Nothing builds from it and nothing may depend on it.

## The rule that shapes everything

**`@rockysurf/core` may import `@rockysurf/provider-sdk` and nothing else from this workspace.**
Not a provider, not `web`. Providers are loaded at runtime through configuration, and
`packages/rockysurf` is the only package allowed to import both sides.

Two reasons, and both are why it is a CI lint rather than a review convention. The SDK has no
out-of-tree consumers yet, so the lint is the only thing keeping the abstraction honest — if core
can reach into a concrete provider, the interface stops being tested by anything. And it keeps a
cloud vendor's SDK out of core's dependency tree, which is what makes an `npx` cold start fast; a
regression there would be invisible until somebody timed a fresh install.

## Tests

Ordinary unit tests are expected, and one extra kind is expected on top of them.

**Every seam between two components gets a whole-app wiring test.** This is a scar, not a
preference: at one point every module in the repository had passing unit tests while the product
could not bootstrap anything at all. Each test built the wiring it needed and then asserted
behaviour, and that shape *cannot* see a missing composition — the thing being tested was
assembled by the test, not by the application.

So: if your change adds a component that something else must wire up, add a test that boots the
real thing (`createApp`, or the real boot path) and asserts the seam. `packages/core` has both
patterns to copy — the app-level wiring test and the boot-level one. Test at the boot level when
the seam involves configuration, secrets or the filesystem; four app-level tests once stayed
green while every real boot was broken.

Two other habits worth adopting:

- **Assert against evidence, not intent.** The capability matrix documents what was measured on
  real infrastructure and says plainly which column has never been pointed at a rack. Keep it
  that way.
- **A test that cannot fail is worse than no test.** If a rule matters, write the check so that
  breaking the rule breaks the build — the three `scripts/check-*.mjs` lints exist because
  reviewers forget.

## Adding a provider

Read [`docs/writing-a-provider.md`](docs/writing-a-provider.md). Short version: a provider is its
own package, implements ten methods against the frozen SDK, declares its
[capabilities](docs/providers/capability-matrix.md) honestly, passes the shared conformance
suite, and gets registered in one row of `packages/rockysurf/src/compose.ts`. Core does not
change. The SDK shape is frozen by
[ADR-0003](docs/adr/0003-provider-sdk-shape-and-exclusions.md) — changing it means amending that
ADR in the same pull request.

## Adding a pack

Read [`docs/writing-a-pack.md`](docs/writing-a-pack.md), which is normative. A pack is one YAML
file in `packs/`, named for its pack id. The four rules — idempotent, `$ARCH`-aware,
non-interactive, `runAs`-honest — each have a section there with worked examples of the right and
wrong way, and the mechanical ones are enforced by `packages/core/src/packs/packs.test.ts` on
every test run.

**A pack defines whatever tools it installs** — a tool is an id, a description and a script the
author wrote, and nothing has to be registered anywhere first. The only cross-file rules are that
a reference must resolve and an id must not be defined twice.

So: reference the shared base toolchain (`curl`, `git`, `nodejs`, …) by tool id rather than
redefining it, because a reviewer should not have to work out whether a pack's `curl` is the real
one. Anything else your pack needs, it declares. `lint.test.ts` has the worked case — a pack
introducing a tool nothing has ever heard of, linting clean with no core involvement.

Two commands run the contract, and both are published, so a pack that does not live in this
repository is held to the same standard:

```bash
rockysurf pack lint  packs/                                  # static, a second, no Docker
rockysurf pack check packs/ --pack <id> --arch arm64         # the smoke harness
```

`--base-packs` defaults to the packs bundled in the `rockysurf` you are running
(`packages/core/packs` — `rockysurf-io02`), which is what lets a community pack in the shop
resolve the base toolchain with no flag and no clone.

**`packages/core/packs` is a committed copy of this directory, not a build artifact.** Core's
build writes it and `check-packs-bundle.mjs` fails when the two disagree, so editing a pack means
building and committing the copy alongside it. It is committed rather than generated-and-ignored
because generated state that lives only in a working tree is invisible to everyone except the
person who happens to have built — a fresh clone does not have it, and a test that guarded on its
presence would report "did not run" as a pass.
Linting this repository's own `packs/` is unaffected: a base pack whose `packId` the target also
defines is the same pack seen twice and contributes nothing.

`pack lint` is the single definition of the mechanical rules — `packages/core/src/packs/lint.ts`.
It used to be a dozen regexes inside `packs.test.ts`, which was fine while every pack lived in
`packs/` and stopped being fine when packs started arriving from
[`amroja-biz/rockysurf-shop`](https://github.com/amroja-biz/rockysurf-shop): that repository's CI
gates community pull requests with these commands, and a rule that exists in two places will
eventually mean two things. Add a rule to `lint.ts` with a fixture in `lint.test.ts` that breaks
it, and both repositories get it.

Neither command is a security check, and the help text for both says so. Install scripts are
arbitrary root-privileged shell; what they prove is well-formedness and resume-safety. What
carries the rest is disclosure — the control plane shows an operator every script before they
consent — and that split is [ADR-0006](docs/adr/0006-pack-registry-split-horizon.md).

**Community packs belong in the shop, not here.** `packs/` in this repository is Rocky Surf's own
packs: they ship inside the release, and they are what "official" means. A pack you wrote goes to
[`amroja-biz/rockysurf-shop`](https://github.com/amroja-biz/rockysurf-shop), where it is reviewed
and published without waiting on a control-plane release. Adding a pack here is for the
maintainers changing what the product itself ships.

## Documentation

Design decisions go in an ADR under [`docs/adr/`](docs/adr/) — there is a template, and
`llms.txt` is the index. Behaviour that a self-hoster would be surprised by goes in
[`docs/self-hosting.md`](docs/self-hosting.md) or [`SECURITY.md`](SECURITY.md), whichever fits.

The standard for both: **cite what you checked.** If a document says the control plane does
something, that sentence should be true of the code as it is, not of the code as intended. Where
a control is weaker than it sounds, say so in place rather than softening the wording —
`SECURITY.md` has a residual-risks section precisely so nothing has to be shaded.

## Issue tracking

Bugs and feature requests go to
[GitHub issues](https://github.com/amroja-biz/rockysurf/issues); there are templates for
both. Security problems do **not** — see [`SECURITY.md`](SECURITY.md) for private reporting.

Internally the maintainers plan with [beads](https://github.com/gastownhall/beads), a local issue
tracker, which is why commit messages and code comments cite ids like `rockysurf-ftl9.7`. You do
not need beads to contribute and nothing in the workflow requires it; treat those ids as
references to the reasoning behind a change. A `TODO` in the code that names one is pointing at
work that is already tracked, not at work that has been forgotten.

## Commits and pull requests

- Keep commits path-scoped and focused; say *why* in the message, since the diff already says
  what.
- Anything that changes behaviour a document describes changes that document in the same pull
  request.
- Run `pnpm run check` before pushing. If a package you did not touch is failing, say so
  explicitly rather than silently working around it.

## A note on this repository's history

The public git history **starts fresh at `v0.1.0`** with a single initial commit.

Rocky Surf was developed for months as a private, hosted AWS product before being rewritten as
the self-hosted control plane in this repository. That private history is saturated with the
things a public repository must not carry — a real AWS account id, live credential and
installation ids, deployment identifiers of a running SaaS — and rewriting it commit by commit
would be a scrub of thousands of commits with no way to prove it complete.

So the history is not published, and nothing is lost that mattered: the development story is
preserved as prose in [`docs/history/`](docs/history/), scrubbed, alongside the original phase
specifications. The ADRs carry the decisions, and `spike/recordings/` carries the evidence.

`gitleaks` runs on every pull request over the full history, which is what keeps the fresh start
from being a one-time cleanup. If it fires on your branch, do not force-push around it — the
value is in the scan being unignorable.

The rules live in [`.gitleaks.toml`](.gitleaks.toml): the full default rule set, plus two rules
pinned to the old hosted deployment's GitHub App identifiers. Neither is a credential you can
authenticate with, which is exactly why no generic scanner flags them — the open-source control
plane has no GitHub App at all, so a match is either the old deployment's or somebody else's.
(Five rules used to live here — an account id, a Stripe price, and an operator's own name,
username, and worktree name were removed by owner decision 2026-08-21: none of those is a
secret, and blocking someone's own name or an identifier the config file discloses in plain
text was silly.)

Those rules have their own test, `node scripts/gitleaks-selftest.mjs`, and CI runs it in the
same job immediately *before* the scan. A secret scanner is the one check whose failure mode is
silence: a rule that has stopped matching passes, and a passing scan looks exactly like a clean
tree. The self-test asserts each rule still fires on a fixture, that none fires on the
near-misses that exist in this tree, and that no path exemption has outlived the files it
excuses. Change a rule, run it.

## License

By contributing you agree that your contributions are licensed under the
[MIT license](LICENSE). Note that the Rocky Surf name and logo are **not** covered by it; see
[`TRADEMARK.md`](TRADEMARK.md).
