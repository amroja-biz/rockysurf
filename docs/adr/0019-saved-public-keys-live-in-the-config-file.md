# ADR-0019: Saved SSH public keys are named entries in the config file, and the parser refuses the private half

## Status

Accepted — 2026-09-01. Issue #302. Applies [ADR-0017](0017-settings-apply-on-save.md)'s
save-and-it-applies contract to a new config block, and adds nothing to the create path
[ADR-0008](0008-supplied-key-retires-managed-key.md) froze.

**Amended 2026-09-01, same day, after PR #303 shipped a broken editor.** Clause 1 said this
list reused the Settings page's existing list machinery. There was no such machinery: `view.lists`
was served by core and *never read by the page*, and every list on that page existed only because
somebody had hand-written a block for it, keyed by section id. The `ssh.keys` card worked in
tests — which populated the list — and, on the owner's install, drew its two section headings
from core's inventory and no controls at all: two boxes of prose and no way to add a key.

The amendment makes the original claim true rather than working around it. The page now renders
**any list core declares** from `view.lists`, `SETTINGS_LISTS` gains the `blank`/`labelField`/
`empty` a generic renderer needs (the new-entry shape is a claim about the schema, so it belongs
to core and is parsed through `configSchema` in `fields.test.ts`), `ssh.keys` has **no**
hand-written block so the generic path is exercised by the product rather than only by a test,
and a card that would draw a heading and nothing else now says so instead of implying an editor
that is not there. See "The editor that was not there", below.

## Context

The New Server page has taken a pasted SSH public key since the rewrite: one textarea, one
`sshPublicKey` string on the wire, parsed by `normalizeUserPublicKey` and appended to core's own
key (never substituted for it — the reasoning is in `ssh/server-keys.ts` and in ADR-0008). It
works, and it asks the same thing of the same person every single time: go and find
`~/.ssh/id_ed25519.pub`, open it, copy the line, come back.

Issue #302 asks for the obvious remedy — save the keys you reuse under names, and offer the list
on the create form — with two constraints written into the issue itself: the value saved is the
**public** key, and pasting one at create time must keep working untouched.

Two things about this repository shape the decision. The first is that a public key is not a
secret, and the codebase already says so in a place nobody had to be reminded of:
`settings/fields.ts`'s `SECRET_KEY_NAME` backstop deliberately leaves `sshPublicKey` alone,
because masking it "would hide a field an operator has to be able to read". The second is that
**Rocky Surf stores no cloud credentials** (issue #280/#281) is unconditional, and a feature that
opens a new place to put key-shaped material is exactly the kind of thing that erodes a sentence
like that by degrees.

And there is a predictable mistake. A keypair is two files whose names differ by four characters,
and the one that must never be pasted anywhere is the one without the extension. The existing
parser would already refuse a private key — it is multi-line, and `-----BEGIN` is not a key type
— but it would refuse it with *"public key must be a single line"*, which reads as a formatting
complaint and invites the person to strip the newlines out and try again with their private key
on one line.

## Decision

1. **Saved keys are `ssh.keys` in `rockysurf.config.yaml`**: a list of `{ name, publicKey }`,
   edited on the admin Settings page, which writes that same file. Not a database table, and not
   a `SECRET_KINDS` entry.
2. **They are stored in plain text and are not masked**, on the classification the codebase
   already made: a public key is published material — handed to the cloud provider in the clear
   on every create, written into `authorized_keys` on the box — so encrypting one copy of it
   would be custody theatre, the same judgement [ADR-0011](0011-user-script-at-create-time.md)
   made about the user script. `SECURITY.md`'s secrets inventory gains no row; its
   *never stored* list gains the private half, explicitly.
3. **One parser, and it refuses a private key first.** `normalizeUserPublicKey` moves to a
   dependency-free `ssh/public-key.ts` so `config/schema.ts` can run the same parse the create
   path runs, and it gains a `PRIVATE KEY` check ahead of every other check, whose message names
   the wrong half, names the `.pub` file to paste instead, and says to rotate what was copied. A
   private key in `ssh.keys` therefore fails the settings save and fails the boot — the config
   file cannot come to hold one by accident.
4. **The picker fills the existing field; it does not become a second one.** The create form
   resolves a chosen name to its `authorized_keys` line in the browser and posts it in the same
   `sshPublicKey` string a pasted key uses. Core, the row, the plan, cloud-init and ADR-0008's
   retirement step learn no new concept, and `PLAN_VERSION` does not move.
5. **The name never goes on the wire.** A server is answerable to the key it actually
   authorized, so editing or removing an entry in Settings later cannot rewrite what a box was
   built with.
6. **An entry with an empty `publicKey` is legal and means "not filled in yet"**, because the
   Settings page's Add button writes a blank entry before anyone types into it. The New Server
   page and `GET /api/v1/ssh-keys` drop those rather than offering a choice that would fail at
   submit.
7. **`appliesAt: 'save'`**, and it costs nothing: the route reads the list through
   `currentConfig()` per request, so a key saved a moment ago is offered on the next page load.

## Considered options

- **A new database table plus a migration.** Rejected. It buys nothing here — the list is
  configuration an operator would happily hand-write, which is the test `registry.sources` and
  `providers.byo.hosts` already pass — and it would cost a table, a repository, a migration, an
  admin route pair, and a second home for a value the config file is the natural place for.
- **A new `SECRET_KINDS` entry, encrypted at rest.** Rejected as a misclassification, and an
  actively harmful one: it would mask the value on the settings page, hiding from the operator
  the one thing they need to compare against `~/.ssh/*.pub`, while implying Rocky Surf keeps a
  secret for them that it does not.
- **Sending the key's NAME to the create route and resolving it in core.** Rejected. It puts a
  reference where a value belongs — a box built from `laptop` would silently mean something else
  once `laptop` was edited — and it would give core two ways to receive a key.
- **Copying the chosen key into the paste box.** Rejected: two controls that can disagree about
  one value is how somebody authorizes a key they did not mean to. The textarea is hidden while
  a saved key is selected.
- **Shipping a plausible example key as the Add button's placeholder.** Rejected outright. Any
  string that parses as a public key is a *real* public key whose private half belongs to
  whoever generated it; an empty value is the only honest placeholder.
- **Extending `rockysurf create` and the MCP `create_server` tool.** Not done, and deliberately
  not: neither has an SSH-key argument of any kind today, so nothing became inconsistent. Adding
  one is a separate decision about the CLI's own surface.

## Consequences

### Positive

- The common case — the same laptop key on every box — becomes one menu choice.
- The wrong-half paste is now refused in the operator's own words at three points (settings save,
  boot, create) instead of being refused as a formatting error at one.
