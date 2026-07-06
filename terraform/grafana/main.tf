# ------------------------------------------------------------------------------
# Grafana Cloud provider — manages Access Policy + Loki write token
# Free Tier proxy mode only (no Logpush job here)
# ------------------------------------------------------------------------------


# ------------------------------------------------------------------
# Provider
# ------------------------------------------------------------------
provider "grafana" {
  alias                     = "cloud"
  cloud_access_policy_token = var.grafana_cloud_api_key
}

# ------------------------------------------------------------------
# Data: look up the stack so we know the region / org
# ------------------------------------------------------------------
data "grafana_cloud_stack" "this" {
  provider = grafana.cloud
  slug     = var.grafana_stack_slug
}

# ------------------------------------------------------------------
# Access Policy: logs:write scoped to this stack
# ------------------------------------------------------------------
resource "grafana_cloud_access_policy" "loki_write" {
  provider     = grafana.cloud
  region       = data.grafana_cloud_stack.this.region_slug
  name         = "graft-ai-loki-write"
  display_name = "graft-ai Loki write policy"
  scopes       = ["logs:write"]

  realm {
    type       = "stack"
    identifier = tostring(data.grafana_cloud_stack.this.id)
  }
}

# ------------------------------------------------------------------
# Token for the Access Policy
# ------------------------------------------------------------------
resource "grafana_cloud_access_policy_token" "loki_write" {
  provider         = grafana.cloud
  region           = data.grafana_cloud_stack.this.region_slug
  access_policy_id = grafana_cloud_access_policy.loki_write.policy_id
  name             = "graft-ai-loki-write-token"
  display_name     = "graft-ai Loki write token"
  expires_at       = timeadd(timestamp(), "8760h")

  lifecycle {
    ignore_changes = [expires_at]
  }
}

# ------------------------------------------------------------------
# Outputs — used by the setup script to register Wrangler secrets
# ------------------------------------------------------------------
output "grafana_loki_url" {
  description = "Grafana Cloud Loki push URL"
  value       = data.grafana_cloud_stack.this.logs_url
}

output "grafana_loki_username" {
  description = "Grafana Cloud Loki tenant username (numeric ID)"
  value       = tostring(data.grafana_cloud_stack.this.logs_user_id)
}

output "grafana_loki_write_token" {
  description = "Access Policy Token for Loki write (logs:write)"
  value       = grafana_cloud_access_policy_token.loki_write.token
  sensitive   = true
}
