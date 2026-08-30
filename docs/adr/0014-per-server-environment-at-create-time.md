# ADR-0014: The person creating a server may set their own environment on it

## Status

Accepted — 2026-08-27. Issue #197. Extends
[ADR-0013](0013-packs-declare-their-inputs.md)'s delivery mechanism to a second contributor —
the user — and narrows the `GIT_` name reservation that decision introduced.

## Context

[ADR-0013](0013-packs-declare-their-inputs.md) gave a **pack author** a way to say what their
pack needs, and the create form asks for it. There is still no way for the **person creating the
box** to hand it a value the pack never declared.

The case that surfaced is [ADR-0011](0011-user-script-at-create-time.md)'s startup script. It is
stored on the server row and pushed to the box in plain text — encrypting one copy beside a
cleartext one is custody theatre, which that ADR says out loud — so the form told the user to
put no passwords or tokens in it. A script that needs a token was therefore left with two
options: edit the pack, or do it anyway. The form was refusing something without offering
anywhere else to put it, which is an obstacle rather than a rule.

The second half of this decision is a debt from ADR-0013 §3. `RESERVED_INPUT_PREFIXES` refused
the entire `GIT_` namespace to protect the four names the setup preamble writes. A user who
wants `GIT_AUTHOR_NAME` on their box — or a pack author who wants it — was refused for nothing.

## Decision

**1. An `Environment` field on the create form, next to the startup script, for every pack.**
(It sat below the script until issue #245 put the form in the order the box boots; it is now
directly above it, because the script is what reads these values.)
`KEY=value` lines the user types. Like the startup script and the repositories field, no pack
grants or withholds it: it is the user's own configuration of their own box.

**2. A line is marked secret with a `secret:` prefix, not a checkbox beside it.** The issue
offered both. The prefix wins on being one control rather than two: a checkbox list needs a
stable identity per line to hang state on, and a textarea has none — a name typed one character
at a time is a different name on every keystroke, a reordered paste re-associates every box, and
a deleted line leaves a checkbox pointing at nothing. The prefix is also part of the text, so it
survives a paste, and it is the **same format `--env-file` reads** — an environment moves
between the browser and a script as a copy rather than a translation. It cannot be mistaken for
a name, because a name is `^[A-Z][A-Z0-9_]*$` and `secret:` is not.

**3. Delivery is ADR-0013's, unchanged, with the same custody split.**

| | plain line | `secret:` line |
|---|---|---|
| at rest | `servers.environment`, a JSON column | encrypted store, kind `server-environment`, one row per server |
| `GET /servers/:id`, `GET /servers` | returned | **never**, by any route |
| plan snapshot (`plan.json`, `installPlan`) | **never** | **never** |
| on the box | `secrets.env`, `0600`, every step's environment | same |

`PLAN_VERSION` does not move, for the reason it did not move for ADR-0013: nothing about the
plan's shape changed, and the values travel in a file the agent has always read.

**4. Two columns and two secret kinds, not one shared pair.** A pack's inputs and a user's
environment hold the same shape and are delivered identically, so the temptation is to merge
them at rest. They stay separate because the **provenance is the thing being stored**: the
server page says "the pack asked for this" and "you added this", a create-time collision between
them is a 400, and both sentences are only true while something remembers which is which.

**5. The same name in both is refused at create — never a silent precedence.** Whichever way a
precedence rule went, one of the two values the user filled in would vanish invisibly: the form
would still show both, the box would carry one. The refusal names the key and says which field
to use instead, and it is checked against what the pack **declares** rather than what the user
answered — an optional input left blank still owns its name on that box.

**6. The rules are one implementation, consulted twice.** `env/names.ts` holds the reserved
names, the reserved prefixes, the `^[A-Z][A-Z0-9_]*$` name schema and the value schema (≤4 KiB,
single line); `packs/schema.ts` and the environment resolver both use it. They were written
inside the pack format file, where the pack's `inputs` were the only contributor; a rule that
held for a pack's variable and not for a user's would be a rule about paperwork, because the box
cannot tell them apart. The same reuse runs through the stack: one `putSecretMap`/`getSecretMap`
serves both secret kinds, and `createServerSecretsLoader` folds all four sources in one loop.

**7. An empty value is kept, unlike an empty pack input.** A declared input nobody answered is
omitted so the pack's own `${FOO:-}` default can fire. A line the user wrote as `FOO=` can only
mean "set `FOO`, empty" — dropping it would make what they typed do nothing.

**8. The startup-script hint changes from a prohibition to a direction.** "It is stored and sent
to the box in plain text, so put no passwords or tokens in it" becomes "…so put passwords and
tokens in Environment below and read `$KEY` here."

