# Free Tier AI Gateway OTel Deployment

This runbook configures the Free Tier telemetry route:

```text
Cloudflare AI Gateway -> Cloudflare Tunnel -> Alloy -> Tempo/Loki/Prometheus
```

This route does not use Workers Logpush. Alloy is the authenticated trust
boundary and the only component that sends telemetry to the three backends. It
redacts credentials before exporting Tempo metadata, Loki request logs, and
Prometheus request metrics.

## Prerequisites

The host needs:

- Docker Engine with the Compose plugin.
- A Cloudflare managed Tunnel with a public hostname.
- `openssl` when self-hosted Grafana password generation is needed.
- An existing Cloudflare AI Gateway and its configured proxy Worker.
- A Grafana Cloud telemetry Access Policy with `logs:write`, `metrics:write`,
  and `traces:write`.

The Cloudflare Tunnel hostname must be configured with the service
`http://alloy:4318`. Do not publish an Alloy host port. The receiver accepts
authenticated OTLP/HTTP only at `POST /v1/traces`.

## Protected runtime files

`deploy/otel/secrets/` and `deploy/otel/.env.grafana-cloud` are ignored by
`.gitignore`. Never add their contents to Git, shell history, Compose YAML, or
the deployment summary. Create `deploy/otel/secrets/` with mode `0700`, and
create each secret file with mode `0600`. If an approved secret manager or
protected editor creates `deploy/otel/.env.grafana-cloud`, explicitly set and
verify its mode `0600` immediately afterward.

### Secret files

Create these files under `deploy/otel/secrets/`:

| File                     | Purpose                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `otel_ingest_token`      | Bearer token accepted by Alloy for `/v1/traces`.                                    |
| `otel_hmac_key`          | Alloy rate-limit HMAC key. It must differ from the ingest token.                    |
| `cloudflared_token`      | Managed Tunnel connector token.                                                     |
| `grafana_admin_password` | Fresh self-hosted Grafana password, only when the local Grafana service is started. |

Before writing any file, require `OTEL_INGEST_TOKEN`,
`OTEL_RATE_LIMIT_HMAC_KEY`, and `CLOUDFLARED_TUNNEL_TOKEN` to be non-empty and
require the ingest token and HMAC key to differ. The following preflight fails
without writing when a requirement is violated and does not print secret
values. Run it in the host shell with shell tracing disabled:

The required failure messages are `OTEL_INGEST_TOKEN must be set and non-empty`,
`OTEL_RATE_LIMIT_HMAC_KEY must be set and non-empty`, and
`CLOUDFLARED_TUNNEL_TOKEN must be set and non-empty`.

```bash
for required_name in \
  OTEL_INGEST_TOKEN \
  OTEL_RATE_LIMIT_HMAC_KEY \
  CLOUDFLARED_TUNNEL_TOKEN; do
  if [[ -z "${!required_name:-}" ]]; then
    printf '%s must be set and non-empty\n' "$required_name" >&2
    exit 1
  fi
done

if [[ "$OTEL_INGEST_TOKEN" == "$OTEL_RATE_LIMIT_HMAC_KEY" ]]; then
  printf '%s\n' \
    'OTEL_INGEST_TOKEN and OTEL_RATE_LIMIT_HMAC_KEY must differ' >&2
  exit 1
fi

set -euo pipefail
umask 077
install -d -m 700 deploy/otel/secrets
touch \
  deploy/otel/secrets/otel_ingest_token \
  deploy/otel/secrets/otel_hmac_key \
  deploy/otel/secrets/cloudflared_token
chmod 600 \
  deploy/otel/secrets/otel_ingest_token \
  deploy/otel/secrets/otel_hmac_key \
  deploy/otel/secrets/cloudflared_token
printf '%s' "$OTEL_INGEST_TOKEN" > deploy/otel/secrets/otel_ingest_token
printf '%s' "$OTEL_RATE_LIMIT_HMAC_KEY" > deploy/otel/secrets/otel_hmac_key
printf '%s' "$CLOUDFLARED_TUNNEL_TOKEN" > deploy/otel/secrets/cloudflared_token
for protected_path in \
  deploy/otel/secrets \
  deploy/otel/secrets/otel_ingest_token \
  deploy/otel/secrets/otel_hmac_key \
  deploy/otel/secrets/cloudflared_token; do
  if [[ "$protected_path" == deploy/otel/secrets ]]; then
    expected_mode=700
  else
    expected_mode=600
  fi
  chmod "$expected_mode" "$protected_path"
  [[ "$(stat -c '%a' "$protected_path")" == "$expected_mode" ]] || {
    printf 'unexpected permissions on %s\n' "$protected_path" >&2
    exit 1
  }
done
```

Create `deploy/otel/.env.grafana-cloud` through the host secret manager or a
protected editor. It must contain the seven non-file variables listed below.
Immediately after creation, explicitly restrict and verify its mode:

```bash
chmod 600 deploy/otel/.env.grafana-cloud
[[ "$(stat -c '%a' deploy/otel/.env.grafana-cloud)" == "600" ]] || {
  printf '%s\n' 'unexpected permissions on deploy/otel/.env.grafana-cloud' >&2
  exit 1
}
```

