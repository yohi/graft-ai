<!-- markdownlint-disable MD013 -->

# graft-ai

Cloudflare AI Gateway, OpenAI, and Ollama Cloud telemetry (metrics/logs)
aggregator for Grafana Cloud.

日本語版: [README.ja.md](./README.ja.md)

---

## 📌 Overview

`graft-ai` is an integrated telemetry pipeline designed to graft costs, token
usages, and access logs from multiple AI provider endpoints into a unified
**Grafana Cloud** dashboard.

This project is fully optimized to run within the constraints of the **Grafana
Cloud Free Tier** (14-day retention, 10k active series, 50GB logs).

## 🏗️ Architecture

- **Cloudflare AI Gateway:** Streams proxy logs and latency directly to Grafana
  Loki via Workers Logpush.
- **OpenAI GPT Usage:** Scrapes token consumption and dollar-based costs via
  Management API to Grafana Prometheus.
- **Ollama Cloud:** Tracks GPU execution duration metrics and account
  limitations to Grafana Prometheus.

## 📁 Directory Layout

```text
graft-ai/
├── workers/          # TypeScript Cloudflare Worker for AI Gateway log collection
│   ├── src/
│   │   ├── index.ts      # fetch handler: auth → decompress → decrypt → transform → push
│   │   ├── crypto.ts     # RSA-OAEP unwrap + AES-GCM decrypt for encrypted log fields
│   │   ├── transform.ts  # NDJSON → Loki JSON streams (labels, timestamp, log line)
│   │   ├── loki.ts       # Loki HTTP push client with Basic Auth and 429 retry
│   │   └── types.ts      # shared TypeScript types
│   ├── tests/        # unit and integration tests (46 cases via Vitest)
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   └── wrangler.jsonc
├── terraform/        # Terraform: only the Cloudflare Logpush job (Worker is Wrangler)
│   ├── main.tf
│   ├── variables.tf
│   ├── outputs.tf
│   └── versions.tf
├── tests/fixtures/   # sample AI Gateway NDJSON fixtures
├── Makefile          # convenience targets: install, typecheck, test, fmt, validate, deploy
└── README.md         # this file
```

## 🔌 Subsystems

### Subsystem 1 — Cloudflare AI Gateway Log Collection

This subsystem receives encrypted AI Gateway access logs via Cloudflare Logpush,
transforms them into Loki JSON streams, and pushes them to Grafana Cloud Loki.

#### Data Flow

```text
[Cloudflare AI Gateway] ── logs ──→ [Cloudflare Logpush]
                                       ↓ gzip + RSA-encrypted NDJSON
[Cloudflare Workers]
  ├─ verify X-Origin-Secret header
  ├─ decompress gzip body
  ├─ decrypt encrypted fields (RSA-OAEP unwrap AES key, AES-GCM decrypt)
  ├─ parse NDJSON lines
  ├─ transform each line to Loki stream entry
  │     ├─ timestamp: seconds/milliseconds → nanoseconds
  │     ├─ labels: model, status_code, env, gateway
  │     └─ log line: selected fields in snake_case
  └─ push to Grafana Cloud Loki via HTTPS + Basic Auth
```

#### Key Design Rules

- **Ingress authentication:** Logpush sends the `X-Origin-Secret` header; the
  Worker compares it with `env.ORIGIN_SECRET` using a constant-time comparison.
  Mismatches return `401` to avoid retry loops.
- **Timestamp handling:** `RequestTime` is treated as seconds if ≤10 digits,
  milliseconds if 11–13 digits, and rejected as precision-lost if ≥14 digits.
  The offending log line is skipped and logged.
- **Model normalization:** Cloudflare model IDs such as
  `@cf/meta/llama-3.1-8b-instruct` are stripped to `llama-3.1-8b-instruct`.
- **Cardinality control:** Loki labels are strictly limited to `model`,
  `status_code`, `env`, `gateway`.
- **Log line fields:** `request_id`, `cache_status`, `prompt_tokens`,
  `completion_tokens`, `total_tokens`, `duration_ms`, `path`, `method`.
  Optionally includes decrypted `request_body`, `response_body`, and `metadata`
  when `env.INCLUDE_*` flags are explicitly enabled; by default these are
  excluded to protect prompts, response bodies, and metadata.
