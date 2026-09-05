# The contract, and the ways it has been got wrong

Nine required methods, one optional method, eight capability fields (five required, three optional).
The authoritative types are in `@rockysurf/provider-sdk` and the doc comments there carry the
reasoning — read them. This page is what the types cannot say: which parts have already cost
something, and what to do instead.

Every trap below must be **pinned by a test with literal values**. A comment does not fail CI when
a maintainer "fixes the typo", and that is exactly the edit these traps invite.

## The nine methods

| method | the thing to get right |
|---|---|
| `validateCredentials()` | prove the credential, loudly. An unreachable host or a read-only token is reported here, not later |
| `validateSpec(spec)` | reject a spec the cloud will reject, before anything is created |
| `listOfferings()` | machine types with prices. A price you do not know is `null` — the SDK defines that as *unknown, never free*, and `0` renders as free |
| `provision(spec)` | create it. Return enough `ProviderData` to find it again |
| `describe(data)` | current state. Both the absence grace and the status mapping live here |
| `terminate(data)` | idempotent — not-found is success |
| `listManaged()` | everything you created, each tagged `server-owned` or `shared` |
| `stop(data)` / `start(data)` | required **even if the cloud cannot stop** |
| `syncSshAccess(options?)` | **optional** — present exactly when `capabilities.managesSshAccess` is true. Push the operator's saved whitelist at the shared firewall object without provisioning. [ssh-access.md](ssh-access.md) |

`stop`/`start` exist even when unsupported: throw `unsupportedOperationError(providerId, 'stop')`
and set `capabilities.stop = false`. Core branches on the capability flag and never on
`typeof provider.stop === 'function'`, because two ways to ask the same question is how they drift
apart. `@rockysurf/provider-byo` is the worked example, in a checkout.

(Pass the id explicitly rather than `this.id` — if the provider is built as a closure returning an
object literal, which is the shape the scaffold uses, `this` is not what you want.)

The exact type shapes for every argument and return value are in [types.md](types.md).

---

## Trap 1 — the status vocabulary collision

**Your cloud's status strings and the SDK's `InstanceState` may share a spelling and mean different
things by it.** This is the single most dangerous mapping in a provider.

The SDK's states, and what each one licenses the caller to do:

| state | meaning |
|---|---|
| `pending` | accepted and coming up, not yet reachable |
| `running` | usable, and billing |
| `stopping` | on its way to `stopped` |
| `stopped` | **stopped with its disk intact, restartable via `start()`.** Usually still billing for storage |
| `terminating` | irreversibly on its way out, but **not gone yet** — the resources have not been released, so a reconciler must treat it as still present |
| `terminated` | gone. The provider has released the resources |
| `failed` | the cloud says the instance is broken |
| `unknown` | the provider returned a state this SDK does not model. **Never guess on the caller's behalf** |

Note that `stopped` is defined by what the caller can *do*, not by what it costs. That is what lets
two different "off" states collapse into one.

### The two real collisions

**GCE reports a stopped instance as `TERMINATED`.** Google's own docs define it as "the instance
has stopped (either by explicit action or underlying failure)" — that is the SDK's `stopped`. GCE's
word for a real teardown is `DEPROVISIONING`. Mapping GCE's `TERMINATED` onto the SDK's
identically-spelled `terminated` tells core a live, disk-billing resource is gone; core stops
tracking a disk the operator keeps paying for, and `terminate()` no-ops on a row already believed
terminated.

**Azure has two off states where the SDK has one.** `PowerState/stopped` is Stopped(Allocated) and
still bills compute at the full rate; `PowerState/deallocated` has released the compute. Both are
the SDK's `stopped`, because both are restartable with the disk intact. `deallocated` reads like
"the resources are gone" and is not — mapping it to `terminated` reaches the same data-loss bug by
a different road. Azure's `Deleting` is the one that means teardown, and it maps to `terminating`.

A maintainer who knows the SDK vocabulary and not the cloud's will read `TERMINATED: 'stopped'` as
an obvious typo. Pin it so that fixing it fails a test whose name explains why:

