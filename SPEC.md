<!-- markdownlint-disable MD013 -->

# graft-ai Specification

日本語版: [SPEC.ja.md](./SPEC.ja.md)

## 1. Purpose

Transform encrypted Cloudflare AI Gateway access logs into Loki JSON streams and
push them to Grafana Cloud Loki, while remaining within the Grafana Cloud Free
Tier limits (14-day retention, 10k active series, 50GB logs). Independently,
receive Cloudflare AI Gateway OTLP telemetry through a private Tunnel and export
redaction-safe traces, payload logs, and request metrics to configured Tempo,
Loki, and Prometheus backends.

> **Note:** Ollama Cloud rate-limit reset metrics and provider usage metrics are
> documented in this specification and implemented by the scheduled Workers below.

## 2. Subsystems

### Subsystem 1 — Cloudflare AI Gateway → Grafana Cloud Loki

#### 2.1 Goal

Receive encrypted AI Gateway access logs from Cloudflare Logpush in near real
time, transform them into Loki JSON streams, and push them to Grafana Cloud
Loki.

#### 2.2 Architecture

##### Logpush Mode

```text
[Client/App]
    ↓
[Cloudflare AI Gateway] ── logs ──→ [Cloudflare Logpush]
                                       ↓ encrypted, gzip-compressed NDJSON
[Cloudflare Workers (receive/decrypt/decompress)]
                                       ↓ NDJSON
[Cloudflare Workers (transform)]
                                       ↓ JSON streams
[Grafana Cloud Loki]
                                       ↓
[Grafana Cloud Dashboard]
```

##### Free Tier Proxy Mode

```text
[Client/App]
    ↓ X-Proxy-Secret header
[Cloudflare Workers - proxy.ts (graft-ai-aig-proxy)]
    ├─ validates X-Proxy-Secret
    ├─ forwards to Cloudflare AI Gateway (my-gateway)
    └─ returns the upstream response unchanged
```

#### 2.3 Components

| Component             | Managed By                                                           | Responsibility                                                                                                           |
| --------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| AI Gateway            | Existing service                                                     | Proxies AI requests and generates access logs.                                                                           |
| Logpush Job           | Terraform (`terraform_data.aig_logpush_job` + Cloudflare API helper) | Fetches gateway logs and POSTs NDJSON to the Worker.                                                                     |
| Transform Worker      | Wrangler (`workers/src/index.ts`)                                    | Validates ingress, decompresses, decrypts, transforms, and pushes to Loki.                                               |
| Credentials           | Wrangler secrets + `TF_VAR_*` env vars                               | Holds Grafana token, origin secret, and RSA private key.                                                                 |
| Loki                  | Grafana Cloud managed                                                | Stores transformed logs for 14 days.                                                                                     |
| Proxy Worker          | Wrangler (`workers/src/proxy.ts`)                                    | Validates X-Proxy-Secret, forwards to AI Gateway, and returns the upstream response.                                     |
| Tail Worker           | Paid-plan optional component                                         | Not used in Free Tier proxy-only mode.                                                                                   |
| Ollama Cloud Worker   | Wrangler (`workers/src/ollama-cloud.ts`)                             | Derives reset metrics from a strict ISO 8601 anchor and pushes OTLP metrics.                                             |
| Ollama Cloud alerts   | Grafana Alerting API (`grafana/alerts/`)                             | Fires session/weekly reset alerts from Prometheus metrics.                                                               |
| Dashboard             | `grafana/dashboards/graft-ai-overview.json`                          | 13-panel Grafana dashboard imported via gcx API.                                                                         |
| Ollama dashboard      | `grafana/dashboards/graft-ai-ollama-cloud.json`                      | Ollama Cloud reset metrics dashboard imported via gcx API.                                                               |
| Grafana Access Policy | Terraform (`terraform/grafana/`) or manual                           | Cloud Access Policy with `logs:write`, `metrics:write`, and `traces:write` scopes for OTel and Loki/Prometheus delivery. |

