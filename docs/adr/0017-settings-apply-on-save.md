# ADR-0017: The config file is re-read on save, and five settings say why they cannot be

## Status

Accepted — 2026-08-31. Issue #264. Reverses the "read once, at startup" premise that
[ADR-0005](0005-config-file-resolution.md) established for `rockysurf.config.yaml` and that
`config/live-preferences.ts` (issue #124) carved its single exception out of; ADR-0005's
resolution order — which file is read — is untouched.

## Context

The Settings page has been a working GUI over `rockysurf.config.yaml` since rockysurf-m29b: it
edits the operator's own file, comments intact, with a concurrency token and a redacted read. It
also carried a banner, on every save, saying that nothing the operator had just done was in
effect and would not be until they stopped the process and started it again.

That was true. It was also, in the owner's words on #264, a bad experience — and it made the
page's most obvious errand impossible to complete: switching a cloud on, correcting a region,
pasting a token, raising a limit, adding a pack source. Each of those is a thing an operator does
*because something is not working right now*, and each of them changed a file and nothing else.

Issue #124 had already found the shape of the fix for one block. `preferences.tiers` is read from
the file at create time rather than from the config this process booted with, on the reasoning
that "a preference that needs the control plane restarted before it applies is a preference that
did not get remembered". `config/live-preferences.ts` states four conditions under which
re-reading is safe: nothing is built from the value, the file is written atomically, a bad file
changes nothing, and the read is cheap. This ADR is that argument applied to the whole file, with
the "nothing is built from it" condition met by rebuilding rather than by exclusion.

## Decision Drivers

- The user experience the issue names: save should mean save.
- Honesty is not negotiable. A page that says "applied" about a value nothing re-reads is worse
  than the banner it replaced, because the operator stops looking for the problem.
- Restart-required must be a per-setting fact with a reason, not a global caveat. The issue says
  so directly: "be very clear in the UI that a Rocky Surf restart is required".
- Nothing may become half-applied. A request must see one configuration, not a mixture.
- The provider composition seam ([ADR-0003](0003-provider-sdk-shape-and-exclusions.md),
  `packages/rockysurf/src/compose.ts`) must not be rethreaded: core cannot import a provider, and
  the registry is held by the job loop, the lifecycle, the routes and the bootstrap supervisor.

## Considered Options

### Option 1: watch the file and reload on change
- Pros: hand-edits apply too; no coupling to the save route.
- Cons: a save could not report on its own outcome — the page would ask "did it take?" and race
  the watcher to the answer. It also adopts half-typed files from an operator editing in vim, and
  turns every editor's write-and-rename dance into an adoption event.

### Option 2: reload synchronously in the save route, before it answers ← chosen
- Pros: the response can say exactly what happened, per path, because the adoption has already
  happened by the time it is written. One trigger, one moment, no timers, no watcher to leak.
- Cons: a hand-edit still applies at the next start. Stated in the example config rather than
  worked around — an operator editing YAML by hand is already in "restart it" territory, and the
  alternative is Option 1's problems for that case's benefit.

### Option 3: a deep `Proxy` over `Config`, so every existing read becomes live for free
- Pros: no call sites change at all.
- Cons: rejected. It makes `config.limits.maxServers` a number that changes under its reader with
  nothing at the call site saying so, and it silently fails for the reads that copy a value out
  (`Boolean(config.github.pat)`), so the property it appears to guarantee is not one. `Live<T>` in
  the type is the honest version of the same idea.

### Option 4: move the settings into the database, and make the file a bootstrap seed
- Pros: a natural place to hang change notifications.
- Cons: rejected on the standing rule (rockysurf-yzae): configuration is configuration and never
  becomes data. Two sources of truth for the same value is how they come to disagree, and the
  page's whole premise is that it edits the operator's own file.

## Decision

**`config/live-config.ts` holds one in-force `Config`, and the settings save asks it to re-read
the file before the response is written.** `createApp` reads through `currentConfig()` at the
moment it needs a value rather than capturing it at construction; the seams that take a slice of
the config take a `Live<T>` — the value, or a function returning it — which leaves every existing
caller and every test compiling unchanged.

**Adoption is all-or-nothing.** The candidate goes through `checkConfigText`, the same validator
the save has just run and the boot path uses. A file that does not parse, does not validate, or
names a `${VAR}` this process's environment cannot see is not adopted; the previous values stay in
force and the response says why. The swap itself is one assignment of one immutable object.

**Four settings are pinned to their booted values, whatever the file says** — `server.port`,
`server.host`, `server.dataDir`, `auth.mode`. Not a judgement about safety: the listener is bound,
the database and master key are open from one directory, and every live session was issued by the
mode this process started in. A `Config` naming the file's newer values for any of them would be a
config that lies about the process holding it.

**Two things are rebuilt rather than re-read**, by their owners, on a change subscription: the
provider registry (`ProviderRegistry.replaceWith`, so the object every seam holds keeps its
identity) and the pack shop's registry client (whose cache is keyed to sources that may have
changed). An in-flight call keeps the client it already resolved, which is correct — a create
half-way through talking to EC2 must finish against the account it started with.

