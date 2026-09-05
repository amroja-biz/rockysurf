# ADR-0026: A personal provider is an npm package named in the config file, loaded with Rocky Surf's full access

## Status

Accepted — 2026-09-04. Issue #294, item 2 of the settled direction. **Amends
[ADR-0003](0003-provider-sdk-shape-and-exclusions.md)** twice: it lifts the "dynamic out-of-tree
plugin loading" exclusion, and it adds amendment E18 — `ProviderFactory.credentialEnv` and
`ProviderFactory.credentialField`, both optional. It also makes `isProviderError` structural.

**Amended 2026-09-05** (owner ruling, reverting PR #390): personal providers are verified by their
author and installer, not by this repository's nightly. See
[the amendment below](#amendment--who-verifies-a-personal-provider-2026-09-05-owner-ruling).

## Context

ADR-0003 cut "dynamic out-of-tree plugin loading" from v0.1 with the rest of the speculative
generality, on the reasoning that there were no out-of-tree consumers to generalize from. The
composition root (`packages/rockysurf/src/compose.ts`) accordingly imports five factories by name,
and `docs/writing-a-provider.md`'s "Out of tree" section told anyone else to build their own
composition root — which is to say, to fork the product.

Issue #294 settled the model: **official providers ship in this repository; users add personal
providers to their own installation without touching this repository; a personal provider that
would help others can be promoted to the shop, later.** That is the Surge Pack model applied to
providers, and it needs exactly the thing ADR-0003 excluded.

Three facts about the repository shaped the mechanism more than any design preference did:

1. **`composeRegistry` is synchronous and re-run on every config change** (`server.ts`, issue
   #264): a settings save adopts the file, rebuilds the registry inline, and answers, and the
   SSH-access sync that follows reads the registry as it stands (ADR-0021 clause 9). `import()` is
   asynchronous. Loading cannot happen inside composition.
2. **`providers` is a strict object.** `providers.nimbus:` is a boot error naming the key
   (`config.test.ts`), and that typo protection is a property worth keeping.
3. **`createRequire(...).resolve(name)` fails on every provider package this repository ships.**
   They declare import-only conditional `exports`, and the `require` resolver answers
   `ERR_PACKAGE_PATH_NOT_EXPORTED`. An author who copies Hetzner — which the skill tells them to —
   produces a package the obvious resolver cannot load by name. Found in review, by running it.

And one about the SDK: `isProviderError` was `instanceof ProviderError`. A package installed
outside the workspace resolves its own copy of `@rockysurf/provider-sdk`, so its `ProviderError`
is a different class, and every error it threw would have been an unexplained 500.

## Decision

1. **A personal provider is one more key under `providers:` whose section names its `package`.**

   ```yaml
   providers:
     digitalocean:
       package: "@someone/rockysurf-provider-digitalocean"   # or a path: ~/code/my-provider
       enabled: true
       token: "${DO_TOKEN}"        # the provider's own fields pass through to its configSchema
       region: nyc3
       sizes: [s-2vcpu-4gb]        # core's allowlist, honoured for every provider
   ```

   Under `providers:` and not in a block of its own because everything in core that knows what
   clouds exist iterates `config.providers` — the wizard, `/health`, composition, the size
   allowlist, `preferences.tiers` — and one more key needs none of them taught a second place to
   look.

2. **The `providers` schema stays strict for the shipped five and admits any other key only when it
   names `package`.** The catchall is on the inner strict object (the `section()` wrapper is a
   `z.preprocess` and has no `.catchall`), typed `unknown` so no shipped section's type is widened,
   with a `superRefine` that: says "did you mean hetzner?" for a key one edit from a shipped id
   with no `package` — the most common way to reach this code is a typo, and telling that operator
   to install a package is confidently wrong; requires a lowercase hostname-safe id; and refuses a
   missing `package` with the instruction. `preferences.tiers` admits any key the same way, and the
   top-level refine refuses a tiers key naming no provider in the file, so `awz` is still a boot
   error. The standalone `preferencesSchema` that `live-preferences.ts` parses alone stays
   permissive — it has no `providers` block to compare against — and the schema comment says not to
   tighten it.

3. **Loading happens once, before boot, in the composition root.** `runRockysurfCli` loads every
   `providers.<id>.package` the config names — enabled or not, so a personal cloud can be switched
   on from the Settings page without a restart — and closes the composition over the result.
   `BootOptions.providers` may return a promise, which `boot()` awaits; every later composition is
   synchronous from the cached factories. A section added to the file after boot is reported as an
   unavailable provider with "restart to load its package". Nothing about a personal provider is
   fatal: cannot find, throws on import, not a factory, id disagrees with the section key — each is
   an `UnavailableProvider` reason on the wizard and the New Server page, and a boot-log line.

4. **Names resolve from `<dataDir>/providers`; paths are imported directly.** The operator runs
   `npm install <pkg>` in `~/.rockysurf/providers` (`/data/providers` in the container). That
   directory is outside the application's own `node_modules`, so `npx rockysurf@latest`,
   `git pull && pnpm -r build`, `./start.sh` and a Docker image rebuild leave it alone. The manifest
   is found with `module.findPackageJSON` (Node 24; stability 1.1, so guarded by `typeof` with the
   `node_modules/<name>/package.json` fallback) and the entry is read from the manifest itself,
   honouring `exports` (string, `.`, sugar form, arrays, nested conditions) in the order `import`,
   `node`, `default`, `require` — `require` LAST and never refused, because `import()` loads
   CommonJS and hands back `{ default: module.exports }` — then `module`, `main`, `index.js`.

5. **`isProviderError` is structural**: an `Error` named `ProviderError` carrying one of the nine
   frozen codes. `retryable` is a getter on whichever copy built the error, so it keeps working.
   Pinned by a test that constructs a look-alike from a second class and a near-miss with a bad
   code.

6. **E18 — `ProviderFactory.credentialEnv` and `credentialField`, optional.** The composition root
   needs two things it used to write by hand per row: the variables a credential may arrive under
   when the config field is empty, and the field to hand the value to. They live on the factory
   because the composition root has the factory before any provider exists, and a chain-auth cloud
   names variables without having any field. The registry carries a `ProviderDescriptor` per
   factory it knows — id, displayName, credentialEnv — loaded or not, so the setup wizard can name a
   disabled personal cloud and report "`NIMBUS_TOKEN` detected" from the same list composition
   reads. Core's `PROVIDER_CREDENTIAL_ENV` table stays authoritative for the shipped five.

7. **A personal section gets a Settings panel and is masked by default.** `settings/inventory.ts`
   builds the inventory per file: every non-shipped `providers.<id>` key contributes `enabled`,
   `package` (`appliesAt: 'restart'`) and read-only `sizes`, and a section titled by the factory's
   `displayName` when it loaded, else by the id. The page's rule 2 draws them generically, so a
   mistyped `package:` is fixable from the page the operator was sent to. `redactTree` takes the
   inventory's predicate: every other scalar leaf of a personal section is masked, because the
   name-based backstop knows `token` and not `privateKey`, and a section core knows nothing about
   is exactly where a literal credential would otherwise come back in the clear. The provider's own
   fields are edited in the file until the provider declares them (the next ADR).

8. **The trust model is full trust, stated plainly.** No sandbox, no second process, no protocol
   fence — the owner's ruling, because a fence a provider could not do its job behind is theatre.
   The obligation that replaces it is one sentence, verbatim in `docs/self-hosting.md`,
   `docs/writing-a-provider.md`, `SECURITY.md`, the panel's help, and the boot log beside every
   personal provider it loads:

   > a provider runs with Rocky Surf's full access — install ones you trust.

   If a shop ever grows to where that is insufficient, review or signing is added at the shop, not
   in the architecture.

## Considered options

- **A `personalProviders:` block of its own.** Rejected: every consumer of `config.providers` would
  need a second place to look, and the first one forgotten would be the one that mattered.
- **A typed catchall (`.catchall(personalSectionSchema)`).** Rejected: it puts an index signature on
  `Config['providers']` and widens `config.providers.aws` to `AwsSection & PersonalSection`, so
  `package` reads as a required field of every shipped section. `unknown` plus a helper keeps the
  five typed and the rest explicit.
- **Loading inside `composeRegistry`.** Impossible without making composition asynchronous, which
  the settings save and the SSH-access sync cannot tolerate (fact 1).
- **`createRequire().resolve()` by name.** Fails on every shipped provider package (fact 3).
- **Refusing a package whose only entry is `require`-conditional.** Rejected in review: a working
  CommonJS package would be refused for a reason its author cannot act on.
- **Resolving from the application's own `node_modules`.** Rejected: an `npx` install's
  `node_modules` is a cache that a version bump replaces, and a checkout's is rebuilt by `pnpm
  install`; a provider installed there is uninstalled by the next upgrade.
- **Forcing a personal package to resolve Rocky Surf's own SDK copy** instead of duck-typing the
  error guard. Rejected: a loader hook to redirect one bare specifier is more machinery than a
  structural check, and the SDK's other exports are plain data and pure functions with no identity
  to preserve.
- **Guessing a personal section's credential field from a key's name** for the wizard's `source`.
  Rejected: a heuristic that is wrong for the next cloud. The factory says (E18) or the wizard says
  `'none'`.
- **A `rockysurf providers install <pkg>` command.** Not built; the two shell commands are in the
  docs, and a wrapper is a follow-on if the docs prove insufficient.

## Consequences

### Positive

- A provider that is not in this repository can be installed, configured and switched on by an
  operator who never clones it, and it survives every upgrade path the docs describe.
- Every failure a personal package can have is reported where the operator already looks, and none
  of them stops the control plane from starting.
- The five shipped providers are composed by the same function a personal one is, so the seam is
  exercised by the product and not only by a fixture.
- The shipped `providers` sections keep their strict typing and their typo protection.

### Negative

- Two `@rockysurf/provider-sdk` copies can now be in one process, and the only cross-copy hazard
  found — the error guard — is fixed structurally. Any future SDK export that relies on identity
  (an `instanceof`, a `Symbol` compared by reference) would break for personal providers, and the
  SDK's charter should say so.
- A personal provider's OWN fields are YAML-only until it declares settings (the next ADR); its
  panel says so rather than pretending.
- `module.findPackageJSON` is stability 1.1; the fallback path is the directory npm puts a direct
  dependency in, which is correct for both npm and pnpm installs into `<dataDir>/providers`.
- A personal section added while Rocky Surf runs needs a restart. Stated on the panel and in the
  unavailable reason rather than worked around with an asynchronous recompose.

### Risks and mitigations

- **Risk:** a personal provider's literal credential reaches the browser through the settings view.
  **Mitigation:** mask-by-default for every undeclared leaf of a personal section, pinned by a test
  that puts a literal in a `privateKey` field and asserts it appears nowhere in the response.
- **Risk:** an operator installs a malicious package. **Mitigation:** none in the architecture, by
  decision; the sentence is printed everywhere the decision is made.
- **Risk:** the settings save's recompose races the SSH-access sync. **Mitigation:** composition
  stays synchronous after boot by contract, `server.ts` logs if it ever is not, and the loader's
  cache is what makes the contract cheap to keep.
- **Risk:** `providers.hetzer:` gets worse advice than before. **Mitigation:** the did-you-mean
  refusal runs before the personal-provider instruction and is pinned by a test.

## Amendment — who verifies a personal provider (2026-09-05, owner ruling)

**2026-09-05, owner ruling: personal providers are verified by their author and installer, not by
this repository's nightly.**

A nightly real-cloud leg in `.github/workflows/nightly-real-cloud.yml` is for OFFICIAL providers —
the ones composed into `packages/rockysurf/src/compose.ts`. A personal provider ships a fully
daggered capability column, verified by its author and by whoever installs it against their own
cloud account; the `byo` column is the model for how that reads.

This settles a question the original decision left open. `packages/provider-digitalocean` is in
this repository as the worked example of a personal provider (issue #368), and a nightly leg was
built for it (PR #390) on the reasoning that nothing else in CI ever loads an installed provider.
That leg was reverted: being the worked example does not make a personal provider official, and
this repository does not hold a long-lived third-party credential or spend money to prove somebody
else's package works. The provider itself stays, and the checks that exercise the shipped tarball
without touching a cloud — the pack-and-install test in
`packages/rockysurf/src/personal-provider-tarball.test.ts` — stay with it.

Where this is written for the people it applies to: `docs/writing-a-provider.md` ("Before it
merges" and "Out of tree: a personal provider"), `.agents/skills/add-provider/references/wiring.md`
§13, and the DigitalOcean section of `docs/providers/capability-matrix.md`.

## References

- Issue #294 (the settled direction; the plan and its review, recorded as a comment).
- Owner ruling of 2026-09-05, reverting PR #390 (the DigitalOcean nightly leg); issues #372 and
  #373 are the by-hand verification of that provider.
- `packages/rockysurf/src/personal-providers.ts` — the loader; `personal-providers.test.ts`.
- `packages/rockysurf/src/compose.ts` — personal wirings and descriptors; `cli.ts` — load once.
- `packages/core/src/config/personal-providers.ts`, `config/schema.ts` — the catchall and refines.
- `packages/core/src/settings/inventory.ts`, `settings/view.ts` — the panel and the mask.
- `packages/core/src/providers/registry.ts` — `ProviderDescriptor`.
- `packages/provider-sdk/src/errors.ts` — the structural guard; `provider.ts` — E18.
- `packages/web/e2e/fixtures/personal-provider/`, `settings-personal-provider.e2e.ts` — the panel
  and the switch-on, in a browser, against the shipped binary.
- `packages/rockysurf/src/bin.e2e.test.ts` — the whole-boot case.

## Related decisions

- ADR-0003 — lifts one exclusion; adds E18. The central property (core branches on capabilities,
  never on ids) is untouched: a personal provider is one more `ComputeProvider` in the registry.
- ADR-0006 — the pack registry's split horizon and "only the operator says which is trusted"; the
  provider shop, when it exists, inherits that posture and this ADR's sentence.
- ADR-0017 — settings apply on save; why composition must stay synchronous after boot.
- ADR-0021 — the sync route's file-versus-process check, which is the reader the synchronous
  recompose protects.
- ADR-0024 — the SDK's charter, which this ADR extends with "and no identity-dependent export".
