# Grafana Cloud OTel Export Design

## Goal

Enable the existing OTel pipeline to export traces, logs, and metrics to
Grafana Cloud without removing or changing the self-hosted OTel reference
stack.

## Chosen approach

Keep the custom Alloy collector and its three independent backend queues. The
collector already emits OTLP protobuf for Tempo traces and Prometheus metrics,
and Loki JSON for payload logs. Add environment-driven endpoint and
Authorization overrides to the Compose reference deployment, while retaining
the current local endpoints as defaults.

Make Grafana dashboard and alert deployment apply explicit datasource UID
overrides at deployment time. The tracked dashboard and alert files continue
to use `otel-prometheus`, `otel-loki`, and `otel-tempo` as self-hosted defaults;
the Grafana Cloud workflow supplies all three Cloud UIDs. If Cloud deployment
is enabled without the three overrides, the deployment scripts fail before
calling Grafana's API.

Extend the Terraform-managed Cloud Access Policy from `logs:write` and
`metrics:write` to include `traces:write`. The same least-privilege token can
then authenticate the three telemetry ingestion paths. Grafana alert
provisioning remains separate and uses a Grafana Service Account token with
alert provisioning permissions.

## Data flow

```text
AI Gateway OTLP/HTTP
        |
        v
custom Alloy collector
  |                |                 |
  | OTLP protobuf  | Loki JSON       | OTLP protobuf
  v                v                 v
Cloud Tempo       Cloud Loki        Cloud Prometheus/Mimir
```

The local Compose defaults continue to send to `tempo`, `loki`, and
`prometheus` on the internal Docker network. Cloud mode changes only the
collector's backend URLs and Authorization headers; the ingress, redaction,
sampling, bounded queues, retries, and metric aggregation remain unchanged.

## Configuration contract

The following variables are optional in local mode and are read by the Alloy
process:

- `OTEL_TEMPO_URL`: complete trace ingestion URL.
- `OTEL_LOKI_URL`: complete Loki push URL.
- `OTEL_PROMETHEUS_URL`: complete metrics ingestion URL.
- `OTEL_TEMPO_AUTHORIZATION`, `OTEL_LOKI_AUTHORIZATION`, and
  `OTEL_PROMETHEUS_AUTHORIZATION`: complete `Authorization` header values.

Grafana Cloud URLs must be copied from the target stack's OpenTelemetry and
data source configuration. Signal-specific URL paths are part of the values;
the application does not append paths.

## Dashboard and alert deployment

The deployment scripts support these Cloud-only variables:

- `GRAFANA_OTEL_PROMETHEUS_DATASOURCE_UID`
- `GRAFANA_OTEL_LOKI_DATASOURCE_UID`
- `GRAFANA_OTEL_TEMPO_DATASOURCE_UID`
- `GRAFANA_OTEL_DATASOURCE_UIDS_REQUIRED=true`

When the required flag is enabled, all three UID variables must be non-empty.
Only exact self-hosted OTel UIDs are replaced, and expression datasource UIDs
such as `-100` are preserved. Source JSON files are never rewritten on disk.

## Security and compatibility

- No credentials are stored in tracked files, dashboard JSON, Terraform
  variables, or URLs.
- The Cloud Access Policy token is used only for telemetry ingestion. The
  dashboard/alert API uses the existing Service Account token path.
- Self-hosted deployments remain compatible when the Cloud variables are
  absent.
- Cloud log payload export remains subject to the existing positive retention
  value of 14 days or less.

## Verification

Automated coverage will verify endpoint substitution defaults, Authorization
header propagation, datasource UID replacement in dashboard and alert payloads,
Cloud-mode preflight failures, Terraform syntax, Compose interpolation, and
the existing OTel contract suite. Live ingestion requires the operator to run
a synthetic trace against the configured Cloud endpoints and confirm all three
Cloud backends receive data.
