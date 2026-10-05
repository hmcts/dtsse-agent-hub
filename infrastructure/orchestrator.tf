locals {
  orchestrator_enabled = var.env == "aat"
}

resource "azurerm_user_assigned_identity" "orchestrator" {
  count = local.orchestrator_enabled ? 1 : 0

  name                = "${var.product}-${var.component}-orchestrator-${var.env}-mi"
  resource_group_name = "managed-identities-${var.env}-rg"
  location            = var.location
  tags                = var.common_tags
}

output "orchestrator_identity_client_id" {
  description = "Client id of the orchestrator's workload identity, for its ServiceAccount annotation in cnp-flux-config."
  value       = local.orchestrator_enabled ? azurerm_user_assigned_identity.orchestrator[0].client_id : null
}

output "orchestrator_identity_principal_id" {
  description = "Object id of the orchestrator's service principal, for the hub's ORCHESTRATOR_OIDS."
  value       = local.orchestrator_enabled ? azurerm_user_assigned_identity.orchestrator[0].principal_id : null
}