**9. The CLI takes `--env [secret:]KEY=VALUE` (repeatable) and `--env-file <path>`,** merged
file-then-flags, checked with core's own `resolveServerEnvironment` before the POST. A `secret:`
value given as `--env` is refused outright, on the ruling `--rdp-password <value>` and a secret
`--input` already carry: by the time a warning could print, the value is in the shell's history
file and has been readable in `ps`. There is deliberately **no `ROCKYSURF_ENV_<NAME>`**
counterpart to `ROCKYSURF_INPUT_<NAME>`: that one works because the pack enumerates the names it
declares, and nothing enumerates this field — the equivalent would have to scan the process
environment for a prefix and guess.

**10. The `GIT_` reservation is narrowed to the names Rocky Surf actually writes.**
`GIT_TERMINAL_PROMPT` and `GIT_CONFIG_COUNT` become reserved exact names; `GIT_CONFIG_KEY_` and
`GIT_CONFIG_VALUE_` stay prefixes because they are indexed and no exact-name list can close a
name with a number in it. Everything else git reads — `GIT_AUTHOR_NAME`, `GIT_SSH_COMMAND`,
`GIT_PAGER` — is now accepted, for packs and for user environment alike. `ROCKYSURF_` is
untouched. A test reads the real `SETUP_GIT_AUTH_PREAMBLE` and asserts every variable it exports
is unclaimable, so a fifth name added to the preamble fails in CI rather than on a box — the
exact risk of replacing a prefix with a list.

**11. The server page shows both non-secret sets, and says a secret is unrecoverable.** After
the create screen is gone, this page is the only thing that remembers what a box was configured
with. Saying that a secret is shown by nothing is the honest half: the remedy for a lost one is
a new box.

## Considered options

**A. A per-server Environment field, delivered like pack inputs (chosen).**

**B. Nothing — tell users to put the value in a pack.** Rejected, and it is what the product
did. It makes a private fork of a pack the price of one token, which is exactly the friction
`inputs` was built to remove for pack authors, charged to the user instead. It also cannot work
for a startup script, which is not part of any pack.

**C. A free-form `env` map with no `secret` flag, everything stored in the clear.** Rejected.
The motivating case is a startup script that needs a **token**; a field that cannot keep one is
the field the user already had.

**D. Everything encrypted, no plain half.** Rejected for the reason ADR-0013 rejected it (its
option F): it costs the server page its answer to "what is this box configured with" for values
the user is looking at in a text box, and makes the encrypted store the authority for data whose
whole purpose is to be displayed.

**E. A checkbox list beside the parsed lines, instead of the `secret:` prefix.** Rejected — see
§2. Two controls, per-line state a textarea cannot supply an identity for, and a format that
does not survive the trip to `--env-file`.

**F. A `--secret-env KEY=VALUE` companion flag instead of the line prefix.** Rejected. It splits
one list into two that must be read together, gives the file no spelling for a secret line at
all, and makes the CLI's format differ from the form's for no gain.

**G. Sending the textarea's raw text on the wire and parsing it in core.** Rejected, though it
is tempting: it would leave exactly one parser. It makes `secret:` a wire format rather than a
typing convenience, and obliges every API client — an agent, a script, `curl` — to assemble a
text blob instead of sending the structure it already has. The API's job is structure. The cost
is a small parser on each of the two surfaces where a human types the text (the form, and
`--env-file`), with core re-validating everything either one produces.

**H. Merging the environment into `servers.pack_inputs` and the `pack-inputs` secret kind.**
Rejected — see §4. It saves a column and throws away the provenance the server page and the
collision check are both built on.

**I. Keeping `GIT_` reserved whole.** Rejected. It protects four names by refusing a namespace
of dozens, and the drift risk it was guarding against is better handled by the test in §10,
which reads the preamble itself.

**J. Allowing the environment to override a pack input, or vice versa.** Rejected — see §5.
Every precedence rule loses a value the user typed, silently.

## Consequences

- A startup script can finally read a token, and the form can say where to put one.
- One migration, one nullable column (`servers.environment`), one new secret kind
  (`server-environment`).
- The custody rule gains a plaintext accessor (`getServerEnvironmentSecrets`) and no new
  exemption.
- `RESERVED_INPUT_NAMES`/`RESERVED_INPUT_PREFIXES` are renamed `RESERVED_ENV_NAMES`/
  `RESERVED_ENV_PREFIXES` and move to `env/names.ts`. They were never pack-specific; they are
  the names the bootstrap environment already occupies.
- A pack input name that was legal yesterday is still legal today, and several that were not
  (`GIT_AUTHOR_NAME` and friends) now are. Nothing that validated before fails now.
- The textarea format is parsed in two places — `packages/web/src/lib/environment.ts` and
  `packages/rockysurf/src/environment.ts` — because the SPA cannot import core (core bundles the
  SPA). Both are courtesy readers: core re-validates every name and value, and `docs` states the
  format once.
- `PLAN_VERSION` is untouched, so no agent, no snapshot and no resume changes.

## Deliberately unresolved

