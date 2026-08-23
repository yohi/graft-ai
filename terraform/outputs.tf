output "worker_url" {
  description = "URL of the deployed Worker"
  value       = "https://${var.worker_script_name}.${var.workers_subdomain}.workers.dev"
}

output "otel_worker_url" {
  description = "URL of the dedicated AI Gateway OTel Worker"
  value       = "https://${local.otel_worker_name}.${var.workers_subdomain}.workers.dev"
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
