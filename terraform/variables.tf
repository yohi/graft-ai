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
}

variable "grafana_cloud_loki_username" {
  description = "Grafana Cloud Loki tenant ID (User value from portal)"
  type        = string
  sensitive   = true
}

variable "grafana_cloud_access_policy_token" {
  description = "Grafana Cloud Access Policy Token with logs:write scope"
  type        = string
  sensitive   = true
}

variable "origin_secret" {
  description = "Shared secret for X-Origin-Secret header validation between Logpush and Worker"
  type        = string
  sensitive   = true
}

variable "rsa_private_key_pem" {
  description = "RSA private key (PKCS#8 PEM) for decrypting AI Gateway logpush logs"
  type        = string
  sensitive   = true
}

variable "gateway_name" {
  description = "AI Gateway name (used as Loki 'gateway' label and Worker GATEWAY_NAME var)"
  type        = string
  default     = "main"
}

variable "env_label" {
  description = "Environment label for Loki 'env' label (prod / stg)"
  type        = string
  default     = "prod"
}

variable "logpush_dataset" {
  description = "Cloudflare Logpush dataset name for AI Gateway logs. Verify via Cloudflare API before applying (spec §9)."
  type        = string
  default     = "gateway_http"
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
