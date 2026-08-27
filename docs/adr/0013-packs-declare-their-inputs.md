# ADR-0013: A pack declares the values it needs; they reach every step as environment variables

## Status

Accepted — 2026-08-27. Issue #189. Extends [ADR-0004](0004-packs-as-pr-able-yaml.md)'s frozen
v0.1 pack format with one optional field, and amends the closed `secrets.env` key-name contract
that [ADR-0002](0002-push-bootstrap-default-callback-fallback.md)'s bootstrap established — not by
adding a name to it, but by putting a second, pack-owned namespace beside it.

## Context

A pack can need a value from the user before its install scripts run. The motivating case is a
custom pack that installs [Headlong](https://github.com/HumanCompatibleAI/headlong), which assumes
Docker and installs headless only when several environment variables are set before its installer
executes.

Today there is no way to hand a pack's install step a user-supplied value at all.
`docs/writing-a-pack.md` promises exactly two names — `$GITHUB_TOKEN` and `$RDP_PASSWORD` — and
says the list is closed on purpose; the env table's row "your tool's secrets — whatever the user
supplied" had nothing whatsoever behind it. A pack author reading that document was told a
mechanism existed that did not.

Four facts about this codebase shaped the answer.

1. **`secrets.env` already delivers a per-server environment to every step.** `bootstrap/push.ts`
   writes it at `0600` in the call that creates it; `agent.sh` sources it with `set -a` so root
   steps inherit it, and re-reads it line by line to build the explicit `env` list a `sudo -u
   rocky` step receives. Nothing on the box needed to change.
2. **Pack behaviour is described by the pack** (ADR-0004). `requiresRepos`, `requiresRdp`,
   `desktop` and `webPort` exist precisely so the application never compares a `packId` — the
   rule that replaced the old `packId === 'open-claw'` hardcode in the create form.
3. **The plan is not a private document.** `plan.json` is pushed at `0644`, snapshotted on the
   server row, and quoted in failure reports. Anything that must not be casually readable cannot
   go in it.
4. **`secrets.env` is shell source, and its values were all shapes core controlled.** A GitHub
   PAT, a desktop password, and a `host/owner/repo` scope whose character class
   `config/schema.ts` restricts *specifically* so the file stays sourceable. None of them can
   contain a space, and so nothing was ever quoted.

A "pre-install user script" — a second slot beside [ADR-0011](0011-user-script-at-create-time.md)'s
— cannot solve this: every plan step runs in its own process, so an `export` in an earlier step
never reaches a later one.

## Decision

**1. `inputs` is an optional list on the pack, in the pack's own file.**

```yaml
pack:
  inputs:
    - name: HEADLONG_HEADLESS        # ^[A-Z][A-Z0-9_]*$ — the env var the install script reads
      label: Headless install
      description: Install without Docker. Set to 1 on a box with no Docker.
      required: true
      default: "1"
    - name: HEADLONG_API_KEY
      label: Headlong API key
      secret: true
```

`required` and `secret` default to `false` in the file and are present in the parsed object — the
same treatment `requiresRepos` gets, and for the same reason. At most 16 entries; at most 4 KiB
per value.

**2. Pack-level, not tool-level.** The declaration exists so a form can ask, and the thing a user
picks on that form is a pack. A tool-level list would have to be flattened into one form section
anyway (a tool the pack references from another file contributes its inputs too), two tools naming
one variable would need a precedence rule nobody asked for, and the delivery is pack-wide
regardless: `secrets.env` is one file read by every step of every tool on the box. Declaring at
the level the value is actually scoped to is the honest shape.

**3. Names that collide with Rocky Surf's own are refused at pack validation.**
`RESERVED_INPUT_NAMES` covers the agent's environment (`ARCH`, `DEBIAN_FRONTEND`, `HOME`, `USER`,
`LOGNAME`), the `secrets.env` contract (`GITHUB_TOKEN`, `RDP_PASSWORD`), the setup preamble
(`REPOS`), and the shell's own (`PATH`, `IFS`, `LD_PRELOAD`, …). `ROCKYSURF_` and `GIT_` are
refused as whole prefixes, because both are indexed (`ROCKYSURF_GITHUB_TOKEN_<n>`,
`GIT_CONFIG_KEY_<n>`) and no exact-name list could close them. A test pins
`SECRET_ENV_KEY_NAMES` as a subset of the reserved list, so a future name added to the
`secrets.env` contract cannot quietly become claimable.

