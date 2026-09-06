# Scaffolding the package

The layout, from the standard:

```
packages/provider-<id>/
├── package.json          # depends on @rockysurf/provider-sdk; never on @rockysurf/core
├── src/
│   ├── index.ts          # the default-exported ProviderFactory
│   ├── config.ts         # the config schema (zod, or anything with a throwing parse())
│   ├── api.ts            # the HTTP transport, if the cloud is fetch-shaped
│   ├── errors.ts         # cloud error codes → the nine frozen ProviderError codes
│   ├── provider.ts       # the ComputeProvider implementation
│   └── *.test.ts
└── README.md             # published to npm
```

Out of tree, the same shape with your own package name. Nothing here requires the package to live
in the Rocky Surf repository.

**In a checkout**, copy the freshest in-tree provider rather than starting from a blank file:
`packages/provider-gcp` and `packages/provider-azure` are the most recent REST-shaped examples and
carry the most current reasoning in their comments; `packages/provider-hetzner` is the smallest
complete one and the best to read end to end; `packages/provider-byo` is the model for a provider
that cannot stop and does not generate user-data.

**Out of tree you have none of those** — they are not on npm as readable examples and you should not
need them. What you do have, inside the tarballs you installed, is the authoritative contract:
`node_modules/@rockysurf/provider-sdk/README.md` and the fully commented type definitions in
`node_modules/@rockysurf/provider-sdk/dist/*.d.ts`. Start from
[types.md](types.md) in this skill, which is the field lists and the signatures, and read those
`.d.ts` doc comments for the reasoning behind each one.

## package.json

```jsonc
{
  "name": "@rockysurf/provider-mycloud",
  "version": "0.1.0",
  "description": "…",
  "license": "MIT",
  "type": "module",
  "files": ["dist", "README.md"],
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "engines": { "node": ">=24" },
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "@rockysurf/provider-sdk": "^0.1.0", "zod": "^4" },  // zod: in-tree only — see below
  "devDependencies": { "@rockysurf/provider-conformance": "^0.1.0" }
}
```

- **The name.** `@rockysurf/provider-<id>` is for providers that live in this repository; nobody
  else can publish into that scope. A personal provider is `<your-scope>/rockysurf-provider-<id>`
  or, unscoped, `rockysurf-provider-<id>`. The package name is not the provider id: `factory.id`
  is the bare `<id>` and it is the key of the config section either way.
