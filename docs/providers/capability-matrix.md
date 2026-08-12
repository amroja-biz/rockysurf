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

| capability | `aws` | `hetzner` | `byo` |
|---|---|---|---|
| `stop` | `true` | `true` | **`false`** |
| `ipStableAcrossStop` | **`false`** | `true` | `true` |
| `canInjectHostKeys` | `true` | `true` | **`false`** |
| `userDataMaxBytes` | `16384` | `32768` | `0` |
| `generatesUserData` | `true` | `true` | **`false`** |

`aws` and `hetzner` values are measured — both providers were built and run end to end against
real infrastructure.

`byo` is now **implemented** (`@rockysurf/provider-byo`, `rockysurf-ftl9.3`) and its column is
enforced by that package's tests rather than being a specification. It is still the one column
with no real-infrastructure run behind it: the tests drive a real SSH client and a real
in-process SSH server, which is what makes the host-key claims below evidence rather than
assertion, but nobody has yet pointed it at a rack.

## Row by row

### `stop` — can the instance be stopped and restarted with its disk intact?

Both clouds can. BYO cannot: core does not own the machine's power state, so there is nothing
to call.

This flag is the single source of truth (ADR-0003, A2). `stop()` and `start()` are **required
methods on every provider**, and a provider that cannot stop implements both as
`throw unsupportedOperationError(this.id, 'stop')`. Core checks the flag and never
`typeof provider.stop === 'function'`, because two ways to ask the same question is how they
drift apart.

### `ipStableAcrossStop` — does a restarted instance keep its public IP?

**AWS: no.** An EC2 instance without an Elastic IP gets a new public IPv4 on every start. The
spike deliberately does not allocate Elastic IPs — they are a per-server resource to create,
tag, and reap, and one more orphan class.

**Hetzner: yes.** The primary IPv4 survives a poweroff/poweron.

**BYO: yes**, trivially — the address is whatever the operator configured, and core never
changes it.

This is what drives the `previousIp` / `ipChangedAt` UX: on a provider where the address moves,
core must re-read it after every start and tell the user their SSH config is stale.

### `canInjectHostKeys` — can the box come up already presenting a host key core minted?

Renamed from `canPinHostKey` (ADR-0003, E4) because the old name hid what it decides. This is a
**security posture**, not a feature toggle:

- **`true` (both clouds)** — core generates an ed25519 host key before the server exists, ships
  the private half in `#cloud-config` `ssh_keys:`, and verifies it on the very first connection.
  There is no trust-on-first-use window, which matters because the first connection is the one
  carrying the secrets file. **Verified on real infrastructure for both clouds**: the capstone
  run confirmed the box presented exactly the minted fingerprint on first contact, and that a
  deliberately wrong fingerprint was rejected in under a second rather than retried.
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

AWS's 16,384-byte limit is the binding one; Hetzner's 32,768 has never been approached. BYO is
`0` because there is no pre-boot hook at all.

The ceiling is real, not theoretical. Embedding the agent in-band for callback mode produced
**19,130 bytes** — fine on Hetzner, a provider-side 400 at provision time on AWS, and invisible
to unit tests. cloud-init's native `gz+b64` brings the same document to 10,934 bytes.

In push mode the rendered document is **~2.1KB and constant** no matter how much software the
install plan adds (2130B on AWS, 2138B on Hetzner in the capstone), because installation moved
out of user-data entirely. That is the main reason the ceiling stops being a design constraint.

Enforced in two places: core checks when rendering, and `validateSpec()` lets the provider
reject a spec before anything is created (ADR-0003, A7).

### `generatesUserData` — does the provider deliver user-data at all?

Both clouds do, and the capstone verified the document arrives **byte-for-byte**: what core sent
matched `/var/lib/cloud/instance/user-data.txt` on the box exactly, on both clouds.

BYO does not. Core renders no document, and bootstrap is SSH push only — which is the same push
path both clouds already use after first boot, so BYO is a subset rather than a separate
mechanism. Note the dependency: `generatesUserData: false` forces `canInjectHostKeys: false`.

What cloud-init would have done before boot, the BYO provider does over SSH at claim time:
create the account core connects as, write `authorized_keys` (appending, never truncating — the
operator's own access is in that file), and grant passwordless sudo, which the bootstrap agent
needs to install anything. Everything after that point is the ordinary push bootstrap.

## Differences this table cannot express

Not every divergence between clouds is a capability. These are real, and they live in the types
or in provider configuration instead — recorded here so nobody looks for a flag that should not
exist:

- **Stock availability.** Hetzner had zero arm64 stock across all locations at capstone time
  while still publishing prices for sold-out types. That is per-offering and time-varying, so it
  belongs on `Offering.available`, not here.
- **Terminal-state latency.** EC2 sits in `terminating` for 30-120s; Hetzner drops the server
  almost immediately. Expressed by the `terminating` state itself.
- **Secondary resources.** Hetzner's API will not take raw key material inline, so its provider
  creates first-class SSH Key objects it then owns; AWS needs no such thing but keeps one shared
  security group. Expressed by `ManagedResource.ownership`.
- **Network prerequisites and default exposure.** AWS needs a VPC, subnet, and security group
  before an instance can exist; Hetzner needs none and a server is SSH-reachable the moment it
  boots. The two clouds therefore have **different default exposure**, which ADR-0003 leaves
  deliberately unresolved as a product decision rather than an interface one.
- **Base image contents.** Both clouds run "Ubuntu 24.04" and they are not the same image —
  Hetzner's ships without `jq`. Nothing in `Offering` or `ProviderCapabilities` describes image
  contents and nothing reasonably could; the obligation belongs to the agent, which must
  bootstrap anything it needs before it can parse its own plan.

## Adding a provider

Fill in a column here in the same PR that adds the provider, with a note on how each value was
established. A value nobody has exercised should say so, the way the `byo` column does.