```ts
it('is exactly this mapping, so a future edit cannot pass unnoticed', () => {
  expect(MYCLOUD_STATE_MAP).toEqual({ /* every key, with the trap commented inline */ })
})

it('never maps anything to terminated', () => {
  // `terminated` is reserved for ABSENCE, and only after the propagation grace.
  expect(Object.values(MYCLOUD_STATE_MAP)).not.toContain('terminated')
})
```

That second assertion is worth copying verbatim. It states the invariant without naming any of the
cloud's status strings, so it survives the vocabulary changing — and for most clouds it is simply
true, because `terminated` should be reached by absence rather than by a status.

### The rest of the rules

- **Export the map** so tests can assert it rather than re-derive it.
- **One cloud status can mean two SDK states.** GCE's `STOPPING` covers both stopping-to-stopped
  and delete-in-progress. Disambiguate with local evidence — GCP records the instances it has
  issued a delete for, and records it *before* the delete call, so a `describe()` racing the delete
  still reads `terminating`.
- **Map to `unknown` rather than guessing.** A status you have never heard of is `unknown`, and if
  the API offers a human-readable message, carry it in `failureReason` — that is the case where a
  human needs the cloud's own words.
- **A state that needs a different resume call is not `stopped`.** GCE's `SUSPENDED` is revived by
  `instances.resume`, not `instances.start`, so calling it `stopped` would advertise a `start()`
  to core that fails. It maps to `unknown`.
- **Prefer a mapping keyed on your own status union**, so the compiler enforces exhaustiveness,
  with a `?? 'unknown'` fallback anyway.

---

## Trap 2 — the absence grace

`describe()` maps absence to `terminated` **only after a propagation grace**. `DESCRIBE_ABSENCE_GRACE`
(4 attempts, 2s apart) is the floor — lengthen it if the cloud needs it, never skip it.

An eventually consistent API reports a just-created instance as missing. Believing the first
not-found marks a healthy, billing instance dead and orphans it, because `terminate()` then
short-circuits on the terminated row.

This is not hypothetical. `@rockysurf/provider-aws` shipped without it: `describe()` believed the
first not-found, core wrote `terminated` onto an instance EC2 had `running`, and the box ran and
billed with nothing in the system pointing at it. Eighty-five tests were green at the time, because
the only provider any of them exercised was the fake — which implements the grace correctly. A rule
that only one implementation is checked against is a rule the next author gets to skip by accident.

Three sub-rules:

1. Absence for an instance **never seen running** is ambiguous — spend the whole grace.
2. Absence that persists past the grace is `terminated`. This is a normal outcome during teardown,
   not an error.
3. Absence for an instance **already seen running** is believed on the **first** read. There is no
   ambiguity, this is the path core polls during teardown, and a grace here is pure delay.

`assertDescribeAbsenceGrace` in `@rockysurf/provider-conformance` asserts all three, and it counts
*reads of your read path* — because a provider that honours the grace and one that skips it return
the same state whenever the instance really is gone, and differ only in how hard they looked.

---

## Trap 3 — ownership, and reaping on failure

`listManaged()` reports secondary resources, each tagged `server-owned` or `shared`. The reconciler
deletes the first kind and never the second. Getting it wrong means either an orphan that bills
forever or a reaper that deletes something another server is using.

Hetzner's provider owns the SSH Key objects it creates. AWS shares one security group across every
server, so it is `shared`.

**A `managed-by` label means "a Rocky Surf made this", not "this run made this".** That distinction
destroyed the repository owner's live Hetzner server: a sweep selected on `managed-by=rockysurf`,
could not distinguish the owner's own machine from an orphan, reported it as a leak and deleted it.
Anything that *destroys* must select on something that identifies the specific server — a
server-id label — and treat "cannot prove it is ours" and "safe to destroy" as different sentences.

Two related defects from the same incident, both worth checking in a new provider:

- **Ownership decided by whether your own create call returned success is wrong.** An API client
  that retries a POST whose response was lost will see the retry fail as a uniqueness error, and
  record a resource it really did create as not-ours — never to be reaped. Decide ownership from
  the labels on the resource, not from the outcome of the call.
- **Secondary resources created before a failing instance create are stranded**, because core marks
  the row failed without storing a handle. Reap them on the way out of the failure path.

And the same incident's rule at the other end of the lifecycle: **refuse a spec whose `managed-by`
tag disagrees with your configured prefix.** An instance tagged with anything else is invisible to
your own `listManaged()` and is therefore an orphan from the moment it is created — the failure is
committed at create time and only discovered by a bill. Assert it in `validateSpec`.

