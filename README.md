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

HT|This project is optimized to run within the **Grafana Cloud Free Tier**
VS|(14-day retention, 10k active series, 50GB logs). The default deployment path
WY|uses Cloudflare **Workers Logpush**, which requires a **Cloudflare Workers
MB|Paid plan**. An alternative ** autopilot proxy mode is available and routes traffic
ZZ|through a Cloudflare Worker plus a Tail Worker so no Logpush job is needed.
NV|> **Note:** Tail Workers require a **Cloudflare Workers Paid or Enterprise plan**; the "Free Tier" refers to Grafana Cloud's free tier, not Cloudflare's.

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
├── workers/          # TypeScript Cloudflare Workers for AI Gateway telemetry
│   ├── src/
│   │   ├── index.ts      # fetch handler: auth → decompress → decrypt → transform → push
│   │   ├── proxy.ts      # Free Tier proxy: client → AI Gateway + telemetry log
│   │   ├── tail-worker.ts # Tail Worker: telemetry log → Loki
│   │   ├── crypto.ts     # RSA-OAEP unwrap + AES-GCM decrypt for encrypted log fields
│   │   ├── transform.ts  # NDJSON → Loki JSON streams (labels, timestamp, log line)
│   │   ├── loki.ts       # Loki HTTP push client with Basic Auth and 429 retry
│   │   └── types.ts      # shared TypeScript types
│   ├── tests/        # unit and integration tests (50 cases via Vitest)
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── wrangler.jsonc       # Logpush mode Worker config
│   ├── wrangler.proxy.jsonc # Free Tier proxy Worker config
│   └── wrangler.tail.jsonc  # Free Tier Tail Worker config
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

This subsystem supports two modes:

- **Logpush mode:** receives encrypted AI Gateway access logs via Cloudflare
  Logpush, transforms them into Loki JSON streams, and pushes them to Grafana
  Cloud Loki.
- **Free Tier proxy mode:** routes client traffic through a proxy Worker, emits
  one marked structured `console.log()` telemetry line per request, and uses a
  Tail Worker to transform those logs and push them to Grafana Cloud Loki.

#### Data Flow

##### Logpush Mode (Workers Paid Plan)

```text
[Cloudflare AI Gateway] ── logs ──→ [Cloudflare Logpush]
                                       ↓ gzip + RSA-encrypted NDJSON
[Cloudflare Workers - workers/src/index.ts]
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

##### Free Tier Proxy Mode (No Logpush)

```text
[Client/App]
  └─ calls proxy Worker instead of AI Gateway directly
       ↓
[Cloudflare Workers - workers/src/proxy.ts]
  ├─ forwards request to Cloudflare AI Gateway
  ├─ streams AI Gateway response back to client
  └─ emits one JSON telemetry line per request
       ↓ Tail Worker logs
[Cloudflare Workers - workers/src/tail-worker.ts]
  ├─ filters marked console.log lines
  ├─ converts telemetry into the same AI Gateway log shape used by transform.ts
  └─ pushes Loki JSON streams via loki.ts
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
  exponential backoff. The Loki handler returns the upstream status on final
  failure, and the Worker maps `429` and `>=500` responses to `503` while all
  other non-2xx responses become `400`.
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
make validate    # terraform validate (Logpush mode only)
make deploy      # wrangler deploy + terraform apply (Logpush mode only)
```

### Free Tier Setup (No Logpush)

Use this mode when your Cloudflare account cannot use Workers Logpush because
Logpush requires a Paid Workers plan. The existing Logpush receiver remains in
`workers/src/index.ts` and is deployed via `wrangler.jsonc`. The Free Tier proxy
Worker is in `workers/src/proxy.ts` and is deployed via
`wrangler.proxy.jsonc`. The Tail Worker is in `workers/src/tail-worker.ts` and
is deployed via `wrangler.tail.jsonc`.

#### Free Tier Data Flow

```text
[Client/App]
  └─ calls proxy Worker instead of the AI Gateway URL directly
       ↓
[workers/src/proxy.ts]
  ├─ forwards method, headers, body, path, and query to Cloudflare AI Gateway
  ├─ streams the AI Gateway response back to the client unchanged
  └─ emits one JSON telemetry line marked with "_graft_ai_telemetry": true
       ↓ Tail Worker logs
[workers/src/tail-worker.ts]
  ZN|  ├─ filters marked console.log lines
  JW|  ├─ converts telemetry into the same AI Gateway log shape used by transform.ts
  SM|  └─ loki.ts 経由で Loki JSON streams を push

The client must call your proxy Worker URL instead of calling
`https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/...` directly.
The proxy Worker reconstructs the AI Gateway URL from these non-secret routing
values:

- `CF_ACCOUNT_ID` - your Cloudflare account ID (used to build the upstream URL
  path)
- `AI_GATEWAY_ID` - the AI Gateway ID in the URL path

The following values are used **only** as low-cardinality Loki labels and are
not required for routing:

- `GATEWAY_NAME` - appears as the `gateway` label in Loki; usually the same
  name such as `main`
- `ENV_LABEL` - appears as the `env` label in Loki; such as `prod` or
  `staging`

QX|Set these values in `workers/wrangler.proxy.jsonc` before deploying.

Free Tier mode does **not** need `ORIGIN_SECRET`, `RSA_PRIVATE_KEY_PEM`,
Terraform, or a Cloudflare Logpush job. It only needs Grafana Cloud Loki write
secrets on the Tail Worker:

