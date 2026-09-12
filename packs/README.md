# `packs/`

Surge Packs are the software bundles a Rocky Surf Server can be created with — one YAML file
per pack, PR-able by anyone. "Surge Pack" is what the product calls them; `pack`, `packId` and
this directory are the spelling in code and in the file format, and neither is going to change
to match the other.

**The authoring contract is [`docs/surge-pack-contract.md`](../docs/surge-pack-contract.md), and
[`docs/writing-a-surge-pack.md`](../docs/writing-a-surge-pack.md) is the guide to it.** Read them
before adding a file here; it is normative, and CI enforces it. This README only says what
lives in this directory.

## The format, in brief

One pack per file, named after the pack id (`packs/rust-dev.yaml`), with three top-level keys:

```yaml
version: 1        # required; the frozen v0.1 format
pack:  { … }      # required; exactly one SurgePack
tools: [ … ]      # required; the Tool records this file introduces
```

`pack.tools` lists Tool **ids**, which may be defined in this file or in any other file
here — that is how several packs share one `claude-code` definition. Defining the same
`toolId` twice is an error and CI rejects it.

One file here is not a pack. `base.yaml` is a **Tool file** (ADR-0018) — `version: 1` and a
`tools:` list, no `pack:` block — and it holds the shared base toolchain everything else
references. Any file in this directory with no `pack:` block is read that way: definitions, no
pack, no card in the picker, no image.

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

`claude-code`, `amp-agents`, `codex-cli`, `gas-town`, `open-claw`, and
`open-code` were ported from the pre-open-source installation scripts and rewritten against
the contract. `grok-build`, `cursor-cli`, `deepseek-harness`, `omp`, `pi` and `all-agents` have
shipped since.

`all-agents` is the second file here that **defines no Tool at all**: like `gas-town` it is a
list of ids other files own — every shipped terminal agent, plus each one's herdr integration —
for the case of one box holding several agents at once.

`base.yaml` **defines the shared base toolchain** — the compiler, Node, the Python bits, tmux,
git, the GitHub CLI, herdr and so on — that every pack references by id. If you are adding a pack, list
those ids in your `pack.tools` rather than redefining them; the loader rejects a `toolId` defined
in two files. Those definitions lived in `claude-code.yaml` until issue #499 moved them out: a
file that fails to parse is skipped at boot, so while they lived in a pack's file, one typo
there left every other pack referencing ids that no longer existed and the picker came up
empty.

That is the only thing a pack may not do with Tools. **Everything else it installs, it defines
itself** — a Tool is an id, a description and a script, and nothing needs registering anywhere
first. A pack introducing software this project has never heard of is the normal case, not an
exception, and it is what the community registry at
[`amroja-biz/rockysurf-shop`](https://github.com/amroja-biz/rockysurf-shop) exists for.

Every file here is validated on every test run against the same rules the contract asks of
you, including the mechanical ones: no hardcoded architectures, no `apt-get install` without
`-y`, no `sudo` inside a `runAs: rocky` script, and no unguarded append to a file.
