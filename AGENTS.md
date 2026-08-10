# AGENTS.md

This repository is `graft-ai`, a telemetry pipeline that aggregates Cloudflare AI Gateway logs, provider usage metrics, and Ollama Cloud reset metrics into Grafana Cloud.

## Project overview

- **What:** TypeScript Cloudflare Workers, Terraform, and Grafana dashboards.
- **Why:** Provide a unified, Free-Tier-friendly view of AI provider costs, tokens, access logs, and rate-limit reset windows.
- **How:** Encrypted AI Gateway Logpush NDJSON is decrypted, transformed into Loki JSON streams, and pushed to Grafana Cloud Loki. Scheduled Workers fetch Codex, OpenAI API, and OpenCodeGo usage, plus Ollama Cloud reset metrics, and push them to Grafana Cloud Prometheus via OTLP/JSON.

## Quick references

Read these files before making changes:

- [`README.md`](./README.md) — architecture, directory layout, deployment steps, and operational notes.
- [`SPEC.md`](./SPEC.md) — formal specification: providers, data transformation rules, reliability matrix, security constraints.
- [`Makefile`](./Makefile) — standard commands.

## Essentials

- **Language:** TypeScript with strict settings (`workers/tsconfig.json`).
- **Package manager:** npm (run commands from inside `workers/`).
- **Secrets:** never commit or store in `*.tfvars`. Use `workers/.dev.vars` for local development and Wrangler secrets for deployed Workers.
- **CI expectations:** `make test`, `make typecheck`, `make fmt`, and `make validate` must pass before merging.

## When working on this repo

1. Read `README.md` and `SPEC.md` if you are touching the AI Gateway log pipeline, Terraform, or Workers code.
2. Follow existing patterns in `workers/src/`; modules are split by responsibility (e.g., `index`, `crypto`, `transform`, `loki`, `types`, `ollama-cloud`, `provider-metrics`). Add new modules following this pattern.
3. Run `make test` and `make typecheck` after any TypeScript change; run `make validate` after any Terraform change.
4. Keep Loki labels strictly to `model`, `status_code`, `env`, `gateway` and avoid adding high-cardinality labels.

## Progressive disclosure

For deeper conventions (TypeScript style, testing patterns, security practices, Git workflow), prefer reading existing code and tests over adding broad rules here. If a domain needs a persistent guide, add a focused markdown file under `.agents/guides/` or `docs/` and link it from this file instead of inlining it.
