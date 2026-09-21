# Provider Metrics

The provider-metrics Worker collects account- or session-level usage information from supported AI providers and pushes normalized metrics to the configured Prometheus-compatible backend.

## Supported Providers

The current implementation includes collectors for:

- OpenAI API
- Codex
- OpenCodeGo
- Ollama Cloud
- CommandCode

Each provider is independent. If credentials for one provider are absent, that provider is skipped without preventing the other configured providers from running.

## Execution

`workers/wrangler.provider-metrics.jsonc` configures the Worker with a once-per-minute Cron trigger:

```text
* * * * *
```

The Worker also exposes a `fetch` handler that runs the same collection flow and returns a JSON diagnostic report. Treat that endpoint as an operational diagnostic surface rather than a public API contract.

## Configuration

The concrete Worker shape is defined in `workers/wrangler.provider-metrics.jsonc`. Secrets and provider-specific credentials must not be committed to the repository.

Important configuration includes:

- `OPENAI_API_HISTORY_DAYS` — OpenAI history window. The default is `1`; valid configured values are integers from 1 through 31.
- OpenAI admin API credentials for OpenAI usage/cost collection.
- Codex access credentials and optional account/proxy configuration.
- OpenCodeGo session credentials and optional workspace selection.
- Ollama Cloud session credentials.
- Prometheus/Grafana Cloud endpoint credentials used by the metrics push path.
- `MYBROWSER` binding used by provider flows that require browser rendering.

For the complete variable and secret names, use the Worker environment types and repository configuration examples as the machine-usable source of truth. See [Configuration](configuration.md).

## Credentials and Source Ownership

The provider registry checks the primary credential for each provider. A provider with no non-empty primary credential is `skipped`; an enrichment or fallback credential by itself does not start that provider.

### Primary credentials

| Provider | Primary credential | Primary source ID | Support level |
| --- | --- | --- | --- |
| OpenAI API | `OPENAI_ADMIN_API_KEY` | `openai-organization-api` | `official-public` |
| Codex | `CODEX_ACCESS_TOKEN` | `codex-wham-usage` | `official-internal` |
| OpenCode Go | `OPENCODEGO_API_KEY` | `opencodego-usage-api` | `official-internal` |
| Ollama Cloud | `OLLAMA_API_KEY` | `ollama-api-usage` | `official-internal` |
| CommandCode | `COMMAND_CODE_API_KEY` | `commandcode-billing-credits` | `official-internal` |

### Fallback and enrichment credentials

- `OPENCODEGO_SESSION_COOKIE` enables optional Zen balance enrichment through `opencodego-zen-rpc`. `OPENCODEGO_WORKSPACE_ID` is an optional workspace override for that RPC; otherwise the workspace is discovered. These values do not replace `OPENCODEGO_API_KEY`.
- `OLLAMA_SESSION_COOKIE` enables settings-page enrichment after a successful API scrape and HTML fallback after a recoverable API request failure. It does not replace `OLLAMA_API_KEY`.
- `MYBROWSER` is the Cloudflare Browser Rendering binding used by the Codex fallback. It is not a credential and does not replace `CODEX_ACCESS_TOKEN`.
- Codex also accepts optional `CODEX_ACCOUNT_ID`, `CODEX_PROXY_URL`, `CODEX_PROXY_SECRET`, and `CODEX_API_BASE_URL` settings. The configured proxy secret is forwarded through both the primary and browser paths.
- `OPENAI_API_HISTORY_DAYS` is configuration, not a credential. It defaults to `1` and accepts integer values from `1` through `31`.

### Source IDs and support levels

Source IDs are fixed endpoint ownership identifiers. They are not inferred from an error message. Support levels are `official-public`, `official-internal`, `web-internal`, and `scraping`; source roles are `primary`, `enrichment`, and `fallback`.

