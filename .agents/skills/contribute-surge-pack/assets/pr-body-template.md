<!--
PULL REQUEST BODY TEMPLATE for a Surge Pack contributed to amroja-biz/rockysurf-shop.

Fill it in, delete every comment and every unused line, and pass it with `gh pr create
--body-file`. Do not paste it through a quoted shell argument: the description output below
contains backticks and newlines.

Each section is here because a maintainer would otherwise have to ask for it, and every round
trip is a day. A section with nothing to say gets one honest line, not deletion.
-->

## What this pack installs

<!-- One line per tool the pack DEFINES. Then the base ids it borrows, on one line. -->

**Defines**

- `<toolId>` — <what it is>, installed <from apt / from npm / from a pinned GitHub release>, runs as `<root|rocky>`.

**Borrows** (defined in Rocky Surf's own `packs/ai-coding-agents.yaml`, referenced by id)

`build-essential`, `curl`, `git`, …

<!-- If any tool's script is adapted from a base pack's script under a new id, say so here and
say why. It is mechanically legal and it is the first thing a reviewer asks about. -->

## What its scripts fetch

<!-- Paste the "URLs these scripts fetch" section from:
       rockysurf pack describe packs --pack <packId> --markdown
     KEEP the caveat below verbatim — CI posts the same one, and a body that sounds more certain
     than the tool is worse than no body. -->

- https://…

> This list is derived by reading the scripts and **cannot be complete** — a script that builds a
> URL from a variable will not appear above. The scripts themselves are what runs.

## Which version, and why

<!-- CONTRIBUTING's "Review" section says a maintainer will ask. One line per tool:
     - a quota-free registry (npm, PyPI via pipx) -> UNVERSIONED, no pin to bump
     - a GitHub release asset -> PINNED to a tag and checked against a sha256, and say where a
       bump comes from
     If the pack pipes an installer to a shell or cache-busts a URL, this is where the reason
     goes. -->

## How it was tested

- `rockysurf pack lint packs` — clean.
- `rockysurf pack check packs --pack <packId> --arch arm64` — passed, <date>.
- `rockysurf pack check packs --pack <packId> --arch amd64` — passed, <date>.
- `rockysurf pack index --source packs --out index.json` — regenerated and committed with the pack.
- <Installed on a real Rocky Surf box on <date>, or: not installed on a real box.>

<!-- If only one architecture ran on the contributor's machine, say WHICH and say that CI runs
     both on native runners. Do not imply two runs. -->

## Anything the checks do not cover

<!-- Honest and short. Examples: a tool that needs an API key before it does anything; a first
     run that downloads several gigabytes; a vendor URL that has moved before. "Nothing beyond
     the usual" is an acceptable answer; silence is not. -->

---

The `guide` tells the user how to authenticate everything this pack installs; every step declares
`runAs` honestly. I understand a maintainer will read the scripts before merging, because they
run as root on an operator's server.
