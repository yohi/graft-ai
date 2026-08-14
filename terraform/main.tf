provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# Worker script is deployed by Wrangler; Terraform manages only the Logpush job.
# Use `make deploy` (wrangler deploy + terraform apply) after setting secrets via
# `npx wrangler secret put` and `TF_VAR_*` environment variables.
#
# NOTE: cloudflare_logpush_job does not yet support the "ai_gateway_events"
# dataset in provider v5, so the job is managed through the Cloudflare API.
# The helper performs an idempotent upsert by job name.

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

resource "terraform_data" "aig_logpush_job" {
  # Keep only non-secret values in input so the Terraform plan/state does not
  # store the Cloudflare API token. The token is passed to the create-time
  # local-exec via its environment. On destroy, export CF_API_TOKEN in the
  # calling shell (from TF_VAR_cloudflare_api_token or another source) so the
  # helper can remove the Logpush job.
  triggers_replace = [
    nonsensitive(sha256(var.cloudflare_account_id)),
    nonsensitive(sha256(local.destination_conf)),
    nonsensitive(sha256(local.logpush_payload)),
  ]

  input = {
    cloudflare_account_id = var.cloudflare_account_id
    logpush_dataset       = var.logpush_dataset
    logpush_job_name      = var.logpush_job_name
  }

  provisioner "local-exec" {
    environment = {
      CF_API_TOKEN  = nonsensitive(var.cloudflare_api_token)
      CF_ACCOUNT_ID = var.cloudflare_account_id
      JOB_NAME      = var.logpush_job_name
      PAYLOAD       = local.logpush_payload
    }
    command = "${path.module}/manage-cloudflare-logpush-job.sh upsert"
  }

  provisioner "local-exec" {
    when = destroy
    environment = {
      CF_ACCOUNT_ID = self.input.cloudflare_account_id
      JOB_NAME      = self.input.logpush_job_name
    }
    command = "${path.module}/manage-cloudflare-logpush-job.sh delete"
  }
}
