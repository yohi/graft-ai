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

This project is optimized to run within the **Grafana Cloud Free Tier**
(14-day retention, 10k active series, 50GB logs). The default deployment path
uses Cloudflare **Workers Logpush**, which requires a **Cloudflare Workers
Paid plan**. An alternative **Free Tier proxy-only mode** routes traffic through
a Cloudflare Worker without Workers Logpush or a Tail Worker.

### 📊 Feature Support & Roadmap Matrix

The current support status and planned roadmap items are summarized below:

| Feature / Provider | What's Possible Now (Current Support) | What's Not Possible / Limitations | Future Plans (Roadmap) |
| :--- | :--- | :--- | :--- |
| **Workers AI** | Use Workers AI through AI Gateway | - | - |
| **OpenAI (via AI Gateway)** | Use OpenAI through AI Gateway | Direct usage scraping via OpenAI APIs | Direct usage scraping from OpenAI APIs using API keys |
| **Anthropic (via AI Gateway)** | Use Anthropic through AI Gateway | Direct usage scraping via Anthropic APIs | - |
| **AI Gateway access log forwarding** | Collect AI Gateway access logs and forward them to Grafana Loki via Workers Logpush | Proxy-only mode does not forward access logs | - |
| **Ollama Cloud** | Calculate session/weekly rate-limit reset times and push to Grafana Metrics (Prometheus format) | Real-time access logs forwarding | Dynamic auto-detection of rate-limit reset anchors (currently uses static anchors) |
| **OpenAI (Direct Connect)** | - (only supported via AI Gateway proxy) | Direct cost/token scraping via API keys | Scheduled usage scraping from OpenAI Usage APIs |


## 🏗️ Architecture

- **Cloudflare AI Gateway:** Streams proxy logs and latency directly to Grafana
  Loki via Workers Logpush.
- **OpenAI GPT Usage:** Scrapes token consumption and dollar-based costs via
  Management API to Grafana Prometheus.
- **Ollama Cloud:** Derives session / weekly rate-limit reset times from
  configured anchor and intervals, pushes them to Grafana Cloud Metrics.
- **Provider Metrics Worker:** Fetches Codex, OpenAI API, and OpenCodeGo usage
  every five minutes and pushes OTLP/v1 metrics to Grafana Cloud Prometheus.

### Scheduled Workers

| Worker | Trigger | Responsibility |
| :--- | :--- | :--- |
| `graft-ai-provider-metrics` | Cron `*/5 * * * *` | Fetches Codex / OpenAI API / OpenCodeGo usage and pushes to Grafana Cloud Prometheus |
| `graft-ai-ollama-cloud` | Cron `*/5 * * * *` | Derives session / weekly reset metrics and pushes them to Grafana Cloud Prometheus |

#### `graft-ai-provider-metrics` secrets

```sh
cd workers
npx wrangler secret put OPENAI_ADMIN_API_KEY --config wrangler.provider-metrics.jsonc
npx wrangler secret put CODEX_ACCESS_TOKEN --config wrangler.provider-metrics.jsonc
npx wrangler secret put CODEX_ACCOUNT_ID --config wrangler.provider-metrics.jsonc      # optional
npx wrangler secret put OPENCODEGO_SESSION_COOKIE --config wrangler.provider-metrics.jsonc
npx wrangler secret put OPENCODEGO_WORKSPACE_ID --config wrangler.provider-metrics.jsonc  # optional
npx wrangler secret put GRAFANA_CLOUD_PROMETHEUS_URL --config wrangler.provider-metrics.jsonc
npx wrangler secret put GRAFANA_CLOUD_PROMETHEUS_USERNAME --config wrangler.provider-metrics.jsonc
npx wrangler secret put GRAFANA_CLOUD_ACCESS_POLICY_TOKEN --config wrangler.provider-metrics.jsonc
cd ..
```

The non-secret history window is configured in
`workers/wrangler.provider-metrics.jsonc`:

```jsonc
{
  "vars": {
    "OPENAI_API_HISTORY_DAYS": "1"
  }
}
```

`OPENAI_API_HISTORY_DAYS` defaults to `1` day and accepts integer values from
`1` through `31` days. Run `make deploy-provider-metrics` from the repository
root after registering the secrets.

