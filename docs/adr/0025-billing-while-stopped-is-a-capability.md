# ADR-0025: Whether a stopped machine still bills is a capability, and the meter reads it

## Status

Accepted — 2026-09-04. Issue #294 (the DigitalOcean audit's gap S1). **Amends
[ADR-0003](0003-provider-sdk-shape-and-exclusions.md)** as amendment E17, in the E12–E16 shape:
one optional field on `ProviderCapabilities`, absent meaning the old behaviour, no shipped provider
changed. Migration 0020.

## Context

`packages/core/src/db/repositories/servers.ts` defines which provider states cost money:

```ts
export const BILLING_INSTANCE_STATES: readonly InstanceState[] = ['pending', 'running', 'stopping']
```

and its comment said why `stopped` was absent: *"compute billing ends there on every provider core
speaks to."* That sentence was true of the five shipped providers and false of the first cloud the
`adding-providers` skill was pointed at. A powered-off DigitalOcean droplet keeps billing at the
full compute rate, because the hypervisor resources stay reserved, and DigitalOcean offers no
`deallocate`-shaped call to choose instead. Azure has both (`powerOff` bills, `deallocate` does
not) and the shipped provider chooses `deallocate`; DigitalOcean offers only the one that bills.

So a DigitalOcean provider written against the frozen SDK had two answers and both were lies:

- `stop: true` — true by the SDK's definition (restartable, disk intact) — and core would stop
  accruing the moment `describe()` said `stopped`, while the cloud went on charging. `isBillingRow`'s
  own doc comment names under-reporting as *"the bug"*: over-reporting makes a user terminate
  something they did not need; under-reporting makes the spend cap a fiction.
- `stop: false` — a lie about the API, and it throws away stop/start and the idle auto-stop lever
  the capability matrix calls v0.1's cost lever.

