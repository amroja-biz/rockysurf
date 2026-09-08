# Prerequisites — what has to be on the user's own computer

Read this when a check in `SKILL.md` came back missing. **Never install any of these for the
user.** Name what is missing, give them the vendor's page, and stop at the step that needs it —
a skill that installs a package manager on somebody's laptop to get past its own step 1 has
exceeded what anyone asked it to do.

None of this is about the box the pack builds. The `apt-get install` lines inside an
`installScript` run on the Rocky Surf server, which starts empty by design.

| Tool | macOS | Ubuntu |
|---|---|---|
| Git | Xcode command line tools (`xcode-select --install`), or https://git-scm.com/downloads | `apt-get install git` |
| Node.js 24+ | https://nodejs.org/en/download, or `nvm install 24` (https://github.com/nvm-sh/nvm) | https://github.com/nodesource/distributions, or `nvm install 24` |
| Docker | Docker Desktop, https://docs.docker.com/desktop/install/mac-install/ | Docker Engine, https://docs.docker.com/engine/install/ubuntu/ |
| `gh` | `brew install gh`, or https://cli.github.com/ | https://github.com/cli/cli/blob/trunk/docs/install_linux.md |
| `jq` | `brew install jq`, or https://jqlang.github.io/jq/download/ | `apt-get install jq` |

## The two that fail in a way that is not "command not found"

**Docker.** `docker version` printing a client block and then an error is a daemon that is not
running, not a missing install — start Docker Desktop, or `systemctl start docker`. `pack check`
exits **2** in that state, which means *the check could not be run*, and it is not the same thing
as a pack that failed. Do not report it as a pack failure, and do not open the pull request on the
strength of a lint that passed while the check never ran.

The second architecture is worth checking before you promise anything, because what happens on a
non-x86 machine varies — sometimes `linux/amd64` refuses outright, sometimes it runs slowly under
emulation and fails in surprising ways:

```bash
docker run --rm --platform linux/arm64 ubuntu:24.04 uname -m
docker run --rm --platform linux/amd64 ubuntu:24.04 uname -m
```

If one of them will not run here, say so: the pull request can still be opened, and CI runs both
on native runners, but what *you* verified is one architecture and the body must say that rather
than implying two.

**`gh`.** `gh --version` succeeding proves nothing about authentication. The check is:

```bash
gh auth status
```

which must name a logged-in account. Forking a public repository needs no special scope beyond
the default `repo` that `gh auth login` requests — but a token created by hand, or one issued for
a single organisation, can be authenticated and still unable to fork. That failure arrives at
`gh repo fork` with a 403, and the fix is the user's to make: `gh auth login` again, or a token
with `repo`. Do not work around it by pushing a branch to the upstream repository; a contributor
does not have that access and the procedure would be a lie.

## What is *not* needed

- **A checkout of Rocky Surf.** The harness is `npx -y rockysurf@0.1.0` (SKILL.md step 1), and
  npx fetches it on first use. A session already inside a checkout can build that in place and
  use its `packages/rockysurf/dist/bin.js` instead, but nothing requires a clone.
- **A write bit on `amroja-biz/rockysurf-shop`.** The whole procedure runs on a fork.
