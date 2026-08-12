# `@rockysurf/provider-hetzner`

Hetzner Cloud compute provider. Plain `fetch` against the documented REST API — no vendor SDK,
and therefore no transitive dependency tree to audit or to slow an `npx` cold start.

```ts
import hetzner from '@rockysurf/provider-hetzner'

const config = hetzner.configSchema.parse({ token: process.env.HETZNER_TOKEN, location: 'fsn1' })
const provider = hetzner.createProvider(config)
```

`createProvider` is synchronous and does no I/O, so core can load the provider, show its
identity, and validate its configuration before it holds anything live. Credentials are proven
separately by `validateCredentials()`.

## Pricing: live first, bundled as fallback

**This provider is the documented exception to the bundled-prices rule** (`rockysurf-gyp1.3`).

The general rule from ADR-0003 is that prices ship bundled and stamped with `fetchedAt`, because
live pricing APIs are out of v0. The reason for the exception here is narrow and specific:
Hetzner returns `prices[]` **inline on `GET /server_types`** — the exact call `listOfferings()`
already makes. Preferring a bundled number would mean showing a figure we know to be older than
one already in hand, having saved no request. That is the opposite of what the price-honesty
rule is for.

So the order is:

| source | when | `fetchedAt` |
|---|---|---|
| **live** | the type carries a price for the configured location, and `GET /pricing` reported a currency | now |
| **bundled** | `src/prices.generated.ts` has an entry | when the table was generated |
| **neither** | — | `hourly: null`, which the SDK defines as *unknown, never free* |

Two details worth knowing:

- **Currency comes from `GET /pricing`**, not from an assumption. Hetzner quotes in the
  **project's** billing currency — EUR for most accounts, USD for some — and a number without
  its currency is not a price (amendment B2). If that call fails (a read-only token, a blip),
  offerings are still listed; the provider just falls back to the bundled table rather than
  taking the whole catalogue down.
- **`net`, not `gross`.** Gross folds in a per-account VAT rate, so two customers looking at the
  same machine would see different "prices" for it.

**AWS keeps the bundled-only rule**, because it has no equivalent freebie: its price list is a
separate service, so reading it live would add a runtime dependency for a number that changes a
few times a year. See `packages/provider-aws/src/offerings.ts`.

### Refreshing the fallback table

```bash
HETZNER_TOKEN=… node scripts/refresh-prices.mjs --hetzner
```

Opt-in, and it ships **empty**. Both facts follow from the same thing: Hetzner quotes per
project, so a table built from one account's numbers would be wrong for another — and since
prices are read live anyway, an empty fallback costs nothing in practice.

## `available` is a real signal here

Unlike AWS, Hetzner sells out of whole architectures. At spike capstone time **every CAX (arm64)
type reported `available: false` in all three ARM locations**, while still publishing prices for
them, and a direct order attempt in each returned `412 resource_unavailable`.

That is why `listOfferings()` returns unavailable types with `available: false` rather than
omitting them (amendment B1), and why availability is read **only** from `locations[].available`
— never inferred from the presence of a price. A price is not an offer.

## Three behaviours the port preserves

Each was learned the hard way in the spike, and each is now expressible in the frozen SDK where
the spike had to write a comment instead:

- **The server NAME is the idempotency mechanism.** There is no `ClientToken` equivalent, so a
  replayed create is caught as `uniqueness_error` and resolved to the original server. This is
  why `ProvisionSpec.serverId` must be hostname-safe: any sanitizing map would have to be
  injective, and the obvious one is not.
- **The create call cannot take raw key material**, so the provider creates first-class SSH Key
  objects it then owns and must reap — `ownership: 'server-owned'` (D2). A key matched to
  something that already existed is never claimed, because reaping it would break whoever else
  references it.
- **`deleting` is `terminating`, not `stopping`** (A3). The spike mapped it to `stopping`, which
  the app layer read as `running` — a latent bug that would have resurrected a terminating row.

## Development

```bash
pnpm --filter @rockysurf/provider-hetzner test        # vitest, mocked fetch
pnpm --filter @rockysurf/provider-hetzner typecheck
```

The SDK conformance assertions come from `@rockysurf/provider-conformance`
(`rockysurf-lw72`) — a test-only package, so the SDK's zero-runtime-dependency promise holds.

Real-cloud verification is `rockysurf-55fx.9`; the spike's `spike/verify-hetzner.ts` is the
pattern it follows.
