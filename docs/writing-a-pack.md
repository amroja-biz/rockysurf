# Writing a pack

A **pack** is a curated bundle of tools that gets installed on a fresh cloud box. It is a
single YAML file. You can read it, diff it, fork it, and send it as a pull request — which is
the whole point: packs are data, not code, and adding one should never mean touching the
application.

This page is the contract. If your pack follows it, it will work on every provider and every
architecture we support, and it will survive a bootstrap that gets interrupted halfway through.
If it doesn't, CI will tell you before a user ever sees it.

The file format is **frozen at v0.1**. A pack written today keeps working.

---

## Contents

- [How a pack runs](#how-a-pack-runs)
- [The four rules](#the-four-rules)
  1. [Idempotent](#rule-1-idempotent)
  2. [`$ARCH`-aware](#rule-2-arch-aware)
  3. [Non-interactive](#rule-3-non-interactive)
  4. [`runAs`-honest](#rule-4-runas-honest)
- [What you may not assume](#what-you-may-not-assume)
- [Which version to install](#which-version-to-install)
- [The file format](#the-file-format)
- [A complete pack](#a-complete-pack)
- [The CI smoke test](#the-ci-smoke-test)
- [Checklist before you open a pull request](#checklist-before-you-open-a-pull-request)
- [Where these rules come from](#where-these-rules-come-from)

---

## How a pack runs

Understanding this takes two minutes and explains all four rules.

When someone creates a server with your pack, the control plane resolves the pack into an
ordered **install plan** and snapshots it. The box boots with a tiny, inert pre-boot config —
it creates the unprivileged user `rocky` and authorizes an SSH key, and that is all. Nothing
from your pack has run yet.

The control plane then connects over SSH, copies a small **bootstrap agent** onto the box, and
launches it. The agent walks your plan in order. For each step it:

1. reads its journal at `/var/lib/rockysurf/state.json` and **skips any step already marked
   done**;
2. runs the step's script as the user the step declared (`root`, or `rocky` via
   `sudo -u rocky -H env …`);
3. records the outcome back into the journal.

That journal is what makes an interrupted install recoverable. If the network drops, the
control plane restarts, or the agent is killed outright, the next attempt re-reads the journal
and picks up where it left off instead of starting over.

Two consequences fall directly out of this design, and they are the reason rules 1 and 4 exist:

- **A step can run more than once.** A journal entry is written when a step *finishes*. A step
  interrupted in the middle is not marked done, so it runs again from the top on the next
  attempt. Your script must be able to survive that.
- **A step runs as exactly the user it declared.** The agent decides privilege from your
  `runAs` field before your script has any say in the matter.

---

## The four rules

Every `installScript` and every `setupScript` in your pack must be idempotent, `$ARCH`-aware,
non-interactive, and `runAs`-honest. CI enforces all four.

### Rule 1: Idempotent

**Running your script twice must be safe, and the second run must change nothing.**

#### Why

The resume path above re-runs any step that didn't finish. This isn't a theoretical concern —
resume after a mid-plan kill is part of the bootstrap test suite, and re-running a completed
install is expected to skip every step with timestamps untouched. A script that appends to a
file, or that fails when its target already exists, turns a recoverable interruption into a
corrupted box. The failure is also nasty to diagnose, because the box looks installed.

The most common real-world break is the shell profile append. Run it three times and the user
gets three copies of the same `PATH` line.

#### Do this

Guard anything that mutates existing state. Prefer commands that are already convergent
(`apt-get install`, `npm install -g`, `install -m`, `mkdir -p`) over ones that aren't
(`>>`, `mv`, `useradd`).

```bash
# Package installs are convergent already — but the package list is not, so refresh it once
# and leave a stamp so a re-run is a genuine no-op.
apt_update_once() {
  local stamp=/var/lib/rockysurf/apt-updated
  [ -f "$stamp" ] && return 0
  apt-get update -qq
  mkdir -p "$(dirname "$stamp")" && touch "$stamp"
}
apt_update_once
apt-get install -y ripgrep

# Appending to a profile is NOT convergent. Guard it.
if ! grep -q '.cargo/bin' "$HOME/.bashrc"; then
  echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> "$HOME/.bashrc"
fi

# Writing a whole file is fine: it converges on the same content every time.
install -D -m 0644 /dev/stdin "$HOME/.config/mytool/config.toml" <<'EOF'
theme = "dark"
EOF
```

#### Not this

```bash
# Duplicates the line on every run. After a resume, PATH contains it twice.
echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> ~/.bashrc

# Fails on the second run: the installer refuses to overwrite an existing install
# unless you tell it to update.
curl -fsSL https://example.com/tool.zip -o /tmp/tool.zip
unzip -q /tmp/tool.zip -d /tmp
/tmp/tool/install            # second run: "found preexisting installation" → exit 1

# Fails on the second run: the directory already exists, the clone aborts.
git clone https://github.com/example/thing ~/thing
```

The fixes are small: pass the installer's `--update` flag, and use
`git clone … || git -C ~/thing pull --ff-only`.

---

### Rule 2: `$ARCH`-aware

**Never hardcode a CPU architecture. Read `$ARCH` and branch.**

#### Why

We run on both `amd64` and `arm64`, and which one a user gets depends on the provider and the
size they picked. This is not an edge case: our own reference install produced an identical
result on both architectures from one plan, with exactly one arch-aware line in it. The whole
portability story rests on pack authors writing that one line.

The agent exports `ARCH` for you, normalized to Debian's spelling — `amd64` or `arm64`, never
`x86_64` or `aarch64` — so you don't have to care whether it came from `dpkg
--print-architecture` or `uname -m`. It is set for root steps and for unprivileged steps alike.

Most of the time you need nothing: `apt-get install`, `npm install -g` and `pip install` all
resolve the right build themselves. You need `$ARCH` when you download a binary or a tarball
by URL.

#### Do this

```bash
case "$ARCH" in
  amd64) NODE_ARCH=x64 ;;
  arm64) NODE_ARCH=arm64 ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

curl -fsSL "https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-${NODE_ARCH}.tar.xz" \
  -o /tmp/node.tar.xz
```

Note the explicit failure on an unknown value. If a third architecture ever appears, you want a
clear error, not a silent download of the wrong binary.

#### Not this

```bash
# Works on amd64. On arm64 it downloads an x86 binary that cannot execute,
# and the failure surfaces much later as "cannot execute binary file".
curl -s https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscliv2.zip
unzip -qo /tmp/awscliv2.zip -d /tmp
/tmp/aws/install
```

```bash
# Also wrong, for the same reason, and harder to spot:
GOARCH=amd64 go build ./...
docker pull --platform linux/amd64 someimage
```

---

### Rule 3: Non-interactive

**Nothing may prompt. There is no terminal and nobody is watching.**

#### Why

Your script runs under a systemd unit with no TTY attached. A prompt does not pause for input —
it reads EOF, and what happens next is unpredictable. `apt-get` will abort; `debconf` may hang
until the step's timeout expires, which looks to the user like a box that never finishes
booting. Packages such as `tzdata`, `keyboard-configuration` and `xrdp` are prompt-happy and
will do this to you.

The agent already exports `DEBIAN_FRONTEND=noninteractive` for both root and unprivileged
steps, so you inherit it. Set it explicitly anyway if you invoke a sub-shell or a nested
installer that might reset the environment — it costs one line and it documents the intent.

#### Do this

```bash
export DEBIAN_FRONTEND=noninteractive
apt-get install -y xfce4 xrdp

# Keep an existing config file rather than asking which one to keep.
apt-get install -y -o Dpkg::Options::="--force-confold" some-package

npx --yes playwright install-deps chromium
ssh-keygen -t ed25519 -N '' -f "$HOME/.ssh/id_ed25519" -q   # -N '' = no passphrase prompt
```

#### Not this

```bash
apt-get install nodejs                 # no -y: prompts, reads EOF, aborts
npx playwright install-deps chromium   # prompts to install the package first
read -p "Which version? " version      # there is no one there to answer
ssh-keygen -t ed25519                  # prompts for a path and a passphrase
```

Also avoid anything that *waits* without prompting: no `systemctl start … && sleep 60`, no
polling loops without a bounded retry count. Give long installs a real completion check
instead.

---

### Rule 4: `runAs`-honest

**Declare the user your step actually needs. Don't declare `rocky` and then reach for `sudo`.**

#### Why

`runAs` is not documentation, it is dispatch. The agent reads it and runs your script as
`root`, or as `rocky` through `sudo -u rocky -H env …`. Getting it wrong breaks in three
different ways:

- **`sudo` may not exist.** The CI smoke-test container is a stock `ubuntu:24.04` image, which
  ships without `sudo`. A `rocky` step that shells out to `sudo` fails there immediately, even
  though it happens to work on a cloud image.
- **A root step that writes into `/home/rocky` leaves root-owned files** in the user's home,
  and the user then can't edit their own config. If you must do this, `chown` afterwards.
- **The environment differs.** Unprivileged steps run with `-H`, so `$HOME` is `/home/rocky`.
  A root step's `$HOME` is `/root`, and `~/.bashrc` means something different.

If a single tool genuinely needs both — install system packages as root, then configure them
for the user — that is two steps: an `installScript` running as `root` and a `setupScript`
running as `rocky`. That split is exactly what `setupScript` is for.

#### Do this

```yaml
# Two tools, because the work genuinely needs two privilege levels.
- toolId: docker-engine
  runAs: root                    # apt needs root, and says so
  installScript: |
    export DEBIAN_FRONTEND=noninteractive
    apt-get install -y docker.io

- toolId: docker-for-rocky
  runAs: root                    # adding a user to a group is also root's job
  installOrder: 40               # after docker-engine, which sits at 30
  installScript: |
    usermod -aG docker rocky     # convergent: re-running changes nothing
```

```yaml
- toolId: claude-code
  runAs: rocky                   # a per-user install, in the user's own home
  installScript: |
    curl -fsSL https://claude.ai/install.sh | bash
    if ! grep -q '.claude/bin' "$HOME/.bashrc"; then
      echo 'export PATH="$HOME/.claude/bin:$PATH"' >> "$HOME/.bashrc"
    fi
```

#### Not this

```yaml
- toolId: gas-town
  runAs: rocky
  installScript: |
    sudo apt-get install -y golang-go     # declared rocky, needs root
    go install github.com/example/gt@latest
```

```yaml
- toolId: open-claw
  runAs: rocky
  installScript: |
    sudo npm install -g openclaw@latest   # global npm install is a root operation
```

Both should declare `runAs: root` for the privileged half and move the user-level half into a
`setupScript`, or split into two tools.

---

## What you may not assume

The single most expensive lesson from building this: **"Ubuntu 24.04" is not a contract about
installed packages.** Two clouds both advertising Ubuntu 24.04 shipped materially different
images — one had `jq` preinstalled and the other did not, so a code path that depended on it
fired on exactly one provider and looked fine everywhere we tested.

So: if your pack needs it, your pack installs it. Specifically, do not assume any of the
following exist or are reachable.

| Don't assume | Why not | What to do |
|---|---|---|
| `jq`, `curl`, `wget`, `unzip`, `git`, `python3` | Not guaranteed by the base image, and absent from a stock `ubuntu:24.04` container | `apt-get install -y` what you use, after refreshing the package list once |
| Fresh apt package lists | A stock container has none, so the first `apt-get install` fails with "Unable to locate package". Nothing refreshes them on your behalf: the runtime is only required to bootstrap its own JSON parser, not to update your package lists | Call an `apt_update_once` helper like the one above |
| The AWS CLI, or any cloud SDK | Nothing on the box is cloud-specific by design, and the box may not be on AWS at all | Bundle what you need, or don't need it |
| Cloud credentials, instance roles, or `s3://` access | The box holds no cloud credentials. A pack that reaches for one is broken on every other provider | Fetch assets over plain HTTPS from a public URL |
| The instance metadata service (`169.254.169.254`) | The bootstrap design has zero metadata coupling, and user-supplied boxes have no metadata service at all | Read `$ARCH` and the documented environment instead |
| A GitHub API call to resolve "latest" | `api.github.com` allows 60 unauthenticated requests an hour **per source IP**, and a bootstrapping box never has a token. A shared CI runner or anything behind NAT is spending somebody else's quota too, and the 403 usually surfaces as an unrelated-looking failure in whichever tool is last in `installOrder` | Pin a version and fetch `https://github.com/OWNER/REPO/releases/download/TAG/ASSET`, which is CDN-served, has no quota, and lets you verify a `sha256`. This stays true for GitHub-released tools even though agents on a registry channel now install unversioned — see [Which version to install](#which-version-to-install) |
| That the box can reach the control plane | The default topology is outbound-only: the control plane connects to the box, never the reverse, and it may sit behind NAT with no public address | Never phone home. Write to stdout; the agent captures it |
| A desktop, an X server, or a display | Only packs that declare `desktop: xfce` get one | Declare it, or stay headless |
| A login session for `rocky` — `systemctl --user`, `$XDG_RUNTIME_DIR`, a per-user D-Bus | The agent drops privilege without a PAM session, so no user systemd instance exists to install a user unit into. This is true on a real cloud box, not only in a container | From a `runAs: root` step, `loginctl enable-linger rocky` and wait for `/run/user/<uid>/bus`; the `rocky` step can then use `systemctl --user`. Guard both on `[ -d /run/systemd/system ]` |
| A particular Node, Python, Go or Rust version | Only what you install | Install and pin what you need |
| That another tool has already run | Ordering comes from `installOrder` and nothing else; equal values fall back to `toolId` order, which is a determinism guarantee and not a dependency mechanism | Give the dependent tool a higher `installOrder` |
| A network mirror, proxy, or registry beyond what your own script fetches | The box has ordinary outbound internet and nothing more | Fetch from stable public URLs |

Two more, worth calling out separately:

- **How you fetch is not the same question as which version you fetch.** Never resolve a
  version through a rate-limited API, never pipe an unpinned `main`-branch script to `bash`,
  and never cache-bust a download URL with `?$(date +%s)` — that last one guarantees a
  different payload on every run, which is the opposite of what rule 1 asks for. Which
  *version* to ask for is a separate decision with its own section below.
- **Secrets come from the environment, and only yours.** If a user supplies an API key for your
  tool, it arrives as an environment variable in your step. Control-plane credentials are never
  exported to install steps. Don't go looking for them, and never write a secret into a
  world-readable file or pass one on a command line where `ps` can read it.

### The environment your script gets

| Variable | Set for | Value |
|---|---|---|
| `ARCH` | every step | `amd64` or `arm64` |
| `DEBIAN_FRONTEND` | every step | `noninteractive` |
| `HOME` | every step | `/root` for root steps, `/home/rocky` for `rocky` steps |
| `REPOS` | `setupScript`, when the pack sets `requiresRepos: true` | comma-separated list of the repositories the user chose |
| your tool's secrets | steps of the tool they belong to | whatever the user supplied |

Standard output and standard error are captured per step. Log freely; it is the only debugging
signal a user gets when something fails on their box.

---

## Which version to install

This page used to say "pin what you download", flatly, for everything. It no longer does, and
the reason is worth stating rather than quietly editing away: pinning an **agent** bought a
reproducibility it could not actually keep, and charged the user staleness for it.

A pack exists to hand somebody a working coding agent. These tools ship constantly, users
expect the one they read about this morning, and most of them update themselves the first time
they run — so a pinned version is not really the version the box ends up on, it is only the
version the box *starts* on, and the pin's whole promise evaporates the moment the tool
updates itself. What the pin reliably did deliver was a box that arrives out of date, and a
pack file that needs a pull request every time upstream ships.

So the rule now depends on **where the tool comes from**, not on what it is.

### 1. A quota-free registry channel: install latest, unversioned

npm, PyPI (via `pipx`), and anything else that serves any version on demand with no
per-IP request budget. Ask for the package and nothing else:

```bash
npm install -g --no-fund --no-audit @openai/codex
pipx install aider-chat
```

A bare name resolves the registry's release channel — npm's `latest` dist-tag, PyPI's newest
non-prerelease. That is deliberate and it is the behaviour to rely on: a package whose newest
upload is a prerelease (npm `alpha`, `beta`, `next`) is **not** what a bare install returns, so
"latest" here means latest *stable*, not latest *uploaded*.

**The accepted risk, stated plainly:** a broken upstream release breaks provisioning of NEW
boxes until upstream fixes it. Existing boxes are untouched — nothing re-runs an install
script on a server that already booted. This was weighed and accepted: the failure is loud,
it is upstream's to fix, and it is rarer than the guaranteed staleness a pin produced.

### 2. GitHub release assets only: the pin and the digest stay

`beads`, `agent-deck`, `beads-viewer` and `dolt` are pinned to a tag and verified against a
`sha256`, and **they must stay that way.** This is not an oversight for somebody to tidy up
later, so read this paragraph before you "fix" one of them.

There is no quota-free way to ask GitHub what "latest" is. The only endpoint that answers is
`api.github.com`, which allows 60 unauthenticated requests an hour **per source IP** — and a
bootstrapping box never has a token, so every one of those calls is unauthenticated by
construction. Resolving "latest" there is exactly the outage in `rockysurf-c6cm` and
`rockysurf-pcma`: a shared CI runner drew an address whose quota another tenant had already
spent, the call returned 403, upstream's installer did not fail on it but fell through to a
source build, found no toolchain, and exited 1 — with the asset it wanted sitting on a CDN
that has no quota at all.

The download endpoint, `https://github.com/OWNER/REPO/releases/download/TAG/ASSET`, is that
CDN. It has no quota, and it lets you check a digest. But it needs a TAG, and a tag is a pin.
So for these tools the pin is not a freshness policy, it is the price of not touching the
rate-limited API — and bypassing the vendor's installer means you own the version bump, which
is the trade being made.

### 3. No registry channel at all: pin and verify, for case 2's reason

A few agents ship through neither. Cursor's CLI is the one in tree: no npm package, no apt
line in its own signed repository (which carries the desktop IDE and nothing else), a Homebrew
cask that is `depends_on :macos`, and no repository to cut releases from. What it has is a
vendor CDN, `downloads.cursor.com`, serving a versioned tarball — and `/latest/` and
`/stable/` on it both return 403, so the only way to learn the current version is to read it
out of the installer the vendor would rather you piped into a shell.

Every clause of case 2 transfers: the endpoint is a CDN, it has no quota, and it lets you
check a digest — but it needs a version in the path, and a version in a path is a pin. So
`cursor-cli` is pinned with both `sha256` digests in the script for the same reason `beads`
is, and it is not the "latest scares me" pin this section rejects: case 1 is not available to
it, because there is no registry to ask. As with case 2, bypassing the installer means you own
the bump, so write where the next version comes from into the script.

### 4. Agent tools ride latest; base plumbing may stay pinned

The ruling above is about the **agent** — the thing in `category: agent` that the pack exists
to deliver. Base plumbing is a different risk: Node, the Go toolchain, `gh`, Playwright and
the desktop are the substrate every pack stands on, and a bad one breaks all of them at once
rather than breaking one pack for the people who chose it. Those keep their current treatment
— `nodejs` pins the major and tracks the patch, `gh` tracks apt's stable — and a pack author
changing that should say why in the script.

### When an agent may still be pinned

One case, and it is not a freshness judgement: **upstream's latest is known broken for what
this pack promises.** `gt` in `packs/gas-town.yaml` is pinned at `v1.1.0` because `v1.2.1`
cannot initialise the Beads-backed HQ that pack exists to deliver on a fresh box. A pin like
that needs the reason written into the script, and an issue tracking its removal
(`rockysurf-4zmx`). "Latest scares me" is not that reason.

### Idempotency without a version in the stamp

A pinned tool could put its version in a stamp file — `installed-aider-0.86.2` — so that
bumping the pin reinstalled and leaving it alone was a no-op. Unversioned installs cannot do
that, and rule 1 still applies: the run-twice gate discards the journal and requires the
second run to change nothing.

Two shapes that work:

```bash
# Presence guard. The second run finds the binary and does nothing.
command -v amp >/dev/null 2>&1 || npm install -g --no-fund --no-audit @sourcegraph/amp

# Or lean on an installer that is convergent by itself. `npm install -g` re-resolves the
# registry, sees the version it already installed, and exits without rewriting anything —
# which is a no-op in effect, though not a free one.
npm install -g --no-fund --no-audit @openai/codex
```

A presence guard has a consequence worth knowing: it pins the box to whatever was current on
the day it booted, because nothing reinstalls afterwards. That is the right default anyway —
**updating a live box belongs to the tool's own updater, not to us.** A pack's install script
runs once, at boot, and never again; a user who wants a newer agent three weeks later runs
`grok update` or `npm update -g`, not a re-bootstrap. Say so in your `guide`.

---

## The file format

One pack per file, in `packs/`, named after the pack id: `packs/rust-dev.yaml`.

A file has three top-level keys:

```yaml
version: 1        # required; the frozen v0.1 format
pack:  { … }      # required; exactly one SurgePack
tools: [ … ]      # required; the Tool records this file introduces
```

`pack.tools` is a list of tool **ids**. It may name tools defined in this file or tools defined
in any other pack file in the repository — that is how several packs share one `claude-code`
definition. Defining the same `toolId` in two files is an error and CI will reject it.

### Tool

| Field | Type | Required | Meaning |
|---|---|---|---|
| `toolId` | string | yes | Unique across the whole repository. Lowercase, hyphens, no spaces. This is the identity other packs reference |
| `name` | string | yes | Human-readable name shown in the UI |
| `description` | string | yes | One line. Shown next to the name |
| `category` | `'agent'` \| `'base'` | yes | `agent` for the AI coding agents a pack exists to deliver; `base` for supporting software |
| `url` | string | yes | The tool's home page, so a user can see what they're installing |
| `installScript` | string | yes | Shell. Installs the software. Must satisfy all four rules |
| `setupScript` | string | no | Shell. Per-server configuration, run after the software is installed. Same `runAs`, same four rules |
| `enabled` | boolean | yes | `false` hides the tool from the UI without deleting it. CI smoke-tests it either way |
| `installOrder` | number | yes | Ascending. See the convention below |
| `bootstrap` | boolean | yes | Set `false`. Reserved for the handful of tools the runtime guarantees before any plan runs |
| `runAs` | `'root'` \| `'rocky'` | yes | The user the step runs as. See rule 4 |

#### `installOrder`, and the gaps-of-10 convention

Steps run in ascending `installOrder`. **Leave gaps of 10** so someone can insert a step later
without renumbering every pack in the repository. The bands in use:

| Order | For |
|---|---|
| `0` | Runtime-guaranteed base tools. Not for community packs |
| `10` | System packages from apt with no dependencies of their own |
| `20` | Language runtimes — Node, Python, Go, Rust |
| `30` | Anything that needs a runtime from band 20 |
| `40` | The agents themselves |
| `50` | Anything that needs an agent to already be installed |

A tool that has to land between two bands takes the gap: the desktop environment sits at `35`,
after the runtime-dependent tools and before the agents. That is the convention working as
intended.

**If B needs A, give B a higher `installOrder`.** That is the only way to express a dependency.
Never rely on the order tools happen to appear in the file, and don't reach for the tie-break
rule below either.

Tools with the same `installOrder` do execute in a defined order — `toolId` ascending — but that
exists for the executor's benefit, not yours: a snapshotted plan has to render identically every
time, or an interrupted install resumes against a different order and skips the wrong work. It
is a determinism guarantee, not a scheduling tool, and a pack that leans on it is one rename
away from breaking. See [the bootstrap contract](bootstrap-contract.md#step-ordering).

### SurgePack

| Field | Type | Required | Meaning |
|---|---|---|---|
| `packId` | string | yes | Unique across the repository. Matches the filename |
| `name` | string | yes | Display name |
| `tools` | string[] | yes | Tool ids, in any order — `installOrder` decides execution |
| `displayOrder` | number | yes | Position in the UI's pack list, ascending |
| `enabled` | boolean | yes | `false` hides it from the UI. CI still smoke-tests it |
| `imageUrl` | string | no | Card image. Relative path or absolute URL |
| `theme` | string | no | A named UI theme for the pack's card |
| `guide` | string | no | Post-boot instructions, shown to the user once the server is running. See below |
| `requiresRepos` | boolean | yes (defaults to `false` if omitted) | The user must choose at least one Git repository before creating the server, and `$REPOS` is set for setup scripts |
| `requiresRdp` | boolean | yes (defaults to `false` if omitted) | The user is asked for a remote-desktop password at create time |
| `desktop` | `'xfce'` | no | Install a graphical desktop. Omit for a headless box |
| `webPort` | number (1–65535) | no | The loopback port of a web UI your pack serves on the box. The server page's Connect section renders the `ssh -L` forward and the `http://localhost:<port>` link from it. Omit if the pack has no web UI |

`requiresRepos`, `requiresRdp`, `desktop` and `webPort` exist so that pack behaviour is
described by the pack. If you find yourself wanting the application to special-case your
`packId`, that is a bug in this format — please open an issue instead of working around it.

Declare `webPort` whenever your pack's main interface is a web UI that binds loopback only
(the right posture for an unauthenticated agent UI — do not bind `0.0.0.0` instead). Without
it, the one command that changes how the user connects exists only inside your guide's prose,
and a user who has already run the plain ssh command from Connect has no reason to reread it.
The guide should still open with the forward, since it is also where you say how to start the
UI; `packs/deepseek-harness.yaml` is the worked example.

#### `guide` — what the user has to do themselves

Your pack installs software. It does not, and must not, authenticate it: no credential of the
user's reaches the box during bootstrap, so a freshly-built server is a pile of CLIs that all
want a login. `guide` is where you tell them how.

It is displayed on the server's page as soon as the server is running, **as plain text** — the
app does not parse markdown and does not render HTML, so write it the way you would write a
README in a terminal: short imperative lines, literal commands, and its own line breaks as the
only structure. Every one of the shipped packs has one; copy the shape from
`packs/ai-coding-agents.yaml`.

```yaml
  guide: |
    Claude Code
      claude                  first run walks you through signing in
      claude setup-token      mints a long-lived token instead

    GitHub
      gh auth login           then: gh auth setup-git
```

Two rules, both about honesty:

- **Say what the box actually has.** If your setup script left something half-done — a daemon
  it could not install, a wizard that only works from a desktop session — the guide is where
  the user finds out, not a support thread.
- **`$GITHUB_TOKEN` is not in the user's shell.** It is delivered to bootstrap steps through
  `secrets.env` and nothing exports it into an interactive session, so a guide that says "you
  already have a token" is wrong. Clones performed during setup did use it; `gh` will not.

Leading and trailing whitespace is trimmed. The field is optional, and a pack without one
simply shows nothing.

---

## A complete pack

`packs/rust-dev.yaml` — a headless Rust environment with Claude Code, requiring a repository.

```yaml
version: 1

pack:
  packId: rust-dev
  name: Rust + Claude Code
  tools:
    - build-tools
    - rustup
    - claude-code
  displayOrder: 20
  enabled: true
  imageUrl: /images/surge-packs/rust-dev.png
  theme: theme-orange
  requiresRepos: true
  requiresRdp: false
  guide: |
    Claude Code
      claude                  first run walks you through signing in
      claude setup-token      mints a long-lived token instead

    GitHub
      gh auth login           then: gh auth setup-git
      Your shell has no $GITHUB_TOKEN, even though the clone during setup used one.

    Rust
      cargo build             the crates in your lockfile are already fetched

tools:
  - toolId: build-tools
    name: Build tools
    description: C toolchain and pkg-config, needed to compile most Rust crates
    category: base
    url: https://packages.ubuntu.com/noble/build-essential
    installOrder: 10
    runAs: root
    bootstrap: false
    enabled: true
    installScript: |
      set -euo pipefail
      export DEBIAN_FRONTEND=noninteractive

      stamp=/var/lib/rockysurf/apt-updated
      if [ ! -f "$stamp" ]; then
        apt-get update -qq
        mkdir -p "$(dirname "$stamp")" && touch "$stamp"
      fi

      apt-get install -y build-essential pkg-config libssl-dev curl

  - toolId: rustup
    name: Rust
    description: The Rust toolchain, installed per-user via rustup
    category: base
    url: https://rustup.rs
    installOrder: 20
    runAs: rocky
    bootstrap: false
    enabled: true
    installScript: |
      set -euo pipefail

      # rustup ships one installer for both architectures, but pin the host triple
      # explicitly so a wrong-arch toolchain can never be selected silently.
      case "$ARCH" in
        amd64) TRIPLE=x86_64-unknown-linux-gnu ;;
        arm64) TRIPLE=aarch64-unknown-linux-gnu ;;
        *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
      esac

      if ! command -v rustup >/dev/null 2>&1; then
        curl -fsSL https://sh.rustup.rs \
          | sh -s -- -y --no-modify-path --default-host "$TRIPLE" --default-toolchain 1.85.0
      fi

      if ! grep -q '.cargo/bin' "$HOME/.bashrc"; then
        echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> "$HOME/.bashrc"
      fi

      "$HOME/.cargo/bin/rustc" --version
    setupScript: |
      set -euo pipefail
      export PATH="$HOME/.cargo/bin:$PATH"

      # Warm the build cache for each repository the user selected. Safe to repeat:
      # cargo fetch is a no-op once the lockfile's crates are present.
      for repo in $(echo "${REPOS:-}" | tr ',' ' '); do
        [ -n "$repo" ] || continue
        dir="$HOME/$(basename "$repo" .git)"
        [ -f "$dir/Cargo.toml" ] || continue
        (cd "$dir" && cargo fetch)
      done

  - toolId: claude-code
    name: Claude Code
    description: Anthropic's AI coding assistant CLI
    category: agent
    url: https://claude.com/claude-code
    installOrder: 40
    runAs: rocky
    bootstrap: false
    enabled: true
    installScript: |
      set -euo pipefail

      curl -fsSL https://claude.ai/install.sh | bash

      if ! grep -q '.claude/bin' "$HOME/.bashrc"; then
        echo 'export PATH="$HOME/.claude/bin:$PATH"' >> "$HOME/.bashrc"
      fi

      "$HOME/.claude/bin/claude" --version
```

Three things in there are worth copying into your own pack:

- **Every script ends by verifying itself.** `rustc --version` and `claude --version` are how
  you find out that an installer exited `0` after only half-working. This has bitten us.
- **`set -euo pipefail` at the top of each script.** The agent isolates and records a failed
  step, but only if the step actually reports failure.
- **Each script's idempotency is visible in one glance** — a `command -v` guard, a `grep -q`
  guard, and a stamp file. A reviewer should not have to guess.

---

## The CI smoke test

**Normative.** Every pack in the repository is smoke-tested on every pull request, and the test
gates merge. It is deliberately harsher than a real cloud image, because a pack that only works
on one provider's idea of Ubuntu is exactly the failure this project is trying to avoid.

For each pack file, for each of **`amd64` and `arm64`**, CI:

1. starts one **stock `ubuntu:24.04` container** for that architecture — no preinstalled
   convenience packages, empty apt lists, and no `sudo`;
2. creates the unprivileged `rocky` user, and nothing else. The harness drops privilege with
   `runuser`, not `sudo`, so `sudo` really is absent from your script's world;
3. resolves the pack into a plan and runs every `installScript`, then every `setupScript`, in
   `installOrder`;
4. **discards the resume journal** and runs the whole thing a **second time in the same
   container**.

Step 4 is the point of the exercise. Clearing the journal is what forces your scripts to
execute again — if CI simply re-ran the agent, it would skip every completed step and prove
nothing.

### What the second run must satisfy

- Every script exits `0`, both runs.
- Every verification command still passes after the second run.
- Files that scripts append to are **byte-identical before and after** the second run. CI
  snapshots `/home/rocky/.bashrc`, `/root/.bashrc` and `/etc/apt/sources.list.d/` and requires
  them unchanged. This is the check that catches the duplicated-`PATH`-line bug.
- No step takes materially longer on the second run than a no-op should. A second run that
  re-downloads and re-compiles everything is a warning sign even when it exits `0`.

A pack that fails on one architecture and passes on the other fails the whole check. There is
no "amd64 only" pack.

### The two checks, and which one to reach for

There is a fast static check and a slow behavioural one. Run the first constantly and the second
before you open the pull request.

```bash
rockysurf pack lint  packs/                    # a second, no Docker
rockysurf pack check packs/ --pack my-pack --arch arm64   # a few minutes, needs Docker
```

**`pack lint`** validates the frozen schema, checks that every `toolId` resolves and that none is
defined twice, and applies the mechanical half of the four rules — a hardcoded architecture with
no `$ARCH` branch, an `apt-get install` without `-y`, `sudo` in a `runAs: rocky` script, an
unguarded `>>`, and the "what you may not assume" list. It is the same code that validates this
repository's own `packs/`, so a finding here is a finding a maintainer would have raised.

**`pack check`** is the smoke harness described above: same container, same two runs, same
journal discard, same three files compared byte for byte. Add `--keep` to leave the container up
when something fails.

**Neither is a security check.** An `installScript` is arbitrary shell that runs as root on
somebody's box, and no amount of pattern matching over it can decide whether it is benign.
What these two prove is that a pack is *well-formed and survives a resume*.

What protects the person installing it is review, the label their own configuration puts on the
registry it came from, and — the one that does the real work — the fact that the control plane
shows them **every script, verbatim**, along with which steps run as root and every URL those
scripts fetch, before they consent. Write your scripts as though someone will read them line by
line, because the interface is built so that they can.

### Publishing to the shop

Most packs belong in [`amroja-biz/rockysurf-shop`](https://github.com/amroja-biz/rockysurf-shop),
not in this repository. It is the community registry: a pack merged there is installable from any
Rocky Surf control plane's shop page, without waiting on a release here. `packs/` in this
repository is Rocky Surf's *own* packs — the ones that ship inside the release, which is what
"official" means and why a contribution cannot become one ([ADR-0006](adr/0006-pack-registry-split-horizon.md)).

**Your pack defines whatever it installs.** There is no list of approved software: a tool is an id
you choose, a description, and a shell script you wrote. Nothing has to be added to Rocky Surf
first and no maintainer has to have heard of it. A pack introducing software this project knows
nothing about is the *normal* case, and it is the reason the registry exists at all —
`packages/core/src/packs/lint.test.ts` pins the worked example, a pack declaring a tool nothing
has ever seen and linting clean with no core involvement anywhere.

The one category to **reference rather than redeclare** is the shared plumbing — `curl`, `git`,
`gh`, `nodejs`, `tmux`, `build-essential` — which every box installs anyway and which lives here
rather than in the shop. Listing their ids reuses one definition; copying their scripts into your
file creates a second, and a duplicate `toolId` is refused. That refusal is about review rather
than permission: a maintainer reading your pull request should never have to work out whether
your `curl` is the real one. Need one of them to behave differently? Give it your own id.

If your pack borrows any of those shared ids, point the checks at a checkout of this repository so
they resolve. A pack that defines everything it installs needs no such flag:

```bash
git clone --depth 1 https://github.com/amroja-biz/rockysurf /tmp/rockysurf

rockysurf pack lint  packs --base-packs /tmp/rockysurf/packs
rockysurf pack check packs --base-packs /tmp/rockysurf/packs --pack my-pack --arch arm64
```

From a checkout of this repository, `node scripts/pack-smoke.mjs` is the same harness pointed at
`packs/`, and it is what CI runs. It needs a built workspace (`pnpm -r build`), because it
resolves your pack with core's own resolver rather than a re-implementation of it.

Exit codes are worth knowing if you are scripting either one: **0** is clean, **1** means the
pack failed the check, and **2** means the check could not be run at all — a missing Docker
daemon, a directory with no pack files in it, a `--pack` id that matches nothing.

For a single script, mid-edit, you don't need any of that. This finds nearly everything in about
a minute:

```bash
# arm64 on an Apple Silicon machine; use --platform linux/amd64 for the other half.
docker run --rm -it --platform linux/arm64 -v "$PWD:/work" ubuntu:24.04 bash

# inside the container:
useradd -m -s /bin/bash rocky
export ARCH=arm64 DEBIAN_FRONTEND=noninteractive HOME=/root

bash /work/my-install-script.sh   # run 1
bash /work/my-install-script.sh   # run 2 — must be quiet, quick, and exit 0
```

For a `runAs: rocky` script, run it as that user, without `sudo` available:

```bash
su - rocky -c 'ARCH=arm64 DEBIAN_FRONTEND=noninteractive bash /work/my-install-script.sh'
```

If that command needs `sudo`, your `runAs` is wrong. See rule 4.

---

## Checklist before you open a pull request

- [ ] One pack per file in `packs/`, filename matches `packId`, `version: 1` at the top.
- [ ] Every `toolId` is unique across the repository.
- [ ] Every script runs cleanly **twice in a row** in a stock `ubuntu:24.04` container.
- [ ] Every script runs cleanly on **both** `amd64` and `arm64`.
- [ ] No hardcoded `x86_64`, `amd64`, `aarch64` or `arm64` in a download URL — branch on `$ARCH`.
- [ ] No prompts. Every `apt-get install` has `-y`; every `npx` has `--yes`.
- [ ] No `sudo` anywhere in a `runAs: rocky` script.
- [ ] No root-owned files left in `/home/rocky`.
- [ ] Nothing assumes `jq`, `curl`, the AWS CLI, cloud credentials, or metadata.
- [ ] The agent installs **unversioned** from its registry channel — or, if it has no registry
      channel, is pinned to a version and verified against a `sha256`, the same treatment
      anything fetched from GitHub releases or a vendor CDN gets. Nothing resolves a version
      through `api.github.com`. See [Which version to install](#which-version-to-install).
- [ ] Each script ends with a command that verifies the install actually worked.
- [ ] `installOrder` uses the bands above and leaves gaps of 10.
- [ ] `requiresRepos`, `requiresRdp`, `desktop` and `webPort` describe what your pack actually needs.
- [ ] `guide` tells the user how to authenticate everything the pack installs, and admits
      anything the install could not finish.

---

## Where these rules come from

Every rule here is the result of something that broke, or nearly broke, on real infrastructure
during the project's de-risking work. If you want the evidence:

- `docs/spike/findings.md` — the full findings memo. The bootstrap and base-image sections are
  the ones that produced rules 1–3, including the two clouds whose "Ubuntu 24.04" images
  differed, and the one identical install plan that produced a working setup on both
  architectures with a single arch-aware line.
- `docs/adr/0002-push-bootstrap-default-callback-fallback.md` — the bootstrap design, the
  outbound-only topology, and the resume semantics that make idempotency mandatory rather than
  polite.
- `docs/adr/0004-packs-as-pr-able-yaml.md` — why packs are files, why the format is frozen at
  v0.1, and why CI runs every pack twice on two architectures.

Found something this page gets wrong, or a rule that fights a legitimate pack? Open an issue.
The format is frozen; the documentation isn't.

<!-- APPENDED by rockysurf-55fx.14 (spike-hetzner). This is spike-scaffold's document; the
     section below is an append rather than an edit, so nothing above it moved. If it belongs
     somewhere earlier in the flow, move it in the morning — the content is the decision, the
     placement is not. -->

## The environment your scripts get

Every `installScript` and `setupScript` runs with these variables set. Read them; do not
hardcode what they carry.

| variable | set for | what it is |
|---|---|---|
| `$ARCH` | every step | `amd64` or `arm64`. See [Rule 2](#rule-2-arch-aware). |
| `DEBIAN_FRONTEND` | every step | `noninteractive`. See [Rule 3](#rule-3-non-interactive). |
| `$HOME` | every step | `/home/rocky` for `runAs: rocky`, `/root` for `runAs: root`. |
| `$REPOS` | every step | Comma-separated clone URLs the user chose, when the pack takes repos. |
| `$GITHUB_TOKEN` | every step, **when configured** | A GitHub token, for private repositories and for `gh`. Satisfied by `github.pat` in the operator's config file, or by the GitHub account the box's creator connected — same name, same meaning, either way. |
| `$RDP_PASSWORD` | every step, **when the pack sets `requiresRdp`** | The remote-desktop password for the `rocky` account. |

### The two secrets, and how to use them safely

`$GITHUB_TOKEN` and `$RDP_PASSWORD` arrive through `secrets.env`, a `0600` file written at the
moment it is created. They are the only credential names Rocky Surf promises a pack, and that
list is closed on purpose: every name here is a commitment to keep working, and a per-tool
namespace would let packs depend on names nothing ever agreed to.

**Both may be absent.** A key with no secret behind it is omitted entirely rather than set
empty, so guard before you use one:

```bash
if [ -n "${GITHUB_TOKEN:-}" ]; then
  gh auth setup-git          # gh reads GITHUB_TOKEN with no further configuration
fi
```

An empty value would be worse than a missing one — `RDP_PASSWORD=` would pass a naive check and
then set an empty desktop password.

**Never put either in a command line.** Everything in `argv` is readable through `ps` by every
other unprivileged step running on the same box:

```bash
# Do this — the secret goes in on stdin.
printf 'rocky:%s\n' "$RDP_PASSWORD" | chpasswd

# Not this — visible in `ps` to anything else running.
echo "rocky:$RDP_PASSWORD" | tee /tmp/pw && chpasswd < /tmp/pw
```

**You usually do not need `$GITHUB_TOKEN` for cloning.** Repository clones in the resolved plan
already authenticate with it when it is set, via a per-invocation credential helper that keeps
the token out of `argv` and out of the checkout's `.git/config`. Reach for it only when your
own script talks to a forge API.

**`$GITHUB_TOKEN` is the instance-wide token, and it is on every box it is configured for.** An
operator may also configure per-repository tokens, and since `rockysurf-18lq` a box receives only
the ones its own declared repositories need — but that narrowing never touches this variable, so
the guard above keeps its meaning: if the operator set `github.pat`, `gh` works here. What the
narrowing does mean is that a repository your pack clones *itself*, one the user did not declare
at create, may not be covered by any of the scoped tokens on the box. Clone what the user declared
(`$REPOS`) and let the plan's own clone steps do the authenticating.

