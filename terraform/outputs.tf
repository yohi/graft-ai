output "worker_url" {
  description = "URL of the deployed Worker"
  value       = "https://${var.worker_script_name}.${var.workers_subdomain}.workers.dev"
}

output "otel_worker_url" {
  description = "URL of the dedicated AI Gateway OTel Worker"
  value       = "https://${local.otel_worker_name}.${var.workers_subdomain}.workers.dev"
}

output "otel_payload_kv_namespace_id" {
  description = "Workers KV namespace ID used by the dedicated OTel Worker payload store"
  value       = cloudflare_workers_kv_namespace.otel_payloads.id
}

output "otel_payload_d1_database_id" {
  description = "Cloudflare D1 database ID used by the dedicated OTel Worker payload store"
  value       = cloudflare_d1_database.otel_payloads.id
}

output "logpush_job_name" {
  description = "Name of the created Logpush job"
  value       = var.logpush_job_name
}

output "worker_script_name" {
  description = "Name of the deployed Worker script"
  value       = var.worker_script_name
}

output "logpush_destination_url" {
  description = "Destination URL used for the Logpush job (query parameters excluded)"
  value       = "https://${var.worker_script_name}.${var.workers_subdomain}.workers.dev"
}
