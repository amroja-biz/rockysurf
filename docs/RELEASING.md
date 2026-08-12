# Releasing Rocky Surf to npm

Six packages go to the public registry, in lockstep, from one command. This document is the
procedure and the reasons — the reasons matter, because three of the steps look optional and are
not.

## What is published, and what is not

| package | why it is public |
|---|---|
| `rockysurf` | the thing `npx rockysurf` installs — the composition root, and the only one with a `bin` |
| `@rockysurf/core` | the control plane, so someone can build their own composition root |
| `@rockysurf/provider-sdk` | the frozen v0 contract an out-of-tree provider implements |
| `@rockysurf/provider-aws` | |
| `@rockysurf/provider-hetzner` | |
| `@rockysurf/provider-byo` | |

| package | why it stays `private: true` |
|---|---|
| `@rockysurf/web` | not a library. Its build output is copied into `@rockysurf/core/public` and shipped there |
| `@rockysurf/provider-conformance` | test-only, resolved from source, never a runtime dependency |

**Why all six rather than one bundled tarball.** Bundling the providers and core into the
`rockysurf` tarball was considered and rejected. `better-sqlite3` and `ssh2` are native modules
and cannot be bundled; and an out-of-tree provider author needs a real `@rockysurf/provider-sdk`
on the registry to build against, which means the scope is public regardless. Once the scope is
public, a private core buys nothing and costs the ability to embed the control plane.

`@rockysurf/provider-conformance` still appears as a `devDependency` in four published
manifests, rewritten to a version nobody can install. That is harmless — consumers never install
a published package's devDependencies — but it is why `npm install` inside an *extracted* tarball
fails, and worth knowing before someone reports it as a bug.

## One-time setup (the owner, once, before the first release)

Nothing below is automatable and nothing below has been done from this repository — as of
2026-08-12 `rockysurf`, `@rockysurf/core` and `@rockysurf/provider-sdk` all return 404 from the
registry, so the names were still unclaimed, but nobody is logged in on this machine.

1. **Create the npm account** and turn on two-factor authentication. Publishing with 2FA prompts
   for an OTP once per `pnpm publish -r` run, not once per package.
2. **Create the organization `rockysurf`.** This is what claims the `@rockysurf` scope; there is
   no other way to reserve it, and a 404 on `@rockysurf/anything` does *not* prove the scope is
   free — a scope can be owned and empty. Creating the org is the test.
3. **Claim the unscoped name `rockysurf`** by being the first to publish it. Until then any
   `npm view rockysurf` 404 is a race, not a reservation.
4. `npm login`, then confirm with `npm whoami`.

### Where the names live

This table is the record the repository keeps of who owns the published identities. **Fill it in
as each one is claimed** — the point is that a future maintainer can find out who to ask without
guessing, and that "who owns the npm org" never becomes a question only one person can answer.

| identity | status | where it lives |
|---|---|---|
| npm user account | **not created** as of 2026-08-12 | _(fill in: the account name, and which password manager holds it)_ |
| npm org `rockysurf` (owns the `@rockysurf` scope) | **not created** as of 2026-08-12 | _(fill in: org name, and the accounts with owner rights)_ |
| unscoped npm name `rockysurf` | **not claimed** — 404 from the registry as of 2026-08-12 | claimed by publishing it, step 3 above |
| GitHub org `amroja-biz` | in use — this repository is `amroja-biz/rockysurf` | GitHub, under the owner's account |

Two things not to read into that table. A 404 on `@rockysurf/anything` does **not** prove the
scope is free, so "not created" above means nobody here has created it, not that nobody has.
And nothing was claimed from this repository: as of 2026-08-12 there is no `~/.npmrc` on the
build machine and `npm whoami` has never succeeded here.

Recording the 2FA recovery codes anywhere in this repository would be a bad idea; the table
points at where they are, and nothing more.

## The release

Run from a clean checkout of the release commit.

```bash
source ~/.nvm/nvm.sh && nvm use 24

# 1. Version, in lockstep. Every package carries the same number; internal deps use
#    `workspace:*`, so nothing has to be rewritten when it changes.
pnpm -r exec npm version 0.2.0 --no-git-tag-version

# 2. Gates.
pnpm install
pnpm run check          # lint (incl. the npx closure check) + typecheck + tests

# 3. Build. The WHOLE workspace, never `--filter` — see the warning below.
pnpm -r build

# 4. Verify the tarballs before anything leaves the machine.
node scripts/verify-tarballs.mjs

# 5. Publish. `pnpm`, never `npm` — see the warning below.
pnpm publish -r --access public

# 6. Tag.
git commit -am "release: v0.2.0"
git tag -a v0.2.0 -m "v0.2.0"
git push && git push --tags
```

`pnpm publish -r` skips `private: true` packages, resolves every `workspace:*` specifier to the
concrete version being published, and orders the publishes topologically so `@rockysurf/core`
lands before `rockysurf` depends on it. It refuses to run on a dirty tree or a detached HEAD;
that check exists for a reason, and `--no-git-checks` should not become habit.

### `pnpm publish`, never `npm publish`

None of the six packages contains its own `LICENSE` file. They are MIT because the workspace root
is, and the text reaches each tarball **only because pnpm copies the root `LICENSE` into packages
that lack one**. Running `npm publish` from inside `packages/provider-sdk` produces a package that
claims MIT in its manifest and ships no license text at all — a bare claim, which is worse than no
claim.

Verified by tarball inspection (`rockysurf-gonw.2`, re-verified for all six under
`rockysurf-3hz9`): `package/LICENSE` is present in every tarball packed by pnpm.

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