While you are there, **assert `serverId` is hostname-safe rather than sanitizing it**
(`assertHostnameSafeId` ships in the SDK). A sanitizing map would have to be injective and cannot
be: two different logical servers would quietly collide onto one cloud resource.

---

## Trap 4 — idempotency

`terminate()` is idempotent and not-found is success, because reconcilers retry. Returning does not
mean the resources are gone — expect `terminating` on the next `describe()`.

`terminating` instances **stay in `listManaged()`**: they still exist and still hold their disk, so
the reconciler must see them. Only `terminated` is gone.

The SDK ships both predicates and they answer different questions: `stillExistsAtProvider(state)`
is `state !== 'terminated'` and is what a reconciler asks, while `isTerminalInstanceState(state)`
covers `terminated` and `failed`. `terminating` is terminal for scheduling and still present for
reaping, so use the first one when deciding whether something needs cleaning up. Do not re-derive
either by hand.

---

## Trap 5 — exposure posture, and a whitelist that only reaches the cloud at launch

If the cloud has a firewall model, `sshAllowedCidr` is **a LIST, required, with no default** (ADR-0021).
Rocky Surf will not infer a firewall rule from whatever address the operator happens to have today.
A bare string is read as a list of one; an empty list is refused, because a whitelist allowing
nothing is a lockout dressed as a setting.

Opening SSH to the whole internet takes **two** keys, deliberately — `0.0.0.0/0` anywhere in the list
*and* `allowAllCidr: true` — because opening SSH to the internet is two decisions, not one. Use the
SDK's `normalizeSshCidrs` and `opensSshToTheInternet` so every provider agrees, enforce it with a
cross-field refine, and write the rejection message as an instruction:

> `sshAllowedCidr is required: state which network may reach SSH, e.g. "203.0.113.7/32". To open
> SSH to the whole internet, set allowAllCidr: true as well — deliberately.`

**Do NOT "rewrite the rule on every provision" and call it done.** That was this trap's old advice
and it is the exact defect ADR-0021 fixed for three clouds: the saved list reached the firewall at
the next launch and not before, so an operator who changed networks was told their change applied
while every box stayed unreachable. Provision is ADDITIVE and never revokes; the saved list reaches
the cloud through `syncSshAccess()`, declared by `capabilities.managesSshAccess`, and declared to the
Settings page as an `sshCidrList`. The whole of it — the result shape, the never-delete and
authorize-before-revoke rules, and the two proof-of-authorship shapes — is
[ssh-access.md](ssh-access.md). Read it before writing the firewall half of a provider.

Auto-detecting the operator's address from a what-is-my-IP service was considered and rejected: a
firewall rule is a security decision, and a rule derived from a DHCP lease is a rule nobody chose.

---

## Traps for token-and-firewall clouds

Three answers from the research protocol that FIT existing fields but not the way a first reading
suggests. DigitalOcean produced all three; it will not be the last cloud to.

- **The tag charset.** `ProvisionSpec.tags` is `Record<string, string>` and the provider owns the
  encoding. A cloud whose tags are flat strings with a restricted charset (letters, digits, `:`,
  `-`, `_`) cannot write `managed-by=rockysurf`. Choose an encoding that is INJECTIVE for the keys
  Rocky Surf uses (`managed-by:rockysurf` works because neither key nor value may contain the
  separator), filter `listManaged()` on the same encoding, and **refuse a spec whose tag values you
  cannot round-trip** rather than mangling them — trap 3's create-time rule again.
- **A user-data ceiling that is documented somewhere else.** The skill forbids guessing a round
  number and it means it — but "the how-to page publishes no limit" is not the same as "the cloud
  publishes no limit". DigitalOcean's user-data how-to says nothing and its API reference documents
  the create body's `user_data` as "plain text and may not exceed 64 KiB in size", which is a
  transcription rather than a guess. **Read the reference before concluding there is no number.**
  If there genuinely is none, establish it against the real API and say how, or declare the value
  with a dagger in the matrix and in the README as REASONED. `validateSpec()` enforces whatever you
  declare either way.