`make setup-free-tier` provisions the Logpush-free proxy
Workers. Provider Metrics is deployed separately with
`make deploy-provider-metrics` because its provider credentials are independent
of the proxy setup.

#### `graft-ai-ollama-cloud`

```sh
cd workers
npx wrangler secret put OLLAMA_CLOUD_RESET_ANCHOR_ISO --config wrangler.ollama.jsonc
npx wrangler secret put GRAFANA_CLOUD_PROMETHEUS_URL --config wrangler.ollama.jsonc
npx wrangler secret put GRAFANA_CLOUD_PROMETHEUS_USERNAME --config wrangler.ollama.jsonc
npx wrangler secret put GRAFANA_CLOUD_ACCESS_POLICY_TOKEN --config wrangler.ollama.jsonc
cd ..
make deploy-ollama
```

`GRAFANA_CLOUD_ACCESS_POLICY_TOKEN` must include the `metrics:write` scope for
Prometheus delivery. A Loki-only token with `logs:write` will fail to deliver
metrics. Use a separate Prometheus token from the Loki token, or use one shared
token containing both `logs:write` and `metrics:write` scopes.
`OLLAMA_CLOUD_RESET_ANCHOR_ISO` must be a strict ISO 8601 timestamp and the
Prometheus endpoint must use HTTPS.

The Ollama Worker derives each reset from the configured anchor and interval:
`remainder = ((now - anchor) % interval + interval) % interval`,
`remaining_seconds = interval - remainder`, and
`next_reset_timestamp = now + remaining_seconds`. It publishes
`ollama_cloud_reset_seconds_remaining{period}`,
`ollama_cloud_reset_timestamp_seconds{period}`,
`ollama_cloud_reset_progress_ratio{period}`, and
`ollama_cloud_plan_info{plan,session_interval,weekly_interval}`. Missing or
invalid anchor/interval configuration skips emission. Prometheus 429, 5xx, and
network failures are retried up to three attempts; other 4xx responses are not
retried.

## 📁 Directory Layout

```text
graft-ai/
├── workers/          # TypeScript Cloudflare Workers for AI Gateway telemetry
│   ├── src/
│   │   ├── index.ts      # fetch handler: auth → decompress → decrypt → transform → push
│   │   ├── proxy.ts      # Free Tier proxy-only: client ↔ AI Gateway
│   │   ├── crypto.ts     # RSA-OAEP unwrap + AES-GCM decrypt for encrypted log fields
│   │   ├── transform.ts  # NDJSON → Loki JSON streams (labels, timestamp, log line)
│   │   ├── loki.ts       # Loki HTTP push client with Basic Auth and 429 retry
│   │   └── types.ts      # shared TypeScript types
│   │   ├── ollama-cloud.ts      # Cron Worker: derive reset metrics and push to Grafana
│   │   └── ollama-cloud/        # reset calculator + OTLP/JSON metrics client
│   │       ├── calc.ts
│   │       └── prometheus.ts
│   │   ├── provider-metrics.ts   # Cron Worker: provider usage → Prometheus
│   │   └── provider-metrics/     # provider fetchers + OTLP metrics client
│   ├── tests/        # unit and integration tests (179 cases via Vitest)
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── wrangler.jsonc       # Logpush mode Worker config
│   ├── wrangler.proxy.jsonc # Free Tier proxy Worker config
  │   ├── wrangler.tail.jsonc  # Paid-plan optional Tail Worker config
│   ├── wrangler.ollama.jsonc # Ollama Cloud reset metrics Worker config
│   └── wrangler.provider-metrics.jsonc # Provider metrics Worker config
├── grafana/
│   └── dashboards/
│       ├── graft-ai-overview.json      # AI Gateway dashboard (13 panels)
│       └── graft-ai-ollama-cloud.json  # Ollama Cloud reset metrics dashboard
├── scripts/
│   ├── setup-free-tier.sh   # One-command setup for proxy-only Free Tier mode
│   └── setup.sh              # Legacy: superseded by setup-free-tier.sh
├── terraform/        # Terraform: Cloudflare Logpush API helper + optional Grafana resources
│   ├── main.tf
│   ├── variables.tf
│   ├── outputs.tf
│   ├── grafana/          # Grafana Cloud provider: Access Policy + token (optional)
│   └── versions.tf
├── tests/fixtures/   # sample AI Gateway NDJSON fixtures
├── Makefile          # convenience targets: install, typecheck, test, fmt, validate, deploy, deploy-ollama, deploy-provider-metrics, setup-free-tier, setup-grafana
└── README.md         # this file
```

