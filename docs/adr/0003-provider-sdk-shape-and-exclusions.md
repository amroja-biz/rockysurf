# ADR-0003: Freeze the provider SDK shape, with deliberate exclusions

## Status

Accepted — 2026-08-11. This ADR fixes the *shape*; `rockysurf-q5lm.2` writes the actual types
and the capability matrix. Amended by ADR-0009 (2026-08-25): the "live pricing APIs are out of
v0" exclusion is lifted for the AWS/Azure price *table* only, which is now served from a hosted
feed rather than bundled; the SDK shape itself is unchanged. **Amended by
[ADR-0021](0021-ssh-access-is-pushed-on-save-not-only-on-provision.md) (2026-09-01):** amendment
E11 below is the one this ADR said to revisit "if a second provider needs the same call", and
three do — it arrives as `capabilities.managesSshAccess` plus `syncSshAccess()`, the first
OPTIONAL method on the interface, which is a deliberate exception to A2's required-and-throwing
precedent. Core still branches on the flag and never on the method's presence, so A2's central
property is untouched. **Amended by
[ADR-0025](0025-billing-while-stopped-is-a-capability.md) (2026-09-04):** amendment E17 below,
`capabilities.billsWhileStopped`, in the E15 shape — additive, optional, absent means false.
**Amended by
[ADR-0026](0026-a-personal-provider-is-a-package-named-in-the-config-file.md) (2026-09-04):** the
"dynamic out-of-tree plugin loading" exclusion below is lifted — a provider named by
`providers.<id>.package` in the config file is loaded by the composition root before boot — and
amendment E18 adds `ProviderFactory.credentialEnv` and `credentialField`, both optional. The
central property is untouched: a personal provider is one more `ComputeProvider` in the registry.

## Context

`docs/spike/interface-sketch.md` was published as an explicitly non-frozen sketch so the spike
had one concrete thing to implement against. Two real providers (AWS EC2, Hetzner Cloud) plus an
in-memory fake were built on it and run against real infrastructure.

The sketch survived contact. The central property held: there are **zero `provider.id`
conditionals in shared code**, and that is grep-enforced by tests. Every behavioural difference
flows through `capabilities.*`.

But the honest verdict is narrower than "it works". Eight real divergences appeared between the
two clouds and **three had no field to live in**, so they were expressed in prose comments and
provider-local data structures instead — availability, terminal-state semantics, and
secondary-resource ownership. As the memo puts it, that is not provider `if`s leaking into core;
it is leaking into *prose*, which is worse, because nothing enforces a comment. The answer is
fields, not discipline.

The memo issues 32 amendments. This ADR takes a position on every one that touches the SDK.

## Decision

Adopt the amendments below as the shape of provider SDK v0. Amendments E1 and E5 are decided in
ADR-0002; their SDK-facing consequence is A7.

### Interface shape

| # | Amendment | Disposition |
|---|---|---|
| **A1** | Drop the `TData` generic; provider data is an opaque `Record<string, unknown>` | **Adopt** |
| **A2** | One source of truth for `stop` | **Adopt, with a choice** — see below |
| **A3** | Add `terminating` to `InstanceView.state` | **Adopt** |
| **A4** | `describe()` maps absence to `terminated` only after a propagation grace | **Adopt** — highest severity |
| **A5** | Add a failure state to `InstanceView` | **Adopt** |
| **A6** | `provision()` returns an initial `InstanceView` alongside `data` | **Adopt** |
| **A7** | Add `validateSpec(spec)` so providers own their own limits | **Adopt** |