Core is forbidden to learn this from a provider id (ADR-0003's central property, grep-enforced),
and `ProviderCapabilities`' own doc comment prescribes the answer: *"If core needs to know
something a flag here cannot tell it, the answer is a new flag, not a special case."*

Four things read the billing predicate today: the uptime ticker (`jobs/uptime-ticker.ts`, through
`listBillingServers`), the spend tracker's unpriced count (`jobs/limits.ts`), the `billing` block
the server routes serialize for every front end (`servers/routes.ts`), and the `billingSince`
anchor `recordProviderState` stamps. All four read `isBillingRow(row)`, a pure function of the row.

## Decision

1. **A new optional capability, `ProviderCapabilities.billsWhileStopped`.** Absent means `false`,
   which is what all five shipped providers declare by saying nothing. `true` means a `stopped`
   instance accrues compute charges **at the same hourly rate as a running one**.
2. **A provider MUST set it when a stopped instance is charged at the running rate, and MUST NOT
   set it for a cloud that charges a reduced rate while stopped.** Core accrues the running rate
   and would over-report; a reduced-rate cloud needs a capability that does not exist yet, which is
   an ADR question and never an approximation — the hard rule the `adding-providers` skill teaches.
   A cloud that offers both a billing and a non-billing off-state MUST use the non-billing call and
   leave the flag absent, as Azure does.
3. **Core records the provider's answer on the server row**, `servers.bills_while_stopped`
   (migration 0020), written by `recordProviderState` from `provider.capabilities.billsWhileStopped`
   at both places the lifecycle hears from a provider — the `provision()` result and every
   `describe()`. It is refreshed on every read, `unknown` included: the capability is a fact about
   the provider, not about the read, so a row from before the column existed picks it up at its
   first sync after upgrade.
4. **`isBillingRow` stays a pure function of the row.** `billingStatesFor(row)` is the base list
   plus `stopped` when `row.billsWhileStopped`; the predicate and the `billingSince` stamp both read
   it. Nothing in the ticker, the spend tracker or the routes is handed a registry lookup.
5. **Every front end learns it through what it already reads.** The `billing` block on a server
   appears for a `stopped` row exactly when the provider said so; the web server page prints one
   sentence beside the Start button ("Stopped, and still billing … Terminate it to stop the
   charge"); the New Server page warns before the machine exists ("Stopping a … server does not
   stop its charges"); the MCP `list_providers`/`get_provider` records carry the optional
   capabilities and the tool description names `billsWhileStopped` as the thing to check before
   `stop_server`. The web bundle imports the SDK's `ProviderCapabilities` type instead of a
   hand-copied five-field version that had already drifted.
6. **Conformance checks the type, not the value.** `assertProviderShape` requires the optional
   capabilities to be booleans when present. Whether the value is true of the cloud is the
   capability matrix's job, with the same dagger discipline as every other row.

### Two sources for one fact, and why they cannot disagree in a way that matters

After this decision the answer exists in two places: the live `capabilities.billsWhileStopped` on
the provider in the registry, and the `bills_while_stopped` column on each server row. They answer
different questions. The live capability answers *"what happens if you create a machine here"* —
the New Server page reads it. The row column answers *"what is happening to THIS machine"* — the
meter and the server page read it. The one case where they could differ is a provider that changes
its declaration between releases, and the row is refreshed on the very next `describe()`, so the
window is one poll. The row is the provider's **last word about the machine**, in the same category
as `providerState` and `providerStateAt`, and not configuration copied into data.

## Considered options

- **A live registry lookup instead of a column** — `isBillingRow(row, capabilitiesOf)` threaded
  into the ticker, the spend tracker and the routes. Rejected in review. The ordinary case it gets
  wrong is not an uninstalled provider but an operator setting `enabled: false` on a cloud that
  still has stopped, billing machines: composition drops the provider from the registry, the lookup
  returns absent, accrual stops, and nothing on the page says so — under-reporting, silently. The
  column keeps the last answer the way `providerState` already does for an unreachable cloud.
- **A billing-model enum** (`billingModel: 'stops-at-stop' | 'bills-while-allocated' | …`).
  Rejected. A required field is a breaking change for every provider written outside this
  repository; an optional one with a default is the boolean wearing a longer name. The only question
  core computes with is binary, and a third value (a reduced rate) would invite a number nobody has
  measured — core has never priced disks either, for the same reason. If a cloud needs it, that is
  a new ADR with the evidence in hand.
- **`stop: false` for DigitalOcean.** Rejected as a lie about the API that also discards the idle
  auto-stop cost lever. This is the approximation the skill's hard rule now forbids.
- **Provider-supplied advisory text alone.** Rejected: text cannot make the meter compute. The
  spend cap has to *calculate* with "a stopped droplet still bills", and free text where a number
  is due means the spend figure silently lies. Advisory text is for what only the human needs to
  know (issue #294's second kind of variability), and this is the first kind.

## Consequences

### Positive

- An honest DigitalOcean provider is writable: `stop: true, billsWhileStopped: true`, and every
  surface that shows money tells the truth about a stopped droplet.
- No shipped provider changes. The migration adds a defaulted column; every existing row reads
  `false`, which is what every shipped provider means.
- The predicate stays pure and the three consumers stay untouched — less code than the lookup
  design, not more.

### Negative

- A field on the row that is `false` for every shipped cloud, carried by every server, for a
  provider that does not yet exist in this repository. That is the same honest shape as
  `hostKeyFingerprint` (E12) and `sshPort` (E13).
- The meter now runs on a stopped machine, and the estimate on such a server keeps growing while
  it sits. That is the correct number; it will surprise anyone whose mental model came from AWS.
- A cloud that bills a reduced rate while stopped still has no honest answer — stated plainly
  rather than papered over with the flag.

### Risks and mitigations

- **Risk:** an author sets the flag on a reduced-rate cloud because it is "closer than false".
  **Mitigation:** the MUST NOT in the doc comment, the skill's hard rule, and the matrix row that
  demands evidence per value.
- **Risk:** a row created before this release never learns the flag. **Mitigation:** the column is
  refreshed on every provider read, `unknown` included, so the first sync after upgrade sets it.
- **Risk:** the two sources disagree. **Mitigation:** stated above — they answer different
  questions, and the row follows the provider within one poll.

## References

- Issue #294 — the DigitalOcean audit (gap S1) and the settled direction.
- `packages/provider-sdk/src/capabilities.ts` — `billsWhileStopped`.
- `packages/core/src/db/repositories/servers.ts` — `billingStatesFor`, `isBillingRow`,
  `recordProviderState`.
- `packages/core/src/db/schema.ts` — `servers.billsWhileStopped`; `packages/core/drizzle/0020_bills-while-stopped.sql`.
- `packages/core/src/servers/bills-while-stopped.test.ts` — the row keeps billing after the cloud is
  disabled, and every shipped-shaped provider is unchanged.
- `docs/providers/capability-matrix.md` — the new row.

## Related decisions

- ADR-0003 — the freeze this amends (E17). E15 (`simulatedInstances`) is the precedent: an optional
  capability added because one provider could not tell the truth without it.
- ADR-0009 — why `hourly` can be `null`; an unpriced stopped machine is counted, not costed.
- ADR-0017 — settings apply on save; switching a cloud off rebuilds the registry, which is the case
  clause 3 exists for.