### Provider Metrics Worker (`graft-ai-provider-metrics`)

A scheduled Worker (cron `* * * * *`) that fetches usage metrics from Codex,
OpenAI API, and OpenCodeGo, and pushes them to Grafana Cloud Prometheus via
OTLP/v1 JSON.

**Providers:**

- **OpenAI API:** `GET /v1/organization/costs` +
  `GET /v1/organization/usage/completions` (Bearer Admin Key, daily window)
- The history window is controlled by `OPENAI_API_HISTORY_DAYS`; it defaults to
  `1` day when unset and accepts integer values from `1` through `31` days.
- The OpenAI fetch uses the default of `1` day when `OPENAI_API_HISTORY_DAYS` is
  unset. It is skipped only when the variable is explicitly set to an invalid
  value; other providers still execute.
- When the OpenAI response contains zero cost buckets and zero token buckets,
  the result is treated as empty and excluded from the push payload.
- **Codex:** `GET https://chatgpt.com/backend-api/wham/usage` (Bearer OAuth Access Token, optional custom base/proxy via `CODEX_PROXY_URL` or `CODEX_API_BASE_URL`)
  - At least one valid window (`primary_window` or `secondary_window`) is required. When `secondary_window` is absent or null (e.g. for single-window plans), its usage ratio and reset timestamp are omitted (`undefined`) to display as hyphens on Grafana dashboards rather than false 0% usage.
  - When direct requests receive HTTP 403 (Cloudflare WAF Turnstile challenge), the Worker can route through `CODEX_PROXY_URL` (e.g. residential proxy via Cloudflare Tunnel) or fallback to Cloudflare Browser Rendering.
- `GET .../wham/rate-limit-reset-credits` is a supplementary endpoint. When it
  fails, Codex usage metrics are still pushed; only `codex_reset_credits` and
  `codex_reset_credits_available_count` are omitted.
- **OpenCodeGo:** HTML scraping of `opencode.ai/workspace/{id}/go` and `_server` RPC (Session Cookie)
- OpenCodeGo rolling usage and rolling reset are required fields; the fetch
  fails when they are absent. Weekly and monthly windows are optional; their
  metrics are omitted when the response does not contain them. When subscription
  RPC returns null (e.g. pay-as-you-go workspaces), it falls back to the billing
  RPC endpoint.
- When `OPENCODEGO_WORKSPACE_ID` is unset, the workspace ID is auto-fetched from
  the OpenCodeGo `_server` endpoint before scraping the usage page.
- **Ollama Cloud:** HTML scraping of `ollama.com/settings` (Session Cookie)
- Extracts Plan tier (`Free`, `Pro`, `Max`), Session/Hourly usage percent,
  Weekly usage percent, and `data-time` ISO reset timestamps. When session or
  weekly blocks are absent, their metrics are omitted.

**Metrics pushed:**

- `openai_api_cost_usd{line_item}`, `openai_api_{input,output,cached}_tokens{model}`, `openai_api_requests{model}`
- `codex_usage_ratio{period}`, `codex_reset_timestamp_seconds{period}`, `codex_credits_remaining`, `codex_reset_credits`, `codex_reset_credits_available_count`, `codex_plan_info{plan}`
- `opencodego_usage_ratio{period}`, `opencodego_reset_seconds_remaining{period}`, `opencodego_zen_balance_usd`
- `ollama_cloud_usage_ratio{period}`, `ollama_cloud_reset_timestamp_seconds{period}`, `ollama_cloud_plan_info{plan}`

**Error handling:** Each provider fetch is independent; a single failure does
not prevent other metrics from being pushed. HTTP 401 and 403 responses are
treated as immediate failures (cookie/key expired) and are not retried. HTTP
429 and 5xx responses, as well as network failures, are retried up to three
attempts with exponential backoff. Other 4xx responses are not retried. When
all providers are skipped, misconfigured, or produce no metrics, the Worker
logs an error and exits without pushing.