- One parse of a public key exists, so the settings editor cannot accept a key the create form
  would then reject.
- No migration, no table, no secret kind, and no new place a credential could be put.

### Negative

- The config file grows a block, and a public key is long, so a hand-edited file gets noisier.
- A key removed in Settings is still authorized on every box it already reached; nothing in this
  feature can change that, and the docs say so rather than implying otherwise.
- The picker's list is a per-installation list, not a per-user one. On a single-admin
  installation — which is every installation, per the *everyone who runs an installation is its
  admin* memory — that distinction does not exist yet, and it would if it ever did.

### Risks and mitigations

- **Risk:** somebody pastes a private key anyway and the check is bypassed by a later edit that
  reorders the parser's clauses. **Mitigation:** `ssh/server-keys.test.ts` asserts both that the
  private-key message is raised *and* that the "single line" message is not, for four shapes of
  private key including one with its newlines stripped.
- **Risk:** the picker silently stops being wired up, leaving an empty menu everywhere.
  **Mitigation:** `servers/saved-ssh-keys.test.ts` drives the real `createApp` rather than the
  handler, which is the whole-boot rule in `CONTRIBUTING.md`.

## The editor that was not there

The failure is worth writing down, because the tests that missed it were not weak — they were
pointed at the wrong state.

`SettingsPage.tsx` draws a list from a hand-written entry in one `handWritten` record keyed by
section id. `view.lists` — core's declaration of which paths are lists and what an entry is made
of — was served from the day the editor was built and read by nothing. So the page's contract was
really "core may add a FIELD and it renders (`humanize` says so in its own comment); core may add
a LIST and it renders only if somebody also edits this file". Nothing said that out loud, and the
`ssh.keys` PR claimed the opposite in its own description.

Three things then lined up. The section headings and their help come from core over the wire, so
the tab looked populated. Every field the section covers is a `*` pattern, and `*` paths are
excluded from `leftovers` — correctly, since a pattern is a shape and not a setting — so the
fallback that catches an unknown FIELD could not catch this. And the wiring test seeded the list
with an entry, so it exercised the one state in which a missing Add button is invisible: the
entries rendered from the hand-written block, and an empty list — the state every installation
starts in — was never asked about.

The fix is the generic renderer. The guard is three tests: the empty list and the absent `ssh:`
block, a list core declares that the page has never heard of, and a sweep of every tab asserting
that no card is help text with no controls. That last one fails on the shipped page.

## Deliberately unresolved

Whether `rockysurf create` should learn `--ssh-key <name>`. It has no SSH-key flag at all today,
so this ADR leaves the CLI exactly as it found it; the question reopens the first time somebody
wants a saved key on a non-browser create.

## References

- Issue #302.
- `packages/core/src/ssh/public-key.ts` — the one parse, and the private-key refusal.
- `packages/core/src/config/schema.ts` — `ssh.keys`, validated by that parser.
- `packages/core/src/settings/fields.ts` — the inventory entries and the two sections.
- `packages/core/src/servers/routes.ts` — `GET /api/v1/ssh-keys`.
- `packages/web/src/pages/CreateServerPage.tsx`, `packages/web/src/pages/SettingsPage.tsx`.
- `SECURITY.md`, *What is stored, and what is never stored*.

## Related decisions

- ADR-0008 — the create path this feeds; unchanged by it.
- ADR-0017 — the save-and-it-applies contract this block is declared under.
- ADR-0011 — the same "encrypting one copy beside a plaintext one is custody theatre" judgement.
- ADR-0006 — the precedent for an operator list that lives in the config file and is edited on
  the Settings page.
