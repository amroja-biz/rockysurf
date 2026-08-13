# Capability differences: AWS vs Hetzner (rockysurf-d0no.7)

Input to the findings memo (`rockysurf-d0no.8`). This answers spike exit question **(3)**:
every place the two clouds diverge, how the divergence was expressed, and whether it leaked a
provider `if` into shared code.

Recorded from the two real lifecycle runs in this directory:
`aws-lifecycle.txt` (t4g.small, **arm64**) and `hetzner-lifecycle.txt` (cpx12, **amd64**).

## The declared capability matrix

| capability | AWS | Hetzner | how the difference is expressed |
|---|---|---|---|
| `stop` | `true` | `true` | no divergence |
| `ipStableAcrossStop` | **`false`** | **`true`** | data on the row: core writes `previousIp`/`ipChangedAt` when the IP moves. Never branched on in this run — neither box was stopped. |
| `canPinHostKey` | `true` | `true` | no divergence, but load-bearing: `renderUserData` emits the `ssh_keys:` block **only** when the flag is set, and `push.ts` has no trust-on-first-use path. A `false` provider would silently drop to a weaker security posture — see the `keys.ts` finding. |
| `userDataMaxBytes` | **16384** | **32768** | one `if` in `renderUserData`, comparing rendered bytes against `provider.capabilities.userDataMaxBytes`. Both runs rendered ~2.1KB, so the ceiling is not a live constraint in push mode. |
| `generatesUserData` | `true` | `true` | no divergence (BYO would be `false`) |

**No shared-code path branches on `provider.id`.** The lifecycle body in `verify-two-cloud.ts`
reads `provider.capabilities` and never the id; the per-cloud values are *data* in the
`CLOUDS` table (offering, arch, orphan sweep).

## Divergences the capability struct does NOT describe

These are the interesting ones — real differences with nowhere to live in the sketch.

1. **Architecture availability is a live constraint, not a static fact.** Hetzner had *zero*
   arm64 (`cax*`) stock in fsn1 at run time — `listOfferings()` returned 13 amd64 types and
   nothing else — so this run used cpx12/amd64 there and t4g.small/arm64 on AWS. `Offering`
   has no availability field, so "orderable right now" is expressed by the Hetzner provider
   *omitting* unavailable types from `listOfferings()` (its `includeUnavailable` option).
   AWS's offering table is hardcoded and always "available". A t-shirt-size resolver that
   asks for arm64 would therefore find nothing on Hetzner and would need to fall back —
   logic that does not exist yet. **The freeze needs an availability signal on `Offering`.**

2. **Terminal states differ in shape, and neither fits `InstanceView`.** EC2 sits in
   `shutting-down` for 30-120s; Hetzner sits in `deleting` for a few seconds and then 404s.
   The union has no `terminating`, so AWS maps it to `terminated` and Hetzner maps it to
   `stopping` (which `app.ts` then reads as `running` — latent bug, documented in
   `hetzner.ts`). **Two providers, two different wrong answers: the freeze must add the state.**

3. **What `listManaged()` must return is not the same set.** AWS returns instances plus one
   intentionally persistent, shared security group. Hetzner returns servers plus first-class
   **SSH key** resources that `provision()` had to create because the API will not take raw
   key material inline. `ManagedResource` cannot say "shared, do not reap" (AWS) and cannot
   say "owned by this server, reap with it" (Hetzner) — both were expressed in prose comments
   and in `HetznerData.sshKeyIds`, not in the type. **The freeze needs an ownership/shared
   flag**, or a reconciler will either orphan Hetzner keys or delete the AWS group from under
   running servers.

4. **Idempotency mechanisms are structurally different.** AWS passes `idempotencyKey` to
   EC2 as `ClientToken` — the provider does nothing itself. Hetzner has no such concept, so
   the provider derives a deterministic server *name* and treats a name collision as a
   replay. Same `ProvisionSpec` field, two mechanisms; the sketch's comment
   ("EC2 ClientToken / Hetzner name-dedupe") already anticipated this and it held up. The
   only wart is that the Hetzner name is derived by folding the id to hostname-safe
   characters, which is not injective (`hetzner.ts` finding).

5. **Network prerequisites are asymmetric.** AWS needs a VPC, a subnet, and a security group
   before an instance can exist, and the provider lazily ensures a shared SSH group scoped to
   the operator's `/32`. Hetzner needs none of it — a server is reachable on SSH the moment it
   boots, with no firewall object at all. This is invisible in the interface (both are just
   `provision()`), and it is why the AWS provider has a `sweep` for security groups and
   Hetzner does not. It also means the two clouds have **different exposure by default**,
   which the product should probably equalize rather than inherit.

6. **`sshPublicKeys` is used by exactly one of them.** On AWS the field is dead — keys can
   only be authorized through cloud-init, so the provider asserts the keys appear in
   `userData` and otherwise ignores the field. On Hetzner the field is genuinely needed,
   because `ssh_keys` on the create call must reference key objects the provider creates
   first. The same field is redundant on one provider and load-bearing on the other.

7. **The base image is not the same image.** Both clouds ran "Ubuntu 24.04", but Hetzner's
   `ubuntu-24.04` ships without `jq` while Canonical's AWS AMI includes it — so `agent.sh`
   took its `jq missing` bootstrap path on Hetzner only. Nothing in `Offering` or
   `ProviderCapabilities` describes image contents, and nothing could reasonably: the lesson
   is that **the agent must not assume any package exists before it can parse its own plan.**
   Expressed today as defensive bootstrapping inside `agent.sh`, which is the right place.

8. **Teardown latency differs by ~60s and is invisible through the interface.** EC2 holds
   `shutting-down` for about a minute; Hetzner drops the server and its owned SSH key almost
   at once. Because `listManaged()` treats terminal-but-unreaped as gone, a zero-orphan check
   written against the interface alone passes on AWS while the instance still exists. The AWS
   sweep goes behind the provider to raw `DescribeInstances`/`DescribeVolumes` for that
   reason; Hetzner needs no such workaround. **This is the same missing `terminating` state as
   (2), seen from the reconciler's side.**

## Verdict on exit question (3)

Capability and taxonomy differences **were** expressible without provider conditionals in
shared code — but three of the six divergences above (availability, terminal state,
resource ownership) had to be expressed in comments and provider-local data structures
because the sketch has no field for them. They are not leaking `if (provider.id === 'aws')`
today; they are leaking into *prose*, which is worse, because nothing enforces it.
