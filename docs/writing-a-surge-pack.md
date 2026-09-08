# Writing a Surge Pack

*For Surge Pack authors and the agents that write Surge Packs.*

A **Surge Pack** is a curated bundle of Tools that gets installed on a fresh cloud box. It is a
single YAML file, and the schema, the CLI and this page all shorten the name to *pack*. You can
read it, diff it, fork it, and send it as a pull request — which is the whole point: packs are
data, not code, and adding one should never mean touching the application.

This page is the author guide: how a pack runs, the four rules every script obeys, a complete
worked pack, and the checklist to work through before you open a pull request. The normative
half — the file format field by field, what you may not assume about the box, the retry budget,
the environment your scripts get, which version to install, and the CI smoke test — is
[`surge-pack-contract.md`](surge-pack-contract.md). Where the two disagree, **the contract wins**.

The file format is **frozen at v0.1**. A pack written today keeps working.

---

## Contents

- [How a pack runs](#how-a-pack-runs)
- [The four rules](#the-four-rules)
  1. [Idempotent](#rule-1-idempotent)
  2. [`$ARCH`-aware](#rule-2-arch-aware)
  3. [Non-interactive](#rule-3-non-interactive)
  4. [`runAs`-honest](#rule-4-runas-honest)
- [A complete pack](#a-complete-pack)
- [Debugging a pack on a real box](#debugging-a-pack-on-a-real-box)
- [Checklist before you open a pull request](#checklist-before-you-open-a-pull-request)
- [The contract](#the-contract)

---

## How a pack runs

Understanding this takes two minutes and explains all four rules.

When someone creates a Server with your pack, the control plane resolves the pack into an
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
non-interactive, and `runAs`-honest. CI enforces all four. Each rule below states what it
requires and why; the worked right-and-wrong pairs, and the evidence behind each rule, are in
[`surge-pack-contract.md` § The four rules](surge-pack-contract.md#the-four-rules).

### Rule 1: Idempotent

**Running your script twice must be safe, and the second run must change nothing.**

The resume path re-runs any step that did not finish, so a script that appends to a file, or that
fails when its target already exists, turns a recoverable interruption into a corrupted box — and
the box looks installed, which makes it nasty to diagnose. Guard anything that mutates existing
state, and prefer commands that are already convergent (`apt-get install`, `npm install -g`,
`install -m`, `mkdir -p`) over ones that are not (`>>`, `mv`, `useradd`). The most common
real-world break is the shell-profile append: run it three times and the user's `PATH` carries
three copies of the same line.

→ [The worked examples](surge-pack-contract.md#rule-1-idempotent)

### Rule 2: `$ARCH`-aware

**Never hardcode a CPU architecture. Read `$ARCH` and branch.**

We run on both `amd64` and `arm64`, and which one a user gets depends on the Provider and the
size they picked. The agent exports `ARCH` for every step, root and unprivileged alike,
normalized to Debian's spelling — `amd64` or `arm64`, never `x86_64` or `aarch64`. Most of the
time you need nothing: `apt-get install`, `npm install -g` and `pip install` resolve the right
build themselves. You need `$ARCH` when you download a binary or a tarball by URL, and an
unrecognised value should be a loud error rather than a silent download of the wrong binary.

→ [The worked examples](surge-pack-contract.md#rule-2-arch-aware)

### Rule 3: Non-interactive

**Nothing may prompt. There is no terminal and nobody is watching.**

Your script runs under a systemd unit with no TTY attached. A prompt does not pause for input —
it reads EOF: `apt-get` aborts, and `debconf` may hang until the step's timeout expires, which
looks to the user like a box that never finishes booting. The agent already exports
`DEBIAN_FRONTEND=noninteractive` for you, so pass `-y` to `apt-get` and `--yes` to `npx`, and
avoid anything that merely *waits* as well. Where a download genuinely deserves one more go the
bound is small and belongs on the command — see
[`surge-pack-contract.md` § Bounded retries](surge-pack-contract.md#bounded-retries), which also covers the
apt retry you do **not** have to write.

→ [The worked examples](surge-pack-contract.md#rule-3-non-interactive)

### Rule 4: `runAs`-honest

**Declare the user your step actually needs. Don't declare `rocky` and then reach for `sudo`.**

`runAs` is not documentation, it is dispatch: the agent reads it and runs your script as `root`,
or as `rocky` through `sudo -u rocky -H env …`. The CI smoke-test container is a stock
`ubuntu:24.04` image, which ships without `sudo` at all, so a `rocky` step that shells out to it
fails there even though it happens to work on a cloud image. A root step that writes into
`/home/rocky` leaves root-owned files the user cannot edit. And the environment differs:
unprivileged steps run with `-H`, so `$HOME` is `/home/rocky` where a root step's is `/root`.

To decide, ask one question: **on your own laptop, would you run this command as yourself, or
would you type `sudo` first?** The first is `rocky`, the second is `root`.

→ [The worked examples](surge-pack-contract.md#rule-4-runas-honest)

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
      Only needed when the operator configured no token — with one, $GITHUB_TOKEN is
      already in your shell and gh works as it is.

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
    runAs: root                    # a global npm install, into node's own prefix
    bootstrap: false
    enabled: true
    installScript: |
      set -euo pipefail

      npm install -g --no-fund --no-audit @anthropic-ai/claude-code@stable

      claude --version >/dev/null
```

Three things in there are worth copying into your own pack:

- **Every script ends by verifying itself.** `rustc --version` and `claude --version` are how
  you find out that an installer exited `0` after only half-working. This has bitten us.
- **`set -euo pipefail` at the top of each script.** The agent isolates and records a failed
  step, but only if the step actually reports failure.
- **Each script's idempotency is visible in one glance** — a `command -v` guard, a `grep -q`
  guard, and a stamp file. A reviewer should not have to guess.

---

## Debugging a pack on a real box

When one of your Tool steps fails on a real Server, the default is that **the machine is
terminated** (ADR-0010): a half-installed box is worthless and billing, and the user gets the
complete account instead — the failed step by name, the classified cause, the decisive lines, and
the step's whole log, on the creation screen and the Server page. For most failures that log is
all you need.

When it is not — you want to poke at the box itself — set this in the config of the Rocky Surf
you are testing with:

```yaml
bootstrap:
  onFailure: keep
```

A failed Tool install then leaves the machine up, exactly as it did before, and the row carries
the still-billing notice until you terminate it. SSH in and read `/var/lib/rockysurf/agent.log`
and `/var/lib/rockysurf/steps/<step id>.log`. Put it back to `terminate` (or delete the key) when
you are done; nobody else's boxes should outlive their failures.

A repository that fails to clone never terminates the box under either setting — it is an
optional step, and shows up as a warning on the running Server.

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
- [ ] No apt retry loop of your own — the agent already gives every step a second attempt. Every
      `curl` that matters carries `--retry 3 --retry-delay 2 --retry-all-errors`. See
      [Bounded retries](surge-pack-contract.md#bounded-retries).
- [ ] The agent installs **unversioned** from its registry channel — or, if it has no registry
      channel, is pinned to a version and verified against a `sha256`, the same treatment
      anything fetched from GitHub releases or a vendor CDN gets. Nothing resolves a version
      through `api.github.com`. See [Which version to install](surge-pack-contract.md#which-version-to-install).
- [ ] Each script ends with a command that verifies the install actually worked.
- [ ] `installOrder` uses the [documented bands](surge-pack-contract.md#installorder-and-the-gaps-of-10-convention) and leaves gaps of 10.
- [ ] `requiresRepos`, `requiresRdp`, `desktop` and `webPort` describe what your pack actually needs.
- [ ] Every value your install scripts read from the environment is either one of the two names
      Rocky Surf promises or one your pack declares in `inputs` — nothing reads a variable
      nobody sends.
- [ ] `guide` tells the user how to authenticate everything the pack installs, and admits
      anything the install could not finish.
- [ ] If this pack builds on another, it references that pack's Tool ids, redefines none of
      them, and leaves the other pack's file unchanged.

---

## The contract

[`surge-pack-contract.md`](surge-pack-contract.md) is the normative half of this document, and the place to
look a rule up:

- [The file format](surge-pack-contract.md#the-file-format) — every field of `Tool` and `SurgePack`,
  [`installOrder` and the gaps-of-10 convention](surge-pack-contract.md#installorder-and-the-gaps-of-10-convention),
  [`inputs`](surge-pack-contract.md#inputs--what-your-pack-asks-the-user-for),
  [`guide`](surge-pack-contract.md#guide--what-the-user-has-to-do-themselves), and
  [building on an existing pack](surge-pack-contract.md#building-on-an-existing-pack).
- [The four rules, in full](surge-pack-contract.md#the-four-rules) — the right and the wrong way to
  write each one.
- [Bounded retries](surge-pack-contract.md#bounded-retries) — the apt retry the agent owns, and the
  three-attempt bound that is yours.
- [What you may not assume](surge-pack-contract.md#what-you-may-not-assume) — what is, and is not, on
  the box before your script runs.
- [Which version to install](surge-pack-contract.md#which-version-to-install) — latest from a
  quota-free registry channel; pinned and `sha256`-verified everywhere else.
- [The environment your scripts get](surge-pack-contract.md#the-environment-your-scripts-get) — every
  variable a step is handed, and how to handle the two secrets.
- [Sharing a single Tool](surge-pack-contract.md#sharing-a-single-tool) — the tool-file format, for
  when the thing worth sharing is one Tool rather than a whole box.
- [The CI smoke test](surge-pack-contract.md#the-ci-smoke-test) — `rockysurf pack lint` and
  `rockysurf pack check`, what the second run must satisfy, and publishing to the shop.
- [Where these rules come from](surge-pack-contract.md#where-these-rules-come-from) — the evidence
  behind each one.

The bootstrap agent's side of the same contract, in implementer's terms, is
[`bootstrap-contract.md`](bootstrap-contract.md).

Found something these pages get wrong, or a rule that fights a legitimate pack? Open an issue.
The format is frozen; the documentation isn't.
