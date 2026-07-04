# AGENTS.md

This repository is `graft-ai`, a telemetry pipeline that aggregates Cloudflare AI Gateway logs, OpenAI usage, and Ollama Cloud metrics into Grafana Cloud dashboards.

## Project overview

- **What:** TypeScript Cloudflare Worker + Terraform for AI Gateway log collection; Prometheus-oriented scrapers for OpenAI/Ollama are future subsystems.
- **Why:** Provide a unified, Free-Tier-friendly view of AI provider costs, tokens, and access logs.
- **How:** The Worker receives encrypted Logpush NDJSON, decrypts it, transforms it into Loki JSON streams, and pushes to Grafana Cloud Loki. Terraform manages only the Cloudflare Logpush job; the Worker is deployed via Wrangler.

## Quick references

For implementation details, read these files before making changes:

- [`README.md`](./README.md) — architecture, directory layout, deployment steps, and operational notes.
- [`SPEC.md`](./SPEC.md) — formal specification: data transformation rules, reliability matrix, security constraints.
- [`Makefile`](./Makefile) — standard commands: `make install`, `make test`, `make typecheck`, `make fmt`, `make validate`, `make deploy`.

## Universal conventions

- Language: TypeScript with strict settings (`workers/tsconfig.json`).
- Package manager: npm (inside `workers/`).
- Secrets: never commit or store in `*.tfvars`. Use `workers/.dev.vars` for local development and `TF_VAR_*` environment variables for Terraform.
- CI expectations: `make test`, `make typecheck`, `make fmt`, and `make validate` must pass before merging.

## When working on this repo

1. Read `README.md` and `SPEC.md` if you are touching the AI Gateway log pipeline, Terraform, or Workers code.
2. Follow existing patterns in `workers/src/`; the modules are split by responsibility (`index`, `crypto`, `transform`, `loki`, `types`).
3. Run `make test` and `make typecheck` after any TypeScript change; run `make validate` after any Terraform change.
4. Keep Loki labels strictly to `model`, `status_code`, `env`, `gateway` and avoid adding high-cardinality labels.
