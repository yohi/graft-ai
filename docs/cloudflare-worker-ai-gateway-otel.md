# Cloudflare Worker AI Gateway OTel Runbook

This runbook describes the dedicated JSON-only OTel route:

```text
AI Gateway
  -> https://<worker>.workers.dev/v1/traces
  -> authenticated Worker
  -> redaction
  -> KV redacted envelope (R2 is an explicit opt-in)
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
Wrangler dry run. Terraform owns the four source Queues, four DLQs, and the
Workers KV namespace. The R2 bucket and its seven-day `otel/` lifecycle rule are
retained for explicit R2 and drain deployments. Wrangler owns Queue consumers
and Durable Object exports.

Provision account resources before deploying the Worker:

```bash
terraform -chdir=terraform init
terraform -chdir=terraform apply \
  -target=cloudflare_queue.otel \
  -target=cloudflare_queue.otel_dlq \
  -target=cloudflare_workers_kv_namespace.otel_payloads
make deploy-otel-worker
```

The production workflow performs the same order, reads the non-secret KV
namespace ID from Terraform output, runs
`make render-otel-worker-config` to render `.wrangler/otel.generated.jsonc`,
synchronizes the seven secrets, and deploys that generated config. It does not
change the existing AI Gateway exporter configuration.

## Payload storage, quotas, and migration

`OTEL_PAYLOAD_STORE=kv` is the default. The current Worker binds the KV
namespace as `OTEL_PAYLOAD_KV`; `OTEL_OBJECTS` is optional. Workers Free provides
1 GB of KV storage, 1,000 writes/day, 100,000 reads/day, 1,000 deletes/day, and
a 25 MiB value limit. The export cap is 4 MB. A free-limit error fails the
operation and does not silently enable paid overage. Monitor read, write, delete,
and stored-data series separately in KV Analytics or the Cloudflare GraphQL API;
alert at 80,000 reads/day, 800 writes/day, 800 deletes/day, or 0.8 GiB stored
data, and page on confirmed quota-related Worker failures. A delete quota failure
does not prove that reads or writes are unavailable.

KV is eventually consistent. The first Queue delivery for a pointer to a KV
payload is delayed by 60 seconds, and bounded stale-read retries use
`KV_PAYLOAD_READ_RETRY_DELAYS_SECONDS`. Queue messages contain no raw payload;
they carry payload-store pointers:
schema-version-1 pointers always select R2, while schema-version-2 pointers
persist their backend identity. The `DEDUPLICATION_TOMBSTONE_MS` and
`PAYLOAD_RETENTION_FAILSAFE_MS` windows must both be considered before removing
the final dual binding.

### Initial KV deployment

Apply the source Queues, DLQs, and KV namespace, obtain the Terraform output, and
deploy the generated KV-only config:

```bash
terraform -chdir=terraform apply \
  -target=cloudflare_queue.otel \
  -target=cloudflare_queue.otel_dlq \
  -target=cloudflare_workers_kv_namespace.otel_payloads
OTEL_PAYLOAD_STORE=kv \
  OTEL_PAYLOAD_KV_NAMESPACE_ID="$(terraform -chdir=terraform output -raw otel_payload_kv_namespace_id)" \
  make deploy-otel-worker
make otel-worker-smoke
```

### R2 opt-in

Use R2 only after enabling the R2 subscription and granting R2 Storage Write:

```bash
OTEL_PAYLOAD_STORE=r2 \
  OTEL_PAYLOAD_KV_NAMESPACE_ID="$(terraform -chdir=terraform output -raw otel_payload_kv_namespace_id)" \
  make deploy-otel-worker
```

The renderer includes both `OTEL_PAYLOAD_KV` and `OTEL_OBJECTS`, so existing KV
pointers remain readable while new pointers use R2. Verify the selected backend
with the synthetic OTLP smoke test.

### R2-to-KV drain

Set `OTEL_PAYLOAD_STORE=kv OTEL_PAYLOAD_R2_DRAIN=true` and deploy the dual-binding
configuration:

```bash
OTEL_PAYLOAD_STORE=kv \
  OTEL_PAYLOAD_R2_DRAIN=true \
  OTEL_PAYLOAD_KV_NAMESPACE_ID="$(terraform -chdir=terraform output -raw otel_payload_kv_namespace_id)" \
  make deploy-otel-worker
cd workers && npm run test:otel:kv-r2-drain
```

Verify that new payloads use KV while schema-version-1 and schema-version-2 R2
pointers both read and delete through R2. Replay every recoverable R2 pointer
from its matching source Queue when draining a DLQ. Keep the dual binding until
source Queues are empty and at least
`DEDUPLICATION_TOMBSTONE_MS + PAYLOAD_RETENTION_FAILSAFE_MS` has elapsed since the
final R2 write. Keep it through the configured 24-hour DLQ retention for entries
that are intentionally not replayed. Do not delete the R2 bucket during a
normal rollback.

### KV quota or delete incident

Select R2 for new writes only when Cloudflare confirms a quota error or a
threshold forecasts exhaustion before the next 00:00 UTC reset. Deploy the
dual-binding R2 config and keep KV until old KV pointers complete or their
seven-day `expirationTtl` expires. For a transient non-quota delete failure,
keep the KV selector, alert and investigate, and rely on KV expiration as the
cleanup failsafe. The R2 lifecycle rule never cleans up KV payloads.

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
The Worker returns `200` after the redacted payload-store pointer and ingress
Queue handoff are durable. Queue and backend delivery are at-least-once; do not
treat the Grafana HTTP POST as exactly-once.

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
a payload-store pointer, not a raw OTLP payload. Preserve the pointer and its
ledger state during investigation. For R2-backed pointers, including
schema-version-1 pointers and schema-version-2 pointers retained during an R2
drain, confirm the R2 checksum and object retention before replaying them;
never edit the payload or construct a replacement pointer by hand.

Terminal Grafana responses and exhausted retries are deliberately left
visible to the matching DLQ. Network failures, timeouts, and `408`/`429`/`5xx`
responses remain retryable for up to three attempts. Confirmed completion is
recorded before the payload-store object is deleted. A response lost after bytes
may have been sent remains an explicit at-least-once outcome.

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