## 🔌 Subsystems

### Subsystem 1 — Cloudflare AI Gateway Log Collection

This subsystem supports two modes:

- **Logpush mode:** receives encrypted AI Gateway access logs via Cloudflare
  Logpush, transforms them into Loki JSON streams, and pushes them to Grafana
  Cloud Loki.
- **Free Tier proxy-only mode:** routes client traffic through a proxy Worker
  and returns the upstream response. It does not collect AI Gateway access logs.

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
  ├─ validates X-Proxy-Secret
  ├─ forwards request to Cloudflare AI Gateway
  └─ streams AI Gateway response back to client
```

#### Key Design Rules

- **Proxy authentication:** The proxy compares `X-Proxy-Secret` with
  `env.PROXY_SECRET` using a constant-time comparison. Mismatches return `401`.
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
- **Sensitive body handling:** The Worker does not automatically redact enabled
  request bodies, response bodies, or metadata. Treat them as potentially
  containing PII and credentials; sanitize them before enabling the flags, and
  leave the flags disabled when deterministic redaction is unavailable. Keep
  Loki retention within the Grafana Cloud Free Tier limit of 14 days and limit
  access to the minimum Grafana users/teams and a token with only `logs:write`.
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
make typecheck        # TypeScript type check
make test             # run Vitest suite
make fmt              # format Terraform and Workers sources
make validate         # terraform validate (Logpush mode only)
make deploy           # wrangler deploy + terraform apply (Logpush mode only)
make setup-free-tier  # deploy the Free Tier proxy-only Worker
make setup-grafana    # run scripts/tf-apply-grafana.sh to create/rotate Access Policy token and re-register Wrangler secrets
```

### Free Tier Setup (No Logpush)

Use this mode when your Cloudflare account cannot use Workers Logpush because
Logpush and Tail Workers require a Paid Workers plan. The proxy Worker is in
`workers/src/proxy.ts` and is deployed via `wrangler.proxy.jsonc`.
Set `CF_ACCOUNT_ID` and the real `AI_GATEWAY_ID` in that configuration before
running the setup script.

#### One-Command Setup (Recommended)

Run the following script to set up the Proxy Worker automatically:

```bash
bash scripts/setup-free-tier.sh
```

The script performs these steps automatically:

1. Verify `npx`, Wrangler, and `jq`
2. Generate a random `PROXY_SECRET`
3. Register `PROXY_SECRET` on the Proxy Worker
4. Generate `workers/.dev.vars` for local development
5. Deploy the Proxy Worker (`wrangler.proxy.jsonc`)

Alternatively, run `make setup-free-tier` from the repo root.

Proxy-only mode does not send AI Gateway access logs to Grafana Cloud Loki.
Only requests sent through the proxy are forwarded to AI Gateway.

For Logpush mode, create a Cloud Access Policy token with `logs:write` scope in your Grafana instance and register it as a Wrangler secret on `wrangler.jsonc`.

> **Important:** The Cloud Access Policy UI is inside your **Grafana instance**,
> not the grafana.com portal. Navigate to:
> `https://{stack}.grafana.net/admin/access-policies`
> (Administration → Cloud access policies)
>
> **Note:** Grafana Cloud API Keys (from `grafana.com/orgs/.../api-keys`) are
> deprecated. Service Account tokens also **cannot** push to Loki — you must
> use a Cloud Access Policy token with `logs:write` scope.

Set non-secret values in `workers/wrangler.proxy.jsonc` before deploying. `AI_GATEWAY_ID` must match the actual gateway slug, not an arbitrary name.

#### Variable Reference

**Routing variables** (used to build the upstream AI Gateway URL):

- `CF_ACCOUNT_ID` — your Cloudflare account ID
- `AI_GATEWAY_ID` — the AI Gateway slug used in the URL path (e.g., `my-gateway`). **This must match the actual gateway slug**, not an arbitrary name.

**Loki label variables** (low-cardinality labels only, not used for routing):

