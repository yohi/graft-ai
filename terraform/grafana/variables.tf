variable "grafana_cloud_api_key" {
  description = "Grafana Cloud API key (org-level, Admin role) for managing Access Policies."
  type        = string
  sensitive   = true
}

variable "grafana_stack_slug" {
  description = "Grafana Cloud stack slug (e.g. <your-stack-slug>)"
  type        = string
}


