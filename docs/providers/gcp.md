# Running Rocky Surf on Google Cloud

What you need to give Rocky Surf so it can create, stop, start and destroy Compute Engine dev
boxes in your own project — and nothing beyond that.

- [Credentials](#credentials)
- [The custom role](#the-custom-role)
- [Deploying it](#deploying-it)
- [What each permission is for](#what-each-permission-is-for)
- [Who can reach SSH](#who-can-reach-ssh)
- [Which machines you get](#which-machines-you-get)
- [What it costs](#what-it-costs)
- [Testing it](#testing-it)
- [The nightly real-cloud run (maintainers)](#the-nightly-real-cloud-run-maintainers)
- [What is deliberately absent](#what-is-deliberately-absent)
- [Status: proven on real Google Cloud, nightly](#status-proven-on-real-google-cloud-nightly)

---

## Credentials

Rocky Surf uses **Application Default Credentials** — the same chain `gcloud` itself uses. It
never asks you to paste a service-account key into its config file, and there is nowhere in
`rockysurf.config.yaml` to put one.

Any of these work, in the library's normal order of preference:

```bash
# a user session, for running it yourself
gcloud auth application-default login

# the same, acting as the least-privilege service account this page creates
gcloud auth application-default login --impersonate-service-account=rockysurf@PROJECT.iam.gserviceaccount.com

# a service-account key file
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json

# or nothing at all, if you run core on a GCE instance, Cloud Run or GKE with the service
# account attached — then no key exists anywhere to leak
```

### `gcloud auth login` and ADC are two different credentials

**`gcloud auth login` does not create or refresh Application Default Credentials**, and this is
the single most likely reason a correct configuration fails on a first run. They are two separate
logins that happen to be performed by the same tool. They can be two different Google accounts.
Only the second one is what Rocky Surf reads:

| command | who it authenticates | what reads it |
|---|---|---|
| `gcloud auth login` | your `gcloud` CLI session | `gcloud`, and nothing else |
| `gcloud auth application-default login` | Application Default Credentials | Rocky Surf, and every client library |

An ADC file, once written, sits there until something overwrites it. It does not expire in any
way you would notice and no amount of `gcloud auth login` touches it. This cost Rocky Surf's own
GCE exit run its first minutes: a freshly logged-in `gcloud`, and an
`application_default_credentials.json` eight months old belonging to a **different Google
account**.

**How to check who ADC actually is:**

```bash
# the file's own age is the first tell — nothing refreshes it but the ADC login itself
ls -l ~/.config/gcloud/application_default_credentials.json

# the project it quotes against is the second. Read only that field: the rest of the file is a
# refresh token, so do not cat it into a terminal you are sharing or pasting from.
jq -r '.quota_project_id' ~/.config/gcloud/application_default_credentials.json
```

A `quota_project_id` naming a project you do not recognise means the file belongs to some other
account, from some other piece of work, months ago. There is one fix and it is the obvious one:
run `gcloud auth application-default login` again.

**The 403-vs-404 signature, which is the diagnosis rather than a symptom.** If Rocky Surf reports
`PERMISSION_DENIED` on a call while `gcloud` gets a **404 for the same call**, stop granting
permissions — that pair means the two are not the same caller:

```bash
# Rocky Surf: 403, Required 'compute.firewalls.get'
gcloud compute firewall-rules describe rockysurf-ssh --project=my-project-123456
# gcloud: 404, not found
```

Google answers a caller who cannot see a resource with `403 Required '<permission>'` rather than
with a 404, because confirming that something does not exist is itself information about a
project you have no visibility into. So the 403 is not "your role is short a permission" — it is
"whoever is asking cannot see this project at all". Meanwhile `gcloud`, authenticated as an
account that *can* see it, gets the honest 404: the firewall rule genuinely has not been created
yet, which on a first launch is correct. **Two different answers to one call means two different
identities**, and adding permissions to the role changes nothing, because the identity being
refused is not the one you granted them to.

You should not have to find this page to learn that. The provider recognises the shape — a 403 on
a *read* — and says so in the error itself, naming the ADC login as the thing to re-run. It stays
quiet on a 403 from a create or a delete, where a permission really can be missing and the hint
would be misdirection.

Point the provider at your project:

```yaml
providers:
  gcp:
    enabled: true
    projectId: my-project-123456
    zone: us-central1-a
    sshAllowedCidr: 203.0.113.7/32
```

**`projectId` is required and nothing is inferred.** A Google credential can be valid for many
projects and names none of them, and `gcloud config get-value project` is deliberately not
consulted — which project your billable machines appear in should not depend on the state of a
shell.

If you must use a key file, name it by **path**:

```yaml
providers:
  gcp:
    keyFile: ~/keys/rockysurf-sa.json
```

The key stays where your own tooling put it. `providers.gcp` is a strict schema with no field
that can hold key material, so a pasted private key is a startup error rather than a secret
committed to a repository.

---

## The custom role

Rocky Surf needs **23 permissions**. Here they are, and this list is the whole of it:

```yaml
title: Rocky Surf Dev Box Manager
description: >-
  Least-privilege role for Rocky Surf: create, read, stop, start and delete Compute Engine
  instances it labelled itself, and maintain one shared SSH firewall rule.
stage: GA
includedPermissions:
  - compute.zones.get
  - compute.instances.create
  - compute.disks.create
  - compute.instances.setMetadata
  - compute.instances.setTags
  - compute.instances.setLabels
  - compute.disks.setLabels
  - compute.subnetworks.use
  - compute.subnetworks.useExternalIp
  - compute.images.get
  - compute.images.getFromFamily
  - compute.images.useReadOnly
  - compute.instances.get
  - compute.instances.list
  - compute.instances.delete
  - compute.instances.stop
  - compute.instances.start
  - compute.zoneOperations.get
  - compute.globalOperations.get
  - compute.firewalls.create
  - compute.firewalls.get
  - compute.firewalls.update
  - compute.networks.updatePolicy
```

No predefined role, no `roles/compute.admin`, no `roles/editor`. For comparison,
`roles/compute.admin` carries over a thousand permissions.

**The list above and [`deploy/gcp/rockysurf-role.yaml`](../../deploy/gcp/rockysurf-role.yaml)
cannot drift apart.** `node scripts/check-gcp-role.mjs` runs in `pnpm run lint` and compares
them permission by permission; change one without the other and CI fails, naming the difference.
Two copies of a security boundary is otherwise exactly the situation in which the published
policy quietly stops being the policy anyone deployed.

---

## Deploying it

You do not have to transcribe that YAML. It ships as the file `gcloud` consumes, with a script
that creates the role, a service account, and the binding between them:

```bash
./deploy/gcp/setup.sh --project=my-project-123456
```

| Flag | Default | What it is |
|---|---|---|
| `--project` | **none — required** | The project everything is created in. No default, on purpose. |
| `--role-id` | `rockySurfDevBoxManager` | Custom role ids are per project, so a second Rocky Surf against the same project needs a second id. |
| `--sa-name` | `rockysurf` | The service account's name. |
| `--create-key` | off | Also write a service-account key to a path you name. Off by default — see below. |
| `--dry-run` | off | Print every command it would run and change nothing. |

Everything it does is idempotent: run it again after editing the role file and it updates in
place. `gcloud iam roles create` fails when the role already exists and there is no upsert flag,
so the script describes first and updates if it finds one.

**gcloud is the only prerequisite, and that is the reason this is a shell script rather than
Terraform or a Deployment Manager template.** Deployment Manager is out on facts, not taste:
Google discontinued support on 2026-04-01 and has blocked *new* users from enabling the V2 API
since 2026-06-30, so a self-hoster following these instructions today cannot use it at all.
Terraform is a genuine extra install for the median self-hoster, while gcloud is not an extra
install for anybody — it is how Application Default Credentials get created in the first place.
If you already run Terraform, read the permission list above and express it your own way; there
is nothing special about the file.

**A key file is the last resort, not the default.** `--create-key` exists because some
installations need it, but a key is a long-lived credential sitting in a file that has to be
rotated and can be lost. Attaching the service account to the workload, or federating your CI's
own identity, means no key exists to leak.

---

## What each permission is for

The provider makes **twelve** distinct API calls. These are all of them.

| Call | Permissions | Why it is needed |
|---|---|---|
| `zones.get` | `compute.zones.get` | `validateCredentials()`. The cheapest authenticated call there is, and it proves four things at once: the credential works, the project exists with the Compute Engine API enabled, you can read it, and the zone is real. |
| `images.getFromFamily` | `compute.images.get`, `compute.images.getFromFamily` | Resolving the current Ubuntu 24.04 image for the requested architecture. |
| `instances.insert` | `compute.instances.create`, `compute.disks.create`, `compute.images.useReadOnly`, `compute.subnetworks.use`, `compute.subnetworks.useExternalIp`, `compute.instances.setMetadata`, `compute.instances.setTags`, `compute.instances.setLabels`, `compute.disks.setLabels` | Creating the box. Nine permissions for one call — see below. |
| `instances.get` | `compute.instances.get` | Reading a server's state. |
| `instances.list` | `compute.instances.list` | Listing everything labelled `managed-by` for the reconciler. |
| `instances.delete` | `compute.instances.delete` | Destroying a box. |
| `instances.stop` / `instances.start` | `compute.instances.stop`, `compute.instances.start` | Power-cycling. |
| `zoneOperations.get` | `compute.zoneOperations.get` | Waiting for an instance operation to finish. |
| `globalOperations.get` | `compute.globalOperations.get` | Waiting for a *firewall* operation to finish. |
| `firewalls.get` | `compute.firewalls.get` | Finding the shared SSH rule, and reporting it to the reconciler. |
| `firewalls.insert` | `compute.firewalls.create`, `compute.networks.updatePolicy` | Creating that rule, on first launch only. |
| `firewalls.patch` | `compute.firewalls.update` | Rewriting that rule's `sourceRanges` when you change `sshAllowedCidr`, without launching anything. Only ever against a rule whose description matches the one Rocky Surf writes at create time. |

### Five things that trip people up

**`instances.insert` checks nine permissions, not one.** Every field you populate in the request
body carries its own authorization annotation, so setting `metadata`, `tags` and `labels` on the
create call triggers `setMetadata`, `setTags` and `setLabels` — even though the provider never
calls those methods. Creating the boot disk adds `disks.create`, labelling it adds
`disks.setLabels`, and using the image adds `images.useReadOnly`. Miss one and the launch fails
with a `PERMISSION_DENIED` naming a method you never called.

**`compute.networks.updatePolicy` is the most-missed permission in the whole set.** A role with
`compute.firewalls.create` alone **cannot create a firewall rule**: the rule's `network` field
carries its own annotation, and without this permission the call is refused. It reads like a
permission to modify the VPC and is in fact the permission to attach a rule to it.

**`compute.firewalls.update` authorizes a `patch`, and it is the only write this release
added.** Google's permission names do not line up one-to-one with its method names here: the
provider calls `firewalls.patch`, and `patch` on a firewall is checked against
`compute.firewalls.update`. There is no separate `compute.firewalls.patch` to grant, and looking
for one is the fastest way to conclude the list is wrong.

**Both operation permissions are required, and they are easy to confuse.** Instance operations
are *zonal*; firewall operations are *global*. Grant only `compute.zoneOperations.get` and
everything works until the very first launch in a fresh project, which is the only one that
creates the firewall rule — and it then fails at the poll rather than at the insert.

**Google's public images need nothing granted in `ubuntu-os-cloud`.** Public image projects
grant `roles/compute.imageUser` to `allAuthenticatedUsers`, so every authenticated caller can
already read and use them. The three `compute.images.*` lines are what let you point
`imageProject` at your **own** project's custom image instead.

### Where the scope is broader than one would like

**`compute.instances.list` and `compute.instances.get` are project-wide.** Compute Engine's read
APIs do not support resource-level conditions on labels, so Rocky Surf can *see* other instances
in your project. It cannot touch them: it only ever deletes, stops or starts an instance by a
name it composed itself from its own prefix, and `listManaged()` filters on its own
`managed-by` label.

**`compute.firewalls.create` is project-wide.** A rule that does not exist yet has no attributes
to condition on. If you want it tighter, create the rule yourself — one `tcp:22` ingress from
your CIDR to the target tag `rockysurf-ssh` — and drop `firewalls.create`,
`firewalls.update` and `networks.updatePolicy` from the role entirely.

**A rule Rocky Surf did not write is still never modified**, and that is now a narrower promise
than it used to be, so it is worth stating exactly. Rocky Surf adopts an existing rule with the
configured name, and it will only ever `patch` a rule whose **description** matches the string it
writes on its own rules at create time. The name alone proves nothing — `rockysurf-ssh` is
configuration, and you may have created or repurposed a rule under it — so a rule carrying any
other description (or none) is reported back to you untouched, along with the `gcloud` command
that would change it, rather than being edited on the strength of a name collision. If you
hand-made the rule as described above, you are in exactly that case: Rocky Surf reads it, uses
it, and leaves it alone.

---

## Who can reach SSH

Rocky Surf creates **one** shared firewall rule (`rockysurf-ssh` by default) allowing TCP 22
from the CIDRs **you specify**, to instances carrying the matching network tag. Every box it
creates carries that tag; nothing else in your project is affected.

```yaml
providers:
  gcp:
    sshAllowedCidr:                    # required — no default
      - 203.0.113.7/32                 # home
      - 198.51.100.0/24                # the office
```

**`sshAllowedCidr` is a list**, and a bare string is still read as a list of one, so an existing
config file keeps working untouched. The list may not be empty — an empty list is refused by the
schema rather than quietly meaning "nobody", which would produce a rule allowing nothing and a
box nobody can reach. Exact duplicates are folded away; **overlapping ranges are deliberately
left alone**, because `203.0.113.7/32` inside `198.51.100.0/24` means something to the person
maintaining the file (the wide one is the office, the narrow one is that laptop) and collapsing
them would make removing one of them do something other than what it says.

There is no default, and startup fails with an explanation if you omit it. A firewall rule is a
security decision that belongs in a file you can diff and review, not one inferred at runtime
from whatever network you happen to be on today. That has not changed — see
[SECURITY.md](../../SECURITY.md); nothing here discovers your address for you.

Opening SSH to the whole internet takes **two** deliberate settings, not one typo:

```yaml
    sshAllowedCidr: [0.0.0.0/0]
    allowAllCidr: true                 # required to accept 0.0.0.0/0
```

`0.0.0.0/0` **anywhere in the list** triggers that guard, not only a list whose single entry is
`/0`. A list of five careful office ranges with a `/0` appended is open to the entire internet,
and the four careful entries change nothing about that.

### The change reaches Google Cloud on save

**This is the part of this page that used to be wrong, and the reason issue #304 exists.**
`sourceRanges` was written when the rule was created and never again. A changed `sshAllowedCidr`
therefore had no effect for the life of the rule — not on the next launch, not after a restart —
and the only fix was `gcloud compute firewall-rules update` by hand. GCP was the worst of the
three clouds on this: AWS and Azure at least picked the setting up at the next provision.

Now, saving the setting pushes it. The save itself stays local and atomic (ADR-0017): the
Settings page writes your file, this process adopts it, and *then*, if the save changed a CIDR
list, a second and separate call goes out — `POST /api/v1/network/ssh-access/sync` — which is
what talks to Compute Engine. The per-cloud result renders on the Settings page under **SSH
access at the cloud**, so you can see what each cloud said. `rockysurf network sync` does the same
from the CLI. Nothing on this path launches, starts or touches an instance.

**There is also a button — `Push SSH access to the clouds`, in the Settings page footer — and on
this cloud it is the one you are most likely to need.** A save only pushes what the save changed,
and the state this page has been in for every installation is a cloud that drifted while the
config file stayed exactly as it was: the firewall rule read `sshAllowedCidr` once, at create
time, and has ignored it ever since. Nothing in a save fixes that, because nothing about it is a
change. The button does not require unsaved edits, pushes every cloud that maintains a whitelist
in one press, and reports into the same block.

What the sync does, precisely:

- It reads the rule by name, and **checks the description** against the one Rocky Surf writes at
  create time. That string is the ownership marker: a name is configuration and proves nothing
  about who created the rule, and a description Rocky Surf wrote does. A rule carrying anything
  else is left **exactly as found** and the sync reports **failed** — not "skipped", because you
  asked for your list to be in force and it is not, and nothing Rocky Surf can do will change
  that. The report names what the rule currently allows and gives you the `gcloud` command that
  would apply your list yourself.
- It issues `compute.firewalls.patch`, sending **only `sourceRanges`**. A patch body carrying the
  whole rule would re-assert the network, the target tags and the ports as a side effect of
  changing who may connect. **Never a delete, and never a delete-and-recreate**: the rule is
  shared by every box in the project, so the seconds between the two halves of a recreate are
  seconds in which nobody can reach anything — including you, if the recreate then fails.
- **It widens only. It does not yet narrow.** The ranges it writes are your list *plus* anything
  already on the rule that your list no longer names. Those extras are **kept** and reported to
  you with the `gcloud` command that removes them. See the next block — this is the most
  important thing on this page to get right in your head.
- If the rule does not exist yet, the sync **skips** and says so, rather than creating it. A
  settings save must not create cloud objects in a project nobody has launched into; the rule is
  created at the first launch, with your current list already in it.
- If Compute Engine refuses with a 403, that is a **failed** result naming the missing permission
  and carrying the exact remediation — the `gcloud compute firewall-rules update` command that
  does the same thing under your own credentials. A 403 here almost always means the custom role
  predates this release and is missing `compute.firewalls.update`; re-run
  `./deploy/gcp/setup.sh --project=…`, which updates the role in place.
- If Compute Engine does not answer within **30 seconds**, the result is **failed** and says
  Rocky Surf cannot tell you whether the patch landed. It does not claim success it cannot
  support, and it deletes nothing.

**Adding a CIDR works today. Removing one does not.** This is a deliberate limitation of this
release and it is stated here rather than discovered later: a CIDR you delete from
`sshAllowedCidr` stays on the firewall rule until you remove it yourself, and the sync report
hands you the command:

```bash
gcloud compute firewall-rules update rockysurf-ssh \
  --source-ranges=203.0.113.7/32 --project=my-project-123456
```

The reason is that this rule's `sourceRanges` were frozen at create time for the whole life of
the release before this one, so what is on the rule is very often the CIDRs of an *older* config —
quite possibly the network you are sitting on while you read this. Patching to exactly your list
would drop those in one call, and the first thing an operator does with this feature is save it
from a network that may be reachable only because of them. Converging to exactly the list is
deferred until you have been offered keep-or-remove and picked one; see
[ADR-0021](../adr/0021-ssh-access-is-pushed-on-save-not-only-on-provision.md). It is the same
report-don't-revoke stance [AWS](aws.md#who-can-reach-ssh) takes on a range it cannot prove it
authorized.

Once you have removed a range, **new SSH connections from that network stop as soon as the change
lands.** Established sessions survive — a firewall rule is evaluated on connection setup — and the
boxes keep running. This is reachability, not data.

**Worth knowing about your default VPC.** A project's auto-created `default` network usually
ships with Google's own `default-allow-ssh` rule, which opens port 22 to `0.0.0.0/0` for *every*
instance in the network — including the ones Rocky Surf creates. Rocky Surf never touches that
rule, because deleting a firewall somebody else's workloads may depend on is not its call, but
it is worth a look:

```bash
gcloud compute firewall-rules list --project=PROJECT --filter="name=default-allow-ssh"
```

Rocky Surf also sets `block-project-ssh-keys=TRUE` on every instance it creates, so project-wide
SSH keys do not grant login to a box that holds your git credentials. Its own access does not
depend on that mechanism — the key reaches the box through cloud-init — so blocking it costs
nothing.

**No service account is attached to the boxes.** They carry no Google Cloud identity at all,
cannot read any Google API, and need no permission to. This is why `iam.serviceAccounts.actAs`
appears nowhere in the role above.

---

## Which machines you get

| family | arch | where |
|---|---|---|
| `e2-*` | amd64 | every zone |
| `t2a-*` | **arm64** | **eight zones only** |
| `c4a-*` | **arm64** | **~77 zones** |

There are now **two** arm64 families, and they answer different questions.

Tau T2A is the older one, and it exists in exactly these eight zones:

```
us-central1-a   us-central1-b   us-central1-f
europe-west4-a  europe-west4-b  europe-west4-c
asia-southeast1-b   asia-southeast1-c
```

**`us-central1-c` is not one of them**, which is why the default zone is `us-central1-a`.

C4A (Axion) is Google's current-generation Arm VM — the practical successor to T2A: cheaper on
any committed spend, eligible for Committed Use Discounts (T2A is not), and available in roughly
77 zones rather than eight. That list is broad enough that most self-hosters' zone already has
it; see [`prices.generated.ts`](../../packages/provider-gcp/src/prices.generated.ts)'s
`C4A_ZONES` for the exact set, read the same way and from the same source as `T2A_ZONES`. On raw
on-demand price alone T2A is still marginally cheaper per vCPU (\$0.0385 vs \$0.0449 for a single
vCPU in `us-central1`, both read 2026-08-13/2026-08-21) — C4A's advantage is committed-spend
pricing and reach, not the on-demand sticker.

**`us-central1-c` is exactly the zone C4A closes the gap in**: it has no T2A, and it does have
C4A. In any zone, an offering your zone's list doesn't cover is still returned by
`listOfferings()`, reported as unavailable rather than omitted, so the UI can tell you *this zone
has no C4A* (or no T2A) rather than silently having neither.

If you want arm64 and your zone has neither family, move the zone — that is a one-line config
change.

### C4A's boot disk is Hyperdisk, not Persistent Disk — and that's a config choice, not automatic

C4A cannot boot from Persistent Disk **at all**. Its only boot disk option is Hyperdisk Balanced.
Every other family this provider ships (`e2-*`, `t2a-*`) is the mirror image: this package does
not yet expose Hyperdisk for them, so they stay Persistent-Disk-only.

`bootDiskType` is **one value for the whole provider instance** (it is scoped to one zone the
same way the rest of this provider is), so pointing it at a C4A machine means setting it
explicitly:

```yaml
providers:
  gcp:
    zone: us-central1-a
    bootDiskType: hyperdisk-balanced   # required for c4a-standard-*; refused for e2-*/t2a-*
```

Get the pairing wrong and it is refused **before anything is created**, with a message naming
which family requires which:

```
c4a-standard-4 is a C4A machine type. C4A supports Hyperdisk only, but this provider is
configured with bootDiskType 'pd-balanced'. Set bootDiskType to 'hyperdisk-balanced' to
provision C4A machines.
```

That is deliberate: the alternative is a Compute API 400 on `disks.insert`, partway through a
create that has already reserved the instance name and started talking to GCE.

---

## What it costs

Prices come from the hosted price feed, stamped, and the UI says "as of" rather than implying
they are live. Four things to know:

**The numbers were transcribed by hand, not machine-read.** Google publishes no credential-free
price feed — the old `cloudpricingcalculator` JSON is gone and the Cloud Billing Catalog API
refuses unauthenticated callers — so unlike AWS and Azure, whose feed documents are generated
from public pricing APIs, these were read off Google's published pricing page on a stated date.
They live as data in
[`scripts/gcp-transcribed-prices.json`](../../scripts/gcp-transcribed-prices.json), which records
the URL, the dates, and the word "transcribed". `node scripts/refresh-prices.mjs --gcp` (with a
`GCP_BILLING_API_KEY`) prints the Cloud Billing Catalog beside that transcription to sanity-check
it, and deliberately does **not** rewrite it: the Catalog prices machine *components*, and
predefined machine types are their own cheaper SKUs, so summing them would produce a confidently
wrong number.

**They still reach you over the feed, and that is the point** (issue #100,
[ADR-0009](../adr/0009-prices-served-from-hosted-feed.md); rockysurf-ndx6). The transcription is
published daily as `prices/v1/gcp.json` and read at runtime, exactly like AWS's and Azure's, so
**correcting a transcribed number reaches your installation on the next publish instead of the
next release**. What moved was the delivery, not the provenance. If the feed is unreachable,
every offering lists with its price unknown and nothing else changes — there is no stale bundled
fallback, by the owner's ruling. Set `pricing.enabled: false` to opt out explicitly.

**The date you see is the day somebody read the page, not the day the feed was republished.**
This is the part that looks like a bug and is not: `gcp.json` is regenerated every morning, and
its `fetchedAt` still says `2026-08-13`, because that is when the numbers were actually read. A
daily republish must not present a hand-copied number as freshly checked. The
**c4a-standard-\* rows carry their own date**, `2026-08-21` — they were transcribed later, when
C4A was added (rockysurf-h6mb), from the same page and column — and the feed's `transcribedAt`
map carries that per row. A price's `fetchedAt` says when *that row* was actually read, never a
global "as of" that would misdate the rows added afterward.

**Only `us-central1` is priced.** Any other region reports its prices as unknown rather than
reusing a us-central1 figure that would be wrong. Machine types are still listed there — an
unknown price never hides a machine you can create.

**The boot disk is billed separately** and is not in the hourly figure. A 20 GB `pd-balanced`
disk is about \$2/month in `us-central1` at \$0.10 per GiB-month, and it keeps billing while an
instance is stopped — which is the whole trade a stopped box makes.

**C4A's Hyperdisk Balanced boot disk adds two more separately-metered lines: provisioned IOPS
and provisioned throughput.** Neither is in `Offering.hourly` either, for the same reason the
disk itself is not. They are not free by nature — Hyperdisk Balanced only waives them below a
baseline (3,000 IOPS / 140 MiB/s in every region; \$0.000006849/hour per IOPS and
\$0.000054795/hour per MiB/s above that, read 2026-08-21 from Google's disk pricing page) — but
this provider does not expose a setting for either, so every disk it creates gets GCE's
documented minimum for its size, which for any boot disk this provider can produce (10 GB and
up) is exactly that baseline. In today's fixed configuration the two lines are real SKUs billed
at \$0, not a free tier this package invented; a future version that lets an operator raise
provisioned IOPS/throughput would make them non-zero without anything here changing.

---

## Testing it

Start Rocky Surf and let it validate:

```bash
gcloud auth application-default login
node packages/rockysurf/dist/bin.js
```

**That second line is the `rockysurf` command until v0.1.0 is on npm.** The published form is
`npx rockysurf`, but npm cannot supply a package that has not been published yet; from a checkout
you have run `pnpm -r build` in, `packages/rockysurf/dist/bin.js` is the identical binary. The
Docker Compose path in the [README](../../README.md#quickstart) works today too. See
[`docs/RELEASING.md`](../RELEASING.md).

`validateCredentials()` reads the configured zone and fails with a plain message if the
credential, the project, the API or the zone is wrong.

To check the role without creating anything:

```bash
gcloud iam roles describe rockySurfDevBoxManager --project=PROJECT
```

The honest test is still creating one server and destroying it: create in the UI, wait for
ready, SSH in, then terminate. If the role is short something, the failure surfaces as a
`ProviderError` whose `providerCode` is Google's own reason and whose message names the call
that was refused.

---

## The nightly real-cloud run (maintainers)

This section is for whoever maintains this repository, not for self-hosters. Nothing here changes
what you deploy.

[`.github/workflows/nightly-real-cloud.yml`](../../.github/workflows/nightly-real-cloud.yml)
creates and destroys real machines every morning, on both architectures, and the GCP leg runs
**under the exact role published above** — not a CI-flavoured variant of it. That is the whole
point of wiring it this way: add an API call to `@rockysurf/provider-gcp` and forget to add its
permission here, and the nightly fails the next morning instead of every self-hoster's next
launch failing while CI stays green.

**Use a dedicated, CI-only Google Cloud project. This is the one rule that matters.** Never the
project in the examples on this page, never a project anybody runs their own Rocky Surf against,
never a project holding anything else. The sweep that runs after each leg is deliberately narrow —
it deletes only the `server-id` labels the run itself recorded, and merely *reports* everything
else it finds — but that narrowness is the second line of defence. The first is that nothing
anybody cares about is in the project at all. On 2026-08-12 the Hetzner leg destroyed the owner's
own live server, launched from their laptop against the same project 37 seconds earlier, and
reported it as a leak it had helpfully cleaned up. A separate project makes that impossible rather
than merely unlikely.

**No key exists anywhere on this path.** GitHub mints a short-lived OIDC token for the run;
Google's STS exchanges it for a token that impersonates a named service account. There is no GCP
secret in the repository and no service-account key to rotate, leak or forget — federation is the
answer to the question `deploy/gcp/setup.sh`'s `--create-key` flag exists to avoid asking.

### Wiring it, once

One command. You need to be signed in to Google Cloud and to GitHub, and that is all it asks of
you.

```bash
gcloud auth login   # if you are not already signed in
gh auth login       # if you are not already signed in

./deploy/gcp/setup-nightly.sh --dry-run     # optional: shows every step, changes nothing
./deploy/gcp/setup-nightly.sh
```

It offers to start a run at the end. To undo everything it made:

```bash
./deploy/gcp/teardown-nightly.sh
```

**Run it as often as you like.** Every step checks before it creates, so a second run says what is
already there and writes nothing at all — including on a project that was wired up by hand before
this script existed.

**Nothing it makes costs money.** Roles, service accounts and an identity pool are free. Only the
nightly's own machines bill, at about two cents a night.

**It creates no key, password or secret, and prints none.** There is nothing to rotate.

#### What it does, in order

You do not have to read this to run it. It is here so the permissions it grants are auditable
without running anything.

| Step | What it makes | Why |
|---|---|---|
| 1 | nothing | Checks you are signed in to both. |
| 2 | nothing, usually | Settles which project. The flag, else the one already saved in `GCP_CI_PROJECT`, else it asks — never the project `gcloud` happens to be pointed at. Offers to create one that does not exist, and says so if billing is off. |
| 3 | four API enablements | `compute`, `iam`, `iamcredentials`, `sts`. A pool without `sts` fails at run time with an opaque 403 rather than at creation. |
| 4 | the published role, its service account and the binding | By calling the shipped [`deploy/gcp/setup.sh`](../../deploy/gcp/setup.sh) **unmodified** — the file a self-hoster deploys, which is the whole point of the leg. Skipped entirely when the role in the project already carries exactly [`rockysurf-role.yaml`](../../deploy/gcp/rockysurf-role.yaml). |
| 5 | the sweep role, its service account and the binding | [`nightly-sweep-role.yaml`](../../deploy/gcp/nightly-sweep-role.yaml): delete-only, one project, no create of any kind, nothing that can touch the shared SSH rule. |
| 6 | the workload identity pool and its OIDC provider | This is what lets GitHub sign in with no key. The condition on it names this repository and this one workflow file, and accepts nothing else. |
| 7 | `roles/iam.workloadIdentityUser` on both accounts | [Two grants, and not interchangeable](#why-there-are-two-service-accounts). |
| 8 | nothing | Checks the zone actually sells `t2a-standard-1` and `e2-small`, and reads the region's CPU quota. |
| 9 | four repository variables | Names and ids. None of them is a credential. |
| 10 | nothing | Offers to start a run. |

The variables it sets:

| Variable | What it is |
|---|---|
| `GCP_CI_PROJECT` | the CI-only project id |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | the pool provider's full resource name, which uses the project **number** |
| `GCP_PROVIDER_SERVICE_ACCOUNT` | the account carrying the published role — the identity under test |
| `GCP_NIGHTLY_SERVICE_ACCOUNT` | the CI-only sweep account |
| `GCP_CI_ZONE` | only written if you pass `--zone`; the workflow defaults to `us-central1-a` on its own |

Defaults are overridable: `--project`, `--repo`, `--workflow`, `--zone`, `--pool`, `--provider`.

Until all four are set the job **skips with a notice** rather than failing: a perpetually red
scheduled workflow trains everyone to ignore it, and the one morning it is red for a real reason
nobody looks. Then trigger it once by hand — `gh workflow run nightly-real-cloud.yml` — rather
than waiting for 07:00 UTC to find out.

#### The two things a script cannot do for you

Both are read and reported at step 8, in plain words, rather than being discovered by a failed
create at 07:00:

- **Billing.** Compute Engine refuses to build anything in a project with no billing account
  attached, and only you can attach one.
- **Stock and quota.** `t2a-standard-1` (arm64) exists in only eight zones, and a fresh project's
  CPU quota in a region can be too small for the two machines the nightly builds. Re-run with
  `--zone` for the first; ask for quota at <https://console.cloud.google.com/iam-admin/quotas> for
  the second, which is usually approved in minutes.

### Why there are two service accounts

The lifecycle runs as the published account; the sweep runs as the CI-only one. They are separate
for two independent reasons, both learned on the AWS leg:

- **The sweep reads calls the provider never makes.** `compute.disks.list` is absent from the
  published role deliberately — the provider does not list disks — so a sweep using the identity
  under test could not see a disk that outlived its instance, and would report the run clean.
- **The sweep has to work when the identity under test is what broke.** A cleanup wired through
  the credentials being tested goes blind at exactly the moment it matters.

The sweep account can delete instances and disks in one project and nothing else: no `create` of
any kind, no firewall permission (the shared SSH rule must survive; deleting it closes port 22 on
every running box at once), no `iam.*`.

### What the leg covers, and what it does not

Both architectures, sequentially: `t2a-standard-1` (arm64) and `e2-small` (amd64), each through
the full create → bootstrap → SSH → stop/start → terminate → zero-orphan path. `t2a-standard-1`
rather than a `c4a-standard-*` because C4A can only boot from Hyperdisk and `bootDiskType` is one
provider-wide setting — choosing it would break the amd64 leg to fix the arm64 one. So **C4A
remains unmeasured** by the nightly, exactly as it is today.

`us-central1-a` is the default because it is one of the eight zones with T2A stock. Point
`GCP_CI_ZONE` somewhere without it and the arm64 leg fails on the catalogue's own `available`
flag before it creates anything, which is the cheapest possible place to find out.

### What the nightly costs — measured 2026-08-26

Answering [gh issue #141](https://github.com/amroja-biz/rockysurf/issues/141). Full derivation
and sourcing is in
[the issue comment](https://github.com/amroja-biz/rockysurf/issues/141#issuecomment-5425987411);
this is its one dated home — see
[`docs/memories/2026-08-13-measured-numbers-in-prose.md`](../memories/2026-08-13-measured-numbers-in-prose.md)
for why it lives here once instead of being copied into prose elsewhere.

Every night creates **five boxes** — one Hetzner, two AWS, two GCP — each for a few minutes,
then destroys them. The bill is per box for the minutes it lived. From 4 clean
`nightly-real-cloud.yml` runs for Hetzner and AWS (2026-08-22 through 2026-08-26) and the GCP
leg's first run (2026-08-26, run 33002562621 — one sample each, so those two rows are the least
settled):

| Box | Lifetime | Per-run cost |
|---|---|---|
| Hetzner `cpx12` (eu) | ~3.2 min, billed a full hour (hourly rounding) | ≈ $0.022 |
| AWS `t4g.small` (us-east-1, arm64) | ~5.8 min, billed per-second | ≈ $0.0023 |
| AWS `t3.small` (us-east-1, amd64) | ~4.1 min, billed per-second | ≈ $0.0019 |
| GCP `t2a-standard-1` (us-central1-a, arm64) | ~6.7 min, billed per-second | ≈ $0.005 |
| GCP `e2-small` (us-central1-a, amd64) | ~12 min, billed per-second | ≈ $0.004 |
| **All five boxes, per night** | | **≈ 4 cents** |

**Per month:** ~30 scheduled nights plus occasional manual reruns ≈ **about $1**, $2 at the
outside. Hetzner is roughly half of it, purely because it bills a three-minute box as an hour.
**GitHub Actions minutes: $0** — `amroja-biz/rockysurf` is public, and GitHub-hosted Linux/ARM
runners are free and unmetered on every plan for public repos (still true as of Aug 2026). This
applies to every workflow in the repo, not just this one.

**Assumptions:** AWS prices from this repo's own hosted feed
(`https://amroja-biz.github.io/rockysurf/prices/v1/aws.json`, `t4g.small` $0.0168/hr, `t3.small`
$0.0208/hr, us-east-1), plus public-IPv4 ($0.005/hr) and `gp3` root-volume cost for the box's few
minutes of life. Hetzner `cpx12` is **not** in this repo's feed (see "Pricing" above) — its
≈$0.0215/hr comes from a third-party tracker (sparecores.com, post the June-2026 repricing), so
treat that one number as an estimate rather than a measurement, with Hetzner's documented
hourly-rounded billing applied on top.

**The GCP rows** use the rates in this repo's own GCP price feed
(`scripts/gcp-transcribed-prices.json`, hand-transcribed 2026-08-13 from Google's published
pricing page for `us-central1`: `t2a-standard-1` $0.0385/hr, `e2-small` $0.016753/hr; no
sustained-use discount applies to either type; GCP bills per-second with a 1-minute minimum),
plus the external-IP and `pd-balanced` boot-disk charges for the minutes each box exists —
both rounding errors at this lifetime. The lifetimes are the `Lifecycle` step's wall-clock from
the one run so far; the amd64 box's ~12 minutes was mostly bootstrap (its `ready` came at 532 s
against the arm64 box's 205 s) and will move as more nights accumulate. Adding the leg took the
nightly from about 3 cents to about 4 — it did not change the headline.

**The Azure leg is not in these numbers** and cannot be until it runs: it exists (gh issue #170)
but skips with a notice until the repository owner wires it — see
[`azure.md`](azure.md#the-nightly-real-cloud-run-maintainers). Estimated at roughly 1–2 cents a
night on the same basis (two B-series VMs, five to ten minutes each, billed per minute), which
would take the nightly from about 4 cents to about 5. Estimated, not measured; re-measure it here
the first morning it is green.

**How to re-measure:** pull the last few runs' step timings with
`gh run list --workflow=nightly-real-cloud.yml` and `gh run view <id> --json jobs`, multiply each
box's lifetime by its rate from the price feed (or Hetzner's API / a tracker, per above), and
re-apply each provider's billing granularity (AWS/GCP per-second, Hetzner hourly-rounded).

---

## What is deliberately absent

**No `iam.*` at all** — no service account creation, no `actAs`, no key management. The boxes
carry no Google Cloud identity.

**Still no `compute.firewalls.delete`.** Rocky Surf never removes its shared rule, and never
removes anybody else's. The rule is shared by every box in the project, so deleting it cuts SSH
to all of them at once — which is also why delete-and-recreate was rejected as a way to change
it, even though it would have needed one fewer permission than the patch does.

**`compute.firewalls.update` is granted, and the promise around it has been narrowed rather than
dropped** (issue #304). The original reasoning still holds and is unchanged: *a firewall change
is not something an application should do to itself on a restart*, and Rocky Surf does not. It
does not reconcile, it has no loop that compares the rule to anything, and starting or restarting
the process changes no firewall.

What it now does is change the rule when **you** ask it to, and only then: saving
`sshAllowedCidr` on the Settings page, pressing `Push SSH access to the clouds` there, or running
`rockysurf network sync`. That is one operator
action producing one `firewalls.patch` against one rule, and only when that rule is missing a
range your list names — and it exists because the alternative was worse
than the permission. Before this, `sourceRanges` was written at create time and never again, so an
operator who moved networks had a rule that went on allowing the network they had left — for the
life of the rule, with no launch and no restart that would fix it. The only remedy was
`gcloud compute firewall-rules update` by hand, which is the same API call, made by the same
person, with the permission granted to a human instead of to the product.

**No `compute.instances.setServiceAccount`, no `compute.addresses.*`.** No identity on the
boxes, and no reserved static addresses: an external IP is ephemeral, which is why
`ipStableAcrossStop` is `false` for this provider. A reserved address would be one more
per-server resource to create, tag and reap.

**No `compute.instances.list` filter that could reach another project**, no organisation- or
folder-level permission of any kind. Everything is scoped to the one project you name.

**No spot / preemptible instances.** Out of v0.1: an interrupted box with an agent mid-task
undercuts the point of a persistent dev box, and idle auto-stop is the cost lever instead.

---

## Status: proven on real Google Cloud, nightly

**This page has been proven by a launch — on 2026-08-14, against real Compute Engine**
(`rockysurf-ev41.8`). It was written before that run, from Google's REST reference, and the run
is what turned it from carefully derived into checked. One part of it is still derived, and this
block says which.

**What the run measured.** The full create → bootstrap → terminate lifecycle, on both
architectures: `e2-small` and `e2-micro` on amd64, `t2a-standard-1` on arm64, in `us-central1-a`
— the default zone, and one of the eight with T2A stock. The permission list
above is *sufficient* — a box launched under it, which is the check the AWS policy failed the
first time it was tried for real. **One permission is outside that evidence**:
`compute.firewalls.update` was added on 2026-09-01 by issue #304, after this run, and no run has
yet issued a `firewalls.patch` under the published role. It is derived from the Compute Engine
REST reference's authorization annotation for that method, the same way the whole list was before
this run turned it from derived into checked, and `capability-matrix.md` carries it daggered for
the same reason. The shared SSH firewall rule was created and maintained,
including on a first launch in a project that had never had one, which is the only launch that
exercises `firewalls.create` and `compute.networks.updatePolicy`. Bootstrap was pushed over SSH,
so the SSH path is verified by the boxes having reached ready at all. Terminate left **zero
orphans**: an audit on Google's side afterwards found no instances and no disks, with only the
shared `rockysurf-ssh` rule persisting, which is what it is for.

**`canInjectHostKeys: true` is now measured, and it was the important one.** The provider
declares that a core-minted SSH host key reaches the box through the `user-data` metadata key,
which cloud-init's GCE datasource documents that it reads. Real Google boxes presented exactly
the fingerprint core minted, on both architectures. GCE's guest agent does not regenerate the key
out from under it — the failure that would have made the capability `false` and dropped the
security posture to trust-on-first-use. It did not happen.

**Stop and start were measured later, by the nightly.** The 2026-08-14 run deliberately never
power-cycled a box. The nightly's first GCP run (2026-08-26, run 33002562621, `t2a-standard-1`)
did: `compute.instances.stop` reached a provider-confirmed `stopped`, `compute.instances.start`
brought the box back `running`, and both permissions in the role above are therefore exercised
under the published identity. What that cycle did *not* show is the address moving: the box came
back on the same ephemeral external IP. `ipStableAcrossStop: false` stays — Google releases an
ephemeral address on stop and does not promise the next one, and getting the old one back seconds
later is the ordinary case rather than a guarantee — but that one row of
[the capability matrix](capability-matrix.md) is still Google's word rather than an observation
of the address actually changing.

**C4A is derived, not measured, and is newer than the run above.** `c4a-standard-*` and the
Hyperdisk-only boot disk path (rockysurf-h6mb) were added after the 2026-08-14 run and were not
part of it: no C4A box has been created against real Compute Engine, so `compute.disks.create`
against a `hyperdisk-balanced` boot disk and the `c4a-standard-*` machine type are both read from
Google's documentation rather than watched. The IAM permission list is unchanged and believed
sufficient — Hyperdisk uses the same `compute.disks.*` surface Persistent Disk does — but "believed"
is the honest word until a real launch says otherwise.

**The evidence is weaker in form than AWS's and Hetzner's, and you should know how.** Those two
have committed transcripts under [`scripts/e2e/recordings/`](../../scripts/e2e/recordings/) and
[`spike/recordings/`](../../spike/recordings/) that you can read; this run was driven by hand and
through the MCP server, and **no transcript of it was recorded into the repository**. What is
written above is a report of it, not a thing you can check for yourself.

**The nightly's GCP leg is what makes this page continuous rather than dated.** The workflow, the
sweep and the one-command project setup are in the repository (gh issue #132; see [the nightly
section above](#the-nightly-real-cloud-run-maintainers)), and the leg runs the full lifecycle on
both architectures under exactly the role published on this page. It first ran on 2026-08-26
(run 33002562621) once the four repository variables were set: create, push bootstrap to `ready`,
`claude --version` over SSH, stop, start, terminate, and a zero-orphan sweep, all under the
published role. Its lifecycle log is uploaded as a run artifact (`gcp-lifecycle-log-<arch>`), so
unlike the 2026-08-14 run there is a transcript to read. Every morning it stays green, the claims
on this page are re-verified against real Compute Engine.

Two smaller things the run did not settle, both harmless:

1. **Whether `instances.get` ever reports not-found for a machine it just created.** Google
   documents it as strongly consistent and nothing in the run contradicted that. The provider
   implements the full propagation grace anyway, because the ADR permits lengthening it and never
   skipping it, and because the AWS provider shipped without one while eighty-five tests were
   green.
2. **Anything about a project unlike the one it ran in** — a shared VPC, an org policy
   constraining external IPs, a different image project. If you hit a `PERMISSION_DENIED`, the
   error names the permission it wanted and we would like to hear about it.
