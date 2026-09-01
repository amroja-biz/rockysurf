# Proving one tool works

The harness runs **packs**, because a pack is what a box is built from. A tool on its own has no
pack — so wrap it in a throwaway one. Nothing in Rocky Surf changes for this; the wrapper is a
file in a temp directory that you delete afterwards.

Two loops, in this order. The first is a thousand times faster than the second and catches most
of what a first draft gets wrong.

## Loop 1 — static, no Docker

In a checkout, after every edit:

```bash
pnpm --filter @rockysurf/core exec vitest run src/packs/
```

Out of a checkout, against a directory of your own files:

```bash
npx rockysurf@latest pack lint /tmp/my-tool-check
```

Both parse the frozen schema and mechanically check what reading can check: hardcoded
architectures, `apt-get install` without `-y`, `apt-get install` without the shared `apt-updated`
stamp, `npx` without `--yes`, a privilege escalation anywhere in a `runAs: rocky` script body
(comments included), unguarded `>>` appends, cache-busted URLs, an `installOrder` outside 10–60,
and a reference to a tool that does not exist.

Failures name the tool and the script: `my-tool.installScript: expected … to contain '$ARCH'`.

## Loop 2 — the real harness, on a wrapper pack

### Build the wrapper

Your tool file declares which base tools it needs — that is the list you worked out in the
interview, and it is what the wrapper must reference. Write **two files in one directory**: your
tool as a pack file, wrapped.

```bash
mkdir -p /tmp/my-tool-check
cat > /tmp/my-tool-check/tool-check.yaml <<'YAML'
version: 1
pack:
  packId: tool-check          # must equal the filename
  name: Tool check
  displayOrder: 999
  enabled: true
  requiresRepos: false
  requiresRdp: false
  tools:
    # The base tools YOUR tool needs, referenced by id — not redefined.
    - curl
    # ...and the one under test:
    - my-tool
  guide: |
    Throwaway pack for verifying one tool. Not for installation.
tools:
  # Paste your tool here, exactly as it appears under `tools:` in your tool file. The two
  # formats share `toolSchema` verbatim, so this is a copy, never a translation.
  - toolId: my-tool
    name: My Tool
    description: One line
    category: base
    url: https://example.com
    installOrder: 40
    runAs: root
    bootstrap: false
    enabled: true
    installScript: |
      set -euo pipefail
      ...
YAML
```

**Declare the base tools honestly.** A wrapper that lists fewer than the real pack will provides
a box your tool passes on and the real one fails on — and one that lists the whole base toolchain
makes every run take twice as long for nothing. List what your script actually uses.

### Run it

```bash
npx rockysurf@latest pack check /tmp/my-tool-check --pack tool-check --arch arm64 --keep
npx rockysurf@latest pack check /tmp/my-tool-check --pack tool-check --arch amd64 --keep
```

**Do not pass `--base-packs` here.** It defaults to the packs bundled in that `rockysurf`, which
is where `curl` and the rest of the shared base toolchain are defined — and naming a directory
**replaces** that default rather than adding to it, so a stray flag turns every base reference
into "unknown tool". Pass one only when you mean to resolve against a specific checkout:
`--base-packs /path/to/rockysurf/packs`.

In a checkout you can equally use the in-tree caller, which resolves the base packs the same way:

```bash
node scripts/pack-smoke.mjs --pack tool-check --arch arm64 --keep
```

That script is a thin caller over the same CLI code; there is nothing to change in it for a
tool, and nothing about a tool that needs it changed.

### What a pass requires

Read these off the output rather than assuming:

- both runs exit `0` and reach `plan reached done`;
- `run 2: nothing was skipped as already-done` — a skip means the run proved nothing;
- `run 2: every step re-executed to done`;
- `run 2 changed nothing: .bashrc x2 and sources.list.d byte-identical` — this is the check that
  catches a duplicated `PATH` line, and the one hand-written scripts fail;
- run 2 is much faster than run 1. A run 2 that re-downloads everything exits `0` and is still a
  tool that will hurt somebody's resume; the harness prints a `warn` for it.

It prints nothing between "stock container prepared" and the end of run 1 — one to five minutes,
longer under emulation — so do not conclude it has hung. To see where it is:

```bash
docker ps --filter name=rockysurf-pack-smoke --format '{{.Names}}'
docker exec <name> cat /var/lib/rockysurf/state.json
```

The harness **exits non-zero on failure**, and piping it into `tail` or `head` hides both the
exit code and the failure dump. Redirect to a file if you must, and check `$?`.

## When it fails

The harness dumps the failing step's own log (`/var/lib/rockysurf/steps/<id>.log`) — your
script's stdout and stderr, where the answer usually is literally written.

| Symptom | What it means |
|---|---|
| `sudo: not available to install scripts on a Rocky Surf box` | Rule 4. The harness is right: split it into a root tool and a `rocky` tool |
| Run 2 fails where run 1 passed | Not idempotent. Guard the append with `grep -qF`, the installer with a stamp file or `command -v` |
| `.bashrc` not byte-identical | An unguarded `>>`. The line is now in there twice |
| `cannot execute binary file` | A hardcoded architecture in a download URL. `case` on `$ARCH` |
| Unknown tool `curl` (or another base id) | A `--base-packs` flag that replaced the bundled default. Drop it |
| A step you did not write failed | Check the step id. If it names a base tool, your tool may be fine and the problem is upstream — say so rather than editing a file that has nothing wrong with it |
| `Segmentation fault` / `qemu: uncaught target signal 11` on amd64 | Usually the emulator, on a non-x86 machine, with a large prebuilt x86 binary. Do not soften a correct script to turn it green — but do not wave a real bug through as "just the emulator" either |

**About `amd64`.** On a non-x86 machine this leg either refuses to start outright (`exec format
error`, in which case amd64 is CI's job) or runs slowly under emulation. If it runs, read its
failures: emulation reproduces genuine bugs faithfully. A tool that fails one architecture fails.

## Afterwards

```bash
docker rm -f $(docker ps -aq --filter name=rockysurf-pack-smoke)   # --keep leaves these behind
rm -rf /tmp/my-tool-check
```

The wrapper is scaffolding. **Do not import it, do not commit it, and do not offer it to the user
as a pack** — it exists to make one tool runnable by a harness that runs packs, and a pack called
`tool-check` in somebody's picker is a mess you left behind. What ships is the tool file.
