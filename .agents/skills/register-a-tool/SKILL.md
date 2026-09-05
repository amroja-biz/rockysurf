---
name: register-a-tool
description: Register ONE tool in a Rocky Surf installation's personal tools registry and share it as a tool file. Use when someone wants to add, register, package or share a single tool, CLI, runtime or agent rather than a whole box — "register my linter with Rocky Surf", "add fd to my tools", "turn this install script into a Rocky Surf tool", "export my tool so a colleague can use it", "import the tool file someone sent me", "what is a tool file", "why won't my tool import" — or is working with the Tools page, the tool YAML format, or `/api/v1/admin/tools`. Covers the interview, writing the install script against the four authoring rules, proving it in the real Docker harness, registering it, and exporting or importing it. NOT for authoring a whole Surge Pack — a pack is a bundle of tools plus the behaviour flags a box needs, and `create-surge-pack` owns that; come here for one tool that several packs will reuse, go there for "I want a box with X on it".
---

# Register a tool

A **tool** is one installable thing: a name, a home page, an install script, and whether it runs
as root or as `rocky`. A **Surge Pack** is a bundle of tools plus the flags a box needs. This
skill is about the first, on its own.

Two things make that worth its own skill. A tool can be reused by many packs — the shipped packs
already share a base toolchain this way — and since issue #289 a tool can be exported as a **tool
file**, a small YAML anyone can send to anyone. That is the unit people actually trade: "here is
how I install my linter."

