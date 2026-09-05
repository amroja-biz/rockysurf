# ADR-0027: A provider declares its settings and its advisories, and the Settings page is built from them

## Status

Accepted — 2026-09-04. Issue #294, item 3 of the settled direction. **Amends
[ADR-0003](0003-provider-sdk-shape-and-exclusions.md)** as amendment E19 — `ProviderFactory.settings`,
optional — and narrows the "hand-written on purpose" doctrine of `settings/fields.ts` to core's own
sections.

**Amended 2026-09-05 (issue #370): all shipped providers declare their settings.** Decision 9 below
said Hetzner migrated and AWS, Azure, GCP and BYO would follow, GCP first. They have, in that order,
in one change. What that leaves is the end state this ADR named: `settings/fields.ts` holds no
`providers.*` row, no `providers.*` section, no `preferences.tiers.*` row and no per-cloud table;
`SETTINGS_LISTS` holds core's three lists and none of a provider's; `SettingsPage.tsx` has no
hand-written provider block; and the settings inventory is a pure function of the loaded factories
plus core's own sections. The prose moved verbatim — the labels, the help sentences and the
firewall warnings an operator reads are the ones they read before.

Five details are worth recording, because each is a place the mechanical migration was not quite
mechanical:

1. **Three optional additions to the declaration**, each unlocked by one shipped provider and each
   there to keep prose the migration would otherwise have lost.
   `ProviderSettingListItemField.help` — BYO's six host boxes each had their own sentence, and a
   list whose items all repeat the list's sentence says nothing about any of them.
   `offering.label` — how a provider is named INSIDE a sentence, because "whenever you ask Your own
   machines for a small box" is not English and "Your own machines" is the right heading.
   `offering.allowlist: false` — BYO has no `sizes` key in core's schema and should not grow one:
   its machine types ARE the hosts the operator listed, so an allowlist over them is the list.
2. **`enabled` keeps core's sentence, and the credential sentence moved to the section.** `enabled`
   is reserved (decision 2), so the four clouds' own switch help — "Credentials come from the
   standard AWS chain … and never from this file" — could not travel on it. It travels on
   `settings.help`, at the head of the panel, where the same words already were.
3. **The read-only allowlist is labelled from the declared noun.** The hand-written blocks said
   "Offered instance types" / "Offered VM sizes" / "Offered machine types"; core generates
   `Offered ${noun}s`, which reproduces all three and gives Hetzner "Offered server types" where the
   generic renderer had humanized `sizes` to "Sizes". That is the one label this change alters, and
   it alters it towards the words the other clouds already used.
4. **The splice points are named rather than found.** `orderedSections` located the provider run by
   looking for the first `providers.*` section in `SETTINGS_SECTIONS`; with none left there is
   nothing to find, so the anchors are explicit — provider tabs immediately before `limits`,
   saved-type cards immediately after `preferences`, which is exactly where they have always been.
5. **AWS declares `securityGroupName`**, which never had a hand-written row. The provider has
   accepted it since it was written and core's schema learned it in issue #343; leaving it off the
   panel would be that issue's lesson in the other direction — a field the file accepts and no page
   shows.

Two things deliberately did NOT move, and are named here rather than left implicit. **The three
clouds' credential environment variables** stay in core's `setup/state.ts` `PROVIDER_CREDENTIAL_ENV`:
AWS, Azure and GCP have no credential FIELD to declare — their credentials arrive from an ambient
chain and nothing is stored, which is the "Rocky Surf stores no cloud credentials" rule as a panel
with no box on it — and moving the variable names onto a factory would need a `ProviderSettings`
level `credentialEnv` this migration did not need. **Azure's `allowAzureCli`** is accepted by both
schemas and declared by neither: it narrows which credential SOURCES a process will accept, which is
a decision made in the file a process boots from, not a checkbox on a page. **`WizardPage.tsx`'s
per-cloud setup steps** remain the sanctioned exception, unchanged and still pinned by its boundary
test.

The consequence recorded below — that an installation composed without descriptors has no provider
panel and does not pretend to — now covers all five rather than only Hetzner. The product always
composes (`packages/rockysurf/src/compose.ts` records a descriptor per wiring, enabled or not); a
test with a bare registry has to record one too, and two in `server.test.ts` now do.

## Context

The Settings page's inventory (`packages/core/src/settings/fields.ts`) was hand-written, and said so
in its first paragraph: a form generated from the zod schema would draw a control for every field,
would render a `${VAR}` reference and a literal token in the same box, and would offer edits to
fields that must not be edited from a browser. That reasoning was and is correct — and it produced
the class of gap the DigitalOcean audit on #294 found (D4): a hardcoded `['aws', 'azure', 'gcp']`
loop in `SettingsPage.tsx` drawing the SSH whitelist, a per-cloud `TIER_PREFERENCE_CLOUDS` table, a
per-cloud `SETTINGS_LISTS` entry, and a hand-written block per cloud in the SPA. A new cloud had to
be added to every one of them or it silently had no whitelist control, no saved-type card and no
panel; and a cloud that is not in this repository at all (ADR-0026) could be added to none of them.

The owner's first idea was to render the provider's zod config schema. It cannot be, for reasons the
review sharpened: the schema is a structural `{ parse() }` the SDK cannot introspect without a
dependency it refuses to have; it carries no labels or help; `enabled`, `package` and `sizes` are
core's and are not in it; a `token` box means "the NAME of a variable" (ADR-0007's `accepts`), which
no zod type says; and `sshAllowedCidr` + `allowAllCidr` is ONE control with ADR-0021's two-act
guard. What the schema knows and what a page needs are different things.

