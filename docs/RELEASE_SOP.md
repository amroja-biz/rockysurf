# Release standard operating procedure

*For the maintainer.*

This is the checklist you follow to publish a major, minor, or patch release of Rocky Surf to npm
and to GitHub. It gives the steps and nothing else. For why each step exists — what is published,
why publishing happens in GitHub Actions and not on your machine, and what the tarball checks
guard against — see [`docs/contributing/RELEASING.md`](contributing/RELEASING.md).

## Before you start

Make sure all of the following are true:

- The one-time npm and GitHub setup is done. It happens once, ever, and it is described in the
  "One-time setup" section of
  [`docs/contributing/RELEASING.md`](contributing/RELEASING.md#one-time-setup-the-owner-once-before-the-first-release).
- `main` is at the commit you intend to ship, and its CI run is green.
- Your working tree is clean.
- You are on Node 24: run `source ~/.nvm/nvm.sh && nvm use 24`.
- You are signed in to both tools: `gh auth status` and `npm whoami` each succeed.

## Choose the version number

Rocky Surf follows semantic versioning. Pick the number by asking what the release does to someone
who already uses it. Start with "is anything breaking?", because that answer decides the rest.

A change is breaking when something that worked before stops working:

- A removed or renamed CLI flag, config file key, or HTTP API field.
- A change to the Provider SDK contract that an out-of-tree Provider must be rewritten against.
- A data migration that cannot be undone.
- **A changed default value for an existing setting.** The config file that produced one behavior
  now produces another, which is a break even though nothing was removed.
- **A raised minimum for a runtime the reader has to supply**, such as the minimum Node version.
  An installation that met the old floor stops installing.

Adding a setting that has a default is not breaking: an existing config file keeps behaving as it
did.

### Before 1.0.0

Rocky Surf is in the `0.x` series, so the numbers work as the `0.x` convention has them, and this
is the rule to apply today:

- A breaking change bumps the **minor**: `0.1.0` to `0.2.0`.
- Everything else — a new capability, a fix — bumps the **patch**: `0.1.0` to `0.1.1`.
- The major stays `0` until the owner declares the public surface stable.

`1.0.0` is that declaration, and it is a promise about four surfaces: the CLI flags, the config
file keys, the HTTP API, and the Provider SDK contract. From `1.0.0` on, those are supported, and
breaking any of them costs a major version.

### From 1.0.0 on

Once the major is `1` or higher, the standard rule applies:

- **Major** (`1.0.0` to `2.0.0`): the release contains a breaking change, as defined earlier.
- **Minor** (`1.0.0` to `1.1.0`): a new capability, and everything that worked before still works.
  A new Provider, a new command, a new setting with a default.
- **Patch** (`1.0.0` to `1.0.1`): a fix, with no new capability and nothing removed.

### The lockstep rule

Every package under `packages/` carries the same number, including the ones a given release does
not touch. The workflow enforces it: it refuses a tag whose number does not match the `version`
field in every `package.json`.

The consequence is worth stating plainly, because it surprises people reading the registry: a
package's version tells you which release train it belongs to and which other packages it is
compatible with. It does not tell you that the package changed. A package nobody edited jumps from
`0.1.0` to `0.2.0` along with everything else, and its diff between those two versions is empty.

That is also why there are two unrelated things called "v0" here. The **frozen v0 contract** that
[`docs/contributing/RELEASING.md`](contributing/RELEASING.md) and
[ADR-0003](adr/0003-provider-sdk-shape-and-exclusions.md) describe is the generation of the
Provider SDK's API — the shape an out-of-tree Provider implements. The **package version** of
`@rockysurf/provider-sdk` is the release train. The two move independently: the package version
changes at every release, and the contract generation changes only when the API shape does.

### Pre-releases

A pre-release version takes the form `X.Y.Z-rc.N` — for example, `0.2.0-rc.1`. Use `rc` and no
other identifier, and do not add build metadata.

Any version whose number contains a hyphen publishes under the npm dist-tag `next`, never
`latest`. The workflow reads the tag name and adds `--tag next` for you. This is what keeps
`npx -y rockysurf` serving the last stable release to everyone who has not asked for otherwise;
readers who want the pre-release ask for it by name:

```bash
npx -y rockysurf@next
```

## Publish the release

To publish version `X.Y.Z`, follow these steps. Replace `X.Y.Z` with the version number you chose.

1. Create the release branch from the tip of `main`:

   ```bash
   git checkout -b release/vX.Y.Z origin/main
   ```

2. Set the version on every package at once:

   ```bash
   pnpm -r exec npm version X.Y.Z --no-git-tag-version
   ```

3. Prove the lockfile is current. Internal dependencies use `workspace:*`, so this changes
   nothing, and that is the point:

   ```bash
   pnpm install
   ```

4. Add the release to `CHANGELOG.md`: a new `## [X.Y.Z] - YYYY-MM-DD` section at the top with an
   entry per user-visible change, each naming its pull request, and a compare link at the bottom
   of the file.

5. Commit the bump:

   ```bash
   git commit -am "release: vX.Y.Z"
   ```

6. Push the branch:

   ```bash
   git push -u origin release/vX.Y.Z
   ```

7. Open the pull request:

   ```bash
   gh pr create --fill
   ```

8. Wait for every check to pass:

   ```bash
   gh pr checks --watch
   ```

9. Merge the pull request:

   ```bash
   gh pr merge --squash
   ```

10. Bring the merged commit down:

   ```bash
   git fetch origin
   ```

11. Tag the merged commit. The tag must be annotated, and it must point at `origin/main`; the
    workflow refuses a tag whose commit is not on `main`:

    ```bash
    git tag -a vX.Y.Z -m "vX.Y.Z" origin/main
    ```

12. Push the tag, which starts the release workflow:

    ```bash
    git push origin vX.Y.Z
    ```

13. Approve the deployment. In the repository's Actions tab, open the "Release to npm" run, click
    **Review deployments**, select **npm**, and click **Approve and deploy**. Nothing publishes
    until you do; this click is the human gate.

14. Watch the run to the end:

    ```bash
    gh run watch
    ```

15. Confirm the registry serves the new version:

    ```bash
    npm view rockysurf version
    ```

16. Install it the way an operator will, from an empty directory:

    ```bash
    cd "$(mktemp -d)" && npx -y rockysurf@X.Y.Z --version
    ```

17. Write the GitHub release notes. Issue #130 fixes the four sections they carry: the features in
    the release, the Provider capability matrix, a summary of the security posture, and the
    roadmap. Draft them in a file, then publish:

    ```bash
    gh release create vX.Y.Z --title "vX.Y.Z" --notes-file notes.md
    ```

18. Announce the release wherever you announce releases, and link the release notes rather than
    repeating them.

## What the workflow does for you

`.github/workflows/release.yml` runs on the tag, after your approval. Do not repeat any of this by
hand:

- Proves the tagged commit is on `main`.
- Proves the tag's number matches the `version` in every `package.json`.
- Proves a stable tag's number is greater than the version the registry already serves, so a
  downgrade or a transposed digit fails before anything is published rather than burning a version
  number that can never be reused. Pre-releases are exempt from this check.
- Runs `pnpm -r build` across the whole workspace, then the full `pnpm run check` gate.
- Runs `scripts/verify-tarballs.mjs`, which packs every publishable package, asserts what each
  tarball must and must not contain, and installs the packed CLI into an empty directory.
- Publishes every non-private package with `pnpm publish -r --access public --provenance`, in
  dependency order, with a provenance attestation on each one. A tag whose number contains a
  hyphen publishes under the `next` dist-tag instead of `latest`.
- Installs the published CLI from the real registry by exact version, retrying until the timeout
  set in `release.yml`.

## Review the package READMEs before you bump

> **Caution:** A package's README is copied into its tarball at publish time. npmjs.com shows the
> README from the tarball, so fixing a README on `main` after a release does not change what
> readers see on npmjs.com — the next release does. This has already happened once: the
> `rockysurf` page carried a stale pre-publish note for the life of `0.1.0`.

Read every `packages/*/README.md` as part of the version-bump pull request, and fix what is wrong
there rather than in a follow-up.

## The personal Provider in the release

`@rockysurf/provider-digitalocean` takes the same version number as everything else, even though
the CLI never imports it and the release does not bundle it. It is a personal Provider
([ADR-0026](adr/0026-a-personal-provider-is-a-package-named-in-the-config-file.md)): a user
acquires it by installing it under their own `<dataDir>/providers` directory, and npm is where they
install it from. Publishing it is the only way to ship it, so it releases in lockstep like the
rest.

## Support policy

Only the latest release is supported. A security fix ships as a patch of the current version, and
nothing is backported to an older major or minor: a reader on an older version upgrades to get the
fix.

Removals are announced before they happen. From `1.0.0` on, deprecate the CLI flag, config key, or
API in a minor release, name its replacement in the same release, and remove it no earlier than the
next major. Before `1.0.0`, a removal happens in a minor release and the release notes carry the
entry that says so.

`npm deprecate` is reserved for a published version that is dangerous to run, not for announcing
that a feature is going away.

## If something goes wrong

### The run fails before the Publish step

Nothing reached the registry. The version is still free, so fix the problem and re-cut the tag:

1. Delete the tag locally and on the remote:

   ```bash
   git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
   ```

2. Fix the problem on `main` through a pull request, as with any other change.
3. Repeat the procedure from the tagging step, against the new merged commit.

This is what happened on the first `v0.1.0` run: the workflow ran the gate before the build, the
gate failed, and nothing had been published. The order was fixed on `main` and the tag was re-cut.

### The run fails at "Install the published CLI from the registry"

The publish already succeeded. This step runs after `pnpm publish`, and the registry's read path
lags a fresh publish by minutes, so the step can time out against a version that exists.

Confirm with `npm view rockysurf version`, and wait a few minutes and retry
`npx -y rockysurf@X.Y.Z --version` if it has not caught up yet. Do not delete the tag, do not
re-tag, and do not re-run the workflow: a second publish of a version that already exists fails,
and the release is done.

### A version went out with the wrong contents

You cannot fix it in place. npm refuses to unpublish a version after the window described in the
npm unpublish policy, and a version number, once published, can never be reused even if you do
unpublish it. Publish a patch release with the correct contents and, if the bad version is
dangerous rather than merely wrong, deprecate it with `npm deprecate`.

### Publishing from your machine is not a fallback

Do not run `pnpm publish` or `npm publish` outside the workflow, even when the workflow is broken.
Three things go wrong:

- The registry requires a one-time password for a human write, so the publish stalls or fails
  partway through a nine-package release.
- A version published that way carries no provenance attestation, so nothing links it to a commit
  or a run.
- `npm publish` ships no license text. None of the packages holds its own `LICENSE` file; they are
  MIT because the workspace root is, and pnpm is what copies the root `LICENSE` into each tarball.
  A package published with `npm publish` claims MIT in its manifest and ships nothing to back the
  claim.

If the workflow is broken, fix the workflow.