**A2 — the choice the memo left open.** `capabilities.stop` remains the single source of truth,
and `stop`/`start` become **required** methods that throw `ProviderError('invalid_spec')` when
the capability is false. We reject the alternative reading ("presence of the method IS the
capability") because core's whole no-provider-`if`s property rests on branching through
`capabilities.*`, and the capability matrix is itself a deliverable (q5lm.2). A `typeof
p.stop === 'function'` check scattered through core is a second vocabulary for the same fact.
The cost, stated plainly: providers that cannot stop must implement two throwing methods.

**A3 is load-bearing in two places.** EC2 sits in `shutting-down` for 30–120s and Hetzner in
`deleting` for seconds. With nowhere to put that, the two providers picked two *different* wrong
answers — AWS mapped it to `terminated`, Hetzner to `stopping`, which `app.ts` then reads as
`running`, a latent bug that would resurrect a terminating row if polled. The same field makes
`listManaged()` honest for the reconciler and retires the transitional workaround in D5.

**A4 is the highest-severity amendment in the memo, and it is a data-loss bug if read
literally.** The rule "`describe()` on a vanished instance returns `terminated` and never
throws" is correct and teardown polling depends on it — but EC2's `DescribeInstances` is
eventually consistent. In `spike/verify-aws.run1.log` a `describe()` 0.1 seconds after a
*successful* launch returned not-found, which that mapping reads as `terminated`; core would
have marked a healthy, billing instance dead and stopped tracking it. **The frozen spec must
state the grace rule beside the mapping**, or the next provider written from the spec ships the
same bug. Normative rule: believe absence only after a bounded propagation grace, and only for
instances never yet observed running. The spike's proven default — 4 attempts, 2s apart — is
the reference value; providers may lengthen it, never skip it.

### Offerings and pricing

| # | Amendment | Disposition |
|---|---|---|
| **B1** | Add `Offering.available: boolean` — a price is not an offer | **Adopt** |
| **B2** | Replace `hourlyUsd: number \| null` with `{ amount, currency, fetchedAt }` | **Adopt** |
| **B3** | Keep `Offering.id` a string; keep deprecation provider-internal | **Adopt as no-change** |

**B1** is one of the three prose leaks. Hetzner publishes prices for sold-out types, and at
capstone time had **zero arm64 stock across all locations** — a fact the provider could express
only by silently omitting types from `listOfferings()`. Without an availability signal core
cannot distinguish "this cloud has no ARM" from "ARM is sold out this afternoon", which is
exactly what a size selector's error message must say. **B3** is recorded explicitly so the
freeze does not "fix" two things that held: the AWS SDK types `InstanceType` as a closed union
so a cast is unavoidable and providers must own validation of their native ids, and Hetzner's
`deprecated` is per-location rather than per-type.

### Idempotency and naming

| # | Amendment | Disposition |
|---|---|---|
| **C1** | Put a generation/epoch component in the idempotency key | **Adopt** |
| **C2** | Require hostname-safe server ids | **Adopt** — and **reject** the `dedupeName` alternative |
| **C3** | Keep `idempotencyKey` exactly as sketched | **Adopt as no-change** |

**C2** offered two routes; we take the first. `srv_a1b2` is not a legal Hetzner server name
(RFC 1123, no underscores) and the name *is* Hetzner's dedupe mechanism, so the sanitizing map
must be **injective** — which folding underscores to hyphens is not, and a collision here means
two logical servers fighting over one cloud resource. Making ids hostname-safe at the source
eliminates the class structurally. Adding `dedupeName` to `ProvisionSpec` is rejected as
redundant once ids are safe: it is a field every provider must remember to prefer, which is the
discipline-not-fields failure this ADR exists to avoid. **C3** is recorded as a deliberate
no-change: two structurally different mechanisms (EC2 `ClientToken` passthrough, Hetzner
name-dedupe) sat behind one field without strain and both were verified against the real APIs.

### Managed resources and the reconciler

| # | Amendment | Disposition |
|---|---|---|
| **D1** | Add ownership to `ManagedResource`: shared-and-persistent vs owned-by-a-server | **Adopt** |
| **D2** | `provision()` may create secondary resources; `terminate()`/`listManaged()` must cover them | **Adopt** |
| **D3** | Providers refuse a spec whose `managed-by` tag disagrees with their own prefix | **Adopt** |
| **D4** | Specify volume lifecycle explicitly for block-storage providers | **Adopt** |
| **D5** | Zero-orphan audits must not rely on `listManaged()` alone until A3 lands | **Adopt as transitional** |
| **D6** | Document that `listManaged()` is scoped by a construction-time prefix | **Adopt as documentation** |

**D1** is the third prose leak, and it cuts both ways: AWS's shared SSH security group carries
the managed-by tag but intentionally outlives every server, while Hetzner's SSH key objects must
be reaped with the server that owns them. A reconciler treating `listManaged()` as a delete-list
would break running AWS instances; one treating it as append-only would orphan Hetzner keys.
This is no longer argued from two providers' comments: the q5lm.5 callback run observed it on
real infrastructure after a real teardown. With the instance genuinely reaped,
`listManaged()` reported no instances and *still* reported
`security-group/sg-0a949e8ed67c5a1bd` — a tagged resource that must survive the servers it
serves, which is the reconciler's hardest case
(`spike/recordings/aws-callback-lifecycle.txt:55-56`). Without an ownership field, that line is
indistinguishable from an orphan.
**D2** follows from Hetzner refusing raw key material inline: a crash between creating the key
object and creating the server orphans a key the database never references, so the reconciler
must sweep secondary kinds — and must **not** claim fingerprint-matched pre-existing keys it did
not create. **D4** is a concrete orphan class: sizing an EC2 root volume requires the AMI's
`RootDeviceName`, and guessing `/dev/sda1` silently attaches a *second* volume that survives
termination and is invisible to instance-walking audits. **D5** expires when A3 ships.

### Error taxonomy

| # | Amendment | Disposition |
|---|---|---|
| **F1** | Add a `providerCode` passthrough to `ProviderError` | **Adopt** — and **reject** a tenth code |
| **F2** | Drop `ProviderError.retryable`; derive it from the code | **Adopt** |

All 22 documented Hetzner codes land somewhere in the nine-code taxonomy, but three land badly:
`locked` (busy, retry in ~2s) becomes `conflict`, which reads as a contradictory request;
`maintenance`/`service_error` become `unknown`, erasing "this is the cloud's fault, not yours";
`token_readonly` becomes `auth`, indistinguishable from a bad token. A passthrough field is
cheaper than growing the taxonomy and preserves what an operator needs to see. The nine codes
stay nine.

### Keys and capabilities

| # | Amendment | Disposition |
|---|---|---|
| **E2** | Core is the sole owner of key material; narrow `sshPublicKeys`/`hostKeys` | **Adopt** — and **remove `hostKeys` from `ProvisionSpec`** |
| **E3** | Per-server private key material needs a first-class encrypted home | **Adopt — lands in core, not the SDK** |
| **E4** | Rename `canPinHostKey` → `canInjectHostKeys`; document the TOFU fallback | **Adopt** |
| **E11** | Give core a way to refresh its own access | **Reject for v0.1** — documented as provider configuration |

**E2** resolves a field that is redundant on one provider and required on the other. For
cloud-init providers, keys reach the box only through rendered user-data — the AWS provider
merely *asserts* they appear there — while on Hetzner `sshPublicKeys` is genuinely load-bearing
because the create call must reference first-class key objects. So `sshPublicKeys` stays, defined
as "key material the provider must register with its own API". `hostKeys` is **removed**: no
provider consumes it, the public half reaches the box through rendered user-data, and the private
half needs an encrypted home in core (amendment E3), not a trip into a provider. **E4** is a
rename that changes what the flag admits: it silently decides whether core can reject an unknown
host key on first contact or must fall back to trust-on-first-use. That is a security posture,
not a feature toggle, and it is really a cloud-init property rather than a provider-API one.

**E3 is adopted but is not an SDK change.** The private halves of per-server key material need an
encrypted home so that a core restart between provision and bootstrap does not permanently lose
the ability to authenticate to core's own box — today they survive only in whatever variable the
caller happens to hold. That home is core's AES-256-GCM secrets store (ADR-0001), which is
another reason `hostKeys` leaves `ProvisionSpec`: the material belongs in core, not in a trip
through a provider.

**E11 is rejected for v0.1.** The AWS SSH rule is scoped to the operator's `/32` and breaks the
moment their network changes, and the memo offers two routes: add `ensureAccess()` /
`authorizeCaller()` to the interface, or document security group maintenance as provider
configuration. We take the second. Adding an interface method to solve one provider's problem,
with no second implementation to generalize from, is the same premature generality this ADR
rejects for `interruptible` and `resize` — Hetzner needs nothing like it. The consequence is
accepted openly: an operator whose network changes must update provider configuration, and that
obligation belongs in the AWS provider's documentation. Revisit if a second provider needs the
same call.

### Deliberate exclusions — held

`interruptible` / `checkInterruption`, `resize`, and spot stay **out** of v0.1. The original cut
was made because generalizing from zero implementations with no out-of-tree consumers is
premature, and the memo confirms nothing has changed: there is still no second implementation to
generalize from. Spot also loses on product grounds — an interrupted box with an agent mid-task
undercuts the persistence positioning, and idle auto-stop is the cost lever instead. Also out:
live pricing APIs, dynamic out-of-tree plugin loading, and per-server IAM. *(Dynamic out-of-tree
loading was lifted by ADR-0026 on 2026-09-04, once issue #294 settled that users add providers to
their own installation without touching this repository; the reasoning for the original cut —
nothing to generalize from — had expired.)*

## Amendments after acceptance

### E12 — `InstanceView.hostKeyFingerprint`, added by the first `canInjectHostKeys: false` provider

Added 2026-08-12 by `rockysurf-ftl9.3`, the BYO provider. **Additive and optional**; nothing else
in the freeze changes, and no existing provider populates it.

E4 named trust-on-first-use as the fallback for a provider that cannot carry a host key, but did
not say *who* does the trusting — and when the first such provider arrived, the two candidate
answers turned out not to be equivalent:

- **core learns TOFU.** Cheap, and wrong. Core's push path pins strictly and has deliberately no
  trust-on-first-use path (`docs/bootstrap-contract.md`, push #15) because the first connection
  core makes is the one carrying the secrets file. Weakening that for one provider weakens it for
  every provider, since core cannot branch on `provider.id`.
- **the provider learns it, and reports a pin.** BYO connects to the box before core ever does —
  it has to, in order to install the account and the authorized keys that cloud-init installs
  elsewhere — so the trust decision already has a natural home *outside* core. What travels to
  core is then a fingerprint to verify against, not permission to trust.

We take the second. The field carries a `SHA256:…` the provider observed; core folds it onto the
server row exactly as it folds `publicIp`, and **never overwrites one it already has** — a
changed host key is a refusal, not an update. Contract #15 stays literally true: core still
verifies strictly, on its first connection, against a fingerprint it was told beforehand.

The cost is a field that means nothing on the two cloud providers, where core mints the host key
itself and already knows the answer. That is the honest shape of the difference; the alternative
was a second, weaker verification path inside core that every provider would have inherited.

Core pairs it with one non-SDK rule: when `canInjectHostKeys` is false, the minted host
fingerprint is **not** written to the server row, so a null pin means "nothing observed yet"
rather than "pinned to a key this box cannot present".

### E13 — `InstanceView.sshPort`, added because port 22 was an assumption, not a fact

Added 2026-08-12 by `rockysurf-ftl9.12`, a bug found by the first run against a real sshd
(`rockysurf-ftl9.10`). **Additive and optional**; absent means 22, and neither cloud provider
populates it.

The freeze modelled an instance's address as `publicIp` alone, which is exactly right for a
machine core provisioned: core wrote the image's sshd config by writing the cloud-config, so it
knows the port because it chose it. BYO inverts that. The box was configured by its operator
years before Rocky Surf existed, and `sshd` on 2222 is an ordinary hardening choice on a fleet
of them. `providers.byo.hosts[].port` already existed and the provider already honoured it for
its own connections — the probe, the claim, the prepare script — but the value died at the
provider boundary, because `InstanceView` had nowhere to carry it. Core dialled 22.

The failure that produced was worse than a refusal: the host was claimed, the `rocky` account,
its `authorized_keys` and its sudoers drop-in were all written to it correctly, and only then did
core start dialling a port nothing was listening on, until the provisioning timeout. The
operator's machine was visibly modified by a create that then failed with no stated reason.

Two alternatives were rejected. **Refusing a non-22 port at config-parse time** is honest and one
line, but it deletes a capability the provider already has for a constraint that exists nowhere
except in a missing field. **A BYO-specific column** in core keeps the SDK frozen at the cost of
core knowing what a `byo` server is, which is precisely the provider-specific knowledge the
dependency lint exists to keep out of core.

So the port travels the way the address travels: reported on `InstanceView`, folded onto the
server row, and read by everything that dials — the push bootstrap's `waitForSsh` and its SFTP
and exec channels, and the `ssh` command line the web UI, the CLI and the MCP server hand to a
human. The cost is a field that is always absent on AWS and Hetzner, which is the same honest
shape as E12.

### E14 — `InstanceView.hostPublicKey`, so no host has to settle for a weaker check

Added 2026-08-12 by `rockysurf-ftl9.14`. **Additive and optional**; populated only alongside E12's
fingerprint, and only by a provider with `canInjectHostKeys: false`.

E12 said the provider does the trusting and reports a **pin**, and that was right as far as it
went. What it missed is what a pin is *for* downstream: `GET /servers/:id/ssh-host-key` exists so
a client can write a real `known_hosts` entry and connect with `StrictHostKeyChecking yes`
(ADR-0002 makes that mandatory), and **ssh cannot verify against a fingerprint
non-interactively** — `known_hosts` needs the key. So a fingerprint alone left exactly one class
of host, the adopted ones, unable to be verified the way every other host is, and the first
attempt to handle that honestly weakened the generated ssh config for those hosts to a prompt.
Downgrading the check for a subset is still downgrading the check; the answer is to make the key
available instead.

The material was already in hand and being thrown away: the BYO provider's `hostVerifier` is
handed the raw key blob during the handshake, hashes it, and drops the rest. It now keeps it,
encoded as an OpenSSH public-key line from the blob's own declared type.

**The fingerprint remains the pin, and the key is subordinate to it.** Two rules make that
literal, and both are tested:

1. the provider records a key only *after* the pin has matched (or been learned) on a completed
   handshake, so a reported key hashes to the reported fingerprint by construction;
2. anything that arrives from **storage** rather than from a handshake — the provider re-adopting
   its own handle after a restart, core reading its row — is re-hashed and compared to the pin
   before it is believed, and dropped on disagreement rather than adopted. A changed host key
   must not be able to enter through the new field the way E12's never-overwrite rule stops it
   entering through the old one.

Core stores it beside the pin and serves it from the host-key route, so a BYO server now yields
the same strict `known_hosts` entry a cloud server does, and the CLI's generated config keeps
`StrictHostKeyChecking yes` **unconditionally**, for every provider.

### E15 — `ProviderCapabilities.simulatedInstances`, so the no-cloud trial run has a box

Added 2026-08-13 by `rockysurf-8fkz`. **Additive and optional**; absent means `false`, which is
what all three shipped providers declare by saying nothing, and no provider package changed.

The no-cloud path was broken end to end and the cause was structural. `compose.ts` registers the
in-memory provider when nothing real is configured so that `npx rockysurf` can create a server
without an AWS account — but since `rockysurf-55fx.13` a row is promoted out of `provisioning`
by exactly one thing, `recordProgress('ready')`, reported by a bootstrap that drove a real box.
The two callers are the push supervisor, which needs SSH, and the callback route, which needs a
box that can dial core. A simulated instance has neither, so it sat in `provisioning` until the
30-minute timeout terminated it, accrued no uptime, and made `limits.spendCap` unreachable on
the only installation a stranger ever runs first.

The rule is right and stays: **bootstrap owns the promotion.** What was missing is a way for
core to learn that this server's bootstrap has nowhere to connect to, so that it can drive the
same plan in-process instead of over SSH. Core is not permitted to learn that from a provider
id — that is the property this ADR exists to protect — so it learns it from a capability, which
is what the struct's own doc comment already prescribed for exactly this case: *"If core needs
to know something a flag here cannot tell it, the answer is a new flag, not a special case."*

Three things the flag deliberately does **not** do:

1. **It does not add a promotion path.** The simulated agent produces the same `AgentState`
   journal a real agent does and feeds it to the same `applyAgentState`, so the row is promoted
   by the same `recordProgress('ready')` as a real create, from the same supervisor, on the same
   ticker. Only the transport is simulated.
2. **It is not a demo mode.** There is no global switch, no config key, and no second code path
   that an operator could turn on against a real cloud. The flag rides on the provider, so it is
   true for exactly the servers whose provider has no machines and false everywhere else,
   including on an installation that runs the in-memory provider beside a configured cloud.
3. **It does not run the real agent locally.** The rejected alternative — stand up an in-process
   SSH server so `runPushBootstrap` drives it unmodified — has better fidelity and an
   unacceptable consequence: `agent.sh` would execute the pack's install scripts on the
   operator's own laptop. A trial run must not `apt-get install` anything.

A provider MUST NOT set this while reporting addresses that resolve to real hosts; core takes it
as permission to skip the SSH drive entirely.

### E16 — `InstanceView.consoleUrl`, because the console URL is provider knowledge

Added 2026-08-13 by `rockysurf-imj1`. **Additive and optional**; absent means "no link", which is
what BYO and the in-memory provider report and what Hetzner reports until it is configured.

The request was small — from a server's page, open that same server in the AWS or Hetzner
console — and the only interesting question was *who is allowed to know the URL*. Core is not:
`https://<region>.console.aws.amazon.com/ec2/home?region=<region>#InstanceDetails:instanceId=…`
is a fact about EC2, and a `provider === 'aws'` branch in core to build it is exactly the
knowledge this ADR exists to keep out. The SPA is not either, for the same reason — it reads
core's own projection, and a switch on `server.provider` there is the same conditional one layer
further from the compiler.

So the provider reports it, and two shapes were candidates:

- **a static method on the provider**, `consoleUrlFor(data)`. Rejected on the freeze's own rule:
  an optional method needs a capability flag to go with it (A2 — core checks flags, never
  `typeof provider.x === 'function'`), so it costs an interface method *and* a capability to
  deliver a string, and it would still need the instance handle core holds opaquely.
- **a field on `InstanceView`**, the E12/E13/E14 shape. The URL is per-instance and the provider
  is already answering a per-instance question in `describe()` with the handle in hand.

We take the field. It costs nothing to a provider that has no answer, and core carries it exactly
as it carries the rest of what a provider reports about where an instance is.

**Core persists it on the row and folds it like the port**, rather than deriving it per response.
`present()` is a projection of the row, and the read paths that reach it (`get`, `list`) do call
`describe()` first — but `create` answers before any describe, and threading a view through four
lifecycle signatures to carry a display string is a worse trade than one nullable column beside
`publicIp` and `sshPort`, which are the same category of thing: the last address a provider gave
us. A reported URL that differs is adopted; an ABSENT one is left alone rather than cleared,
because `describe()`'s failure and not-found paths legitimately return sparse views and clearing
on those would delete the link every time a terminating box is polled.

Two provider-side notes the field forces into the open:

1. **AWS needs nothing new** — the region is the provider's own configuration and the instance id
   is its handle, so the URL is constructible for every instance it has ever created, from the
   moment `RunInstances` returns. Non-default partitions get their own console host
   (`console.amazonaws.cn`, `console.amazonaws-us-gov.com`); an unrecognised region prefix
   reports nothing rather than a link into the wrong partition.
2. **Hetzner needs a number its API does not expose.** A console URL is
   `/projects/<numeric project id>/servers/<server id>/overview`, and the numeric project id
   appears nowhere in the Cloud API — a token is scoped to a project without ever naming its id.
   So it is optional configuration, `providers.hetzner.consoleProjectId`, and **no value means no
   link**. Deriving, guessing, or defaulting it would produce a URL that resolves for somebody,
   just not for this operator.

The field carries no secret: instance ids and regions are identifiers, and the link lands on the
provider's own sign-in page. It is the same posture as showing the address.

### E17 — `ProviderCapabilities.billsWhileStopped`, because one cloud's off-state is not free

Added 2026-09-04 by [ADR-0025](0025-billing-while-stopped-is-a-capability.md) (issue #294).
**Additive and optional; absent means `false`**, which is what all five shipped providers declare
by saying nothing, and no provider package changed.

Core's billing predicate had written down that `stopped` costs nothing "on every provider core
speaks to". A powered-off DigitalOcean droplet bills at the full compute rate and DigitalOcean has
no non-billing off-state to choose instead, so a provider for it could say `stop: true` and watch
core stop the meter, or `stop: false` and lie about the API. E15's reasoning applies unchanged:
core is not permitted to learn this from a provider id, so it learns it from a capability, and the
struct's own doc comment prescribed exactly that.

Two things the flag deliberately does not do:

1. **It does not model a reduced rate.** `true` means the running rate. A cloud that charges less
   while stopped MUST NOT set it and needs a capability that does not exist yet — an ADR question,
   never an approximation.
2. **It does not reach the meter live.** Core records the provider's answer on the server row
   beside `providerState`, so a cloud switched off in the config cannot silently stop the meter on
   a machine it is still charging for. The reasoning, and the rejected live-lookup shape, are in
   ADR-0025.
### E18 — `ProviderFactory.credentialEnv` and `credentialField`, because the composition root can no longer write the row by hand

Added 2026-09-04 by [ADR-0026](0026-a-personal-provider-is-a-package-named-in-the-config-file.md)
(issue #294). **Additive and optional**; absent means the credential is named in the config file or
comes from an ambient chain the provider resolves itself, which is what every shipped factory
declares by saying nothing.

Each of the five rows in `compose.ts` names, by hand, the config field a credential belongs in and
the environment variables it may arrive under (`PROVIDER_CREDENTIAL_ENV`). A provider Rocky Surf
did not ship has no row. Two fields on the factory carry the same two facts: `credentialEnv`, the
variables in the order to try them, and `credentialField`, where a value found there lands in the
input to `configSchema.parse`. They sit on the FACTORY rather than the provider because the
composition root has the factory before any provider exists, and a chain-auth cloud names variables
without having any field.

Two things they deliberately do not do:

1. **They store nothing.** A value read from a variable goes into the parse input and nowhere
   else — the same path the Hetzner row has always taken, and the reason "Rocky Surf stores no
   cloud credentials" stays unconditional for a provider from outside this repository.
2. **They do not override the shipped table.** `PROVIDER_CREDENTIAL_ENV` stays authoritative for
   the five, so the wizard's detection and the composition's fallback keep reading one list.

## Consequences

### Positive

- The three divergences that were living in comments get fields, so the compiler and the
  reconciler enforce them instead of a reviewer noticing.
- A4 turns a latent data-loss bug into a specified rule before any third provider is written.
- Dropping `TData` (A1) removes the `any` that the generic was supposed to prevent.
- The SDK stays small: nine error codes, no spot, no resize.

### Negative

- These are breaking changes to a sketch two providers already implement; both spike providers
  need reworking when the types land in q5lm.2.
- Required-but-throwing `stop`/`start` (A2) is boilerplate for providers that cannot stop.
- `ManagedResource` ownership (D1) and secondary resources (D2) make the reconciler materially
  more complex than "diff a list".

### Risks and mitigations

- **Risk:** the freeze is wrong in a way the spike could not see, because only two providers and
  one BYO-shaped hole were exercised. **Mitigation:** pre-1.0 changes are cheap and there are no
  out-of-tree consumers yet; the dependency lint keeps core from growing provider-specific
  assumptions in the meantime.
- **Risk:** A4's grace rule is skipped by a future provider author who finds it inconvenient.
  **Mitigation:** state it in the frozen spec beside the mapping it modifies, not in a note.

## Deliberately unresolved

The memo lists these as not-yet-decidable, and this ADR does not decide them:

- **Spot/interruptible and `resize`** — the cut holds; unblocks when a second interruptible
  provider exists.
- ~~**BYO provider shape.** `generatesUserData: false` is honoured in code but never exercised end
  to end.~~ **Resolved** by `rockysurf-ftl9.3`: `@rockysurf/provider-byo` implements it, and
  amendment E12 above is the one interface change it needed. Still unexercised against a real
  operator fleet — the tests drive an in-process SSH server, not somebody's rack.
- ~~**T-shirt size resolution when an architecture is unavailable.** The fallback logic cannot be
  designed before B1 gives it something to read.~~ **Resolved** by `rockysurf-clf2`: **there is no
  fallback.** B1 (`Offering.available`) gave it something to read, and what it reads says the two
  cases must not be merged — "this cloud sells no ARM" and "ARM is sold out this afternoon" are
  different facts, so an unmeetable request is a `400` and a sold-out one a `503`, and neither
  quietly becomes a machine the caller did not ask for.

  Leaving this open cost more than the design would have. Core's create route filled the gap with
  "cheapest available offering in the catalogue", which made `size` decorative — every size
  resolved to the same machine — and made `arch` worse than decorative: the route chose without
  consulting it, kept the caller's value beside the choice, and the provider refused the pair with
  `invalid_spec: arch arm64 does not match offering e2-micro (amd64)`, blaming the caller for a
  contradiction the route had built. Arch-only creation was impossible on every surface except the
  SPA, which resolved in the browser and posted a concrete `offeringId`.

  The rule now, in `packages/core/src/servers/offerings.ts`: a size is a **floor** (`small` ≥ 2
  vCPU / 2 GB, `medium` ≥ 2 / 4, `large` ≥ 4 / 8), a requested `arch` is part of that floor rather
  than a filter applied afterwards, and the answer is the cheapest **available** offering
  satisfying both — a cloud with coarser types rounds up. Substituting is never a resolution.
  Nothing in this changes the SDK: it is core reading `Offering.cpu`, `memoryGb`, `arch` and
  `available`, which is what B1 and the frozen shape were for.
- **Multi-region and multi-project scoping of the `listManaged()` prefix** (D6).
- **Equalizing default network exposure between clouds.** AWS needs a VPC, subnet and security
  group; Hetzner needs none and a server is SSH-reachable the moment it boots. Inheriting that
  difference is a product decision, not an interface one.

## References

- `docs/spike/findings.md` — amendments A1–A7, B1–B3, C1–C3, D1–D6, E2/E4, F1–F2; "Deliberately
  unresolved"; exit question 3
- `docs/spike/findings-notes.md` #1–#27, #37, #38
- `docs/spike/interface-sketch.md` — the shape being amended
- `spike/recordings/capability-differences.md` — the eight divergences
- Spike implementation: `spike/src/sdk.ts`, `spike/src/providers/aws.ts`,
  `spike/src/providers/hetzner.ts`; `spike/verify-aws.run1.log` for A4
- `spike/recordings/aws-callback-lifecycle.txt:55-56` (commit `5e537b0`) — D1 observed on real
  infrastructure: a shared, intentionally-persistent resource surviving a real teardown
- The reconciler is the concrete consumer of A3, A4 and D1–D5: follow-up task 3 in
  `docs/spike/findings.md`, tracked as **`rockysurf-55fx.7`** ("Startup recovery pass +
  reconciler (listManaged vs DB)"), which carries the same D1 evidence. Its acceptance criteria
  are where these amendments get tested — a cloud resource with no DB row flagged as an orphan,
  and a DB row marked terminated when the resource is gone. The shared security group above is
  precisely the case that breaks the first criterion if `ManagedResource` cannot express
  ownership.

## Related decisions

- ADR-0001 — the registry and reconciler that consume this SDK
- ADR-0002 — E1 and E5, decided there; A7 is their SDK hook