## Decision

1. **`ProviderFactory.settings?: ProviderSettings`** (E19) — a declaration DISTINCT from the config
   schema: a title and help; `fields`, each with a `name`, a `kind` from a closed set (`string`,
   `number`, `boolean`, `secret`, `stringList`, `sshCidrList`), a `label`, a `help` sentence, and
   optionally `warning`, `writable`/`reason`, `appliesAt`/`restartReason`, `accepts`, `example`;
   `lists` (the `providers.byo.hosts` shape); an `offering` vocabulary (`noun`, `example`) for the
   saved-type fields; and `advisories`, each with a `surface` (`settings` or `create`) and a
   sentence. Types only; the SDK gains no dependency.
2. **`enabled`, `package` and `sizes` cannot be declared.** They are the installation's, added to
   every panel by core, and a declaration naming one is refused by conformance.
3. **`sshCidrList` is the two-act whitelist as one kind.** The declared field is the list; the
   sibling `allowAllCidr` boolean is implied and drawn by the same control; a provider declaring it
   MUST also declare `capabilities.managesSshAccess` — conformance constructs the provider from the
   valid config and checks — because a firewall editor whose saves land in a file and nowhere else
   is the defect ADR-0021 exists to prevent.
4. **The declaration is checked against the schema.** `assertSettingsShape` (run by
   `assertFactoryShape` whenever `settings` is present) requires every `help` to be a sentence,
   every kind valid, `writable: false` to carry a `reason`, and every `example` to parse through
   `configSchema` on top of the valid config — a secret's example substituted with a placeholder,
   because it is the NAME of a variable.
5. **Core builds the inventory by merging.** `settings/inventory.ts` takes what the composition root
   recorded about every factory it knows (`ProviderDescriptor.settings`, loaded or not) and turns a
   declaration into `FieldSpec`s, `SectionSpec`s and `ListSpec`s the page already draws: `enabled`
   first, the declared fields in order (with `allowAllCidr` after an `sshCidrList`), `sizes` last
   with the declared noun, `package` for a personal provider, lists as cards on the provider's tab,
   and the three saved-type fields from the declared vocabulary through the same template the static
   table uses. A shipped provider that has not declared keeps its hand-written rows; the page cannot
   tell the two apart.
