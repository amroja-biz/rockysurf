---
name: contribute-provider
description: Contribute a finished Rocky Surf provider to the shop — the community registry at amroja-biz/rockysurf-shop — as a pull request whose `provider listing` check is green on the first push. Use when someone has a working provider package and wants to publish, submit, list, share or "get it into the shop"; says "open a PR for my provider", "list my provider in the registry", "release my provider and add it to providers.json", "how do other people install my provider"; or when a provider pull request there has come back red on the validator or the digest check. Builds, packs, releases the tarball, generates the listing entry from the artifact with `rockysurf-shop-entry`, and refuses to open the pull request when the manifest declares runtime dependencies or the released asset's digest differs from the tarball it read. NOT for writing the provider in the first place: that is `add-provider`. NOT for contributing a Surge Pack, which is a YAML file and a different procedure — that is `contribute-surge-pack`.
---

# Contribute a provider to the shop

The shop is [`amroja-biz/rockysurf-shop`](https://github.com/amroja-biz/rockysurf-shop). A
provider listed there is one JSON object in its `providers.json` — the package name, the URL of a
tarball you host, that tarball's digest, the settings the provider asks for and the capabilities
it answers with. **The shop never holds the artifact.** An operator reads the entry, downloads
your tarball from your release, checks the digest by hand, unpacks it under their data directory,
names it in their config file and restarts. Nothing in Rocky Surf fetches the listing, and
nothing executes at install.

Your job here is narrow and mechanical: **take a provider that already builds and passes
conformance, and end with a pull request that a maintainer only has to make a judgement about.**
Every question a machine can answer — is `dist/` in the tarball, does the manifest resolve
anything at install time, does the release serve the exact bytes that were hashed, does the entry
describe the artifact — gets answered on this machine, before the pull request exists.

**You are not writing the provider here.** If the user does not have one that builds and passes
`@rockysurf/provider-conformance`, that is [`add-provider`](../add-provider/SKILL.md) — the
research protocol, the nine methods, the capability answers and the acceptance bar. Come back when
there is a package. If they want to contribute a *Surge Pack* (a YAML file describing scripts to
run on a server, not code that runs inside Rocky Surf), that is
[`contribute-surge-pack`](../contribute-surge-pack/SKILL.md).

**The normative documents are in two places and neither is this skill.** The shop's
[`CONTRIBUTING.md`](https://github.com/amroja-biz/rockysurf-shop/blob/main/CONTRIBUTING.md),
section "Contributing a provider", says what that repository expects; Rocky Surf's
[`docs/writing-a-provider.md`](https://github.com/amroja-biz/rockysurf/blob/main/docs/writing-a-provider.md)
is the authoring contract. When either disagrees with what you read here, it wins — say so to the
user and follow it.

## Prerequisites

What has to be on **the user's own computer**. Check all of them before step 1, rather than
discovering at step 3 that the release cannot be created. If one is missing, tell the user which
and where it comes from — **do not install it for them**, and do not route around it.

| Tool | Why this skill needs it | Check |
|---|---|---|
| Git | the release is a tag in the provider's repository, and the contribution is a branch on a fork | `git --version` |
| Node.js 24+ | the provider is a Node package and `engines.node` is `>=24`; the entry generator runs on it | `node --version` |
| npm (or pnpm) | `npm pack` produces the tarball, and the same manager runs the build and the conformance suite | `npm --version` |
| `gh`, logged in | it must be an account that may **create a release on the provider's repository** and **fork a public repository**. Those are two different permissions and they fail at different steps | `gh auth status` |
| `rockysurf-shop-entry` | the listing entry is read out of the artifact, never typed. It is a bin of `@rockysurf/provider-sdk`, which the provider already depends on | `npx rockysurf-shop-entry --help` |

[`references/prerequisites.md`](references/prerequisites.md) has the install page for each on
macOS and Ubuntu, the two ways `gh` is authenticated and still cannot do the job, and what to run
before the SDK's first release puts the generator on the registry.

Docker is **not** a prerequisite: a provider's acceptance suite is unit tests, and nothing here
starts a container.

## Step 1 — The provider, and the bar it must already pass

Ask for the package directory if you do not have it. Three things must be true before anything
else happens, and each is a command rather than an assurance:

1. **It builds.** `npm run build` (or `pnpm build`) in the package, and `dist/` exists afterwards.
2. **It passes conformance.** `npm test`, running `@rockysurf/provider-conformance` — at minimum
   `assertFactoryShape` and the absence-grace harness. A provider that has never run the suite is
   not ready to be listed; hand it back to [`add-provider`](../add-provider/SKILL.md).
3. **Its source is in a public repository.** Operators are being asked to run this code with their
   Rocky Surf process's full access — its database, its master key, every cloud credential in its
   environment. A listing that points at code nobody can read is a listing a maintainer will
   refuse, and rightly.

Read `name`, `version` and `exports` (or `main`) out of `package.json` now. Those three decide the
tarball's filename, the release tag, the entry, the branch name and the commit message.

## Step 2 — Pack, and check what came out

```bash
npm run build
npm pack                    # or: pnpm pack --pack-destination <somewhere>
```

`npm pack` writes `<name with @ dropped and / turned into ->-<version>.tgz`. Three checks on it,
all cheap, each of which catches a failure that would otherwise arrive at an operator's restart:

```bash
tar -tzf <file>.tgz
tar -xzOf <file>.tgz package/package.json | grep -A3 '"dependencies"'
shasum -a 256 <file>.tgz
```

- **`dist/` is in the tarball**, and specifically the file `exports` points at, normally
  `package/dist/index.js`. A tarball carrying `package.json` and no `dist/` is the commonest way a
  publish goes wrong; Rocky Surf refuses it at the operator's next start with *is the package
  built?*
- **No runtime `dependencies`.** No output from that `grep` is the right answer. The documented
  install is `tar -xzf` and nothing else — no `npm install`, no lifecycle script — so a dependency
  the manifest names is an import that throws at the operator's next start. **This is a refusal,
  not a warning.** A package with runtime dependencies does not get a release and does not get a
  pull request; tell the user which dependencies, and that the fix is to bundle them into `dist/`
  the way `@rockysurf/provider-digitalocean` does with `esbuild` and a `devDependency`.
- **The digest**, which is the number every later step is measured against.

[`references/release.md`](references/release.md) has each command in full, what each proves, and
the failure-to-cause table.

## Step 3 — Release the tarball, then download it back

A GitHub release is a tag with files attached; each attached file gets a permanent `https://`
download URL, which is what the listing needs.

**The tag name depends on where the provider lives, and getting it wrong is not cosmetic.**

| The provider's repository | Tag |
|---|---|
| holds this provider and nothing else | `v<version>` — e.g. `v1.0.0` |
| is a **monorepo** holding this provider among other packages | `provider-<providerId>-v<version>` — e.g. `provider-digitalocean-v0.1.0` |

A monorepo's `v1.0.0` belongs to the repository, not to one package inside it, so a bare version
tag there either collides with a release that means something else or silently claims the whole
repository is at that version. Package-scoped tags are the only ones that stay true when the
second provider ships. Ask which case applies if the repository layout does not make it obvious.

```bash
git tag <tag> && git push origin <tag>
gh release create <tag> ./<file>.tgz \
  --title "<package name> <version>" \
  --notes "Install per https://github.com/amroja-biz/rockysurf-shop#installing-one"
```

Then **download the asset back and compare the digest with step 2's.** This is not ceremony: it
is the only proof that the URL the listing publishes serves the bytes that were hashed, and the
shop's CI will make exactly this comparison in public.

```bash
curl -fL -o /tmp/released.tgz \
  https://github.com/<owner>/<repo>/releases/download/<tag>/<file>.tgz
shasum -a 256 /tmp/released.tgz
```

**A mismatch stops everything.** No entry, no pull request. It means a different file was attached
than was hashed, and the fix is in the release, not in the listing. Say so plainly and fix the
release. Never edit the digest to match what came down — that is the one edit that turns a caught
error into a shipped one.

## Step 4 — Generate the entry. Never compose it

```bash
npx rockysurf-shop-entry <file>.tgz \
  --tarball-url https://github.com/<owner>/<repo>/releases/download/<tag>/<file>.tgz \
  --description "<one line>"
```

Nine fields, and **only those two options are things anyone writes.** `providerId` comes from the
factory, `name` from the settings declaration's title, `version` and `package` from the manifest,
`settings` from the declared fields in declared order, `capabilities` from the provider
`createProvider()` returns, and `sha256` from the bytes of the file named on the command line.
A settings summary transcribed by hand and a capability struct copied out of a source file are two
transcriptions that drift from the artifact silently and are checked by nobody.

**Ask the user for the description**, in their words — it is the one line an operator reads before
deciding to install, and neither you nor the artifact can supply it. One sentence: which cloud,
what it needs, what it does. Then print the output and mark those two values as theirs.

The generator refuses two things here rather than letting a public pull request find them: a
manifest with runtime `dependencies`, naming them, and a `--tarball-url` that is not https. If
either fires, go back — step 2 for the first, step 3 for the second.

**Re-run it rather than editing its output.** Any change to the package makes the whole entry
stale, not one field of it.

## Step 5 — Fork, branch, add the entry, validate, commit

Follow [`references/pull-request.md`](references/pull-request.md), which has the commands. In
outline:

```bash
gh repo fork amroja-biz/rockysurf-shop --clone
cd rockysurf-shop
git checkout -b providers/<providerId>
# append the generated object to providers.json's `providers` array
# set `generatedAt` at the top of the file to now, in the ISO-8601 form it already has
node scripts/validate-providers.mjs providers.json
git add providers.json
git commit -m "providers: add <providerId> <version>"
```

The validator is the first thing the shop's CI runs and it needs no install. It prints
`providers.json: N provider entries, all valid`, or every problem with the field it is in. **Do
not open the pull request until it is clean.**

One file moves: `providers.json`, and nothing else. A pull request that also touches the README or
a workflow is a different review.

## Step 6 — Open the pull request

[`assets/pr-body-template.md`](assets/pr-body-template.md) is the body to fill in. It carries the
link to the provider's source repository, which the shop's CONTRIBUTING asks for by name, because
reading that source is the only review a provider gets.

```bash
git push -u origin providers/<providerId>
gh pr create --repo amroja-biz/rockysurf-shop --base main \
  --title "providers: add <providerId> <version>" --body-file <the filled-in body>
```

## Step 7 — Watch the checks once, and fix what is red

```bash
gh pr checks <number> --repo amroja-biz/rockysurf-shop --watch
```

Once, for the whole set — it exits 0 even when a check failed, so read the output rather than the
exit code. One workflow runs, `provider listing`, in two steps:

| Step | What red means |
|---|---|
| `node scripts/validate-providers.mjs providers.json` | the entry's shape — an unknown field, a bad `providerId`, a `sha256` that is not 64 hex characters, a `generatedAt` that is not a timestamp. Reproduce it locally; it is the same command and the same message |
| Every tarball matches the sha256 the listing publishes | it downloads every tarball in the file and compares. Red means the release asset is not the file the digest describes — step 3, and the fix is in the release |

Fix red on the branch and push again; the same job re-runs. If it is red for a reason this
contribution cannot have caused — another entry's tarball, say — say so plainly to the user rather
than pushing at it.

## Step 8 — Hand it over

End with the pull request URL and this, in one sentence, not softened:

> A maintainer will still read the provider's code before merging, because it runs with the
> operator's full access.

That is the whole point of the review the pull request is entering. The validator checks the shape
of a description and the digest check proves the tarball at the URL is the one that was described;
neither says anything about what the code does when it runs, and nothing in the shop claims
otherwise. Tell the user what was actually proven — the suite that ran, the digest round trip, the
date — and what was not.

## Reference files

- [`references/prerequisites.md`](references/prerequisites.md) — the five tools, their install
  pages for macOS and Ubuntu, the two `gh` permissions and how each fails. Read it when a check
  above came back missing.
- [`references/release.md`](references/release.md) — steps 2 to 4 in full: the tarball checks with
  their exact commands, the tag rule with its reasoning, the digest round trip, and what each
  refusal means. Read it before packing, and again when something fails.
- [`references/pull-request.md`](references/pull-request.md) — fork, branch, the `providers.json`
  edit, `generatedAt`, the validator, the commit, the body, and the red-CI triage. Read it at
  step 5.
- [`references/acceptance.md`](references/acceptance.md) — how this skill itself is verified: the
  live run, what it must produce, and what the last rehearsal did and did not exercise. Read it
  only if you are changing this skill.
- [`assets/pr-body-template.md`](assets/pr-body-template.md) — the pull request body to fill in.