**The classification is one required field per setting.** `FieldSpec.appliesAt: 'save' | 'restart'`
in `settings/fields.ts`, with `restartReason` required for the restart half, rendered beside the
control. Five are `'restart'`: the four pinned ones, plus `mcp.scopes`, which is read by a
different process altogether — the one an MCP client starts with `rockysurf mcp` — so Rocky Surf
needs no restart and the MCP client does.

## Rationale

The four conditions issue #124 wrote down for `preferences.tiers` are the same four here, and
three of them were already met for the whole file: the write is atomic (temp file plus rename), a
bad file changes nothing (the validator refuses it and the previous values stand), and the read is
one parse per save rather than per request. Only "nothing is built from it" was false — and the
things that *are* built from config in this product are two, both pure functions of it, and both
replaceable in place. That is a much smaller set than the "read once at startup" premise implied,
which is the finding that makes this change small rather than a rewrite.

The pinned four are what keeps the honesty claim true rather than approximately true. Without them
this design would quietly acquire the failure mode it exists to remove: a page reporting a value
as applied while the process ignores it. `settings/fields.test.ts` fails when a pinned path is not
marked `'restart'`, so the two halves cannot drift.

## Consequences

### Positive
- Turning a cloud on, fixing a region, rotating a config-file token, raising a limit, adding a
  pack source, and pasting an OAuth client id all take effect on save.
- The page's banner now means something: it appears only when a restart is actually due, and names
  what for.
- The GitHub token table is re-read per box created, so rotating a token in the file is an edit
  and nothing else.

### Negative
- `AppDeps.config` is now the *starting* value rather than the only one, which is a subtlety a
  reader of `createApp` has to hold. The accessor is named `currentConfig` and documented at its
  declaration for exactly that reason.
- A hand-edit to the file still applies at the next start. Stated in `rockysurf.config.example.yaml`.
- Changing the environment variable *behind* a `${VAR}` still needs a restart, because a running
  process cannot be handed a new environment. This is unchanged and now the only token-rotation
  case that does.

### Risks & Mitigations
- Risk: a new setting is added and silently claims to apply on save while its consumer still reads
  a captured value → Mitigation: `appliesAt` is required by the type, so the classification cannot
  be forgotten; the field's doc comment states that a mislabelled `'save'` is a bug in the
  consumer, not a reason to relabel.
- Risk: recomposing providers disturbs an in-flight operation → Mitigation: `replaceWith` swaps the
  map, never the objects a caller already holds; the SDK gives a provider no lifecycle to close
  (ADR-0003), so there is nothing to release.
- Risk: rebuilding the pack registry client on every save discards a warm cache → Mitigation: the
  rebuild is scoped to a change in the `registry` block; the same scoping keeps a save of the port
  from reconstructing five cloud clients.

## Implementation

- `packages/core/src/config/live-config.ts` (the store, `Live<T>`, `PINNED_PATHS`),
  `settings/fields.ts` (`appliesAt`), `settings/routes.ts` (reload on save, `pendingRestart`),
  `app.ts` (`currentConfig`, `liveRegistryClient`), `server.ts` (the store and the recomposition),
  `providers/registry.ts` (`replaceWith`).
- `packages/web/src/pages/SettingsPage.tsx` (`RestartNote`, the narrowed banner, the per-path save
  report).

## Related Decisions

- [ADR-0005](0005-config-file-resolution.md): which file is read. Unchanged — this ADR is about
  when it is read again.
- [ADR-0007](0007-github-credentials-two-paths.md): the connected token was already read live from
  the encrypted store; the config-file half now behaves the same way.
- [ADR-0006](0006-pack-registry-split-horizon.md): the source list, editable on the Settings page
  since #88 and in force on save since this ADR.
- [ADR-0003](0003-provider-sdk-shape-and-exclusions.md): a provider has no lifecycle, which is what
  makes replacing one safe.
