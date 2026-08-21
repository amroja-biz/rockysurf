---
name: creating-surge-packs
description: Author a Surge Pack for Rocky Surf — the single YAML file that decides which tools get installed on a fresh cloud dev box. Use this whenever someone wants to make, write, author, extend, debug or ship a Surge Pack or a "Rocky Surf pack"; wants their own tools, CLIs, coding agents, runtimes or desktop installed on a Rocky Surf server; wants to build on, fork or add tools to a pack that already exists — theirs or a shipped one; is editing anything under packs/*.yaml in a Rocky Surf checkout; or says things like "make me a surge pack for X", "add my tools to rocky surf", "I want a Rocky Surf box with Rust and Neovim on it", "add ripgrep to the claude-code pack", "add OMP and an MCP server on top of the Claude Code pack", "add ripgrep and fzf on top of the opencode pack", "I want the opencode pack plus my own tools", "extend the ai-coding-agents pack", "my pack fails the smoke test", or "how do I get my pack into Rocky Surf". Covers the frozen v0.1 file format, the four authoring rules, the run-twice Docker smoke harness, how to extend an existing pack without breaking it, and how to install and share the finished pack.
---

# Creating a Surge Pack

A Surge Pack is a bundle of tools Rocky Surf installs on a fresh cloud box. It is **one YAML
file**: data rather than code, so adding one is meant to need no change to the application. (Meant
to — one test currently disagrees; step 3 says what to do about it.)

Your job in this skill is to take the user from "I want a box with X on it" to a pack file that
**provably** works: it survives an interrupted install, it works on both CPU architectures, and
it tells the user how to sign in to everything it installed. The proof is a real Docker harness
in the Rocky Surf repository, not your reading of the file.

The thing that makes this hard, and the reason this skill exists: a pack script runs **twice, in
the same container, in a stock `ubuntu:24.04` image with no `sudo` and no package lists**. Almost
every pack that gets written by hand fails that on the first try. Write for it from the start
rather than fixing it afterwards.

## Before you write anything

Verification needs two things. Establish both now — do not discover at step 4 that the user
cannot run the harness.

1. **A Rocky Surf checkout.** The harness, the loader and the six worked examples are all in the
   repository (in tree — an out-of-tree pack author has none of them). Check whether you are
   already in one: `packs/` and `scripts/pack-smoke.mjs` both present means yes, and this skill
   shipping from `.claude/skills/` means you very likely are. If not:
   ```bash
   git clone https://github.com/amroja-biz/rockysurf
   cd rockysurf
   ```
   Either way, once:
   ```bash
   node --version                    # 22+; if the machine uses nvm, select it first
   pnpm install && pnpm -r build     # the harness needs the built core
   ```
   If they intend to contribute the pack back, have them fork first and clone the fork.
   **Every command in this skill runs from the root of that checkout**, and your working
   directory may reset between tool calls, so anchor each one.
2. **Docker**, for the smoke harness. `docker version` should print a server version. Check
   *both* architectures before you promise anything, because what happens on a non-x86 machine
   varies — sometimes `linux/amd64` refuses outright, sometimes it runs slowly under emulation
   and fails in surprising ways:
   ```bash
   docker run --rm --platform linux/arm64 ubuntu:24.04 uname -m
   docker run --rm --platform linux/amd64 ubuntu:24.04 uname -m
   ```

Read `references/contract.md` now if you have not authored a pack in this session. It is the
condensed contract: the field tables, the four rules, and the list of things you may not assume
about the box. The normative source is `docs/writing-a-pack.md` in the checkout — when the two
disagree, the checkout wins, and say so to the user.

## Route first: new pack, or building on one that exists?

Before Step 1, ask the question whose answer decides everything else: **does a pack that already
exists get modified, or does it stay exactly as it is?**

| The user wants | Mode | What changes on disk |
|---|---|---|
| their own variant — extra tooling on top of a pack that already works; the original stays in the picker, untouched | **Derive** (the default) | exactly one new file, `packs/<new-id>.yaml` |
| everyone who already uses pack X to get the new tool too, and X is theirs to change | **Amend** | the one existing `packs/X.yaml` |
| a new tool that several packs should share | one definition in whichever file owns it, referenced from each pack's `tools:` list | the owning file, plus each pack's `tools:` list |

**Default to derive.** A derived pack cannot break anybody else's pack; an amend to a base file
like `packs/ai-coding-agents.yaml` empties the entire pack picker at boot if it goes wrong (see
`references/shipping.md`). If the user is only adding tools on top of something that already
works — "add X on top of the Y pack" — that is a derive, and it is what Step 1E below covers. A
pack with nothing existing to build on falls through to Step 1 unchanged.

## Step 1 — Interview

Ask before you write. These are the questions whose answers change the file; do not ask anything
else, and infer what you reasonably can from what the user already said.

- **What goes on the box?** Get a concrete list of tools with versions where they care. For each
  one you will need: how it installs on Ubuntu 24.04 (apt / npm -g / a release tarball / an
  upstream `install.sh`), and its home page URL, which the format requires.
- **Whose software is it?** A system package is root's. A per-user CLI that lives in `$HOME` is
  `rocky`'s. If a tool is both, it is two tools. This is rule 4 and it is the second most common
  way a pack fails.
- **Do they want repositories cloned?** If yes the pack sets `requiresRepos: true` and the user
  picks repositories at create time. The install plan clones them for you — you write no clone
  code — and `$REPOS` reaches your scripts so you can do extra work per repository.
- **How much of the shared base toolchain do they want?** See below. This is the highest-leverage
  question in the whole file and the easiest one to skip: it decides both what the box can do and
  how long every smoke run takes.
- **Where does each tool come from — a registry, or GitHub releases?** It decides the version
  question for you. Anything on a quota-free registry (npm, PyPI via `pipx`) installs
  **unversioned**, so there is no pin and nothing to bump. Anything that ships only as a GitHub
  release asset is pinned to a tag and checked against a `sha256`, and that pin needs bump
  instructions in the file — the upstream release page, a `checksums.txt`. A pin with no bump
  instructions rots. See `docs/writing-a-pack.md` § Which version to install.
- **Headless or a graphical desktop?** A desktop means `desktop: xfce` and almost always
  `requiresRdp: true` (Rocky Surf then asks for a remote-desktop password at create time).
- **Where is this pack going?** Three destinations, and they shape the file differently — a pull
  request against `packs/`, a file imported into their own running instance, or a file shared
  with other people. See `references/shipping.md`; the short version is in step 6.

**If you cannot reach the user**, do not stall — these defaults are defensible, and say which ones
you took: install registry-served tools unversioned, pin what comes from GitHub releases and note
where a bump comes from; take the base subset
your pack's purpose actually implies (below); `requiresRepos: true` for a pack aimed at working on
code and `false` for a pack that is a workstation; headless unless a GUI was named; and assume the
pack is for the user's own instance rather than a pull request.

### What you get for free

**`packs/ai-coding-agents.yaml` defines a shared base toolchain** that every other pack lists by
id rather than redefining. Read that file before writing a single install script: half of what a
new pack needs is usually already there.

**Take the subset you need.** All six shipped packs list the full set because all six are
general-purpose AI-coding boxes, not because the format requires it. A narrower pack should say so
with its tool list — a terminal-first box has no use for Chromium, and dropping `playwright` and
`playwright-deps` roughly halves every smoke run you are about to do.

Trimming is safe only if you know what the survivors need. Ordering does not install anything, so
if you drop a tool that another one depends on, the dependent breaks:

| Tool | Order | Needs |
|---|---|---|
| `build-essential`, `git`, `tmux`, `unzip`, `python3-pip`, `python3-venv`, `pipx` | 10 | nothing |
| `curl` | 10 | nothing |
| `gh` | 10 | nothing — installs its own `curl` |
| `nodejs` | 20 | `curl` |
| `playwright-deps` | 25 | `nodejs` (runs `npx`) |
| `playwright` | 30 | `nodejs`, and `playwright-deps` for a browser that actually launches |
| `beads`, `agent-deck` | 30 | `curl` |
| `beads-viewer` | 30 | `curl` |
| `claude-code` | 40 | `curl` only — **not** `nodejs`; its installer ships its own runtime |

Anything you add yourself follows the same rule, so state its needs in a comment. Say out loud
which base tools you dropped and why, so the user can push back.

## Step 1E — Extending an existing pack

Skip this step for a from-scratch pack. Read it when the user is deriving from, or amending, a
pack that already ships — `packs/gas-town.yaml` is the in-repo proof this pattern already works:
it lists the shared base toolchain plus three other packs' agents (`claude-code`, `amp`,
`codex`) plus its own three tools. No format change is involved anywhere below; `pack.tools` is
just a list of ids, and it already resolves across files.

**The derive workflow:**

1. **Read the base pack file end to end** — `packs/<base>.yaml`. Note its `pack.tools` list, its
   `requiresRepos` / `requiresRdp` / `desktop` / `webPort`, and its `guide`. If it references an
   agent defined elsewhere (`amp`, `codex`, `opencode`, `claude-code`, `gas-town` — see the table
   further down in Step 2 for which file owns which), read that file too.
2. **Take a new identity.** A free `packId` and `displayOrder` (`grep -h 'toolId:\|packId:\|
   displayOrder:' packs/*.yaml | sort -u`, the same command Step 2 uses), filename equal to
   `packId`. Never reuse the base's `packId` or `displayOrder` — that is amending, not deriving.
3. **Copy `pack.tools` from the base verbatim, in the same order.** Do not re-sort, do not tidy.
   List order does not affect execution — `installOrder` does — so reordering the copy only
   destroys a reviewer's ability to diff it against the base. Trim afterwards only if the user
   asked for a narrower box, and re-read the dependency table above first: dropping `nodejs`
   breaks every npm-installed agent that needs it.
4. **Carry the base's behaviour flags** (`requiresRepos`, `requiresRdp`, `desktop`, `webPort`)
   unless something you are adding changes the answer — a loopback web UI needs `webPort`, a GUI
   app needs `desktop: xfce` and `requiresRdp: true`.
5. **Add only new ids to `pack.tools`, and define only those new tools under `tools:`.** Never
   redefine a tool the base owns: the loader rejects a `toolId` defined in two files, `pack lint`
   fires `duplicate-tool`, and on import a redefinition silently overwrites the shipped row for
   every pack on that instance. A base tool that needs to behave differently gets your own id
   instead (`acme-curl`), not the base's.
6. **`installOrder` for the tools you add uses the gaps — never renumber the base's tools.** An
   add-on that needs `nodejs` (band 20) sits at 40; one that needs an agent already installed sits
   at 50. The bands are in the dependency table above and in `docs/writing-a-pack.md`; `pack lint`
   rejects anything outside 10–60.
7. **`guide`: start from the base's guide and append — do not replace it.** Every tool the base
   installed is still on the box, so its instructions are all still true. Add one block per tool
   you added.

**Then verify as if it were a brand-new pack, because to the harness it is one.** Step 3
(`pnpm --filter @rockysurf/core exec vitest run src/packs/`), then Step 4 (`node
scripts/pack-smoke.mjs --pack <new-id> --arch arm64|amd64 --keep`). **The base pack's own green
run does not transfer to the derived file** — this is the single most likely wrong assumption
someone brings to "I only added one tool," so say it out loud before they find out the hard way.

**The guardrail that makes "the base still works" checkable, and the whole point of deriving:**

```bash
git status --porcelain packs/         # a derive shows exactly one new file, nothing modified
```

If that shows `packs/<base>.yaml` as modified, the user is amending, not deriving — see below,
and re-smoke that file specifically.

**The amend path, when the base pack really is being changed:** add the tool under `tools:` and
its id to `pack.tools`, same four rules and bands as any other tool, then re-run Step 3 and Step
4 **on the amended pack**. If the file is `packs/ai-coding-agents.yaml`, that is the shared base
toolchain for every pack in the repository — re-smoke everything (`node scripts/pack-smoke.mjs`
with no `--pack`), because a pack file that fails validation is skipped at boot, taking every
pack that references its tools out of the picker with it. On a running instance, a file-backed
pack needs a restart to pick up the edit — there is no watcher — and an imported pack is edited
in the admin UI or re-imported.

`references/extending.md` has a worked derive example end to end, a symptom→fix table for what
goes wrong, and the operator/import path for extending a pack without a checkout at all —
including why **Export** is not a "fork this pack" button.

Now rejoin at Step 2 for the writing rules and Step 3 for validation — a derived pack is verified
as a new pack, because that is what it is.

## Step 2 — Write the file

Copy `assets/pack-template.yaml` into `packs/<pack-id>.yaml` in the checkout and fill it in. The
filename must match `packId` — the loader rejects a file where they disagree.

Before you name anything, see what is taken. `toolId` must be unique across the **whole
repository**, not just the base file, and `packId` and `displayOrder` are worth checking too:

```bash
grep -h 'toolId:\|packId:\|displayOrder:' packs/*.yaml | sort -u
```

That also tells you when something close to your tool already exists — the repository has a Go
toolchain (`gas-town-toolchain`) that a Go pack might reuse or might deliberately supersede, and
either way the file should say which.

**The base file is not the only place tool ids come from.** The agents themselves are defined
across `packs/amp-agents.yaml` (`amp`), `packs/codex-cli.yaml` (`codex`), `packs/open-code.yaml`
(`opencode`), `packs/ai-coding-agents.yaml` (`claude-code`) and `packs/gas-town.yaml` (`gas-town`,
`dolt`, `gas-town-toolchain`) — every one of them referenceable by id from your pack, and none of
them safe to redefine. The three npm-installed agents (`amp`, `codex`, `opencode`) need `nodejs`,
so take it if you take them. If the user asked for a named agent, go and read the file that
defines it before writing anything.

Then open the closest worked example beside it and follow its shape. `packs/open-code.yaml` is
the smallest and freshest: one new tool, everything else referenced from the base file. Pick from
these by what you are doing:

| You are | Read |
|---|---|
| adding one CLI on top of the base toolchain | `packs/open-code.yaml` |
| adding an apt repository (keyring + source list) | the `gh` tool in `packs/ai-coding-agents.yaml` |
| downloading a pinned release binary | the `dolt` tool in `packs/gas-town.yaml`, and `beads-viewer` for a checksummed one |
| building from source with a compiler | `gas-town-toolchain` + `gas-town` in `packs/gas-town.yaml` |
| shipping a desktop | `packs/open-claw.yaml` |
| taming an installer that wants a TTY or a systemd user service | `open-claw-onboard` in `packs/open-claw.yaml` |
| building on a pack that already exists | `packs/gas-town.yaml`, and Step 1E |

`references/idioms.md` has the copyable shell for each of these, with the failure each guard
prevents. **Use those idioms rather than inventing your own** — every one of them is there
because a real pack broke without it.

Four things to get right while writing, in the order they bite:

- **Idempotency.** Every script runs a second time from the top. Guard every append with
  `grep -qF`, every third-party installer with a stamp file or a `command -v` check, and write
  whole files rather than appending to them where you can.
- **Self-containment.** A step may not assume another step ran. `installOrder` is ordering, and
  equal values break ties by `toolId` — that is a determinism guarantee so an interrupted install
  resumes against the same plan, **not** a dependency mechanism. If your tool needs `curl`, either
  give it a higher `installOrder` than the `curl` tool *and* accept that ordering is all you get,
  or install `curl` yourself. The `gh` tool installs its own `curl` for exactly this reason.
- **`$ARCH`.** Never hardcode an architecture in a download URL: read `$ARCH` (already normalised
  to `amd64`/`arm64`) and `case` on it, with an explicit `exit 1` on anything else. Upstream
  labels often disagree with that spelling — `x86_64`, `aarch64`, `linux-x64` — and using their
  literal string is **fine as long as your script branches on `$ARCH` to choose it**. That is
  exactly what the `case` arms are for, and it is what the rule checks: the literal is rejected
  only in a script that never mentions `$ARCH`.
- **Verify at the end.** Close every script with the command that proves the install worked —
  `mytool --version >/dev/null`. Installers exit `0` after half-working, and this is how you find
  out. Verify **the name the user will type**: `apt-get install -y fd-find` gives them a binary
  called `fdfind`, and a script that checks `fdfind --version` passes while `fd` does not exist.

Get the version question right, and say in a comment which of the two rules you are under. A tool
on a quota-free registry (npm, PyPI via `pipx`) installs **unversioned** — users expect the current
agent and most agents update themselves anyway, so a pin bought staleness for a reproducibility it
could not keep. A tool that ships only as a GitHub release asset stays **pinned to a tag with a
`sha256`**, because the only way to ask GitHub for "latest" is the rate-limited API that took the
trunk down once already. Neither rule licenses piping a vendor's `install.sh` to `bash`. Full
reasoning, and the narrow case where an agent may still be pinned, in `docs/writing-a-pack.md`
§ Which version to install.

Two mechanical traps, both of which fail your file rather than merely advising you:

- **The word `sudo` anywhere in a `runAs: rocky` script body is rejected — including inside a
  comment.** The check scans the whole script text. Writing "upstream's installer is
  `curl … | sudo bash`, which we don't do" fails the build; reword it.
- **Any script containing `apt-get install` must contain the literal string `apt-updated`**, i.e.
  the shared stamp idiom. There is no other accepted way to refresh the package list.

And one thing that surprises everyone: **nothing sources `.bashrc` or `/etc/profile.d` for your
scripts.** Steps run under a plain non-login, non-interactive `bash -c`. A `PATH` line you append
to `.bashrc` is for the human's SSH session later; it does nothing for the next step in the plan.
Every script that needs a directory on `PATH` must `export PATH=…` itself, at the top.

## Step 3 — Validate in two seconds, before Docker

Run this after every edit. It needs no Docker and no container:

```bash
pnpm --filter @rockysurf/core exec vitest run src/packs/
```

Both this and the harness in step 4 run from the checkout root. If the machine manages Node with
`nvm`, the selected version resets between shells too, so put the selection in the same command
rather than assuming it stuck.

Run the whole `src/packs/` directory, not just `packs.test.ts`: **two** test files read `packs/`
and the second one enforces things the first does not. Together they parse every file in `packs/`
— including the one you just wrote — against the frozen schema, and mechanically check the rules
that are checkable by reading: hardcoded architectures, `apt-get install` without `-y`, `npx`
without `--yes`, `sudo` inside a `runAs: rocky` script (the whole body, comments included — your
`guide` is not scanned), unguarded `>>` appends, cache-busted URLs, `apt-get install` without the
shared apt-update stamp, `installOrder` outside 10–60, and any reference to a tool that does not
exist.

Failures name the tool and the script: `zz-thing.installScript: expected … to contain '$ARCH'`.
Fix everything here before you start a container — this loop is a thousand times faster than the
one in step 4, and it catches most of what a first draft gets wrong.

Your pack file is the only thing you have to add: no test in this repository names the packs it
expects, so adding one to `packs/` is not an application change. `routes.test.ts` proves it — *a
seventh pack file changes nothing about the application* builds a temporary `packs/` with an extra
pack in it and runs the whole public contract over it. A red test here is about **your pack**.

One thing that is easy to get half-right: `imageUrl` is optional, but if you do set it to a
bundled path (`/images/surge-packs/<something>.png`), the PNG has to be in *both*
`packages/core/public/images/surge-packs/` and `packages/web/public/images/surge-packs/`. A test
checks both directories, and a path that starts with `https://` is your own business.

Note what the suite does **not** catch: whether your script actually works, and whether it is
genuinely idempotent. `grep -q` present is not `grep -q` correct. That is what step 4 is for.

## Step 4 — Run the real smoke harness

This is the merge gate, and it is the same code CI runs:

```bash
node scripts/pack-smoke.mjs --pack <pack-id> --arch arm64 --keep
node scripts/pack-smoke.mjs --pack <pack-id> --arch amd64 --keep
```

It starts a stock `ubuntu:24.04` container, creates `rocky` and nothing else, runs your plan
through the real bootstrap agent, then **deletes the resume journal and runs the whole plan again
in the same container**. Discarding the journal is the entire point: without it the agent would
skip every completed step and prove nothing.

Two things about watching it run. **It prints nothing between "stock container prepared" and the
end of run 1** — one to five minutes, longer under emulation — so do not conclude it has hung.
If you want to know where it is, look inside the container from another call:

```bash
docker ps --filter name=rockysurf-pack-smoke --format '{{.Names}}'
docker exec <name> cat /var/lib/rockysurf/state.json     # which step, and its status
```

And `--keep` is above deliberately: it costs nothing on success and it is the difference between
diagnosing a slow failure and running the whole thing again to reproduce it. Remove the container
yourself afterwards (`docker rm -f <name>`).

The plan also contains steps your pack did not declare — a repository clone per selected
repository, a `branding` step, an `rdp` step for a pack that asks for one — so the step count
exceeding your tool count is normal.

A pass requires every one of these, and you should read them off the output rather than assuming:

- both runs exit `0` and reach `plan reached done`;
- `run 2: nothing was skipped as already-done` — a skip here means the run was meaningless;
- `run 2: every step re-executed to done`;
- `run 2 changed nothing: .bashrc x2 and sources.list.d byte-identical`. This is the check that
  catches the duplicated `PATH` line, and it is the one hand-written packs fail;
- run 2 is much faster than run 1. A run 2 that re-downloads everything exits `0` and is still
  a pack that will hurt somebody's resume; the harness prints a `warn` for it.

Read the summary off the terminal directly. The harness **exits non-zero on failure**, and piping
it into `tail` or `head` hides both the exit code and the failure dump — redirect to a file if
you need to, and check `$?`.

**When it fails**, the harness dumps the failing step's own log — `/var/lib/rockysurf/steps/<id>.log`
— delimited, followed by the agent's output around it. Read the step log first: it is your
script's stdout and stderr, and the answer is almost always literally in it. `references/verifying.md`
maps the failures you will actually hit to their fixes, including the ones that look like harness
bugs and are not (`sudo: not available to install scripts on a Rocky Surf box` means rule 4, and
the harness is right). Add `--keep` to leave the container up and go look around inside it.

**Check whose step failed before you change anything.** The plan contains every tool your pack
references, including the shared ones you did not write. If the failing step id names a tool
defined in another file, your pack may be fine and the problem is upstream of you. Isolate it
before touching your own file — `references/verifying.md` has a recipe that runs one script
standalone in a container — and then report it as *blocked by a shared tool*, naming the tool and
the evidence, rather than editing a file that has nothing wrong with it.

**About `amd64`.** On a non-x86 machine this leg either refuses to start (`exec format error`, in
which case amd64 is simply CI's job) or runs slowly under emulation. If it runs, read its
failures: emulation reproduces genuine bugs faithfully, and "that's just the emulator" is how a
broken pack ships. But do not soften your own script to turn it green either — a `Segmentation
fault` or `qemu: uncaught target signal 11` from a large prebuilt x86 binary is the emulator even
when it happens in a step you wrote. `references/verifying.md` has the discriminator, the known
casualties and the recipe for proving which it is; go there the moment amd64 goes red.

Either way, a pack that fails one architecture fails the whole check: there is no amd64-only
pack. Report what actually ran rather than what you hoped: which architectures were exercised,
which step failed and whose it is, and what is left for CI.

Finish the file before you start the amd64 leg. It is the slowest thing you will do — several
minutes per run — and editing the pack afterwards means paying for it twice.

## Step 5 — Write the `guide`

The pack installs software. It does not authenticate it: no credential of the user's reaches the
box during bootstrap, so a freshly built server is a pile of CLIs that all want a login. `guide`
is where you tell them how, and it is shown on the server's page as **plain text** — no markdown,
no HTML. Short imperative lines, literal commands, indentation as the only structure. Copy the
shape from `packs/open-code.yaml`.

Two rules, both about honesty, and this is where a pack most often lies to its user:

- **Say what the box actually has.** If a setup script could not finish something — a daemon it
  had no session to install, a wizard that only works from a desktop — the guide is where the
  user learns that, not a support thread. `open-claw`'s guide is the worked example.
- **`$GITHUB_TOKEN` is not in the user's shell.** It is delivered to bootstrap steps only.
  Repository clones during setup did use it; `gh` will not. Every shipped guide says
  `gh auth login` for this reason, and a test asserts it.

Rerun step 3 after editing the guide — it is a trimmed string in the frozen schema and a bad
block scalar breaks the round-trip.

## Step 6 — Ship it

Where the pack goes decides its final shape. This is usually the whole answer; read
`references/shipping.md` only when the pack is going somewhere other people will consume it.

- **Pull request against `packs/`** — the intended path, and the only one that gets the pack
  smoke-tested on both architectures by CI forever. Reference the shared base tool ids; do not
  redefine them. Work through the checklist at the end of `docs/writing-a-pack.md` first.
- **Import into their own running instance** — Admin → Surge Packs → Import, either uploading the
  file or fetching a URL. An imported pack becomes a database row that boot never overwrites and
  never restores. The URL fetch goes through an SSRF guard: public `http`/`https` only, 2 MB cap,
  no credentials sent, so a raw GitHub or raw gist URL works and anything private or on the
  operator's LAN does not. **Do not use Export as a "fork this pack" button** — Export inlines
  every referenced tool, so the result redefines the shared base ids, which the loader rejects
  in-tree and which overwrites the shipped tool rows instance-wide on import. Deriving by hand
  from the base's `pack.tools` id list (Step 1E) is the supported way to fork a pack.
- **Drop the file into `packs/`** in their own deployment — loaded at **boot only**, there is no
  watcher, so it needs a restart. Warn them about the cascade: a broken pack file is skipped, and
  because tool definitions are shared, breaking `ai-coding-agents.yaml` takes every pack that
  references it out of the picker until it is fixed.

Finally, tell the user what was actually proven — which architectures ran, what CI will still
check, and anything the guide admits the box cannot do. That honesty is the whole product here.

## Reference files

- `references/contract.md` — the frozen v0.1 format, field by field; the four rules; what you may
  not assume about the box; the environment and secrets your scripts get. Read it once before
  authoring; if your pack is headless you can skip its desktop and RDP parts.
- `references/idioms.md` — the known-good shell for apt, apt repositories, pinned release
  binaries, per-user installers, PATH, secrets, each with the failure it prevents. This is the
  one to read while writing.
- `references/verifying.md` — the two verification loops in detail, how to read the step-log dump,
  how to isolate one script, and a failure-to-fix map for what actually goes wrong. Read it when
  something fails, or when you are about to write a claim about what passed.
- `references/desktops-and-daemons.md` — only for a pack that ships `desktop: xfce`, a background
  service, or an installer that wants a TTY. Skip it otherwise.
- `references/shipping.md` — only when you are publishing the pack for someone else: the
  destinations in detail, the SSRF guard's real rules, and what import does to shared tool
  definitions. Step 6 above is enough for a pack that stays on the user's own instance.
- `references/extending.md` — only when you are deriving from or amending a pack that already
  exists: a worked derive example end to end, a symptom→fix table for what goes wrong, and the
  amend and out-of-checkout/import paths. Step 1E above is enough for most cases.
- `assets/pack-template.yaml` — a commented skeleton to copy into `packs/`.
