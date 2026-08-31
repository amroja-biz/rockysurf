# Verifying a pack

Two loops. The fast one runs in about two seconds and catches most of what a first draft gets
wrong; the slow one takes minutes, needs Docker, and is the thing that actually decides whether
the pack works. Use the fast one after every edit and the slow one when you believe you are done.

**Both run from the root of a Rocky Surf checkout** — anchor every invocation, since a working
directory does not survive between tool calls — and both need a one-time setup, on Node 22 or
newer:

```bash
pnpm install && pnpm -r build
```

## Contents

- [Loop 1: the loader test](#loop-1-the-loader-test)
- [Loop 2: the smoke harness](#loop-2-the-smoke-harness)
- [Reading a harness failure](#reading-a-harness-failure)
- [When the failing step is not yours](#when-the-failing-step-is-not-yours)
- [Isolating one script](#isolating-one-script)
- [Failure-to-fix map](#failure-to-fix-map)
- [The amd64 problem](#the-amd64-problem)
- [What to claim when you are done](#what-to-claim-when-you-are-done)

## Loop 1: the loader test

```bash
pnpm --filter @rockysurf/core exec vitest run src/packs/packs.test.ts
```

No Docker, no container, about two seconds. It loads every file in `packs/` — yours included, and
the shipped ones alongside it, so a duplicate `toolId` or a dangling reference shows up here — and
checks it against the frozen schema plus the mechanically checkable half of the four rules:

| The test says | It means |
|---|---|
| `<pack>.yaml validates against the frozen schema` | Shape, types, unknown keys, id spelling |
| `every pack references only tools that exist` | Every id in `pack.tools` is defined somewhere in `packs/` |
| `rule 2: no script hardcodes an architecture without branching on $ARCH` | The script mentions `x86_64`/`aarch64`/`linux-x64`/`linux-arm64` but never `$ARCH` |
| `rule 3: no apt-get install without -y, and no npx without --yes` | Also rejects `read -p` |
| `rule 4: no sudo inside a runAs: rocky script` | The literal word `sudo` anywhere in the body — **including in a comment** |
| `rule 1: every append to a file is guarded` | The script contains `>>` but not `grep -q` |
| `rule 1: no cache-busted download URLs` | The script contains `date +%s` |
| `assumes nothing about the cloud` | `aws s3\|ec2\|configure`, `s3://`, or `169.254.169.254` |
| `every apt-installing script refreshes the package list first` | `apt-get install` without the literal `apt-updated` stamp |
| `installOrder respects the documented bands` | Outside 10–60 inclusive. Values between the bands (`25`, `36`) are fine |
| `<pack> round-trips` | The file survives export→import byte-identically |

Failures name the tool and script: `zz-thing.installScript: expected … to contain '$ARCH'`.

Two things it deliberately does not tell you: whether the script *works*, and whether it is
*genuinely* idempotent. `grep -q` being present is not `grep -q` being correct. Do not report a
pack as verified on the strength of this test.

What it will not do is fail you for existing. Every assertion about the *shipped* packs — that
each of the six carries a card image, a guide, and a `gh auth login` line in that guide — names
those six explicitly, and every assertion about a pack in general holds an optional field to the
schema's word. `routes.test.ts` keeps a test called *a seventh pack file changes nothing about
the application*, which drops an extra pack into a temporary `packs/` and re-runs the public
contract over it, so that the couplings that used to fail a valid seventh file (`rockysurf-d5an`)
cannot come back quietly. If `src/packs/` is red, it is red about your pack.

There is one honest reason to care about the container's own quirks here rather than later: the
smoke container is not identical to a cloud image in *both* directions. It is thinner in the ways
the contract lists, and it is also missing `/usr/share/doc/*`, which the Docker image excludes by
policy and a real Ubuntu box has. A step that reads a file from there passes on a cloud box and
finds nothing in CI — or, if you wrote the verification the contract asks for, fails in CI for a
reason that looks nothing like the truth.

## Loop 2: the smoke harness

```bash
node scripts/pack-smoke.mjs --pack <pack-id> --arch arm64
node scripts/pack-smoke.mjs --pack <pack-id> --arch amd64
```

Useful flags: `--keep` leaves the container running when something fails (and prints its name and
a temp directory holding both runs' logs); `--json` emits a machine-readable document on stdout
with failure dumps on stderr. With no `--pack` it runs every pack in `packs/`, which is what CI's
matrix does one leg at a time.

**It exits `0` only when every check passed, `1` on any failure, `2` when it could not run at
all.** Do not pipe it into `tail` or `head`: you lose the exit status to the pipeline and you cut
off the failure dump, which is the only part that tells you what went wrong. Let it print, or
redirect the whole thing to a file and read that.

For each pack, on one architecture, it:

1. starts a stock `ubuntu:24.04` container — no convenience packages, empty apt lists, **no
   `sudo`**;
2. creates the unprivileged `rocky` user, and nothing else;
3. resolves your pack with core's own loader and resolver, and runs the resulting plan through
   the real bootstrap agent;
4. **deletes `/var/lib/rockysurf/state.json` and runs the whole plan again in the same
   container.**

Step 4 is the entire test. The agent is contracted to read that journal and skip every step
already marked `done` — so a harness that merely re-invoked the agent would get a green run in
seconds in which not one script body executed twice. The journal exists to *prevent*
re-execution; a test of re-execution has to take it away first.

The checks are listed in SKILL.md step 4; three of them are easy to misread:

- `run 2: nothing was skipped as already-done` failing does not mean your pack is broken — it
  means the journal was not discarded and **the entire run proved nothing**. Investigate the
  harness, not the pack.
- `run 2 changed nothing: .bashrc x2 and sources.list.d byte-identical` names the differing lines
  when it fails. The diff points straight at the unguarded write.
- The duration `warn` is not a failure and is still worth acting on: a run 2 that re-downloads and
  recompiles everything exits `0` and will hurt somebody's resume.

There is a `sudo` shim in the container, and it is not a loophole: the agent itself drops
privilege with `sudo -u <user> -H env …`, so exactly one caller needs it. The shim answers that
one invocation with `runuser` and refuses every other form with

```
sudo: not available to install scripts on a Rocky Surf box.
  A 'runAs: rocky' script must not need root. See docs/writing-a-pack.md rule 4.
```

If you see that, the harness is right and the pack is wrong.

## Reading a harness failure

When a run fails, the harness prints the failing step's own log —
`/var/lib/rockysurf/steps/<id>.log`, read out of the container before it is removed — inside a
box, followed by the agent's own output around it:

```
┌─ my-pack on linux/arm64 — run 1 failed. The failing step's log follows.
│  step: tool:mytool   log: /var/lib/rockysurf/steps/tool:mytool.log (last 80 lines; the
│  agent APPENDS, so run 2's tail still holds run 1's output)
├──────────────────────────────────────────────────────────────────────────
… your script's stdout and stderr …
├─ the agent's own output around it ───────────────────────────────────────
… which step, run as whom, the exit code …
└──────────────────────────────────────────────────────────────────────────
```

**Read the step log first.** It is your script's own output and the answer is almost always
literally in it. Two things to keep in mind:

- The agent **appends** to that log, so on a run-2 failure the tail may still contain run 1's
  output. Check which run you are looking at before concluding the same thing failed twice.
- The step id tells you which half failed: `tool:<id>` is the `installScript`, `tool-setup:<id>`
  is the `setupScript`.

When the log is not enough, re-run with `--keep` and go in:

```bash
docker exec -it <container-name> bash
docker exec <container-name> runuser -u rocky -- env HOME=/home/rocky bash -lc 'command -v mytool'
```

Use `runuser`, not `sudo`, to become `rocky` — the whole point is that `sudo` is not available to
your scripts.

## When the failing step is not yours

Check this **before** you change your file. The resolved plan contains every tool your pack
references, and most of those you did not write — the shared base toolchain lives in
`packs/ai-coding-agents.yaml`, and a pack that lists `claude-code` or `nodejs` is running somebody
else's script inside its own smoke run.

The step id tells you whose it is: `tool:<toolId>` / `tool-setup:<toolId>`. If that `toolId` is
not defined in the file you wrote:

1. **Isolate it** with the recipe below, running the shipped script on its own in a fresh
   container with nothing of yours present.
2. If it fails there too, your pack is not the problem. Report it as **blocked by a shared tool**,
   naming the tool, its defining file, the exact error, and the isolation evidence.
3. Only then consider whether your pack should avoid that tool at all — and say so as a
   trade-off, not as a fix.

Editing your own file to work around somebody else's broken step wastes your time and hides a
real bug from the people who can fix it.

## Isolating one script

Useful in two situations: iterating on a script you are writing, and proving that a failure
belongs to a tool you did not write. It takes about a minute and needs no plan and no agent.

```bash
docker run --rm -it --platform linux/arm64 -v "$PWD:/work" ubuntu:24.04 bash

# inside the container:
useradd -m -s /bin/bash rocky
export ARCH=arm64 DEBIAN_FRONTEND=noninteractive HOME=/root

bash /work/my-install-script.sh   # run 1
bash /work/my-install-script.sh   # run 2 — must be quiet, quick, and exit 0
```

For a `runAs: rocky` script, run it as that user, without `sudo` available:

```bash
runuser -u rocky -- env HOME=/home/rocky ARCH=arm64 DEBIAN_FRONTEND=noninteractive \
  bash /work/my-install-script.sh
```

If that command needs `sudo`, the `runAs` is wrong. Swap `--platform` to `linux/amd64` for the
other architecture, and extract the script under test straight out of the pack file — the point is
that nothing else is in the container to confuse the result.

## Failure-to-fix map

| What you see | What it is |
|---|---|
| the failing step names a `toolId` you did not define | Not your bug until proven otherwise. See "When the failing step is not yours" |
| `sudo: not available to install scripts on a Rocky Surf box` | Rule 4. Split the tool, or declare `runAs: root` |
| `Unable to locate package <x>` | No apt-update stamp before `apt-get install`, or the package name is not in Ubuntu 24.04 |
| `cannot execute binary file: Exec format error` | Rule 2. A hardcoded architecture downloaded the wrong build |
| the step hangs until it times out | Rule 3. Something is prompting — `debconf`, `tzdata`, an installer's "Continue?" |
| `command not found` for something a previous tool installed | You assumed ordering means dependency, or you expected `.bashrc`/`/etc/profile.d` to be read — nothing sources them. `export PATH=…` at the top of the script |
| `command not found` for a tool whose install step passed | apt landed it under a different name (`fd-find` → `fdfind`). Symlink it into `/usr/local/bin` and verify the name the user will type |
| a segfault, `qemu: uncaught target signal 11`, or an illegal instruction, only on amd64 | Almost certainly the emulator running an x86 prebuilt binary, not your pack. See the amd64 section |
| passes run 1, fails `run 2 changed nothing` with a `.bashrc` line in the diff | An unguarded append. Use `grep -qF` |
| passes run 1, fails `run 2 changed nothing` with a `sources.list.d` path in the diff | The source list is rewritten unconditionally. Compare content before writing |
| `found preexisting installation` / `already exists` on run 2 | An installer with no update mode. Guard with `command -v`, a version check, or a stamp |
| `Systemd user services are unavailable` | There is no login session for `rocky`. See the linger idiom |
| `Gateway did not become reachable` / a health probe times out | The tool is waiting for a service nothing started. Use the tool's own skip flag |
| a step that only fails sometimes, on a download from GitHub | The unauthenticated `api.github.com` quota. Fetch the release asset from the CDN download URL instead |
| `packs/ does not validate — fix that before smoke-testing it` (exit 2) | Loop 1 would have told you this in two seconds |
| `@rockysurf/core is not built` (exit 2) | `pnpm -r build` |

## The amd64 problem

A pack that fails on one architecture fails the whole check — there is no amd64-only pack. On a
non-x86 machine, though, the amd64 leg is not a straightforward signal, and it goes one of two
ways. Find out which one you are in before you write a word about it.

**It will not start at all.** `exec format error`, before any of your script runs. Then the leg is
genuinely CI's, and the honest report is: arm64 passed locally, amd64 is unverified until CI runs
it, and the only architecture-dependent thing in the file is a `$ARCH` branch. Strengthen that by
checking the upstream artifacts by hand — does the apt repository serve `binary-amd64`? does the
release publish a `linux-amd64` asset with the checksum you pinned? — and say you did.

**It runs under emulation.** Slowly: expect several minutes per run. Now you have real evidence
and you are obliged to read it, because emulation reproduces genuine bugs faithfully and "that's
just the emulator" is how a broken pack ships. Work out which it is:

The discriminator is **which binary crashed**, not whose step it was in — a step you wrote can
fail because of a binary you did not write, and that is the common case.

- **A crash inside a large prebuilt x86 binary** — `Segmentation fault`, `qemu: uncaught target
  signal 11`, an illegal instruction — is the emulator. `rustc` under qemu-user on Apple Silicon
  has segfaulted for years, and anything shipping its own Bun or Node runtime behaves the same
  way. This is a permanent property of the host, not bad luck, so plan for a CI-only amd64 leg
  from the start when your pack installs one of them. Confirm it by running that binary
  standalone in a bare amd64 container, then report it as an emulation limit with the step id and
  the crash text — not as a pack failure, and not as a pass.
- **Anything else in a step you wrote** — a wrong-arch download, a missing amd64 asset, a checksum
  mismatch, a package that does not exist for that architecture — is real on any machine. Fix it.

What you must not do is soften your own script to make the leg green. A verification line that
segfaults under emulation is doing its job; deleting it ships a pack that cannot tell a working
install from a half-installed one on real hardware.

Either way, the useful thing to notice is that an emulated run still exercises **your**
architecture-dependent lines: if your tools all reached `done` on amd64 and only a shared tool
crashed, your `$ARCH` branches and your amd64 checksums are genuinely proven, and you should say
exactly that rather than either claiming a green run or throwing the leg away.

A claim of "verified on both architectures" that rests on nothing is worse than an honest gap.

## What to claim when you are done

Report what actually ran. A useful summary names: which architectures were exercised and which
were not, the step count and both run durations, whether run 2 re-executed everything and left
the hashed files byte-identical, any step that failed and **whose tool it belongs to**, and
anything the pack deliberately does not do (an unpinned version and why, a daemon that cannot
install at bootstrap, a per-repository path the harness cannot reach because it passes an empty
repository list). Everything in that list has been a real surprise to a real user of this project
at least once.

Two claims to never make: that a leg passed when it was not run, and that a red run is fine
because you decided the cause was environmental. If you decided that, say what the evidence was.
