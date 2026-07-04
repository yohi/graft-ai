variable "cloudflare_account_id" {
  description = "Cloudflare Account ID"
  type        = string
  sensitive   = true
}

variable "cloudflare_api_token" {
  description = "Cloudflare API Token with Logpush and Workers permissions"
  type        = string
  sensitive   = true
}

variable "grafana_cloud_loki_url" {
  description = "Grafana Cloud Loki push endpoint URL (e.g. https://logs-prod-xxx.grafana.net)"
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.grafana_cloud_loki_url) > 0
    error_message = "grafana_cloud_loki_url must not be empty."
  }
}

variable "grafana_cloud_loki_username" {
  description = "Grafana Cloud Loki tenant ID (User value from portal)"
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.grafana_cloud_loki_username) > 0
    error_message = "grafana_cloud_loki_username must not be empty."
  }
}

variable "grafana_cloud_access_policy_token" {
  description = "Grafana Cloud Access Policy Token with logs:write scope"
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.grafana_cloud_access_policy_token) > 0
    error_message = "grafana_cloud_access_policy_token must not be empty."
  }
}

variable "rsa_private_key_pem" {
  description = "RSA private key (PKCS#8 PEM) for decrypting AI Gateway logpush logs"
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.rsa_private_key_pem) > 0
    error_message = "rsa_private_key_pem must not be empty."
  }
}

variable "logpush_dataset" {
  description = "Cloudflare Logpush dataset name for AI Gateway logs. Verify via Cloudflare API before applying (spec §9)."
  type        = string
  default     = "ai_gateway_events"
}

variable "worker_script_name" {
  description = "Cloudflare Workers script name"
  type        = string
  default     = "graft-ai-aig-logpush"
}

variable "logpush_job_name" {
  description = "Human-readable name for the Logpush job"
  type        = string
  default     = "graft-ai-aig-logpush"
}

variable "workers_subdomain" {
  description = "Cloudflare Workers account subdomain (set in Workers & Pages › Your subdomain)"
  type        = string
}

variable "max_upload_bytes" {
  description = "Maximum upload size in bytes for each Logpush batch"
  type        = number
  default     = 5000000
}

variable "max_upload_records" {
  description = "Maximum number of records per Logpush batch"
  type        = number
  default     = 1000
}

variable "origin_secret" {
  description = "Origin secret shared between Logpush destination and the Workers ingress; sent as X-Origin-Secret header"
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.origin_secret) > 0
    error_message = "origin_secret must not be empty."
  }
}
