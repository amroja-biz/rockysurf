targetScope = 'subscription'

// =============================================================================================
// Rocky Surf — the Azure permissions the control plane needs to create, stop, start and destroy
// dev boxes in your subscription, and nothing beyond that.
//
// THIS TEMPLATE IS A SHIPPED ARTIFACT, NOT TEST SCAFFOLDING.
//
// Rocky Surf is self-hosted, so the cloud resources a deployment needs ship with the product as
// parameterized infrastructure-as-code. This is the file a self-hoster deploys, and the actions
// below are checked for equality against the JSON published in docs/providers/azure.md by
// `node scripts/check-azure-role.mjs`, which runs as part of `pnpm run lint`. They cannot drift
// apart silently: change one without the other and CI fails, naming the action that differs.
//
// WHY THERE ARE TWO ROLES, which is the only surprising thing here.
//
// Everything Rocky Surf CREATES lives in one resource group, and the operational role is scoped
// to exactly that group — it cannot see, touch or delete anything else in your subscription.
// That is the whole reason Rocky Surf does not create the group itself: a role cannot be scoped
// to a resource group that does not exist yet, so a provider that created its own scope would
// have to be granted resource-group write at SUBSCRIPTION scope, which means permission to
// delete any resource group in the account.
//
// But two of the reads Rocky Surf needs are of resources that live ABOVE a resource group —
// the list of VM sizes your subscription may order, and the list of regions it may use. No
// resource-group-scoped role can grant those, whatever actions it names. So they are a second,
// separate, read-only role at subscription scope. It reads AZURE'S OWN CATALOGUE, not the
// contents of your account: what Microsoft sells you, not what you own.
//
// STATUS: this role is REASONED FROM THE API CALLS THE PROVIDER MAKES and has NOT yet been
// proven under a restricted principal. See the status note in docs/providers/azure.md.
//
// Deploy:
//   az deployment sub create \
//     --location eastus \
//     --template-file deploy/azure/role.bicep \
//     --parameters resourceGroupName=rocky-surf-rg principalId=<object id of your identity>
// =============================================================================================

@description('''
The one resource group Rocky Surf owns. Create it first — `az group create --name rocky-surf-rg
--location eastus` — because a role cannot be scoped to a group that does not exist yet. This
must match `providers.azure.resourceGroup` in your rockysurf.config.yaml.
''')
param resourceGroupName string

@description('''
The OBJECT id (not the application id) of the identity Rocky Surf runs as. For a service
principal: `az ad sp show --id <appId> --query id -o tsv`. For a user-assigned managed identity:
its `principalId`. There is no default — who holds the keys to your dev boxes is a decision to
write down, not to inherit.
''')
param principalId string

@description('What kind of identity principalId names. ServicePrincipal covers both app registrations and managed identities.')
@allowed([
  'ServicePrincipal'
  'User'
  'Group'
])
param principalType string = 'ServicePrincipal'

@description('''
A suffix for the two role names, so a second Rocky Surf against the same subscription does not
collide with the first. Role definition names are unique per subscription.
''')
param roleNameSuffix string = resourceGroupName

