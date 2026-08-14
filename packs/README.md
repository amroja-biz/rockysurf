# `packs/`

Surge Packs are the software bundles a Rocky Surf server can be created with — one YAML file
per pack, PR-able by anyone. "Surge Pack" is what the product calls them; `pack`, `packId` and
this directory are the spelling in code and in the file format, and neither is going to change
to match the other.

**The authoring contract is [`docs/writing-a-pack.md`](../docs/writing-a-pack.md).** Read it
before adding a file here; it is normative, and CI enforces it. This README only says what
lives in this directory.

## The format, in brief

One pack per file, named after the pack id (`packs/rust-dev.yaml`), with three top-level keys:

```yaml
version: 1        # required; the frozen v0.1 format
pack:  { … }      # required; exactly one SurgePack
tools: [ … ]      # required; the Tool records this file introduces
```

`pack.tools` lists tool **ids**, which may be defined in this file or in any other pack file
here — that is how several packs share one `claude-code` definition. Defining the same
`toolId` twice is an error and CI rejects it.

The format is **frozen at v0.1** (ADR-0004). These files are the source of truth; the database
is a cache and edit layer.

## The four rules

Every `installScript` and `setupScript` must be **idempotent**, **`$ARCH`-aware**,
**non-interactive**, and **`runAs`-honest**. Each has a section in the contract document with
worked examples of both the right and the wrong way.

The rule that catches people out is idempotency, and the reason is worth knowing: the on-box
agent keeps a resume journal, and CI **discards that journal and runs your scripts a second
time in the same container**. A step that appends to `.bashrc` without a guard passes a
single run and fails the second one.

## What is here

Six packs, ported from the pre-open-source installation scripts and rewritten against the
contract: `ai-coding-agents` (Claude Code), `amp-agents`, `codex-cli`, `gas-town`,
`open-claw`, and `open-code`.

`ai-coding-agents.yaml` also **defines the shared base toolchain** — the compiler, Node, the
Python bits, tmux, git, the GitHub CLI and so on — that the other five reference by id. If you are adding a
pack, list those ids in your `pack.tools` rather than redefining them; the loader rejects a
`toolId` defined in two files.

That is the only thing a pack may not do with tools. **Everything else it installs, it defines
itself** — a tool is an id, a description and a script, and nothing needs registering anywhere
first. A pack introducing software this project has never heard of is the normal case, not an
exception, and it is what the community registry at
[`amroja-biz/rockysurf-shop`](https://github.com/amroja-biz/rockysurf-shop) exists for.

Every file here is validated on every test run against the same rules the contract asks of
you, including the mechanical ones: no hardcoded architectures, no `apt-get install` without
`-y`, no `sudo` inside a `runAs: rocky` script, and no unguarded append to a file.
