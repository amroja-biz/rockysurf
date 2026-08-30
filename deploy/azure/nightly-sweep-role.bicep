targetScope = 'subscription'

// =============================================================================================
// Rocky Surf — the CI-only orphan sweep role for the nightly real-cloud run (gh issue #170).
//
// THIS IS NOT A SHIPPED ARTIFACT. Nothing a self-hoster runs needs it. It exists so the
// repository's own nightly workflow can clean up after itself under an identity that is NOT the
// one under test, and it is deployed by deploy/azure/setup-nightly.sh.
//
// WHY A SECOND IDENTITY AT ALL — two reasons, both learned on the AWS leg:
//
//   1. The sweep deletes what the published role deliberately cannot. Rocky Surf deletes a
//      virtual machine and lets `deleteOption` cascade to the disk, the NIC and the address; it
//      never deletes those three directly, so `deploy/azure/role.bicep` does not grant it. A
//      cleanup after a cascade that only half-happened has to.
//   2. A cleanup wired through the credentials being tested goes blind at exactly the moment it
//      matters — when those credentials are what broke.
//
// WHAT IT CANNOT DO, which is the part worth reading:
//
//   - It cannot CREATE anything. There is no `write` action in the list at all.
//   - It cannot delete the virtual network or the network security group. Those are shared, they
//     outlive every server, and deleting either detaches the network from — or closes port 22 on
//     — every running box in the group at once. The workflow's sweep step also excludes them by
//     type; this is the braces to that belt.
//   - It cannot reach outside the one CI resource group. The definition's assignableScopes and
//     the assignment are both that group.
//   - It has nothing on Microsoft.Authorization, so it cannot grant itself more.
// =============================================================================================

@description('The CI-only resource group the nightly creates its machines in. Create it first.')
param resourceGroupName string

@description('The OBJECT id of the CI-only sweep identity. `az ad sp show --id <appId> --query id -o tsv`.')
param principalId string

@description('What kind of identity principalId names.')
@allowed([
  'ServicePrincipal'
  'User'
  'Group'
])
param principalType string = 'ServicePrincipal'

@description('A suffix for the role name, so two CI groups in one subscription do not collide.')
param roleNameSuffix string = resourceGroupName

// Read the group and everything in it — the second entry is what `az resource list` spends, and
// it is how the sweep sees an OS disk, which carries no tag of its own because Azure does not
// copy a VM's tags onto a disk it creates from an image.
var sweepActions = [
  'Microsoft.Resources/subscriptions/resourceGroups/read'
  'Microsoft.Resources/subscriptions/resourceGroups/resources/read'

  'Microsoft.Compute/virtualMachines/read'
  'Microsoft.Compute/virtualMachines/delete'
  'Microsoft.Compute/disks/read'
  'Microsoft.Compute/disks/delete'
  'Microsoft.Network/networkInterfaces/read'
  'Microsoft.Network/networkInterfaces/delete'
  'Microsoft.Network/publicIPAddresses/read'
  'Microsoft.Network/publicIPAddresses/delete'
]

resource targetResourceGroup 'Microsoft.Resources/resourceGroups@2021-04-01' existing = {
  name: resourceGroupName
}

resource sweepRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, resourceGroupName, 'rockysurf-nightly-sweep')
  properties: {
    roleName: 'Rocky Surf Nightly Sweep (${roleNameSuffix})'
    description: 'Delete leftover Rocky Surf machines, disks, interfaces and addresses in one CI resource group. Creates nothing.'
    type: 'CustomRole'
    permissions: [
      {
        actions: sweepActions
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    assignableScopes: [
      targetResourceGroup.id
    ]
  }
}

// Same scope-crossing shape as role.bicep: the definition is subscription-level, the assignment
// is at the resource group, and Bicep needs a module to cross that boundary (BCP139).
module sweepAssignment 'role-assignment.bicep' = {
  name: 'rockysurf-nightly-sweep-assignment'
  scope: resourceGroup(resourceGroupName)
  params: {
    roleDefinitionId: sweepRole.id
    principalId: principalId
    principalType: principalType
  }
}

output sweepRoleId string = sweepRole.id
