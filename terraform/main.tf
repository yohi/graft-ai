provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# Worker script is deployed by Wrangler; Terraform manages only the Logpush job.
# Use `make deploy` (wrangler deploy + terraform apply) after setting secrets via
# `npx wrangler secret put` and `TF_VAR_*` environment variables.

resource "cloudflare_logpush_job" "aig_logs" {
  account_id         = var.cloudflare_account_id
  dataset            = var.logpush_dataset
  name               = var.logpush_job_name
  enabled            = true
  destination_conf   = "https://${var.worker_script_name}.${var.workers_subdomain}.workers.dev?header_X-Origin-Secret=${urlencode(var.origin_secret)}"
  max_upload_bytes   = 5000000
  max_upload_records = 1000

  output_options = {
    field_names = [
      "RequestID",
      "RequestTime",
      "CacheStatus",
      "StatusCode",
      "Model",
      "PromptTokens",
      "CompletionTokens",
      "TotalTokens",
      "RequestDuration",
      "Path",
      "Method",
      "Metadata",
      "RequestBody",
      "ResponseBody",
    ]
    timestamp_format = "unixseconds"
    output_type      = "ndjson"
  }
}
