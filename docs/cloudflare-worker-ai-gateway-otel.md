# Cloudflare Worker AI Gateway OTel Runbook

This runbook describes the dedicated JSON-only OTel route:

```text
AI Gateway
  -> https://<worker>.workers.dev/v1/traces
  -> authenticated Worker
  -> redaction
  -> D1 redacted envelope (KV and R2 are available via configuration)
  -> ingress Queue
  -> Trace/Metrics Durable Objects
  -> backend Queues and DLQs
  -> Grafana Cloud Tempo, Loki, and Prometheus
```

The Worker is independent of the encrypted Logpush Worker in
`workers/src/index.ts`. The legacy Tunnel/Alloy route remains available as the
rollback path until the controlled observation window is complete.

## Cloudflare plan prerequisite

The dedicated Worker must run on a Cloudflare Workers Paid plan for production
AI Gateway OTel traffic. AI Gateway OTel spans include prompt and completion
attributes, so request bodies can be hundreds of kilobytes or larger. On the
Workers Free plan, the 10 ms HTTP CPU limit was reached by observed
388-815 KB requests and the Worker returned HTTP 503 with
`exceededCpu`. `limits: null` in the Worker settings does not raise the
account plan limit. Do not treat a successful small smoke request as proof
that production-sized OTel payloads are supported.

If a Paid plan is not available, keep the legacy Tunnel/Alloy route active and
do not route production OTel traffic to the dedicated Worker. Any upstream
payload-reduction option must be verified against the actual OTel export before
using it as a substitute for the plan requirement.

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
`otel_payload_kv_namespace_id` and `otel_payload_d1_database_id` from Terraform
outputs and replaces the KV namespace and D1 database ID sentinels with their
real IDs. The complete sequence is shown below.

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
Wrangler dry run. Terraform owns the four source Queues, four DLQs, the D1 database
(`graft-ai-aig-otel-payloads-v1`), and the Workers KV namespace. The R2 bucket
and its seven-day `otel/` lifecycle rule are retained for explicit R2 and drain
deployments. Wrangler owns Queue consumers and Durable Object exports.

Provision account resources before deploying the Worker:

```bash
terraform -chdir=terraform init
terraform -chdir=terraform apply \
  -target=cloudflare_queue.otel \
  -target=cloudflare_queue.otel_dlq \
  -target=cloudflare_workers_kv_namespace.otel_payloads \
  -target=cloudflare_d1_database.otel_payloads
make deploy-otel-worker
```

The production workflow performs the same order, reads the non-secret KV
namespace ID and D1 database ID from Terraform output, applies D1 migrations
(`cd workers && npx wrangler d1 migrations apply graft-ai-aig-otel-payloads-v1 --remote`),
runs `make render-otel-worker-config` to render `.wrangler/otel.generated.jsonc`,
synchronizes the seven secrets, and deploys that generated config. It does not
change the existing AI Gateway exporter configuration.

## Grafana Cloud dashboard datasource UIDs

The dashboard JSON keeps `otel-prometheus`, `otel-loki`, and `otel-tempo` as
self-hosted defaults. Before deploying to Grafana Cloud, set all three
production variables to the UIDs returned by `GET /api/datasources`:

```text
GRAFANA_OTEL_PROMETHEUS_DATASOURCE_UID
GRAFANA_OTEL_LOKI_DATASOURCE_UID
GRAFANA_OTEL_TEMPO_DATASOURCE_UID
```

Set `GRAFANA_OTEL_DATASOURCE_UIDS_REQUIRED=true` so a missing or partial Cloud
UID configuration fails before dashboard provisioning. The deployment helper
rewrites both panel and templating datasource references without changing the
repository's self-hosted defaults.

## Payload storage, quotas, and migration

`OTEL_PAYLOAD_STORE=d1` is the default. Cloudflare D1 provides 100,000
writes/day, 5,000,000 reads/day, 5 GB/account total storage, and a
500 MB/database limit, with zero credit card requirement on Workers Free. D1
is strongly consistent. For D1 pointers, the configured Queue `delaySeconds` is
0 seconds (no intentional delay), but Queue delivery remains asynchronous;
consumer scheduling, batch timeout, backlog, and retries mean actual immediate
delivery is not guaranteed. A daily Cron Trigger (`0 4 * * *` UTC) runs a
failsafe purge on expired records (`expires_at < unixepoch()`).