- **No editing a server's environment after create.** There is no re-push, so a changed value
  would not reach a running box; a field that looked editable and did nothing would be worse
  than no field. The server page says so.
- **No per-value validation beyond size and one line.** Nothing declares this field, so there is
  nothing to validate against. A bad value fails wherever it is read, with that reader's own
  message.
- **The MCP `create_server` tool takes no environment**, for the reason ADR-0013 gives for
  `packInputs` and ADR-0011 for `user_script`: worth adding when a real agent workflow needs it,
  rather than on speculation. Core's 400 is actionable as it stands.
- **A duplicate name in the textarea is refused rather than resolved**, and there is no UI
  affordance pointing at the second line beyond the message naming it.

## References

- Issue #197 — the request, and the startup-script case behind it.
- `packages/core/src/env/names.ts` — the reserved names, the name and value rules.
- `packages/core/src/servers/environment.ts` — `resolveServerEnvironment`, and the collision.
- `packages/core/src/bootstrap/server-secrets.ts` — the four sources folded into one environment.
- `docs/writing-a-pack.md` § env table; `docs/bootstrap-contract.md` § The `secrets.env` key-name
  contract; `docs/self-hosting.md` § Your own environment on a box.

## Related decisions

- [ADR-0013](0013-packs-declare-their-inputs.md) — the pack's own inputs, whose delivery,
  custody split and validation this reuses wholesale, and whose option C (a free-form `env` map
  with no declaration) is **not** what this is: that was rejected as the mechanism a PACK uses
  to state its needs, and remains rejected for that. This is the user's own namespace, where
  there is nothing to declare.
- [ADR-0011](0011-user-script-at-create-time.md) — the startup script, which is the case that
  made this necessary and which receives these values like any other step.
- [ADR-0002](0002-push-bootstrap-default-callback-fallback.md) — the `secrets.env` channel and
  the frozen plan version this decision does not move.

## Amendment — 2026-08-30: the values are in `rocky`'s shell, not only in setup (issue #244)

**Owner ruling.** If a user would expect an environment variable to be on the box, it is on the
box — by default, with nothing to opt into. A person who typed an API key into this field,
SSHed in and found the harness could not see it had hit a bug, not a documentation gap.

**What changes.** §3's delivery table gains a row and §3's "on the box" column is no longer the
whole story. After every step the pack contributes and after the user's own script, a
`shell-environment` step (phase 6 of the bootstrap contract) writes every Environment line —
plain and `secret:` alike — and every pack input from [ADR-0013](0013-packs-declare-their-inputs.md)
to `~rocky/.config/rockysurf/environment`, owner `rocky`, mode `0600`, and installs two
value-free hooks (`/etc/profile.d/rockysurf-environment.sh`; a marker block at the top of
`/etc/bash.bashrc`) so that an interactive SSH login, `ssh box 'command'`, a tmux session and
the remote-desktop session all source it. `GITHUB_TOKEN` is included; `RDP_PASSWORD` and the
credential-helper plumbing are not. The full mechanism and the alternatives rejected are in
[`bootstrap-contract.md` § The shell environment](../bootstrap-contract.md#the-shell-environment).

| | plain line | `secret:` line |
|---|---|---|
| on the box, after setup | `~rocky/.config/rockysurf/environment`, `0600`, sourced by every shell `rocky` gets | same |

**What does not change.** Custody at rest and over the API are exactly §3's: a `secret:` value
is still returned by no route, and neither half is in the plan snapshot. What the plan gains is
the NAMES — the `shell-environment` step's body lists which names it will export, because the
step reads the values off the environment the agent already holds rather than off the plan.
`PLAN_VERSION` is unmoved for §3's reason: no field changed. §5's collision rule is what makes
the name list a plain list — the pack's names and the user's cannot overlap. §7 holds on the
box too: an empty Environment value is exported empty, an unanswered optional input is absent.

**Why a file in the home directory is acceptable.** This is one person's box; the same values
were already handed to every install step; and `rocky` holds `sudo`, so `secrets.env` was
already readable to anyone who could read this file. The mode is the tightest a file a shell
must read can have. There is still no editing after create — the ADR's "deliberately
unresolved" entry stands — so the file cannot go stale against a value core holds.

**§11's sentence needs one word changed, everywhere it is repeated.** "A secret is shown by
nothing" was true while the values stopped at setup; it is not true of a box that now carries
them in a file its owner can `cat`. What is still true — and is the useful half — is that
**Rocky Surf** will not show it back: no route, no page, no list. Every place that phrased the
refusal as a property of the world rather than of the control plane is corrected to say so
(`self-hosting.md`, twice; the create form's own caveat, in #245). The remedy for a lost secret
is unchanged only for someone who no longer has the box.

**Consequences for the form.** The startup-script hint (§8) is now understated rather than wrong:
a value put here reaches the script AND the shell. The form's Environment copy is rewritten in
the form-restructure issue; this amendment owns core, the agent and the documents.
