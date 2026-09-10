# graft-ai

[日本語](README.ja.md)

Observability and routing helpers for Cloudflare AI Gateway, with a Free Tier proxy path and optional OpenTelemetry pipelines.

## What it does

`graft-ai` provides a Cloudflare Worker proxy for AI Gateway and optional observability paths for exporting AI request telemetry to OpenTelemetry-compatible backends.

The fastest way to try the project is the **Free Tier proxy-only** path. Logpush and the dedicated OTel Worker are optional deployment paths for users who need broader observability or production-scale ingestion.

## Quick Start

### Requirements

- Node.js 22
- `npm` / `npx`
- `jq`
- A Cloudflare account
- An existing Cloudflare AI Gateway

### Configure

Edit `workers/wrangler.proxy.jsonc` and set:

- `CF_ACCOUNT_ID`
- `AI_GATEWAY_ID`

Do not put provider API keys in the file. Provider credentials are passed at request time and protected by the proxy secret.

### Deploy

```bash
make setup-free-tier
```

The setup script installs Worker dependencies, deploys the proxy Worker, and configures the proxy secret.

### Verify

Send one request through the deployed proxy using the `X-Proxy-Secret` header. A successful AI Gateway response confirms the minimum path is working.

For the full walkthrough, request examples, local observability stack, and troubleshooting, see [Free Tier AI Gateway + OTel](docs/free-tier-ai-gateway-otel.md).

## Features

- Free Tier proxy path for Cloudflare AI Gateway
- Optional Logpush-based telemetry ingestion
- Optional dedicated OTel Worker ingestion
- Redaction and payload-handling safeguards
- OpenTelemetry traces, logs, and metrics
- Local/self-hosted Tempo, Loki, Prometheus, and Grafana workflows
- Terraform and Wrangler deployment support

## How It Works

The project has three main paths:

1. **Free Tier proxy-only** — the default onboarding path. Requests go through the proxy Worker to Cloudflare AI Gateway.
2. **Logpush** — an optional Cloudflare path for exporting AI Gateway logs into the observability pipeline.
3. **Dedicated OTel Worker** — an optional ingestion path with payload storage, queue processing, and OTLP export.

Technical invariants, storage semantics, failure behavior, redaction requirements, and protocol contracts are canonical in [SPEC.md](SPEC.md).

## Usage

Use the proxy Worker as the upstream endpoint for AI requests and authenticate to it with `X-Proxy-Secret`.

For concrete commands and examples:

- [Free Tier AI Gateway + OTel](docs/free-tier-ai-gateway-otel.md)
- [Logpush Deployment](docs/logpush.md)
- [Dedicated Cloudflare Worker OTel path](docs/cloudflare-worker-ai-gateway-otel.md)
- [Provider metrics](docs/provider-metrics.md)
- [Ollama Cloud reset metrics](docs/ollama-cloud.md)

## Configuration

The most important proxy settings are `CF_ACCOUNT_ID` and `AI_GATEWAY_ID` in `workers/wrangler.proxy.jsonc`. Secrets must be configured with Wrangler or the provided setup workflow rather than committed to the repository.

For the complete human-readable reference, see [Configuration](docs/configuration.md). Machine-usable examples remain canonical for concrete variable names and shapes.

## Documentation

- [SPEC.md](SPEC.md) — normative technical contracts and invariants
- [AGENTS.md](AGENTS.md) — instructions for AI coding agents
- [Configuration](docs/configuration.md) — complete configuration reference
- [Deployment](docs/deployment.md) — deployment-path router
- [Operations](docs/operations.md) — monitoring, recovery, and quota guidance
- [Migration](docs/migration.md) — payload-store and deployment migration guidance
- [Free Tier AI Gateway + OTel](docs/free-tier-ai-gateway-otel.md) — Free Tier walkthrough
- [Logpush Deployment](docs/logpush.md) — Logpush setup and deployment runbook
- [Dedicated Cloudflare Worker OTel path](docs/cloudflare-worker-ai-gateway-otel.md) — dedicated OTel Worker runbook
- [Provider metrics](docs/provider-metrics.md) — provider-side metrics integration
- [Ollama Cloud reset metrics](docs/ollama-cloud.md) — scheduled reset-window metrics

## Development

Install Worker dependencies and run the repository tests from the project root:

```bash
make install
make test
```

Additional development commands are documented in the `Makefile` and package scripts under `workers/`.

## License

See [LICENSE](LICENSE).