6. **Tab order is preserved, not derived.** `PROVIDER_ORDER` is hetzner, aws, azure, gcp, byo — the
   order the tabs and the saved-type cards have always had — and declared and static sections slot
   into it alike, with personal providers after in the order the file lists them. Ordering by the
   schema's key order would have moved Hetzner from the first tab to the fourth.
7. **Redaction follows the declaration.** A declared `secret` is masked wherever it is; a declared
   non-secret leaf of a personal section is shown; an undeclared leaf of a personal section stays
   masked (ADR-0026). Shipped sections keep the name-based backstop.
8. **The page renders a declared row with its own label and placeholder**, draws `sshCidrList` with
   the CIDR control it already had, and derives the whitelist ledger from inventory paths matching
   `providers.*.sshAllowedCidr` — the `['aws', 'azure', 'gcp']` loop is gone. `sectionHeader` prints
   the `settings`-surface advisories at the head of the panel; `/api/v1/providers` carries the
   `create`-surface ones and the New Server page prints them for the selected provider.
9. **Hetzner migrates; AWS, Azure, GCP and BYO do not, yet.** *(Superseded by the 2026-09-05
   amendment above: all five have migrated.)* Hetzner's four rows, its section, its
   tier-table row and its hand-written block are deleted; the prose moved verbatim onto
   `hetznerProviderFactory.settings` (with `credentialField`/`credentialEnv` from ADR-0026). One
   shipped provider on the declared path is what keeps that path exercised by the product rather
   than by a fixture — the `ssh.keys` lesson of ADR-0019's amendment. It is Hetzner because it is the
   token-shaped cloud the `add-provider` skill tells authors to copy, so it should be the shape
   they copy. The other four are a follow-on issue, GCP first (the firewall shape).
10. **The two core-local properties keep both halves tested.** `fields.test.ts` names Hetzner in
    `DECLARED_BY_PROVIDER` (its own set — `DELIBERATELY_ABSENT` means "not manageable from the page",
    which would be a lie), with a reason naming the factory, and asserts no static rows remain; the
    credential scan admits `token` as a declared credential; and the composition root's
    `settings-parity.test.ts` — the one package that may import both sides — asserts the named
    factory declares every field core's copy of its section accepts, nothing core's copy refuses,
    and its credential as `secret`. The env-var wording rule is checked over the inventory built
    with the declaration, so it governs something.

## Considered options

- **Rendering the zod config schema.** Rejected — see Context. The declaration is a description;
  the schema is a validator; conformance holds them together.
- **Zero migrations in this release** (declare the type, merge for personal providers, leave all
  five static). Rejected in review on the product-exercise argument: a path only a fixture takes is
  a path the product can break unnoticed, which is exactly how #303 shipped a section with no
  controls.
- **Migrating Hetzner and GCP together.** Agreed conditionally in review, on the ground that an
  existing browser spec (`settings-ssh-converge.e2e.ts`) drives the GCP panel. It does not — it
  stubs an `aws` sync response against a BYO-only control plane — so the agreed fallback applies:
  Hetzner only, with `sshCidrList` exercised in the browser by the personal fixture provider
  (`e2e/fixtures/personal-provider`, which declares one and `managesSshAccess`), and GCP named first
  in the follow-on.
- **Migrating all five.** Rejected as the largest diff for the least new information: core's
  `config/schema.ts` still mirrors every shipped section by hand (the dependency lint), so a shipped
  provider ends with three homes rather than two whichever way; the merge model lets the migration
  happen one provider at a time.
- **A `kind: 'cidrList'` plus a separately declared `allowAllCidr`.** Rejected: the two fields are
  one decision with a guard between them, and a provider that declared the checkbox alone would
  draw the permanent, unexplained offer to open SSH to the internet that the page's ledger exists
  to prevent.
