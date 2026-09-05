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

**Credentials resolve config-first, then the encrypted secrets store.** A credential written in the
config file is the one an operator can see, diff and roll back, so it wins. A credential pasted in
the wizard takes effect at the **next restart**, because providers are constructed at boot.

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
Until someone does that, mirror by hand and check both files.

Do **not** bother adding `sizes` to a new section. It is core-only, compose strips it, and on this
branch nothing consumes it (`rockysurf-j10e`).

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

`packages/core/src/secrets/store.ts` — `PROVIDER_CREDENTIAL_ENV`, if an environment variable can
supply the credential. This drives "env wins, and refuse to persist over it", which is what stops
the wizard from writing a credential that the environment then silently overrides.

### 7. The settings inventory

`packages/core/src/settings/fields.ts` — rows in `SETTINGS_FIELDS` **and** an entry in
`SETTINGS_SECTIONS`. The settings API refuses to save any path not in this inventory: it is not a
general-purpose YAML writer, and an unknown path returns *"this settings page does not edit that
field"*.

It is hand-written on purpose. A form generated from the zod schema would produce a control for
every field the schema happens to have, including ones that must not be editable from a browser,
and would render a `${VAR}` reference and a literal token as the same text box.

**A credential-named field must appear here or `fields.test.ts` fails by design** — the test exists
so that adding `providers.digitalocean.token` to the config schema, and forgetting this file,
cannot start returning a live token in a JSON body. That test also pins the exact secret list, so
it changes too.

### 8. The Settings page

`packages/web/src/pages/SettingsPage.tsx` — `SECTION_ORDER`, plus a hand-written `<section>` block.
Not schema-driven; adding a provider means frontend work or it gets no settings UI.

**Proof that this step gets skipped:** GCP is a fully wired provider — compose row, core schema
section, docs, bundled prices — and has *zero* presence in both `fields.ts` and `SettingsPage.tsx`.
On this branch GCP is configurable only by hand-editing YAML.

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

What it does not yet get is a Settings panel for its own fields — those are edited in the file
until the provider declares them.
