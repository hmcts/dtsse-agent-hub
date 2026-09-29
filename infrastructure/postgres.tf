locals {
  database = "agent_hub"
}

module "postgresql" {
  providers = {
    azurerm.postgres_network = azurerm.postgres_network
  }

  source = "git@github.com:hmcts/terraform-module-postgresql-flexible?ref=master"

  name          = "dts-${var.component}"
  env           = var.env
  product       = var.product
  component     = var.component
  business_area = "cft"
  common_tags   = var.common_tags

  subnet_suffix = "expanded"

  pgsql_databases = [
    {
      name = local.database
    }
  ]

  pgsql_version        = "16"
  pgsql_sku            = "GP_Standard_D2ds_v4"
  pgsql_storage_mb     = 32768
  auto_grow_enabled    = true
  admin_user_object_id = var.jenkins_AAD_objectId
}

resource "azurerm_key_vault_secret" "postgres_host" {
  name         = "agent-hub-postgres-host"
  value        = module.postgresql.fqdn
  key_vault_id = data.azurerm_key_vault.key_vault.id
}

resource "azurerm_key_vault_secret" "postgres_port" {
  name         = "agent-hub-postgres-port"
  value        = "5432"
  key_vault_id = data.azurerm_key_vault.key_vault.id
}

resource "azurerm_key_vault_secret" "postgres_user" {
  name         = "agent-hub-postgres-user"
  value        = module.postgresql.username
  key_vault_id = data.azurerm_key_vault.key_vault.id
}

resource "azurerm_key_vault_secret" "postgres_password" {
  name         = "agent-hub-postgres-password"
  value        = module.postgresql.password
  key_vault_id = data.azurerm_key_vault.key_vault.id
}

resource "azurerm_key_vault_secret" "postgres_database" {
  name         = "agent-hub-postgres-database"
  value        = local.database
  key_vault_id = data.azurerm_key_vault.key_vault.id
}
