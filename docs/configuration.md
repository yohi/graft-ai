# Configuration

This document is the human-readable configuration reference for `graft-ai`.

Machine-usable files remain canonical for exact binding shapes and example values. When configuration changes, update the relevant Wrangler/Terraform/example file and this reference together. Normative technical defaults and invariants belong in [`SPEC.md`](../SPEC.md), not here.

## Configuration Sources

| Area | Machine-usable source | Purpose |
| --- | --- | --- |
| Free Tier proxy | `workers/wrangler.proxy.jsonc` | Proxy Worker name, entry point, account/gateway IDs |
| Logpush Worker | `workers/wrangler.jsonc`, `workers/.dev.vars.example` | Logpush Worker runtime and local examples |
| Dedicated OTel Worker | `workers/wrangler.otel.jsonc` | Queue, D1/KV/R2, OTLP, sampling/redaction settings |
| Provider metrics | `workers/wrangler.provider-metrics.jsonc` | Scheduled provider-metrics Worker |
| Ollama Cloud resets | `workers/wrangler.ollama.jsonc` | Scheduled reset-window Worker |
| Terraform | `terraform/variables.tf`, `terraform/terraform.tfvars.example` | Cloudflare/Grafana infrastructure inputs |
| Local development | `workers/.dev.vars.example` | Local-only environment examples |

Secrets must not be committed. Use `wrangler secret put`, `TF_VAR_*` environment variables, or the repository's deployment workflow as appropriate.

## Free Tier Proxy

Configure `workers/wrangler.proxy.jsonc`:

| Setting | Required | Purpose |
| --- | --- | --- |
| `CF_ACCOUNT_ID` | yes | Cloudflare account ID |
| `AI_GATEWAY_ID` | yes | AI Gateway ID used by the proxy |

Runtime secret:

| Secret | Required | Purpose |
| --- | --- | --- |
| `PROXY_SECRET` | yes | Authenticates requests through `X-Proxy-Secret` |

`GATEWAY_NAME` and `ENV_LABEL` are used by shared/local telemetry flows where configured; they are not replacements for the proxy's `AI_GATEWAY_ID`.

For onboarding, use `make setup-free-tier`.

## Logpush Worker

The Logpush path uses these runtime values:

| Setting or secret | Purpose |
| --- | --- |
| `GRAFANA_CLOUD_LOKI_URL` | Loki push endpoint |
| `GRAFANA_CLOUD_LOKI_USERNAME` | Loki tenant/user ID |
| `GRAFANA_CLOUD_ACCESS_POLICY_TOKEN` | Grafana Cloud token with Loki write scope |
| `ORIGIN_SECRET` | Shared secret used for Logpush-to-Worker ingress |
| `RSA_PRIVATE_KEY_PEM` | PKCS#8 private key used to decrypt AI Gateway Logpush payloads |

Terraform owns the matching Cloudflare/Grafana deployment inputs. Use `terraform/variables.tf` as the exact input-name/validation source and `terraform/terraform.tfvars.example` only for non-secret example values.

See [Logpush Deployment](logpush.md).

## Dedicated OTel Worker

`workers/wrangler.otel.jsonc` owns the deployable binding shape for the dedicated OTel Worker.

Important configuration groups include:

- payload-store selection and D1/KV/R2 bindings;
- Queue producer/consumer bindings;
- OTLP endpoint and authentication;
- sampling and redaction settings;
- ingress authentication and rate limiting;
- scheduled payload cleanup.

The current default payload store is D1. Compatibility rules, storage semantics, limits, failure behavior, and retention contracts are normative in [`SPEC.md`](../SPEC.md).

Do not copy complete OTel defaults into other human documents. Use the Wrangler config for machine values and `SPEC.md` for normative behavior.

See [Dedicated Cloudflare Worker AI Gateway OTel](cloudflare-worker-ai-gateway-otel.md).

## Provider Metrics Worker

`workers/wrangler.provider-metrics.jsonc` schedules the provider-metrics Worker once per minute.

Provider credentials are optional per provider; an unconfigured provider is skipped. Configuration currently includes:

| Variable | Purpose |
| --- | --- |
| `OPENAI_ADMIN_API_KEY` | OpenAI usage/cost collection |
| `OPENAI_API_HISTORY_DAYS` | OpenAI history window; default `1`, valid configured range `1..31` |
| `CODEX_ACCESS_TOKEN` | Codex usage collection |
| `CODEX_ACCOUNT_ID` | Optional Codex account selector |
| `CODEX_PROXY_URL` / `CODEX_API_BASE_URL` | Optional Codex request path override |
| `CODEX_PROXY_SECRET` | Optional secret for the configured Codex proxy |
| `OPENCODEGO_SESSION_COOKIE` | OpenCodeGo session credential |
| `OPENCODEGO_WORKSPACE_ID` | Optional OpenCodeGo workspace selector |
| `OLLAMA_SESSION_COOKIE` | Ollama Cloud session credential |
| `GRAFANA_CLOUD_PROMETHEUS_URL` | Prometheus-compatible OTLP/push destination |
| `GRAFANA_CLOUD_PROMETHEUS_USERNAME` | Destination username |
| `GRAFANA_CLOUD_ACCESS_POLICY_TOKEN` | Destination access token |
| `MYBROWSER` | Browser binding used by flows requiring browser rendering |

Exact runtime types are defined under `workers/src/provider-metrics/`.

See [Provider Metrics](provider-metrics.md).

## Ollama Cloud Reset Metrics

`workers/wrangler.ollama.jsonc` schedules the Ollama reset-window Worker once per minute.

| Variable | Required | Purpose |
| --- | --- | --- |
| `OLLAMA_CLOUD_RESET_ANCHOR_ISO` | yes | ISO 8601 timestamp used as the reset-window anchor |
| `OLLAMA_CLOUD_PLAN` | no | Plan label; defaults to `unknown` |
| `OLLAMA_CLOUD_SESSION_INTERVAL_SECONDS` | no | Session reset interval; default `18000` |
| `OLLAMA_CLOUD_WEEKLY_INTERVAL_SECONDS` | no | Weekly reset interval; default `604800` |
| `GRAFANA_CLOUD_PROMETHEUS_URL` | yes for export | Metrics destination |
| `GRAFANA_CLOUD_PROMETHEUS_USERNAME` | yes for export | Metrics destination username |
| `GRAFANA_CLOUD_ACCESS_POLICY_TOKEN` | yes for export | Metrics write credential |

See [Ollama Cloud Reset Metrics](ollama-cloud.md).

## Terraform

Terraform inputs are defined in `terraform/variables.tf`.

Keep sensitive values out of `terraform/terraform.tfvars`. Supply sensitive values using `TF_VAR_*` environment variables. The repository example file intentionally contains only non-secret placeholders/defaults.

Resource names for the dedicated OTel Worker, D1 database, KV namespace, and optional R2 bucket are constrained to match the Worker configuration. Do not rename them independently.

## Local Development

Copy the local example only when needed:

```bash
cp workers/.dev.vars.example workers/.dev.vars
```

Never commit `workers/.dev.vars`.

The example intentionally covers several deployment paths in one local file. You only need to populate the values for the component you are running.

## Ownership Rules

Use one source for each kind of truth:

- exact machine binding/variable shapes: Wrangler, Terraform, and example files;
- human-readable configuration guidance: this document;
- normative defaults, compatibility rules, and technical invariants: [`SPEC.md`](../SPEC.md);
- deployment procedures: [Deployment](deployment.md);
- recovery and quota handling: [Operations](operations.md);
- AI-agent workflow rules: [`AGENTS.md`](../AGENTS.md).