When self-hosted Grafana is also started, generate a fresh separate password.
Do not reuse an ingest, HMAC, or Tunnel token:

```bash
grafana_admin_password="$(openssl rand -base64 32)"
[[ -n "$grafana_admin_password" ]] || {
  printf '%s\n' 'failed to generate grafana_admin_password' >&2
  exit 1
}
touch deploy/otel/secrets/grafana_admin_password
chmod 600 deploy/otel/secrets/grafana_admin_password
printf '%s' "$grafana_admin_password" > deploy/otel/secrets/grafana_admin_password
[[ "$(stat -c '%a' deploy/otel/secrets/grafana_admin_password)" == "600" ]] || {
  printf '%s\n' 'unexpected permissions on grafana_admin_password' >&2
  exit 1
}
unset grafana_admin_password
```

## Grafana Cloud variables

Set the following values in `deploy/otel/.env.grafana-cloud`; keep
Authorization headers in this untracked file or in a protected secret manager:

- `OTEL_TEMPO_URL`
- `OTEL_TEMPO_AUTHORIZATION`
- `OTEL_LOKI_URL`
- `OTEL_LOKI_AUTHORIZATION`
- `OTEL_PROMETHEUS_URL`
- `OTEL_PROMETHEUS_AUTHORIZATION`
- `OTEL_GRAFANA_CLOUD_LOGS_RETENTION=14d`

Confirm the effective Grafana Cloud Logs retention before setting the last
value. Compose checks only that `OTEL_GRAFANA_CLOUD_LOGS_RETENTION` is
non-empty. Alloy is the authoritative retention gate: it enables Grafana
Cloud Loki payload logs only for a positive whole-number duration with exactly
one `d`, `h`, `m`, or `s` suffix and a value no greater than 14 days. Missing,
malformed, zero, composite, and excessive values keep payload-log export
disabled.

## Start the protected receiver

Start only Alloy and `cloudflared` in Cloud mode:

```bash
docker compose --env-file deploy/otel/.env.grafana-cloud \
  -f deploy/otel/docker-compose.yml \
  -f deploy/otel/docker-compose.grafana-cloud.yml \
  --profile tunnel up -d --build alloy cloudflared
```

Confirm both services are running without exposing an Alloy host port:

```bash
docker compose --env-file deploy/otel/.env.grafana-cloud \
  -f deploy/otel/docker-compose.yml \
  -f deploy/otel/docker-compose.grafana-cloud.yml \
  --profile tunnel ps alloy cloudflared
```

## Configure the single AI Gateway exporter

In Cloudflare Dashboard, open the target AI Gateway and edit the existing sole
OTel exporter. Do not add a second exporter. Use:

```text
URL: https://<otel-public-hostname>/v1/traces
Authorization: Bearer <OTEL_INGEST_TOKEN>
Content type: protobuf
```

Confirm the former direct `https://otlp-gateway-.../otlp/v1/traces` exporter is
no longer configured. Keeping it would bypass Alloy redaction and duplicate
traces.

## Verify the route

Send one controlled low-cost request through the deployed proxy Worker. The
path omits the leading provider gateway prefix because the Worker appends it:

```bash
curl --config - <<EOF
fail-with-body
show-error
url = "${PROXY_WORKER_URL}/openai/chat/completions"
header = "X-Proxy-Secret: ${PROXY_SECRET}"
header = "Authorization: Bearer ${OPENAI_API_KEY}"
header = "Content-Type: application/json"
data = "{\"model\":\"gpt-4o-mini\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply only with OK.\"}],\"max_tokens\":1}"
EOF
```

Within 15 minutes, open `graft-ai-otel-observability` and verify all three
queries:

```text
Tempo TraceQL: { span.graft_ai.request_span = true }
Loki: {gateway="main",env="prod"} | json
Prometheus: sum by (model, provider) (increase(ai_gateway_requests_total{gateway="main",env="prod"}[15m]))
```

Tempo must contain the selected request span. Loki must contain a redacted
request record with only `model`, `status_code`, `env`, and `gateway` stream
labels. Prometheus must report a non-zero series whose `provider` is not
`unknown`.

`graft-ai-aig-overview` remains Logpush-specific and is expected to be empty in
this mode. Use `graft-ai-otel-observability` as the Free Tier OTel dashboard.

## Safe failure action

If the exporter or any backend check fails, disable the AI Gateway exporter and
inspect the receiver logs:

```bash
docker compose --env-file deploy/otel/.env.grafana-cloud \
  -f deploy/otel/docker-compose.yml \
  -f deploy/otel/docker-compose.grafana-cloud.yml \
  logs alloy cloudflared
```

Do not restore the direct Grafana exporter while diagnosing a failure; it
bypasses Alloy redaction. Record only non-secret facts in the change summary:
the Tunnel hostname, exporter content type, whether Tempo/Loki/Prometheus
returned a result, the dashboard URL, and any disabled exporter. Do not record
Authorization values, token fragments, credential-bearing URLs, request
bodies, or response bodies.
