# Pack, release, generate — steps 2 to 4 in full

Read this before packing, and again when one of the checks fails. Everything here happens in the
**provider's** repository; nothing in it touches the shop.

The example throughout is a provider `mycloud`, package `@you/rockysurf-provider-mycloud` at
`1.0.0`, in a repository `you/rockysurf-provider-mycloud`. Substitute.

## Step 2 — pack, and check what came out

```bash
npm run build      # or pnpm build
npm pack           # or: pnpm pack --pack-destination <dir>
```

`npm pack` writes `you-rockysurf-provider-mycloud-1.0.0.tgz` — a scoped name has its `@` dropped
and its `/` turned into `-`. It is exactly the archive an operator unpacks: gzipped ustar, every
member under `package/`.

### 2a. `dist/` is in it

```bash
tar -tzf you-rockysurf-provider-mycloud-1.0.0.tgz
```

Every path is under `package/`. The file the manifest's `exports` (or `main`) points at must be in
the list — normally `package/dist/index.js`. A tarball carrying `package.json` and no `dist/` is
the commonest way a publish goes wrong, usually because `files` omits `dist` or the build was
never run; Rocky Surf refuses it at the operator's next start with *is the package built?*, and
by then the listing is merged.

### 2b. The manifest declares no runtime dependencies

```bash
tar -xzOf you-rockysurf-provider-mycloud-1.0.0.tgz package/package.json | grep -A3 '"dependencies"'
```

**No output is the right answer.** Read the manifest inside the *tarball*, not the one on disk:
those differ whenever a build step rewrites it, and the tarball is what the operator gets.

This is a refusal. The documented install is `tar -xzf` under the operator's data directory and
nothing else — no `npm install`, no lifecycle script, nothing from the package executed until
Rocky Surf imports it at the next restart. So a dependency the manifest names is not a slow
install, it is an import that throws. Tell the user which dependencies were found and that the fix
is to bundle them: `@rockysurf/provider-digitalocean` compiles the SDK helpers it uses into its own
`dist/` with `esbuild` and keeps the SDK as a `devDependency`, which is the shape to copy.

`devDependencies` are irrelevant here. They are not in the published manifest's `dependencies` and
nobody checks them.

### 2c. The digest

```bash
shasum -a 256 you-rockysurf-provider-mycloud-1.0.0.tgz
```

Sixty-four lowercase hex characters. Write it down — step 3 compares against it, and step 4's
generator produces it independently from the same file, which is a third opportunity to notice
that two different files are in play.

## Step 3 — the release

### The tag

| The provider's repository | Tag | Example |
|---|---|---|
| holds this provider and nothing else | `v<version>` | `v1.0.0` |
| is a monorepo holding this provider among other packages | `provider-<providerId>-v<version>` | `provider-digitalocean-v0.1.0` |

**Why the second form exists.** A tag names a point in a repository, not in a directory inside it.
In a monorepo, `v1.0.0` therefore claims the whole repository is at 1.0.0 — which is either
untrue or, worse, true of something else, and it collides the moment a second package wants its
own release. Package-scoped tags stay true and stay unambiguous, and the release page reads as a
list of package releases rather than a list of repository states that happen to carry assets.

`@rockysurf/provider-digitalocean` lives in the Rocky Surf monorepo, so its tag is
`provider-digitalocean-v0.1.0` and never `v0.1.0`.

Ask which case applies if the layout does not settle it. A `packages/` directory with siblings is
a monorepo; a repository whose root `package.json` *is* the provider is not.

### Creating it

```bash
git tag provider-mycloud-v1.0.0
git push origin provider-mycloud-v1.0.0
gh release create provider-mycloud-v1.0.0 ./you-rockysurf-provider-mycloud-1.0.0.tgz \
  --title "@you/rockysurf-provider-mycloud 1.0.0" \
  --notes "First release. Install per https://github.com/amroja-biz/rockysurf-shop#installing-one"
```

