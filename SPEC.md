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

| Component | Managed By | Responsibility |
| --------- | ---------- | -------------- |
| AI Gateway | Existing service | Proxies AI requests and generates access logs. |
| Logpush Job | Terraform (`terraform_data.aig_logpush_job` + Cloudflare API helper) | Fetches gateway logs and POSTs NDJSON to the Worker. |
| Transform Worker | Wrangler (`workers/src/index.ts`) | Validates ingress, decompresses, decrypts, transforms, and pushes to Loki. |
| Credentials | Wrangler secrets + `TF_VAR_*` env vars | Holds Grafana token, origin secret, and RSA private key. |
| Loki | Grafana Cloud managed | Stores transformed logs for 14 days. |
| Proxy Worker | Wrangler (`workers/src/proxy.ts`) | Validates X-Proxy-Secret, forwards to AI Gateway, and returns the upstream response. |
| Tail Worker | Paid-plan optional component | Not used in Free Tier proxy-only mode. |
| Ollama Cloud Worker | Wrangler (`workers/src/ollama-cloud.ts`) | Derives reset metrics from a strict ISO 8601 anchor and pushes OTLP metrics. |
| Ollama Cloud alerts | Grafana Alerting API (`grafana/alerts/`) | Fires session/weekly reset alerts from Prometheus metrics. |
| Dashboard | `grafana/dashboards/graft-ai-overview.json` | 13-panel Grafana dashboard imported via gcx API. |
| Ollama dashboard | `grafana/dashboards/graft-ai-ollama-cloud.json` | Ollama Cloud reset metrics dashboard imported via gcx API. |
| Grafana Access Policy | Terraform (`terraform/grafana/`) or manual | Cloud Access Policy with `logs:write`, `metrics:write`, and `traces:write` scopes for OTel and Loki/Prometheus delivery. |

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
