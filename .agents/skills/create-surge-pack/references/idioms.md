# Known-good idioms

Every snippet here is lifted from a pack that ships in `packs/`, and every guard is there because
something broke without it. Prefer copying one of these to inventing your own — the failure modes
they cover are not obvious from reading, and several of them only appear on the *second* run or
on *one* architecture.

## Contents

- [The opening of every script](#the-opening-of-every-script)
- [apt packages](#apt-packages)
- [An apt repository, keyring and all](#an-apt-repository-keyring-and-all)
- [A pinned release binary](#a-pinned-release-binary)
- [A checksummed release binary](#a-checksummed-release-binary)
- [Global npm install](#global-npm-install)
- [A per-user installer you do not control](#a-per-user-installer-you-do-not-control)
- [PATH: three different problems](#path-three-different-problems)
- [Writing a config file](#writing-a-config-file)
- [A command with no idempotent mode](#a-command-with-no-idempotent-mode)
- [An installer that wants a TTY](#an-installer-that-wants-a-tty)
- [Anything that talks to systemd](#anything-that-talks-to-systemd)
- [Repositories the user selected](#repositories-the-user-selected)
- [Secrets](#secrets)
- [Anti-patterns](#anti-patterns)

Packs that ship a desktop, a background service, or anything needing `systemctl --user` have
their own reference: `desktops-and-daemons.md`. Skip it for a headless pack.

## Where versions and checksums come from

**First check whether you need any of this.** A tool served by a quota-free registry — npm, PyPI
via `pipx` — installs unversioned, so there is no version to look up and no digest to record.
This section is for the other case: a tool that ships only as a GitHub release asset, which stays
pinned to a tag and verified against a `sha256`. See `docs/writing-a-pack.md` § Which version to
install for why the two are treated differently.

For that case, budget a few minutes — it is reliably the slowest part of writing a pack, and
plenty of projects publish no digest at all. The sources, in order: the
project's own release page or download JSON (`https://go.dev/dl/?mode=json` gives version and
per-tarball sha256 in one request); a `checksums.txt`/`SHA256SUMS`/`*.sha256` asset published
beside the release; failing both, download the artifact once and hash it yourself, and say in a
comment that the digest is self-computed:

```bash
curl -fsSL "$url" | shasum -a 256      # macOS; on Linux, sha256sum
```

Do that once per architecture, on your own machine — everything else in this skill runs inside a
Linux container, and this is the one step that does not, so the coreutils name differs.

Record the bump instructions in the file, next to the pin — "to bump: change the version and both
digests, from `<url>`". A pin whose successor nobody can find becomes a pin nobody dares touch.

Ubuntu's package names are their own lookup. `apt-cache policy <name>` in a throwaway
`ubuntu:24.04` container settles both whether a package exists and which version noble carries —
which matters, since `golang-go` on noble is well behind Go's current release.

## The opening of every script

```bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive   # root steps that touch apt; harmless elsewhere
```

Without `set -e` the agent isolates and records a failed step only if the step actually reports
failure — a script that plows on after a failed download exits `0` with nothing installed.

## apt packages

```bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
[ -f /var/lib/rockysurf/apt-updated ] || { apt-get update -qq && mkdir -p /var/lib/rockysurf && touch /var/lib/rockysurf/apt-updated; }
apt-get install -y ripgrep
rg --version >/dev/null
```

**Check what the package is actually called, and what binary it lands.** The two differ often
enough to matter: `fd-find` installs `fdfind`, `bat` installs `batcat`. Verify the name the user
will type, and if it differs, make it exist:

```bash
apt-get install -y fd-find
ln -sfn /usr/bin/fdfind /usr/local/bin/fd     # -f -n: convergent, safe to repeat
fd --version >/dev/null
```

The stamp is shared by every apt tool in the plan, so the package list is refreshed exactly once
per box no matter how many tools need it — and the stamp survives into the harness's second run,
which is what makes that run a genuine no-op. The loader test requires the literal string
`apt-updated` in any script containing `apt-get install`, so this is not optional.

`runAs: root`, always. apt is root's.

## An apt repository, keyring and all

From the `gh` tool in `packs/ai-coding-agents.yaml`. The subtle part is the last block.

```bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
[ -f /var/lib/rockysurf/apt-updated ] || { apt-get update -qq && mkdir -p /var/lib/rockysurf && touch /var/lib/rockysurf/apt-updated; }
apt-get install -y curl ca-certificates      # self-contained: do not rely on the `curl` tool

case "$ARCH" in
  amd64|arm64) repo_arch="$ARCH" ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

install -d -m 0755 /etc/apt/keyrings
keyring=/etc/apt/keyrings/example-archive-keyring.gpg
if [ ! -f "$keyring" ]; then
  tmp=$(mktemp)
  curl -fsSL https://example.com/keyring.gpg -o "$tmp"
  install -m 0644 "$tmp" "$keyring"
  rm -f "$tmp"
fi

list=/etc/apt/sources.list.d/example.list
want="deb [arch=${repo_arch} signed-by=${keyring}] https://example.com/packages stable main"
if [ "$(cat "$list" 2>/dev/null)" != "$want" ]; then
  echo "$want" > "$list"
  apt-get update -qq
fi

apt-get install -y example
example --version >/dev/null
```

**Write the source list only when its content would change.** The harness hashes every file in
`/etc/apt/sources.list.d/` across the journal discard, so a source file rewritten on run 2 fails
even though its bytes are identical in content terms — and the `apt-get update` that a new source
forces then runs once instead of every time. `$ARCH` is already Debian's spelling, which is also
apt's, so it drops straight into `arch=`; branch on it anyway so a third architecture fails loudly
rather than writing a source list no mirror serves.

## A pinned release binary

From the `dolt` tool in `packs/gas-town.yaml`. Upstream's own installer was `curl … | sudo bash`,
which rule 4 rules out; this is that download without the sudo.

```bash
set -euo pipefail
TOOL_VERSION=2.2.3
case "$ARCH" in
  amd64) tool_arch=amd64 ;;
  arm64) tool_arch=arm64 ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
# Guarded on the INSTALLED VERSION rather than on a stamp: a re-run neither re-downloads nor
# rewrites the binary, while bumping TOOL_VERSION still reinstalls.
if [ "$(mytool version 2>/dev/null | awk 'NR==1{print $3}')" != "$TOOL_VERSION" ]; then
  tmp=$(mktemp)
  curl -fsSL "https://github.com/org/mytool/releases/download/v${TOOL_VERSION}/mytool-linux-${tool_arch}.tar.gz" \
    | tar -xzO "mytool-linux-${tool_arch}/bin/mytool" > "$tmp"
  install -m 0755 "$tmp" /usr/local/bin/mytool
  rm -f "$tmp"
fi
mytool version >/dev/null
```

Version-guarding beats stamp-guarding whenever the tool can report its own version: the stamp can
disagree with the disk, the version cannot.

Note the URL is the **release download CDN**, not `api.github.com`. Installers that ask the API
which release is latest get 60 unauthenticated requests an hour per source IP, and a bootstrapping
box has no token — when the quota runs out the installer typically reports "no pre-built binary",
falls through to a source build, finds no toolchain, and exits 1 with the asset it wanted sitting
perfectly reachable on a CDN that has no quota at all.

## A checksummed release binary

From `beads` in `packs/ai-coding-agents.yaml`. Same shape, plus verification and bounded retries:

```bash
bd_version=v1.2.1
case "$ARCH" in
  amd64) bd_sha=48aecf42ffdefa6470298d8022deeb762e30c8729dc0a4bdda93888c0b0354e2 ;;
  arm64) bd_sha=507c35d0fbf382b5ac64824386460a80849d73064d3f50b23eb247eabb68c7a8 ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
stamp="$HOME/.rockysurf/installed-beads-$bd_version"  # the version is IN the stamp name
if [ ! -f "$stamp" ]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  # Bounded retries: one reset mid-download should cost a second, not a box.
  curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors "$url" -o "$tmp/beads.tar.gz"
  echo "$bd_sha  $tmp/beads.tar.gz" | sha256sum -c - >/dev/null
  tar -xzf "$tmp/beads.tar.gz" -C "$tmp"
  install -D -m 0755 "$tmp/bd" "$HOME/.local/bin/bd"
  mkdir -p "$(dirname "$stamp")" && touch "$stamp"
fi
```

Putting the version in the stamp *name* is what makes a version bump reinstall while an unchanged
version is a no-op.

## Global npm install

```bash
set -euo pipefail
# Unversioned on purpose: npm is a quota-free registry, so the user gets the current release,
# and a bare name takes the `latest` dist-tag rather than any prerelease the package publishes.
# npm install -g is convergent, so a re-run is a no-op.
npm install -g --no-fund --no-audit mytool
mytool --version >/dev/null
```

Where you would rather not re-resolve the registry on every resumed install, guard on presence
instead — `command -v mytool >/dev/null 2>&1 || npm install -g --no-fund --no-audit mytool`. The
trade is that the box then keeps whatever it installed at boot, so say in the `guide` that moving
forward is the tool's own updater.

**`runAs: root`.** A global install writes into `/usr/lib/node_modules`, which is root's — the
single most common rule-4 violation is a `runAs: rocky` tool that runs `sudo npm install -g`.
Most npm packages that ship native binaries publish per-platform optional dependencies and need
no `$ARCH` branch at all; the version check at the end is what proves npm picked an executable
build.

## A per-user installer you do not control

```bash
set -euo pipefail
# Put every candidate bin directory on PATH BEFORE the installer runs. Several installers finish
# by verifying their own work with a PATH lookup; under the agent's non-interactive shell that
# lookup fails, the installer exits non-zero, and the step fails with the tool sitting installed
# on disk.
export PATH="$HOME/.local/bin:$HOME/.mytool/bin:$PATH"
if ! command -v mytool >/dev/null 2>&1; then
  curl -fsSL https://example.com/install.sh | bash
fi
```

`command -v` is the right guard when the tool ends up on PATH. When you cannot inspect the
installer's idempotency at all, use an explicit stamp instead, so re-running the step is a no-op
regardless of how the installer behaves:

```bash
stamp="$HOME/.rockysurf/installed-mytool"
if [ ! -f "$stamp" ]; then
  curl -fsSL https://example.com/install.sh | bash
  mkdir -p "$(dirname "$stamp")" && touch "$stamp"
fi
```

Ask PATH where a tool is rather than asserting where it ought to be. One upstream installer moved
from `~/.claude/bin` to `~/.local/bin` and the hardcoded verification path could no longer find a
binary it had just successfully installed.

## PATH: three different problems

Getting a binary "on PATH" means three unrelated things here, and confusing them is a common way
to ship a pack that installs a tool nobody can run.

**1. Your own script's PATH.** Steps run under a plain `bash -c` — non-login and
non-interactive — so **nothing sources `/etc/profile`, `/etc/profile.d/*` or `~/.bashrc`**. A
`PATH` line written into any of those has no effect on your script or on any later step. Export
what you need, at the top:

```bash
export PATH="$HOME/.local/bin:$HOME/go/bin:$PATH"
```

Do this *before* invoking a third-party installer, not after: several of them finish by verifying
their own work with a PATH lookup, and under this shell that lookup fails, the installer exits
non-zero, and the step fails with the tool sitting installed on disk.

**2. Every user's PATH, for a system-wide binary.** The temptation is `/etc/profile.d/mytool.sh`,
and it is wrong twice over — nothing in the bootstrap reads it, and it does not help a script.
Put the binary somewhere already on the default PATH instead. `/usr/local/bin` is, so a package
that unpacks into its own directory gets a symlink:

```bash
# Go unpacks to /usr/local/go; /usr/local/go/bin is on nobody's PATH.
ln -sfn /usr/local/go/bin/go /usr/local/bin/go
ln -sfn /usr/local/go/bin/gofmt /usr/local/bin/gofmt
go version >/dev/null
```

`ln -sfn` is convergent: it replaces an existing symlink rather than failing or nesting one
inside a directory, so a second run changes nothing. `install -m 0755 <binary> /usr/local/bin/`
does the same job for a single-file release.

**3. The human's interactive shell, later.** This is the only thing `.bashrc` is for — the user's
SSH session, after the box is built. It matters for per-user installs into `$HOME`, which cannot
be symlinked into a root-owned directory from a `rocky` step:

```bash
touch "$HOME/.bashrc"
for dir in "$HOME/.local/bin" "$HOME/.mytool/bin"; do
  grep -qF "$dir" "$HOME/.bashrc" || echo "export PATH=\"$dir:\$PATH\"" >> "$HOME/.bashrc"
done
```

This is the check the harness exists for: it hashes `/home/rocky/.bashrc` and `/root/.bashrc`
before and after the second run and requires them byte-identical. `grep -qF` (fixed string, not a
pattern) is what keeps them that way. The loader test requires the literal `grep -q` in any script
containing `>>`, so an unguarded append never reaches Docker.

Write this even if another tool in your pack writes the same line — a pack that took your tool
without that one would otherwise get a binary its shell cannot find. Duplicate guarded appends
cost nothing.

## Writing a config file

Whole-file writes converge and cannot accumulate duplicate lines, so prefer them to appends:

```bash
install -D -m 0644 /dev/stdin "$HOME/.config/mytool/config.toml" <<'EOF'
theme = "dark"
EOF
```

When writing the file has a **visible side effect** — restarting a service, say — track whether
anything actually changed, because doing it unconditionally on a resume is exactly the kind of
side effect the second run exists to catch:

```bash
changed=0
if [ "$(cat /etc/mything/conf 2>/dev/null)" != "$want" ]; then
  printf '%s\n' "$want" > /etc/mything/conf
  changed=1
fi
[ "$changed" = 0 ] || systemctl restart mything
```

## A command with no idempotent mode

Third-party commands that error rather than no-op on a second call get a stamp per unit of work:

```bash
stamp="$HOME/.rockysurf/mytool-workspace-$name"
if [ ! -f "$stamp" ]; then
  mytool workspace add "$name"
  mkdir -p "$(dirname "$stamp")" && touch "$stamp"
fi
```

For a command that creates a marker of its own, guard on that instead — it cannot drift from
reality the way a stamp can: `[ -d "$HOME/gt/.git" ] || gt install "$HOME/gt" --git`.

## An installer that wants a TTY

Rule 3, and the failure is nastier than it sounds: the wizard prints its briefing, stops at
"Continue?", reads EOF, exits non-zero, and takes the rest of the plan down with it.

```bash
mytool onboard --non-interactive --accept-risk --auth-choice skip
```

Find the tool's own non-interactive flags rather than trying to feed it input. Three things worth
knowing from the `open-claw` experience:

- A `--non-interactive` flag often *requires* an acknowledgement flag alongside it. Taking that
  acknowledgement on the user's behalf is a real decision — make it deliberately, say so in a
  comment, and tell the user in the `guide` what was acknowledged for them.
- **No credential of the user's reaches the box at bootstrap**, so any "sign in" step must be
  skipped and handed to the `guide`. There is no version of this where the pack logs them in.
- A closing health probe will wait for a service nothing started. Tools usually name their own
  remedy (`--skip-health`); read the tool's failure output rather than adding a `sleep`.

## Anything that talks to systemd

The smoke container has no init at all, so guard it — an unguarded `systemctl` fails the step
there while working fine on a real box:

```bash
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl enable myservice
fi
```

If what you are installing is a **user** service (`systemctl --user`), that guard is not enough
and the fix is not obvious — `rocky` never logs in during a bootstrap, so there is no user
manager for it to talk to. See `desktops-and-daemons.md`.

## Repositories the user selected

Only when the pack sets `requiresRepos: true`. `$REPOS` is comma-separated and may be empty — the
smoke harness passes no repositories at all, so this loop must be a clean no-op:

```bash
for repo in $(echo "${REPOS:-}" | tr ',' ' '); do
  [ -n "$repo" ] || continue
  dir="$HOME/$(basename "$repo" .git)"
  [ -f "$dir/Cargo.toml" ] || continue
  (cd "$dir" && cargo fetch)          # convergent: a no-op once the lockfile's crates are present
done
```

Anything repo-shaped belongs in `setupScript`, which runs after every tool is installed.

Beware the trap this hides: because the harness passes an empty repository list, a bug in this
loop passes CI and breaks for every real user who selects a repository. If your pack does real
work per repository, exercise it by hand once.

## Secrets

```bash
if [ -n "${GITHUB_TOKEN:-}" ]; then
  gh auth setup-git          # gh reads GITHUB_TOKEN with no further configuration
fi

# The secret goes in on stdin. Never in argv — everything there is readable through `ps` by
# every other unprivileged step on the box.
printf 'rocky:%s\n' "$RDP_PASSWORD" | chpasswd
```

## Anti-patterns

Each of these has cost this project a real debugging session.

```bash
echo 'export PATH=...' >> ~/.bashrc        # duplicates on resume; fails the byte-identical check
sudo apt-get install -y golang-go          # in a runAs: rocky script — sudo does not exist there
sudo npm install -g mytool                 # same; a global install is root's, so declare root
curl .../tool-linux-x86_64                 # wrong binary on arm64, failing much later as
                                           #   "cannot execute binary file"
git clone https://... ~/thing              # fails on the second run; use || git -C ~/thing pull --ff-only
apt-get install nodejs                     # no -y: prompts, reads EOF, aborts
npx playwright install-deps chromium       # no --yes: prompts to install the package first
curl "https://cdn/x?$(date +%s)"           # cache-busting guarantees a different payload each run
go install github.com/org/tool@latest      # unpinned: CI tested something else
aws s3 cp s3://bucket/asset .              # no cloud credentials, no AWS CLI, maybe not even AWS
curl http://169.254.169.254/latest/meta-data/  # no metadata service on a BYO box
systemctl --user enable mytool             # no user session at bootstrap; see the linger idiom
systemctl start x && sleep 60              # waits blind; use a bounded check
```

The last one worth stating on its own: **do not put a root command in a `rocky` script because
"it works on a real box"**. It does not work in CI, it does not work where `rocky` is not in
`sudoers`, and the split into two tools costs four lines.
