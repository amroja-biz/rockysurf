# Releasing Rocky Surf to npm

*For the maintainer.*

Nine packages go to the public registry, in lockstep, from one command. This document is the
procedure and the reasons — the reasons matter, because three of the steps look optional and are
not.

## What is published, and what is not

| package | why it is public |
|---|---|
| `rockysurf` | the thing `npx rockysurf` installs — the composition root, and the only one with a `bin` |
| `@rockysurf/core` | the control plane, so someone can build their own composition root |
| `@rockysurf/provider-sdk` | the frozen v0 contract an out-of-tree provider implements |
| `@rockysurf/provider-aws` | |
| `@rockysurf/provider-azure` | |
| `@rockysurf/provider-gcp` | |
| `@rockysurf/provider-hetzner` | |
| `@rockysurf/provider-conformance` | the acceptance bar a provider runs against itself, so an out-of-tree author can run it too |
| `@rockysurf/provider-digitalocean` | a PERSONAL provider (ADR-0026): nothing imports it and the CLI does not bundle it, so it is public because installing it is the only way to have it |

| package | why it stays `private: true` |
|---|---|
| `@rockysurf/web` | not a library. Its build output is copied into `@rockysurf/core/public` and shipped there |

**`@rockysurf/provider-digitalocean` is the one package nothing else in the release depends on**,
and that is what it is for. It is a personal provider (ADR-0026): the composition root does not
name it, `check-core-deps.mjs` does not require it, and an installation acquires it by putting it
under `<dataDir>/providers` — with `npm install`, or by extracting the tarball, which works because
the package declares no runtime dependencies and its build bundles what it uses of the SDK into its
own `dist/`. `packages/rockysurf/src/personal-provider-tarball.test.ts` packs and extracts it on
every CI run and boots the loader against the result, so the release cannot quietly stop producing
an installable artifact.

**Why all ten rather than one bundled tarball.** Bundling the providers and core into the
`rockysurf` tarball was considered and rejected. `better-sqlite3` and `ssh2` are native modules
and cannot be bundled; and an out-of-tree provider author needs a real `@rockysurf/provider-sdk`
on the registry to build against, which means the scope is public regardless. Once the scope is
public, a private core buys nothing and costs the ability to embed the control plane.

**`@rockysurf/provider-conformance` is the one package whose tarball manifest differs from the
one in the repository, and that is deliberate** (`rockysurf-92nv`). In the workspace its `main`,
`types` and `exports` point at `src/`, because provider packages depend on it from their *tests*
and `pnpm run check` runs `test` without running `build` — pointing at `dist/` would make every
provider's test run wait on this package being compiled first. A published package cannot ship
TypeScript sources, so its `publishConfig` overrides those same three fields to `dist/`, and pnpm
applies the override at pack time. If you are diffing a tarball against the repository and the
entry points disagree, that is why. `scripts/verify-tarballs.mjs` checks the packed form.

It was `private: true` until the ninth slot was added, which meant the acceptance bar the standard
points authors at could not be installed by the out-of-tree authors it was written for — they
could only vendor the checks or work inside a checkout. Publishing it also removed the reason
`npm install` inside an *extracted* tarball used to fail: the `devDependency` on it, which appears
in six published manifests, no longer names a version nobody can install.

## One-time setup (the owner, once, before the first release)