- `GATEWAY_NAME` — value of the `gateway` label in Loki. Can differ from
  `AI_GATEWAY_ID`; it is a human-readable identifier for dashboards.
- `ENV_LABEL` — value of the `env` label in Loki; e.g., `prod` or `staging`.

Set non-secret values in `workers/wrangler.proxy.jsonc` before deploying.

#### Free Tier Proxy-Only Data Flow

```text
[Client/App]
  └─ calls proxy Worker instead of the AI Gateway URL directly
       ↓
[workers/src/proxy.ts]
  ├─ validates X-Proxy-Secret header
  ├─ forwards method, headers, body, path, and query to Cloudflare AI Gateway
  └─ streams the AI Gateway response back to the client unchanged
       ↓
  [Client receives the upstream response]
```

#### Manual Setup (Alternative)

If you prefer not to use `scripts/setup-free-tier.sh`, register secrets and deploy manually:

```bash
cd workers
npx wrangler secret put PROXY_SECRET --config wrangler.proxy.jsonc
```

Deploy only the proxy Worker:

```bash
cd workers
npx wrangler deploy --config wrangler.proxy.jsonc
```

After deployment, send one client request through the proxy Worker and confirm
that the upstream AI Gateway response is returned. Proxy-only mode does not
send AI Gateway access logs to Loki.

> **Note:** `make deploy`, `make plan`, `make apply`, and `make validate` are
> Logpush-mode commands. Proxy-only mode does not use Terraform Logpush.
> Use `make setup-free-tier` or the manual proxy deployment command above.

## CI/CD

GitHub Actions workflows drive continuous integration and deployment:

- `.github/workflows/ci.yml` runs on every Pull Request and non-`master` push:
  - TypeScript type check, Vitest run, Prettier check
  - Terraform fmt/validate for the Cloudflare and Grafana workspaces
- `.github/workflows/deploy.yml` runs on `master` push and `workflow_dispatch`:
  - Deploys the Proxy Worker, Ollama Cloud Worker, and Provider Metrics Worker via Wrangler
  - Uses the `production` GitHub environment

Required repository secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
Provider Metrics and Ollama Cloud Workers need their own secrets registered via Wrangler before the first deploy.

Configure the GitHub `production` environment with **Required reviewers** and restrict deployment branches to `master` before enabling `deploy.yml`.

## 🛠️ Logpush Setup & Deployment (Workers Paid only)

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
- A Cloudflare API token (requires `Account.Workers Scripts: Edit`, `Account.AI Gateway: Read`, and `User.Memberships: Read` permissions if deploying Workers or managing secrets. This same token is also used as `TF_VAR_cloudflare_api_token` by `make deploy`'s Terraform Logpush apply step, which needs additional Logpush/Logs permissions — see the "⚠️ Operational Notes" section below for the full permission set)

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
- Logpush-only secrets are not required in Proxy-only mode

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

   Before `terraform apply` or `terraform destroy`, also export `CF_API_TOKEN` in
   the same shell. Terraform destroy provisioners inherit this variable because
   they cannot reference normal Terraform variables. The Logpush helper requires
   it to remove the remote job and does not infer it from
   `TF_VAR_cloudflare_api_token`.

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

1. `terraform plan` — confirm only `terraform_data.aig_logpush_job` and its
   Cloudflare API-managed Logpush job are created.
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
- If `make deploy` fails before the Terraform apply step, re-check `scripts/verify-deployment-env.sh` output and the Cloudflare login state.
- If Logpush does not deliver data, confirm the dataset name in `terraform/terraform.tfvars` matches the Cloudflare account and that the RSA public key was uploaded to the Logpush settings.

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

- The Grafana Terraform module uses the Terraform Cloud workspace
  `graft-ai-grafana`; authenticate with `terraform login app.terraform.io` (or
  `TF_TOKEN_app_terraform_io` in automation) before running its setup targets.
  The Cloudflare Terraform module remains separate and uses its own backend
  configuration.
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
  - **Via AI Gateway (OpenAI, Anthropic, etc.):** The Proxy Worker relays these requests when you route traffic through it. You do NOT need to redeploy or rerun `setup-free-tier.sh` when adding models. Simply direct your app's API requests to the Proxy Worker URL.

## 📄 License

See [LICENSE](./LICENSE).