**4. The two lists are two different promises, and the document says so.** Rocky Surf's names are
a platform commitment: closed, permanent, and true on every box. A pack's `inputs` are the pack
author's own namespace — they chose the names, they document them, and the names exist only on
boxes built from that pack. `writing-a-pack.md`'s "closed list" paragraph is amended to say
exactly that rather than deleted: the platform still promises two names and only two.

**5. Where the answers live at rest, split by what the pack declared.**

| | non-secret | `secret: true` |
|---|---|---|
| at rest | `servers.pack_inputs`, a JSON column | encrypted store, kind `pack-inputs`, one row per server |
| `GET /servers/:id`, `GET /servers` | returned | **never**, by any route |
| plan snapshot (`plan.json`, `installPlan`) | **never** | **never** |

Non-secret values go on the row so that re-rendering a plan months later produces the same
environment and the detail page can answer "what was this box built with". Secret ones go beside
the desktop password, under the same custody rule (`secrets/route-inventory.test.ts`), which keeps
its single exemption. The split is decided once, at the create route, because only the pack's
declaration knows which name is which.

**6. Values are never rendered into the plan, so `PLAN_VERSION` stays 1.** They travel in
`secrets.env`. No step, field or step id changed, and no agent has to understand anything new: the
delivery channel is the one the agent has always read.

**7. The create route validates against the declaration, before the provider is called.** Unknown
name → 400 (refused, not ignored: ignoring one puts a value the caller believes is on the box
nowhere at all, and the failure surfaces as an install script reading an empty variable). Missing
`required` with no `default` → 400. Oversized, or containing a newline → 400. A declared `default`
is applied when the request omits the name; an optional input nobody answered is **omitted
entirely**, never sent as the empty string — the rule `RDP_PASSWORD` has always had, because an
empty value satisfies a naive `-z` guard and defeats a script's own `${FOO:-}`.

**8. Every `secrets.env` value is now single-quoted.** Fact 4 above stopped being true the moment
a value came from a form field. Unquoted, `FOO=a b` runs `b` as a command; a value containing
`$(…)` or a backtick executes on the box as root. Single quotes are the only bash form with no
escape sequences inside them, so this is a total escape rather than a filter. What quoting cannot
fix is a newline — the agent re-reads the file line by line to learn the variable NAMES, so a
second line would become a second name — hence the single-line rule in point 7.

**9. A pack whose declaration changes after a server exists changes nothing about that server.**
Stored values win. A newly-required input is simply absent, because nobody was ever asked for it,
and the pack's own step fails with its own message rather than core inventing a value. A removed
input keeps its value on the row harmlessly. Only new servers are asked the new questions.

**10. What a user is told, and when.** The create form renders a field per entry with the pack's
label and description, a password field for a `secret` one; the pack card carries a count; and the
**pre-install disclosure lists every name and label**, marking required and secret ones. That last
placement is the point: a pack that wants an API key is asking you to put a credential on a box you
have not consented to installing yet, so it belongs beside "how many steps run as root", not on the
form you reach only after saying yes. No value appears in either place, not even a declared
default.

**11. The CLI takes `--input NAME=VALUE` (repeatable), `--inputs-file <path>` (dotenv) and
`ROCKYSURF_INPUT_<NAME>`,** merged least-to-most-specific in that order, checked with core's own
`resolvePackInputs` before the POST. A value for a `secret` input given as `--input` is refused
outright, on the ruling `--rdp-password <value>` already carries: by the time a warning could
print, the value is in the shell's history file and has been readable in `ps`.

## Considered options

**A. Pack-level `inputs` (chosen).** One section on the form, one namespace per pack, and the
declaration sits at the level the delivery is actually scoped to.

**B. Tool-level `inputs`.** Rejected. It reads as tidier — the tool that needs the value declares
it — and is not: the values still reach every step on the box, so the declaration would describe a
scoping that does not exist. It also needs a collision rule for two tools naming one variable, and
a flattening rule for a tool referenced from another pack's file. The form would look identical
after all that work.

**C. A free-form `env: { NAME: value }` on the create request, with no declaration.** Rejected —
this is the shape that needs no pack format change at all, and it is the wrong one. Nothing could
render a form (the app would have no idea what to ask), nothing could mark a value secret, nothing
could refuse a typo, and a pack author would be reasoning about an environment anybody could put
anything into. The declaration is what makes the rest possible.

