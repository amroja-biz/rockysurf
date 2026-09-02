# The tool file, and where a tool should live

## The format

A tool file is `version: 1` and a list of tools. That is all of it.

```yaml
version: 1
tools:
  - toolId: my-tool
    ...
```

| Field | Required | What it is |
|---|---|---|
| `toolId` | yes | Unique across the installation. Lowercase, single hyphens. This is the id packs reference |
| `name` | yes | Display name |
| `description` | yes | One line, shown beside the name |
| `category` | yes | `agent` for an AI coding agent, `base` for everything else |
| `url` | yes | The tool's home page, so a person can see what they are installing |
| `installScript` | yes | Root-privileged (or `rocky`) shell, run once per box |
| `setupScript` | no | Per-server configuration, run after every tool's `installScript`, same `runAs`. Where `$REPOS` work belongs |
| `enabled` | yes | A disabled tool is skipped when a plan renders |
| `installOrder` | yes | 10–60. Ordering, **not** dependency; ties break by `toolId` |
| `bootstrap` | yes | Always `false` — see below |
| `runAs` | yes | `root` or `rocky` |

The list is closed. The schema is **strict**, so anything else — a field from a newer version, a
key you invented, a `pack:` from the other format — is an error on import rather than a value
quietly dropped. That is deliberate: a dropped key is a promise the file made and the
installation did not keep.

### Why `bootstrap` is in a format that forbids `true`

`toolSchema` is shared verbatim between pack files and tool files, so a tool moves between them
as a copy rather than a translation — no field mapping to drift, no second spelling of the same
entity. `bootstrap` is part of that shared shape. But the steps it marks are the ones the runtime
guarantees before any plan runs; they are not something a person imports. So the field travels
and `true` is refused.

### What export strips

`sourceFile` — which `packs/*.yaml` a row was loaded from. It is one installation's fact about
its own disk, it means nothing anywhere else, and the strict schema rejects a file carrying it.
Nothing else is removed: the exported tool is the tool.

There is no provenance recorded in a tool file, and none is faked. A file cannot say where it
has been.

## Import refusals

| Message | Meaning | Fix |
|---|---|---|
| `this is a pack file, not a tool file` | Right file, wrong door | Surge Packs → Import |
| `Cannot replace tools that come from a pack file` | The id belongs to a tool loaded from `packs/*.yaml` | Rename yours, e.g. `acme-<id>` |
| `reserved for the tools the runtime guarantees` | `bootstrap: true` | Set it to `false` |
| `Unrecognized key: "…"` | The strict schema | Delete the key |
| `a tool file with no tools shares nothing` | Empty list | Put a tool in it |
| `not valid YAML: …` | Malformed | Usually an unquoted `:` or bad block scalar indentation |

An import whose id matches an existing **personal** row replaces it. That is what re-importing an
edit means, and it is intended — the previous version is gone, so keep the file.

### Why the file-backed refusal is a refusal and not an overwrite

A row with a `sourceFile` belongs to the boot reconcile: the next restart rewrites it from disk
(ADR-0004). An import allowed to win there would appear to work and then silently revert, which
is worse than being told no. The 409 names the tool.

## Import from a URL

Both formats have this now (ADR-0022, issue #299; ADR-0018 originally withheld it from tools).

Give the Tools page an `https://…/tool.yaml` address and the control plane — never your browser —
fetches it through the same SSRF guard the pack import uses, then records where it came from on
the row: the URL, the sha256 of the exact bytes accepted, and a `trust` of `unverified` (a one-off
URL has no operator-written trust label to borrow, and there is no tool registry to borrow one
from). The Tools page shows that origin, so "where did this root-privileged shell come from" has a
true answer — which is what issue #88 asked for, and what the `tools` table could not answer until
issue #299 added the provenance columns.

A tool that arrives by **paste or upload records nothing**, because there is nothing true to
record: the bytes came from your own machine. And the file itself still carries no provenance in
either case — an exported tool file names no origin, so the record is the importing installation's,
not the file's.

## Where a tool should actually live

Three homes, and they are not equivalent.

**A personal row, imported or typed in.** Yours, immediately, on one installation. Never
overwritten by boot, never restored by it either — if the database goes, the tool goes. Right for
something you are still working on, or that is nobody else's business.

**A `packs/*.yaml` file in your own deployment.** Loaded at boot only, so it needs a restart —
there is no watcher. Source-controlled if that directory is. The trap: a pack file that fails
validation is skipped, and because tool definitions are shared across files, breaking one takes
every pack that references its tools out of the picker until it is fixed.

**A pull request against `packs/` upstream.** The only home that gets the tool smoke-tested on
both architectures by CI forever, and the only one where other people get it without doing
anything. This is what `create-surge-pack` Step 1E covers. If the tool is generally useful, say
so to the user — a tool file mailed around is a fine way to start and a poor way to maintain.

**Do not use Export as a "fork this" button on a pack.** Pack export inlines every referenced
tool, so re-importing its output redefines the shared base ids — which the loader rejects in-tree
and which overwrites the shipped tool rows instance-wide on import. To build on a pack, derive
from it (New Surge Pack → start from an existing pack). To share one tool, export the tool.
