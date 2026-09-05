# Releasing Rocky Surf to npm

Ten packages go to the public registry, in lockstep, from one command. This document is the
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
| `@rockysurf/provider-byo` | |
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

None of the ten packages contains its own `LICENSE` file. They are MIT because the workspace root
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
