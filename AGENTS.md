# AGENTS.md

This is `graft-ai`, a telemetry pipeline that aggregates Cloudflare AI
Gateway logs, provider usage metrics, and Ollama Cloud reset metrics into
Grafana Cloud.

## Why we are here

Provide a unified, Free-Tier-friendly view of AI provider costs, tokens,
access logs, and rate-limit reset windows.

## What the repo contains

- **Cloudflare Workers** (`workers/`): TypeScript Workers for AI Gateway
  Logpush ingestion, proxy mode, scheduled provider metrics, and Ollama Cloud
  reset metrics.
- **Terraform** (`terraform/`): Cloudflare infrastructure and optional Grafana
  resources.
- **Dashboards and alerts** (`grafana/`): Grafana JSON plus alert rules.
- **Operational runbooks** (`docs/`): deployment, rollback, and subsystem
  guides.

## How to work in this repo

- **Tech stack:** TypeScript with strict settings (`workers/tsconfig.json`);
  use npm inside `workers/`.
- **Verification gates:** `make test`, `make typecheck`, `make fmt`, and
  `make validate` must pass before any merge.
- **Secrets hygiene:** never commit secrets, API keys, or credentials. Use
  `workers/.dev.vars` for local development and Wrangler secrets for deployed
  Workers. Do not put them in `*.tfvars`, dashboard JSON, Compose files, or
  any tracked configuration.
- **Universal data contract:** Loki labels are strictly limited to `model`,
  `status_code`, `env`, `gateway` on every path that writes to Loki; never add
  high-cardinality labels.
- **Authoritative docs:** read `README.md` and `SPEC.md` before changing the AI
  Gateway log pipeline, Terraform, or Workers code. Detailed OTel design
  invariants (sampling, redaction, spanlogs, dispatch) are in `SPEC.md`
  § _OTel signal contracts (design invariants)_.
- **Code organization:** follow the existing module-by-responsibility pattern in
  `workers/src/` (e.g., `index`, `crypto`, `transform`, `loki`, `types`,
  `ollama-cloud`, `provider-metrics`). Add new modules following the same
  pattern.

## Progressive disclosure

This file is intentionally small. Domain-specific conventions (TypeScript
style, testing patterns, security practices, Git workflow, per-Worker
deployment procedures) should be discovered by reading existing code and tests.
If a topic needs a persistent guide, create a focused markdown file under
`docs/` and link it here instead of inlining it.
