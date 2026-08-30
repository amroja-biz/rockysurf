# Running Rocky Surf on Azure

What you need to give Rocky Surf so it can create, stop, start and destroy Azure dev boxes in
your own subscription — and nothing beyond that.

- [Getting started](#getting-started)
- [Two things Azure gates that are not permissions](#two-things-azure-gates-that-are-not-permissions)
- [Credentials](#credentials)
- [The role](#the-role)
- [Why there are two roles](#why-there-are-two-roles)
- [Deploying the role](#deploying-the-role)
- [What each action is for](#what-each-action-is-for)
- [Who can reach SSH](#who-can-reach-ssh)
- [What terminate actually deletes](#what-terminate-actually-deletes)
- [Priced regions](#priced-regions)
- [The nightly real-cloud run (maintainers)](#the-nightly-real-cloud-run-maintainers)
- [What is deliberately absent](#what-is-deliberately-absent)

---

## Getting started

Four commands and four config lines.

```bash
# 0. Register the two resource provider namespaces, if this subscription has never used them.
#    A fresh subscription has not. Each takes a minute or two; they run in parallel.
az provider register --namespace Microsoft.Compute
az provider register --namespace Microsoft.Network

# 1. The one resource group Rocky Surf owns. You create it; Rocky Surf does not — see below.
az group create --name rocky-surf-rg --location eastus

# 2. An identity for Rocky Surf to run as, if you do not already have one.
az ad sp create-for-rbac --name rocky-surf
#    Note the appId, password and tenant it prints. Then get its OBJECT id:
az ad sp show --id <appId> --query id -o tsv

# 3. The least-privilege role, granted to that identity.
az deployment sub create \
  --location eastus \
  --template-file deploy/azure/role.bicep \
  --parameters resourceGroupName=rocky-surf-rg principalId=<object id>
```

```yaml
providers:
  azure:
    enabled: true
    subscriptionId: "00000000-0000-0000-0000-000000000000"
    resourceGroup: rocky-surf-rg
    location: eastus
    sshAllowedCidr: 203.0.113.7/32
```

```bash
export AZURE_TENANT_ID=... AZURE_CLIENT_ID=... AZURE_CLIENT_SECRET=...
node packages/rockysurf/dist/bin.js
```

**That second line is the `rockysurf` command until v0.1.0 is on npm.** The published form is
`npx rockysurf`, but npm cannot supply a package that has not been published yet; from a checkout
you have run `pnpm -r build` in, `packages/rockysurf/dist/bin.js` is the identical binary. The
Docker Compose path in the [README](../../README.md#quickstart) works today too. See
[`docs/RELEASING.md`](../RELEASING.md).

**Rocky Surf does not create the resource group, and that is deliberate.** A role cannot be
scoped to a resource group that does not exist yet, so a provider that created its own scope
would have to be granted resource-group write at *subscription* scope — permission to delete any
resource group in your account. One `az group create` buys a role that cannot reach outside one
group.

---

## Two things Azure gates that are not permissions

Both of these were found the first time Rocky Surf was pointed at a real Azure subscription, and
neither is something the role can grant. They are listed together because they produce confident,
misleading errors that look like the provider is broken.

### Resource provider registration

An Azure subscription must **register** a resource provider namespace before it can create
anything in it, and a fresh subscription has registered nothing. Without it the very first create
fails at the virtual network:

```
MissingSubscriptionRegistration: The subscription is not registered to use namespace
'Microsoft.Network'.
```

Step 0 above is the fix. Rocky Surf cannot do this for you and deliberately does not ask to:
registration is a subscription-level write, and `Microsoft.Network/register/action` is exactly the
kind of permission that would make the published role reach outside its resource group.

An unregistered `Microsoft.Compute` also makes `Microsoft.Compute/skus` under-report — sizes come
back marked unavailable to your subscription that become available once registration completes. If
the size list looks implausibly empty, check registration before believing it.

### Core quota is a separate gate from SKU availability

**Azure gates a create twice**, and the two gates are not the same:

| gate | what it answers | where Rocky Surf reads it |
|---|---|---|
| SKU restrictions | "do we sell this size in this region, to this subscription?" | `Microsoft.Compute/skus`, on the call that builds the size list |
| core quota | "how many vCPUs of this FAMILY — and in this region in total — may this subscription run?" | `Microsoft.Compute/locations/{location}/usages`, on the same size-list call (issue #116) |

A size can be perfectly unrestricted and still be refused at create because the approved core
quota for its VM family in that region is zero. Azure's own words for that:

```
OperationNotAllowed: Operation could not be completed as it results in exceeding approved
standardBpsv2Family Cores quota. Location: eastus, Current Limit: 0, Additional Required: 2
```

**The size list now reads both gates.** A size whose family (or whose region as a whole) has no
room for its vCPUs is listed as unavailable with the reason beside it — "no core quota for
`standardBpsv2Family` in eastus (approved limit is 0 …)" — rather than as "sold out", because the
remedy is different: sold-out stock comes back on its own; quota comes back when a human asks
for it in the portal and Microsoft approves. Raising quota is sometimes instant and sometimes
hours. The `small`/`medium`/`large` resolver skips those sizes, so the cheapest size *you can
actually order* is what gets picked.

This is why the catalogue role holds `Microsoft.Compute/locations/usages/read`. It is read-only,
subscription-scoped, and still Azure's catalogue rather than your account's contents — how many
cores you *may* run, not what you run. **A credential without it is not broken**: the size list
falls back to the SKU gate alone (the v0.1 behaviour: an occasional offered-but-unorderable
size, refused at create with Azure's verbatim message and portal link), and the log names the
missing action once. Redeploy `deploy/azure/role.bicep` to add it.

How big the difference is: on a fresh Pay-As-You-Go subscription probed on 2026-08-26, **104 of
232 quota rows sat at `limit: 0`**, including both B-series burstable families the resolver would
otherwise pick first. The two families at 0 were exactly the two that failed at create; every
family that succeeded reported 10. That agreement is what makes the endpoint trustworthy enough
to gate on.

Two practical consequences:

- **Upgrading a free account does not grant quota.** It lifts the spending limit. Per-family core
  quota is still zero until separately approved.
- **Availability varies by region in ways that look arbitrary**, because it is per-subscription.
  If one region refuses, another commonly works — and the arm64 (Ampere, `p`-suffixed) families
  are frequently available where the x64 ones are not. They are also the cheaper, faster default.

## Credentials

**There is nowhere in `rockysurf.config.yaml` to put an Azure secret**, and Rocky Surf will not
read one from a file. Four sources are tried in order:

```bash
# 1. workload identity federation — a token minted by an issuer your tenant trusts, exchanged
#    for an Azure token. No secret exists anywhere on this path. (gh issue #170)
export AZURE_TENANT_ID=... AZURE_CLIENT_ID=... AZURE_FEDERATED_TOKEN_FILE=/path/to/token

# 2. a service principal — the same variables DefaultAzureCredential reads
export AZURE_TENANT_ID=... AZURE_CLIENT_ID=... AZURE_CLIENT_SECRET=...

# 3. a managed identity, if you run Rocky Surf on an Azure VM — no secret at all, and the best
#    posture available. Nothing to export.

# 4. the Azure CLI, for trying it out without creating a service principal first
az login
```

When nothing works, the error names **every** source it tried and why each one did not answer.
An operator who misspelled `AZURE_CLIENT_SECRET` should not be told "the Azure CLI is not
installed".

Turn off the fourth source on a server:

```yaml
providers:
  azure:
    allowAzureCli: false
```

A control plane that can shell out to whatever `az` resolves to on `PATH` has a wider trust
boundary than one that cannot. It is on by default because the alternative is making a stranger
create a service principal before they can create one box.

### Workload identity federation, which is the one with no secret

If you run Rocky Surf **inside GitHub Actions, on AKS, or anywhere else that can present a token
Entra has been told to trust**, you never have to create — or rotate, or store — a client secret.
Add a *federated credential* to the app registration naming the issuer and subject, set the three
variables above, and that is the whole configuration:

```bash
az ad app federated-credential create --id <appId> --parameters '{
  "name": "rockysurf-ci",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:<owner>/<repo>:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'
```

`AZURE_FEDERATED_TOKEN_FILE` names a file holding that token; Rocky Surf reads it — **on every
acquisition, because the thing that writes it rotates it** — and exchanges it at the same Entra
endpoint the client-secret path uses, sending it as a `client_assertion` with
`client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`. Nothing here
signs, parses or validates a JWT: the assertion is written by the platform and posted verbatim.
Those three variable names are the ones Azure's own SDKs, AKS's workload-identity webhook and the
`azure/login` action all use, so an installation already set up for other Azure tooling needs
nothing new.

**Federation is tried first**, ahead of a client secret in the same environment. A deployment
that has configured the source with nothing to leak or rotate should get it, and a stale
`AZURE_CLIENT_SECRET` left in the environment beside it must not silently win.

The nightly real-cloud run uses exactly this path — see
[The nightly real-cloud run](#the-nightly-real-cloud-run-maintainers) below.

**This is still not the whole `DefaultAzureCredential` chain**, and it is better to say so than to
imply parity. Visual Studio / VS Code credentials, Azure PowerShell and Azure Developer CLI
credentials are absent. Rocky Surf talks to Azure with plain `fetch` against the ARM REST API
rather than through `@azure/identity` and `@azure/arm-*`, because those five packages and their
trees would land in the install closure of every `npx rockysurf` — see
[`packages/provider-azure/README.md`](../../packages/provider-azure/README.md).

---

## The role

Rocky Surf needs **two** custom roles — one scoped to your resource group, one read-only at
subscription scope. [The next section](#why-there-are-two-roles) explains why the split is
unavoidable rather than a convenience.

```json
{
  "Rocky Surf Provider": {
    "scope": "resource group",
    "actions": [
      "Microsoft.Resources/subscriptions/resourceGroups/read",
      "Microsoft.Resources/subscriptions/resourceGroups/resources/read",
      "Microsoft.Compute/virtualMachines/read",
      "Microsoft.Compute/virtualMachines/write",
      "Microsoft.Compute/virtualMachines/delete",
      "Microsoft.Compute/virtualMachines/start/action",
      "Microsoft.Compute/virtualMachines/deallocate/action",
      "Microsoft.Compute/virtualMachines/instanceView/read",
      "Microsoft.Compute/disks/read",
      "Microsoft.Compute/disks/write",
      "Microsoft.Compute/disks/delete",
      "Microsoft.Network/virtualNetworks/read",
      "Microsoft.Network/virtualNetworks/write",
      "Microsoft.Network/virtualNetworks/subnets/read",
      "Microsoft.Network/virtualNetworks/subnets/write",
      "Microsoft.Network/virtualNetworks/subnets/join/action",
      "Microsoft.Network/networkSecurityGroups/read",
      "Microsoft.Network/networkSecurityGroups/write",
      "Microsoft.Network/networkSecurityGroups/join/action",
      "Microsoft.Network/networkSecurityGroups/securityRules/read",
      "Microsoft.Network/networkSecurityGroups/securityRules/write",
      "Microsoft.Network/publicIPAddresses/read",
      "Microsoft.Network/publicIPAddresses/write",
      "Microsoft.Network/publicIPAddresses/delete",
      "Microsoft.Network/publicIPAddresses/join/action",
      "Microsoft.Network/networkInterfaces/read",
      "Microsoft.Network/networkInterfaces/write",
      "Microsoft.Network/networkInterfaces/delete",
      "Microsoft.Network/networkInterfaces/join/action"
    ]
  },
  "Rocky Surf Catalogue Reader": {
    "scope": "subscription",
    "actions": [
      "Microsoft.Compute/skus/read",
      "Microsoft.Resources/subscriptions/locations/read",
      "Microsoft.Compute/locations/usages/read"
    ]
  }
}
```

> **Status: EXERCISED END TO END under a principal holding exactly this role, on 2026-08-26
> (`rockysurf-ihtq.8`).**
>
> The full lifecycle — create, bootstrap, SSH, stop, start, terminate — ran on both architectures
> under a service principal holding these two roles and nothing else, with `allowAzureCli: false`
> set so no wider credential could be silently substituted. No `AuthorizationFailed` occurred at
> any point, and the teardown left no VM, disk, network interface or public address behind.
>
> So this list is now known to be **sufficient**, and known not to be wider than the lifecycle
> needs. Two honest limits on that claim: the run exercised the lifecycle, not every branch that
> can call Azure, and it made no attempt to prove each action is individually necessary — an
> entry could still be redundant without any run noticing.
>
> **One action postdates that run.** `Microsoft.Compute/locations/usages/read` was added to the
> catalogue role on 2026-08-26 (issue #116) so the size list can read core quota, and has not yet
> been exercised under a restricted principal. It is read-only and subscription-scoped like its
> two neighbours. A credential without it is not broken: the size list falls back to SKU
> availability alone and the log names the missing action once.
>
> **That proof is dated, and the fix for that is built but not yet switched on.** The nightly
> real-cloud workflow now carries an Azure leg (issue #170) that runs this whole lifecycle under a
> principal holding exactly these two roles, every morning — including `locations/usages/read`,
> which the leg would exercise under a restricted principal for the first time. It **skips with a
> notice** until the repository owner creates the CI-only subscription, the two app registrations
> and the five repository variables it names; see
> [The nightly real-cloud run](#the-nightly-real-cloud-run-maintainers). Until then this block
> means what it says: proven once, by hand, on 2026-08-26.
>
> **The AWS equivalent found a real bug the first time it was run**, which is why this block used
> to warn that Azure was likely to have one too. Azure did — but not in the action list. The
> template itself had never compiled: `deploy/azure/role.bicep` declared the resource-group-scoped
> assignment inside a subscription-scoped file, which Bicep refuses (BCP139), so `az deployment
> sub create` failed at parse. The permissions were right; the file that granted them could not be
> deployed by anyone. It is fixed, and the `join/action` entries this block predicted would be the
> problem all turned out to be correct.
>
> If you do hit an `AuthorizationFailed`, the error names the action it wanted and we would like
> to hear about it.
>
> **The two copies cannot drift apart.** `node scripts/check-azure-role.mjs` runs in
> `pnpm run lint` and compares the JSON above to
> [`deploy/azure/role.bicep`](../../deploy/azure/role.bicep) action by action, and scope by
> scope. Change one without the other and CI fails, naming the action that differs.

---

## Why there are two roles

This is the one genuinely surprising thing about running Rocky Surf on Azure, and it follows
from a fact about RBAC rather than from a design choice.

**Everything Rocky Surf creates lives in one resource group**, and the operational role is scoped
to exactly that group. It cannot see, touch or delete anything else in your subscription. That
scoping is why Rocky Surf does not create the group itself.

**But three of the reads it needs are of things that live above a resource group.** To offer you
a list of machine sizes, it asks Azure which VM sizes this subscription may order in your region
and what each one's vCPU and memory are — `Microsoft.Compute/skus` — and how many cores of each
family it is allowed to run there — `Microsoft.Compute/locations/usages`. To tell you that a
region name is wrong before it tries to build anything, it asks for the region list. None of
those is *in* a resource group, so **no resource-group-scoped role can grant them**, whatever
actions it names.

So they are a second role, at subscription scope, holding three read actions and nothing else.
What it reads is **Azure's own catalogue, not the contents of your account**: what Microsoft will
sell you and how much of it you are allowed, not what you own. It cannot enumerate your
resources, read your data, or change anything.

The alternative was granting the whole operational role at subscription scope so that one
assignment covers everything. That would trade a role confined to one resource group for a role
that can create and delete virtual machines anywhere in the subscription, in exchange for
avoiding a second `az` resource in a template you run once. It is not a close call.

---

## Deploying the role

You do not have to transcribe that JSON. It ships as Bicep —
[`deploy/azure/role.bicep`](../../deploy/azure/role.bicep) — which creates both role definitions
and assigns them to your identity.

```bash
az deployment sub create \
  --location eastus \
  --template-file deploy/azure/role.bicep \
  --parameters \
      resourceGroupName=rocky-surf-rg \
      principalId=$(az ad sp show --id <appId> --query id -o tsv)
```

| Parameter | Default | What it is |
|---|---|---|
| `resourceGroupName` | **none — required** | The group Rocky Surf owns. Must match `providers.azure.resourceGroup`. Create it first. |
| `principalId` | **none — required** | The **object** id of the identity Rocky Surf runs as — not the application id. `az ad sp show --id <appId> --query id -o tsv`. |
| `principalType` | `ServicePrincipal` | Covers both app registrations and managed identities. `User` or `Group` if you are granting a person. |
| `roleNameSuffix` | the resource group name | Role definition names are unique per subscription, so a second Rocky Surf against the same subscription needs a different suffix. |

The deployment is at **subscription** scope (`az deployment sub create`, not
`az deployment group create`) because that is where the catalogue role lives. Creating role
assignments requires Owner or User Access Administrator on the subscription — as it does for any
grant, from any tool.

**The roles are optional.** Rocky Surf will work with any identity that has the permissions,
including one holding Contributor on the subscription. The custom roles exist because
least-privilege is the right default and because a published, machine-checked role is something
you can audit.

---

## What each action is for

The provider makes these calls and no others.

| Call | Actions | Why it is needed |
|---|---|---|
| read the resource group | `resourceGroups/read` | `validateCredentials()` proves the credential, the subscription and the group in one cheap call — and a group this identity cannot see is by far the most likely misconfiguration, since the role is scoped to exactly one. |
| list the group's contents | `resourceGroups/resources/read` | The reconciler's whole input. See [below](#what-terminate-actually-deletes) for why it is a listing rather than a tag filter. |
| list VM sizes | `skus/read` *(catalogue role)* | Both halves of an offering: vCPU and memory, and whether **this subscription** may order the size at all. |
| list regions | `subscriptions/locations/read` *(catalogue role)* | So a typo'd region is an error at startup rather than a failed launch. |
| read core quota | `locations/usages/read` *(catalogue role)* | The second gate on a create (issue #116): approved vCPUs per VM family and per region. A size with no room is listed as unavailable with the reason, instead of failing at the VM PUT. Optional in practice — without it the size list reflects the SKU gate alone. |
| create the machine | `virtualMachines/write`, `disks/write` | Rocky Surf never PUTs a disk — the VM creates it from the image — but Azure evaluates that as a disk write. |
| read it | `virtualMachines/read`, `virtualMachines/instanceView/read` | State and power state. |
| power-cycle it | `virtualMachines/deallocate/action`, `virtualMachines/start/action` | **Deallocate, not power off.** Both preserve the disk and only one stops the compute bill: an Azure VM that is merely powered off is charged the full rate for doing nothing. |
| destroy it | `virtualMachines/delete`, `disks/delete`, `networkInterfaces/delete`, `publicIPAddresses/delete` | One `DELETE` cascades to the other three. See [below](#what-terminate-actually-deletes). |
| the shared network | `virtualNetworks/*`, `networkSecurityGroups/*`, `securityRules/*`, minus delete | Created on first launch and adopted forever after. **No delete action is granted for either**, because they outlive every server and a reconciler must never reap them. |
| attach things | the four `join/action` entries | See below. This is the one that trips people up. |

Note what is **not** in that table: a pricing call. A size's hourly price comes from the hosted
price feed (issue #100, [ADR-0009](../adr/0009-prices-served-from-hosted-feed.md)) — a JSON
document this repository's `price-feed` workflow regenerates from Azure's public Retail Prices
API and republishes to GitHub Pages daily, fetched at runtime by your installation (see
`pricing` in [self-hosting](../self-hosting.md)). It covers the fourteen locations listed under
[Priced regions](#priced-regions); any other location lists offerings with `hourly: null`
("unknown, never free"), and if the feed itself is unreachable everything still works with prices
simply shown as unavailable — there is deliberately no bundled fallback.

### The `join/action` entries, which are the trap

**Azure authorizes an attachment against the resource being attached *to*.** Creating a network
interface inside a subnet needs `Microsoft.Network/virtualNetworks/subnets/join/action` **on the
subnet**, even though nothing about the subnet changes and you are not writing to it. The same
goes for attaching a security group to an interface, an address to an interface, and an interface
to a machine.

It is the same shape as EC2 authorizing `RunInstances` against every resource it touches, and it
fails the same way: an `AuthorizationFailed` naming a resource you did not think you were
modifying. All four are granted above.

### No delete on the shared network

`virtualNetworks` and `networkSecurityGroups` are granted `read` and `write` but **not**
`delete`, and that is a deliberate belt-and-braces alongside the code. Those two resources are
reported to the reconciler as `shared` precisely so it never reaps them — deleting either breaks
every running box in the group — and the role makes the mistake impossible rather than merely
unlikely.

---

## Who can reach SSH

Rocky Surf creates **one** shared network security group (`rockysurf-ssh` by default) with a
single inbound rule: TCP 22, from a CIDR **you specify**.

```yaml
providers:
  azure:
    sshAllowedCidr: 203.0.113.7/32     # required — no default
```

There is no default, and startup reports the provider as unloaded with an explanation if you omit
it. Same rule as [AWS](aws.md#who-can-reach-ssh), and the same reasoning: a firewall rule is a
security decision that belongs somewhere reviewable, not inferred at runtime from whatever
address the operator happened to have that morning.

It matters slightly more here than on AWS. **An Azure Standard-SKU public IP is closed to inbound
traffic by default** — Basic SKUs, which were open by default, were retired on 2025-09-30 — so
without this rule SSH does not work at all rather than working too widely. The failure is at least
loud.

Opening SSH to the whole internet takes **two** deliberate settings, not one typo:

```yaml
    sshAllowedCidr: 0.0.0.0/0
    allowAllCidr: true                 # required to accept 0.0.0.0/0
```

**The rule is written as a child resource**, at
`.../networkSecurityGroups/rockysurf-ssh/securityRules/rockysurf-ssh`, never by PUTting the whole
security group. A PUT on a security group replaces its `securityRules` array, so writing the
whole thing would silently delete every other rule you had added to it. If you share this group
with anything else, your rules survive.

It is attached to the **network interface**, not to the subnet, so Rocky Surf never changes the
network configuration of a subnet you may share with other things.

Rocky Surf does **not** create Azure SSH key resources. Keys are generated per server, the public
half is injected through cloud-init, and the private half stays encrypted in Rocky Surf's own
store. There is nothing in your subscription to manage or leak.

---

## What terminate actually deletes

**This is the part of Azure that differs most from the other clouds Rocky Surf supports, and the
part most likely to cost you money if it were got wrong.**

On EC2 and on Hetzner, an instance is one resource and destroying it destroys it. A running Azure
dev box is **four** resources — the virtual machine, its OS disk, its network interface and its
public IP address — and **Azure's default is to keep all of them when the VM is deleted.** A
naive integration leaks three billable resources per server, forever, and an audit that walks
virtual machines never sees them.

Rocky Surf sets `deleteOption: "Delete"` at create time so that one `DELETE` cascades:

```
DELETE virtual machine
  ├── OS disk            (deleteOption on the VM)
  └── network interface  (deleteOption on the VM)
        └── public IP    (deleteOption on the NIC — there is no field on the VM that reaches it)
```

Two consequences worth knowing:

**A box you created outside Rocky Surf and adopted will not cascade.** `deleteOption` can only be
set when the VM is created. Rocky Surf does not adopt foreign VMs, so this does not arise in
normal use — but if you ever move one in by hand, its disk and address are yours to clean up.

**The reconciler lists the whole resource group rather than filtering by tag**, and there are two
reasons. ARM's `$filter=tagName eq … and tagValue eq …` does not return the tags of the resources
it matches, so a filtered listing can find a resource and then not say which server owns it. More
importantly, **Azure does not copy a VM's tags onto the OS disk it creates from an image** — so a
tag-filtered sweep would never see a disk at all, which is exactly the orphan class that costs
money silently. A stray disk is attributed instead through its `managedBy`, which points at the
VM that owns it, and is still reported when that VM is gone, as an owned resource nobody can
attribute. That is a finding worth surfacing rather than a gap.

This is also why the resource group should be Rocky Surf's own and not shared with your other
infrastructure.

---

## Priced regions

**Fourteen locations are covered with real prices**, regenerated daily from Azure's public
Retail Prices API by [`scripts/refresh-prices.mjs`](../../scripts/refresh-prices.mjs) and
published to the hosted feed (issue #100, [ADR-0009](../adr/0009-prices-served-from-hosted-feed.md)):

| | |
|---|---|
| `eastus` (Virginia) | `eastus2` (Virginia) |
| `centralus` (Iowa) | `westus2` (Washington) |
| `canadacentral` (Toronto) | `brazilsouth` (São Paulo) |
| `northeurope` (Ireland) | `westeurope` (Netherlands) |
| `uksouth` (London) | `francecentral` (Paris) |
| `germanywestcentral` (Frankfurt) | `southeastasia` (Singapore) |
| `australiaeast` (New South Wales) | `japaneast` (Tokyo) |

**Any other location is a documented degraded state, not a silent one.** Rocky Surf does not
restrict `location` to this list and Azure will create the machine — but every offering's
`hourly` comes back `null`, which the SDK defines as "unknown, never free" rather than reusing
another region's number. One consequence is worth stating plainly: **the spend cap cannot see
those boxes.** `hourlyCostAmount` is null for an unpriced offering, so a server in an uncovered
location counts toward nobody's spend total. Budget for it the way you would for a provider Rocky
Surf could not price at all.

**The size catalogue is not per-region.** `AZURE_SIZES` in
`packages/provider-azure/src/prices.generated.ts` is the *union* of every size that priced
cleanly in any of the regions above — 1691 of them as of 2026-08-26, against 1097 that price in
all fourteen. It is a union rather than an intersection because Azure stocks its regions very
differently, and intersecting would have hidden a third of the catalogue (including half the
arm64 sizes, `Standard_B2ps_v2` among them, absent only from `brazilsouth`) from the regions that
*do* sell it. Nothing is oversold by that: the catalogue is intersected at runtime with what
`Microsoft.Compute/skus` reports for **your** location and subscription, and a size your location
has no price for lists with `hourly: null` like any other unpriced offering.

To add a region: add its `armRegionName` to `AZURE_REGIONS` in
[`scripts/refresh-prices.mjs`](../../scripts/refresh-prices.mjs). A region id that does not exist
returns no rows and fails the generator rather than shipping a silently empty region. The next
`price-feed` publish carries the prices; re-run `node scripts/refresh-prices.mjs --azure` too if
the bundled size list should pick up sizes only that region sells.

### A size Azure has not priced is absent, never present at zero

Azure publishes retail meters for VM families **before it starts billing for them**, and those
meters carry `retailPrice: 0`. On 2026-08-26 the entire thirty-size Mbv4 memory-optimized series
did this in `eastus` and `germanywestcentral` — `Standard_M16bs_v4` through
`Standard_M304bds_4_v4`, four meters apiece (Linux and Windows, spot and not), all zero.

A zero is not a price, and the generator now excludes such a size and names it in the run log,
on the same "report, don't guess" rule that already excluded a size resolving to two meters or
none. **This is why it matters more than thirty missing sizes** (issue #140): every provider's
feed reader rejects a price document *whole* on a single non-positive number, because the spend
cap must degrade to *unpriced* rather than to *wrong*. So thirty zeros in `eastus` did not
unprice thirty sizes — they unpriced every Azure size in all fourteen regions, for every
installation, which is exactly the "prices are currently unavailable for Azure" notice that
issue reported. The generator now also refuses to publish a document its own readers would
reject, so the next family Azure announces without billing for turns the `price-feed` run red —
which publishes nothing and keeps the last good document being served — instead of silently
unpricing the cloud.

---

## The nightly real-cloud run (maintainers)

This section is for whoever maintains this repository, not for self-hosters. Nothing here changes
what you deploy.

[`.github/workflows/nightly-real-cloud.yml`](../../.github/workflows/nightly-real-cloud.yml)
creates and destroys real machines every morning on Hetzner, AWS and GCP, and
[gh issue #170](https://github.com/amroja-biz/rockysurf/issues/170) adds the Azure leg: both
architectures, sequentially, each through the full create → bootstrap → SSH → stop → start →
terminate → zero-orphan path, **under the exact two roles published above**. That is the whole
point of wiring it this way. The role on this page was proven **once, by hand**, on 2026-08-26;
add an ARM call to `@rockysurf/provider-azure` and forget to add its action here, and without the
leg nothing turns red until a self-hoster's next launch fails.

**Until the repository variables exist the leg skips with a notice**, not a failure — a
perpetually red scheduled workflow trains everyone to ignore it, and the one morning it is red for
a real reason nobody looks. So the paragraphs below describe a leg that is *in the repository* and
is *not yet running*; the status block under [The role](#the-role) says what is proven today.

**Turning it on is one command.** Sign in with `az login` and `gh auth login`, then run
[`./deploy/azure/setup-nightly.sh`](../../deploy/azure/setup-nightly.sh). It does everything
below and asks you for nothing else. [`./deploy/azure/teardown-nightly.sh`](../../deploy/azure/teardown-nightly.sh)
undoes it. The rest of this section is what those two scripts do, and why.

### Use a dedicated, CI-only subscription and resource group

This is the one rule that matters, and it is the same rule the [GCP
page](gcp.md#the-nightly-real-cloud-run-maintainers) states for its project. The sweep that runs
after each leg is deliberately narrow — it deletes only what the run itself recorded and merely
*reports* everything else — but that narrowness is the second line of defence. The first is that
nothing anybody cares about is in the group at all. On 2026-08-12 the Hetzner leg destroyed the
owner's own live server, launched from their laptop against the same project 37 seconds earlier,
and reported it as a leak it had helpfully cleaned up.

### No secret exists anywhere on this path

GitHub mints a short-lived OIDC token for the run; a **federated credential** on the app
registration is what makes Entra accept it. There is no Azure secret in the repository, nothing to
rotate, and nothing to leak — the same posture as the AWS and GCP legs, reached through the
credential source described under [Credentials](#credentials) above.

### Wiring it, once

One command. You need to be signed in to Azure and to GitHub, and that is all it asks of you.

```bash
az login          # if you are not already signed in
gh auth login     # if you are not already signed in

./deploy/azure/setup-nightly.sh --dry-run     # optional: shows every step, changes nothing
./deploy/azure/setup-nightly.sh
```

It offers to start a run at the end. To undo everything it made:

```bash
./deploy/azure/teardown-nightly.sh
```

**Run it as often as you like.** Every step checks before it creates, so a second run says what
is already there and changes nothing else.

**Nothing it makes costs money.** Identities, roles and an empty resource group are free. Only the
nightly's own machines bill, at about two cents a night.

**It creates no password, key or secret, and prints none.** There is nothing to rotate.

#### What it does, in order

You do not have to read this to run it. It is here so the permissions it grants are auditable
without running anything.

| Step | What it makes | Why |
|---|---|---|
| 1 | nothing | Checks you are signed in to both, and installs Bicep if the Azure CLI lacks it. |
| 2 | nothing | Picks the subscription. Asks you only if you have more than one. |
| 3 | nothing | Registers `Microsoft.Compute` and `Microsoft.Network` if this subscription never has. |
| 4 | the CI resource group | `rocky-surf-ci` by default. Rocky Surf never creates a resource group itself — see [above](#getting-started). |
| 5 | two app registrations and their service principals | One is the identity under test; one is the sweep. [Why two](#why-there-are-two-app-registrations). |
| 6 | a federated credential on each | This is what lets GitHub sign in with no password. It names this repository and one branch, and accepts nothing else. |
| 7 | the published roles | [`role.bicep`](../../deploy/azure/role.bicep), **unmodified** — the file a self-hoster deploys, which is the whole point of the leg. |
| 8 | the sweep role | [`nightly-sweep-role.bicep`](../../deploy/azure/nightly-sweep-role.bicep): delete-only, one resource group, no create of any kind, no delete on the shared network. |
| 9 | nothing | Reads your core quota and tells you what to click if it is zero. |
| 10 | six repository variables | Names and ids. None of them is a credential. |
| 11 | nothing | Offers to start a run. |

The variables it sets:

| Variable | What it is |
|---|---|
| `AZURE_CI_SUBSCRIPTION` | the CI-only subscription id |
| `AZURE_CI_RESOURCE_GROUP` | the CI-only resource group — the scope the operational role is granted at |
| `AZURE_TENANT` | the Entra tenant both app registrations live in |
| `AZURE_PROVIDER_CLIENT_ID` | the app registration carrying the published roles — the identity under test |
| `AZURE_NIGHTLY_CLIENT_ID` | the CI-only sweep app registration |
| `AZURE_CI_LOCATION` | the region; `eastus` unless you pass `--location` |

Defaults are overridable: `--group`, `--location`, `--repo`, `--branch`, `--subscription`.

#### The one thing a script cannot do for you

Azure decides how many vCPUs your subscription may run, per machine family, per region — and a new
subscription is often allowed **zero**. No API can grant that to yourself, so step 9 reads it and
tells you. If it says you are short:

1. Open <https://portal.azure.com> and search for "Quotas".
2. Choose "Compute".
3. Set the region filter to your region.
4. Find the family the script named.
5. Tick it, choose "New Quota Request", ask for 2 or more vCPUs, and submit.

It is usually approved in minutes. Run the setup script again afterwards to confirm.

### Why there are two app registrations

The lifecycle runs as the published one; the sweep runs as the CI-only one. Two independent
reasons, both learned on the AWS leg:

- **The sweep deletes what the published role deliberately cannot.** Rocky Surf deletes a virtual
  machine and lets `deleteOption` cascade to the disk, the NIC and the address; it never deletes
  those three directly, so the published role does not grant it. A cleanup after a cascade that
  half-happened has to.
- **The sweep has to work when the identity under test is what broke.** A cleanup wired through
  the credentials being tested goes blind at exactly the moment it matters.

There is a third reason specific to Azure, and the workflow depends on the fix. The sweep logs
`az` in as the CI-only identity **on the same runner** as the lifecycle, so
[`scripts/e2e/lifecycle.mjs`](../../scripts/e2e/lifecycle.mjs) writes `allowAzureCli: false` into
the config it generates: without it the credential chain could fall through to
`az account get-access-token` and quietly run the lifecycle as the *sweep* account. Every check
would pass, and the run would prove nothing whatsoever about the published role.

### What the leg covers, and what it does not

`Standard_B2ls_v2` (amd64) and `Standard_B2ps_v2` (arm64) — the two sizes the 2026-08-26 hand run
used, so a red morning is a regression against a known-good pair rather than a new unknown. The
cheaper 1 GiB B-series entries (`Standard_B2ats_v2`, `Standard_B2pts_v2`) are deliberately not
used: that is under half the memory of the smallest box any other leg runs, and not a machine the
pack has ever been installed on.

It exercises one region, one resource group and the sizes above. It does not prove each granted
action is individually *necessary*, and it does not touch branches the lifecycle never takes.

**About two cents a night**, on the same measured basis as the numbers in
[gcp.md](gcp.md#what-the-nightly-costs--measured-2026-08-26): two B-series VMs for five to ten
minutes each, billed per minute.

---

## What is deliberately absent

**No `Microsoft.Resources/subscriptions/resourceGroups/write` or `/delete`.** Rocky Surf cannot
create or destroy resource groups, including its own. A resource group per server would have made
`terminate()` a single atomic call — and would have required exactly these two actions at
subscription scope, which is permission to delete any resource group in your account.
`deleteOption` buys the same atomicity without it.

**No `Microsoft.Authorization/*`.** Rocky Surf cannot create roles, grant permissions, or attach
a managed identity to anything. The boxes it creates carry **no Azure identity at all** — they do
not call Azure APIs, so they need no permission to.

**No delete on the shared network.** Covered above.

**No `Microsoft.Compute/virtualMachineScaleSets/*`, no spot, no hibernation.** Spot instances are
out of v0.1: an interrupted box with an agent mid-task undercuts the whole point of a persistent
dev box, and idle auto-stop is the cost lever instead.

**No storage accounts, no key vaults, no Log Analytics.** Rocky Surf keeps its own state in its
own database and its secrets in its own encrypted store. It stores nothing in your subscription
except the machines themselves.

**No subscription-wide read of your resources.** The catalogue role reads what Azure sells, not
what you own. The only listing Rocky Surf ever does of *your* things is of the one resource group
you gave it.
