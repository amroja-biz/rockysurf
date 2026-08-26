---
KEY: azure-core-quota-is-a-second-gate
DATE: 2026-08-26
UPDATED: 2026-08-26
STATUS: active
SOURCE: issue #116, the real-Azure runs of 2026-08-25/26, and the owner's `az vm list-usage` probe
---

# Azure core quota is a second gate, and `locations/usages` is trustworthy enough to gate on

Azure refuses a VM create twice. `Microsoft.Compute/skus` answers "is this size sold to this
subscription in this region"; `Microsoft.Compute/locations/{location}/usages` answers "how many
vCPUs of this FAMILY, and in this region in total, may the subscription run". A size can pass the
first and fail the second at the VM PUT with `OperationNotAllowed … Current Limit: 0`.

**On a fresh Pay-As-You-Go subscription most families are at zero.** The owner's probe on
2026-08-26 had 104 of 232 rows at `limit: 0`, including both B-series burstable families — the
cheapest sizes, and therefore what the `small`/`medium`/`large` resolver picked first. Every
create on those failed; every create on a family reporting 10 succeeded. Upgrading a free account
lifts the spending limit and does not touch quota.

**An earlier session distrusted the endpoint** ("`az vm list-usage` reported limit 0 for a region
where creates succeeded"). The probe settled it: the two families at 0 were exactly the two that
failed, and every family that succeeded reported 10. The earlier reading was almost certainly a
family mismatch (checking one family's row against a create in another), not the endpoint lying.

Rules that follow:

- The size list reads both gates (`quotaRefusal()` in `provider-azure/src/offerings.ts`) and
  carries the reason on `Offering.unavailableReason`, so the UI says "no core quota for X" and
  not "sold out" — the remedies differ.
- The family join is **case-insensitive**: `skus` says `StandardDalsv7Family`, `usages` says
  `standardBpsv2Family`; Azure is not consistent about the leading capital.
- The regional `cores` row is a gate too, not just the family.
- **Unreadable quota is not "no quota".** A credential on the pre-#116 Catalogue Reader role gets
  `AuthorizationFailed`; the provider degrades to the SKU gate alone and warns once. Never mark a
  size unavailable on the strength of a read that failed.
- `currentValue` moves with every create, ours included, so the read is cached for a minute, not
  for the process.