- **A personal provider takes NO runtime dependencies.** The documented install is `tar -xzf` into
  `<dataDir>/providers` — no `npm install`, nothing of yours executed — so a dependency the
  manifest names and the operator does not already have is an import that throws at their next
  start, and the provider is simply not there
  ([`docs/writing-a-provider.md`](../../../docs/writing-a-provider.md), "The artifact must be
  self-contained"). That is why `zod` above is bracketed as in-tree only: out of tree, either
  hand-write the config parser against the structural `ConfigSchema` contract or bundle what you
  use into `dist/`. `devDependencies` are irrelevant to this — they are not in the published
  manifest's `dependencies`.
- **`files` must list `README.md`**, and the README is the page npm shows.
- **Never a dependency on `@rockysurf/core`.** In tree, CI enforces it in both directions; out of
  tree it is still wrong, because core is the thing your provider is decoupled from.
- `@rockysurf/provider-conformance` is a **devDependency**, never a runtime one.
- **In tree, two lines differ**: the two `@rockysurf/*` specifiers become `"workspace:*"`, and the
  build script becomes `node ../../scripts/build-package.mjs`. That script compiles into a scratch
  directory and renames it into place, because `tsc` overwrites but never deletes — a file whose
  source is gone lives on in `dist/` indefinitely, and a `dist/` that is briefly absent makes
  concurrent readers see the package as broken. Out of tree that script does not exist; a plain
  `tsc -p tsconfig.build.json` is fine, and `rm -rf dist` before it if you want the same guarantee.
- Set `"module": "nodenext"` and `"moduleResolution": "nodenext"` in your tsconfig. The SDK is
  ESM-only, so relative imports need the `.js` extension (`from './config.js'`).

## config.ts

A zod `strictObject`. Strict is load-bearing: it is what rejects `enabled` (core's field, stripped
by the composition root) and what turns a typo into an error rather than a silently ignored key.

```ts
import { z } from 'zod'

const CIDR_V4 = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/

import { normalizeSshCidrs, opensSshToTheInternet } from '@rockysurf/provider-sdk'

export const mycloudConfigSchema = z
  .strictObject({
    token: z.string().min(1),
    region: z.string().min(1),
    // A LIST, required, with NO default (ADR-0021): a firewall rule is a security decision. A bare
    // string is read as a list of one so an older file keeps loading; an empty list is refused.
    // `.optional()` here is deliberate and is NOT a contradiction — the refine below is what
    // makes it required, so that the operator sees that message rather than zod's generic one.
    sshAllowedCidr: z
      .union([z.string().regex(CIDR_V4), z.array(z.string().regex(CIDR_V4))])
      .transform((v) => normalizeSshCidrs(v))
      .optional(),
    allowAllCidr: z.boolean().default(false),
    // The label prefix this provider stamps on everything it creates, and the one it REFUSES a
    // spec for if the spec's managed-by tag disagrees. See trap 3.
    managedBy: z.string().default('rockysurf'),
  })
  .refine((c) => c.sshAllowedCidr !== undefined && c.sshAllowedCidr.length > 0, {
    message:
      'sshAllowedCidr is required: state which network may reach SSH, e.g. "203.0.113.7/32". ' +
      'To open SSH to the whole internet, set allowAllCidr: true as well — deliberately.',
  })
  .refine((c) => !opensSshToTheInternet(c.sshAllowedCidr ?? []) || c.allowAllCidr, {
    message: 'sshAllowedCidr "0.0.0.0/0" also requires allowAllCidr: true. Opening SSH to the internet is two decisions, not one.',
  })

export type MycloudProviderConfig = z.infer<typeof mycloudConfigSchema>
```

Write rejection messages as **instructions**. The operator sees this text and it is the whole of
their debugging experience.

Zod lives in the provider's dependencies, never in the SDK's. Any validator with a throwing `parse`
works — the SDK's `ConfigSchema<T>` is structurally `{ parse(input: unknown): T }` precisely so the
SDK can keep zero runtime dependencies.

**A personal provider has nowhere to put zod**, for the reason above: its install resolves no
dependencies. Write the parser by hand against the same structural contract — an object with a
throwing `parse` — and keep the two refines and their instructional messages exactly as they are
here. The messages are the part that matters, and hand-writing them is if anything easier than
bending a library's generic errors into instructions.

## index.ts

The default export is the factory. `createProvider` must be **synchronous and side-effect free** —
no network, no filesystem, no credential check — so core can load a provider, show its identity and
validate its configuration before holding a live instance of it. Credentials are proven separately
by `validateCredentials()`.

```ts
import type { ProviderFactory } from '@rockysurf/provider-sdk'
import { mycloudConfigSchema, type MycloudProviderConfig } from './config.js'
import { MYCLOUD_PROVIDER_ID, makeMycloudProvider } from './provider.js'

export const mycloudProviderFactory: ProviderFactory<MycloudProviderConfig> = {
  id: MYCLOUD_PROVIDER_ID,
  displayName: 'My Cloud',
  configSchema: mycloudConfigSchema,
  createProvider: (config) => makeMycloudProvider(config),
  // Where a token lands and which variables may supply it when the config field is empty
  // (ADR-0026). Nothing is stored; the composition root hands the value to configSchema.parse.
  credentialField: 'token',
  credentialEnv: ['MYCLOUD_TOKEN'],
  // The Settings panel, declared (ADR-0027). Every field an operator sets, in order, with a kind,
  // a label and a sentence; `enabled`, `package` and `sizes` are the installation's — leave them out.
  settings: {
    title: 'My Cloud',
    help: 'Servers at My Cloud, driven with a personal access token from its console.',
    fields: [
      { name: 'token', kind: 'secret', label: 'Token Environment Variable', example: 'MYCLOUD_TOKEN',
        help: 'The NAME of an environment variable holding a read/write API token — not the token itself.' },
      { name: 'region', kind: 'string', label: 'Region', example: 'nyc3', help: 'Which region new servers are created in.' },
      // The two-act SSH whitelist as ONE kind; `allowAllCidr` is implied. Requires managesSshAccess.
      { name: 'sshAllowedCidr', kind: 'sshCidrList', label: 'SSH allowed from', example: '203.0.113.7/32',
        help: 'Which networks may reach SSH on the boxes created here, as CIDRs — your own address as a /32 is the usual answer.' },
    ],
    offering: { noun: 'machine type', example: 'm-2vcpu-4gb' },
    advisories: [
      // Only what a HUMAN needs to know. Anything core computes with is a capability.
      { surface: 'create', text: 'A stopped machine bills at the running rate on this cloud; only terminating ends the charge.' },
    ],
  },
}

export default mycloudProviderFactory
```

Re-export the package's public surface from here too — the api client, the config schema and type,
the error helpers. **Do not re-export the conformance assertions**: they are test-only, and a
provider package should not make its consumers carry a test helper.

## errors.ts

Everything thrown across the interface must be a `ProviderError` carrying one of the SDK's nine
frozen codes, with a derived boolean `retryable`. Write one function mapping the cloud's error
vocabulary onto those codes, and route every call through it.

Watch for clouds with **more than one** error vocabulary — GCE has HTTP `reason` strings *and*
SCREAMING_SNAKE Operation codes, and both need mapping. Check whether the cloud has an async
operation model before assuming an error can only arrive in an HTTP status.

## The first test file

Start with conformance, before implementing anything beyond the factory. It fails usefully:

```ts
import { describe, it } from 'vitest'
// assertFactoryShape ends by calling assertProviderShape, so importing both is redundant.
import { assertFactoryShape, assertOfferingsShape } from '@rockysurf/provider-conformance'
import factory from './index.js'

const validConfig = { token: 't', region: 'r', sshAllowedCidr: '203.0.113.7/32' }

describe('conformance', () => {
  it('has the factory and provider shape', () => {
    assertFactoryShape(factory, factory.configSchema.parse(validConfig))
  })

  it('returns well-formed offerings', async () => {
    const provider = factory.createProvider(factory.configSchema.parse(validConfig))
    assertOfferingsShape(await provider.listOfferings())
  })
})
```

Add `assertDescribeAbsenceGrace` as soon as `describe()` exists — it needs a harness over your read
path, and wiring it late means writing the read path twice.

And add this one as soon as `provision()` exists, against the fake described in the next section.
It is required, not optional, and it is the test that would have caught the first live failure of
a provider built with this skill:

```ts
import { emptyCloud, fakeFetch } from './fake-cloud.js'

describe('provision on a fresh account', () => {
  it('builds every object it references, in the order the cloud requires, from nothing', async () => {
    // NOTHING is seeded. Not the firewall, not a key, not a tag, not a network — the fake holds
    // exactly what a brand-new account holds, and refuses a reference to anything it does not.
    const cloud = emptyCloud()
    const provider = makeMycloudProvider(validConfig, { fetchImpl: fakeFetch(cloud), grace: { attempts: 4, delayMs: 0 } })

    const result = await provider.provision(spec)

    // The chain, in order, by the cloud's own paths: each write before the one that names it.
    expect(cloud.requests.filter((r) => !r.startsWith('GET '))).toEqual([
      'POST /v2/tags',         // the tag the firewall targets — created explicitly, because a
      'POST /v2/firewalls',    //   firewall create does not create it (research question 21)
      'POST /v2/account/keys',
      'POST /v2/droplets',
    ])
    expect(result.initial.state).toBe('pending')
  })
})
```

**Those four paths are DigitalOcean's real ones**, transcribed rather than invented, because the
chain they show is DigitalOcean's — its instance collection is `/v2/droplets` and it has no
`/v2/instances`. Substitute your own cloud's paths, exactly as its API spells them: the assertion
is worth nothing if it names a path the cloud does not have, and a `--refuse` pattern copied from
here (`dry-run.md`) would then match nothing at all on the live run.

The literal list of paths is the point. A test that only asserts `provision()` resolved would pass
against a fake that accepts dangling references, which is the fake this test exists to forbid.

### The cloud-side name comes from `serverId`, never from the display name

One more assertion belongs on the same test, and it is one line:

```ts
    // spec.name is the human's label ("DO skill retest 2"). The cloud's name field is
    // hostname-shaped or worse, so the display name must never reach it.
    expect(cloud.lastBody('POST /v2/droplets').name).toBe(spec.serverId)
```

`ProvisionSpec` carries two names and they are not interchangeable: `name` is Rocky Surf's display
name, chosen by a human and free to contain spaces, punctuation and unicode; `serverId` is core's
id, which the provider asserts is hostname-safe (trap 3) precisely so it can be the name the cloud
sees. Sending `spec.name` fails at the cloud — a real create was refused with
*"Only valid hostname characters are allowed"* — and it fails only on the live run, because a fake
that stores whatever string it is given accepts it happily. Give the spec in your tests a display
name with a space in it, so the assertion has something to catch.
`@rockysurf/provider-conformance` ships `assertProvisionNameFromServerId(spec, sentBodies)` for the
same check ([shipping.md](shipping.md)).

## A fake for the cloud, not a mock of your own code

Every in-tree provider tests against a fake of the *cloud's API* — a `fetch` route table or an
in-memory resource map — rather than by mocking its own methods. That is what lets the tests assert
real behaviour: that `stop()` reaches the state the cloud actually reports, that a replayed create
resolves to the original instance, that `describe()` spends its grace.

**This needs a seam that `createProvider(config)` does not give you**, since it takes one argument
and the tests need to inject both the fake and a zeroed retry delay. Give the underlying constructor
an options parameter that only tests pass — `makeMycloudProvider(config, { api, grace })` — and have
the factory call it with none. The pattern, with the grace-floor guard that belongs in it, is in
[types.md](types.md#the-dependency-seam-your-tests-need).

Make the fake speak the cloud's own vocabulary. GCP's fake sets `TERMINATED` when an instance is
stopped, because that is what a really-stopped GCE box reports — a fake that speaks the SDK's
vocabulary instead would hide exactly the bug the mapping test exists to catch.

### The fake starts empty, and refuses what nobody created

Two rules about the fake, both written after a provider passed seventy-four tests and failed on
its first real create:

1. **`emptyCloud()` holds what a brand-new account holds** — sizes, regions and images, because
   the cloud sells those; and no firewall, no key, no tag, no network, no instance, because a
   fresh account has none. A test may seed the fake to set up a later scenario (a replayed create,
   a stop from `running`), and the seeding is that test's business. **The fresh-account test
   seeds nothing** and `provision()` has to build the whole chain from it, in the order the cloud
   requires.
2. **A reference to an object the fake does not hold is refused, with the cloud's own status and
   message.** A firewall create that names a tag not in `cloud.tags`, an instance create that
   names a key id not in `cloud.keys`, a rule that names a network the fake has never seen — each
   answers the way the real API does (a 404, a 422 `"tag not found"`), never by inventing the
   object. Every answer to research question 21 is one such check in the fake, and the check is
   what turns a missing precondition into a red unit test rather than a refused live create.

A fake that auto-creates whatever a request mentions is comfortable to write and asserts nothing:
it accepts every chain, including the ones the cloud rejects. The route table should be a little
pedantic about existence for the same reason it speaks the cloud's vocabulary — the bugs it is
there to catch are the ones where the author's model of the cloud and the cloud disagree.
