# ADR-0024: The offering/size resolver is one implementation, and it lives in the provider SDK

## Status

Accepted — 2026-09-04

## Context

Issue #349. The code that decides which machine a t-shirt size buys was written twice:

- `packages/core/src/servers/offerings.ts` — resolves for the CLI and the MCP, i.e. any caller
  that posts a `size` to `POST /api/v1/servers`.
- `packages/web/src/lib/requirements.ts` — resolves in the browser, before submit, so the New
  Server page can show the concrete machine and its price. The page then posts the resolved
  `offeringId` + `arch`, which the create route takes verbatim. **For browser creates the web
  copy is the one that decides what gets billed.**

About 120 parallel lines: `SIZE_REQUIREMENTS`, `byPrice`, `meets`, `resolveOffering`,
`preferenceProblem` (the issue #124 saved-type rules) and `resolveSize`. Both files admitted the
mirror in their own doc comments.

Three facts made "it is covered" false:

1. **The drift guard covered only the numbers.** `scripts/check-size-table.mjs` compared the two
   `SIZE_REQUIREMENTS` tables with a regex. The resolver logic around them was unguarded, and the
   copies had already diverged structurally — web's `meets` carried a `diskGb` clause core lacked,
   web returned `alternatives` and core did not, core had `allowedOfferings`/`describeCatalogue`
   and web did not.
2. **The test suites were parallel copies too.** `core/src/servers/offering-resolution.test.ts`
   and `web/src/lib/requirements.test.ts` pinned the same #124 case list against their own copy.
   Neither pinned agreement BETWEEN the copies, so logic drift would have shipped with two green
   suites.
3. **The guard's own rationale had drifted.** `check-size-table.mjs` called core's copy "the
   authority… the only copy that decides what gets billed", which is false for browser creates.

Two properties are deliberate and constrain any fix. Resolution must NOT move server-side:

- **Quote-what-you-showed.** The page posts "the offering the user was shown a price for — not
  whatever core would pick now" (`CreateServerPage.tsx`).
- **Create-survives-a-pricing-outage.** A fully-specified create never consults the catalogue
  (`servers/routes.ts`, pinned by `pricing.test.ts`).

So the resolver still has to run in the browser before submit AND in core for size-only callers.
One implementation, two call sites.

## Decision

1. **The decisions move to `@rockysurf/provider-sdk`**, in a new `sizing.ts`: `ServerSize`,
   `SERVER_SIZES`, `Requirements`, `SIZE_REQUIREMENTS`, `requirementsForSize`, `archLabel`,
   `compareOfferingsByPrice`, `meetsRequirements`, `chooseOffering`, `preferenceObstacle` and
   `chooseForSize`. Core and the browser both import it. It is the only place a size resolves.

2. **The SDK's charter is not amended; it is restated.** The promise its `contract.test.ts`
   asserts is ZERO RUNTIME DEPENDENCIES (`dependencies: {}`, no `peerDependencies`, no import
   outside the package), not "no runtime code" — `errors.ts`, `instance.ts`, `provision.ts` and
   `ssh-cidr.ts` already ship pure helpers, and `ssh-cidr.ts` arrived for this exact reason in
   ADR-0021 ("the one place three providers have to agree character-for-character"). Only the
   `package.json` description and the README, which said "Types only", were stale and are
   corrected. The zero-import assertion is WIDENED from the six frozen surface files to every
   source file in the package, because the SPA bundle now imports this package and an import
   added here would reach a browser.

3. **Prose is NOT shared.** Every shared function returns a structured outcome — an
   `OfferingRefusal` carrying `soldOut`, the `requirements` that were asked for and the
   provider's `unanimousReason` where there is one; a `PreferenceObstacle` of
   `not-offered` / `unavailable` / `arch-mismatch`. Each surface phrases it in its own voice, and
   both voices are preserved verbatim: core writes lowercase fragments that get interpolated into
   an HTTP error, the SPA writes sentences with curly quotes for a person looking at a form. The
   DECISION is shared; the sentence is not.

4. **What stays where it was.** `allowedOfferings` and `describeCatalogue` stay in core — the
   operator's allowlist is core's own idea and reaches the browser already applied, in the
   `/api/v1/providers` response. `availableArchitectures` and the price formatters stay in web —
   they are display, not resolution.

5. **The known dead weight is dropped.** Web's `alternatives` (tested, consumed by nothing outside
   its own module) and web's `diskGb` clause in `meets` (matched no `Requirements` value either
   tree ever set) are gone.

6. **`SERVER_SIZES` is defined once**, in `sizing.ts`, and re-exported by core's `db/schema.ts`
   where the persisted `size` column is declared. `StoredSize` still widens it with `'custom'`.