### OpenTelemetry Pipeline

The custom Alloy distribution at `deploy/otel/alloy` owns the OTel trust
boundary and the complete downstream data flow. It accepts authenticated
OTLP/HTTP only on `/v1/traces`, rejects untrusted TCP peers, redacts
credentials before queue handoff, groups spans by trace, elects one request
span, and creates one deterministic sampling decision. Request RED metrics are
exported for every selected request span; sampled traces are exported as
payload-free Tempo metadata and redacted Loki JSON through independent bounded
queues.

The reference topology is `deploy/otel/docker-compose.yml`. It uses
digest-pinned images, publishes only Grafana to the host, and keeps Alloy and
all telemetry backends on the internal network. `make otel-validate` checks the
static topology and dashboard contract, while `make otel-smoke` sends a
synthetic OTLP request and verifies all three internal backend APIs.

Grafana Cloud export uses `deploy/otel/docker-compose.grafana-cloud.yml` as an
override. It replaces the three Alloy backend endpoints and requires external
`Authorization` headers through environment interpolation; credentials must
not be embedded in committed Compose files. The Grafana Cloud telemetry Access
Policy must include `logs:write`, `metrics:write`, and `traces:write`. Loki
Logpush and Tail Workers use a separate Access Policy limited to `logs:write`.
Dashboard and alert deployment replaces only the self-hosted datasource
references through the
`GRAFANA_OTEL_{PROMETHEUS,LOKI,TEMPO}_DATASOURCE_UID` environment variables;
when `GRAFANA_OTEL_DATASOURCE_UIDS_REQUIRED=true`, all three must be configured
before any Grafana API call. Expression datasource UID `-100` and unrelated
UIDs remain unchanged.

#### OTel Worker payload store

The dedicated Worker defaults to `OTEL_PAYLOAD_STORE=kv` and stores redacted
payloads in the `OTEL_PAYLOAD_KV` binding. `OTEL_OBJECTS` is an optional R2
binding, required only for `OTEL_PAYLOAD_STORE=r2` or an explicit
`OTEL_PAYLOAD_R2_DRAIN=true` deployment. Workers Free provides a 1 GB KV
storage allowance, 1,000 writes/day, 100,000 reads/day, 1,000 deletes/day, and
a 25 MiB value limit. The 4 MB export payload cap is below that value limit;
free-limit exhaustion fails the operation rather than enabling paid overage.

KV eventual consistency requires a 60-second first Queue delivery delay. New
Queue pointers use schema version 2 and persist `storageBackend`. Schema-version-1
pointers always read and delete through R2, and schema-version-2 R2 pointers
remain R2-backed during a KV/R2 drain regardless of the current write selector.

Cloudflare KV Analytics or the GraphQL API is the source of truth for four
independent monitoring dimensions: read operations, write operations, delete
operations, and stored data. Alert at 80,000 reads/day, 800 writes/day, 800
deletes/day, or 0.8 GiB stored data; page only on a confirmed quota-related
Worker failure. A delete quota failure does not prove that writes or reads are
unavailable. R2 selection is a manual response to confirmed quota exhaustion or
a forecast before the next 00:00 UTC reset, never an automatic reaction to one
transient delete error. R2 lifecycle rules apply only to R2 payloads and never
clean up KV payloads.

#### OTel signal contracts (design invariants)

The following invariants apply to both the dedicated OTel Worker and the legacy
Alloy/Tunnel reference stack. They were fixed by the OTel design review and must
not drift between implementations.

**Deterministic sampling:**

- The default sampling rate is 100%. An operator-configured decimal rate is
  validated to `0..1` and normalized to integer millionths without floating
  point: `rate_ppm = floor(rate * 1_000_000)` with range `0..1,000,000`.