| Provider path | Source ID | Role | Support level |
| --- | --- | --- | --- |
| OpenAI organization API | `openai-organization-api` | `primary` | `official-public` |
| Codex WHAM usage | `codex-wham-usage` | `primary` | `official-internal` |
| Codex Browser Rendering | `codex-browser-rendering` | `fallback` | `web-internal` |
| OpenCode Go usage API | `opencodego-usage-api` | `primary` | `official-internal` |
| OpenCode Go Zen RPC | `opencodego-zen-rpc` | `enrichment` | `web-internal` |
| Ollama usage API | `ollama-api-usage` | `primary` | `official-internal` |
| Ollama settings HTML | `ollama-settings-html` | `enrichment` or `fallback` | `scraping` |
| CommandCode whoami prerequisite | `commandcode-whoami` | internal prerequisite | `official-internal` |
| CommandCode billing credits | `commandcode-billing-credits` | `primary` | `official-internal` |
| CommandCode billing subscriptions | `commandcode-billing-subscriptions` | `enrichment` | `official-internal` |
| CommandCode usage summary | `commandcode-usage-summary` | `enrichment` | `official-internal` |

`commandcode-whoami` resolves the organization required by the other CommandCode endpoints. It owns failures but is intentionally not included in the successful result's `sources` list.

## Metrics

The Worker emits the following exact OTLP gauge names. Quota metrics use a `period` label. Provider-specific labels are shown where applicable.

### OpenAI API

- `openai_api_cost_usd{line_item="<line_item>"}`
- `openai_api_input_tokens{model="<model>"}`
- `openai_api_output_tokens{model="<model>"}`
- `openai_api_cached_tokens{model="<model>"}`
- `openai_api_requests{model="<model>"}`

### Codex

- `codex_usage_ratio{period="<period>"}`
- `codex_reset_timestamp_seconds{period="<period>"}`
- `codex_credits_remaining`
- `codex_reset_credits`
- `codex_reset_credits_available_count`
- `codex_plan_info{plan="<plan>"}`

### OpenCode Go

- `opencodego_usage_ratio{period="<period>"}`
- `opencodego_reset_timestamp_seconds{period="<period>"}`
- `opencodego_reset_seconds_remaining{period="<period>"}`
- `opencodego_zen_balance_usd`

For OpenCode Go, normal or available statuses map to `exceeded = false`. `rate-limited` and `exhausted` map to `exceeded = true` only when `percent` is exactly `100`; any other percentage for those statuses is a schema failure.

### Ollama Cloud

- `ollama_cloud_usage_ratio{period="<period>"}`
- `ollama_cloud_reset_timestamp_seconds{period="<period>"}`
- `ollama_cloud_plan_info{plan="<plan>"}`
- `ollama_cloud_model_requests{period="<period>",model="<model>"}`
- `ollama_cloud_activity_cost_usd`

`ollama_cloud_model_requests` keeps `session` and `weekly` series separate and aggregates duplicate entries only for the exact `(period, model)` pair. Invalid model labels are omitted rather than normalized.

### CommandCode

- `commandcode_usage_ratio{period="<period>"}`
- `commandcode_reset_timestamp_seconds{period="<period>"}`
- `commandcode_credits_remaining`
- `commandcode_credits_monthly`
- `commandcode_credits_purchased`
- `commandcode_credits_free`
- `commandcode_plan_info{plan="<plan>"}`
- `commandcode_subscription_info{plan="<plan>",status="<status>"}`
- `commandcode_billing_period_end_seconds`
- `commandcode_usage_cost_usd`
- `commandcode_usage_requests`
- `commandcode_usage_tokens`

### Scrape health

- `provider_metrics_scrape_success{provider="<provider>"}`
- `provider_metrics_scrape_duration_seconds{provider="<provider>"}`
- `provider_metrics_scrape_timestamp_seconds{provider="<provider>"}`

## Failure Behavior

Provider collection is isolated per provider. A failed provider fetch is recorded in the diagnostic report while other configured providers continue.