The Worker limits each D1 payload to `MAX_D1_PAYLOAD_BYTES = 1,900,000` bytes,
below D1's 2,000,000-byte maximum row size. This limit is separate from the
`MAX_GRAFANA_OTLP_BYTES = 4,000,000` export payload cap. An oversized D1
ingress payload returns HTTP 413 with `{"error":"payload_too_large"}` after its
reservation is released, and no Queue message is registered; a failed release
returns HTTP 503 instead. For a D1-backed export within the 4,000,000-byte
export cap but above 1,900,000 bytes, the D1 payload-store size guard rejects
the payload before the SQL write and before Queue enqueue. The ledger export
reservation is released and no Queue message is registered. Payloads above
4,000,000 bytes fail earlier at export validation.

Workers KV (`OTEL_PAYLOAD_STORE=kv`, the previous default) and Cloudflare R2
(`OTEL_PAYLOAD_STORE=r2`) remain available via explicit configuration. The
current Worker binds the KV namespace as `OTEL_PAYLOAD_KV`; `OTEL_OBJECTS` is
optional. Workers Free provides 1 GB of KV storage, 1,000 writes/day, 100,000
reads/day, 1,000 deletes/day, and a 25 MiB value limit. The export cap is 4 MB.
A free-limit error fails the operation and does not silently enable paid overage.
Monitor read, write, delete, and stored-data series separately in KV Analytics or
the Cloudflare GraphQL API; alert at 80,000 reads/day, 800 writes/day, 800
deletes/day, or 0.8 GiB stored data, and page on confirmed quota-related Worker
failures. A delete quota failure does not prove that reads or writes are
unavailable.

KV is eventually consistent. The first Queue delivery for a pointer to a KV
payload is delayed by 60 seconds, and bounded stale-read retries use
`KV_PAYLOAD_READ_RETRY_DELAYS_SECONDS`. Queue messages contain no raw payload;
they carry payload-store pointers:
schema-version-1 pointers always select R2, while schema-version-2 pointers
persist their backend identity (`"d1"`, `"kv"`, or `"r2"`). The
`DEDUPLICATION_TOMBSTONE_MS` and `PAYLOAD_RETENTION_FAILSAFE_MS` windows must
both be considered before removing the final dual binding.

### Initial D1 deployment (default)

Apply the source Queues, DLQs, KV namespace, and D1 database, apply D1
migrations, and deploy the generated D1 config:

```bash
terraform -chdir=terraform apply \
  -target=cloudflare_queue.otel \
  -target=cloudflare_queue.otel_dlq \
  -target=cloudflare_workers_kv_namespace.otel_payloads \
  -target=cloudflare_d1_database.otel_payloads
(cd workers && npx wrangler d1 migrations apply graft-ai-aig-otel-payloads-v1 --remote)
OTEL_PAYLOAD_STORE=d1 \
  OTEL_PAYLOAD_KV_NAMESPACE_ID="$(terraform -chdir=terraform output -raw otel_payload_kv_namespace_id)" \
  OTEL_PAYLOAD_D1_DATABASE_ID="$(terraform -chdir=terraform output -raw otel_payload_d1_database_id)" \
  make deploy-otel-worker
make otel-worker-smoke
```

Note that `make deploy-otel-worker` automatically provisions required
infrastructure and applies remote D1 migrations prior to deployment.

### Explicit KV deployment

To deploy using Workers KV:

```bash
OTEL_PAYLOAD_STORE=kv \
  OTEL_PAYLOAD_KV_NAMESPACE_ID="$(terraform -chdir=terraform output -raw otel_payload_kv_namespace_id)" \
  make deploy-otel-worker
make otel-worker-smoke
```

The smoke helper creates current-time span timestamps and a new trace/span ID
for every invocation. Fixed historical timestamps are rejected by Grafana
Cloud's retention window and fixed IDs can be treated as duplicates.

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