- The decision uses SHA-256 of the UTF-8 concatenation
  `trace_id + "graft-ai-otel-v1"` (lowercase 32-hex trace ID). The first 8
  digest bytes are a big-endian unsigned integer `hash`; the trace is sampled
  iff `hash * 1_000_000 < rate_ppm * 2^64` with strict `<` and exact integer
  arithmetic. Never convert the 64-bit hash to a float. Sampling priority
  overrides are rejected; the same `trace_id`/`rate_ppm`/seed always yields the
  same decision.
- Tempo traces and Loki payloads share one trace-level decision; a sampled-out
  trace appears in neither backend. RED metrics are computed from selected
  request spans before sampling and are never reduced by payload sampling.
- Acceptance fixture (seed `graft-ai-otel-v1`): trace
  `00000000000000000000000000000001` -> SHA-256 prefix `f75a2b34049e94d6`
  (out at rate 0.5), trace `ffffffffffffffffffffffffffffffff` ->
  `1d4e75600b429028` (in at rate 0.5), trace
  `11111111111111111111111111111111` -> `db81a30e59fe0b64` (out at rate 0.5).
  Rate `0` samples none; rate `1` samples all.

**Fail-closed redaction:**

- Redaction runs before any exporter, debug log, durable store, or Queue
  handoff. It replaces Bearer/Basic/API-key credentials and explicit
  `secret`/`token`/`password`-like values in `gen_ai.prompt_json`,
  `gen_ai.completion_json`, `cf-aig-metadata`, and string attributes with
  `[REDACTED]`.
- A payload that fails JSON parsing or deterministic redaction is never stored
  raw; its payload attributes are dropped with `payload_dropped=true` and
  `payload_drop_reason="redaction_failure"`, while safe metadata is retained.

**Spanlogs / Loki payload logs:**

- Loki labels are strictly `model`, `status_code`, `env`, `gateway`;
  `trace_id`, `request_id`, `provider`, and payload content stay log fields.
- The serialized UTF-8 line cap is 262,144 bytes (256 KiB). Redaction runs
  first and size is measured after JSON escaping. On overflow, the truncation
  budget is split 50:50 between `prompt` and `completion` (100:0 when only one
  exists), cut at UTF-8 code-point boundaries with the `[TRUNCATED]` suffix
  inside the budget, preserving identity/numeric fields and setting
  `payload_truncated=true`. If metadata alone exceeds the cap, payload fields
  are dropped with reason `line_size`; if the record is still oversized it is
  dropped and only `otel_spanlogs_dropped_total{reason="line_size_metadata"}`
  is incremented. Drop logs never contain trace IDs, URLs, or payload data.
- Token and cost fields (`input_tokens`, `output_tokens`, `total_tokens`,
  `cost_usd`, `duration_ms`) are unquoted finite decimal JSON numbers; NaN,
  Infinity, or unparseable values omit the field with reason
  `numeric_field_invalid`. Aggregate panels query Loki with `| json | unwrap`.

**Canonical RED metrics:**

- Only `ai_gateway_requests_total`, `ai_gateway_errors_total`, and
  `ai_gateway_request_duration_seconds` exist, with labels `model`, `provider`,
  `status_code`, `env`, `gateway`. The duration histogram buckets are
  `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, +Inf]` seconds.
- Exactly one request span is elected per trace to generate RED metrics. A span
  is a request candidate if either:
  1. It is a Cloudflare AI Gateway root span (`name == "cf.aig.request"` with no
     parent span ID, regardless of `span.kind`), or
  2. Its `span.kind` is `server` and it is either a root span (no parent span
     ID) or carries a non-empty `request_id`.
  Among candidates in a trace, the earliest `start_time_unix_nano` wins, with
  lexicographically lowest `span_id` as the deterministic tie-breaker.

**Ingress limits and rate limiting:**

- Receiver limits: 8 MiB body, 5 s header / 30 s read / 10 s write timeouts,
  100 concurrent requests, and a 1,000-item drop-new ingress queue. A full
  queue drops only the new item with fixed reason `capacity` while the client
  still receives `200`; backend status is never returned to the sender.
