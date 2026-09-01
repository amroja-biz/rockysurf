# Extending an existing pack

Step 1E in `SKILL.md` is the workflow. This file is the worked example, the failures you will
actually hit, and the two paths Step 1E only summarizes: amending a pack you own, and extending
one outside a checkout entirely. Read it once when you are building on a pack that already
exists rather than starting from `assets/pack-template.yaml`.

## The worked example: deriving from `ai-coding-agents.yaml`

The request: "give me the Claude Code pack, plus OMP and an MCP server the agents can use to
coordinate with each other." Two tools, on top of a base that already ships.

**1. Read the base.** `packs/ai-coding-agents.yaml` — `packId: ai-coding-agents`, `displayOrder:
1`, `requiresRepos: true`, `requiresRdp: false`, no `desktop`, no `webPort`. Its `pack.tools` is
fifteen ids: `build-essential`, `curl`, `gh`, `git`, `tmux`, `unzip`, `python3-pip`,
`python3-venv`, `pipx`, `nodejs`, `playwright-deps`, `playwright`, `beads`, `beads-viewer`,
`claude-code`. Nothing about the two new tools changes any of `requiresRepos`,
`requiresRdp`, `desktop` or `webPort` — neither is a GUI app or a loopback web server — so those
flags carry over unchanged.

**2. Take a new identity.** `grep -h 'toolId:\|packId:\|displayOrder:' packs/*.yaml | sort -u`
shows `displayOrder` 1–9 taken by the nine shipped packs and no `omp` or `mcp-agent-mail` id
anywhere. `packId: omp-agent-mail`, `displayOrder: 10`.

**3. Copy `pack.tools` verbatim, then append the two new ids** — do not touch the fifteen above:

```yaml
tools:
  - build-essential
  - curl
  - gh
  - git
  - tmux
  - unzip
  - python3-pip
  - python3-venv
  - pipx
  - nodejs
  - playwright-deps
  - playwright
  - beads
  - beads-viewer
  - claude-code
  - omp
  - mcp-agent-mail
```

**4. The two added tools, looked up rather than invented.** This is the pedagogical pair the
authoring rules ask for: one on a registry (unversioned), one that is neither on a registry nor
a single pinnable binary and needs an honest script rather than a copy of the vendor's installer.

`omp` (agent, `installOrder: 40` — same band as `claude-code`, needs nothing but `curl`) ships
only as per-architecture GitHub release binaries with a published `SHA256SUMS.txt`, so it is
pinned exactly like `dolt` in `packs/gas-town.yaml`:

```yaml
  - toolId: omp
    name: omp
    description: Terminal coding agent (Oh My Pi) with LSP, DAP and subagents
    category: agent
    url: https://omp.sh
    installOrder: 40
    runAs: rocky
    bootstrap: false
    enabled: true
    installScript: |
      set -euo pipefail
      export PATH="$HOME/.local/bin:$PATH"
      # PINNED, and fetched from the release download endpoint with a published digest — the
      # same treatment `dolt` gets in packs/gas-town.yaml. To bump: change the version and both
      # digests; the release publishes SHA256SUMS.txt.
      OMP_VERSION=17.4.2
      case "$ARCH" in
        amd64) omp_asset=omp-linux-x64
               omp_sha=218a8684c2b11256b47e28ba131adfb2a03e988eddd8567bd836b7c51dd02005 ;;
        arm64) omp_asset=omp-linux-arm64
               omp_sha=a4fde8f82a6a229b815b5291dc111db4c60532cb2df8484b4ac2654116cbdbfc ;;
        *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
      esac
      # The version is IN the stamp, so bumping OMP_VERSION reinstalls and leaving it alone is a
      # no-op — the run-twice gate measures the second half of that.
      stamp="$HOME/.rockysurf/installed-omp-$OMP_VERSION"
      if [ ! -f "$stamp" ]; then
        tmp=$(mktemp)
        curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors \
          "https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}/${omp_asset}" -o "$tmp"
        echo "$omp_sha  $tmp" | sha256sum -c - >/dev/null
        install -D -m 0755 "$tmp" "$HOME/.local/bin/omp"
        rm -f "$tmp"
        mkdir -p "$(dirname "$stamp")" && touch "$stamp"
      fi
      touch "$HOME/.bashrc"
      grep -qF "$HOME/.local/bin" "$HOME/.bashrc" || echo "export PATH=\"$HOME/.local/bin:\$PATH\"" >> "$HOME/.bashrc"
      "$HOME/.local/bin/omp" --version >/dev/null
```

`mcp-agent-mail` (base, `installOrder: 30` — needs `python3-venv`, same tier as `beads` needing
`curl`) ships on PyPI, a quota-free registry, so per the version rule it installs
**unversioned** — but its `pyproject.toml` publishes no `[project.scripts]` entry, so `pipx
install` would create an app-less venv with nothing to expose. It installs cleanly into its own
venv instead, which is also what Ubuntu 24.04's system Python demands: a bare `pip install`
outside a venv is refused with `externally-managed-environment` (PEP 668), so `python3-venv` —
already in the base toolchain — does the job:

