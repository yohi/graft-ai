provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# Worker script is deployed by Wrangler; Terraform manages only the Logpush job.
# Use `make deploy` (wrangler deploy + terraform apply) after setting secrets via
# `npx wrangler secret put` and `TF_VAR_*` environment variables.
#
# NOTE: cloudflare_logpush_job does not yet support the "ai_gateway_events"
# dataset in provider v5, so we create the job via the Cloudflare API directly
# using a null_resource local-exec provisioner. This is a temporary workaround
# until the Terraform provider adds native support.

locals {
  destination_conf = "https://${var.worker_script_name}.${var.workers_subdomain}.workers.dev?header_X-Origin-Secret=${urlencode(var.origin_secret)}"
  logpush_payload = jsonencode({
    name               = var.logpush_job_name
    dataset            = var.logpush_dataset
    destination_conf   = local.destination_conf
    enabled            = true
    max_upload_bytes   = var.max_upload_bytes
    max_upload_records = var.max_upload_records
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
      timestamp_format = "unix"
      output_type      = "ndjson"
    }
  })
}

resource "null_resource" "aig_logpush_job" {
  triggers = {
    dataset               = var.logpush_dataset
    destination_conf_hash = nonsensitive(sha256(local.destination_conf))
    job_name              = var.logpush_job_name
    max_upload_bytes      = var.max_upload_bytes
    max_upload_records    = var.max_upload_records
    output_options_hash   = sha256(local.logpush_payload)
  }

  provisioner "local-exec" {
    environment = {
      CF_API_TOKEN  = var.cloudflare_api_token
      CF_ACCOUNT_ID = var.cloudflare_account_id
      PAYLOAD       = local.logpush_payload
    }
    command = <<EOT
      set -e
      response=$(curl -fsS -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/logpush/jobs" \
        -H "Authorization: Bearer $CF_API_TOKEN" \
        -H "Content-Type: application/json" \
        -d "$PAYLOAD")
      echo "$response" | tee /tmp/graft-ai-logpush-response.json
    EOT
  }
}
