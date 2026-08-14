# Running Rocky Surf on Hetzner Cloud

What you need to give Rocky Surf so it can create, stop, start and destroy servers in your own
Hetzner project — and nothing beyond that.

- [Credentials](#credentials)
- [There is no least-privilege token, and that is worth knowing](#there-is-no-least-privilege-token-and-that-is-worth-knowing)
- [Configuration](#configuration)
- [Which machines you get](#which-machines-you-get)
- [Who can reach SSH](#who-can-reach-ssh)
- [What it creates, and what it reaps](#what-it-creates-and-what-it-reaps)
- [What it costs](#what-it-costs)
- [Testing it](#testing-it)
- [What is deliberately absent](#what-is-deliberately-absent)
- [Status: measured, and re-measured nightly](#status-measured-and-re-measured-nightly)

---

## Credentials

One **API token with read/write access to one project**, and nothing else. There is no role to
deploy, no policy file, no service account and no infrastructure to create first — this page has
no `deploy/` directory behind it, unlike [AWS](aws.md), [Azure](azure.md) and [GCP](gcp.md).

Create a project at [console.hetzner.com](https://console.hetzner.com), then generate an API
token inside that project — it lives under the project's **Security** section — with
**Read & Write** permission.

Read-only is not enough and fails at the first create. The provider makes servers and the SSH Key
objects they need, and both are writes.

The token belongs in your environment; the config file holds a reference to it:

```yaml
providers:
  hetzner:
    enabled: true
    token: "${HETZNER_TOKEN}"
```

That `${...}` form is resolved before the value reaches the provider, so the secret never lands in
a file you might back up, diff or paste into an issue. The first-run wizard is the other route —
what you paste there goes into Rocky Surf's encrypted secrets store instead. **A token in the
config file wins over a stored one**, because the file is the copy an operator can see and roll
back.

## There is no least-privilege token, and that is worth knowing

The AWS and GCP pages spend most of their length on a minimal policy, because those clouds let you
write one. **Hetzner does not.** A Cloud API token has exactly two settings, Read or Read & Write,
and no per-resource or per-action restriction of any kind. A read/write token can do anything the
Cloud API offers **in that project**: create and destroy any server in it, not only Rocky Surf's,
and read every resource it contains.

So the boundary is the project, and it is the only boundary there is. Two consequences, both
worth acting on:

- **Give Rocky Surf its own project.** A token is scoped to one project, so a project containing
  nothing but Rocky Surf's dev boxes turns "this token can do anything here" into a statement
  about a blast radius you chose. This is the closest thing to a least-privilege setup the API
  offers, and it costs one menu click.
- **Rocky Surf's own restraint is not the same as a permission boundary.** It only ever deletes,
  stops or starts a server whose `managed-by` label it set itself, and `listManaged()` filters on
  that label — but that is the application declining to touch your other servers, not the API
  refusing to let it. On AWS the equivalent restraint is written into the policy and enforced by
  the cloud. Here it is not, and the honest thing is to say so rather than let the shorter setup
  read as a stronger one.

## Configuration

```yaml
providers:
  hetzner:
    enabled: true
    token: "${HETZNER_TOKEN}"
    location: fsn1
    # consoleProjectId: 1234567       # optional; only adds a link to the Hetzner Console
```

| field | default | what it does |
|---|---|---|
| `token` | none — **required** | read/write API token for one project |
| `location` | `fsn1` | the one location this provider manages |
| `image` | `ubuntu-24.04` | base image, overridable for another Ubuntu LTS |
| `managedBy` | `rockysurf` | value of the `managed-by` label this provider owns. `listManaged()` filters on it, and `validateSpec()` refuses a spec that disagrees |
| `consoleProjectId` | none | numeric project id, used only to link a server to its page in the console |

**One provider instance manages one location.** `listManaged()` is scoped at construction, so two
locations means two configured providers rather than one that spans both.

**`consoleProjectId` has to be typed in because the Cloud API never says it.** A token is scoped
to one project without any response naming that project, and a console URL is
`/projects/<id>/servers/<server id>/overview`. Leave it out and servers simply have no console
link — a guessed value would deep-link into somebody else's project. Open the project in the
console and read the number out of the address bar.

## Which machines you get

| family | arch | where |
|---|---|---|
| `cx*` / `cpx*` | amd64 | every location |
| `cax*` | **arm64** | `fsn1`, `nbg1`, `hel1` only |

Locations are `fsn1` (Falkenstein), `nbg1` (Nuremberg) and `hel1` (Helsinki) in Europe, `ash`
(Ashburn) and `hil` (Hillsboro) in the US, and `sin` (Singapore).

The families above are Hetzner's catalogue, not a rule the provider applies: it reads each type's
`architecture` field from the API and reports `arm64` or `amd64` from that, so a family Hetzner
adds tomorrow is classified correctly without a release here.

**arm64 stock is real, regional, and frequently absent.** CAX types exist only in the three
European locations, and Hetzner genuinely sells out of them. Rocky Surf lists a sold-out type with
`available: false` rather than hiding it, so the UI can say *this type has no stock right now*
instead of silently offering you a shorter menu.

**Availability is read from the API's own `locations[].available`, never inferred from a price.**
Hetzner publishes prices for architectures it has no stock of: at the spike's capstone every CAX
type reported `available: false` in all three ARM locations while still quoting a price, and a
direct order in each returned `412 resource_unavailable`. A provider that treated "has a price" as
"can be ordered" would offer machines that cannot be created.

**Hetzner's Ubuntu 24.04 is not the same image as the other clouds'** — notably it ships without
`jq`. Nothing in the provider contract describes image contents and nothing reasonably could; the
bootstrap agent installs what it needs before parsing its own plan.

## Who can reach SSH

**There is nothing to configure, and that is the thing to know about.** A Hetzner server is
reachable from the internet the moment it boots. There is no network, subnet or firewall object to
prepare, which is why Hetzner is the quickest of the four clouds to start on — and it means these
boxes are **exposed by default**, unlike the AWS, Azure and GCP providers, where you must name the
CIDR allowed to reach SSH and startup fails if you do not.

What stands between the box and the internet is therefore SSH itself, and it is set up to carry
that weight: the rendered cloud-config sets `ssh_pwauth: false`, `lock_passwd: true` and
`disable_root: true`, so there is no password to guess on any account and root cannot log in at
all. Access is by key only, against a host key core minted before the server existed. If you want
a network boundary as well, Hetzner Cloud Firewalls are a per-project feature you can apply
yourself — Rocky Surf does not create, adopt or modify one.

## What it creates, and what it reaps

**Per server: the server, and one SSH Key object.** Hetzner's create call will not take raw key
material inline, so the public half has to exist as a first-class API object before it can be
referenced. The provider creates one per provision, labels it, owns it, and deletes it with the
server.

**A key that already existed is never claimed.** If a key with the same fingerprint is already in
the project, the provider references it and records it as *not* owned, because reaping it on
terminate would break whoever else put it there.

**Nothing is shared, and terminate leaves nothing behind.** This is the one structural difference
from every other cloud here: AWS keeps a shared security group, Azure a resource group's worth of
network objects, GCP a shared firewall rule — all of which outlive the servers they serve. Hetzner
has no such resource. Every managed row is `server-owned`, so a project with no Rocky Surf servers
in it has no Rocky Surf anything in it.

The reconciler audit that proves it is `listManaged()`, which lists servers and SSH Key objects
by label. After a terminate it returns empty.

**Terminal states are fast.** Hetzner drops a deleted server almost immediately, where EC2 sits in
`terminating` for 30–120 seconds.

## What it costs

**Live prices, in the currency your project is billed in.** This provider is the documented
exception to Rocky Surf's bundled-prices rule, and the reason is narrow: Hetzner returns `prices[]`
inline on `GET /server_types`, the exact call `listOfferings()` already makes. Preferring a bundled
number would mean showing a figure known to be staler than one already in hand, having saved no
request.

| source | when | `fetchedAt` |
|---|---|---|
| live | the type carries a price for your location, and `GET /pricing` reported a currency | now |
| bundled | `src/prices.generated.ts` has an entry | when the table was generated |
| neither | — | `hourly: null`, which the SDK defines as *unknown, never free* |

**Currency comes from `GET /pricing`, not from an assumption.** Hetzner quotes in the project's
billing currency — EUR for most accounts, USD for some — and a number without its currency is not
a price. If that call fails, offerings still list and prices fall back to the bundled table rather
than taking the whole catalogue down.

**Net, not gross**, because gross folds in a per-account VAT rate and two customers would
otherwise see different "prices" for the same machine.

The bundled fallback ships **empty**, and refreshing it is opt-in
(`HETZNER_TOKEN=… node scripts/refresh-prices.mjs --hetzner`). Both follow from the same fact:
Hetzner quotes per project, so a table built from one account's numbers would be wrong for another.

## Testing it

Start Rocky Surf and let it validate:

```bash
HETZNER_TOKEN=... node packages/rockysurf/dist/bin.js
```

**That is the `rockysurf` command until v0.1.0 is on npm.** The published form is
`npx rockysurf`, but npm cannot supply a package that has not been published yet; from a checkout
you have run `pnpm -r build` in, `packages/rockysurf/dist/bin.js` is the identical binary. The
Docker Compose path in the [README](../../README.md#quickstart) works today too. See
[`docs/RELEASING.md`](../RELEASING.md).

`validateCredentials()` proves the token and checks that the configured location exists — a
typo'd `location` is caught at startup rather than at the first create.

The honest test is still creating one server and destroying it: create in the UI, wait for ready,
SSH in, then terminate. A token that is read-only surfaces as a `ProviderError` whose
`providerCode` is Hetzner's own reason, on the create rather than at startup, because reading is
all validation does.

## What is deliberately absent

**No Cloud Firewall management.** Rocky Surf neither creates one nor adopts yours. A firewall is a
project-wide object whose other rules are somebody else's business, and the exposure it would
change is documented above rather than silently altered.

**No Floating IPs or Primary IPs as managed resources.** A server's primary IPv4 comes with it and
survives a poweroff/poweron, which is what `ipStableAcrossStop: true` reports. A floating IP would
be one more per-server resource to create, tag and reap.

**No Volumes, no Load Balancers, no Networks, no Placement Groups.** A dev box is one server with
its own disk.

**No Backups or Snapshots.** They are a per-server paid feature and turning one on quietly would
change what an operator is billed. Your work belongs in git.

**No spot equivalent**, because Hetzner has none.

## Status: measured, and re-measured nightly

**A full lifecycle on real Hetzner Cloud, on 2026-08-12: `cpx12`, 149 seconds end to end, zero
orphans.** The run drove the shipped article — the `rockysurf` binary booted from a real config
file, then everything through core's own HTTP API — created a server, watched push bootstrap
report ready, ran `claude --version` over SSH on the box (2.1.228), stopped and started it,
terminated it, and finished with a reconciler-grade `listManaged()` audit showing no server-owned
instances left and the owned SSH Key objects reaped with the server. Transcript:
[`scripts/e2e/recordings/hetzner-lifecycle.log`](../../scripts/e2e/recordings/hetzner-lifecycle.log).

**It is re-run nightly at 07:00 UTC** by
[`.github/workflows/nightly-real-cloud.yml`](../../.github/workflows/nightly-real-cloud.yml),
against the same `cpx12`, with a terminate sweep that runs even when the run fails. Hetzner is the
only provider under continuous real-cloud test, which is a large part of why it is the recommended
place to start.

The spike's earlier capstone, also on `cpx12` in `fsn1`, is what proved the two claims this
provider makes about first boot: cloud-init consumed core's `#cloud-config`, with
`/var/lib/cloud/instance/user-data.txt` matching what core sent **byte for byte** (2,138 bytes),
and the box presented **exactly the host key core had minted**. That transcript is
[`spike/recordings/hetzner-lifecycle.txt`](../../spike/recordings/hetzner-lifecycle.txt).

**One value is weaker than the rest, and it is worth naming.** The lifecycle stops and starts a
server but does not re-read the address afterwards, so `ipStableAcrossStop: true` rests on
Hetzner's documented behaviour rather than on a recorded comparison. The AWS side of the same
claim *is* measured: its transcript shows the address changing across a restart. The full table,
with what each value was established against, is
[`capability-matrix.md`](capability-matrix.md).
