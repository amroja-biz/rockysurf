# Spike findings — lead's consolidated working notes

> Raw material for `docs/spike/findings.md` (rockysurf-d0no.8). Collected from the scaffold,
> Hetzner, and AWS agents' reports + `SPIKE-FINDING:` source comments. The memo task should
> verify against source, add d0no.5/.6/.7 findings, and turn these into freeze decisions.

## Interface shape (sdk.ts)

1. **Drop the `TData` generic.** `ComputeProvider<TData>` is invariant (TData in both positions), so a heterogeneous registry degrades to `any`. providerData round-trips through JSON in the DB anyway — the compile-time type is fiction once a row is read back. (scaffold)
2. **`stop?` + `capabilities.stop` = two sources of truth** TypeScript can't link. Pick one: presence IS the capability, or always-present method throwing `invalid_spec`. (scaffold)
3. **`describe()` on a vanished instance must be defined**: not_found → `state: 'terminated'`, never throw. Teardown polling depends on it. Confirmed empirically on both clouds. (scaffold #3, hetzner, aws)
4. **`InstanceView` needs a `terminating` state** (EC2 `shutting-down` 30-60s+, Hetzner `deleting` seconds). Both agents mapped terminal-but-not-reaped states pragmatically; freeze must define it. Closest bug: Hetzner mapped `deleting`→`stopping`, which app.ts maps → `running` — would resurrect a terminating row if polled. (hetzner #7, aws #2)
5. **`InstanceView` has no failure state** — a failed instance reads as `unknown`. (scaffold extra-b)
6. **`provision()` returns only `{data}`** so core must immediately `describe()` to learn state/IP (scaffold's `sync()` helper). Consider returning an initial InstanceView. (scaffold extra-a)
7. **`ProviderError.retryable` duplicates the code** (rate_limited/capacity/network inherently retryable). (scaffold extra-c)
8. **Error taxonomy loses information**: Hetzner `locked` (busy, retry 2s) → `conflict` (reads as contradictory request); `maintenance`/`service_error` → `unknown` (erases "cloud's fault"); `token_readonly` → `auth` (indistinguishable from bad token). Add a `providerCode` passthrough on ProviderError (cheaper than a 10th code). (hetzner #8)
9. **Consider `validateSpec(spec)` provider method** — `userDataMaxBytes` is advisory-only today; nothing validates before a vendor-specific rejection at provision time. Providers should own their limits. (scaffold #6)

## Offerings & pricing

10. **`Offering` needs `available: boolean` — a price is not an offer.** Hetzner publishes prices for sold-out CAX types; without availability, core can't distinguish "this cloud has no ARM" from "ARM is sold out this afternoon" — exactly what a size selector's error needs to say. Confirmed by real 412 `resource_unavailable` on all CAX/all locations. (hetzner #1)
11. **Hetzner currently has ZERO arm64 stock** (all CAX, all locations, confirmed by order attempts). d0no.7 must not require ARM-on-Hetzner; run amd64 (cpx12 $0.0216/h) there, ARM (t4g) on AWS. Operational fact, not interface bug — but it kills any "ARM-first Hetzner" demo assumption until stock returns.
12. **`hourlyUsd` hardcodes currency** — Hetzner quotes in the project's billing currency; EUR projects would report null. Use `{ amount, currency }` + `fetchedAt`. (hetzner #3)
13. **`deprecated` is per-location, not per-type** on Hetzner (cpx types: `deprecated:false` with per-location `unavailable_after`). (hetzner #2)
14. **`Offering.id` stays a string** — AWS SDK types InstanceType as a closed union, cast is unavoidable; providers own validation of native ids. (aws #7)

## Idempotency & naming

15. **Idempotency key derivation is unspecified and load-bearing.** Hash of name+provider+offering collides forever after terminate-and-recreate; needs a generation/epoch component. Spike works around by skipping terminal rows. (scaffold #5)
16. **`serverId` is not a legal provider name** (Hetzner: RFC 1123 hostnames, no underscores) and name IS Hetzner's dedupe mechanism — the sanitizing map must be injective (`srv_a` vs `srv-a` collide). Freeze: hostname-safe ids, or explicit `dedupeName` on ProvisionSpec. (hetzner #4)
17. **ClientToken replay verified working on EC2** (same instance returned, no second launch) and name-dedupe verified on Hetzner (uniqueness_error → resolve to existing). The idempotency design holds on both clouds. (aws, hetzner verifications)

## Managed resources & reconciler

18. **`ManagedResource` can't express "shared, do not reap".** AWS shared SSH SG carries the managed-by tag but outlives every server — a reconciler treating listManaged as a delete-list would break running instances. Add `shared: boolean` (or kind-level policy). (aws #3)
19. **`listManaged()` needs a construction-time prefix** (no filter arg) — one process can't reconcile two prefixes without two provider instances. Probably fine; document it. (scaffold #4)
20. **provision() can create secondary resources** (Hetzner SSH Key objects) that terminate must clean and listManaged must report; a crash between calls orphans a key the DB never references — reconciler must sweep secondary kinds too. Fingerprint-matched pre-existing keys must NOT be claimed as owned. (hetzner #5)
21. **Orphan-by-construction guard**: provider should refuse a spec whose managed-by tag disagrees with its own prefix. (aws #8)
22. **Volume orphan risk (AWS)**: sizing the root volume requires the AMI's RootDeviceName — guessing /dev/sda1 can attach a second volume that survives termination and is invisible to instance-walking listManaged. Verified fix: derive from AMI + DeleteOnTermination + tag volumes; audit DescribeVolumes by tag. (aws #6)

## Keys, user-data, bootstrap topology

23. **`sshPublicKeys`/`hostKeys` are dead fields for cloud-init providers** — keys reach the box only through the rendered userData. AWS provider asserts keys appear in userData rather than consuming the fields. `canPinHostKey` really means "userData reaches cloud-init". Pick one owner for key material (likely: core renders userData; fields exist for generatesUserData=false providers only). (aws #1, hetzner #6)
24. **ProvisionSpec has no slot for the callback token**, and scp is the only delivery that works for BYO — push-mode should be the freeze's DEFAULT assumption, callback the alternative. (scaffold #7)
25. **AWS RunInstances NetworkInterfaces is all-or-nothing** — requesting a public IP forces the interface form; top-level SubnetId/SecurityGroupIds then conflict. (aws #5)
26. **Caller-/32 SSH ingress breaks when the operator's network changes** — nothing in the sketch lets core "refresh my access". Candidate: `ensureAccess()`/`authorizeCaller()` method, or document SG update as provider config. Bears on exit question #2. (aws #4)

27. **CRITICAL: "not found = terminated" is only safe after a propagation grace period.** EC2 DescribeInstances is eventually consistent — describe() 0.1s after a successful launch returned not-found, which finding #3's mapping would read as 'terminated'; core would mark a healthy, billing server dead. Fix proven in aws.ts: bounded grace (4 attempts, 2s apart) before absence is believed, only for instances never yet seen running. The freeze MUST state this alongside the not_found→terminated rule — a provider that takes the sketch literally ships this bug. Evidence: spike/verify-aws.run1.log + 3 regression tests. (aws, found by real run — invisible to unit tests)

## Bootstrap topology (d0no.5, local Docker verification)

28. **Any file-polling status design needs a per-run id.** A re-push read the PREVIOUS run's terminal state.json and reported the old failure as the new result. Fixed: runId stamped into state.json on every push; callback mode needs the same. (bootstrap bug a)
29. **Launcher introspection must go through sudo** — unprivileged `systemctl is-active` fails with "no bus" which reads as not-running; core declared a healthy bootstrap dead. (bootstrap bug b)
30. **Watch the launcher, not just the file**: stall timeouts can't distinguish slow-apt from SIGKILLed agent; transient systemd unit gives a real is-active answer where pgrep is a guess. Strongest argument for the systemd design.
31. **Push topology needs no inbound anything** — no public core URL, no callback token on the box (nothing leakable via instance metadata). Cost: core must stay alive during install; the resume path (runId + state.json skip-done) makes that survivable. Freeze should assume push as DEFAULT, callback as the alternative. (also scaffold #7)
32. **userDataMaxBytes stops mattering in push mode** — pre-boot #cloud-config is ~2.1KB, grows only with keys.
33. **Host private keys need a first-class encrypted home** — ProvisionSpec carries hostKeys to the provider, but nothing persists the private halves; a core restart between provision and bootstrap loses the ability to authenticate to its own box. Also `canPinHostKey` silently decides strict-verification vs TOFU; the capability should say that explicitly.
34. Minor: agent.sh must bootstrap jq before parsing its own JSON plan on a bare image; step `id`/`reports` is one vocabulary too many in push mode (core already holds the plan).
35. Evidence: cloud-config validated by cloud-init's own schema checker; ed25519 keygen byte-identical to ssh-keygen; full install → Claude Code working over SSH as rocky on arm64; idempotent re-push skips all steps; SIGKILL-resume verified; systemd Restart=on-failure confirmed live. 18/18 integration checks (`pnpm run verify:push`).

## From the two-cloud capstone (d0no.7, real infrastructure)

36. **"Ubuntu 24.04" is not a contract about installed packages** — Hetzner's image ships without jq (AWS's has it); agent.sh's defensive jq-bootstrap path fired only on Hetzner. Anything the agent needs before parsing its own plan must be bootstrapped per-image, never assumed. (d0no.7)
37. **A zero-orphan claim built only on listManaged() is falsely green on AWS for ~60s** (terminal-but-unreaped reads as gone). Real audits must go behind the interface (raw DescribeInstances/DescribeVolumes). Same root cause as the missing `terminating` state (#4). (d0no.7)
38. **Prose-leak warning for the freeze**: three of eight cloud divergences (availability, terminal-state semantics, secondary-resource ownership) had no interface field and ended up expressed in comments and provider-local structures — "leaking into comments rather than conditionals, which is worse: nothing enforces a comment." These correspond to findings #10, #4, #18/#20 — the freeze must give them fields. (d0no.7)

## Callback mode (d0no.6, local unreachable-core topology)

39. **FREEZE DECISION (pair with #27): callback mode barely fits AWS user-data.** agent.sh embedded verbatim = 19,130B vs EC2's 16,384B hard ceiling — a provider-side 400 at provision time, on AWS only, invisible to unit tests and to Hetzner's 32KB. cloud-init native gz+b64 gets it to 10,934B (67% of ceiling). Push user-data is a CONSTANT ~2.1KB regardless of plan size; callback grows with the agent. Push must be the default; callback the documented fallback. (d0no.6)
40. **Single-use tokens and at-least-once delivery do not compose** — token spent + response lost in transit = bricked box (410 on retry, no plan, no way to ask again). Shipped mitigation: retry only connect/5xx/429, never replay 4xx, fetch only when planless. Freeze should consider short-TTL + small use budget instead of strict single-use. Plan token is a SEPARATE secret from the status token; replay recorded on the row (planTokenReplayedAt) as the only leak signal core ever gets. (d0no.6)
41. **Callback reintroduces the shell push deleted** — user-data can't be inert (something must start the process), so it grows runcmd + carries the agent. Another push-as-default argument. (d0no.6)
42. **Two token vocabularies are both needed in callback mode**: plan fetch = single-use planToken; status POSTs = callbackToken, deliberately NOT single-use, blast radius bounded to writing progress strings on one row — no route returning secrets may ever accept it. Reports carry stepId (labels alone are lossy: 3 steps under 2 labels) + runId (stale-run reports recorded for forensics, 202, don't move the row — #28 from the wire side). (d0no.6)
43. **Control-plane credentials must not share a file with installed software's env** — agent.sh exports secrets.env into every unprivileged step; callback config lives in a separate never-exported 0600 callback.env, token never in argv (readable via ps). Security asymmetry stated plainly: callback leaves a core credential on the box for the whole bootstrap (readable via instance metadata); push leaves none. (d0no.6)
44. **Boundary**: cloud-init executing the callback user-data on a real provider is unproven (harness applied write_files/runcmd itself; document validated by cloud-init's schema checker). If the freeze keeps callback mode, it owes a d0no.7-style real-cloud run — file as a design-freeze-phase task. (d0no.6)
45. Evidence: one-time plan token spent/410-on-replay; 7 progress reports covering all 3 steps; topology enforced structurally (box publishes no ports, no sshd — asserted at runtime); ready gated on the box's own claude --version (2.1.228); 186 tests green; full push harness re-run after changes: 18/18 (d0no.7 unaffected).

## Verified end-to-end (evidence, not concerns)

- Hetzner full lifecycle: 20.3s, fsn1, cpx12; replay dedupe; double-terminate no-op; zero orphans (servers + ssh keys). `spike/verify-hetzner.log`.
- AWS full lifecycle: sandbox account; t4g.small ARM; running in ~12s; ClientToken replay same-instance; terminate idempotent; genuinely-terminated audit + zero volumes. `spike/verify-aws.log`.
- Zero provider-id conditionals in core (grep-enforced by tests); all behavioral differences flow through `capabilities.*`.
- 163 unit tests green across scaffold + both providers + bootstrap; tsc clean. Node 24 required (corepack/pnpm breaks on the default Node 20).
- **Two-cloud REAL push lifecycle (d0no.7): PASS first attempt, 29 checks each, zero orphans.** AWS t4g.small/arm64 138s total (push bootstrap 31s; 68s of that is EC2 reaping); Hetzner cpx12/amd64 81s. Host-key pinning proven on real infra — box presents the core-minted key on first contact, no TOFU window; wrong fingerprint rejected <1s. cloud-init consumed core's exact bytes on both (user-data.txt byte-identical). One identical plan produced working Claude Code 2.1.228 + Node 24 on both architectures. NAT: core behind NAT, no listener, all connections outbound, box never given a core URL. Recordings: spike/recordings/.
