# `@rockysurf/provider-azure`

Microsoft Azure dev boxes, created with plain `fetch` against the ARM REST API — no Azure SDK. It
creates Linux virtual machines in **one region, in one resource group you own**, and destroys
them with everything they brought with them. It will not create the resource group, will not read
a credential out of your config file, and will not touch anything outside the group you name.

## How you get it

It ships inside the `rockysurf` CLI. There is nothing to install — switch it on in configuration:

```bash
npx rockysurf
```

Reading this in a git checkout, before the v0.1.0 release? Then `npx` has no `rockysurf` to
fetch yet. Run `pnpm -r build` once and use `node packages/rockysurf/dist/bin.js`, which is the
same binary `npx` will fetch.

Building your own composition root instead? `npm install @rockysurf/provider-azure`, then register
its default export in your registry.

## Configuration

```yaml
providers:
  azure:
    enabled: true
    subscriptionId: "00000000-0000-0000-0000-000000000000"
    resourceGroup: rocky-surf-rg
    location: eastus
    sshAllowedCidr: "203.0.113.7/32"
```

| field | default | what it is |
|---|---|---|
| `subscriptionId` | **required** | The subscription everything is created in. A GUID. |
| `resourceGroup` | **required** | The one resource group this provider owns. **You create it**; see below. |
| `location` | `eastus` | The Azure region. One per provider instance. |
| `sshAllowedCidr` | **required** | Which network may reach SSH, as an IPv4 CIDR. No default, deliberately. |
| `allowAllCidr` | `false` | Must also be `true` before `0.0.0.0/0` is accepted. |
| `managedBy` | `rockysurf` | The `managed-by` tag value. Everything created carries it. |
| `vnetName` | `rockysurf-vnet` | The shared virtual network. Created on first launch, adopted after. |
| `subnetName` | `rockysurf-subnet` | The subnet within it. |
| `vnetAddressPrefix` | `10.42.0.0/16` | Address space, used only when creating a new virtual network. |
| `subnetAddressPrefix` | `10.42.0.0/24` | Likewise for the subnet. |
| `nsgName` | `rockysurf-ssh` | The shared network security group. One per resource group. |
| `osDiskGb` | `30` | OS disk size in GiB. Minimum 30 — Azure's Ubuntu images are that size. |
| `osDiskType` | `Premium_LRS` | `Standard_LRS`, `StandardSSD_LRS` or `Premium_LRS`. |
| `imagePublisher` | `Canonical` | Marketplace image publisher. |
| `imageOffer` | `ubuntu-24_04-lts` | Image offer. Note this is the current name; `UbuntuServer` is the pre-20.04 one. |
| `imageSkuAmd64` | `server` | Image SKU for x86-64. Gen2. |
| `imageSkuArm64` | `server-arm64` | Image SKU for Arm64. An Arm image on an x64 size is refused by Azure. |
| `adminUsername` | `azureuser` | The account cloud-init creates and Rocky Surf connects as. Azure refuses `root`. |
| `allowAzureCli` | `true` | Whether the credential chain may fall back to `az account get-access-token`. |
| `sizes` | *(unset)* | Optional allowlist of VM sizes offered in the UI. Core's field, not this provider's. |

**You create the resource group and this provider does not**, which is the one thing in the table
that will surprise you:

```bash
az group create --name rocky-surf-rg --location eastus
```

A role cannot be scoped to a resource group that does not exist yet. A provider that created its
own scope would have to be granted resource-group write across the whole *subscription* — which
is permission to delete any resource group in your account. One command buys a role that cannot
reach outside one group.

## Credentials

**There is no field in the configuration above for an Azure secret, and this provider will not
read one from a file.** Three sources are tried in order:

```bash
# 1. a service principal — the same variables DefaultAzureCredential reads
export AZURE_TENANT_ID=... AZURE_CLIENT_ID=... AZURE_CLIENT_SECRET=...

# 2. a managed identity, if you run Rocky Surf on an Azure VM. Nothing to export, and no secret
#    exists anywhere. This is the best posture available.

# 3. the Azure CLI, so you can try this without creating a service principal first
az login
```

When none of them works, the error names **every** source it tried and why each one did not
answer. Someone who misspelled `AZURE_CLIENT_SECRET` should not be told that the Azure CLI is not
installed.

Set `allowAzureCli: false` to drop the third source. Worth doing on a server: a control plane
that can shell out to whatever `az` resolves to on `PATH` has a wider trust boundary than one
that cannot. It is on by default because the alternative is making a stranger create a service
principal before they can create one box.

**This is not the whole `DefaultAzureCredential` chain**, and it is better to say so than to imply
parity. Workload identity federation, Visual Studio and VS Code credentials, Azure PowerShell and
Azure Developer CLI credentials are absent. If you need one, that is an issue worth opening.

## What it needs in your account

Two custom roles, both published and both shipped as deployable Bicep:

```bash
az deployment sub create \
  --location eastus \
  --template-file deploy/azure/role.bicep \
  --parameters resourceGroupName=rocky-surf-rg principalId=<object id of your identity>
```

The operational role holds 29 actions and is scoped to **your one resource group**. A second,
read-only role holds two actions at subscription scope, and it exists because the VM-size list and
the region list are not *in* a resource group, so no resource-group-scoped role can grant them —
it reads Azure's catalogue, never the contents of your account.

The full action list, with every entry justified, is in
[`docs/providers/azure.md`](https://github.com/amroja-biz/rockysurf/blob/main/docs/providers/azure.md).

**Networking**: Azure has no default virtual network, so this provider creates one — a virtual
network, a subnet and a security group — on first launch and adopts them forever after. They are
never deleted. The SSH rule is written as a *child* of the security group, so if you share that
group with anything else, your other rules survive.

**A Standard-SKU public IP is closed to inbound traffic by default**, so `sshAllowedCidr` is not
merely advisable here: without it SSH does not work at all.

## Capabilities

| capability | value | what it costs you |
|---|---|---|
| `stop` | `true` | Stopping **deallocates**, so compute stops billing. The OS disk and the public IP keep billing — that is the price of a box you can start again with its work intact. |
| `ipStableAcrossStop` | `true` | The address survives a stop. Your SSH config and any DNS pointing at it stay correct across a restart, unlike on EC2. |
| `canInjectHostKeys` | `true` | The box comes up presenting a host key Rocky Surf generated, so the very first connection — the one carrying your secrets file — is verified against a key known beforehand. There is no trust-on-first-use window. **See Verified: this one has not been measured.** |
| `userDataMaxBytes` | `49152` | The ceiling on the cloud-config document. Azure documents 64 KB for `customData` without saying whether that is measured before or after the mandatory base64, and 48 KiB is correct under either reading. In practice the document is ~2.1KB however much software your packs install. |
| `generatesUserData` | `true` | Software is installed through cloud-init at first boot rather than over SSH afterwards, so a box is doing useful work sooner. |

## Prices

**Bundled, in USD, stamped with the date they were read.** The source is the public
[Azure Retail Prices API](https://prices.azure.com/api/retail/prices), which needs no credentials
and no Azure account, so the numbers shipped here are reproducible by anyone.

A price is an estimate rather than a quote: it is pay-as-you-go Linux compute only and does not
include the OS disk, the public IP, or egress. A region this package has no bundled prices for
reports **no price at all** rather than reusing another region's number.

Twelve VM sizes are offered, in both architectures — the burstable `Bsv2`/`Bpsv2` families and the
general-purpose `Dsv5`/`Dpsv5` ones. A `p` in an Azure size name means Ampere Altra, which is the
arm64 half. A size your subscription is restricted from is shown as unavailable rather than
hidden, so a size selector can explain itself instead of silently offering less.

vCPU and memory are read from Azure at the time you look, not bundled, so a machine's shape can
never disagree with what Azure will actually sell you.

## Verified

**Nobody has pointed this provider at Azure.** It was built without an Azure subscription, and
that is a weaker claim than the two clouds that shipped before it can make.

What has been established: 78 tests drive the provider against an in-memory Azure Resource
Manager that reproduces the three behaviours the design depends on — PUT being idempotent by
resource name, the `deleteOption` cascade that makes one delete reap four resources, and the fact
that Azure does not copy a virtual machine's tags onto the OS disk it creates. So the suite can
terminate a machine and assert the disk is gone, rather than assert that the right JSON was sent.
The shared conformance suite passes, including the behavioural absence-grace check that a
previous provider shipped without.

What that cannot establish, and what a real run has to settle:

- **that `canInjectHostKeys: true` is true.** Azure's Ubuntu images are cloud-init provisioned and
  upstream cloud-init injects host keys from the block this provider sends, and Microsoft
  documents no override — but this is a security posture rather than a feature flag, and nobody
  has watched a real Azure box present a key Rocky Surf minted;
- **that the delete cascade reaps everything on real Azure**, rather than in a model of it;
- **that the published role is neither short an action nor wider than it needs to be.** The
  equivalent AWS policy was wrong the first time it was run under a restricted principal;
- **whether ARM has an eventual-consistency window after a create.** The provider waits one out on
  the assumption that it might, because believing a "not found" too early marks a running,
  billing machine dead;
- **whether the `customData` limit is measured before or after base64**, which is why the ceiling
  above is the conservative reading.

Prices are the exception: those are real, and reproducible from a public feed.

## Writing your own provider

The contract is [`@rockysurf/provider-sdk`](https://www.npmjs.com/package/@rockysurf/provider-sdk)
and the workflow is
[`docs/writing-a-provider.md`](https://github.com/amroja-biz/rockysurf/blob/main/docs/writing-a-provider.md).