- **Retry policy:** Loki 429 responses are retried up to 3 times with
  exponential backoff. 5xx or final 429 returns `503` so Logpush retries. Other
  4xx returns `400` to stop retry.
- **Security:** Secrets are never stored in `*.tfvars`; use `TF_VAR_*`
  environment variables or Wrangler secrets.
- **Encryption:** Logpush payload fields are encrypted with RSA-OAEP-wrapped
  AES-GCM keys; the Worker decrypts with the configured PKCS#8 RSA private key
  (`env.RSA_PRIVATE_KEY_PEM`).

#### Quick Commands

```bash
make typecheck   # TypeScript type check
make test        # run Vitest suite
make fmt         # format Terraform and Workers sources
make validate    # terraform validate
make deploy      # wrangler deploy + terraform apply
```

## 🛠️ Development & Deployment

1. Install dependencies and generate types:

   ```bash
   make install
   ```

2. Copy example files and fill in real values:

   ```bash
   cp workers/.dev.vars.example workers/.dev.vars
   cp terraform/terraform.tfvars.example terraform/terraform.tfvars
   ```

3. Set Worker runtime secrets via Wrangler:

   ```bash
   cd workers
   npx wrangler secret put ORIGIN_SECRET
   npx wrangler secret put RSA_PRIVATE_KEY_PEM
   npx wrangler secret put GRAFANA_CLOUD_LOKI_URL
   npx wrangler secret put GRAFANA_CLOUD_LOKI_USERNAME
   npx wrangler secret put GRAFANA_CLOUD_ACCESS_POLICY_TOKEN
   cd ..
   ```

4. Export Terraform variables (do not commit them):

   ```bash
   export TF_VAR_cloudflare_api_token="..."
   export TF_VAR_cloudflare_account_id="..."
   export TF_VAR_workers_subdomain="..."
   export TF_VAR_origin_secret="..."
   export TF_VAR_rsa_private_key_pem="..."
   export TF_VAR_grafana_cloud_loki_url="..."
   export TF_VAR_grafana_cloud_loki_username="..."
   export TF_VAR_grafana_cloud_access_policy_token="..."
   ```

5. Deploy and verify end-to-end:

   ```bash
   make deploy
   ```

   Then follow the **Deployment Verification Flow** below.

### Deployment Verification Flow

Follow the same phased verification used during design:

1. `terraform plan` — confirm only the `cloudflare_logpush_job` is created.
2. `make test` — run Worker unit and integration tests.
3. `wrangler dev` — POST a sample gzipped NDJSON payload and confirm `200`.
4. Real request — send a request through AI Gateway and wait for Loki to show
   the log.
5. Grafana dashboard — confirm `sum by (status_code) (count_over_time(...))`
   returns data.

## ⚠️ Operational Notes

- Terraform state is currently stored locally by default. Configure a remote
  encrypted backend (e.g., S3 with SSE + DynamoDB locking) before production
  use.
- Verify the Cloudflare Logpush dataset name and available fields via the
  Cloudflare API before applying
  (`/accounts/{id}/logpush/datasets/{dataset}/fields`). The default dataset in
  `terraform/variables.tf` is `ai_gateway_events`; confirm this matches your
  account.
- Upload the RSA _public_ key to the AI Gateway Logpush settings; keep the
  private key in `TF_VAR_rsa_private_key_pem`.
- Confirm the Cloudflare API token has the minimum required Logpush/Logs
  permissions before applying (refer to Cloudflare docs for the exact set).
- **Quota and monitoring:** The pipeline is sized for the Grafana Cloud Free
  Tier. Estimated transformed log size is ~0.5–1.5 KB per request (vs. 3–8 KB
  raw). At 100k requests/day this is roughly 1.5–4.5 GB/month, well under the 50
  GB/month limit. After deployment, monitor Workers Analytics for
  exceptions/subrequest errors, watch Logpush `last_delivery` status, and
  compare Grafana Cloud Logs Usage against this estimate weekly.

## 📄 License

See [LICENSE](./LICENSE).