An attempted provider always contributes scrape health. The push contains provider data and health metrics in the same OTLP payload. Therefore, the Worker pushes a health-only payload when all attempted providers fail or when an attempted provider is empty. If every provider is skipped, no push request is made. Push failures are reported separately from provider-fetch failures.

Authentication failures and provider-specific retry behavior are implementation contracts owned by the provider modules under `workers/src/provider-metrics/`; do not duplicate those contracts in deployment documentation.

## Health Semantics and Push Conditions

The diagnostic report preserves `skipped`, `success`, `empty`, and `failed` for each provider.

| Provider status | Meaning | `provider_metrics_scrape_success` | Duration | Timestamp |
| --- | --- | --- | --- | --- |
| `skipped` | The primary credential or valid preflight configuration was absent. No adapter ran. | Not emitted | Not emitted | Not emitted |
| `success` | Usable provider data was returned. | `1` | Emitted | Emitted |
| `empty` | The request was valid but no supported window or activity was available. | `1` | Emitted | Emitted |
| `failed` | The adapter could not produce a valid result because of transport, HTTP, schema, parse, or internal failure. | `0` | Emitted | Not emitted |

Health-only behavior is intentional:

- If at least one provider was attempted, `pushProviderMetrics` sends one OTLP payload even when the data-result list is empty.
- When all attempted providers fail, the payload contains `provider_metrics_scrape_success` and `provider_metrics_scrape_duration_seconds` for each attempted provider, with no provider data metrics.
- When an attempted provider is empty, its health success and completion timestamp are still sent even if it contributes no provider data metrics.
- When all providers are skipped, the orchestrator returns without calling the Prometheus endpoint; no push request is made.

## Fallback and Enrichment Precedence

### Ollama API and settings HTML

The Ollama API result is always primary when it succeeds:

1. On API success, the adapter keeps API quota windows, `ollama_cloud_model_requests`, and `ollama_cloud_activity_cost_usd`. If `OLLAMA_SESSION_COOKIE` is present, the settings HTML request may add missing reset timestamps or the plan. The `ollama-settings-html` source is marked `enrichment` only when it adds a field. A settings request failure leaves the successful API result unchanged.
2. On a recoverable API request failure (`auth`, `forbidden`, `upstream_4xx`, `rate_limit`, `upstream_5xx`, `network`, or `timeout`), the adapter may use `OLLAMA_SESSION_COOKIE` to request the settings HTML. A valid HTML contribution produces a successful fallback owned by `ollama-settings-html`; that fallback contains HTML windows and optional plan, but has no model-request or activity-cost data.
3. If the HTML request fails or contributes no valid window or plan, the original API failure remains owned by `ollama-api-usage`.
4. API `empty`, `schema`, `parse`, and `internal` outcomes do not enter the HTML fallback path. A fatal API response is not converted into a successful fallback.

### Codex Browser Rendering ownership

Codex first owns the request through `codex-wham-usage`. Browser Rendering is attempted only when that primary endpoint returns HTTP `403` and `MYBROWSER` is available. A browser success is owned by `codex-browser-rendering` with role `fallback`; a browser transport, timeout, schema, or parse failure is also reported with that browser source ID and its final error category. If the binding is unavailable, the original primary `403` remains owned by `codex-wham-usage`.

## Verification

Use the Worker diagnostic handler or Worker logs to verify:

1. the expected providers are reported as `success` rather than `skipped` or `failed`;
2. the Prometheus push reports `success`; and
3. the expected provider metrics appear in the configured backend.

Dashboard and alert definitions are stored under `grafana/`.

## Related Sources

- `workers/wrangler.provider-metrics.jsonc` — Worker deployment configuration
- `workers/src/provider-metrics.ts` — orchestration and diagnostic report
- `workers/src/provider-metrics/` — provider collectors and Prometheus serialization
- `grafana/dashboards/graft-ai-provider-metrics.json` — provider metrics dashboard
- [Configuration](configuration.md) — human-readable configuration ownership
- [Operations](operations.md) — monitoring and recovery entry point