```yaml
  - toolId: mcp-agent-mail
    name: MCP Agent Mail
    description: Coordination server giving multiple AI coding agents shared inboxes and file leases
    category: base
    url: https://mcpagentmail.com
    installOrder: 30
    runAs: rocky
    bootstrap: false
    enabled: true
    installScript: |
      set -euo pipefail
      # UNPINNED (deliberate): PyPI is a quota-free registry channel, so this follows the same
      # rule the base pack's own registry-served tools do. pip install is convergent — reruns
      # either do nothing or upgrade in place, the same pattern `packs/open-code.yaml`'s own
      # `npm install -g` uses for its unpinned agent.
      #
      # Ubuntu 24.04's system Python refuses `pip install` outside a venv (PEP 668,
      # "externally-managed-environment") — python3-venv is already in the base toolchain for
      # exactly this. No console-script entry point is published upstream either (its
      # pyproject.toml has no [project.scripts] section), so there is no binary a venv's bin/
      # would need on PATH — the module is imported directly instead. The upstream curl|bash
      # installer also clones the repo and starts a long-lived HTTP server; that does not
      # belong in a one-shot bootstrap script, so this installs the module only. `guide`
      # covers running it.
      venv="$HOME/.local/share/mcp-agent-mail-venv"
      [ -d "$venv" ] || python3 -m venv "$venv"
      "$venv/bin/pip" install --quiet --upgrade pip mcp-agent-mail
      "$venv/bin/python" -c "import mcp_agent_mail"
```

**5. `installOrder`: 30 and 40 are gaps, not the base's own values.** Nothing under
`ai-coding-agents.yaml`'s fifteen tools was renumbered.

**6. `guide`: append, don't replace.** Everything in the base pack's guide is still true, so it
stays; two new blocks go after it:

```
    OMP
      omp                      first run walks you through provider/model setup
      omp --help

    MCP Agent Mail
      Installed into its own venv (no CLI entry point ships upstream), so run it via:
        ~/.local/share/mcp-agent-mail-venv/bin/python -m mcp_agent_mail.cli serve-http --port 8765
      Web UI: http://127.0.0.1:8765/mail — binds to localhost only; reach it over a tunnel:
        ssh -L 8765:localhost:8765 rocky@<box>
      Point omp, Claude Code, or any other MCP-aware agent on this box at that endpoint so
      they can see each other's inboxes and file leases.
```

**7. The guardrail.** `git status --porcelain packs/` after writing `packs/omp-agent-mail.yaml`
shows exactly that one new file — `packs/ai-coding-agents.yaml` is untouched. Then Step 3 and
Step 4 run on `omp-agent-mail` exactly as they would on a from-scratch pack.

## Symptom → cause → fix

| Symptom | Cause | Fix |
|---|---|---|
| `toolId "X" is already defined in <base>.yaml` | you copied a tool's definition instead of just referencing its id | delete the definition from your file, keep the id in `pack.tools` |
| `pack "Y" references unknown tool "X"` | a typo in the id, or the base file failed to parse | check the base file parses on its own first — a broken base cascades into every pack that references it |
| `[duplicate-tool]` from `pack lint` | same root cause as the first row, caught out-of-tree | same fix |
| import says `Tools not found: …` | the target instance does not ship the base pack you derived from | define the missing tools yourself under namespaced ids, or import the base pack first |
| smoke run 2 says `.bashrc` changed | your added tool's install script appends to `.bashrc` without a guard | guard it with `grep -qF`, the idiom in `references/idioms.md` |
| derived pack passes lint but the picker is empty after a restart | the base file got edited too and something in it broke | `git status packs/` — a derive modifies nothing; if it shows the base as modified, you amended by accident |

## The amend path

Amending changes the base file itself, so it is right only when the base pack is yours and every
existing user of it should get the new tool too. Add the tool's definition under `tools:` and its
id to `pack.tools` in the base file — same four authoring rules, same `installOrder` bands as any
other tool — then re-run Step 3 and Step 4 **on the amended pack**, not a derived one.

**If the file is `packs/ai-coding-agents.yaml`, this is the shared base toolchain for every pack
in the repository.** A validation failure in it is not contained to one pack — a pack file that
fails to parse is skipped entirely at boot, and because every other pack references its tool ids,
that takes all of them out of the picker until the file is fixed. Re-smoke everything after an
amend to this file: `node scripts/pack-smoke.mjs` with no `--pack` argument runs the whole
matrix, not just the one pack you touched.

On a running instance, a file-backed pack is only read at boot — there is no watcher — so an
amend needs a restart to take effect. An imported pack (a database row, not a file) is edited
through the admin UI or by re-importing the updated file.

## Extending without a checkout

The derived file above is also what you would hand to `pack import` on someone's own running
instance — import resolves tool ids that already exist on that instance the same way the
in-tree loader does. Three things differ from working inside the repository:

- **Verify with the published CLI, not the repo scripts:**
  `npx rockysurf pack lint <dir>` and `npx rockysurf pack check <dir> --pack <id> --arch arm64`.
  `--base-packs` defaults to the packs bundled in that installed `rockysurf` version, so a pack
  that only references base ids resolves with no flag at all.
- **The packId-matches-filename rule is dropped on import** — the repository's loader enforces
  it, the import path does not.
- **Do not use Export as a "fork this pack" button.** Export inlines every tool the pack
  references, including the ones it only pointed at — so exporting `omp-agent-mail` would embed
  full copies of all fifteen base tools too. Importing that back in redefines every one of those
  ids, which the in-tree loader rejects outright and which, on another instance, silently
  overwrites its shipped tool rows. Deriving by hand from the base pack's `pack.tools` list, the
  way this file just did, is the supported way to fork a pack; Export is for handing someone a
  pack's complete, self-contained bundle, not for basing a new one on it.

## What v0.1 deliberately does not have

No `extends:` key or any other inheritance field in the schema — the format is frozen at v0.1
(ADR-0004), and referencing tool ids across files already buys everything an `extends:` key
would, at no format cost. No tool library owned by no pack, either: every tool still belongs to
exactly one pack file. That gap is real but out of scope here — it is filed as `rockysurf-37pa`
for v0.2. Don't re-propose either one against this file; propose it against that issue instead.
