# Provider capability matrix

What each shipped provider declares in `ProviderCapabilities`, and the evidence behind it.

`ProviderCapabilities` is the **only** thing core is allowed to branch on — there are zero
`provider.id` conditionals in shared code, and that property is grep-enforced by tests. So this
table is not documentation of an implementation detail; it is the complete set of behavioural
differences core can see.

Types: [`@rockysurf/provider-sdk`](../../packages/provider-sdk/README.md).
Frozen by [ADR-0003](../adr/0003-provider-sdk-shape-and-exclusions.md).
Evidence: [`spike/recordings/capability-differences.md`](../../spike/recordings/capability-differences.md)
and the two real-cloud capstone transcripts beside it.

## The matrix

| capability | `aws` | `azure` | `gcp` | `hetzner` | `byo` |
|---|---|---|---|---|---|
| `stop` | `true` | `true` | `true` † | `true` | **`false`** |
| `ipStableAcrossStop` | **`false`** | `true` | **`false`** † | `true` | `true` |
| `canInjectHostKeys` | `true` | `true` † | `true` | `true` | **`false`** |
| `userDataMaxBytes` | `16384` | `49152` † | `262144` | `32768` | `0` |
| `generatesUserData` | `true` | `true` | `true` | `true` | **`false`** |
| `simulatedInstances` | absent | absent | absent | absent | absent |

`aws` and `hetzner` values are measured — both providers were built and run end to end against
real infrastructure. **`gcp` is now measured too, but not in every row**: a real Compute Engine
run settled most of the column and deliberately never touched two of the values, which is why the
daggers in it moved rather than disappeared.

**† A daggered value is REASONED RATHER THAN MEASURED** — an inference from the vendor's
documentation rather than an observation. Daggers are per value rather than per column, because a
run can settle some values in a column while never exercising the others, and that is exactly
what happened to `gcp`.

**`azure`.** Built without an Azure subscription. Every value is derived from Microsoft's own
documentation and from what the provider's code does, and the whole column is enforced by that
package's tests against an in-memory ARM — but nobody has pointed it at Azure. The two daggered
values are the ones to be careful with: `canInjectHostKeys` is a security posture rather than a
feature flag, and `userDataMaxBytes` is deliberately the conservative reading of an ambiguous
document. The owner-gated run that settles both is **`rockysurf-ihtq.8`**, and this table is one
of the things it updates.

**`gcp`.** Built without credentials, then **run against real Compute Engine on 2026-08-14**
(`rockysurf-ev41.8`). That run measured the create/terminate lifecycle on both architectures
(`e2-small` and `e2-micro` amd64, `t2a-standard-1` arm64), host-key injection, push bootstrap
over SSH, maintenance of the shared SSH firewall rule, and a terminate leaving zero orphans —
audited afterwards on Google's side as no instances and no disks left behind. The two values that
used to carry daggers, `canInjectHostKeys` and `generatesUserData`, were the ones it settled:
they rested on the same fact, that cloud-init's GCE datasource reads the `user-data` metadata
key, and a box cannot present a host key core minted unless that holds.

**What the run did not do is stop and start a box**, so `stop` and `ipStableAcrossStop` are the
daggered pair now. No GCP instance has ever been stopped and restarted by this provider. Both
values remain as well-founded as they were — `stop` is `instances.stop`, and
`ipStableAcrossStop` follows from asking for an ephemeral external IP — and both are still
reasoning rather than observation. A lifecycle run is not evidence for a power cycle it never
performed, and flipping a whole column on the strength of one is the move this table exists to
prevent. `userDataMaxBytes` is unchanged and undaggered: Google's documented
per-metadata-value ceiling, structural and never approached.