- **No ARM SKUs at all.** Not a capability, and not a reason to omit anything. Report the offerings
  the cloud sells (all `amd64`), each with its real `available`; core derives the architectures on
  offer from the catalogue and the New Server page says "this cloud sells no ARM", which is a
  different sentence from "ARM is sold out this afternoon" and needs to be.

---

## The eight capability fields

```ts
const capabilities: ProviderCapabilities = {
  stop: true,                 // can it stop and restart with the disk intact?
  ipStableAcrossStop: false,  // does the public IP survive that?
  canInjectHostKeys: true,    // can the box come up presenting a host key core minted?
  userDataMaxBytes: 16384,    // hard ceiling on the rendered document, before transport encoding
  generatesUserData: true,    // does the provider deliver user-data at all?
  // Optional — absent means false. Declare one only when it is TRUE of the cloud:
  //   managesSshAccess: true,   // a shared firewall object core pushes sshAllowedCidr at (ADR-0021)
  //   billsWhileStopped: true,  // a stopped machine bills at the RUNNING rate (ADR-0025)
  //   simulatedInstances: true, // there is no machine at the address reported (test doubles only)
}
```

**There are zero `provider.id` conditionals in shared code, and tests enforce that.** So this object
is not an implementation detail — it is the complete set of behavioural differences core is able to
see. If core needs to do something differently for your cloud and no flag expresses it, that is an
ADR conversation, not a conditional — and not an approximation either. **An approximated capability
passes conformance and lies**; `billsWhileStopped` exists because the first author to face a cloud
that bills a stopped machine stopped and filed the question instead of shipping `stop: false`.

`canInjectHostKeys` requires `generatesUserData`, and conformance checks the dependency: with no
user-data there is no way to place a key before first contact.

**`billsWhileStopped` means the running rate.** Core keeps the meter running through `stopped` at the
machine's hourly price, the server page says "Stopped, and still billing", and the New Server page
warns before the machine exists. A cloud that charges a REDUCED rate while stopped fits no
capability: do not set the flag (over-reporting), do not leave it absent (under-reporting, which
`isBillingRow`'s own comment calls the bug) — stop and file the ADR question. A cloud with both a
billing and a non-billing off-state (Azure `powerOff` vs `deallocate`) uses the non-billing call
and leaves the flag absent.

**`managesSshAccess`** is one claim with `syncSshAccess()`, checked in both directions by
conformance: the flag without the method crashes at the first save, the method without the flag is
never called. [ssh-access.md](ssh-access.md).

**`simulatedInstances`** (ADR-0003 amendment E15) tells core this provider's instances have nowhere
to connect to, so it drives bootstrap in-process instead of over SSH. Absent means `false`, which is
what every provider that touches real hardware declares by saying nothing.

**Set it if and only if there is no machine at the address you report.** A provider that talks to a
real cloud leaves it absent. A provider that simulates — a local libvirt stub, a recorded-fixture
provider — sets it, and the SDK says so explicitly: such a provider "gets the same treatment for
free". The rule that decides it is the MUST NOT, not the pedigree of the package: **never set it
while returning addresses that resolve to real hosts**, because core takes it as permission to skip
the SSH drive entirely and would report a box as installed with nothing installed on it.

**`canInjectHostKeys` is a security posture, not a feature toggle.** `true` means there is no
trust-on-first-use window, and the first connection — the one carrying the secrets file — is
verified against a key core generated itself. Setting it `false` is legal, and it obliges the
provider's docs to say plainly what the operator is trusting instead.

Find `userDataMaxBytes` in the cloud's documentation. Do not guess a round number, and note whether
the documented limit is before or after transport encoding — the SDK's field is the ceiling on the
rendered document, before encoding.

## Prices and currency

Prices ship **bundled and stamped with `fetchedAt`**; live pricing APIs are out of v0. There is one
documented exception, and its reason is narrow enough to be worth stating: Hetzner returns prices
inline on the exact call `listOfferings()` already makes, so preferring a bundled number would mean
showing a figure known to be staler than one already in hand, having saved no request. If the cloud
does not have that property, bundle.

Quote **the currency the cloud bills in**, not USD. The spend cap compares per currency and
deliberately does not sum across them — a project billed in EUR added to an account billed in USD
is a fiction.

A price you do not know is `null`, never `0`.