Publishing is done by GitHub Actions, never from a laptop (issue #275): npm **Trusted
Publishing** lets the registry accept a publish of each package only from
`.github/workflows/release.yml` in this repository, authenticated by a short-lived OIDC token
GitHub mints for the run. No npm token exists anywhere. Setting that up is one script, run once,
after the account-side steps:

1. **npm account with two-factor authentication.** Done — the account is `jbdamask`, which
   published `rockysurf@0.0.1` on 2026-08-12; 2FA was enabled on 2026-09-06 and no tokens exist.
2. **The organization `rockysurf`**, which is what owns the `@rockysurf` scope. A 404 on
   `@rockysurf/anything` does *not* prove the scope is free — a scope can be owned and empty.
   Creating the org (npmjs.com → Add Organization → `rockysurf`, free/public) is the test; if the
   name is taken, every scoped package name below has to change before anything else happens.
3. `npm install -g npm@latest` (`npm trust` needs 11.15.0+), `npm login`, `npm whoami`.
4. **`node scripts/npm-bootstrap-trust.mjs`** (add `--dry-run` first to see the plan). For each of
   the nine publishable packages it: publishes a deprecated `0.0.0` placeholder if the name is not
   on the registry yet, because npm cannot attach a trusted publisher to a package that does not
   exist and eight of the nine do not; attaches the trusted publisher (this repository,
   `release.yml`, environment `npm`); and sets `mfa=publish`, so a human publish needs a second
   factor and automation tokens are refused. It prompts for a one-time password per placeholder.
5. **The `npm` environment on GitHub** — created 2026-09-06 with the owner as required reviewer
   and deployments limited to `v*` tags. Every release waits for the owner's approval in the
   Actions UI; that click is the human gate.

After step 4, `https://www.npmjs.com/package/<name>/access` shows the trusted publisher on each
package, and a local `pnpm publish` is refused by the registry's 2FA-for-writes rule unless the
owner types a code — which they should never need to.

### Where the names live

This table is the record the repository keeps of who owns the published identities. **Fill it in
as each one is claimed** — the point is that a future maintainer can find out who to ask without
guessing, and that "who owns the npm org" never becomes a question only one person can answer.

| identity | status | where it lives |
|---|---|---|
| npm user account | `jbdamask`, 2FA on (2026-09-06), no tokens | the owner's password manager |
| npm org `rockysurf` (owns the `@rockysurf` scope) | **exists** — confirmed by the owner 2026-09-06 | npmjs.com, owner `jbdamask` |
| unscoped npm name `rockysurf` | **claimed** — `rockysurf@0.0.1`, published 2026-08-12 by `jbdamask` | trusted publisher attached by step 4 |
| GitHub environment `npm` on this repository | created 2026-09-06: required reviewer `jbdamask`, tags `v*` only | repository Settings → Environments |
| GitHub org `amroja-biz` | in use — this repository is `amroja-biz/rockysurf` | GitHub, under the owner's account |

A 404 on `@rockysurf/anything` never proved the scope was free; the org's existence is what
settles it, and it is settled.

Recording the 2FA recovery codes anywhere in this repository would be a bad idea; the table
points at where they are, and nothing more.

## The release

A release is a merged version bump, a tag, and an approval. The workflow does the rest.

```bash
source ~/.nvm/nvm.sh && nvm use 24

# 1. Version, in lockstep, on a branch. Every package carries the same number; internal deps use
#    `workspace:*`, so nothing else changes. Open the PR, let CI go green, merge it.
git checkout -b release/v0.2.0 origin/main
pnpm -r exec npm version 0.2.0 --no-git-tag-version
pnpm install                       # a no-op for workspace:* deps; run it so the lockfile is proven current
git commit -am "release: v0.2.0" && git push -u origin release/v0.2.0
gh pr create --fill && gh pr merge --auto --squash

# 2. Tag the MERGED commit on main, and push the tag. The workflow refuses a tag whose commit
#    is not on main and a tag that does not match every package.json.
git fetch origin && git tag -a v0.2.0 -m "v0.2.0" origin/main && git push origin v0.2.0

# 3. Approve. Actions → "Release to npm" → Review deployments → npm → Approve.
```

`.github/workflows/release.yml` then runs, on the tagged commit: `pnpm -r build`, `pnpm run check`
(the whole workspace, never `--filter` — see the warning below), `scripts/verify-tarballs.mjs`,
`pnpm publish -r --access public --provenance`, and finally `npx rockysurf@0.2.0 --version` from
an empty directory against the real registry. `pnpm publish -r` skips `private: true` packages,
resolves every `workspace:*` specifier to the version being published, and orders the publishes
topologically so `@rockysurf/core` lands before `rockysurf` depends on it. The workflow passes
`--no-git-checks` because a tag checkout is a detached HEAD; the is-on-main step above it is
what replaces that check.

**A local `pnpm publish` is not a fallback.** The registry refuses it without a one-time
password, and a version published that way carries no provenance. If the workflow is broken,
fix the workflow.

### `pnpm publish`, never `npm publish`

None of the nine packages contains its own `LICENSE` file. They are MIT because the workspace root
is, and the text reaches each tarball **only because pnpm copies the root `LICENSE` into packages
that lack one**. Running `npm publish` from inside `packages/provider-sdk` produces a package that
claims MIT in its manifest and ships no license text at all — a bare claim, which is worse than no
claim.

Verified by tarball inspection (`rockysurf-gonw.2`, re-verified for all six under
`rockysurf-3hz9`, and again for the two cloud providers added since — `@rockysurf/provider-azure`
and `@rockysurf/provider-gcp`): `package/LICENSE` is present in every tarball packed by pnpm.

### `pack` does not check that `files` matched anything

Every published package has a `files` allowlist whose first entry is `dist`. If `dist` is absent —
a failed build, an interrupted one, a `clean` that ran and did not finish — `pnpm pack` **succeeds
silently** and emits a three-file tarball containing `package.json`, `LICENSE` and `README.md`.
It installs fine. It resolves fine. It has no code in it.

This is not hypothetical: it happened during the verification for `rockysurf-3hz9`, when a
concurrent `pnpm -r build` in a shared worktree emptied `packages/provider-sdk/dist` (its build
script cleans first) while a pack loop was running. All six tarballs came out empty of `dist` and
nothing reported an error.

Hence step 4, and hence "never `--filter` the build": `@rockysurf/core` ships `public/`, which is
produced by `@rockysurf/web`, a package `--filter @rockysurf/core build` does not build.

## Verifying a release

`scripts/verify-tarballs.mjs` packs every publishable package into a temporary directory and
asserts, per tarball:

- `LICENSE` and `README.md` are present;
- `dist/` is present and non-empty;
- no `src/`, no `*.test.*`, no `tsconfig*`, no `node_modules`;
- no `workspace:` specifier survived the rewrite;
- `private` is not set.

It then installs the packed `rockysurf` tarball into an empty directory — with the five sibling
tarballs substituted through npm `overrides`, so nothing is fetched from the registry — and runs
`rockysurf --version` against it. That last step is the one that would have caught
`rockysurf-3hz9`: the CLI's dependency closure is only provably installable when it has actually
been installed.

## After publishing

```bash
npx rockysurf@0.2.0 --version
```

From a machine that has never seen this repository, against the real registry. Anything less is
checking the tarball, not the release.

### Retire the pre-publish notes, once, after v0.1.0

Until `rockysurf` is on the registry, `npx rockysurf` is advice npm cannot honour, so several
documents carry a note saying so and pointing at `node packages/rockysurf/dist/bin.js` instead
(`rockysurf-lsi1`, `rockysurf-emfu`). **They become false at the first successful publish**, and
a stale honesty note is worse than none — it tells a reader the thing they are holding does not
exist. Grep the tree and delete them in one commit:

```bash
grep -rn "on npm\|before the v0.1.0 release\|Not yet published\|Not published yet" \
  --include='*.md' --include='*.tsx' . | grep -v node_modules
```

At the time of writing that finds `README.md`, `docs/self-hosting.md`, the three provider pages
under `docs/providers/`, four package READMEs, and the help page in
`packages/web/src/pages/HelpPage.tsx` — whose test pins the wording, so the test changes with it.
The provider pages should keep `node packages/rockysurf/dist/bin.js` working as an alternative;
what goes is the claim that it is the *only* thing that works.