```bash
cd workers
npx wrangler secret put GRAFANA_CLOUD_LOKI_URL --config wrangler.tail.jsonc
npx wrangler secret put GRAFANA_CLOUD_LOKI_USERNAME --config wrangler.tail.jsonc
npx wrangler secret put GRAFANA_CLOUD_ACCESS_POLICY_TOKEN --config wrangler.tail.jsonc
```

Deploy the Tail Worker first, then deploy the proxy Worker with the configured
tail consumer:

```bash
cd workers
npx wrangler deploy --config wrangler.tail.jsonc
npx wrangler deploy --config wrangler.proxy.jsonc
```

After deployment, send one client request through the proxy Worker and confirm
that Grafana Cloud Loki receives a log stream with only these labels: `model`,
`status_code`, `env`, and `gateway`.

> **Note:** `make deploy` and `make validate` run Terraform and only apply
> to the Logpush mode. For Free Tier mode, deploy the Workers directly with
> the `npx wrangler deploy` commands shown above.

## 🛠️ Logpush Setup & Deployment (Workers Paid)

### Quick Start

If this is your first time using this repo, follow the steps below in order.
The goal is simple: by the end, `make test`, `make validate`, and `make deploy`
should run without missing-file or missing-secret errors.

### What You Need

- A terminal
- A recent Node.js LTS release for the Worker workspace under `workers/`
- `npm`
- Terraform `>= 1.5.0`
- A Cloudflare account with AI Gateway and Logpush access
- A Grafana Cloud Loki tenant URL, username, and access policy token
- A Cloudflare API token with Logpush/Logs permissions

### First-Time Setup

1. Log in to Cloudflare from the Worker workspace:

   ```bash
   cd workers
   npx wrangler login
   cd ..
   ```

   This opens a browser and connects your local machine to Cloudflare.

2. Install dependencies and generate Worker types:

   ```bash
   make install
   ```

   If this fails, check that `npm` is installed and that you are in the repo
   root.

3. Copy the example files and fill in values in the right place:

   ```bash
   cp workers/.dev.vars.example workers/.dev.vars
   cp terraform/terraform.tfvars.example terraform/terraform.tfvars
   ```

   - `workers/.dev.vars` is for local Worker development only.
   - `terraform/terraform.tfvars` is for non-secret Terraform inputs only.
   - Secret values should stay in `TF_VAR_*` environment variables or Wrangler
     secrets.

4. Fill in `workers/.dev.vars`:
   - `GRAFANA_CLOUD_LOKI_URL` - your Loki endpoint
   - `GRAFANA_CLOUD_LOKI_USERNAME` - your Loki tenant ID / username
   - `GRAFANA_CLOUD_ACCESS_POLICY_TOKEN` - your Grafana token
   - `ORIGIN_SECRET` - a random shared secret for Logpush → Worker
   - `RSA_PRIVATE_KEY_PEM` - the private key used to decrypt Logpush payloads

   Example: if you see `your-random-origin-secret-here`, replace it with your
   own secret string.

5. Fill in `terraform/terraform.tfvars`:
   - `cloudflare_account_id` - your Cloudflare account ID
   - `logpush_dataset` - usually `ai_gateway_events`
   - `worker_script_name` - the Worker script name in Cloudflare
   - `logpush_job_name` - the name for the Logpush job
   - `workers_subdomain` - the subdomain used for the Worker

6. Set Worker runtime secrets via Wrangler:

   ```bash
   cd workers
   npx wrangler secret put ORIGIN_SECRET
   npx wrangler secret put RSA_PRIVATE_KEY_PEM
   npx wrangler secret put GRAFANA_CLOUD_LOKI_URL
   npx wrangler secret put GRAFANA_CLOUD_LOKI_USERNAME
   npx wrangler secret put GRAFANA_CLOUD_ACCESS_POLICY_TOKEN
   cd ..
   ```

   When prompted, paste the matching values from your setup.

7. Export Terraform variables in your shell (do not commit them):

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

   Keep this terminal open while you run Terraform commands.

8. Run local checks before deploying:

   ```bash
   make typecheck
   make test
   make validate
   ```

   Success means those commands finish without errors.

9. Deploy and verify end-to-end:

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

### Common Setup Checks

- If `make install` fails, check that `npm` is installed and that you are in the
  repo root.
- If Terraform tries to manage secret values, move them back to `TF_VAR_*`
  environment variables.
- If `make deploy` fails before the Terraform apply step, re-check
  `scripts/verify-deployment-env.sh` output and the Cloudflare login state.
- If Logpush does not deliver data, confirm the dataset name in
  `terraform/terraform.tfvars` matches the Cloudflare account and that the RSA
  public key was uploaded to the Logpush settings.

### Copy-Paste Checklist

Use this if you want a quick self-check before deploying:

- `workers/.dev.vars` exists and contains local Worker values
- `terraform/terraform.tfvars` exists and contains only non-secret Terraform values
- `npx wrangler login` has been run from `workers/`
- `make install` completed successfully
- `make typecheck`, `make test`, and `make validate` all passed
- `TF_VAR_*` environment variables are set in the shell you are using

### Typical Beginner Mistakes

- Running `npx wrangler secret put ...` from the repo root instead of `workers/`
- Putting a secret value into `terraform/terraform.tfvars`
- Forgetting to replace placeholder text such as `your-random-origin-secret-here`
- Using the wrong Cloudflare account ID or worker subdomain
- Skipping `make install` and then trying to run `make test` first

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
