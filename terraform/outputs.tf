output "worker_url" {
  description = "URL of the deployed Worker"
  value       = "https://${var.worker_script_name}.${var.workers_subdomain}.workers.dev"
}

output "logpush_job_id" {
  description = "ID of the created Logpush job"
  value       = cloudflare_logpush_job.aig_logs.id
}

output "logpush_job_name" {
  description = "Name of the created Logpush job"
  value       = cloudflare_logpush_job.aig_logs.name
}

output "worker_script_name" {
  description = "Name of the deployed Worker script"
  value       = var.worker_script_name
}
