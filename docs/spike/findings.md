# Rocky Surf de-risking spike — findings

**Status: complete. This memo is the input contract for the Phase 3 design freeze
(`rockysurf-q5lm`). Nothing in the provider SDK freezes until the amendments below are
accepted, amended, or explicitly rejected.**

The spike built a throwaway Hono mini-app against the non-frozen sketch in
[`interface-sketch.md`](interface-sketch.md), implemented two real providers (Hetzner, AWS
EC2), built two bootstrap topologies, and ran the whole lifecycle on real infrastructure on
both clouds. All four exit questions pass. The sketch survived contact, but it needs
**32 amendments**, and two of them are things a literal reader of the current sketch would ship
as bugs.

Everything here is backed by a recording, a log, or a test. Evidence lives at:

| evidence | what it is |
|---|---|
| `spike/recordings/aws-lifecycle.txt` | full real AWS lifecycle, t4g.small **arm64**, us-east-1, 29/29 checks |
| `spike/recordings/hetzner-lifecycle.txt` | full real Hetzner lifecycle, cpx12 **amd64**, fsn1, 29/29 checks |
| `spike/recordings/capability-differences.md` | every AWS/Hetzner divergence and how it was expressed |
| `spike/verify-aws.log`, `spike/verify-hetzner.log` | provider lifecycle + zero-orphan audits |
| `spike/verify-aws.run1.log` | the run that caught the eventual-consistency bug |
| `pnpm run verify:push` / `verify:callback` | local bootstrap harnesses, no cloud credentials |
| `spike/src/**` | 186 unit tests, `tsc --noEmit` clean, `SPIKE-FINDING:` comments at each site |

