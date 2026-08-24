# The pack contract, condensed

`docs/writing-a-pack.md` in the Rocky Surf checkout is **normative**. This file is a working
summary for authoring — when the two disagree, the checkout wins, and you should say so to the
user rather than quietly following this page.

If your pack is headless, the `desktop`, `requiresRdp` and `RDP_PASSWORD` parts do not apply to
you; `desktops-and-daemons.md` covers those in full when you need them.

## Contents

- [How a pack runs, and why the rules exist](#how-a-pack-runs-and-why-the-rules-exist)
- [The file format](#the-file-format)
- [The four rules](#the-four-rules)
- [What you may not assume](#what-you-may-not-assume)
- [The environment your scripts get](#the-environment-your-scripts-get)

## How a pack runs, and why the rules exist

The box boots with an inert pre-boot config: the unprivileged user `rocky` and an SSH key, nothing
more. The control plane then connects **over SSH** — outbound-only, the box never calls home —
copies a small bootstrap agent onto it, and runs it against a snapshotted install plan. Per step,
the agent reads its journal at `/var/lib/rockysurf/state.json`, skips anything already `done`,
runs the script as the declared user under a plain `bash -c`, and records the outcome.

Two consequences, which are rules 1 and 4: **a step can run more than once**, because the journal
entry is written when a step *finishes* and an interrupted one runs again from the top; and **a
step runs as exactly the user it declared**, because `runAs` is dispatch rather than
documentation.

## The file format

One pack per file in `packs/`, named after the pack id (`packs/rust-dev.yaml`). Frozen at v0.1 —
a pack written today keeps working. Three top-level keys:

```yaml
version: 1        # required; the literal 1
pack:  { … }      # required; exactly one SurgePack
tools: [ … ]      # required; the Tool records this file introduces
```

Every object is strict: an **unknown key is an error**, not something ignored. A misspelled
`requiresRDP` fails the loader rather than quietly producing a pack that never asks for a
password.

### SurgePack

| Field | Type | Required | Meaning |
|---|---|---|---|
| `packId` | string | yes | Unique across the repository, and must match the filename. Lowercase alphanumeric with single hyphens |
| `name` | string | yes | Display name |
| `tools` | string[] | yes | Tool **ids**, at least one, in any order — `installOrder` decides execution. May name tools defined in this file or in any other pack file |
| `displayOrder` | number | yes | Position in the UI's pack list, ascending |
| `enabled` | boolean | yes | `false` hides it from the UI. CI still smoke-tests it |
| `imageUrl` | string | no | Card image; relative path or absolute URL |
| `theme` | string | no | Named UI theme for the pack's card |
| `guide` | string | no | Post-boot instructions shown to the user as plain text. See `shipping.md` |
| `requiresRepos` | boolean | defaults `false` | The form asks the user for Git repositories. **The install plan clones them for you** — you write no clone code — and `$REPOS` is set so your scripts can do extra work per repository. Not a hard requirement: the user can confirm a repo-less create, so tolerate an empty `$REPOS` |
| `requiresRdp` | boolean | defaults `false` | The user is asked for a remote-desktop password at create time |
| `desktop` | `'xfce'` | no | Install a graphical desktop. Omit for a headless box |
| `webPort` | number (1–65535) | no | Loopback port of a web UI the pack serves; Connect renders the `ssh -L` forward from it. Omit if none |

`requiresRepos`, `requiresRdp`, `desktop` and `webPort` exist so behaviour is described by the pack. If you
find yourself wanting the application to special-case your `packId`, that is a bug in the format
— open an issue instead of working around it.

### Tool

| Field | Type | Required | Meaning |
|---|---|---|---|
| `toolId` | string | yes | **Unique across the whole repository.** Lowercase alphanumeric, single hyphens. This is the identity other packs reference |
| `name` | string | yes | Human-readable name shown in the UI |
| `description` | string | yes | One line, shown next to the name |
| `category` | `'agent'` \| `'base'` | yes | `agent` for the AI coding agents a pack exists to deliver; `base` for supporting software |
| `url` | string | yes | The tool's home page, so a user can see what they are installing |
| `installScript` | string | yes | Shell. Installs the software. Must satisfy all four rules |
| `setupScript` | string | no | Shell. Per-server configuration, run after every tool's `installScript`. Same `runAs`, same four rules |
| `enabled` | boolean | yes | `false` hides the tool from the UI without deleting it |
| `installOrder` | number | yes | Ascending, in the bands below |
| `bootstrap` | boolean | yes | Set `false`. Reserved for tools the runtime guarantees before any plan runs |
| `runAs` | `'root'` \| `'rocky'` | yes | The user the step runs as |

### `installOrder`, and the gaps-of-10 convention

**Any integer from 10 to 60 inclusive is accepted**; the bands are a convention within that range,
not a whitelist.

| Order | For |
|---|---|
| `0` | Runtime-guaranteed base tools. Reserved — a pack tool using it is rejected |
| `10` | System packages from apt with no dependencies of their own |
| `20` | Language runtimes — Node, Python, Go, Rust |
| `30` | Anything that needs a runtime from band 20 |
| `40` | The agents themselves |
| `50` | Anything that needs an agent to already be installed |

Leave gaps of 10 so someone can insert a step later without renumbering the repository. A tool
that belongs between two bands takes the gap, and that is the convention working as intended
rather than a violation of it — the desktop sits at `35`, `dolt` at `36`.

**If B needs A, give B a higher `installOrder`. That is the only way to express a dependency.**
Tools with equal `installOrder` do run in a defined order (`toolId` ascending), but that exists
so a snapshotted plan renders identically every time — an interrupted install that resumes
against a different order would skip the wrong work. It is a determinism guarantee, not a
scheduling tool, and a pack that leans on it is one rename away from breaking.

Higher `installOrder` is still only *ordering*. It does not make the earlier tool present: the
user's pack might not include it. Where the cost is low, install what you need yourself.

## The four rules

CI enforces all four, and the mechanical half of each is checked by the loader test in seconds.

### Rule 1 — Idempotent

Running the script twice must be safe, and the second run must change nothing. Prefer commands
that are already convergent (`apt-get install`, `npm install -g`, `install -m`, `mkdir -p`) over
ones that are not (`>>`, `mv`, `useradd`, `git clone`). Guard everything else. The classic break
is the shell-profile append: run it three times, get three copies of the same `PATH` line, and
fail the harness's byte-identical `.bashrc` check.

### Rule 2 — `$ARCH`-aware

Never hardcode a CPU architecture. The agent exports `ARCH`, normalised to Debian's spelling —
`amd64` or `arm64`, never `x86_64` or `aarch64` — for root and unprivileged steps alike. You need
it whenever you download a binary or tarball by URL; `apt-get install`, `npm install -g` and
`pip install` resolve the right build themselves. Always `case` with an explicit failure on an
unknown value, so a third architecture gives a clear error rather than a silent wrong binary.

### Rule 3 — Non-interactive

Nothing may prompt. The script runs under a systemd unit with no TTY: a prompt reads EOF, and
`apt-get` aborts while `debconf` may hang until the step times out, which looks to the user like
a box that never finishes booting. `tzdata`, `keyboard-configuration` and `xrdp` are all
prompt-happy. `DEBIAN_FRONTEND=noninteractive` is exported for you; set it again anyway when you
invoke a sub-shell or a nested installer. Also avoid anything that *waits* without prompting —
no unbounded polling, no `sleep 60` after a `systemctl start`; use a bounded retry with a real
completion check.

### Rule 4 — `runAs`-honest

Declare the user the step actually needs; never declare `rocky` and then reach for `sudo`. Three
ways it breaks: **`sudo` does not exist** in the CI container (a stock `ubuntu:24.04` ships
without it, and the harness drops privilege with `runuser`); a **root step writing into
`/home/rocky`** leaves root-owned files the user cannot edit (`chown` if you must); and
**`$HOME` differs** — `/root` for root steps, `/home/rocky` for `rocky` steps, so `~/.bashrc`
means two different files.

If one tool genuinely needs both privilege levels, that is two tools, or an `installScript` and a
`setupScript` split. Global `npm install -g` is root's. A per-user CLI that installs into `$HOME`
is `rocky`'s.

## What you may not assume

The most expensive lesson in this project: **"Ubuntu 24.04" is not a contract about installed
packages.** Two clouds both advertising Ubuntu 24.04 shipped materially different images — one
had `jq` preinstalled and the other did not, so a code path fired on exactly one provider and
looked fine everywhere it was tested. If your pack needs it, your pack installs it.

| Don't assume | Why not | What to do |
|---|---|---|
| `jq`, `curl`, `wget`, `unzip`, `git`, `python3` | Not guaranteed by the base image, and absent from a stock `ubuntu:24.04` container | `apt-get install -y` what you use, after refreshing the package list once |
| Fresh apt package lists | A stock container has none, so the first `apt-get install` fails with "Unable to locate package". Nothing refreshes them for you | Use the shared `apt-updated` stamp idiom |
| The AWS CLI, or any cloud SDK | Nothing on the box is cloud-specific by design, and it may not be on AWS at all | Bundle what you need, or don't need it |
| Cloud credentials, instance roles, `s3://` access | The box holds no cloud credentials | Fetch assets over plain HTTPS from a public URL |
| The instance metadata service (`169.254.169.254`) | Zero metadata coupling by design, and user-supplied boxes have no metadata service at all | Read `$ARCH` and the documented environment |
| That the box can reach the control plane | Outbound-only topology: the control plane connects to the box, never the reverse, and it may sit behind NAT | Never phone home. Write to stdout; the agent captures it |
| A desktop, an X server, or a display | Only packs that declare `desktop: xfce` get one | Declare it, or stay headless |
| A login session for `rocky` — `systemctl --user`, `$XDG_RUNTIME_DIR`, a per-user D-Bus | The agent drops privilege without a PAM session, so no user systemd instance exists. True on a real cloud box, not only in a container | From a `runAs: root` step, `loginctl enable-linger rocky` and wait for `/run/user/<uid>/bus`. Guard both halves on `[ -d /run/systemd/system ]` |
| That anything sources `.bashrc`, `/etc/profile` or `/etc/profile.d` | Steps run under a plain `bash -c` — non-login and non-interactive — so none of those files is ever read during a bootstrap | `export PATH=…` at the top of each script that needs it, and put system-wide binaries somewhere already on the default PATH |
| A particular Node, Python, Go or Rust version | Only what you install. Ubuntu's apt package is often well behind the current release | Install and pin what you need |
| That another tool has already run | Ordering comes from `installOrder` and nothing else | Give the dependent tool a higher `installOrder`, and install cheap prerequisites yourself |
| A network mirror, proxy, or registry beyond what your script fetches | The box has ordinary outbound internet and nothing more | Fetch from stable public URLs |
| That a file a package *says* it installs is there | The `ubuntu:24.04` Docker image ships `/etc/dpkg/dpkg.cfg.d/excludes` with `path-exclude=/usr/share/doc/*`, so documentation, examples and shell-completion snippets under `/usr/share/doc` are absent in the smoke container while present on a real cloud image. `dpkg -L` lists them either way | Guard on `[ -f "$path" ]` and degrade, rather than either failing the step or silently doing half the job — and say in the step log which branch you took |
| The unauthenticated GitHub API | `api.github.com` allows 60 requests an hour **per source IP**, and a bootstrapping box holds no token. Several installers begin by asking it which release is latest, and fail confusingly when refused | Fetch release assets from the CDN download URL directly, pinned, rather than through an installer that queries the API |

Two more:

- **Which version you install depends on where it comes from.** A quota-free registry (npm, PyPI
  via `pipx`) serves any version on demand, so install **unversioned** and let the user have the
  current release — a bare name takes the registry's stable channel, not a prerelease. A tool
  that ships only as a GitHub release asset stays **pinned to a tag with a `sha256`**, because
  the only endpoint that answers "what is latest" is the rate-limited one above. Say in a comment
  which rule you are under. Separately, and regardless of version: never pipe a vendor's
  `install.sh` to `bash`, and never cache-bust a download URL (`?$(date +%s)`) — that one is
  rejected outright, and it guarantees a different payload on every run.
- **Secrets come from the environment, and only yours.** Control-plane credentials are never
  exported to install steps. Never write a secret into a world-readable file, and never pass one
  on a command line where `ps` can read it.

## The environment your scripts get

| Variable | Set for | Value |
|---|---|---|
| `ARCH` | every step | `amd64` or `arm64` |
| `DEBIAN_FRONTEND` | every step | `noninteractive` |
| `HOME` | every step | `/root` for root steps, `/home/rocky` for `rocky` steps |
| `REPOS` | every step, when the pack sets `requiresRepos` | Comma-separated clone URLs the user chose — `''` when they confirmed a repo-less create |
| `GITHUB_TOKEN` | every step, **when the operator configured one** | A GitHub token, for private repositories and for `gh` |
| `RDP_PASSWORD` | every step, **when the pack sets `requiresRdp`** | The remote-desktop password for `rocky` |

`GITHUB_TOKEN` and `RDP_PASSWORD` are the only credential names Rocky Surf promises a pack, and
that list is closed on purpose. **Both may be absent** — a key with no secret behind it is
omitted entirely rather than set empty, so guard with `${VAR:-}` before use. An empty value would
be worse than a missing one: `RDP_PASSWORD=` passes a naive check and then sets an empty desktop
password.

You usually do not need `GITHUB_TOKEN` for cloning: repository clones in the resolved plan
already authenticate with it through a per-invocation credential helper that keeps it out of
`argv` and out of the checkout's `.git/config`. Reach for it only when your own script talks to a
forge API.

Standard output and standard error are captured per step, into `/var/lib/rockysurf/steps/<id>.log`.
Log freely — it is the only debugging signal a user gets when something fails on their box.