7. **`scripts/check-size-table.mjs` is retired**, with its stale "only copy that decides" comment.
   There is one table now; the type system is the guard.

## Considered options

**A new tiny workspace package (zero runtime deps).** Honest, and rejected on ceremony: core
imports it at runtime, so it must be published — a twelfth npm package, a row in
`docs/RELEASING.md`'s table, three hand-written package counts to move
(`check-package-count.mjs`) and another surface for `check-npx-closure.mjs`, all for one file whose
only inputs are `Offering` and `Architecture`, which the SDK already owns.

**A browser-safe subpath export of `@rockysurf/core`.** Rejected: core's tree pulls in
better-sqlite3 and ssh2, so the browser-safety of a second entry point would be a promise kept by
care — one type-only import turning into a value import at any point in the future puts a native
module in the SPA bundle. In the SDK the same property holds by construction, and is asserted.

**Moving resolution server-side and deleting the browser copy.** Rejected outright by the two
pinned properties above: the page must quote the machine it will post, and a fully-specified
create must not need the catalogue.

**A shared module that also owns the wording, with a per-surface phrasing dictionary.** Rejected:
it puts UI copy into a published provider SDK, and the two voices differ for good reasons
(fragment-in-an-HTTP-error vs sentence-on-a-form). Formatting is ~25 lines per surface and makes
no decisions.

**Folding in the other duplications issue #349 lists.** `web/src/lib/environment.ts` vs
`packages/rockysurf/src/environment.ts`, `web/src/lib/envRef.ts`'s interpolation regex, and
`CreateServerPage.tsx`'s hardcoded `8` for `RDP_MIN_LENGTH` were each considered and left. None of
them is about `Offering`, so each would need its own shared home, and putting env parsing or an
RDP password rule in a provider SDK to get it into the browser is exactly the over-generalisation
this decision should not license. `InstallPreview.tsx`'s install ordering stays too — it is
self-labelled deliberate and pinned to the documented rule.

## Consequences

### Positive

- One `SIZE_REQUIREMENTS`, one price comparator, one floor check, one preference rule. A pricing
  change is one edit and cannot land on one surface only.
- The #124 rules are pinned three ways that cannot disagree: `sizing.test.ts` against the shared
  functions, core's `offering-resolution.test.ts` through a real create route, web's
  `requirements.test.ts` through the browser wrapper. The two surface suites now exercise the same
  code, which is what the old pair could not claim.
- The browser bundle gains a dependency that has, and is asserted to have, none of its own.

### Negative

- `packages/web` now depends on a built workspace package. Its `tsc --noEmit` and its vitest run
  need `pnpm -r build` first — a requirement CI already carries for every job
  (rockysurf-7mdh) but which a developer who only ever ran the web suite did not.
- The provider SDK's public surface grows by eleven exports that a provider AUTHOR has no use for.
  They are for core and the SPA. The README table says so.
- A refusal now travels as data and is turned into a sentence at the edge, so reading either
  surface's wording means reading two files rather than one.

### Risks and mitigations

- **Risk:** the SDK becomes the drawer everything shared gets put in, and a provider author
  inherits a growing surface. **Mitigation:** the bar written into ADR-0021 and restated here — a
  helper belongs in the SDK when it is pure, dependency-free, and expressed in the SDK's own
  types. The three duplications explicitly left out above are the precedent for saying no.
- **Risk:** a future import in any SDK source file quietly puts a dependency into the SPA bundle.
  **Mitigation:** `contract.test.ts` now asserts the zero-import rule over EVERY source file in
  the package, not just the frozen six.
- **Risk:** the two phrasing wrappers drift the way the resolvers did. **Mitigation:** they make no
  decisions — a drift there changes a sentence, never a machine or a price, which is the failure
  mode this ADR exists to remove.

## References

- Issue #349 (the evidence, the pinned properties, and the acceptance criteria).
- `packages/provider-sdk/src/sizing.ts`, `packages/provider-sdk/src/sizing.test.ts`.
- `packages/core/src/servers/offerings.ts`, `packages/web/src/lib/requirements.ts`.
- Retired: `scripts/check-size-table.mjs` (rockysurf-clf2's drift guard).
- Issue #124 (the saved machine type), issue #116 (Azure's quota refusal), rockysurf-clf2 (a size
  is a floor), rockysurf-j10e (`providers.<cloud>.sizes`).

## Related decisions

- ADR-0003 — freezes the SDK's shape; this adds a helper module beside it, not a change to
  `ComputeProvider`. ADR-0003 left t-shirt resolution "deliberately unresolved"; this is where the
  resolution it eventually grew now lives.
- ADR-0021 — the precedent: `ssh-cidr.ts` put pure functions in the SDK for the same reason.
- ADR-0009 — why `hourly` can be `null`, which is why the comparator sorts unpriced offerings last.