In the browser instead: **Releases** → **Draft a new release**, choose or create the tag, attach
the `.tgz` under **Attach binaries**, **Publish release**.

The download URL of an attached file always has this shape, and it is what the listing will carry:

```
https://github.com/<owner>/<repo>/releases/download/<tag>/<file name>
```

### The digest round trip — the step that is not ceremony

```bash
curl -fL -o /tmp/released.tgz \
  https://github.com/you/rockysurf-provider-mycloud/releases/download/provider-mycloud-v1.0.0/you-rockysurf-provider-mycloud-1.0.0.tgz
shasum -a 256 /tmp/released.tgz
```

Compare with 2c. It is the only proof that the URL the listing publishes serves the bytes that
were hashed, and it is the same comparison the shop's CI makes in public on the pull request, and
the same one every operator makes before unpacking.

**A mismatch stops the procedure.** It means a different file was attached than was hashed —
usually a stale `.tgz` left in the directory from a previous version, or a rebuild between the
hash and the upload. Fix the release: delete the asset, re-upload the file that was hashed, and
run the round trip again.

Never change the digest to match what came down. That edit turns an error this procedure caught
into one an operator meets at their own command line, and it is the only way this workflow can
make things worse than doing nothing.

**After the listing merges, an asset is immutable.** Do not delete or re-upload it: operators
compare the digest, and a changed file fails their install. A new version is a new tag, a new
release and a new pull request.

## Step 4 — the entry

```bash
npx rockysurf-shop-entry you-rockysurf-provider-mycloud-1.0.0.tgz \
  --tarball-url https://github.com/you/rockysurf-provider-mycloud/releases/download/provider-mycloud-v1.0.0/you-rockysurf-provider-mycloud-1.0.0.tgz \
  --description "MyCloud compute, one API token, four regions."
```

It prints the JSON object to stdout and nothing else, so it pipes. Anything a human is meant to
read goes to stderr. A failure exits 1 with one sentence and no stack trace.

| field | read from |
|---|---|
| `providerId` | `factory.id` — and it is the config section key the operator ends up with |
| `name` | the settings declaration's `title`; `displayName` when nothing is declared |
| `description` | **you**, on the command line |
| `version` | the manifest's `version` |
| `package` | the manifest's `name`, exactly. The operator writes it on their `package:` line |
| `tarball` | **you**, on the command line. https only |
| `sha256` | the digest of the bytes it just read |
| `settings` | the declared fields, in declared order, reduced to name/label/kind |
| `capabilities` | the provider `createProvider()` returns, constructed from the declared fields' own `example` values |

**Ask the user for the description.** It is the one line an operator reads before deciding to
install: which cloud, what it needs, what it does. Neither you nor the artifact can supply it, and
a generated-sounding one is worse than a plain one. Then print the output with those two values
marked as theirs, so they can see what they are signing.

**Never edit the output.** A change to the package makes the whole entry stale — version, digest,
settings summary and capabilities move together — so the maintenance operation is re-running the
command, not patching a field.

### What it refuses, and what to do

| Message | Cause | Fix |
|---|---|---|
| `… declares runtime dependencies (…)` | the manifest's `dependencies` | step 2b — bundle them into `dist/`, rebuild, repack, re-release |
| `--tarball-url` is not https | an `http://` or a bare path | the artifact and the digest meant to catch a change to it would travel over the same rewritable connection. Host it over https |
| `the archive has a member outside "package/"` | not an npm-packed tarball | pack it with `npm pack` or `pnpm pack`, not with `tar` by hand |
| a failure importing the package's entry point | `dist/` missing, or an import of something the tarball does not carry | step 2a and 2b. The generator constructs the provider to read its capabilities, which is the same import the operator's restart will do |

That last row is worth understanding rather than working around: the generator runs
`createProvider()` in this process, because `capabilities` is a property of a constructed provider
and there is no honest way to read it otherwise. It is safe by contract — `createProvider` is
required to be synchronous and side-effect free — and it means a package that cannot be imported
is caught here rather than on somebody's server.