Numbered references like *(#27)* point at
[`findings-notes.md`](findings-notes.md), the consolidated working notes from all five
agents.

---

## Verdicts on the four exit questions

### 1. Push-mode bootstrap with zero on-box cloud coupling — **PASS**

What core sends before boot is inert `#cloud-config`: it creates the `rocky` user, authorizes
core's key, and pins a core-minted ed25519 host key. No `runcmd`, no `bootcmd`, no shell, no
cloud vendor SDK, no metadata-service dependency. Everything installed arrives afterwards over
one outbound SSH connection: core scps `agent.sh` plus an install plan, launches it under a
transient `systemd-run` unit, and reads progress back from a state journal on the box.

Proven on real infrastructure, both clouds:

- cloud-init consumed **core's exact bytes** — `/var/lib/cloud/instance/user-data.txt` is
  byte-identical to what core sent (2130B on AWS, 2138B on Hetzner);
- host-key pinning is real, not trust-on-first-use: the box came up already presenting the key
  core minted before the server existed, so the *first* connection — the one carrying the
  secrets file — was verified against a known key. The negative case was exercised: a wrong
  fingerprint is rejected in under a second and never retried;
- **one identical plan** produced `claude --version` → `2.1.228 (Claude Code)` over SSH as
  `rocky` on **both architectures**, with node v24.19.0 on arm64 and amd64. The only
  arch-aware line in the plan is the `$ARCH` → Node tarball mapping;
- the `systemd-run` launcher, unverifiable in containers, ran the agent in a transient
  `rockysurf-bootstrap.service` with live `journalctl -f` output on both clouds.

Locally, 18/18 integration checks cover the paths real cloud runs cannot easily exercise:
idempotent re-push (all steps skip, timestamps untouched), resume after `SIGKILL` mid-plan,
failure reporting with log tail, and optional-step isolation.

*Evidence: `recordings/aws-lifecycle.txt`, `recordings/hetzner-lifecycle.txt`,
`recordings/README.md`, `pnpm run verify:push`.*

### 2. Push from behind NAT, and callback from an unreachable core — **PASS** (both, on real infrastructure)

**Push, on a real network:** core for the capstone runs was a laptop behind NAT with no public
address, no port forward, and no listener. Every connection was outbound from core — HTTPS to
the provider APIs, then one SSH connection to the box. Nothing ever connected *to* core, and
the box was never given a core URL at all (`plan.mode` is `push`, so `callbackUrl` goes
unused). Before the capstone this claim held only by construction in a docker harness; it now
holds on real infrastructure.

**Callback, locally:** the opposite topology works too. User-data carries a stub, a single-use
plan token and a recurring status token; cloud-init runs the stub, which fetches the plan from
core's public URL and launches the same `agent.sh`; the box POSTs its own progress. The
harness enforces the topology structurally rather than by promise — the box container
publishes **no ports and has no sshd installed**, both asserted at runtime, so core cannot
dial it even by mistake. Core recorded 7 progress reports covering all 3 plan steps, the
one-time token was spent once and rejected with 410 on replay, and `bootstrapStep` reached
`ready` — a label gated on the box's own `claude --version`.

**Callback, on real AWS (added after the memo's first draft — `rockysurf-q5lm.5`):** the leg
this section originally listed as unverified is now verified. Real cloud-init executed the
document — `write_files` *and* `runcmd`, by cloud-init itself rather than a harness standing in
for it — and decoded the gz+b64 agent to the exact bytes core compressed (sha256 match on
`/var/lib/rockysurf/agent.sh`, 14,185B). The box fetched its own plan with the single-use
token, which was then refused with 410 and the replay recorded; it POSTed 7 progress reports
across all 3 steps, each carrying the runId core minted when it handed out the plan; and it
reached `ready` gated on its own `claude --version` (2.1.228, node v24.19.0, arm64 t4g.small).
26/26 checks, 95s, zero orphans. **Finding #44 is closed.**

The document measured 11,752B on real infrastructure — **72% of EC2's 16,384B ceiling, and
that is with `gz+b64`**; verbatim it does not fit at all, which is amendment E5 confirmed
against the real API rather than a local calculation.

**The boundary that replaces the old caveat.** Callback mode requires core to be reachable
*from the box*, and core in this run was a NAT'd laptop, so the ingress path was an SSH reverse
tunnel: core connected out to the box (host key verified) and asked its sshd to forward a port
back. What is real is cloud-init running the document and the box making every outbound call
itself; what is simulated is the network path — a production callback deployment would put core
on a public URL. Which is the finding: **callback mode earns its keep only where core is
already publicly reachable.** Making it work from a laptop required core to SSH into the box
first — precisely the connectivity push mode needs and callback was supposed to avoid.

*Evidence: `recordings/README.md` (NAT section), `recordings/aws-callback-lifecycle.txt`,
`pnpm run verify:callback`, `spike/verify-aws-callback.ts`.*

### 3. Capability and taxonomy differences expressible without provider `if`s in core — **PASS, and it costs the freeze six fields**

There are **zero `provider.id` conditionals in shared code**, and that property is
grep-enforced by tests. Every behavioural difference flows through `capabilities.*`: the
user-data ceiling check, the host-key block, the `previousIp`/`ipChangedAt` breadcrumb, the
BYO no-user-data path. The registry is the only place that knows a provider by name.

But the honest verdict is narrower than "it works". Eight real divergences showed up between
AWS and Hetzner, and **three of them had no field to live in**, so they were expressed in
prose comments and provider-local data structures instead:

1. **architecture availability** — Hetzner had zero arm64 stock at run time, expressed by the
   provider silently omitting types from `listOfferings()`;
2. **terminal-state semantics** — EC2 `shutting-down` and Hetzner `deleting` have nowhere to
   go in `InstanceView`, so the two providers picked **two different wrong answers**;
3. **secondary-resource ownership** — AWS's shared security group must survive, Hetzner's SSH
   key objects must be reaped, and `ManagedResource` cannot say either.

That is not `if (provider.id === 'aws')` leaking into core. It is leaking into *prose*, which
is worse, because nothing enforces a comment (#38). The answer is fields, not discipline —
amendments **A3, B1, D1** below.

*Evidence: `recordings/capability-differences.md`.*

### 4. Full lifecycle create → install → SSH → terminate → zero orphans — **PASS on both clouds**

| phase | AWS (t4g.small, arm64) | Hetzner (cpx12, amd64) |
|---|---|---|
| provision | 3s | 1s |
| boot to running | 8s | 11s |
| wait for SSH (host key pinned) | 23s | 26s |
| cloud-init evidence | 2s | 3s |
| push bootstrap (3 steps) | 31s | 35s |
| terminate | 0s | 1s |
| orphan sweep | 68s | 0s |
| **total** | **138s** | **81s** |

Both runs passed 29/29 checks on the first attempt with zero orphans. Idempotency holds by
two different mechanisms: EC2 `ClientToken` replay returned the same instance with no second
launch, and Hetzner name-dedupe resolved a `uniqueness_error` to the existing server.
Double-terminate is a no-op on both.

**The zero-orphan claim needs a caveat the freeze must absorb:** on AWS, `listManaged()`
reports clean the moment the instance flips to `shutting-down`, roughly **60 seconds before
the resources stop existing**. A zero-orphan check written against the provider interface alone
is therefore falsely green on AWS (#37). The capstone's AWS sweep goes behind the interface to
raw `DescribeInstances`/`DescribeVolumes` for exactly this reason, and confirms *"every managed
instance is genuinely terminated, not just shutting down"* plus *"no managed EBS volumes
survived termination"*. Hetzner needs no such workaround. This is the same missing
`terminating` state as exit question 3, seen from the reconciler's side.

*Evidence: `recordings/*-lifecycle.txt`, `verify-aws.log` (steps 7–8), `verify-hetzner.log`.*

---

## The two things a literal reader of the sketch will ship wrong

Everything else in this memo is an improvement. These two are latent bugs in the sketch as
written, and both were caught only by running real systems.

### 1. `not_found` means two different things, and one of them is "wait" (#27)

The sketch says `describe()` on a vanished instance returns `state: 'terminated'` and never
throws. That rule is correct and load-bearing — teardown polling depends on it — but applied
literally it is a **data-loss bug**, because EC2's `DescribeInstances` is eventually
consistent. In `verify-aws.run1.log` a `describe()` call 0.1 seconds after a *successful*
launch returned not-found, which the sketch's mapping reads as `terminated`. Core would have
marked a healthy, billing instance dead and stopped tracking it.

> ```
> [   4.3s] STEP 3 describe() until running
> [   4.4s]   state=terminated
> ```
> — `spike/verify-aws.run1.log:10-11`

The fix, proven in `aws.ts` and covered by three regression tests: believe absence only after a
bounded propagation grace (4 attempts, 2s apart), and only for instances never yet seen
running. **The freeze must state this beside the `not_found → terminated` rule**, or the next
provider implemented from the spec ships the same bug.

### 2. One token cannot be both single-use and recurring (#40, #42)

Callback mode needs two secrets with two lifetimes, and collapsing them is the natural mistake:

- the **plan token** ships in user-data, which is readable from the instance metadata service
  by every process on the box, forever. Making it single-use shrinks the exposure window from
  "life of the server" to "until cloud-init runs";
- the **status token** authenticates per-step progress POSTs, so it *cannot* be single-use, and
  necessarily lives on the box for the whole bootstrap.

If they are one secret, single-use loses, and a credential that leaks through user-data stays
valid for the life of the server. Keep them separate, keep the status token's blast radius
bounded to writing progress strings on one row, and never let a route that returns anything
secret accept it.

The second-order finding is subtler and cost real debugging: **single-use tokens and
at-least-once delivery do not compose.** If core spends the token and the response is lost in
transit, the retry gets 410 and the box is bricked — no plan, no way to ask for another. One
dropped packet, one dead server. Mitigated today by retrying only connection failures, 5xx and
429 (never replaying a 4xx) and by fetching only when the box has no plan, so a systemd restart
cannot re-spend. The freeze should go further — see **E8**.

---

## Freeze amendments

Each amendment is a change the SDK sketch must take. Cite them by their letter-number in the
Phase 3 ADRs.

### A. Interface shape

**A1. Drop the `TData` generic from `ComputeProvider`.** Make provider data an opaque
`Record<string, unknown>` each provider narrows internally. `ComputeProvider<TData>` uses
`TData` in both input and output position, so it is invariant: a registry holding an AWS
provider next to a Hetzner one cannot be typed, and every heterogeneous holder degrades to
`any` — erasing the exact safety the generic was added for. The data round-trips through JSON
in the database anyway, so the compile-time type is fiction the moment a row is read back.
*(#1; `sdk.ts:83`)*

**A2. Make the capability flag and the optional method one source of truth for `stop`.** Either
presence of the method IS the capability, or the method is always present and throws
`ProviderError('invalid_spec')` when unsupported. TypeScript cannot link `capabilities.stop` to
`stop?`, so every caller needs both checks — two sources of truth that can disagree at runtime
with no compiler help. Keeping both is the one option that guarantees drift. *(#2;
`sdk.ts:127`)*

**A3. Add `terminating` to `InstanceView.state`.** EC2 sits in `shutting-down` for 30–120s;
Hetzner sits in `deleting` for seconds. With no state for it, the two providers chose two
different wrong answers — AWS mapped it to `terminated`, Hetzner to `stopping`, which `app.ts`
then reads as `running`, a latent bug that would resurrect a terminating row if polled. This
one field also makes `listManaged()` honest for the reconciler (see D5). *(#4, #37;
`aws.ts:100`, `hetzner.ts:209`, `capability-differences.md` §2/§8)*

**A4. Define `describe()` on a vanished instance as `terminated` ONLY after a propagation
grace.** Absence is not proof of termination on an eventually-consistent API. Specify the
bounded-retry rule alongside the mapping. **This is the highest-severity amendment in this
memo.** *(#3, #27; `aws.ts:109`, `verify-aws.run1.log`)*

**A5. Add a failure state to `InstanceView`.** A provider-side failed instance currently reads
as `unknown`, indistinguishable from "the API was weird". *(#5)*

**A6. Return an initial `InstanceView` from `provision()`.** It returns only `{data}` today, so
core must immediately call `describe()` to learn state and IP — an extra round trip on the one
call that already knows the answer. *(#6)*

**A7. Add `validateSpec(spec)` so providers own their own limits.** `userDataMaxBytes` is
advisory-only: nothing validates against it, and the failure mode is a vendor-specific
rejection at provision time. Callback mode makes this concrete — see E5. *(#9, #39;
`bootstrap.ts:70`)*

### B. Offerings and pricing

**B1. Add `Offering.available: boolean` — a price is not an offer.** Hetzner publishes prices
for sold-out types; at capstone time it had **zero** arm64 stock across all locations, and the
provider could only express that by omitting types from `listOfferings()`. Without an
availability signal, core cannot distinguish "this cloud has no ARM" from "ARM is sold out this
afternoon" — which is exactly what a size selector's error message needs to say, and what a
fallback path would branch on. *(#10, #38; `hetzner.ts:369`,
`capability-differences.md` §1)*

**B2. Replace `hourlyUsd: number | null` with `{ amount, currency, fetchedAt }`.** Hetzner
quotes in the project's billing currency, so a EUR project reports `null` under the current
shape — a real customer looks at a price list of nulls. *(#12; `hetzner.ts:355`)*

**B3. Keep `Offering.id` a string, and keep deprecation provider-internal.** The AWS SDK types
`InstanceType` as a closed union, so a cast is unavoidable and providers must own validation of
their native ids. Hetzner's `deprecated` is per-location rather than per-type, which is
likewise provider-internal detail. Both held up as-sketched; recording them so the freeze does
not "fix" them. *(#13, #14)*

### C. Idempotency and naming

**C1. Put a generation or epoch component in the idempotency key.** Hashing
(name, provider, offering) means a user who terminates `dev-box` and recreates it with
identical settings collides with the old row forever. The spike works around this by skipping
rows in a terminal state, which is not a design. *(#15; `store.ts:90`)*

**C2. Require hostname-safe server ids, or add an explicit `dedupeName` to `ProvisionSpec`.**
`srv_a1b2` is not a legal Hetzner server name (RFC 1123, no underscores), and the name IS
Hetzner's dedupe mechanism — so the sanitizing map must be **injective**, which folding
underscores to hyphens is not (`srv_a` and `srv-a` collide, and a collision here means two
logical servers fighting over one cloud resource). *(#16; `hetzner.ts:177`)*

**C3. Keep `idempotencyKey` exactly as sketched.** Two structurally different mechanisms — EC2
`ClientToken` passthrough and Hetzner name-dedupe — sat behind one field without strain, and
both were verified against the real APIs. The sketch's own comment anticipated this and held.
*(#17; `capability-differences.md` §4)*

### D. Managed resources and the reconciler

**D1. Add ownership to `ManagedResource`: shared-and-persistent vs owned-by-a-server.** AWS's
SSH security group carries the managed-by tag but intentionally outlives every server;
Hetzner's SSH key objects must be reaped with the server that owns them. A reconciler treating
`listManaged()` as a delete-list would break running AWS instances; one treating it as
append-only would orphan Hetzner keys. Both facts currently live in comments and in
`HetznerData.sshKeyIds`. *(#18, #20; `aws.ts:695`, `capability-differences.md` §3)*

**D2. Specify that `provision()` may create secondary resources, and that `terminate()` and
`listManaged()` must cover them.** Hetzner's API will not take raw key material inline, so the
provider must create first-class SSH Key objects. A crash between the two calls orphans a key
the database never references — so the reconciler must sweep secondary kinds, and must **not**
claim fingerprint-matched pre-existing keys it did not create. *(#20; `hetzner.ts:295`)*

**D3. Make providers refuse a spec whose `managed-by` tag disagrees with their own prefix.**
Otherwise a mistagged instance is an orphan by construction: invisible to `listManaged()` and
therefore to every audit built on it. *(#21; `aws.ts:514`)*

**D4. Specify volume lifecycle explicitly for block-storage providers.** Sizing an EC2 root
volume requires the AMI's `RootDeviceName`; guessing `/dev/sda1` silently attaches a *second*
volume that survives termination and is invisible to instance-walking audits. Verified fix:
derive the device name from the AMI, set `DeleteOnTermination`, tag volumes, and audit
`DescribeVolumes` by tag. *(#22; `aws.ts:336`)*

**D5. State that zero-orphan audits must not rely on `listManaged()` alone until A3 lands.**
Terminal-but-unreaped reads as gone, so the interface-level check is falsely green on AWS for
~60s. Either audits go behind the interface (what the capstone does), or `terminating` makes
the interface honest. Prefer the latter. *(#37; `verify-aws.log` steps 7–8)*

**D6. Document that `listManaged()` is scoped by a construction-time prefix.** One process
cannot reconcile two prefixes without two provider instances. Probably fine — but it should be
a documented constraint rather than an accident of the constructor. *(#19; `fake.ts:178`)*

### E. Keys, user-data, and bootstrap topology

**E1. Freeze push mode as the DEFAULT bootstrap topology; callback is the documented fallback
for unreachable boxes.** Push needs no inbound anything: no public core URL, no listener, no
callback token on the box, nothing leakable through instance metadata, and a user-data document
that is **constant at ~2.1KB no matter how much software the plan installs**. Callback needs a
reachable core, leaves a credential on the box for the whole bootstrap, reintroduces the shell
that push mode deleted (something must start the process), and grows with the agent. Push's one
cost — core must stay alive during the install — is made survivable by the resume path.
*(#24, #31, #41; `push.ts:15`, `callback.ts:20`)*

**E2. Make core the sole owner of key material, and narrow `sshPublicKeys`/`hostKeys`
accordingly.** For cloud-init providers these fields are **dead**: keys reach the box only
through rendered user-data, and the AWS provider merely asserts they appear there. On Hetzner
`sshPublicKeys` is genuinely load-bearing because the create call must reference key objects.
The same field is redundant on one provider and required on the other; pick one owner and say
which. *(#23; `aws.ts:496`, `hetzner.ts:430`, `capability-differences.md` §6)*

**E3. Give per-server private key material a first-class encrypted home.** `ProvisionSpec`
carries `hostKeys` *into* the provider, but nothing persists the private halves — so a core
restart between provision and bootstrap permanently loses the ability to authenticate to its
own box. Today they survive only in whatever variable the caller happens to hold. *(#33;
`bootstrap.ts:134`, `keys.ts:19`)*

**E4. Make `canPinHostKey` say what it costs.** The flag silently decides whether core can
reject an unknown host key on first contact or must fall back to trust-on-first-use — a
security posture, not a feature toggle. Rename it (`canInjectHostKeys`) and document the TOFU
fallback in the interface. It is also really a cloud-init property, not a provider-API one.
*(#33; `keys.ts:19`, `aws.ts:53`)*

**E5. Treat "compress anything large in user-data" as a rule, and keep the size check in the
renderer.** Callback mode embeds the agent in-band: **19,130 bytes against EC2's 16,384-byte
ceiling** — impossible on AWS, arriving as a provider-side 400 at provision time, **on AWS
only**, invisible to unit tests and to Hetzner's 32KB limit. cloud-init's native `gz+b64`
brings the same document to 10,934 bytes (67% of the ceiling). Pair this with A7. *(#39;
`callback.ts:172`)*

**E6. Give every bootstrap run an identity, and make the on-box journal the source of truth.**
Without a run id, a push to an already-bootstrapped box reads the *previous* run's terminal
state and reports success before the agent has started — and a retry of a **failed** bootstrap
reports the old failure as the new result. Core mints the id (at push time, or when it hands
out the plan in callback mode); the box echoes it on every report; reports from a superseded
run are recorded for forensics but must not move the row. *(#28, #42; `bootstrap.ts:56`)*

**E7. Watch the launcher, not just the progress file — and introspect it with privilege.** A
progress-file timeout cannot distinguish a slow `apt-get` from a SIGKILLed agent: any timeout
long enough to avoid false positives on the former is far too long to notice the latter.
Asking the launcher whether its process still exists collapses both into one accurate signal,
and is the strongest argument for the transient systemd unit — `systemctl is-active` is a real
answer where `pgrep` is a guess about a command line. Run those queries through `sudo`:
unprivileged `systemctl is-active` fails with "Failed to connect to bus" whenever dbus is
unreachable, which reads as "not running" to any caller checking the exit code, and core
declares a healthy bootstrap dead. *(#29, #30; `push.ts:399`, `push.ts:410`)*

**E8. Specify two tokens with two lifetimes, and prefer a short TTL with a small use budget
over strict single-use.** Plan fetch = single-use token, spent on first fetch, replay recorded
as the only leak signal core ever gets. Status POSTs = a recurring token whose blast radius is
bounded to writing progress strings on one row. Strict single-use does not survive a lost
response (see "two things a literal reader will ship wrong"); a budget of a few uses inside a
short window shrinks the exposure window just as effectively and cannot brick a box. *(#40,
#42; `app.ts:244`, `callback.ts:72`)*

**E9. Keep control-plane credentials out of the bag forwarded to install steps, and out of
argv.** The agent exports its secrets file into every unprivileged step's environment, which is
right for an API key the installed software needs and wrong for the token that authenticates
core's control plane — no install script has any business seeing it. Two files, two lifetimes,
one never exported. Pass tokens on stdin, never as a `curl -d` argument readable via `ps`.
*(#43; `callback.ts:140`)*

**E10. State that the agent may assume nothing about the base image.** Both clouds ran "Ubuntu
24.04" and they are not the same image: Hetzner's ships without `jq`, Canonical's AWS AMI has
it, so the agent's defensive bootstrap path fired on exactly one cloud. **"Ubuntu 24.04" is not
a contract about installed packages** — anything the agent needs before it can parse its own
plan must be bootstrapped per-image. Nothing in `Offering` or `ProviderCapabilities` describes
image contents and nothing reasonably could; the obligation belongs to the agent. *(#36;
`agent.sh:143`, `capability-differences.md` §7)*

**E11. Give core a way to refresh its own access.** The AWS SSH rule is scoped to the
operator's `/32`, which breaks the moment their network changes, and nothing in the sketch lets
core say "authorize me again". Add `ensureAccess()`/`authorizeCaller()`, or document security
group maintenance as provider configuration and accept the consequence. *(#26; `aws.ts:410`)*

### F. Error taxonomy

**F1. Add a `providerCode` passthrough to `ProviderError`.** All 22 documented Hetzner codes
land somewhere in the nine-code taxonomy, but three land badly: `locked` (busy, retry in ~2s)
becomes `conflict`, which reads as a contradictory request; `maintenance`/`service_error`
become `unknown`, erasing "this is the cloud's fault, not yours"; `token_readonly` becomes
`auth`, indistinguishable from a bad token. A passthrough field is cheaper than a tenth code
and preserves what the operator needs to see. *(#8; `hetzner.ts:128`)*

**F2. Drop `ProviderError.retryable` and derive it from the code.** `rate_limited`, `capacity`
and `network` are inherently retryable; a separate boolean is a second source of truth that can
contradict the first. *(#7)*

---

## Deliberately unresolved

The freeze should **not** decide these yet. Each is listed with what would unblock it.

- **Spot/interruptible and `resize`.** Still no second implementation to generalize from; the
  original decision to cut them from the sketch was correct and should hold. *Unblocks when a
  second interruptible provider exists.*
- ~~**Whether callback mode survives at all.**~~ **RESOLVED — callback mode is KEPT.** The
  real-cloud run (`rockysurf-q5lm.5`) passed 26/26 with zero orphans, so the mode works on real
  infrastructure and is no longer speculative. Push remains the **default** per ADR-0002, and
  callback is the documented fallback, on the boundary that run established: *callback mode
  earns its keep only where core is already publicly reachable.* Its costs are quantified and
  unchanged — 72% of the AWS user-data ceiling with compression, a credential resident on the
  box for the whole bootstrap, and a runcmd where push mode has none. *(#44 closed; see exit
  question 2 and amendment E1.)*
- **Exact TTL and use budget for the plan token (E8).** The shape is settled, the numbers are
  not, and they depend on observed cloud-init timing across providers.
- **BYO provider shape.** `generatesUserData: false` is honoured in code but never exercised
  end-to-end; BYO is push-only by construction, since a box with no user-data cannot be told
  anything before boot. *Unblocks with one real BYO target.*
- **T-shirt size resolution when an architecture is unavailable.** The fallback logic does not
  exist, and cannot be designed before `Offering.available` (B1) gives it something to read.
- **Equalizing default network exposure between clouds.** AWS needs a VPC, subnet and security
  group; Hetzner needs none and a server is SSH-reachable the moment it boots. The clouds have
  genuinely different default exposure, and inheriting that difference is a product decision,
  not an interface one. *(`capability-differences.md` §5)*
- **Multi-region and multi-project scoping of the `listManaged()` prefix (D6).**

## Follow-up tasks to file

1. ~~**Real-cloud callback-mode run**~~ — **DONE** (`rockysurf-q5lm.5`, commit 5e537b0). Real
   cloud-init executed the callback document on AWS and the box reached `ready` on its own:
   26/26 checks, 95s, zero orphans, gz+b64 decoded to a byte-exact agent, single-use plan token
   spent then refused. Recording: `spike/recordings/aws-callback-lifecycle.txt`; script:
   `spike/verify-aws-callback.ts`. No longer blocks ADR-0002. *(#44 closed)*
2. **ARM-on-Hetzner is a demo-planning constraint, not a bug.** Hetzner had zero arm64 stock at
   spike time across all locations. Any demo or doc promising ARM-on-Hetzner needs a stock
   check first; use amd64 (cpx12) there and arm64 (t4g) on AWS. *(#11)*
3. **Reconciler specification** covering shared vs owned resources, secondary kinds, and the
   propagation grace — the concrete consumer of A3, A4, D1–D5.
4. **Persisted per-server key material**, encrypted at rest, with a rotation story. *(E3)*
5. **BYO provider end-to-end**, to exercise `generatesUserData: false` for real.
6. **Remove the duplicated resume rule.** `agent.sh` decides what to skip and `push.ts`
   re-implements the same rule in TypeScript so core can report the remainder before
   connecting; the agent should report its own remainder instead. *(`push.ts:120`)*
7. **Decide the default network exposure posture** across providers (see Deliberately
   unresolved).

---

## Verified evidence summary

Everything below was observed, not inferred.

**Both clouds, real infrastructure, first attempt, 29/29 checks each, zero orphans.** AWS
`t4g.small` **arm64** in us-east-1 (a sandbox account), 138s end to end, of which 68s is EC2
reaping. Hetzner `cpx12` **amd64** in fsn1, 81s end to end. Provisioning-to-usable-box is
otherwise near-identical; the teardown asymmetry is the whole difference.

**One plan, two architectures.** The same install plan — pinned at `agent.sh` sha256
`f95e7669…57cff44` for comparability — produced Claude Code 2.1.228 and node v24.19.0 on both
arm64 and amd64. One arch-aware line in the plan.

**cloud-init consumed core's exact bytes.** `user-data.txt` byte-identical on both clouds
(2130B / 2138B), inert (no `runcmd`/`bootcmd`), creating `rocky` with sudo and core's key.

**Host-key pinning, not TOFU.** The box presented the core-minted ed25519 key on first contact
on both clouds; a wrong fingerprint was rejected in under a second and never retried. Core's
hand-rolled OpenSSH key encoding is byte-identical to `ssh-keygen`'s output.

**NAT.** Core behind NAT, no public address, no port forward, no listener; every connection
outbound; the box was never given a core URL.

**Zero orphans, audited twice.** Interface-level (`listManaged()` empty) and, on AWS, behind
the interface: every managed instance genuinely terminated rather than shutting down, and no
managed EBS volumes surviving. Hetzner's servers and owned SSH keys both reaped.

**Idempotency on both mechanisms.** EC2 `ClientToken` replay returned the same instance with no
second launch; Hetzner name-dedupe resolved a collision to the existing server;
double-terminate is a no-op on both.

**Bootstrap edge cases, locally.** 18/18 push checks: idempotent re-push skipping every step
with timestamps untouched, resume after `SIGKILL` mid-plan, agent-death detection within one
poll interval, failure reporting with log tail, optional-step isolation, and the `systemd-run`
launcher with `Restart=on-failure` confirmed on a live unit. Callback: one-time token spent
once and 410 on replay, 7 progress reports across 3 steps, topology enforced structurally
(no ports, no sshd).

**Zero provider-id conditionals in core**, grep-enforced by tests. 186 unit tests green,
`tsc --noEmit` clean. Node 24 is required — corepack/pnpm breaks on the default Node 20.
