locals {
  otel_worker_name = var.otel_worker_name
  otel_bucket_name = var.otel_bucket_name
  otel_queue_names = {
    ingress    = "${local.otel_worker_name}-ingress-v1"
    tempo      = "${local.otel_worker_name}-tempo-v1"
    loki       = "${local.otel_worker_name}-loki-v1"
    prometheus = "${local.otel_worker_name}-prometheus-v1"
  }
  otel_dlq_names = {
    ingress    = "${local.otel_worker_name}-ingress-dlq-v1"
    tempo      = "${local.otel_worker_name}-tempo-dlq-v1"
    loki       = "${local.otel_worker_name}-loki-dlq-v1"
    prometheus = "${local.otel_worker_name}-prometheus-dlq-v1"
  }
}

resource "cloudflare_queue" "otel" {
  for_each   = local.otel_queue_names
  account_id = var.cloudflare_account_id
  queue_name = each.value

  settings = {
    message_retention_period = 86400
  }
}

resource "cloudflare_queue" "otel_dlq" {
  for_each   = local.otel_dlq_names
  account_id = var.cloudflare_account_id
  queue_name = each.value

  settings = {
    # Workers Free limits Queue retention to 24 hours.
    message_retention_period = 86400
  }
}

resource "cloudflare_workers_kv_namespace" "otel_payloads" {
  account_id = var.cloudflare_account_id
  title      = var.otel_payload_kv_namespace_title
}

resource "cloudflare_d1_database" "otel_payloads" {
  account_id = var.cloudflare_account_id
  name       = var.otel_d1_database_name
}

resource "cloudflare_r2_bucket" "otel" {
  account_id = var.cloudflare_account_id
  name       = local.otel_bucket_name
}

resource "cloudflare_r2_bucket_lifecycle" "otel" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.otel.name

  rules = [{
    id      = "expire-otel-objects-after-seven-days"
    enabled = true
    conditions = {
      prefix = "otel/"
    }
    delete_objects_transition = {
      condition = {
        max_age = 604800
        type    = "Age"
      }
    }
  }]
}