- Source rate limiting: token bucket capacity 20, refill 2/s (120 requests/min).
  The bucket key is
  `HMAC-SHA-256(OTEL_RATE_LIMIT_HMAC_KEY, "otel-ingress-source-v1" || NUL || canonical_ip)`;
  raw IPs are never persisted or used as labels. Client-supplied forwarding
  headers are always ignored; only the Cloudflare-edge `CF-Connecting-IP` on
  the trusted path (Worker: always trusted; Alloy: only peers in
  `OTEL_TRUSTED_PROXY_CIDRS`, others rejected `403` with `untrusted_source`)
  identifies a source; unknown sources share the `unknown` bucket. `429`
  responses carry `Retry-After` as ASCII decimal delta-seconds, rounded up and
  at least 1.
- Ingress operational metrics are fixed:
  `otel_ingress_requests_total{status}`,
  `otel_ingress_rejections_total{reason}` with reason enum `auth`,
  `untrusted_source`, `path`, `parse`, `content_type`, `compression`,
  `body_size`, `timeout`, plus `otel_ingress_rate_limited_total`,
  `otel_ingress_queue_dropped_total{reason="capacity"}`,
  `otel_ingress_active_requests`, `otel_ingress_request_bytes`, and
  `otel_ingress_queue_items`/`otel_ingress_queue_capacity{queue="dispatcher"}`.
  Source IPs, tokens, prompt/completion text are never labels. Rejection
  statuses are fixed: `401` auth, `403` untrusted source, `404` path, `400`
  parse, `415` content type or compression, `413` body size, `408` handler
  timeout, `429` rate limited.

**Alloy reference backend dispatch:**

- Retryable failures are network errors, `408`, `429`, and `5xx`; other `4xx`
  responses are terminal. Each backend gets 3 total attempts with 10 s
  per-attempt timeout and
  `delay = min(base * 2^retry_index * uniform(0.8, 1.2), 5s)` (Tempo bases 1s/2s;
  Loki and Prometheus 500ms/1s).
- Bounded in-memory queues: Tempo 64 MiB or 2,000 spans; Loki 64 MiB or 500
  records; Prometheus 16 MiB or 100 batches (a batch closes at 200 data points
  or 1 s). Eviction order: Tempo drops the oldest complete trace (else oldest
  item); Loki drops the lowest-priority record (priority: metrics 3 > trace
  metadata 2 > payload 1), then oldest; Prometheus drops the oldest batch.
- Drop reasons are the fixed enum `queue_capacity`, `retry_exhausted`,
  `line_size_metadata`, `numeric_field_invalid`, `shutdown_loss`, and
  `trace_state_evicted`. Operational metrics:
  `otel_backend_export_retries_total{backend}`,
  `otel_backend_export_failures_total{backend,status_class}`,
  `otel_backend_export_exhausted_total{backend}`,
  `otel_backend_queue_dropped_total{backend,signal,reason}`, plus queue
  utilization/age gauges. Backend failure logs may only contain `backend`,
  `status_class`, `attempt`, `reason`, `queue_items`, `queue_capacity`.
- Alerts: export-exhausted or queue-drops above zero for 5 minutes are
  critical; queue utilization over 0.80 for 5 minutes and any rate-limited
  request within 5 minutes are warnings.

**Retention gate (Alloy reference):**

- Self-hosted baseline retention is Tempo 14d, Loki 7d, Prometheus 14d via
  explicit Compose settings. Grafana Cloud payload-log export is enabled only
  when the effective Cloud Logs retention resolves to a supported positive
  duration of at most 14 days; otherwise export is disabled with the fixed
  sanitized reason `retention_unavailable`, `retention_lookup_failed`,
  `retention_invalid`, or `retention_exceeds_14d`. Never assume a Cloud default
  of 7 or 30 days; record the tenant's effective values at acceptance.

**OTel Worker durability and identity:**

