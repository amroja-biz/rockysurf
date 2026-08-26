targetScope = 'resourceGroup'

// =============================================================================================
// Rocky Surf — the operational role assignment, at resource group scope.
//
// WHY THIS IS A SEPARATE FILE, which is the only surprising thing here.
//
// `role.bicep` is `targetScope = 'subscription'`, because it creates two role DEFINITIONS and a
// custom role definition is a subscription-level resource. But the operational role must be
// ASSIGNED at the resource group, which is a different scope — and Bicep refuses to deploy a
// resource at a scope other than its file's (BCP139). Crossing a scope boundary requires a
// module, so the assignment lives here and `role.bicep` invokes it with
// `scope: resourceGroup(resourceGroupName)`.
//
// The catalogue role's assignment stays in `role.bicep`: it is granted at subscription scope,
// which already matches that file.
//
// This file deliberately holds no action list. The permissions both roles grant are declared in
// `role.bicep` and checked against docs/providers/azure.md by scripts/check-azure-role.mjs; a
// second place that could widen a role is exactly the drift that lint exists to prevent.
// =============================================================================================

@description('Resource id of the role definition to grant. Passed in by role.bicep.')
param roleDefinitionId string

@description('The OBJECT id of the identity Rocky Surf runs as.')
param principalId string

@description('What kind of identity principalId names.')
param principalType string

// The name is a deterministic guid of (scope, principal, role), which is what makes redeploying
// this template idempotent rather than an error: the same three inputs always name the same
// assignment. `resourceGroup().id` here is the same value `role.bicep` knows as
// `targetResourceGroup.id`, so the name does not change by having moved into a module.
resource operationalAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, roleDefinitionId)
  properties: {
    roleDefinitionId: roleDefinitionId
    principalId: principalId
    principalType: principalType
  }
}
