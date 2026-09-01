# ------------------------------------------------------------------------------
# Grafana Cloud provider — manages Access Policy + telemetry write token
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
# Access Policy: logs:write + metrics:write + traces:write scoped to this stack
# ------------------------------------------------------------------
moved {
  from = grafana_cloud_access_policy.loki_write
  to   = grafana_cloud_access_policy.telemetry_write
}

moved {
  from = grafana_cloud_access_policy_token.loki_write
  to   = grafana_cloud_access_policy_token.telemetry_write
}

resource "grafana_cloud_access_policy" "telemetry_write" {
  provider     = grafana.cloud
  region       = data.grafana_cloud_stack.this.region_slug
  name         = "graft-ai-telemetry-write"
  display_name = "graft-ai-telemetry-write"
  scopes       = ["logs:write", "metrics:write", "traces:write"]

  realm {
    type       = "stack"
    identifier = tostring(data.grafana_cloud_stack.this.id)
  }
}

# ------------------------------------------------------------------
# Token for the Access Policy
# ------------------------------------------------------------------
resource "grafana_cloud_access_policy_token" "telemetry_write" {
  provider         = grafana.cloud
  region           = data.grafana_cloud_stack.this.region_slug
  access_policy_id = grafana_cloud_access_policy.telemetry_write.policy_id
  name             = "graft-ai-telemetry-write"
  display_name     = "graft-ai-telemetry-write"
  expires_at       = timeadd(timestamp(), "8760h")

  lifecycle {
    ignore_changes = [expires_at]
  }
}

# ------------------------------------------------------------------
# Loki-only Access Policy and token
# ------------------------------------------------------------------
resource "grafana_cloud_access_policy" "loki_ingest" {
  provider     = grafana.cloud
  region       = data.grafana_cloud_stack.this.region_slug
  name         = "graft-ai-loki-write"
  display_name = "graft-ai-loki-write"
  scopes       = ["logs:write"]

  realm {
    type       = "stack"
    identifier = tostring(data.grafana_cloud_stack.this.id)
  }
}

resource "grafana_cloud_access_policy_token" "loki_ingest" {
  provider         = grafana.cloud
  region           = data.grafana_cloud_stack.this.region_slug
  access_policy_id = grafana_cloud_access_policy.loki_ingest.policy_id
  name             = "graft-ai-loki-write"
  display_name     = "graft-ai-loki-write"
  expires_at       = timeadd(timestamp(), "8760h")

  lifecycle {
    ignore_changes = [expires_at]
  }
}

# ------------------------------------------------------------------
# Outputs — used by setup scripts and CI to configure secrets
# ------------------------------------------------------------------
output "grafana_loki_url" {
  description = "Grafana Cloud Loki push URL"
  value       = data.grafana_cloud_stack.this.logs_url
}

output "grafana_loki_username" {
  description = "Grafana Cloud Loki tenant username (numeric ID)"
  value       = tostring(data.grafana_cloud_stack.this.logs_user_id)
}

output "grafana_prometheus_url" {
  description = "Grafana Cloud Prometheus push URL"
  value       = data.grafana_cloud_stack.this.prometheus_url
}

output "grafana_prometheus_username" {
  description = "Grafana Cloud Prometheus instance username (numeric ID)"
  value       = tostring(data.grafana_cloud_stack.this.prometheus_user_id)
}

output "grafana_otlp_url" {
  description = "Grafana Cloud OTLP gateway push URL"
  value       = data.grafana_cloud_stack.this.otlp_url
}

output "grafana_otlp_username" {
  description = "Grafana Cloud OTLP gateway username (stack ID)"
  value       = tostring(data.grafana_cloud_stack.this.id)
}

output "grafana_access_policy_token" {
  description = "Telemetry Access Policy Token with logs:write, metrics:write, and traces:write"
  value       = grafana_cloud_access_policy_token.telemetry_write.token
  sensitive   = true
}

output "grafana_telemetry_write_token" {
  description = "Telemetry Access Policy Token with logs:write, metrics:write, and traces:write"
  value       = grafana_cloud_access_policy_token.telemetry_write.token
  sensitive   = true
}

output "grafana_loki_write_token" {
  description = "Loki-only Access Policy Token with logs:write"
  value       = grafana_cloud_access_policy_token.loki_ingest.token
  sensitive   = true
}
