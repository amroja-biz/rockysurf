# Wiring a provider in

`docs/writing-a-provider.md` says registration is "one row in `packages/rockysurf/src/compose.ts`",
and the composition root's own docblock says "adding a provider is one row in the table below — no
core change, no new interface."

**That is true of the composition root and false of the job.** It describes the *interface* cost,
which really is one row, and it reads as the *total* cost, which is not. An in-tree provider
touches around sixteen places. Several fail in ways that look like something else, and one of them
— core's config section — makes fields silently unusable rather than merely undocumented.

Work down this list in order. Paths are from the repository root.

## Mandatory: it will not work at all without these

### 1. The composition root row

`packages/rockysurf/src/compose.ts` — the import, then one row in `WIRINGS`.

```ts
{
  factory: myProviderFactory,
  section: (config) => config.providers.mycloud,
  credentialField: 'token',   // or null when credentials are ambient or absent
  input: ({ enabled: _enabled, ...rest }, credential) => ({
    ...rest,
    ...(credential ? { token: credential } : {}),
  }),
  credentialHint: 'set providers.mycloud.token in rockysurf.config.yaml (e.g. "${MYCLOUD_TOKEN}"), or paste it in the setup wizard',
}
```

| field | what it does |
|---|---|
| `factory` | the package's default export |
| `section` | selects the raw section out of the parsed core config |
| `credentialField` | the config key holding the secret, or `null`. `null` also disables the "enabled but no credential" skip, which is what you want for an ambient credential chain (AWS, Azure, GCP all use `null`) |
| `input` | maps the raw section to the provider's own schema input. **Always strips `enabled`** |
| `credentialHint` | the operator-facing sentence in the boot log and in the registry's `unavailableReason`. Write it as an instruction, not a noun phrase |

**`enabled` is stripped because it is core's field** — orchestration, not provider configuration —
and every provider schema is a `strictObject`, so passing it through is rejected outright. That
rejection is the boundary working, not a bug.