One difference in the *form* of the evidence, since this table is where people come to compare
it: `aws` and `hetzner` have committed transcripts you can read, and `hetzner` is re-run nightly.
The GCP run was driven by hand and through the MCP server, and no transcript of it was recorded
into the repository — what backs the column is a report of a run rather than an artefact of one.
[The status block in `gcp.md`](gcp.md#status-proven-on-real-google-cloud-except-stopstart) has it
in full.

`byo` is now **implemented** (`@rockysurf/provider-byo`, `rockysurf-ftl9.3`) and its column is
enforced by that package's tests rather than being a specification. Like `azure` it has no
real-infrastructure run behind it, though for a different reason: the tests drive a real SSH
client and a real in-process SSH server, which is what makes the host-key claims below evidence
rather than assertion, but nobody has yet pointed it at a rack.

## Row by row

### `stop` — can the instance be stopped and restarted with its disk intact?

All four clouds can. BYO cannot: core does not own the machine's power state, so there is
nothing to call.

**No GCP box has ever been stopped and restarted**, which is the one gap left in that column.
`rockysurf-ev41.8` drove create, bootstrap and terminate on real Compute Engine and deliberately
not the power cycle, so everything this section says about GCE's vocabulary is still pinned by a
test rather than by an observation.

**Azure's `stop` is `deallocate`, not `powerOff`,** and the distinction is the whole value of the
flag. Both preserve the disk; only one stops the bill. An Azure VM that is merely powered off is
charged the full compute rate for doing nothing, so a provider that implemented `stop` as
`powerOff` would report `stop: true` while delivering none of what core uses it for — idle
auto-stop is v0.1's cost lever. The disk and the public address keep billing either way, which is
the honest cost of a box you can start again.

**A word of warning on GCE's vocabulary**, because it is the trap this provider was written
around: Compute Engine reports a *stopped* instance with the status `TERMINATED`, which means
"stopped, disk intact, restartable" and NOT what the SDK's identically-spelled `terminated`
means. The provider maps it to `stopped`; GCE's word for a real teardown is `DEPROVISIONING`.
Getting that backwards would tell core a live, billing disk was gone. Azure has the mirror image
of the same trap — two off states where the SDK has one, and `deallocated` reading like "gone" —
so both providers pin their mapping with a test rather than a comment.

This flag is the single source of truth (ADR-0003, A2). `stop()` and `start()` are **required
methods on every provider**, and a provider that cannot stop implements both as
`throw unsupportedOperationError(this.id, 'stop')`. Core checks the flag and never
`typeof provider.stop === 'function'`, because two ways to ask the same question is how they
drift apart.

### `ipStableAcrossStop` — does a restarted instance keep its public IP?

**AWS: no.** An EC2 instance without an Elastic IP gets a new public IPv4 on every start. The
spike deliberately does not allocate Elastic IPs — they are a per-server resource to create,
tag, and reap, and one more orphan class.

**Azure: yes**, and it is a property of the ADDRESS rather than of the machine. Basic-SKU public
IPs — the only kind that could be Dynamic — were retired on 2025-09-30, so every address this
provider allocates is Standard, and Standard is always `Static`. A static address is released
only when the address resource itself is deleted, so it survives deallocate/start. There is no
Dynamic-Standard combination to guard against. Reasoned from Microsoft's documentation, not yet
measured.

**GCP: no**, for the same reason and by the same choice. An ephemeral external IP is released
on stop and a different one assigned on start; a reserved static address would be a per-server
resource to create, tag and reap, which is the orphan class AWS declined too. **Reasoned, not
measured.** AWS's identical claim has a transcript behind it showing the address change; the
real-GCE run never stopped a box, so nobody has watched this one happen.

**Hetzner: yes.** The primary IPv4 survives a poweroff/poweron.

**BYO: yes**, trivially — the address is whatever the operator configured, and core never
changes it.

This is what drives the `previousIp` / `ipChangedAt` UX: on a provider where the address moves,
core must re-read it after every start and tell the user their SSH config is stale.

### `canInjectHostKeys` — can the box come up already presenting a host key core minted?

Renamed from `canPinHostKey` (ADR-0003, E4) because the old name hid what it decides. This is a
**security posture**, not a feature toggle:

- **`true` (AWS and Hetzner)** — core generates an ed25519 host key before the server exists,
  ships the private half in `#cloud-config` `ssh_keys:`, and verifies it on the very first
  connection. There is no trust-on-first-use window, which matters because the first connection is
  the one carrying the secrets file. **Verified on real infrastructure for both clouds**: the
  capstone run confirmed the box presented exactly the minted fingerprint on first contact, and
  that a deliberately wrong fingerprint was rejected in under a second rather than retried.
- **`true` (Azure) — REASONED, NOT MEASURED, and this is the single most important unverified
  claim in this table.** Azure's Ubuntu images are cloud-init provisioned, `osProfile.customData`
  is what cloud-init consumes, and upstream `cc_ssh` injects host keys from an `ssh_keys:` block
  exactly as it does on the other two clouds; Microsoft documents no override. That is a good
  reason to expect it to work and it is not evidence. Because this flag is a **security posture**
  rather than a feature toggle — `true` promises core rejects an unknown host key on the
  connection carrying the secrets file — the honest thing is to name it as unproven here rather
  than let the column read like the other two. If `rockysurf-ihtq.8` disproves it, the flag
  becomes `false`, this row changes, and Azure joins BYO in needing the provider-side
  trust-on-first-use path.
- **`true` (GCP) — MEASURED.** Declared on the same mechanism — cloud-init's GCE datasource
  documents that it reads the `user-data` metadata key, so `ssh_keys:` places the key before
  first boot — and `rockysurf-ev41.8` watched real Google boxes do exactly that, on both
  architectures. The specific failure this row was written to be honest about did not happen:
  GCE's guest agent does not regenerate the host key out from under a `ssh_keys:` block, so the
  value stays `true` and it is now an observation. GCP has no trust-on-first-use window either.
- **`false` (BYO)** — with no user-data there is no way to place a key before first contact, so
  the key has to be learned instead: recorded on first connection, refused on any change
  afterwards, and said plainly in the UI.

  **Where that trust decision lives is the part worth knowing.** It is not in core. The BYO
  provider connects to the box before core ever does — it must, in order to install the account
  and authorized keys that cloud-init installs elsewhere — so it does the trusting, pins the
  result, and reports the fingerprint to core through `InstanceView.hostKeyFingerprint`
  (ADR-0003, amendment E12). Core folds it onto the server row and then verifies **strictly**, the
  same way it does for a cloud box. Core has no trust-on-first-use path and does not grow one for
  BYO; what it receives is a pin, not permission to trust. An operator who supplies
  `fingerprint:` in the host's configuration closes the remaining window: the provider's own first
  connection is then verified too.

Strictly this is a property of the image's cloud-init rather than of the provider API — it works
because cloud-init honours `ssh_keys:` and neither cloud strips user-data. It lives in
capabilities because core has nowhere else to ask.

### `userDataMaxBytes` — hard ceiling on the rendered document, before transport encoding

AWS's 16,384-byte limit is the binding one; Hetzner's 32,768 has never been approached, and
GCP's 262,144 — Google's documented ceiling on a single metadata *value*, inside a 512 KB total
across all entries — is sixteen times AWS's and could not be reached by anything core renders.
BYO is `0` because there is no pre-boot hook at all.

**Azure declares 49,152, which is deliberately SMALLER than the ceiling Microsoft documents.**
The docs say `customData` "can't exceed 64 KB" and do not say whether that is measured before or
after the mandatory base64 encoding — and base64 inflates by a third, so the two readings differ
by 16 KB. 48 KiB is the largest value correct under either. Guessing high to reclaim headroom
nobody uses would buy a provider-side rejection at provision time, and in push mode the rendered
document is ~2.1KB regardless, so the ceiling is nowhere near binding. Which reading is right is
one of the things `rockysurf-ihtq.8` can settle.

The ceiling is real, not theoretical. Embedding the agent in-band for callback mode produced
**19,130 bytes** — fine on Hetzner, a provider-side 400 at provision time on AWS, and invisible
to unit tests. cloud-init's native `gz+b64` brings the same document to 10,934 bytes.

In push mode the rendered document is **~2.1KB and constant** no matter how much software the
install plan adds (2130B on AWS, 2138B on Hetzner in the capstone), because installation moved
out of user-data entirely. That is the main reason the ceiling stops being a design constraint.

Enforced in two places: core checks when rendering, and `validateSpec()` lets the provider
reject a spec before anything is created (ADR-0003, A7).

### `generatesUserData` — does the provider deliver user-data at all?

All four clouds do. AWS and Hetzner are measured: the capstone verified the document arrives
**byte-for-byte**, matching `/var/lib/cloud/instance/user-data.txt` on the box exactly, on both.

**Azure** delivers it as `osProfile.customData`, base64-encoded, which is what cloud-init reads on
first boot. Note that Azure has a *separate* `properties.userData` field which is **not** this
one: it is readable from IMDS and mutable after boot, and cloud-init does not consume it.

**GCP** delivers it through the `user-data` instance metadata key, the documented cloud-init
path on Google's images, and `rockysurf-ev41.8` confirmed the delivery the same way it confirmed
the row above: a box cannot present a host key core minted unless cloud-init consumed the
document carrying it. Note the difference in strength, though — AWS and Hetzner were compared
byte-for-byte against the file on the box, and no GCP run has done that.

BYO does not. Core renders no document, and bootstrap is SSH push only — which is the same push
path both clouds already use after first boot, so BYO is a subset rather than a separate
mechanism. Note the dependency: `generatesUserData: false` forces `canInjectHostKeys: false`.

What cloud-init would have done before boot, the BYO provider does over SSH at claim time:
create the account core connects as, write `authorized_keys` (appending, never truncating — the
operator's own access is in that file), and grant passwordless sudo, which the bootstrap agent
needs to install anything. Everything after that point is the ordinary push bootstrap.

### `simulatedInstances` — is there a machine at the address this provider reports?

**Absent on all four, which is the answer `false`.** It is optional (ADR-0003, amendment E15) and
no shipped provider sets it: every one of them creates or claims real hardware.

The only thing that does is the in-memory provider, and only in one of its two roles. As the CI
test double it declares nothing, because tests drive bootstrap progress themselves. As the
no-cloud trial run — what `composeRegistry` registers when nothing else loads, so that
`npx rockysurf` works without a cloud account — it declares `true`, and core responds by driving
that server's install plan **in-process** instead of over SSH.

Everything else about such a server is ordinary. The plan is the one the resolver rendered from
the real packs, progress is recorded by `recordProgress`, the promotion to `running` is the same
`recordProgress('ready')` bootstrap always owned (`rockysurf-55fx.13`), and the uptime ticker
bills it like any other running row. Only the transport is simulated, and no install script is
ever executed — a trial run must not install software on the machine somebody is evaluating Rocky
Surf from.

**A provider must not set this while reporting addresses that resolve to real hosts.** Core takes
it as permission to skip the SSH drive entirely, so a provider that lied here would report a box
as installed with nothing on it.

## Differences this table cannot express

Not every divergence between clouds is a capability. These are real, and they live in the types
or in provider configuration instead — recorded here so nobody looks for a flag that should not
exist:

- **Stock availability, and availability that is not about stock.** Hetzner had zero arm64 stock
  across all locations at capstone time while still publishing prices for sold-out types — that
  is per-offering and time-varying. GCP is the same field used for the opposite kind of fact:
  its arm64 family (Tau T2A) is offered in exactly eight zones and is *permanently* absent
  everywhere else, which is published and stable rather than an afternoon's stock level. Both
  belong on `Offering.available`; neither is a capability, because both vary per offering rather
  than per provider.
- **Terminal-state latency.** EC2 sits in `terminating` for 30-120s; Hetzner drops the server
  almost immediately. Expressed by the `terminating` state itself.
- **Secondary resources, and how many of them there are.** Hetzner's API will not take raw key
  material inline, so its provider creates first-class SSH Key objects it then owns; AWS needs no
  such thing but keeps one shared security group. **Azure is the extreme case**: a running box is
  four resources — the VM, its OS disk, its network interface and its public IP — and Azure
  PERSISTS all of them when the VM is deleted, so the provider sets `deleteOption: 'Delete'` in
  three places at create time to make one delete cascade. All of this is expressed by
  `ManagedResource.ownership` and by what `terminate()` reaps; none of it needs a capability,
  because core never has to know how many resources a machine is made of.
- **Whether the cloud tags what it creates.** Azure does not copy a VM's tags onto the OS disk it
  creates from an image, and ARM's own tag filter does not return tags on the resources it
  matches. So Azure's `listManaged()` lists a whole resource group rather than filtering by tag,
  and attributes a stray disk through `managedBy`. This is the D4 orphan class — a volume that
  survives its instance and is invisible to any audit that walks instances — solved per provider,
  which is where it belongs.
- **Network prerequisites and default exposure.** AWS needs a VPC, subnet, and security group
  before an instance can exist; Azure needs a virtual network, a subnet, a security group AND a
  public IP, and unlike AWS it has no default VPC to fall back on, so the provider creates them
  and adopts them thereafter; Hetzner needs none and a server is SSH-reachable the moment it
  boots. The clouds therefore have **different default exposure**, which ADR-0003 leaves
  deliberately unresolved as a product decision rather than an interface one. Azure is the
  strictest of the three by default: a Standard-SKU public IP is closed to inbound traffic until
  a security rule opens it, so a missing `sshAllowedCidr` fails loudly rather than quietly.
- **The management console URL.** Every provider's console has its own URL shape, and one of
  them needs a value its API does not expose: a Hetzner console link contains the numeric
  PROJECT id, which no Cloud API response carries, so it comes from
  `providers.hetzner.consoleProjectId` and there is no link without it. AWS needs nothing extra —
  region plus instance id. Azure needs nothing extra either — an ARM resource id already contains
  the subscription, the group and the name, and the portal resolves one without being told the
  tenant — and GCP likewise, since the project, zone and instance name are all things its provider
  already holds. BYO and the in-memory provider have no console at all. This is
  per-instance rather than per-provider, so it is expressed by `InstanceView.consoleUrl`
  (ADR-0003, amendment E16), which is absent when the provider cannot construct one honestly.
- **Base image contents.** All three clouds run "Ubuntu 24.04" and they are not the same image —
  Hetzner's ships without `jq`. Nothing in `Offering` or `ProviderCapabilities` describes image
  contents and nothing reasonably could; the obligation belongs to the agent, which must
  bootstrap anything it needs before it can parse its own plan.

## Adding a provider

Fill in a column here in the same PR that adds the provider, with a note on how each value was
established. A value nobody has exercised should say so, the way the `byo` column does.
