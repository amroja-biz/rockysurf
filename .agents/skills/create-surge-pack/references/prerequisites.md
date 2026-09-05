# Prerequisites: what has to be on the user's own computer

Read this when one of the checks in the skill's Prerequisites table came back missing, or before
promising a verification you have not established you can run.

## The distinction to keep straight

Two machines are involved and only one of them is your problem here.

- **The user's computer** — where the checkout, the loader test and the Docker daemon live, and
  the only machine this file is about. Nothing installs itself here. If a tool is missing, name it,
  give the user the install page below, and stop at the step that needs it.
- **The Rocky Surf server** — the cloud box a pack builds. The `apt-get install`, `npm install -g`
  and `curl … | bash` lines you will read in `idioms.md` and write into an `installScript` all run
  there, as part of the bootstrap the product exists to do. They say nothing about what the user's
  computer has.

The smoke harness in step 4 blurs the two on purpose: it runs the server's install plan inside a
container on the user's machine. That container is a stock `ubuntu:24.04` image with nothing in it,
which is exactly why the pack has to install everything it uses.

## Git

**Why:** to clone the Rocky Surf repository, and to show, with `git status --porcelain packs/`,
that a derived pack changed no file but its own.

**Check:** `git --version`

**Install:** macOS — Apple's command line developer tools (`xcode-select --install`) include it, or
take the installer from <https://git-scm.com/downloads/mac>. Ubuntu — `sudo apt-get install git`
(<https://git-scm.com/downloads/linux>).

## Node.js 24 or newer

**Why:** the loader test and `scripts/pack-smoke.mjs` are Node programs, and the `rockysurf` binary
checks the version at startup rather than failing later with a syntax error. The repository declares
`engines.node` as `>=24`; `CONTRIBUTING.md` in the checkout is the normative statement of that and
wins if this file ever disagrees.

**Check:** `node --version`

**Install:** <https://nodejs.org/en/download> covers both — an official `.pkg` installer for macOS,
and the package-manager instructions for Ubuntu.

If the machine already manages Node with `nvm`, select the version instead of installing a second
copy: `nvm install 24 && nvm use 24`. That selection does not survive into a new shell, and your
working directory may not either, so put both the selection and the `cd` in the same command as the
thing you are running.

Node 24 also brings `npx`, which `register-a-tool` uses out of a checkout.

## pnpm

**Why:** the repository is a pnpm workspace. `pnpm install && pnpm -r build` is what puts the built
core under the harness, and `pnpm --filter @rockysurf/core exec vitest run src/packs/` is the fast
loop you run after every edit. The version is pinned in the root `package.json` `packageManager`
field.

**Check:** `pnpm --version`

**Install:** Node ships Corepack, so `corepack enable pnpm` is usually the whole of it. If that is
not available on the machine, <https://pnpm.io/installation> lists the current options for macOS and
Ubuntu.

## Docker

**Why:** step 4. The smoke harness starts a real `ubuntu:24.04` container, runs the pack's install
plan through the real bootstrap agent, then discards the resume journal and runs it again. No other
check in this skill can tell you whether a script actually works.

**Check:** `docker version` — read the **Server** block, not just the client. A client with no
server means the daemon is not running.

**Install:** macOS — Docker Desktop,
<https://docs.docker.com/desktop/setup/install/mac-install/>; start it before running the harness.
Ubuntu — Docker Engine, <https://docs.docker.com/engine/install/ubuntu/>, then the post-install
steps at <https://docs.docker.com/engine/install/linux-postinstall/> so the harness runs without
`sudo`.

Running the *other* architecture needs emulation. Docker Desktop ships it; on Linux it comes from
QEMU binfmt handlers (<https://docs.docker.com/build/building/multi-platform/>). Without it the
second leg fails with `exec format error`, which is a missing emulator, not a broken pack — step 4
in the skill says what to do about that.

**Without Docker** you can still interview, write the file and run the loader test. You cannot say
the pack works. Say which architectures ran and which did not, and leave the rest to CI.

## What is not a prerequisite

- **`curl` and `shasum`/`sha256sum`**, used once to compute the `sha256` for a pinned release asset.
  Both ship with macOS and with Ubuntu. If `curl` is missing on a minimal Ubuntu image,
  `sudo apt-get install -y curl`.
- **Anything the pack installs.** A pack that installs Rust does not need Rust on the user's
  computer, and a pack that installs `jq` does not mean you need `jq` to write it.
- **A cloud account.** Nothing in this skill talks to a cloud. The harness is local Docker.

## When one is missing

Name the tool, quote the check that failed, and give the install page. Then stop at the step that
needs it rather than working around it — a substituted, gentler check is worse than an admitted gap,
because it produces a claim nobody can act on. Say what is still provable without the missing tool
and what is left for CI.
