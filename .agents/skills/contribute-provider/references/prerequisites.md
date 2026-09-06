# Prerequisites — what has to be on the user's own computer

Read this when a check in `SKILL.md` came back missing. **Never install any of these for the
user.** Name what is missing, give them the vendor's page, and stop at the step that needs it — a
skill that installs a package manager on somebody's laptop to get past its own step 1 has exceeded
what anyone asked it to do.

| Tool | macOS | Ubuntu |
|---|---|---|
| Git | Xcode command line tools (`xcode-select --install`), or https://git-scm.com/downloads | `apt-get install git` |
| Node.js 24+ | https://nodejs.org/en/download, or `nvm install 24` (https://github.com/nvm-sh/nvm) | https://github.com/nodesource/distributions, or `nvm install 24` |
| npm | ships with Node | ships with Node |
| pnpm *(only if the package uses it)* | `corepack enable`, or https://pnpm.io/installation | same |
| `gh` | `brew install gh`, or https://cli.github.com/ | https://github.com/cli/cli/blob/trunk/docs/install_linux.md |

## `gh` needs two permissions, and they fail at different steps

`gh --version` succeeding proves nothing about authentication. The check is `gh auth status`, and
it must name a logged-in account. Then there are two separate things this procedure asks that
account to do:

1. **Create a release on the provider's repository** (step 3). This needs write access to that
   repository. If the user does not have it — the provider lives under somebody else's
   organisation, say — the release is theirs to create, and this skill stops there rather than
   inventing a URL for an asset that does not exist. A failure looks like
   `HTTP 403: Resource not accessible by integration` from `gh release create`.
2. **Fork `amroja-biz/rockysurf-shop`** (step 5). Forking a public repository needs no scope
   beyond the default `repo` that `gh auth login` requests, but a token created by hand, or one
   issued for a single organisation, can be authenticated and still unable to fork. That failure
   arrives at `gh repo fork` with a 403, and the fix is the user's to make: `gh auth login` again,
   or a token with `repo`.

Do not work around either by pushing a branch to the upstream repository. A contributor does not
have that access, and the procedure would be a lie.

## `rockysurf-shop-entry` before the SDK's first release

The generator is a bin of `@rockysurf/provider-sdk`, so a provider that depends on the SDK already
has it under `node_modules/.bin` and `npx rockysurf-shop-entry` finds it. **Before the first SDK
release nothing is on the registry yet**, and a bare `npx rockysurf-shop-entry` will not resolve.
Until then, produce the SDK from a checkout and install that tarball — it is the same artifact the
release publishes:

```bash
git clone --depth 1 https://github.com/amroja-biz/rockysurf /tmp/rockysurf
cd /tmp/rockysurf && pnpm install && pnpm -r build
pnpm -C packages/provider-sdk pack --pack-destination /tmp
npm install --save-dev /tmp/rockysurf-provider-sdk-<version>.tgz    # in the provider package
```

If the session is already inside a Rocky Surf checkout, that checkout is the source — build it in
place rather than cloning a second copy, and the bin is
`packages/provider-sdk/dist/bin/shop-entry.js`, run with `node`. Anchor that absolute path in
every command: the working directory changes when you move into the shop clone.

`@rockysurf/provider-conformance` has the same pre-release story, and
[`add-provider`](../../add-provider/references/shipping.md) covers it.

## What is *not* needed

- **Docker.** A provider's acceptance suite is unit tests. Nothing in this procedure starts a
  container. (`contribute-surge-pack` does need it; a pack is verified by running it.)
- **A checkout of Rocky Surf**, once the SDK is on the registry. The generator travels inside the
  package the provider already depends on.
- **A write bit on `amroja-biz/rockysurf-shop`.** The whole procedure runs on a fork.
- **An npm publish.** The tarball can be hosted on a GitHub release, on npm, or on any static host
  that serves the exact bytes over https indefinitely. The walkthrough this skill follows uses a
  GitHub release; the shop's CONTRIBUTING lists the alternatives.

## When one is missing

Name the tool, quote the check that failed, and give the install page. Then stop at the step that
needs it. Do not approximate the step, and do not claim a conformance result or a digest that was
never produced — every number this procedure publishes is one somebody else will re-check.