- Queue semantics are at-least-once: every ingress and export record has a
  stable ID, Durable Object idempotency, and a `DEDUPLICATION_TOMBSTONE_MS` of
  25 hours. Exactly-once delivery is never claimed.
- Durable Object aggregation parameters: the trace aggregate flushes trace
  state after a one-second idle alarm; the metrics aggregate flushes cumulative
  sample windows every 30 seconds or 200 samples, whichever comes first, while
  retaining each series' first start time. Serialized metrics state is capped at
  1,500,000 UTF-8 bytes to stay below the SQLite-backed Durable Object 2 MiB
  value limit. The aggregate stores each series' start time on its sample and
  keeps only compact metadata for the last flush. If the cumulative payload or
  state would exceed its cap, it rolls over to the current flush window and
  resets that window's cumulative start time. If the current window alone is
  too large, `/append` returns HTTP 413 with `metrics_window_too_large` and
  enqueues nothing rather than dropping samples; an alarm reports the same
  failure after leaving the concurrency gate.
- Before envelope serialization, object keys inside JSON-encoded string
  payload attributes are recursively sorted in lexical order while array order
  is preserved. This canonicalization makes equivalent payloads produce the
  same canonical envelope bytes, `ingressId`, and `payloadSha256`.
- `ingressId = SHA-256("graft-ai-otel-ingress-v1" || NUL || canonical_redacted_envelope_bytes)`;
  a matching ID with the same payload hash is an accepted duplicate, while an
  existing ID with a different hash is a collision that fails without mutating
  the original record. AI Gateway delivery IDs (`cf-aig-otel-trace-id`, span
  IDs, request IDs) are never ingress IDs.
- All OTLP payloads are JSON (`application/json`); each exported document is
  capped at 4,000,000 UTF-8 bytes (below the documented 5 MB Cloud ingestion
  limit). No protobuf runtime dependency exists on the Worker path.
- Terraform owns Queues, DLQs, KV namespaces, and optional R2 resources;
  Wrangler owns Queue consumers and Durable Object bindings. Do not add
  `cloudflare_queue_consumer` Terraform resources.

### Ollama Cloud Worker (`graft-ai-ollama-cloud`)

A scheduled Worker (cron `* * * * *`) derives session and weekly rate-limit
reset metrics from a configured ISO 8601 anchor and documented reset intervals.
It does not scrape the Ollama Cloud dashboard or attempt to infer actual usage.
The resulting metrics are pushed to Grafana Cloud Prometheus via OTLP/v1 JSON.

**Configuration:**

- `OLLAMA_CLOUD_RESET_ANCHOR_ISO` is required and must be a strict ISO 8601
  timestamp with timezone information.
- `OLLAMA_CLOUD_SESSION_INTERVAL_SECONDS` defaults to `18000` (5 hours).
- `OLLAMA_CLOUD_WEEKLY_INTERVAL_SECONDS` defaults to `604800` (7 days).
- `OLLAMA_CLOUD_PLAN` is optional and defaults to `unknown`.
- `GRAFANA_CLOUD_PROMETHEUS_URL`,
  `GRAFANA_CLOUD_PROMETHEUS_USERNAME`, and
  `GRAFANA_CLOUD_ACCESS_POLICY_TOKEN` are required for metric delivery. The
  token must include the `metrics:write` scope and must be separate from a
  Loki-only token with the `logs:write` scope.

**Calculation:** For each period, let `elapsed = now - anchor` and
`remainder = ((elapsed % interval) + interval) % interval`. The Worker emits
`progress_ratio = remainder / interval`,
`remaining_seconds = interval - remainder`, and
`next_reset_timestamp = now + remaining_seconds`. The normalized modulo keeps
the result valid when the scheduled time precedes the anchor.

**Metrics pushed:**

- `ollama_cloud_reset_seconds_remaining{period}`
- `ollama_cloud_reset_timestamp_seconds{period}`
- `ollama_cloud_reset_progress_ratio{period}`
- `ollama_cloud_plan_info{plan,session_interval,weekly_interval}`

