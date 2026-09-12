# Ollama Cloud Reset Metrics

This guide covers the scheduled Worker that publishes Ollama Cloud reset-window metrics.

## Purpose

The Worker does not estimate Ollama usage. It derives reset-window timing from a configured ISO 8601 anchor and fixed session/weekly intervals, then pushes those values to the configured Prometheus-compatible backend.

The Worker runs once per minute through the Cron trigger in `workers/wrangler.ollama.jsonc`.

## Configuration

Required anchor:

- `OLLAMA_CLOUD_RESET_ANCHOR_ISO` — an ISO 8601 timestamp with timezone information. Invalid or missing values cause the scheduled execution to log an error and stop without pushing metrics.

Optional settings:

- `OLLAMA_CLOUD_PLAN` — plan label; defaults to `unknown`.
- `OLLAMA_CLOUD_SESSION_INTERVAL_SECONDS` — positive integer; defaults to `18000` (5 hours).
- `OLLAMA_CLOUD_WEEKLY_INTERVAL_SECONDS` — positive integer; defaults to `604800` (7 days).

Metrics destination:

- `GRAFANA_CLOUD_PROMETHEUS_URL`
- `GRAFANA_CLOUD_PROMETHEUS_USERNAME`
- `GRAFANA_CLOUD_ACCESS_POLICY_TOKEN`

Keep credentials out of Git. The destination token must have the permissions required by the configured metrics endpoint.

See [Configuration](configuration.md) for configuration ownership.

## Calculation

For each interval, the Worker computes the reset position relative to the configured anchor and the scheduled execution time. It publishes the remaining seconds, next reset timestamp, progress ratio, and plan information for the session and weekly windows.

The calculation is deterministic for a given anchor, interval, and execution timestamp. Implementation and tests are under:

- `workers/src/ollama-cloud/calc.ts`
- `workers/tests/ollama-cloud/calc.test.ts`
- `workers/tests/ollama-cloud/scheduled.test.ts`

## Deployment

Install dependencies and deploy the dedicated Worker using the repository's existing Ollama deployment target/workflow.

Before deployment, verify:

1. the reset anchor is the intended real reset anchor;
2. session and weekly intervals are positive integers;
3. the Prometheus destination credentials are configured as secrets;
4. the Worker Cron trigger remains enabled.

The deployable Worker shape is canonical in `workers/wrangler.ollama.jsonc`.

## Verification

After deployment:

1. inspect Worker logs for configuration or push failures;
2. confirm scheduled invocations occur once per minute;
3. confirm session and weekly reset metrics appear in the configured Prometheus backend;
4. compare the next-reset timestamp against the configured anchor/interval before relying on dashboard alerts.

Dashboard and alert definitions live under `grafana/`.

## Failure Behavior

The Worker stops the current scheduled run without publishing when:

- the reset anchor is missing or invalid; or
- either interval cannot be parsed as a positive safe integer.

A failed metrics push is logged with the returned status. The next Cron execution retries naturally by running the calculation again; the Worker does not persist a retry queue.

## Related Documentation

- [Configuration](configuration.md)
- [Operations](operations.md)
- [Provider Metrics](provider-metrics.md)
