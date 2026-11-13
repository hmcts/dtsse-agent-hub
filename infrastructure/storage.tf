# Prototype feedback's recordings and page snapshots. The browser puts and gets blobs directly, by SAS the hub signs,
# so the hub never streams a recording.
#
# No account keys: every SAS is signed with a user delegation key the hub's own identity asks for, so a SAS is never
# worth more than that identity's role on the container, and removing the role revokes them all. AAT alone, as the
# hub's identity is.

locals {
  feedback_storage_enabled = local.credentials_enabled
  hub_origin               = "https://agent-hub.${var.env}.platform.hmcts.net"
}

resource "azurerm_storage_account" "feedback" {
  count = local.feedback_storage_enabled ? 1 : 0

  # 3–24 lower-case letters and digits, as dtsseagenthubaat; the chart builds its URL from the same name.
  name                = replace("${var.product}${var.component}${var.env}", "-", "")
  resource_group_name = data.azurerm_key_vault.key_vault.resource_group_name
  location            = var.location
  tags                = var.common_tags

  account_kind             = "StorageV2"
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"

  shared_access_key_enabled       = false
  default_to_oauth_authentication = true
  allow_nested_items_to_be_public = false

  blob_properties {
    # The review shell uploads segments and the hub's pages play them, both from the hub's own origin.
    cors_rule {
      allowed_origins    = [local.hub_origin]
      allowed_methods    = ["GET", "HEAD", "PUT"]
      allowed_headers    = ["content-type", "x-ms-*"]
      exposed_headers    = ["content-length", "content-type", "etag", "x-ms-*"]
      max_age_in_seconds = 3600
    }
  }
}

resource "azurerm_storage_container" "feedback" {
  count = local.feedback_storage_enabled ? 1 : 0

  name                  = "feedback"
  storage_account_id    = azurerm_storage_account.feedback[0].id
  container_access_type = "private"
}

# A backstop for the hub's own sweep, which deletes by each project's retention (at most 365 days) and an archived
# project a week after it is archived: anything the sweep missed is gone after 400 days.
resource "azurerm_storage_management_policy" "feedback" {
  count = local.feedback_storage_enabled ? 1 : 0

  storage_account_id = azurerm_storage_account.feedback[0].id

  rule {
    name    = "feedback-backstop"
    enabled = true

    filters {
      blob_types = ["blockBlob"]
    }

    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = 400
      }
    }
  }
}

resource "azurerm_role_assignment" "hub_feedback_blobs" {
  count = local.feedback_storage_enabled ? 1 : 0

  scope                = azurerm_storage_container.feedback[0].id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.hub[0].principal_id
  principal_type       = "ServicePrincipal"
}

# Asking for a user delegation key is an account-level action, so this one cannot be held to the container.
resource "azurerm_role_assignment" "hub_feedback_delegator" {
  count = local.feedback_storage_enabled ? 1 : 0

  scope                = azurerm_storage_account.feedback[0].id
  role_definition_name = "Storage Blob Delegator"
  principal_id         = azurerm_user_assigned_identity.hub[0].principal_id
  principal_type       = "ServicePrincipal"
}
