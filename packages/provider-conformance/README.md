# @rockysurf/provider-conformance

The shared checks every Rocky Surf compute provider runs against itself. It takes a provider you
built and asserts that it honours the [`@rockysurf/provider-sdk`](https://www.npmjs.com/package/@rockysurf/provider-sdk)
contract — nine methods present, the five required capabilities well-formed and the optional ones
booleans when declared, offerings and managed-resource
records the right shape, errors carrying frozen codes, and `describe()` observing the absence
grace. It is **test-only**: nothing here belongs in a runtime path, and it never becomes a
dependency of your shipped provider.

It is deliberately test-framework-free. Every export takes values and throws `ConformanceError`,
so it runs under vitest, under node:test, or from a plain script — you are not made to adopt a
runner to use it.

## How you get it

```sh
npm install --save-dev @rockysurf/provider-conformance
```

Its only dependency is `@rockysurf/provider-sdk`, so it inherits that package's zero-runtime-
dependency promise and adds nothing to your install closure.

> **Before the first release**, no `@rockysurf` package is on the registry yet, so that command
> 404s. Until it lands, install from a packed tarball — `pnpm pack` in `packages/provider-sdk` and
> in `packages/provider-conformance` from a checkout, then `npm install --save-dev ./<tarball>`.
> The tarball is the same artifact the release publishes.

A provider does not have to live in the Rocky Surf repository. This package is in the published set
precisely so that an out-of-tree provider can run the same acceptance bar the in-tree ones do —
while it was private, the standard pointed authors at a suite they could only get by vendoring the
checks or working inside a checkout.

## Using it

```ts
import { describe, it } from 'vitest'
import {
  assertFactoryShape,
  assertProviderShape,
  assertOfferingsShape,
  assertManagedShape,
  assertProviderErrorShape,
  assertInstanceStateValid,
  assertDescribeAbsenceGrace,
} from '@rockysurf/provider-conformance'
import myProviderFactory from '../src/index.js'

const validConfig = { region: 'eu-central', sshAllowedCidr: '203.0.113.7/32' }

describe('conformance', () => {
  it('has the factory and provider shape', () => {
    // Also asserts createProvider() does no I/O.
    assertFactoryShape(myProviderFactory, validConfig)
  })

  it('returns well-formed offerings', async () => {
    const provider = myProviderFactory.createProvider(validConfig)
    assertOfferingsShape(await provider.listOfferings())
  })
})
```

| export | what it asserts |
|---|---|
| `assertFactoryShape(factory, validConfig)` | the factory's id, display name and `configSchema.parse`; that `createProvider()` returns a provider with the same id and does no I/O; then everything in `assertProviderShape` |
| `assertProviderShape(provider)` | id lowercase and non-empty; all nine methods present — including `stop`/`start` on a provider that cannot stop; the five capability fields well-typed; `canInjectHostKeys` implies `generatesUserData` |
| `assertOfferingsShape(offerings)` | positive cpu and memory, a known architecture, a non-empty region, and prices that are either `null` (unknown) or a finite non-negative amount with an ISO 4217 currency and an ISO 8601 `fetchedAt` |
| `assertManagedShape(resources)` | a non-empty `kind`, a string native id, and an `ownership` from the frozen set — the field the reconciler uses to decide what it may delete |
| `assertProviderErrorShape(err)` | anything thrown across the interface is a `ProviderError` with one of the nine frozen codes and a derived boolean `retryable` |
| `assertInstanceStateValid(state)` | the state is in the SDK's frozen set — the guard against inventing a state name |
| `assertDescribeAbsenceGrace(harness)` | the behavioural one. See below |

## The absence-grace harness

`assertDescribeAbsenceGrace` is the only check here that asserts *behaviour* rather than shape,
and it is the one worth wiring up carefully, because the bug it exists for has already shipped
once.

An eventually consistent cloud reports a just-created instance as missing. A `describe()` that
believes the first not-found marks a live, billing instance `terminated` — after which
`terminate()` short-circuits on the row and nothing ever reaps the machine. That is not
hypothetical: `@rockysurf/provider-aws` shipped exactly that, with eighty-five tests green,
because the only provider any of them exercised implemented the grace correctly.

Behaviour cannot be asserted from the `ComputeProvider` interface alone — it needs your read path
stubbed, and only your tests know how to do that. So you supply a small harness and inherit three
assertions:

```ts
await assertDescribeAbsenceGrace({
  provider: 'mycloud',
  // Optional: the grace the provider under test was built with, if your tests shorten delays.
  grace: { attempts: 4 },
  // A probe over an instance never seen running. The read path answers `script` in order,
  // then repeats the last entry forever.
  neverSeenRunning: (script) => makeProbe(script),
  // A probe over an instance seen running and now absent.
  goneAfterRunning: () => makeProbe(['running', 'absent']),
})
```

Each probe's `run()` calls `describe()` once and reports both the `InstanceView` **and how many
reads of the underlying API it spent**. The read count is the point: a provider that honours the
grace and one that skips it return the same state whenever the instance really is gone, and
differ only in how hard they looked.

The three assertions are that absence which turns out to be propagation lag is never reported as
`terminated`; that persistent absence is believed only after the full attempt count; and that
absence *after* the instance was seen running is believed on the first read, because there is no
ambiguity there and teardown should pay nothing for the grace.

A provider may lengthen the grace. It may never shorten it below `DESCRIBE_ABSENCE_GRACE`.

## What it does not check

Passing is necessary and not sufficient — it is a floor, not a certificate. This suite checks the
mechanical contract and one behavioural rule. It cannot know whether your cloud actually does what
you said it does: whether your status mapping is right, whether `listManaged()` really returns
everything you created, whether your capability flags describe the machine an operator will get.
Those are proved by pointing the provider at real infrastructure and watching a full lifecycle,
and by pinning your status vocabulary with tests of your own.

## Writing your own provider

Start with the contract in [`@rockysurf/provider-sdk`](https://www.npmjs.com/package/@rockysurf/provider-sdk),
then follow
[docs/writing-a-provider.md](https://github.com/amroja-biz/rockysurf/blob/main/docs/writing-a-provider.md)
for the workflow and what has to be true before it merges.
