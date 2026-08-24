# Cloudflare Worker AI Gateway OTel Runbook

This runbook describes the dedicated JSON-only OTel route:

```text
AI Gateway
  -> https://<worker>.workers.dev/v1/traces
  -> authenticated Worker
  -> redaction
  -> R2 redacted envelope
  -> ingress Queue
  -> Trace/Metrics Durable Objects
  -> backend Queues and DLQs
  -> Grafana Cloud Tempo, Loki, and Prometheus
```

The Worker is independent of the encrypted Logpush Worker in
`workers/src/index.ts`. The legacy Tunnel/Alloy route remains available as the
rollback path until the controlled observation window is complete.

## Required secrets

Register these seven values as Wrangler secrets for the generated OTel Worker
configuration at `workers/.wrangler/otel.generated.jsonc`:

```text
OTEL_INGEST_TOKEN
OTEL_RATE_LIMIT_HMAC_KEY
GRAFANA_CLOUD_OTLP_TRACES_URL
GRAFANA_CLOUD_OTLP_METRICS_URL
GRAFANA_CLOUD_OTLP_AUTHORIZATION
GRAFANA_CLOUD_LOKI_URL
GRAFANA_CLOUD_LOKI_AUTHORIZATION
```

The Grafana telemetry credential must have `traces:write`, `metrics:write`, and
`logs:write`. The Loki-only credential, when used separately, must have only
`logs:write`. Never place endpoint credentials in Wrangler `vars`, Terraform
tfvars, source files, Queue messages, or documentation.

Render the configuration after provisioning the Terraform-owned resources and
before registering secrets. The target reads
`otel_payload_kv_namespace_id` and replaces the KV namespace sentinel with the
real ID. The complete sequence is shown below.

For an interactive local registration, run each command from `workers/` and
enter the value only at the hidden prompt:

```bash
npx wrangler secret put OTEL_INGEST_TOKEN --config .wrangler/otel.generated.jsonc
npx wrangler secret put OTEL_RATE_LIMIT_HMAC_KEY --config .wrangler/otel.generated.jsonc
npx wrangler secret put GRAFANA_CLOUD_OTLP_TRACES_URL --config .wrangler/otel.generated.jsonc
npx wrangler secret put GRAFANA_CLOUD_OTLP_METRICS_URL --config .wrangler/otel.generated.jsonc
npx wrangler secret put GRAFANA_CLOUD_OTLP_AUTHORIZATION --config .wrangler/otel.generated.jsonc
npx wrangler secret put GRAFANA_CLOUD_LOKI_URL --config .wrangler/otel.generated.jsonc
npx wrangler secret put GRAFANA_CLOUD_LOKI_AUTHORIZATION --config .wrangler/otel.generated.jsonc
```

## Pre-deployment checks

Run these commands from the repository root:

```bash
make otel-worker-test
make otel-worker-validate
```

`otel-worker-validate` checks the isolated Wrangler contract, Queue/DLQ
topology, JSON-only configuration, forbidden inline credentials, and the
Wrangler dry run. Terraform owns the four source Queues, four DLQs, the OTel KV
namespace, the R2 bucket, and its seven-day `otel/` lifecycle rule. Wrangler
owns Queue consumers and Durable Object exports.

Provision account resources before deploying the Worker:

```bash
terraform -chdir=terraform init
terraform -chdir=terraform apply \
  -target=cloudflare_queue.otel \
  -target=cloudflare_queue.otel_dlq \
  -target=cloudflare_workers_kv_namespace.otel_payloads \
  -target=cloudflare_r2_bucket.otel \
  -target=cloudflare_r2_bucket_lifecycle.otel
export OTEL_PAYLOAD_KV_NAMESPACE_ID="$(terraform -chdir=terraform output -raw otel_payload_kv_namespace_id)"
make render-otel-worker-config OTEL_PAYLOAD_KV_NAMESPACE_ID="$OTEL_PAYLOAD_KV_NAMESPACE_ID"
make deploy-otel-worker
```

The production workflow performs the same apply, output, render, secret
synchronization, and deploy order. It deploys only the generated
`.wrangler/otel.generated.jsonc` configuration and does not change the existing
AI Gateway exporter configuration.

## AI Gateway configuration

Configure exactly one OTel exporter with:

```text
URL: https://<worker>.workers.dev/v1/traces
Header name: Authorization
Header value: Bearer <OTEL_INGEST_TOKEN>
Content type: json
```

The only accepted request is `POST /v1/traces` with
`Content-Type: application/json` and no compression or `identity` compression.
The Worker returns `200` after the redacted R2 pointer and ingress Queue
handoff are durable. Queue and backend delivery are at-least-once; do not treat
the Grafana HTTP POST as exactly-once.

## Grafana verification

After a synthetic request, verify a sampled trace, its selected request span,
and its RED metrics. Example queries are:

```text
Tempo: { span.graft_ai.request_span = true }
Loki: {gateway="main",env="prod"} | json
Prometheus: sum by (model, provider) (increase(ai_gateway_requests_total{gateway="main",env="prod"}[15m]))
```

The Loki stream has exactly `model`, `status_code`, `env`, and `gateway`
labels. `trace_id` remains a JSON field and is not a label. Check the existing
OTel alert rules, especially:

```text
OtelBackendExportExhausted
OtelBackendDrops
OtelBackendQueueSaturation
OtelIngressRateLimited
```

## DLQ and replay safety

Inspect source Queues and backend-specific DLQs with Wrangler. A DLQ message is
an R2 pointer, not a raw OTLP payload. Preserve the pointer and its ledger
state during investigation. Confirm the R2 checksum and object retention before
replaying it; never edit the payload or construct a replacement pointer by
hand.

Terminal Grafana responses and exhausted retries are deliberately left
visible to the matching DLQ. Network failures, timeouts, and `408`/`429`/`5xx`
responses remain retryable for up to three attempts. Confirmed completion is
recorded before the R2 object is deleted. A response lost after bytes may have
been sent remains an explicit at-least-once outcome.

Observe for at least 24 hours. Confirm that no DLQ grows unexpectedly,
`otel_backend_export_exhausted_total` remains stable, Queue saturation stays
below the alert threshold, and sampled Tempo/Loki traces agree with the
configured sampling rate.

## Rollback

If acceptance criteria fail, edit the same single AI Gateway exporter back to
the still-running Tunnel endpoint and its existing authentication/content type.
Do not add a direct Grafana exporter or a parallel Worker exporter. Keep the
Worker Queues, DLQs, and non-secret observations for diagnosis. Retire the
Tunnel/Alloy route only after the observation window and explicit operator
confirmation.

The Worker must never fall back to direct Grafana export from the ingress path;
that would bypass the redaction boundary and the durable Queue handoff.
