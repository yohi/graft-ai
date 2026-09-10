# Provider Metrics

The provider-metrics Worker collects account- or session-level usage information from supported AI providers and pushes normalized metrics to the configured Prometheus-compatible backend.

## Supported Providers

The current implementation includes collectors for:

- OpenAI API
- Codex
- OpenCodeGo
- Ollama Cloud

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

## Failure Behavior

Provider collection is isolated per provider. A failed provider fetch is recorded in the diagnostic report while other configured providers continue.

Metrics are pushed only when at least one provider returns usable data. Push failures are reported separately from provider-fetch failures.

Authentication failures and provider-specific retry behavior are implementation contracts owned by the provider modules under `workers/src/provider-metrics/`; do not duplicate those contracts in deployment documentation.

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