**Error handling:** Missing or invalid anchor/interval configuration is logged
and the scheduled invocation exits without pushing metrics. Prometheus 429 and
5xx responses, as well as network failures, are retried up to three attempts
with exponential backoff. Other 4xx responses are not retried.

**Alerts:** Grafana alert rules (`grafana/alerts/graft-ai-ollama-cloud-rules.json`)
fire when `ollama_cloud_reset_seconds_remaining{period="session"} < 3600` (1 hour
before session reset) and when
`ollama_cloud_reset_seconds_remaining{period="weekly"} < 86400` (24 hours before
weekly reset).

#### 2.4 Data Transformation Rules

1. **Timestamp and Encryption**
   - Incoming payload is gzip-compressed NDJSON. Each encrypted field uses
     hybrid encryption: an AES-GCM key is wrapped with RSA-OAEP-SHA256, and the
     payload is encrypted with AES-GCM. The Worker imports the PKCS#8 RSA
     private key (`env.RSA_PRIVATE_KEY_PEM`) to unwrap and decrypt.
   - `RequestTime` is seconds when ≤10 digits, milliseconds when 11–13 digits.
   - Converted to nanoseconds for Loki.
   - Values ≥14 digits are treated as precision-lost and the log line is
     skipped.

2. **Labels**
   - Strictly four: `model`, `status_code`, `env`, `gateway`.
   - `model` is normalized by stripping the `@cf/<scope>/` prefix.

3. **Log Line Fields**
   - Always included: `request_id`, `cache_status`, `prompt_tokens`,
     `completion_tokens`, `total_tokens`, `duration_ms`, `path`, `method`.
   - Optionally included only when explicitly enabled via
     `env.INCLUDE_REQUEST_BODY`, `env.INCLUDE_RESPONSE_BODY`,
     `env.INCLUDE_METADATA`: decrypted `request_body`, `response_body`,
     `metadata`. These are opt-in because they may contain prompts, response
     bodies, or other sensitive data.
   - Headers, user IPs, auth tokens, and raw prompts/response bodies are
     excluded by default.
   - The Worker does not automatically redact body or metadata content when an
     `INCLUDE_*` flag is enabled. Treat enabled content as potentially containing
     PII or credentials, sanitize it before delivery, and keep the flag disabled
     when deterministic redaction is unavailable. Retain Loki data for no more
     than 14 days and restrict access to least-privilege Grafana users/teams and
     a token limited to the `logs:write` scope.

#### 2.5 Reliability and Error Handling

| Failure Point                   | Behavior                                                                   |
| ------------------------------- | -------------------------------------------------------------------------- |
| Missing/wrong `X-Origin-Secret` | Return `401`; no Logpush retry.                                            |
| Malformed gzip body             | Return `400`; no Logpush retry.                                            |
| Invalid RSA private key         | Return `400`; no Logpush retry.                                            |
| Unparseable NDJSON line         | Skip line and continue; other lines are processed.                         |
| Loki 429                        | Retry up to 3 times with exponential backoff; final failure returns `503`. |
| Loki 5xx                        | Retry up to 3 times with exponential backoff; final failure returns `503`. |
| Loki network failure (status 0) | Fetch fails; Loki handler returns status 0; Worker maps to `503`.          |
| Loki 4xx (non-429)              | Return `400`; no Logpush retry.                                            |

#### 2.6 Security

- HTTPS only for Logpush → Worker and Worker → Loki.
- HTTPS only for scheduled Workers → Grafana Cloud Prometheus.
- Loki push uses HTTP Basic Auth: username = Grafana Cloud Loki tenant ID,
  password = Access Policy Token with `logs:write` scope.
- Secrets are never committed or stored in `*.tfvars`. Use environment variables
  or Wrangler secrets.
- Terraform state uses encrypted Terraform Cloud workspaces.

#### 2.7 Testing and Validation

