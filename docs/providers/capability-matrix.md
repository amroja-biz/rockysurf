# Provider capability matrix

What each provider declares in `ProviderCapabilities`, and the evidence behind it. Five of the
columns are the providers this distribution ships; `digitalocean` is a PERSONAL provider
([ADR-0026](../adr/0026-personal-providers.md)) that lives in this repository, is built and tested
by CI, and is installed rather than composed — it is in the table because core branches on these
values whoever wrote the package.

`ProviderCapabilities` is the **only** thing core is allowed to branch on — there are zero
`provider.id` conditionals in shared code, and that property is grep-enforced by tests. So this
table is not documentation of an implementation detail; it is the complete set of behavioural
differences core can see.

Types: [`@rockysurf/provider-sdk`](../../packages/provider-sdk/README.md).
Frozen by [ADR-0003](../adr/0003-provider-sdk-shape-and-exclusions.md).
Evidence: [`spike/recordings/capability-differences.md`](../../spike/recordings/capability-differences.md)
and the two real-cloud capstone transcripts beside it.

## The matrix

| capability | `aws` | `azure` | `gcp` | `hetzner` | `byo` | `digitalocean` |
|---|---|---|---|---|---|---|
| `stop` | `true` | `true` | `true` | `true` | **`false`** | `true` † |
| `ipStableAcrossStop` | **`false`** | `true` | **`false`** † | `true` † | `true` | `true` † |
| `canInjectHostKeys` | `true` | `true` | `true` | `true` | **`false`** | `true` † |
| `userDataMaxBytes` | `16384` | `49152` † | `262144` | `32768` | `0` | `65536` † |
| `generatesUserData` | `true` | `true` | `true` | `true` | **`false`** | `true` † |
| `managesSshAccess` | `true` † | `true` † | `true` † | absent | absent | `true` † |
| `simulatedInstances` | absent | absent | absent | absent | absent | absent |
| `billsWhileStopped` | absent | absent | absent | absent | absent | **`true`** † |

`aws` and `hetzner` values are measured — both providers were built and run end to end against
real infrastructure — **except where a dagger says otherwise**: `hetzner`'s `ipStableAcrossStop`
was never actually observed, and carrying it as measured because the rest of the column was is
exactly the drift the daggers exist to prevent (`rockysurf-eanp`).

**`gcp` is now measured too, but not in every row**: a real Compute Engine run settled most of the
column and deliberately never touched two of the values, which is why the daggers in it moved
rather than disappeared.

**† A daggered value is REASONED RATHER THAN MEASURED** — an inference from the vendor's
documentation rather than an observation. Daggers are per value rather than per column, because a
run can settle some values in a column while never exercising the others, and that is exactly
what happened to `gcp`.

**`managesSshAccess` is daggered in all three columns that declare it**, and it will stay that
way until a real-cloud run pushes a CIDR. It arrived with issue #304 and **no part of it has
touched real cloud infrastructure**: no security group was described, no NSG rule was PUT, and no
firewall rule was patched outside the test doubles. The flag itself is a claim about the provider
(does it maintain a whitelist Rocky Surf can bring into line?) rather than about the cloud, so it
is not the kind of value a run could contradict — but the calls behind it are exactly the kind, and
GCP's `firewalls.patch` is a permission nobody has yet exercised under the published role. Carrying
these three as measured because the rest of their columns are is precisely the drift the daggers
exist to prevent (`rockysurf-eanp`). The dagger comes off when a run has carried it.

**`azure`.** Built without an Azure subscription, then **run against real Azure on 2026-08-26**
(`rockysurf-ihtq.8`). That run took the full lifecycle — create, bootstrap, SSH, stop, start,
terminate — on both architectures (`Standard_B2ls_v2` amd64, `Standard_B2ps_v2` arm64), under a
principal holding only the two published roles. It settled three of this column's values and
deliberately never exercised the fourth, so like `gcp` the daggers moved rather than disappeared.

