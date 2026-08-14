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
- [What is deliberately absent](#what-is-deliberately-absent)
- [Status: proven on real Google Cloud, except stop/start](#status-proven-on-real-google-cloud-except-stopstart)

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

Rocky Surf needs **22 permissions**. Here they are, and this list is the whole of it:

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

The provider makes **eleven** distinct API calls. These are all of them.

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

### Four things that trip people up

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
your CIDR to the target tag `rockysurf-ssh` — and drop `firewalls.create` and
`networks.updatePolicy` from the role entirely. Rocky Surf adopts an existing rule with the
configured name and never modifies it.

---

## Who can reach SSH

Rocky Surf creates **one** shared firewall rule (`rockysurf-ssh` by default) allowing TCP 22
from a CIDR **you specify**, to instances carrying the matching network tag. Every box it
creates carries that tag; nothing else in your project is affected.

```yaml
providers:
  gcp:
    sshAllowedCidr: 203.0.113.7/32     # required — no default
```

There is no default, and startup fails with an explanation if you omit it. A firewall rule is a
security decision that belongs in a file you can diff and review, not one inferred at runtime
from whatever network you happen to be on today.

Opening SSH to the whole internet takes **two** deliberate settings, not one typo:

```yaml
    sshAllowedCidr: 0.0.0.0/0
    allowAllCidr: true                 # required to accept 0.0.0.0/0
```

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

Tau T2A is the arm64 family, and it exists in exactly these zones:

```
us-central1-a   us-central1-b   us-central1-f
europe-west4-a  europe-west4-b  europe-west4-c
asia-southeast1-b   asia-southeast1-c
```

**`us-central1-c` is not one of them**, which is why the default zone is `us-central1-a`. In a
zone without T2A the arm64 machines are still listed, reported as unavailable, so the UI can
tell you *this zone has no ARM* rather than silently having none.

If you want arm64 and your zone has no T2A, move the zone — that is a one-line config change,
and arm64 is meaningfully cheaper per vCPU.

---

## What it costs

Prices ship bundled and stamped, and the UI says "as of" rather than implying they are live.
Two things to know:

**The bundled numbers were transcribed by hand, not machine-read.** Google publishes no
credential-free price feed — the old `cloudpricingcalculator` JSON is gone and the Cloud Billing
Catalog API refuses unauthenticated callers — so unlike the AWS table, which is generated from a
public feed, these were read off Google's published pricing page on a stated date. The file
[`prices.generated.ts`](../../packages/provider-gcp/src/prices.generated.ts) records the URL,
the date, and the word "transcribed". `node scripts/refresh-prices.mjs --gcp` (with a
`GCP_BILLING_API_KEY`) prints the Cloud Billing Catalog beside the bundled table to sanity-check
it, and deliberately does **not** rewrite it: the Catalog prices machine *components*, and
predefined machine types are their own cheaper SKUs, so summing them would produce a confidently
wrong number.

**Only `us-central1` is bundled.** Any other region reports its prices as unknown rather than
reusing a us-central1 figure that would be wrong.

**The boot disk is billed separately** and is not in the hourly figure. A 20 GB `pd-balanced`
disk is about \$2/month in `us-central1` at \$0.10 per GiB-month, and it keeps billing while an
instance is stopped — which is the whole trade a stopped box makes.

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

## What is deliberately absent

**No `iam.*` at all** — no service account creation, no `actAs`, no key management. The boxes
carry no Google Cloud identity.

**No `compute.firewalls.delete` or `compute.firewalls.update`.** Rocky Surf creates its shared
rule once and never modifies or removes it. Widening who may reach SSH means editing your config
and recreating the rule yourself — a firewall change is not something an application should do
to itself on a restart.

**No `compute.instances.setServiceAccount`, no `compute.addresses.*`.** No identity on the
boxes, and no reserved static addresses: an external IP is ephemeral, which is why
`ipStableAcrossStop` is `false` for this provider. A reserved address would be one more
per-server resource to create, tag and reap.

**No `compute.instances.list` filter that could reach another project**, no organisation- or
folder-level permission of any kind. Everything is scoped to the one project you name.

**No spot / preemptible instances.** Out of v0.1: an interrupted box with an agent mid-task
undercuts the point of a persistent dev box, and idle auto-stop is the cost lever instead.

---

## Status: proven on real Google Cloud, except stop/start

**This page has been proven by a launch — on 2026-08-14, against real Compute Engine**
(`rockysurf-ev41.8`). It was written before that run, from Google's REST reference, and the run
is what turned it from carefully derived into checked. One part of it is still derived, and this
block says which.

**What the run measured.** The full create → bootstrap → terminate lifecycle, on both
architectures: `e2-small` and `e2-micro` on amd64, `t2a-standard-1` on arm64. The permission list
above is *sufficient* — a box launched under it, which is the check the AWS policy failed the
first time it was tried for real. The shared SSH firewall rule was created and maintained,
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

**What is still not measured: stop and start.** No GCP box has been stopped and restarted. The
run created boxes, bootstrapped them and destroyed them, and deliberately never power-cycled one.
So `compute.instances.stop` and `compute.instances.start` in the role above are the two
permissions no launch has exercised, and `ipStableAcrossStop: false` — the claim that an
ephemeral external IP is released on stop and a different one assigned on start — remains read
from Google's documentation rather than watched. Treat that one row of
[the capability matrix](capability-matrix.md) as reasoning, and the rest of this page as checked.

Two smaller things the run did not settle, both harmless:

1. **Whether `instances.get` ever reports not-found for a machine it just created.** Google
   documents it as strongly consistent and nothing in the run contradicted that. The provider
   implements the full propagation grace anyway, because the ADR permits lengthening it and never
   skipping it, and because the AWS provider shipped without one while eighty-five tests were
   green.
2. **Anything about a project unlike the one it ran in** — a shared VPC, an org policy
   constraining external IPs, a different image project. If you hit a `PERMISSION_DENIED`, the
   error names the permission it wanted and we would like to hear about it.