**Credentials resolve config-first, then the ENVIRONMENT — and nothing is ever stored** (issue
#280; `compose.ts`, `resolveCredential`). A credential written in the config file — usually as
`${MYCLOUD_TOKEN}`, the variable's NAME — is the one an operator can see, diff and roll back, so it
wins. With the field empty, the composition root reads the variables `PROVIDER_CREDENTIAL_ENV` names
for a shipped provider, or `factory.credentialEnv` for a personal one, and hands the value straight
to `configSchema.parse` under `credentialField`. There is no wizard credential box and no
`provider-token` secret kind — both were deleted in #280 so that "Rocky Surf stores no cloud
credentials" is unconditionally true. A variable exported after boot takes effect at the **next
restart**, because a variable cannot appear inside a running process.

A provider that is enabled but cannot be built is **reported and skipped, never fatal** — the
control plane still starts, because the UI is where an operator fixes it.

### 2. The composition root's package.json

`packages/rockysurf/package.json` — add `"@rockysurf/provider-mycloud": "workspace:*"`, and update
the lockfile.

### 3. Core's config section — the one that fails silently

`packages/core/src/config/schema.ts` — a new `mycloudProviderSchema`, plus a key in
`providersSchema`.

**This is the step the standard does not mention and the one that will waste the most time.** Core
validates the operator's YAML with its *own* `strictObject`, separate from the schema in the
provider package. The two describe the same section twice and can drift. The consequence:

> A provider field missing from core's section is not merely undocumented — it is **unusable**. The
> operator writes it, core rejects the whole file with "unrecognized key", and nothing points at
> the provider.

So mirror **every** field the provider's own schema accepts, as optional. This has already gone
wrong: `providers.aws.allowAllCidr` is documented in `SECURITY.md`, in `docs/providers/aws.md` and
in the example config, and core's AWS section does not declare it, so the documented procedure for
opening SSH deliberately cannot be expressed (`rockysurf-p5jr`). The GCP section declares all of
its fields specifically so it would never have that shape.

Recorded as friction in the schema itself: the natural fix is a `configSchema` exported by each
provider and handed to core at registration time, which would delete this whole class of drift.
Until someone does that, mirror by hand and check both files. In tree, `settings-parity.test.ts`
(in `packages/rockysurf`) fails when your declared settings and core's mirrored section disagree.

**DO add `sizes`** — as `z.array(z.string().trim().min(1)).nonempty().optional()`, like every other
section. It is core's allowlist and core DOES consume it: `app.ts` applies it to every catalogue
before anything resolves against it, `config/schema.ts` cross-validates saved tier preferences
against it, and the Settings page shows it read-only. (An earlier version of this page said the
opposite and cited the very ticket, `rockysurf-j10e`, that made it consumed.) Compose strips it
before the provider's own schema sees the section, along with `enabled`.

### 4. The dependency lint

`scripts/check-core-deps.mjs`, in **four** places:

- `FORBIDDEN['@rockysurf/core']` — core must not import your provider
- a `'@rockysurf/provider-mycloud': ['@rockysurf/core']` row — your provider must not import core
- `FORBIDDEN['@rockysurf/provider-sdk']`
- the composition-root required-dependency list, which fails the build if
  `packages/rockysurf/package.json` lacks your package: *"composition root is missing … — providers
  would not reach the registry"*

That last list is hand-maintained and has already drifted — `@rockysurf/provider-byo` is wired in
`compose.ts` and absent from it. Add yours; do not assume the list is complete.

## Needed for correct behaviour, and for the test suite to pass

### 5. The wizard's display name

`packages/core/src/setup/state.ts` — `DISPLAY_NAMES`. Without it the setup wizard shows the bare
provider id, because the lookup falls back to `id`.

### 6. The credential environment variable

`packages/core/src/setup/state.ts` — `PROVIDER_CREDENTIAL_ENV`, the variables a shipped provider's
credential may arrive under. Two readers, kept agreeing by sharing the table: the composition root's
fallback when the config field is empty (config wins, then env — never the other way round), and the
wizard's "`MYCLOUD_TOKEN` detected" after the export-and-restart loop. A personal provider declares
the same list on its factory as `credentialEnv`. There is nothing in `secrets/store.ts` about
provider credentials any more, and nothing "refuses to persist over" an environment variable,
because nothing persists.

### 7. The settings inventory — and why a declared provider needs no rows in it

`packages/core/src/settings/fields.ts` is the hand-written inventory of what the Settings page edits,
and since ADR-0027 it is hand-written for CORE'S OWN sections. A provider declares its panel on its
factory (`settings`: fields with kinds, labels and help, the machine-type vocabulary, advisories) and
`settings/inventory.ts` turns that declaration into rows at request time. **No shipped provider has
rows in `fields.ts`** — issue #370 moved the last four — so there is no static block to copy and none
to add. Copy a factory instead: Hetzner for a token cloud, GCP for a firewall cloud, BYO for one with
a list.

What is still true: the settings API refuses to save any path not in the merged inventory (*"this
settings page does not edit that field"*), so a field your declaration does not name is edited in the
file; and a credential-named field must be declared `kind: 'secret'` — `fields.test.ts` names each
declared provider in `DECLARED_BY_PROVIDER` and `settings-parity.test.ts` asserts the factory really
declares its credential secret. The two halves together are what stops `providers.digitalocean.token`
from ever coming back in a JSON body.

The three touch points an earlier version of this page missed no longer exist at all: the
`['aws', 'azure', 'gcp']` whitelist loop in the SPA is derived from the inventory, the
`TIER_PREFERENCE_CLOUDS` table is gone and its rows are generated from `settings.offering`, and the
`providers.*` entries of `SETTINGS_LISTS` are gone and are generated from `settings.lists`.

### 8. The Settings page — nothing to do

`packages/web/src/pages/SettingsPage.tsx` draws a declared provider's panel with no edit: labels and
placeholders from the declaration, the `sshCidrList` kind with the same CIDR control every shipped
cloud now gets through that same kind, advisories at the panel's head. There is no hand-written
provider block left in the file to imitate or to fall back on. There is no `SECTION_ORDER`; sections come from core in
the order core sends them, and a declared provider's tab slots into the order the page has always
had (Hetzner first, then AWS, Azure, GCP, BYO; personal providers after, in file order).

The only hand-written per-cloud code left in the SPA is the wizard's setup steps
(`WizardPage.tsx`, the sanctioned exception, with a generic fallback for any id it does not know).

### 9. Wizard copy (optional)

`packages/web/src/pages/WizardPage.tsx` — optional per-id label, placeholder and hint. There is a
generic fallback, so skipping this degrades rather than breaks.

This is the **sanctioned exception** to the no-provider-id-conditionals rule. Everywhere else in
the SPA, provider-id conditionals are banned and grep-tested. Do not take this file as licence to
branch on `provider.id` elsewhere — the whole point of `ProviderCapabilities` is that it is the
complete set of behavioural differences core can see.

### 10. The example config and the env example

- `rockysurf.config.example.yaml` — a `providers.mycloud` block. A test parses this file.
- `.env.example` — enforced: a test fails if the example config references a `${VAR}` that is not
  documented here.

## Docs and checks

### 11. Documentation

- `docs/providers/capability-matrix.md` — a column, **in the same pull request**, with a note on
  how each value was established. A value nobody has exercised must say so.
- `docs/providers/mycloud.md` — if the provider has operator-facing consequences worth stating.
- `docs/self-hosting.md` — a table row.

### 12. Conditional checks

- `scripts/check-npx-closure.mjs` — only if a vendor SDK was taken. Add the dependency to its
  rules, with fixture tests proving the check fails in **both** directions when broken. Mirrored in
  `packages/core/src/npx-closure.test.ts`.
- `scripts/refresh-prices.mjs` — only if prices are bundled.

### 13. Real-cloud verification

"Before it merges" demands a capability-matrix column with per-value evidence, and this is how the
evidence is obtained: **the nightly real-cloud run**, `.github/workflows/nightly-real-cloud.yml`. It
is hand-written per cloud — a job per cloud with its own OIDC or token setup, a
`deploy/<cloud>/setup-nightly.sh` that creates the CI-only identity and reads it back to verify what
it made (`docs/memories/2026-08-31-setup-scripts-verify-what-they-claimed.md`), a sweep identity
that reaps leaks, and `CLOUD === '<id>'` branches in `scripts/e2e/lifecycle.mjs` for the parts of a
lifecycle that differ (which credential to read, what to preflight, how to build the config). The
config that run boots on is validated on every pull request by `packages/rockysurf/src/e2e-config.test.ts`
(#346), so extend that when you add config keys.

**A provider without a nightly leg ships a fully daggered column, and says so.** That is honest and
allowed — the `byo` column is the model — but say it plainly in the README's "Verified" section and
in the PR rather than letting the next reader discover it. The leg is separate, larger work than the
package, and should be its own issue.

## Tests that enumerate providers and will fail until updated

These do not indicate a mistake; they are the enumeration working. Update them:

- `packages/core/src/setup/setup.test.ts` — asserts the exact sorted provider id list
- `packages/rockysurf/src/compose.test.ts`
- `packages/core/src/config/config.test.ts`
- `packages/core/src/settings/fields.test.ts`

## Out of tree: a personal provider

An out-of-tree provider skips all of the above. Since ADR-0026 it does not build its own
composition root either: the operator installs the package under `<dataDir>/providers` (or points
at a path) and names it in their config file —

```yaml
providers:
  mycloud:
    package: "@you/rockysurf-provider-mycloud"
    enabled: true
    token: "${MYCLOUD_TOKEN}"
```

— and Rocky Surf loads it at start, composes it beside the shipped five, and gives it a Settings
panel with its Enabled switch. The trust model is one sentence and your README should carry it: **a
provider runs with Rocky Surf's full access — install ones you trust.**

What still applies: the SDK contract, conformance, the trap checklist, and the honesty rules about
capabilities and verification. What a personal package must add: the default export IS the factory
and `factory.id` equals the config key; the manifest's entry resolves (import-only `exports` are
fine); `credentialField` and `credentialEnv` on the factory say where a token lands and which
variables may supply it; and errors are `ProviderError`s from your own SDK copy, which core's
structural `isProviderError` accepts. The operator-facing side is `docs/self-hosting.md`, "Personal
providers" (in the checkout).

Its Settings panel comes from `factory.settings` (ADR-0027): declare your fields with kinds, labels
and help, the cloud's machine-type vocabulary, and any advisories, and the page is built from them —
including the two-act SSH whitelist (`kind: 'sshCidrList'`, which requires `managesSshAccess`).
Conformance parses every declared `example` through your `configSchema`. Items 7 and 8 above are
therefore NOT needed for a declared provider, in tree or out: Hetzner has no rows in `fields.ts` and
no block in `SettingsPage.tsx` for exactly this reason, and is the shape to copy. (This reference is
refreshed in full by the skill's next revision; the standard is `docs/writing-a-provider.md`,
"Declare your settings".)