- Unit tests for crypto, transform, and Loki modules
  (`@cloudflare/vitest-pool-workers`).
- Integration test for the full Worker fetch handler.
- CI checks: `terraform fmt`, `terraform validate`, TypeScript type check,
  Vitest run.
- Test fixtures are in `tests/fixtures/sample_aigateway_log.json` covering
  200/400/500 status codes, cache hit/miss, and two model names.

## 3. Global Constraints

- Workers implementation language: TypeScript.
- Terraform provider: `cloudflare/cloudflare` v5.x.
- Terraform provider (optional): `grafana/grafana ~> 3.0` for managing Grafana Cloud Access Policy and token.
- Worker deployment via Wrangler; Terraform manages only the Logpush job (and optionally Grafana Access Policy).
- Free Tier proxy mode requires no Terraform; deploy via `scripts/setup-free-tier.sh` or the manual Wrangler commands.
- OTel telemetry is independent of Logpush and proxy routing; its credentials are supplied through secret files or environment variables and never embedded in URLs, dashboards, or tracked configuration.
- OTel receiver limits are 8 MiB body size, 5s header timeout, 30s read timeout, 10s write timeout, 100 concurrent requests, and a 1,000-item drop-new ingress queue.
- OTel Loki labels are limited to `model`, `status_code`, `env`, and `gateway`; trace IDs remain log fields and are not labels.
- Cloud Access Policy with `logs:write` scope is required for Loki push. Service Account tokens do **not** work for Loki push.
- Grafana Cloud Free Tier limits apply.

## 4. Operational Notes

- Verify the Logpush dataset name and field names via the Cloudflare API before
  applying Terraform.
- Upload the RSA public key to the AI Gateway Logpush settings; the private key
  is used by the Worker.
- Authenticate the configured encrypted Terraform Cloud workspaces before applying changes.
- **Monitoring checklist:** Workers Analytics for exceptions and subrequest
  errors; Logpush `last_delivery` status via Terraform output or the Cloudflare
  dashboard; Grafana Cloud **Logs Usage** dashboard; weekly comparison of actual
  log volume against the design estimate (~0.5–1.5 KB per transformed request).
- **Quota estimate:** Transformed logs are ~0.5–1.5 KB per request vs. ~3–8 KB
  raw. At 100k requests/day, expect roughly 1.5–4.5 GB/month, which fits within
  the Grafana Cloud Free Tier 50 GB/month logs allowance.
- **Grafana dashboard URL:** `https://{stack}.grafana.net/d/graft-ai-aig-overview`
  (import the dashboard separately for Logpush mode).
- **AI Gateway ID vs. GATEWAY_NAME:** `AI_GATEWAY_ID` must match the actual
  gateway slug used in the Cloudflare AI Gateway URL path (e.g., `my-gateway`);
  it must be set in `workers/wrangler.proxy.jsonc` before proxy deployment.
  `GATEWAY_NAME` is a separate Loki label value and does not need to match the
  gateway slug.
- **Cloud Access Policy UI:** The Access Policy is created inside the Grafana
  instance at `https://{stack}.grafana.net/admin/access-policies`
  (Administration → Cloud access policies), **not** on the grafana.com portal.
  Grafana Cloud API Keys are deprecated; Service Account tokens cannot push to
  Loki. Use a Cloud Access Policy token with `logs:write` scope.
- **Diagnosing 100% error rate / 429s:** If Loki shows `model="unknown"` and
  `total_tokens=0` across all requests, the AI Gateway itself is very likely
  rejecting requests before the provider call — not a provider-side rate
  limit — because `cf-aig-model` / `cf-aig-tokens` response headers are only
  set once a model call actually happens. Check the gateway's own
  `rate_limiting_limit` / `rate_limiting_interval` via
  `GET /accounts/{account_id}/ai-gateway/gateways/{gateway_id}`; the default
  may be too restrictive for bursty or multi-client traffic (e.g., several
  concurrent AI agents sharing one gateway).
