# Running Rocky Surf on Azure

What you need to give Rocky Surf so it can create, stop, start and destroy Azure dev boxes in
your own subscription — and nothing beyond that.

- [Getting started](#getting-started)
- [Credentials](#credentials)
- [The role](#the-role)
- [Why there are two roles](#why-there-are-two-roles)
- [Deploying the role](#deploying-the-role)
- [What each action is for](#what-each-action-is-for)
- [Who can reach SSH](#who-can-reach-ssh)
- [What terminate actually deletes](#what-terminate-actually-deletes)
- [What is deliberately absent](#what-is-deliberately-absent)

---

## Getting started

Three commands and four config lines.

```bash
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
npx rockysurf
```

**Rocky Surf does not create the resource group, and that is deliberate.** A role cannot be
scoped to a resource group that does not exist yet, so a provider that created its own scope
would have to be granted resource-group write at *subscription* scope — permission to delete any
resource group in your account. One `az group create` buys a role that cannot reach outside one
group.

---

## Credentials

**There is nowhere in `rockysurf.config.yaml` to put an Azure secret**, and Rocky Surf will not
read one from a file. Three sources are tried in order:

```bash
# 1. a service principal — the same variables DefaultAzureCredential reads
export AZURE_TENANT_ID=... AZURE_CLIENT_ID=... AZURE_CLIENT_SECRET=...

# 2. a managed identity, if you run Rocky Surf on an Azure VM — no secret at all, and the best
#    posture available. Nothing to export.

# 3. the Azure CLI, for trying it out without creating a service principal first
az login
```

When nothing works, the error names **every** source it tried and why each one did not answer.
An operator who misspelled `AZURE_CLIENT_SECRET` should not be told "the Azure CLI is not
installed".

Turn off the third source on a server:

```yaml
providers:
  azure:
    allowAzureCli: false
```

A control plane that can shell out to whatever `az` resolves to on `PATH` has a wider trust
boundary than one that cannot. It is on by default because the alternative is making a stranger
create a service principal before they can create one box.

**This is not the whole `DefaultAzureCredential` chain**, and it is better to say so than to
imply parity. Workload identity federation, Visual Studio / VS Code credentials, Azure PowerShell
and Azure Developer CLI credentials are absent. Rocky Surf talks to Azure with plain `fetch`
against the ARM REST API rather than through `@azure/identity` and `@azure/arm-*`, because those
five packages and their trees would land in the install closure of every `npx rockysurf` — see
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
      "Microsoft.Resources/subscriptions/locations/read"
    ]
  }
}
```

> **Status: reasoned from the API calls the provider makes, and NOT yet proven under a restricted
> principal.**
>
> This is a weaker claim than the one [`aws.md`](aws.md) makes, and the difference is worth
> stating plainly rather than leaving a reader to assume parity. The Azure provider was built
> without an Azure subscription: every action above corresponds to a call the provider actually
> issues, and the list was derived by walking that code — but nobody has yet assumed a principal
> holding exactly this role and run a server end to end under it.
>
> **That matters because the AWS equivalent found a real bug the first time it was run.** A
> resource sat in a statement whose condition could never match, and every first launch under the
> published policy failed. There is no reason to think Azure is less likely to have one. The
> `join/action` entries below are the most likely candidates: Azure authorizes an attachment
> against the resource being attached *to*, and it is easy to miss one.
>
> The run that settles it is tracked as **`rockysurf-ihtq.8`** and is owner-gated — it needs a
> subscription and it spends money. Until it has passed, treat this as a good-faith minimum
> rather than a verified one, and if you hit an `AuthorizationFailed`, the error names the action
> it wanted and we would like to hear about it.
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

**But two of the reads it needs are of things that live above a resource group.** To offer you a
list of machine sizes, it asks Azure which VM sizes this subscription may order in your region
and what each one's vCPU and memory are — `Microsoft.Compute/skus`. To tell you that a region
name is wrong before it tries to build anything, it asks for the region list. Neither of those is
*in* a resource group, so **no resource-group-scoped role can grant them**, whatever actions it
names.

So they are a second role, at subscription scope, holding two read actions and nothing else.
What it reads is **Azure's own catalogue, not the contents of your account**: what Microsoft will
sell you, not what you own. It cannot enumerate your resources, read your data, or change
anything.

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
| create the machine | `virtualMachines/write`, `disks/write` | Rocky Surf never PUTs a disk — the VM creates it from the image — but Azure evaluates that as a disk write. |
| read it | `virtualMachines/read`, `virtualMachines/instanceView/read` | State and power state. |
| power-cycle it | `virtualMachines/deallocate/action`, `virtualMachines/start/action` | **Deallocate, not power off.** Both preserve the disk and only one stops the compute bill: an Azure VM that is merely powered off is charged the full rate for doing nothing. |
| destroy it | `virtualMachines/delete`, `disks/delete`, `networkInterfaces/delete`, `publicIPAddresses/delete` | One `DELETE` cascades to the other three. See [below](#what-terminate-actually-deletes). |
| the shared network | `virtualNetworks/*`, `networkSecurityGroups/*`, `securityRules/*`, minus delete | Created on first launch and adopted forever after. **No delete action is granted for either**, because they outlive every server and a reconciler must never reap them. |
| attach things | the four `join/action` entries | See below. This is the one that trips people up. |

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
