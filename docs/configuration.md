# Configuration

This document is the human-readable configuration reference for `graft-ai`.

Concrete variable names, bindings, and example values are also represented in machine-usable files such as `workers/wrangler.*.jsonc`, `.dev.vars.example`, and `terraform/terraform.tfvars.example`. When changing configuration, update the machine-usable source and this reference together.

## Proxy Worker

The Free Tier proxy path is configured in `workers/wrangler.proxy.jsonc`.

Required values:

- `CF_ACCOUNT_ID` — Cloudflare account ID.
- `AI_GATEWAY_ID` — Cloudflare AI Gateway ID.

Secrets are not stored in the Wrangler configuration. Use the setup workflow or Wrangler secret commands for values such as the proxy secret.

## Provider Metrics Worker

Provider-specific metrics settings are defined in `workers/wrangler.provider-metrics.jsonc` and the corresponding runtime environment types.

See [Provider metrics](provider-metrics.md) for setup and supported behavior.

## Dedicated OTel Worker

The dedicated OTel Worker is configured in `workers/wrangler.otel.jsonc`.

Important settings include:

- `OTEL_PAYLOAD_STORE` — payload storage backend. The current default is `d1`.
- D1, KV, and R2 bindings used by the selected backend.
- Queue bindings for asynchronous processing.
- OTLP endpoint and authentication values.
- Sampling and redaction-related settings.

Normative storage behavior, defaults, compatibility rules, and failure semantics are defined in [`../SPEC.md`](../SPEC.md).

## Terraform

Terraform inputs are documented in `terraform/terraform.tfvars.example` and the Terraform variable definitions.

Use the example file as the machine-usable starting point. Do not copy credentials into committed configuration.

## Local Development

Local environment examples are provided by the repository's `.dev.vars.example` files and Wrangler development configuration.

Keep secrets out of Git and prefer local secret files or Wrangler-managed secrets.

## Configuration Ownership

Use these sources for different kinds of truth:

- Machine-usable variable names and binding shapes: Wrangler, Terraform, and `.dev.vars.example` files.
- Human-readable configuration guidance: this document.
- Technical invariants and normative defaults: [`../SPEC.md`](../SPEC.md).
- AI-agent workflow rules: [`../AGENTS.md`](../AGENTS.md).
