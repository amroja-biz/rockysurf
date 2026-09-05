# Prerequisites: what has to be on the user's own computer

Read this when one of the checks in the skill's Prerequisites table came back missing, or when a
command below fails with "command not found".

Nothing here installs itself. If a tool is absent, name it, give the user the install page, and stop
at the step that needs it.

## Node.js 24 or newer, with npm

**Why:** a provider is a Node package. The scaffold declares `engines.node` as `>=24`, Rocky Surf
itself refuses to start on less, and `npm` is how the SDK and the conformance suite reach your
package:

```sh
npm install --save-dev @rockysurf/provider-conformance
```

That is a dependency of the package you are writing, not a program installed onto the machine.
Nothing in this skill asks for a global install.

**Check:** `node --version`, `npm --version`

**Install:** <https://nodejs.org/en/download> covers both — an official `.pkg` installer for macOS,
and the package-manager instructions for Ubuntu. If the machine already manages Node with `nvm`,
select rather than install: `nvm install 24 && nvm use 24`. That selection does not survive into a
new shell.

**`tsc` and `vitest` are not system tools.** They are devDependencies of the package, run through
`npm run build` and `npm test`. A globally installed TypeScript is a different compiler from the one
the package pins, and is how a build starts disagreeing with CI.

## Git and pnpm — for work in a checkout only

**Why:** the in-tree route. `pnpm install && pnpm -r build`, `pnpm run check` before the pull
request, and `pnpm pack` to produce the SDK and conformance tarballs before the first release puts
them on the registry. A personal provider needs none of this.

**Check:** `git --version`, `pnpm --version`

**Install:** Git — macOS: `xcode-select --install`, or <https://git-scm.com/downloads/mac>; Ubuntu:
`sudo apt-get install git` (<https://git-scm.com/downloads/linux>). pnpm — Node ships Corepack, so
`corepack enable pnpm` is usually the whole of it; <https://pnpm.io/installation> has the rest. The
version is pinned in the root `package.json` `packageManager` field.

## A cloud CLI — only on the credential routes that use one

Rocky Surf never shells out to a cloud CLI. It reads each cloud's own credential chain in process,
so every provider has at least one route that needs nothing installed: an environment variable, or a
role attached to the machine it runs on. A CLI appears in the Configure instructions only because it
is the usual way an operator gets a credential onto the machine in the first place.

| CLI | Which instruction needs it | Check | Install |
|---|---|---|---|
| Azure CLI (`az`) | `az login`, and `az group create` for the resource group Rocky Surf will not create | `az version` | <https://learn.microsoft.com/cli/azure/install-azure-cli> (macOS and Ubuntu both covered) |
| Google Cloud CLI (`gcloud`) | `gcloud auth application-default login` | `gcloud version` | <https://cloud.google.com/sdk/docs/install> |
| AWS CLI (`aws`) | not required by anything here — it is only how most people write `~/.aws/credentials`. `AWS_PROFILE` or the environment variables work without it | `aws --version` | <https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html> |

The alternatives, when the user does not want a CLI on the machine: Azure takes
`AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` or a managed identity; GCP takes
`GOOGLE_APPLICATION_CREDENTIALS` or `providers.gcp.keyFile`, which is a path; Hetzner takes
`HETZNER_TOKEN` and has no CLI in the picture at all.

## What is not a prerequisite

- **Docker**, unless the user runs Rocky Surf from the container image. Nothing in authoring a
  provider needs it; the conformance suite is unit tests.
- **`curl`**, beyond the one convenience in `configuring.md` for reading your own public address.
  It ships with macOS and with Ubuntu.
- **A checkout**, for a personal provider. The SDK's README and its `.d.ts` files travel inside the
  installed package and are the authoritative contract.

## When one is missing

Name the tool, quote the check that failed, and give the install page. Then stop at the step that
needs it. Do not approximate the step, and do not claim a conformance result you did not run — the
whole point of the suite is that its output is checkable.