**A tool reaches a box only through a pack** (owner ruling, issue #295). There is no per-tool
deploy button and none is coming. Registering a tool makes it available to put in a pack;
step 5 is where that happens, and skipping it means the tool exists and installs nowhere.

## Prerequisites

What has to be on **the user's own computer**. Check before step 3, and if one is missing, tell the
user which and where it comes from — **do not install it for them**.

| Tool | Why this skill needs it | Check |
|---|---|---|
| Node.js 24+ | step 4's harness is a Node program, and out of a checkout `npx rockysurf@latest` is the whole toolchain; `engines.node` is `>=24` | `node --version` |
| Docker | step 4 runs the tool in a real `ubuntu:24.04` container; nothing else proves the script works | `docker version` (a **Server** version, not just a client) |
| Git and pnpm | only for the in-checkout route: `pnpm install && pnpm -r build`, then the loader test | `git --version`, `pnpm --version` |

Install pages for macOS and Ubuntu, and what to say when one is missing, are in
[`create-surge-pack`'s prerequisites](../create-surge-pack/references/prerequisites.md). The `npx`
route needs network access the first time — it downloads the Rocky Surf CLI itself, nothing else.

The `apt-get install` and `npm -g` lines in the tool's own `installScript` run on the Rocky Surf
server, not here. They are not a prerequisite for anything.

## Route first

| The user wants | Go |
|---|---|
| a box with a set of tools on it | **`create-surge-pack`**, not this skill |
| one tool, reusable across packs, or shareable as a file | here |
| a tool somebody sent them, installed into their instance | here, step 6 (Import) |
| to change a tool that came from `packs/*.yaml` | `create-surge-pack` — that file owns it, and the next boot rewrites the row |

If they want both — a new tool AND a pack built around it — do this skill first and hand the
finished `toolId` to `create-surge-pack`. That order avoids writing the tool twice.

## What this skill does not repeat

The authoring contract for an install script is the same one pack tools obey, and it lives in
one place. Read it there rather than trusting a summary:

- **The four rules** (idempotent, `$ARCH`-aware, non-interactive, `runAs`-honest), with worked
  right-and-wrong pairs: [`docs/writing-a-pack.md`](../../../docs/writing-a-pack.md) § The four rules.
- **Copyable shell** for apt, apt repositories, pinned release binaries, per-user installers and
  PATH, each with the failure it prevents:
  [`../create-surge-pack/references/idioms.md`](../create-surge-pack/references/idioms.md).
- **Which version to install** — registry-served unversioned, GitHub-release pinned with a
  `sha256`: [`docs/writing-a-pack.md`](../../../docs/writing-a-pack.md) § Which version to install.
- **The base toolchain and what depends on what** — before you write an install script, check
  whether the tool already exists: [`../create-surge-pack/SKILL.md`](../create-surge-pack/SKILL.md)
  § What you get for free.

This skill covers only what is different about a single tool: the interview, the tool file
format, verification without a pack of your own, and registering, exporting and importing.

## Step 1 — Interview

Four questions decide the file. Infer what you reasonably can; ask the rest.

- **What is it, and how does it install on Ubuntu 24.04?** apt, `npm -g`, `pipx`, a release
  tarball, an upstream `install.sh`. Get its home page URL — the format requires one.
- **Whose software is it?** A system package is root's; a per-user CLI living in `$HOME` is
  `rocky`'s. **If it is both, it is two tools**, not one script with a privilege escalation in
  it. That is rule 4, and it is the most common reason a first draft fails.
- **Does anything already installed do this?** `grep -h 'toolId:' packs/*.yaml | sort -u` in a
  checkout, or the Tools page in a running instance. A `toolId` must be unique across the whole
  installation, and half of what people ask for already exists.
- **Where does it come from — a registry or a GitHub release?** That answers the version
  question for you by the rule linked above. Do not invent a third policy.

**Do not ask for credentials, and do not accept one if offered.** No API key, licence key or
token belongs in a tool's install script — the script is stored in the database, rendered into
install plans, and shown verbatim by `pack describe` to anyone who can read the pack. A value
only the user has is declared by the PACK as an `input` (ADR-0013) and arrives as an environment
variable. Say so, and write the script to read `$THE_NAME` rather than to contain a secret.

## Step 2 — Write the tool file

Copy [`assets/tool-template.yaml`](assets/tool-template.yaml) and fill it in. The whole format:

```yaml
version: 1
tools:
  - toolId: my-tool          # unique across the installation; lowercase, single hyphens
    name: My Tool
    description: One line, shown next to the name in the UI
    category: base           # 'agent' for an AI coding agent, 'base' for anything else
    url: https://example.com # the tool's home page
    installOrder: 40         # 10 apt · 20 runtimes · 30 needs a runtime · 40 agents · 50 needs an agent
    runAs: root              # or 'rocky' for a per-user install in $HOME
    bootstrap: false         # always false — see below
    enabled: true
    installScript: |
      set -euo pipefail
      ...
    # setupScript: |         # optional, per-server, runs after every installScript
```

Every field is required except `setupScript`. There is no `pack:` key — that is the other
format, and pasting a pack file here is answered with a message telling you which door to use.

Three things the format will refuse, rather than warn about:

- **`bootstrap: true`** is reserved for the steps the runtime guarantees before any plan runs.
  It is in the format only so a tool moves between a pack file and a tool file unchanged.
- **Any key not in the list above.** The schema is strict, so a field invented here — or one
  borrowed from a newer version — is a loud error on import rather than a promise silently
  dropped.
- **`sourceFile`.** That is one installation's fact about its own disk, and export strips it.

`installOrder` is **ordering, not dependency**. Equal values break ties by `toolId`, which is a
determinism guarantee so an interrupted install resumes against the same plan. If your tool needs
`curl`, either give it a higher `installOrder` and accept that ordering is all you get, or
install `curl` yourself — which is what the shipped `gh` tool does, for exactly this reason.

Close the script with the command that proves the install worked, checking **the name the user
will type**: `apt-get install -y fd-find` gives them `fdfind`, and a script verifying `fd` passes
while the binary they want does not exist.

## Step 3 — Validate, in about two seconds

In a checkout, after every edit:

```bash
pnpm --filter @rockysurf/core exec vitest run src/packs/
```

That parses the frozen schema and mechanically checks what is checkable by reading: hardcoded
architectures, `apt-get install` without `-y` or without the shared `apt-updated` stamp, `npx`
without `--yes`, a privilege escalation inside a `runAs: rocky` script (the whole body, comments
included), unguarded `>>` appends, cache-busted URLs, and an `installOrder` outside 10–60.

It does **not** catch whether your script works, or whether it is genuinely idempotent. That is
step 4, and `grep -q` present is not `grep -q` correct.

## Step 4 — Prove it in the real harness

A tool has no pack of its own, and the harness runs packs — so wrap it in a throwaway one. This
uses the shipped CLI and needs no change to Rocky Surf.
[`references/verifying.md`](references/verifying.md) has the generated wrapper, the base-tool
declaration it is built from, and how to read a failure.

The short version: the harness starts a stock `ubuntu:24.04`, runs your plan through the real
bootstrap agent, **discards the resume journal and runs the whole thing again in the same
container**, and requires the second run to change nothing. That second run is the entire point —
it is what catches the duplicated `PATH` line and the installer that refuses to run twice, and it
is what hand-written scripts fail.

Report what actually ran: which architectures, what failed, and whose it is. A tool that fails
one architecture fails.

## Step 5 — Register it, and put it in a pack

Registering makes the tool exist. A pack is what puts it on a box.

- **In a running instance:** Tools → **New tool**, or **Import a tool file** for one you were
  sent. It lands under **Personal** — a database row the next restart will not touch. Then open
  Surge Packs → Personal and either add it to a pack you own, or use **New Surge Pack → start
  from an existing pack** to derive one that includes it. Modifying an official pack is
  [issue #295](https://github.com/amroja-biz/rockysurf/issues/295), not something to hand-roll.
- **In a checkout, contributing it:** the tool belongs in a `packs/*.yaml` file, defined once and
  referenced by id from every pack that wants it. That is `create-surge-pack`'s Step 1E, and a
  pull request there gets it smoke-tested on both architectures by CI forever.

**Personal means "registered on this installation", not "belongs to one user".** Everyone who
runs an installation is its admin ([issue #192](https://github.com/amroja-biz/rockysurf/issues/192));
there is no per-user registry and no per-user visibility to design around.

## Step 6 — Share it

**Export** (any row on the Tools page) downloads `<toolId>.yaml`. It is the tool and nothing
else — no pack, no provenance, no installation-specific state — so it can be mailed, committed
or pasted into an issue.

**Import** takes that file back, on any installation. What it will refuse:

| Symptom | Meaning |
|---|---|
| `this is a pack file, not a tool file` | Right file, wrong door — Surge Packs → Import |
| `Cannot replace tools that come from a pack file` | The id belongs to a shipped tool. Rename yours (`acme-<id>`); overwriting it would be undone at the next restart anyway |
| `reserved for the tools the runtime guarantees` | `bootstrap: true`. Set it to `false` |
| An unrecognised key | The strict schema, doing its job. Delete the key |

Importing a tool whose id already exists as a **personal** row replaces it — that is what
re-importing an edit means, and it is deliberate.

**Import from a URL** works too (ADR-0022, issue #299): give the Tools page an `https://…/tool.yaml`
address and the control plane fetches it through the SSRF guard and records where it came from —
the URL, the digest, and `trust: unverified`. A pasted or uploaded file records nothing, because
there is nothing true to record. (Originally withheld from tools until the `tools` table had the
provenance columns to hold that answer; issue #299 added them.)

Finally, tell the user what was actually proven — which architectures ran, what CI will still
check, and what the tool still needs a human to do (nearly every CLI needs a login, and no
credential of theirs reaches the box during bootstrap).

## Reference files

- [`references/verifying.md`](references/verifying.md) — the wrapper-pack recipe, running the
  real harness against one tool, and a failure-to-fix map. Read it at step 4.
- [`references/sharing.md`](references/sharing.md) — the tool file format field by field, what
  export strips and why, the import refusals in full, and when a tool belongs in a pull request
  instead. Read it at step 6, or when an import is being refused.
- [`assets/tool-template.yaml`](assets/tool-template.yaml) — a commented skeleton to copy.