`canInjectHostKeys` and `ipStableAcrossStop` are now observations, and `stop` was confirmed to be
a real `deallocate` rather than a `powerOff`. **`userDataMaxBytes` keeps its dagger**: the run
never came close to the ceiling — the pack's rendered document is ~2KB — so which reading of
Microsoft's ambiguous 64 KB is correct remains exactly as unsettled as before. Calling the column
measured because most of it is would be the drift the daggers exist to prevent.

Two other things the run did not settle, neither of them a table value: ARM's post-create
consistency window was never observed (nothing was absent after a create, so the `describe()`
grace went unexercised), and the size catalogue's `available` flag turns out to read only one of
Azure's two gates — see `rockysurf-xmk0` and
[`azure.md`](azure.md#core-quota-is-a-separate-gate-from-sku-availability).

**And that run is still the only evidence in this column**, which is what separates `azure` from
`aws`, `gcp` and `hetzner`: their values are re-observed every morning by the nightly real-cloud
workflow, and Azure's are not. The Azure leg exists (gh issue #170) and runs the same lifecycle
under the same published roles, but it **skips with a notice** until the repository owner wires
the CI-only subscription and the five repository variables it names — see
[`azure.md`](azure.md#the-nightly-real-cloud-run-maintainers). Read this column's values as
measured on one dated run until then.

**`gcp`.** Built without credentials, then **run against real Compute Engine on 2026-08-14**
(`rockysurf-ev41.8`). That run measured the create/terminate lifecycle on both architectures
(`e2-small` and `e2-micro` amd64, `t2a-standard-1` arm64), host-key injection, push bootstrap
over SSH, maintenance of the shared SSH firewall rule, and a terminate leaving zero orphans —
audited afterwards on Google's side as no instances and no disks left behind. The two values that
used to carry daggers, `canInjectHostKeys` and `generatesUserData`, were the ones it settled:
they rested on the same fact, that cloud-init's GCE datasource reads the `user-data` metadata
key, and a box cannot present a host key core minted unless that holds.

**What that run did not do is stop and start a box.** The nightly's GCP leg (gh #132) did, on
2026-08-26 (run 33002562621, `t2a-standard-1`): `instances.stop` reached a provider-confirmed
`stopped`, and `instances.start` brought the box back `running` — so `stop` lost its dagger.
`ipStableAcrossStop` keeps it, and for a reason worth stating: the box **came back on the same
ephemeral address**. That is not evidence for `true` — Google releases an ephemeral external IP
on stop and documents the next one as unassigned, and getting the old one back seconds later is
the common case, not a promise — but it means the `false` reading has still never been
*observed* to bite. It stays `false` on Google's word, not ours, and the nightly's check reads
`false` as "may move, and if it does core records the previous address", not "must move"
(`scripts/e2e/lifecycle.mjs`). `userDataMaxBytes` is unchanged and undaggered: Google's
documented per-metadata-value ceiling, structural and never approached.

One difference in the *form* of the evidence, since this table is where people come to compare
it: `aws`, `hetzner` and `byo` have committed transcripts you can read, and `aws`, `hetzner` and
`gcp` are re-run nightly.
The GCP run was driven by hand and through the MCP server, and no transcript of it was recorded
into the repository — what backs the column is a report of a run rather than an artefact of one.
[The status block in `gcp.md`](gcp.md#status-proven-on-real-google-cloud-nightly) has it
in full.

`byo` is now **implemented** (`@rockysurf/provider-byo`, `rockysurf-ftl9.3`) and its column is
measured against a real OpenSSH server rather than only against the package's own tests
(`rockysurf-ftl9.10`). The shipped binary was driven through core's HTTP API against an
`ubuntu:24.04` container running `openssh-server` on a non-22 port, and the transcript is
committed at [`scripts/e2e/recordings/byo-container.log`](https://github.com/amroja-biz/rockysurf/blob/main/scripts/e2e/recordings/byo-container.log).
What that settles, which no in-process SSH server could: a real `useradd` made the account and
**sudo itself** parsed the sudoers drop-in; real sshd consulted `authorized_keys` and the first
claim appended to it rather than replacing it; terminate is bookkeeping, shown by sshd's own
connection count being unchanged across it; and after `ssh-keygen -A` gave the box new host keys,
both a TOFU-learned pin and a configured fingerprint refused it inside a real handshake, with no
credential reaching the changed host.

**Nobody has pointed it at a rack**, and that half stands. A container on the same machine
reached over loopback is a real sshd with a real PAM stack, and it is still not remote hardware
on a real network. The run also needs Docker, so it gates a pull request but `pnpm run check`
never sees it.

**`digitalocean` is daggered in every row, and that is the whole column.** The package
(`packages/provider-digitalocean`, issue #368) was written from DigitalOcean's published
documentation and its public OpenAPI description, read on 2026-09-04, and tested against a fake of
that API. **No DigitalOcean token has ever been pointed at it**, no droplet has been created and no
firewall has been written. So every value above is an inference from a vendor document, and the
ones a run would most plausibly contradict are worth naming:

- **`canInjectHostKeys`** rests on DigitalOcean's Ubuntu images running stock cloud-init, whose
  `cc_ssh` module writes the host keys a `#cloud-config` `ssh_keys:` block names. That is upstream
  behaviour DigitalOcean documents no override of, and it is still a security posture claimed on
  somebody else's behalf: `true` promises there is no trust-on-first-use window on the connection
  carrying the secrets file. A run that disproves it makes this `false`.
- **`userDataMaxBytes: 65536`** is documentation, not a round number picked because it looked
  plausible: DigitalOcean's droplet-create endpoint documents `user_data` as "plain text and may
  not exceed 64 KiB in size". Because it is plain text there is no encoding step to be conservative
  about, unlike Azure's ambiguous 64 KB. Worth knowing for the next author: the *user-data how-to
  page* publishes no ceiling at all, which is where the `adding-providers` skill's worked example
  had looked.
- **`billsWhileStopped: true`** is the first `true` in this row and the reason the row exists.
  DigitalOcean's own pricing page: "You are still billed for bundled-plan CPU Droplets that are
  powered off because the compute resources stay reserved on the hypervisor… To end billing,
  destroy the Droplet." There is no `deallocate`-shaped call to choose instead, so unlike Azure the
  provider cannot avoid the charge by picking a different action.
- **`managesSshAccess`** carries the same dagger as the other three columns that declare it, plus
  one of its own: DigitalOcean is the first WHOLE-OBJECT-authorship cloud after Azure
  ([ADR-0021](../adr/0021-ssh-access-sync.md)'s amendment), because an inbound rule is
  `{ protocol, ports, sources }` with no name and no description to stamp. Nothing has yet
  confirmed that a `PUT /v2/firewalls/{id}` from this provider converges the object the way the
  documentation says it does.

`packages/provider-digitalocean/README.md` carries a "How to verify live" section naming the calls
that settle the cheap half of this column.

#### What removes each of these daggers, and what does not (issue #369)

There is now a nightly leg — `digitalocean` in `.github/workflows/nightly-real-cloud.yml`, one
`s-2vcpu-2gb` droplet in `nyc3` every morning, on a provider installed from its packed tarball the
way a self-hoster installs it. **It has not run**: it skips with a notice until the repository
owner runs `deploy/digitalocean/setup-nightly.sh` against a DigitalOcean team, so every dagger
above is still on. What comes off the morning it goes green, and what does not, is worth writing
down before anybody reads a green tick as more than it is.

| value | comes off when the leg is green? | why |
|---|---|---|
| `stop` | **yes** | the run stops the droplet, waits for `stopped`, starts it and waits for `running` |
| `ipStableAcrossStop` | **yes** | the address is captured before the stop and compared after the start; the run goes red if it moved |
| `canInjectHostKeys` | **yes** | not by the run's own `ssh`, which accepts a new host key on sight — by core's BOOTSTRAP, which pins the key it minted and refuses the connection that carries the secrets file if the box presents another. A droplet whose cloud-init ignored the `ssh_keys:` block never reaches `ready`, so `ready` is the assertion |
| `generatesUserData` | **yes** | nothing boots to `ready` without cloud-init having consumed the document |
| `managesSshAccess` | **yes** | the run calls `POST /api/v1/network/ssh-access/sync` — the first real-cloud exercise of `syncSshAccess()` on any cloud — and asserts the object converged, that `reported` and `removable` came back empty as whole-object authorship requires, and that a second sync changes nothing |
| `userDataMaxBytes: 65536` | **no** | the run sends one ordinary document. Settling the ceiling means posting a create with 65,537 bytes and reading the refusal, and DigitalOcean has no dry run on that endpoint — so it costs a droplet, deliberately not spent every night |
| `billsWhileStopped` | **no** | the run asserts the METER: a stopped row still reports `billing.live`. That is a check on Rocky Surf, not on DigitalOcean — core derives that flag from the provider's own declaration, so the two cannot disagree. **Only an invoice settles whether a powered-off droplet is really charged.** Read one, then remove this dagger |

The distinction in the last two rows is the whole point of the dagger convention: a nightly proves
that the SHIPPED ARTICLE does what its author believed, and a green run is not evidence for a claim
the run never made.

## Row by row

### `stop` — can the instance be stopped and restarted with its disk intact?

All four shipped clouds can, and so can DigitalOcean. BYO cannot: core does not own the machine's
power state, so there is nothing to call.

**DigitalOcean can stop and it does not save you anything**, which is a combination no shipped
provider has: the disk survives a `shutdown`/`power_on` pair and the meter never pauses. That is
`billsWhileStopped` below, and it is the reason `stop: true` is honest here rather than generous.
Its own vocabulary trap is the mirror of GCE's: `off` means "powered off, disk intact,
restartable", which is the SDK's `stopped`, and mapping it to the SDK's `terminated` would tell
core a live, billing droplet was gone. `packages/provider-digitalocean` pins that with a test on
the literal map, like GCP and Azure do.

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

**Hetzner: yes †.** The primary IPv4 survives a poweroff/poweron — a Hetzner Cloud primary IP is
allocated to the server and released only when the server is deleted. **Reasoned from Hetzner's
documentation, not measured** (`rockysurf-eanp`), which is a correction: this row read as measured
for months on the strength of the rest of the column being measured. It was not. The committed
transcript stops and starts the server and never re-reads the address, and the spike capstone says
in as many words that neither box was stopped.

`scripts/e2e/lifecycle.mjs` now asserts it — the address is captured before the stop and compared
after the start, for both readings of the flag — so the next nightly that completes a Hetzner
stop/start cycle will settle this row. **The dagger comes off when a run has carried it**, not
when the assertion was written.

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
- **`true` (Azure) — MEASURED.** This was the single most important unverified claim in this
  table, because the flag is a **security posture** rather than a feature toggle: `true` promises
  core rejects an unknown host key on the connection carrying the secrets file. `rockysurf-ihtq.8`
  settled it on both architectures. Each box accepted its first connection under
  `StrictHostKeyChecking=yes` with `BatchMode=yes` — so no trust-on-first-use prompt was even
  possible — presenting exactly the key core minted, and a deliberately wrong key was refused with
  `Host key verification failed`. Azure's Ubuntu 24.04 image honours cloud-init `cc_ssh`'s
  `ssh_keys:` block from `osProfile.customData`, as the reasoning predicted. Azure has no
  trust-on-first-use window.
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
BYO is `0` because there is no pre-boot hook at all. DigitalOcean's 65,536 is its create
endpoint's documented `user_data` ceiling — "plain text and may not exceed 64 KiB in size" — and
because it is plain text there is no encoding step to read the number two ways, which is what makes
it a straight transcription rather than Azure's judgement call below.

**Azure declares 49,152, which is deliberately SMALLER than the ceiling Microsoft documents.**
The docs say `customData` "can't exceed 64 KB" and do not say whether that is measured before or
after the mandatory base64 encoding — and base64 inflates by a third, so the two readings differ
by 16 KB. 48 KiB is the largest value correct under either. Guessing high to reclaim headroom
nobody uses would buy a provider-side rejection at provision time, and in push mode the rendered
document is ~2.1KB regardless, so the ceiling is nowhere near binding. Which reading is right is **still unsettled**:
`rockysurf-ihtq.8` ran against real Azure without going anywhere near the ceiling, so it
produced no evidence either way and this value keeps its dagger.

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

### `managesSshAccess` — does the provider own a whitelist Rocky Surf can push to?

**`true` on `aws`, `azure`, `gcp` and `digitalocean`; absent — which is the answer `false` — on
`hetzner` and `byo`.** Optional, added by issue #304 and recorded in
[ADR-0021](../adr/0021-ssh-access-is-pushed-on-save-not-only-on-provision.md).

It answers one question: is there a cloud object whose contents are `sshAllowedCidr`, which Rocky
Surf can rewrite **without provisioning anything**? Three clouds have one — a shared security
group, a shared NSG's `rockysurf-ssh` rule, a shared firewall rule; DigitalOcean has a fourth
shape, one cloud firewall named for Rocky Surf and targeting its `managed-by` tag — and the flag is what lets
`POST /api/v1/network/ssh-access/sync` push the operator's list at every cloud that has one —
after a save that changed a list, from the Settings page's `Push SSH access to the clouds` button,
or from `rockysurf network sync` — instead of only at the next launch. The button is not
redundant with the save: a cloud can drift while the file does not, which is the state GCP has
been in for every installation, and no save would catch it. What each provider then does with the list differs and the flag deliberately does not say:
Azure and DigitalOcean rewrite their object whole, because neither cloud's rule carries a
description or a name to stamp — ADR-0021's "clouds whose rules carry no authorship" amendment,
which makes `reported` and `removable` always empty and makes removing a CIDR take effect in one
step; AWS and GCP widen additively and then CONVERGE on confirmation
(issue #309) — a stamped extra the list no longer names is offered keep-or-remove on the Settings
page, and remove is a confirmed, itemized revoke (authorize-before-revoke), while a range Rocky Surf
cannot prove it created is reported with the command that removes it by hand.

`hetzner` declares nothing because it has no whitelist at all: a Hetzner server is reachable the
moment it boots, there is no firewall object to create or adopt, and there is no `sshAllowedCidr`
setting on that provider to push. It is therefore **absent from the sync report**, not reported as
a failure — there is nothing there to be wrong. `byo` declares nothing because the machine is
already the operator's and its network is already whatever they made it.

**This is the first OPTIONAL method on the interface**, and the flag is what makes it safe:
`syncSshAccess()` exists only on the providers that set this, and core calls it through
`capabilities.managesSshAccess` and never `typeof provider.syncSshAccess === 'function'`. That is
ADR-0003 A2's rule — core branches on flags, never on shape — kept intact while departing from
A2's other half, the required-and-throwing method. The reasoning for the departure is in ADR-0021:
a required method is a breaking change for a provider written outside this repository, and a
capability nobody declares costs them nothing.

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

### `billsWhileStopped`

**Absent in every shipped column, and the row exists for a cloud that is not in this table yet.**
Added by [ADR-0025](../adr/0025-billing-while-stopped-is-a-capability.md) (ADR-0003 amendment
E17). `true` means a `stopped` instance is charged at the SAME hourly rate as a running one, and
core's meter keeps running through `stopped` on the strength of it.

The five shipped clouds say nothing, which means `false`, and the evidence is per cloud: AWS stops
compute charges at `stopped` (the EBS volume keeps costing, which core has never priced — see
`BILLING_INSTANCE_STATES`); GCP and Hetzner likewise; **Azure** has both a billing off-state
(`powerOff`, Stopped/Allocated) and a non-billing one (`deallocate`), and the shipped provider
chooses `deallocate` — confirmed on the real-cloud run of 2026-08-26 — which is why it leaves the
flag absent rather than setting it; BYO's machines are the operator's own and cost Rocky Surf
nothing to count.

The cloud it was added for is **DigitalOcean**, and that column now exists: a powered-off droplet
bills at the full rate and there is no `deallocate`-shaped call to choose instead (issue #294, gap
S1), so `@rockysurf/provider-digitalocean` declares `stop: true, billsWhileStopped: true` and core
keeps the meter running through `stopped`. The evidence is DigitalOcean's own pricing page rather
than a bill anybody has read, so the value is daggered like the rest of that column. A cloud that
charges a REDUCED rate while stopped
must not set this flag — core would accrue the running rate — and needs a capability that does not
exist yet, which is an ADR question rather than an approximation.

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