**D. A second "pre-install" user-script slot.** Rejected in the issue itself: every plan step runs
in its own process, so an `export` in one never reaches another.

**E. Rendering values into the plan as `export` lines, like `$REPOS`.** Rejected. `$REPOS` is a
list of URLs the user typed and the plan is already stored in the clear; an API key is not, and
`plan.json` is `0644` and quoted in failure reports. Delivering half the values one way and half
the other would also give a pack author two mechanisms to reason about.

**F. Storing every value in the encrypted store, secret or not.** Rejected. It costs the detail
page its answer to "what is this box configured with" and the plan re-render its stability, buys
nothing for a value the user is looking at in a text field, and makes the store the sole authority
for data whose whole purpose is to be displayed.

**G. Restricting values to a shell-safe character class instead of quoting.** Rejected. It would
have been the smaller diff and it refuses values people legitimately have — an endpoint with a
query string, a model name with a space, a passphrase. Quoting is correct for all of them, and
correct for the existing values too.

**H. Adding the input names to `SECRET_ENV_KEYS`.** Rejected. That table is a platform promise;
`HEADLONG_API_KEY` is a promise Rocky Surf cannot keep, because the pack that defines it can be
uninstalled. Two lists, two kinds of promise, stated as such.

## Consequences

- A pack can finally ask for something, and the env table's empty row is real.
- One more optional field in the frozen v0.1 format. Every existing pack file is unchanged and
  still valid; `inputs` absent means the pack asks for nothing, which is every pack shipped today.
- One migration, two nullable columns (`packs.inputs`, `servers.pack_inputs`) and one new secret
  kind (`pack-inputs`).
- `secrets.env` lines now read `KEY='value'`. The agent's name parsing is unaffected (the name is
  still everything before the first `=`), and a real bash sourcing the real writer's output is
  asserted in the suite.
- The custody rule gains a plaintext accessor (`getPackInputSecrets`) and no new exemption.
- A pack can now put a variable in front of a user's own startup script (ADR-0011) that the user
  did not write. That is intentional — the script runs on a box the pack built — and it is why
  reserved names are refused: a pack cannot shadow anything the platform or git relies on.
- `PLAN_VERSION` is untouched, so no agent, no snapshot and no resume changes.

## Deliberately unresolved

- **No per-input validation beyond size and one line.** A pack cannot say "this must be a URL" or
  "one of these three values". The pack's own script is a better judge than a regex in a YAML
  file, and a bad value fails at its step with the pack's own message. Revisit only if real packs
  are seen hand-rolling it.
- **No editing a server's inputs after create.** There is no re-push, so a changed value would not
  reach a running box; a field that looked editable and did nothing would be worse than no field.
- **The admin pack editor has no `inputs` control.** The PUT preserves what is there when none is
  sent, so an edit cannot silently delete a declaration; authoring inputs is done in the YAML.
- **The MCP `create_server` tool takes no inputs.** It takes `rdp_password` because
  `packRequiresRdp` can pre-empt that one refusal, and it did not gain `user_script` for ADR-0011
  either. An agent creating a server for a pack with a required input gets core's 400, whose
  message names the pack's own label and is actionable as it stands. Worth revisiting when a real
  agent workflow needs it, rather than on speculation.
- **Callback mode still fetches no secrets.** `GET /internal/servers/:id/secrets` serves the same
  material from the same loader, but the cloud-init stub does not call it — a gap that predates
  this decision and is unchanged by it.

## References

- Issue #189 — the request, and the Headlong case behind it.
- `packages/core/src/packs/schema.ts` — the format, the reserved names, the value rules.
- `packages/core/src/packs/inputs.ts` — `resolvePackInputs`, shared by the route and the CLI.
- `packages/core/src/bootstrap/server-secrets.ts`, `bootstrap/push.ts` — delivery and quoting.
- `docs/writing-a-pack.md` § `inputs`; `docs/bootstrap-contract.md` § The `secrets.env` key-name
  contract; `docs/self-hosting.md` § Settings a pack asks you for.

## Related decisions

- [ADR-0004](0004-packs-as-pr-able-yaml.md) — packs describe their own behaviour; this is one more
  field on that principle.
- [ADR-0011](0011-user-script-at-create-time.md) — the user's own script, which receives these
  values like any other step.
- [ADR-0002](0002-push-bootstrap-default-callback-fallback.md) — the `secrets.env` channel and the
  frozen plan version this decision does not move.