- **Deriving tab order from the config schema.** Rejected — it moves Hetzner from first to fourth.

## Consequences

### Positive

- A provider that is not in this repository gets a Settings panel with its own labels, a secret box
  that takes a variable name, the two-act SSH whitelist control, saved-type cards and advisories —
  with no edit to core or the SPA.
- The D4 class of gap is retired for declared providers: there is no per-cloud list left in the SPA
  to join, and the remaining per-cloud tables in core shrink by one row per migration.
- The prose the operator reads lives beside the code that parses the field it describes.

### Negative

- A shipped provider is described three times — its zod schema, core's mirrored section, and its
  declaration — until core can validate a shipped section with the provider's own schema (a change
  to the dependency rule, not attempted here). The parity test holds the three together.
- Core tests that want a Hetzner panel must say what the factory declares (they cannot import it),
  which is one more fixture to keep honest.
- A settings app built without the composition root's descriptors — an embedded core, a test with a
  bare registry — has no Hetzner panel, and does not pretend to. The product always composes.
- ~~Four shipped providers keep their hand-written rows for one more release.~~ Retired by the
  2026-09-05 amendment: none do.

### Risks and mitigations

- **Risk:** the declaration drifts from the schema and a control's save is refused at boot.
  **Mitigation:** conformance parses every `example`; the parity test parses every declared name
  through core's schema and requires every schema key to be declared.
- **Risk:** the migrated panel changes the words an operator reads. **Mitigation:** the prose moved
  verbatim; the page's wiring test still matches `Token Environment Variable`.
- **Risk:** the merged order differs from the old static order. **Mitigation:** `inventory.test.ts`
  pins the full provider and tier order, including a personal provider's place after `byo`.
- **Risk:** `sshCidrList` ships exercised only by a fixture. **Mitigation:** retired by issue #370 —
  three shipped clouds declare it, and `settings-declared-clouds.e2e.ts` drives all three panels and
  writes a CIDR into a config file that had no `gcp:` section at all.

## Deliberately unresolved

- ~~Migrating AWS, Azure, GCP and BYO — a follow-on issue, GCP first.~~ Done (issue #370).
- Letting core validate a shipped section with the provider's own `configSchema`, which would
  collapse three homes to two; it needs the dependency rule revisited and is not this ADR's job.
- The wizard's per-cloud setup steps (`WizardPage.tsx`, the sanctioned exception) — a `wizard`
  advisory surface would replace them, and the boundary test that pins the exception makes that a
  deliberate change rather than a side effect.

## References

- Issue #294; the plan and its review, recorded as a comment there.
- `packages/provider-sdk/src/settings.ts` — the types; `provider.ts` — E19.
- `packages/provider-conformance/src/index.ts` — `assertSettingsShape`.
- `packages/provider-hetzner/src/index.ts` — the first declaration.
- `packages/core/src/settings/inventory.ts`, `inventory.test.ts`; `fields.ts` (Hetzner's rows gone,
  `tierPreferenceFields`/`tierPreferenceSection` exported); `fields.test.ts` (`DECLARED_BY_PROVIDER`).
- `packages/rockysurf/src/settings-parity.test.ts` — the other half.
- `packages/web/src/pages/SettingsPage.tsx` — the generic renderer, the derived ledger, the deleted
  block; `CreateServerPage.tsx` — advisories.
- `packages/web/e2e/settings-personal-provider.e2e.ts`, `e2e/fixtures/personal-provider/`.

## Related decisions

- ADR-0003 — E19; the central property is untouched (the page keys on the provider id in a PATH,
  never on a name).
- ADR-0007 — `accepts`, which a declared secret carries.
- ADR-0019 — its amendment's lesson: a generic path must be exercised by the product.
- ADR-0021 — `sshCidrList` is its two-act guard as a declared kind, and its `managesSshAccess`
  requirement.
- ADR-0026 — the personal providers this exists to give a panel to.
