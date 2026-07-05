variable "grafana_cloud_api_key" {
  description = "Grafana Cloud API key (org-level, Admin role) for managing Access Policies."
  type        = string
  sensitive   = true
}

variable "grafana_stack_slug" {
  description = "Grafana Cloud stack slug (e.g. <your-stack-slug>)"
  type        = string
}

variable "grafana_stack_region_slug" {
  description = "Grafana Cloud stack region slug (e.g. prod-ap-northeast-0)"
  type        = string
}
