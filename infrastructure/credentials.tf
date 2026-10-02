# Per-user credentials for virtual agents: each person's GitHub token and Azure token cache, written by the hub and read
# back only by that person's running virtual agent, through the hub.
#
# Deliberately not cnp-module-key-vault: in non-production that module grants the developers group Get on every
# secret, and gives the shared preview Jenkins identity access in AAT. Here only the hub's own identity has data-plane
# access, through RBAC; the pipeline identity manages the vault but cannot read it.

locals {
  credentials_enabled = var.env == "aat"
}

data "azurerm_client_config" "current" {}

resource "azurerm_user_assigned_identity" "hub" {
  count = local.credentials_enabled ? 1 : 0

  name                = "${var.product}-${var.component}-${var.env}-mi"
  resource_group_name = "managed-identities-${var.env}-rg"
  location            = var.location
  tags                = var.common_tags
}

resource "azurerm_key_vault" "credentials" {
  count = local.credentials_enabled ? 1 : 0

  name                = "${var.product}-ah-creds-${var.env}"
  resource_group_name = data.azurerm_key_vault.key_vault.resource_group_name
  location            = var.location
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"
  tags                = var.common_tags

  rbac_authorization_enabled = true

  # A credential the owner deletes should be gone, not recoverable for 90 days: the hub purges on delete.
  purge_protection_enabled   = false
  soft_delete_retention_days = 7
}

resource "azurerm_role_assignment" "hub_credentials" {
  count = local.credentials_enabled ? 1 : 0

  scope                = azurerm_key_vault.credentials[0].id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = azurerm_user_assigned_identity.hub[0].principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_key_vault_secret" "credentials_vault_url" {
  count = local.credentials_enabled ? 1 : 0

  name         = "agent-hub-credentials-vault-url"
  value        = azurerm_key_vault.credentials[0].vault_uri
  key_vault_id = data.azurerm_key_vault.key_vault.id
}

output "hub_identity_client_id" {
  description = "Client id of the hub's workload identity, for its ServiceAccount annotation in cnp-flux-config."
  value       = local.credentials_enabled ? azurerm_user_assigned_identity.hub[0].client_id : null
}