// ---------------------------------------------------------------------------------------------
// The operational role — scoped to ONE resource group.
//
// Every action here is one the provider actually calls. The four `join/action` entries are the
// ones that surprise people: Azure authorizes an attachment against the resource being attached
// TO, so creating a network interface in a subnet needs `subnets/join/action` on the subnet even
// though nothing about the subnet changes. It is the same shape as EC2 authorizing RunInstances
// against every resource it touches. Without them, every launch fails with AuthorizationFailed
// naming a resource you did not think you were writing to.
// ---------------------------------------------------------------------------------------------
var operationalActions = [
  // Read the group itself, which is what validateCredentials() proves, and list its contents,
  // which is the reconciler's whole input.
  'Microsoft.Resources/subscriptions/resourceGroups/read'
  'Microsoft.Resources/subscriptions/resourceGroups/resources/read'

  // The machine. `deallocate` rather than `powerOff` is the stop: both preserve the disk and
  // only one stops the compute bill.
  'Microsoft.Compute/virtualMachines/read'
  'Microsoft.Compute/virtualMachines/write'
  'Microsoft.Compute/virtualMachines/delete'
  'Microsoft.Compute/virtualMachines/start/action'
  'Microsoft.Compute/virtualMachines/deallocate/action'
  'Microsoft.Compute/virtualMachines/instanceView/read'

  // The OS disk. Rocky Surf never PUTs a disk — it is created by the VM from the image — but
  // Azure evaluates that as a disk write, and `delete` is what the deleteOption cascade spends.
  'Microsoft.Compute/disks/read'
  'Microsoft.Compute/disks/write'
  'Microsoft.Compute/disks/delete'

  // The shared network, created once on first launch and adopted forever after. No delete: it
  // outlives every server, and a reconciler must never reap it.
  'Microsoft.Network/virtualNetworks/read'
  'Microsoft.Network/virtualNetworks/write'
  'Microsoft.Network/virtualNetworks/subnets/read'
  'Microsoft.Network/virtualNetworks/subnets/write'
  'Microsoft.Network/virtualNetworks/subnets/join/action'
  'Microsoft.Network/networkSecurityGroups/read'
  'Microsoft.Network/networkSecurityGroups/write'
  'Microsoft.Network/networkSecurityGroups/join/action'
  'Microsoft.Network/networkSecurityGroups/securityRules/read'
  'Microsoft.Network/networkSecurityGroups/securityRules/write'

  // The per-server address and interface, both reaped by the cascade on terminate.
  'Microsoft.Network/publicIPAddresses/read'
  'Microsoft.Network/publicIPAddresses/write'
  'Microsoft.Network/publicIPAddresses/delete'
  'Microsoft.Network/publicIPAddresses/join/action'
  'Microsoft.Network/networkInterfaces/read'
  'Microsoft.Network/networkInterfaces/write'
  'Microsoft.Network/networkInterfaces/delete'
  'Microsoft.Network/networkInterfaces/join/action'
]

// ---------------------------------------------------------------------------------------------
// The catalogue role — read-only, subscription-scoped, two actions.
//
// These read what Azure will sell this subscription, never what the subscription contains: the
// VM sizes available in a region together with any per-subscription restriction on them, and the
// list of regions itself. Both live above a resource group, so no resource-group-scoped role can
// grant them.
// ---------------------------------------------------------------------------------------------
var catalogueActions = [
  'Microsoft.Compute/skus/read'
  'Microsoft.Resources/subscriptions/locations/read'
]

resource targetResourceGroup 'Microsoft.Resources/resourceGroups@2021-04-01' existing = {
  name: resourceGroupName
}

resource operationalRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, resourceGroupName, 'rockysurf-operational')
  properties: {
    roleName: 'Rocky Surf Provider (${roleNameSuffix})'
    description: 'Create, stop, start and destroy Rocky Surf dev boxes in one resource group. Cannot reach anything outside it.'
    type: 'CustomRole'
    permissions: [
      {
        actions: operationalActions
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    // The role cannot be assigned anywhere else, even by someone who wanted to.
    assignableScopes: [
      targetResourceGroup.id
    ]
  }
}

resource catalogueRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, resourceGroupName, 'rockysurf-catalogue')
  properties: {
    roleName: 'Rocky Surf Catalogue Reader (${roleNameSuffix})'
    description: 'Read the VM sizes and regions this subscription may order. Reads Azure\'s catalogue, not the account\'s contents.'
    type: 'CustomRole'
    permissions: [
      {
        actions: catalogueActions
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    assignableScopes: [
      subscription().id
    ]
  }
}

// The operational assignment is granted at the RESOURCE GROUP, which is not this file's scope
// (see the header: role DEFINITIONS are subscription-level, which is why targetScope is what it
// is). Bicep will not deploy a resource across a scope boundary, so the assignment is a module.
// See deploy/azure/role-assignment.bicep.
module operationalAssignment 'role-assignment.bicep' = {
  name: 'rockysurf-operational-assignment'
  scope: resourceGroup(resourceGroupName)
  params: {
    roleDefinitionId: operationalRole.id
    principalId: principalId
    principalType: principalType
  }
}

resource catalogueAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(subscription().id, principalId, catalogueRole.id)
  properties: {
    roleDefinitionId: catalogueRole.id
    principalId: principalId
    principalType: principalType
  }
}

@description('Set this as providers.azure.subscriptionId in rockysurf.config.yaml.')
output subscriptionId string = subscription().subscriptionId

@description('Set this as providers.azure.resourceGroup in rockysurf.config.yaml.')
output resourceGroup string = resourceGroupName

output operationalRoleId string = operationalRole.id
output catalogueRoleId string = catalogueRole.id
