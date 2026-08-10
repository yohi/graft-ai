# Grafana Cloud + GitHub Actions デプロイパイプライン 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull Request 時にはテスト・型検査・fmt・Terraform plan を自動実行し、`master` push 時には 5 種の Cloudflare Workers と Terraform リソースを GitHub Actions 経由で自動デプロイするパイプラインを構築する。

**Architecture:** Terraform state は HCP Terraform（Terraform Cloud）の local execution mode で一元管理し、GitHub Actions ランナー上で `terraform init` / `plan` / `apply` / `output` を実行する。Wrangler deploy は並列実行し、Terraform apply は workflow / job レベルの concurrency で直列化する。Terraform 出力・GitHub Secrets から取得した sensitive 値を `::add-mask::` した上で Wrangler secrets を更新する。Grafana outputs は job outputs で secret を渡さず、Terraform apply job が短期 artifact に保存し、secret 更新 job が取得する。

**Tech Stack:** GitHub Actions, HCP Terraform, Terraform Cloud backend, Cloudflare Wrangler, Node.js/npm, Bash.

## Global Constraints

- Terraform version floor: `>= 1.5.0`
- Cloudflare provider: `~> 5.0`; Grafana provider: `~> 3.0`
- Node.js LTS + npm; Worker commands run from `workers/`
- Secrets are **never** committed or placed in `*.tfvars`; use GitHub Secrets and `TF_VAR_*` environment variables
- `CLOUDFLARE_API_TOKEN` minimum permissions: `Logs: Write`, `Workers Scripts: Edit`, `AI Gateway: Read`, `Memberships: Read`
- `TF_API_TOKEN` must be separate from `CLOUDFLARE_API_TOKEN`
- Production deploys require GitHub repository **Environments → production** with Required reviewers + `master` deployment branch policy
- Terraform apply concurrency group: `graft-ai-terraform-apply`, `cancel-in-progress: false`
- Loki labels stay strictly `model`, `status_code`, `env`, `gateway` — do not add high-cardinality labels
- Wrangler `vars.ENV_LABEL` remains `prod` for the single-environment deployment

---

## ファイル構成マップ

| ファイル | 責務 |
|----------|------|
| `.github/workflows/ci.yml` | PR/push 時の継続的検証（test/typecheck/fmt/Terraform validate/plan） |
| `.github/workflows/deploy.yml` | `master` push / workflow_dispatch 時の本番デプロイ |
| `scripts/ci-update-wrangler-secrets.sh` | Terraform 出力 + GitHub Secrets から Wrangler secrets を更新 |
| `scripts/ci-verify-deployment.sh` | デプロイ後の Tail Worker / proxy tail-consumer / Loki ingestion 検証 |
| `terraform/versions.tf` | Cloudflare workspace 用 Terraform Cloud backend 設定 |
| `terraform/grafana/versions.tf` | Grafana workspace 用 Terraform Cloud backend 設定 |
| `Makefile` | `validate-grafana`, `plan-grafana`, `apply-grafana` など CI と対になるローカルターゲット |
| `README.md` | CI/CD セクション追加（PR 3 で実施） |

## PR 分割方針

本機能は **3 つの stacked PR** で実装する。レビュー・リスクを分離し、各 PR は独立してマージできるよう最小の差分にする。

| PR | ブランチ | ベース | 内容 | 主な変更ファイル |
|----|----------|--------|------|------------------|
| **PR 1** | `feat/tf-cloud-backend` | `master` | Terraform Cloud backend 設定 + ローカル Makefile 対称性 | `terraform/versions.tf`, `terraform/grafana/versions.tf`, `Makefile` |
| **PR 2** | `feat/ci-workflow` | `feat/tf-cloud-backend` | PR/push 時の CI 検証 workflow | `.github/workflows/ci.yml` |
| **PR 3** | `feat/deploy-workflow` | `feat/ci-workflow` | `master` 自動デプロイ workflow + ヘルパースクリプト | `.github/workflows/deploy.yml`, `scripts/ci-update-wrangler-secrets.sh`, `scripts/ci-verify-deployment.sh`, `README.md` |

PR スタックは `gh-stack` または手動で管理する。マージ順序は PR 1 → PR 2 → PR 3。

---

## PR 1: Terraform Cloud Backend + ローカル Makefile 対称性

### Task 1.1: Cloudflare workspace 用 Terraform Cloud backend

**Files:**
- Modify: `terraform/versions.tf:1-19`

**Interfaces:**
- Produces: `terraform { cloud { organization = "..." workspaces { name = "..." } } }` block in `terraform/versions.tf`

- [ ] **Step 1: 編集内容を確認**

既存の `terraform/versions.tf` を開き、コメントアウトされた S3 backend ブロックを Terraform Cloud backend に置き換える。

- [ ] **Step 2: 実装**

```hcl
terraform {
  required_version = ">= 1.5.0"

  cloud {
    organization = "graft-ai"
    workspaces {
      name = "graft-ai-cloudflare"
    }
  }

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}
```

- [ ] **Step 3: ローカル検証**

```bash
export TF_API_TOKEN="<your-hcp-terraform-api-token>"
terraform -chdir=terraform init -input=false
terraform -chdir=terraform validate
```

Expected: `init` が HCP Terraform workspace に接続し、`validate` が PASS すること。

- [ ] **Step 4: Commit**

```bash
git add terraform/versions.tf
git commit -m "feat(terraform): add Terraform Cloud backend for cloudflare workspace"
```

### Task 1.2: Grafana workspace 用 Terraform Cloud backend

**Files:**
- Modify: `terraform/grafana/versions.tf:1-16`

**Interfaces:**
- Produces: `terraform { cloud { ... } }` block in `terraform/grafana/versions.tf`

- [ ] **Step 1: 実装**

```hcl
terraform {
  required_version = ">= 1.5.0"

  cloud {
    organization = "graft-ai"
    workspaces {
      name = "graft-ai-grafana"
    }
  }

  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "~> 3.0"
    }
  }
}
```

- [ ] **Step 2: ローカル検証**

```bash
export TF_API_TOKEN="<your-hcp-terraform-api-token>"
export TF_VAR_grafana_cloud_api_key="<grafana-cloud-api-key>"
export TF_VAR_grafana_stack_slug="<stack-slug>"
terraform -chdir=terraform/grafana init -input=false
terraform -chdir=terraform/grafana validate
```

Expected: `init` が HCP Terraform workspace に接続し、`validate` が PASS すること。

- [ ] **Step 3: Commit**

```bash
git add terraform/grafana/versions.tf
git commit -m "feat(terraform): add Terraform Cloud backend for grafana workspace"
```

### Task 1.3: Makefile に Grafana 用ターゲットを追加

**Files:**
- Modify: `Makefile:49-53` 以降に追記

**Interfaces:**
- Produces: `validate-grafana`, `plan-grafana`, `apply-grafana` Makefile targets

- [ ] **Step 1: 実装**

末尾に以下を追記する。

```make
.PHONY: validate-grafana plan-grafana apply-grafana

validate-grafana:
	terraform -chdir=terraform/grafana init -backend=false
	terraform -chdir=terraform/grafana validate

plan-grafana:
	terraform -chdir=terraform/grafana init
	terraform -chdir=terraform/grafana plan

apply-grafana:
	terraform -chdir=terraform/grafana init
	terraform -chdir=terraform/grafana apply
```

- [ ] **Step 2: 検証**

```bash
make validate
make validate-grafana
```

Expected: 両方の `validate` ターゲットが正常終了する。

- [ ] **Step 3: Commit**

```bash
git add Makefile
git commit -m "chore(makefile): add grafana terraform targets for local parity"
```

### Task 1.4: PR 1 作成前チェック

- [ ] HCP Terraform organization 名 `graft-ai` を実際の organization 名に置き換えたことを確認
- [ ] HCP Terraform 上に `graft-ai-cloudflare` と `graft-ai-grafana` workspace を作成済み（local execution mode）
- [ ] `TF_API_TOKEN` が workspace 操作用に発行済み
- [ ] Grafana token の有効期限 `8760h` を確認し、期限前 rotation 手順を運用に登録済み
- [ ] Grafana token rotation は「新 token を Terraform で発行 → Terraform output から取得 → Wrangler と Worker secrets を更新・検証 → 旧 token を revoke」の順で実施し、初回発行だけでなく期限前にも繰り返す
- [ ] PR 1 を作成（base: `master`, head: `feat/tf-cloud-backend`）

---

## PR 2: CI Workflow（Pull Request / 非 master push）

### Task 2.1: `.github/workflows/ci.yml` を作成

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `workers/package.json` scripts (`test`, `typecheck:ci`, `fmt:check`), `terraform/versions.tf`, `terraform/grafana/versions.tf`
- Produces: GitHub Actions workflow that runs on every PR and non-master push

- [ ] **Step 1: workflow ファイルを作成**

```yaml
name: CI

on:
  pull_request:
    branches: [master]
  push:
    branches-ignore: [master]

jobs:
  checks:
    name: Test / Typecheck / Format / Terraform Validate
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: workers/package-lock.json

      - name: Install Worker dependencies
        working-directory: workers
        run: npm ci

      - name: Type check Workers
        working-directory: workers
        run: npm run typecheck:ci

      - name: Run Worker tests
        working-directory: workers
        run: npm test

      - name: Check formatting
        working-directory: workers
        run: npm run fmt:check

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "1.10.0"
          terraform_wrapper: false

      - name: Terraform fmt check
        run: terraform fmt -check -recursive

      - name: Terraform validate (cloudflare)
        run: |
          terraform -chdir=terraform init -backend=false
          terraform -chdir=terraform validate

      - name: Terraform validate (grafana)
        run: |
          terraform -chdir=terraform/grafana init -backend=false
          terraform -chdir=terraform/grafana validate

  plan-cloudflare:
    name: Terraform Plan (cloudflare)
    runs-on: ubuntu-latest
    needs: [checks]
    if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]'
    env:
      TF_API_TOKEN: ${{ secrets.TF_READONLY_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
      TF_VAR_cloudflare_account_id: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
      TF_VAR_cloudflare_api_token: ${{ secrets.CLOUDFLARE_READONLY_API_TOKEN }}
      TF_VAR_workers_subdomain: ${{ vars.WORKERS_SUBDOMAIN }}
      TF_VAR_logpush_dataset: ${{ vars.LOGPUSH_DATASET || 'ai_gateway_events' }}
      TF_VAR_worker_script_name: ${{ vars.WORKER_SCRIPT_NAME || 'graft-ai-aig-logpush' }}
      TF_VAR_logpush_job_name: ${{ vars.LOGPUSH_JOB_NAME || 'graft-ai-aig-logpush' }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "1.10.0"
          terraform_wrapper: false

      - name: Terraform init
        working-directory: terraform
        run: terraform init -input=false

      - name: Terraform plan
        working-directory: terraform
        run: terraform plan -input=false -no-color

  plan-grafana:
    name: Terraform Plan (grafana)
    runs-on: ubuntu-latest
    needs: [checks]
    if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]'
    env:
      TF_API_TOKEN: ${{ secrets.TF_READONLY_API_TOKEN }}
      TF_VAR_grafana_cloud_api_key: ${{ secrets.GRAFANA_READONLY_API_KEY }}
      TF_VAR_grafana_stack_slug: ${{ vars.GRAFANA_STACK_SLUG }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "1.10.0"
          terraform_wrapper: false

      - name: Terraform init
        working-directory: terraform/grafana
        run: terraform init -input=false

      - name: Terraform plan
        working-directory: terraform/grafana
        run: terraform plan -input=false -no-color
```

- [ ] **Step 2: GitHub 設定確認**

以下の Secrets / Variables をリポジトリに登録済みであることを確認。

Secrets:
- `TF_API_TOKEN`（production apply 用）
- `TF_READONLY_API_TOKEN`（PR plan 用）
- `CLOUDFLARE_API_TOKEN`（production deploy/apply 用）
- `CLOUDFLARE_READONLY_API_TOKEN`（PR plan 用）
- `GRAFANA_CLOUD_LOKI_URL`
- `GRAFANA_CLOUD_LOKI_USERNAME`
- `GRAFANA_CLOUD_ACCESS_POLICY_TOKEN`
- `ORIGIN_SECRET`
- `RSA_PRIVATE_KEY_PEM`
- `GRAFANA_READONLY_API_KEY`（PR plan 用）
- `GRAFANA_CLOUD_API_KEY`（production apply 用）

Repository Variables:
- `CLOUDFLARE_ACCOUNT_ID`
- `WORKERS_SUBDOMAIN`
- `GRAFANA_STACK_SLUG`
- `LOGPUSH_DATASET`（省略時デフォルト）
- `WORKER_SCRIPT_NAME`（省略時デフォルト）
- `LOGPUSH_JOB_NAME`（省略時デフォルト）

- [ ] **Step 3: PR 上で workflow 実行を確認**

PR 2 を作成後、`checks` job が全て PASS し、`plan-cloudflare` / `plan-grafana` が secrets を必要として動作することを確認。

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add pull-request checks and terraform plan workflow"
```

---

## PR 3: CD Workflow（master 自動デプロイ）

### Task 3.1: Wrangler secrets 更新用ヘルパースクリプト

**Files:**
- Create: `scripts/ci-update-wrangler-secrets.sh`

**Interfaces:**
- Consumes: env vars `GRAFANA_LOKI_URL`, `GRAFANA_LOKI_USERNAME`, `GRAFANA_LOKI_TOKEN`, `ORIGIN_SECRET`, `RSA_PRIVATE_KEY_PEM`, `PROXY_SECRET`, plus `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` for Wrangler auth; Grafana outputs are loaded from the short-lived `grafana-outputs.env` artifact
- Produces: updated Wrangler secrets on `graft-ai-aig-logpush`, `graft-ai-aig-tail`, `graft-ai-aig-proxy`

- [ ] **Step 1: スクリプトを作成**

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${GITHUB_WORKSPACE:-$(cd "$(dirname "$0")/.." && pwd)}"
WORKERS_DIR="${REPO_ROOT}/workers"

cd "$WORKERS_DIR"

printf '::add-mask::%s\n' "${GRAFANA_LOKI_URL:-}"
printf '::add-mask::%s\n' "${GRAFANA_LOKI_USERNAME:-}"
printf '::add-mask::%s\n' "${GRAFANA_LOKI_TOKEN:-}"
printf '::add-mask::%s\n' "${ORIGIN_SECRET:-}"
printf '::add-mask::%s\n' "${RSA_PRIVATE_KEY_PEM:-}"
printf '::add-mask::%s\n' "${PROXY_SECRET:-}"

register_secret() {
  local config="$1"
  local secrets_file="$2"

  [[ -s "$secrets_file" ]] || {
    echo "[ERROR] secrets file for $config is empty or missing" >&2
    exit 1
  }

  npx wrangler secret bulk "$secrets_file" --config "$config"
}

umask 077
TAIL_SECRETS_FILE=$(mktemp)
LOGPUSH_SECRETS_FILE=$(mktemp)
PROXY_SECRETS_FILE=$(mktemp)
trap 'rm -f "$TAIL_SECRETS_FILE" "$LOGPUSH_SECRETS_FILE" "$PROXY_SECRETS_FILE"' EXIT

cat > "$TAIL_SECRETS_FILE" <<EOF
GRAFANA_CLOUD_LOKI_URL=${GRAFANA_LOKI_URL}
GRAFANA_CLOUD_LOKI_USERNAME=${GRAFANA_LOKI_USERNAME}
GRAFANA_CLOUD_ACCESS_POLICY_TOKEN=${GRAFANA_LOKI_TOKEN}
EOF
cat > "$LOGPUSH_SECRETS_FILE" <<EOF
GRAFANA_CLOUD_LOKI_URL=${GRAFANA_LOKI_URL}
GRAFANA_CLOUD_LOKI_USERNAME=${GRAFANA_LOKI_USERNAME}
GRAFANA_CLOUD_ACCESS_POLICY_TOKEN=${GRAFANA_LOKI_TOKEN}
ORIGIN_SECRET=${ORIGIN_SECRET}
RSA_PRIVATE_KEY_PEM=${RSA_PRIVATE_KEY_PEM}
EOF
cat > "$PROXY_SECRETS_FILE" <<EOF
PROXY_SECRET=${PROXY_SECRET}
EOF

register_secret "wrangler.tail.jsonc" "$TAIL_SECRETS_FILE"
register_secret "wrangler.jsonc" "$LOGPUSH_SECRETS_FILE"
register_secret "wrangler.proxy.jsonc" "$PROXY_SECRETS_FILE"

echo "Wrangler secrets updated."
```

- [ ] **Step 2: 実行権限付与**

```bash
chmod +x scripts/ci-update-wrangler-secrets.sh
```

- [ ] **Step 3: ローカル dry-run 確認（オプション）**

```bash
bash -n scripts/ci-update-wrangler-secrets.sh
```

Expected: シンタックスエラーがないこと。

- [ ] **Step 4: Commit**

```bash
git add scripts/ci-update-wrangler-secrets.sh
git commit -m "feat(scripts): add ci helper to update wrangler secrets from terraform output"
```

### Task 3.2: デプロイ検証用ヘルパースクリプト

**Files:**
- Create: `scripts/ci-verify-deployment.sh`

**Interfaces:**
- Consumes: env vars `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `WORKERS_SUBDOMAIN`, `PROXY_SECRET`, `GRAFANA_LOKI_URL`, `GRAFANA_LOKI_USERNAME`, `GRAFANA_LOKI_TOKEN`, optional `LOGPUSH_JOB_ID`; uses `X-Request-ID` as the telemetry correlation ID and queries Loki `query_range`
- Requires: `workers/src/proxy.ts` must preserve the incoming `X-Request-ID` as telemetry `request_id`; add or retain a regression test in `workers/tests/proxy.test.ts`
- Produces: exit 0 if all verifications pass

- [ ] **Step 1: スクリプトを作成**

```bash
#!/usr/bin/env bash
set -euo pipefail

API_BASE="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}"

fail() {
  echo "[ERROR] $*" >&2
  exit 1
}

echo "Checking Tail Worker script exists..."
curl -sS --connect-timeout 5 --max-time 15 --retry 3 --retry-delay 2 --retry-max-time 20 -o /dev/null -w "%{http_code}" "${API_BASE}/workers/scripts/graft-ai-aig-tail" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  | grep -Eq '^200$' || fail "Tail Worker not found"

echo "Checking proxy tail consumer configuration..."
curl -sS --connect-timeout 5 --max-time 15 --retry 3 --retry-delay 2 --retry-max-time 20 "${API_BASE}/workers/scripts/graft-ai-aig-proxy/script-settings" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  > /tmp/proxy_script_settings.json
jq -e '.success and any(.result.tail_consumers[]?; .service == "graft-ai-aig-tail")' /tmp/proxy_script_settings.json >/dev/null \
  || fail "proxy tail consumer configuration missing"

PROXY_URL="https://graft-ai-aig-proxy.${WORKERS_SUBDOMAIN}.workers.dev"
echo "Sending test request to proxy: ${PROXY_URL}"
CORRELATION_ID="graft-ai-ci-$(date +%s)-${RANDOM}"
HTTP_STATUS=$(curl -sS --connect-timeout 5 --max-time 30 -o /dev/null -w "%{http_code}" \
  -X POST "${PROXY_URL}/workers-ai/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "X-Proxy-Secret: ${PROXY_SECRET}" \
  -H "X-Request-ID: ${CORRELATION_ID}" \
  -d "{\"model\":\"@cf/meta/llama-3.2-1b-instruct\",\"messages\":[{\"role\":\"user\",\"content\":\"graft-ai ci ping\"}]}" \
  || echo "000")

# Only documented successful or authentication responses are acceptable.
if [[ ! "$HTTP_STATUS" =~ ^2[0-9][0-9]$ && "$HTTP_STATUS" != "401" && "$HTTP_STATUS" != "403" ]]; then
  fail "Proxy request failed with HTTP ${HTTP_STATUS}"
fi

echo "Proxy returned HTTP ${HTTP_STATUS}; polling Loki for ${CORRELATION_ID}..."
deadline=$((SECONDS + 60))
found=false
while (( SECONDS < deadline )); do
  LOKI_RESPONSE=$(curl -sS --connect-timeout 5 --max-time 15 --retry 2 --retry-delay 1 --retry-max-time 10 \
    -w '\n%{http_code}' -u "${GRAFANA_LOKI_USERNAME}:${GRAFANA_LOKI_TOKEN}" \
    --get --data-urlencode "query={request_id=\"${CORRELATION_ID}\"}" \
    --data-urlencode "limit=10" \
    "${GRAFANA_LOKI_URL}/loki/api/v1/query_range" || printf '\n000')
  LOKI_STATUS="${LOKI_RESPONSE##*$'\n'}"
  LOKI_BODY="${LOKI_RESPONSE%$'\n'*}"
  [[ "$LOKI_STATUS" == "200" ]] || fail "Loki query returned HTTP ${LOKI_STATUS}"
  if jq -e --arg id "$CORRELATION_ID" 'any(.data.result[]?.values[]?; (.[1] | fromjson? | .request_id) == $id)' <<<"$LOKI_BODY" >/dev/null; then
    found=true
    break
  fi
  sleep 5
done
[[ "$found" == true ]] || fail "Loki did not contain matching request ${CORRELATION_ID} before timeout"

if [[ -n "${LOGPUSH_JOB_ID:-}" ]]; then
  echo "Checking Logpush job ${LOGPUSH_JOB_ID}..."
  curl -sS --connect-timeout 5 --max-time 15 --retry 3 --retry-delay 2 --retry-max-time 20 "${API_BASE}/logpush/jobs/${LOGPUSH_JOB_ID}" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    | jq -e '.success and .result.enabled == true' >/dev/null \
    || fail "Logpush job check failed"
fi

echo "Deployment verification passed."
```

- [ ] **Step 2: 実行権限付与**

```bash
chmod +x scripts/ci-verify-deployment.sh
```

- [ ] **Step 3: Proxy correlation contract を確認**

`workers/src/proxy.ts` の telemetry 生成処理で、incoming `X-Request-ID` を `request_id` に優先して保存する。`workers/tests/proxy.test.ts` に、Cloudflare AI Gateway の `cf-aig-request-id` と異なる `X-Request-ID` を送信した場合でも、telemetry の `request_id` が correlation ID になる回帰テストを追加または維持する。

```bash
make test
make typecheck
```

Expected: proxy correlation test が PASS し、TypeScript typecheck も PASS すること。

- [ ] **Step 4: Commit**

```bash
git add scripts/ci-verify-deployment.sh workers/src/proxy.ts workers/tests/proxy.test.ts
git commit -m "feat(ci): verify proxy correlation ID reaches Loki"
```

### Task 3.3: `.github/workflows/deploy.yml` を作成

**Files:**
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: `scripts/ci-update-wrangler-secrets.sh`, `scripts/ci-verify-deployment.sh`, Terraform outputs `grafana_loki_url`, `grafana_loki_username`, `grafana_loki_write_token`
- Produces: fully automated production deploy workflow

- [ ] **Step 1: workflow ファイルを作成**

```yaml
name: Deploy

on:
  push:
    branches: [master]
  workflow_dispatch:

concurrency:
  group: graft-ai-terraform-apply
  cancel-in-progress: false

jobs:
  deploy-logpush-worker:
    name: Deploy Logpush Worker
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/master'
    environment: production
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: workers/package-lock.json

      - name: Install Worker dependencies
        working-directory: workers
        run: npm ci

      - name: Deploy with Wrangler
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: workers
          command: deploy --config wrangler.jsonc

  deploy-tail-worker:
    name: Deploy Tail Worker
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/master'
    environment: production
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: workers/package-lock.json

      - name: Install Worker dependencies
        working-directory: workers
        run: npm ci

      - name: Deploy with Wrangler
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: workers
          command: deploy --config wrangler.tail.jsonc

  deploy-proxy-worker:
    name: Deploy Proxy Worker
    runs-on: ubuntu-latest
    needs: [deploy-tail-worker]
    if: github.ref == 'refs/heads/master'
    environment: production
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: workers/package-lock.json

      - name: Install Worker dependencies
        working-directory: workers
        run: npm ci

      - name: Deploy with Wrangler
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: workers
          command: deploy --config wrangler.proxy.jsonc

  deploy-ollama-worker:
    name: Deploy Ollama Worker
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/master'
    environment: production
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: workers/package-lock.json

      - name: Install Worker dependencies
        working-directory: workers
        run: npm ci

      - name: Deploy with Wrangler
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: workers
          command: deploy --config wrangler.ollama.jsonc

  deploy-provider-metrics-worker:
    name: Deploy Provider Metrics Worker
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/master'
    environment: production
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: workers/package-lock.json

      - name: Install Worker dependencies
        working-directory: workers
        run: npm ci

      - name: Deploy with Wrangler
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: workers
          command: deploy --config wrangler.provider-metrics.jsonc

  terraform-apply-cloudflare:
    name: Terraform Apply (cloudflare)
    runs-on: ubuntu-latest
    needs:
      - deploy-logpush-worker
      - deploy-proxy-worker
      - deploy-ollama-worker
      - deploy-provider-metrics-worker
    if: github.ref == 'refs/heads/master'
    environment: production
    concurrency:
      group: graft-ai-terraform-apply
      cancel-in-progress: false
    env:
      TF_API_TOKEN: ${{ secrets.TF_API_TOKEN }}
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      TF_VAR_cloudflare_account_id: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      TF_VAR_cloudflare_api_token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      TF_VAR_grafana_cloud_loki_url: ${{ secrets.GRAFANA_CLOUD_LOKI_URL }}
      TF_VAR_grafana_cloud_loki_username: ${{ secrets.GRAFANA_CLOUD_LOKI_USERNAME }}
      TF_VAR_grafana_cloud_access_policy_token: ${{ secrets.GRAFANA_CLOUD_ACCESS_POLICY_TOKEN }}
      TF_VAR_origin_secret: ${{ secrets.ORIGIN_SECRET }}
      TF_VAR_rsa_private_key_pem: ${{ secrets.RSA_PRIVATE_KEY_PEM }}
      TF_VAR_workers_subdomain: ${{ vars.WORKERS_SUBDOMAIN }}
      TF_VAR_logpush_dataset: ${{ vars.LOGPUSH_DATASET || 'ai_gateway_events' }}
      TF_VAR_worker_script_name: ${{ vars.WORKER_SCRIPT_NAME || 'graft-ai-aig-logpush' }}
      TF_VAR_logpush_job_name: ${{ vars.LOGPUSH_JOB_NAME || 'graft-ai-aig-logpush' }}
    outputs:
      logpush_job_id: ${{ steps.tf_output.outputs.logpush_job_id }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "1.10.0"
          terraform_wrapper: false

      - name: Terraform init
        working-directory: terraform
        run: terraform init -input=false

      - name: Terraform apply
        working-directory: terraform
        run: terraform apply -auto-approve -input=false

      - name: Capture outputs
        id: tf_output
        working-directory: terraform
        run: |
          echo "logpush_job_id=$(terraform output -raw logpush_job_id)" >> "$GITHUB_OUTPUT"

  terraform-apply-grafana:
    name: Terraform Apply (grafana)
    runs-on: ubuntu-latest
    needs:
      - deploy-logpush-worker
      - deploy-proxy-worker
      - deploy-ollama-worker
      - deploy-provider-metrics-worker
    if: github.ref == 'refs/heads/master'
    environment: production
    concurrency:
      group: graft-ai-terraform-apply
      cancel-in-progress: false
    env:
      TF_API_TOKEN: ${{ secrets.TF_API_TOKEN }}
      TF_VAR_grafana_cloud_api_key: ${{ secrets.GRAFANA_CLOUD_API_KEY }}
      TF_VAR_grafana_stack_slug: ${{ vars.GRAFANA_STACK_SLUG }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "1.10.0"
          terraform_wrapper: false

      - name: Terraform init
        working-directory: terraform/grafana
        run: terraform init -input=false

      - name: Terraform apply
        working-directory: terraform/grafana
        run: terraform apply -auto-approve -input=false

  update-wrangler-secrets:
    name: Update Wrangler Secrets
    runs-on: ubuntu-latest
    needs: [terraform-apply-cloudflare, terraform-apply-grafana]
    if: github.ref == 'refs/heads/master'
    environment: production
    env:
      TF_API_TOKEN: ${{ secrets.TF_API_TOKEN }}
      TF_VAR_grafana_cloud_api_key: ${{ secrets.GRAFANA_CLOUD_API_KEY }}
      TF_VAR_grafana_stack_slug: ${{ vars.GRAFANA_STACK_SLUG }}
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      ORIGIN_SECRET: ${{ secrets.ORIGIN_SECRET }}
      RSA_PRIVATE_KEY_PEM: ${{ secrets.RSA_PRIVATE_KEY_PEM }}
      PROXY_SECRET: ${{ secrets.PROXY_SECRET }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: workers/package-lock.json

      - name: Install Worker dependencies
        working-directory: workers
        run: npm ci

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "1.10.0"
          terraform_wrapper: false

      - name: Terraform init (Grafana)
        working-directory: terraform/grafana
        run: terraform init -input=false

      - name: Load Grafana outputs from Terraform state
        working-directory: terraform/grafana
        run: |
          LOKI_URL=$(terraform output -raw grafana_loki_url)
          LOKI_USER=$(terraform output -raw grafana_loki_username)
          LOKI_TOKEN=$(terraform output -raw grafana_loki_write_token)
          echo "::add-mask::${LOKI_URL}"
          echo "::add-mask::${LOKI_USER}"
          echo "::add-mask::${LOKI_TOKEN}"
          {
            printf 'GRAFANA_LOKI_URL=%q\n' "$LOKI_URL"
            printf 'GRAFANA_LOKI_USERNAME=%q\n' "$LOKI_USER"
            printf 'GRAFANA_LOKI_TOKEN=%q\n' "$LOKI_TOKEN"
          } >> "$GITHUB_ENV"

      - name: Update secrets
        run: bash scripts/ci-update-wrangler-secrets.sh

  verify-deployment:
    name: Verify Deployment
    runs-on: ubuntu-latest
    needs:
      - terraform-apply-cloudflare
      - terraform-apply-grafana
      - update-wrangler-secrets
    if: github.ref == 'refs/heads/master'
    environment: production
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      WORKERS_SUBDOMAIN: ${{ vars.WORKERS_SUBDOMAIN }}
      PROXY_SECRET: ${{ secrets.PROXY_SECRET }}
      GRAFANA_LOKI_URL: ${{ secrets.GRAFANA_CLOUD_LOKI_URL }}
      GRAFANA_LOKI_USERNAME: ${{ secrets.GRAFANA_CLOUD_LOKI_USERNAME }}
      GRAFANA_LOKI_TOKEN: ${{ secrets.GRAFANA_CLOUD_ACCESS_POLICY_TOKEN }}
      LOGPUSH_JOB_ID: ${{ needs.terraform-apply-cloudflare.outputs.logpush_job_id }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Run verification
        run: bash scripts/ci-verify-deployment.sh
```

- [ ] **Step 2: YAML 構文検証**

```bash
python3 - <<'PY'
import yaml
with open('.github/workflows/deploy.yml') as f:
    yaml.safe_load(f)
print('deploy.yml OK')
PY
```

Expected: YAML parse 成功。

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: add master deploy workflow for workers and terraform"
```

### Task 3.4: README.md に CI/CD セクションを追加

**Files:**
- Modify: `README.md`（"Quick Commands" または新規セクション）

**Interfaces:**
- Produces: documentation for CI/CD usage and required secrets/variables

- [ ] **Step 1: セクションを追加**

`README.md` の "Quick Commands" の直後に以下を追加する。

```markdown
## CI/CD

GitHub Actions workflows drive continuous integration and deployment:

- `.github/workflows/ci.yml` runs on every Pull Request and non-`master` push:
  - `npm run typecheck:ci`, `npm test`, `npm run fmt:check`
  - `terraform fmt -check -recursive` and `terraform validate` for both workspaces
  - `terraform plan` for both workspaces on trusted internal PRs only
- `.github/workflows/deploy.yml` runs on `master` push and `workflow_dispatch`:
  - Deploys all five Workers via Wrangler
  - Applies both Terraform workspaces in the `production` GitHub environment
  - Updates Wrangler secrets from Terraform outputs and GitHub Secrets
  - Verifies Tail Worker, proxy tail consumer, and Loki ingestion

Required repository secrets: `TF_API_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `GRAFANA_CLOUD_API_KEY`, `ORIGIN_SECRET`, `RSA_PRIVATE_KEY_PEM`, `PROXY_SECRET`.

Required repository variables: `WORKERS_SUBDOMAIN`, `GRAFANA_STACK_SLUG`.
Optional repository variables: `LOGPUSH_DATASET`, `WORKER_SCRIPT_NAME`, `LOGPUSH_JOB_NAME`.

Configure the GitHub `production` environment with **Required reviewers** and restrict deployment branches to `master` before enabling `deploy.yml`.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add ci/cd section to readme"
```

### Task 3.5: PR 3 作成前チェック

- [ ] `deploy.yml` の YAML 構文を検証済み
- [ ] `ci.yml` の PR plan jobs が production environment を参照せず、plan 専用 read-only credentials のみを使用することを確認
- [ ] GitHub `production` environment が Required reviewers + `master` branch policy で設定済み
- [ ] `scripts/ci-update-wrangler-secrets.sh` と `scripts/ci-verify-deployment.sh` に実行権限がある
- [ ] PR 3 を作成（base: `feat/ci-workflow`, head: `feat/deploy-workflow`）

---

## Self-Review

### 1. Spec coverage

| 設計書セクション | 実装タスク |
|----------------|------------|
| §2.1 PR 時のテスト・型検査・fmt・Terraform plan | PR 2 `ci.yml`（checks + plan jobs） |
| §2.1 `master` push 時の Worker + Terraform 自動デプロイ | PR 3 `deploy.yml` |
| §2.1 Terraform state をリモートバックエンド管理 | PR 1 `versions.tf` x2 |
| §2.1 Wrangler secrets を Terraform 出力から自動反映 | PR 3 `update-wrangler-secrets` job + `scripts/ci-update-wrangler-secrets.sh` |
| §4.3 `production` environment + `master` 制限 | PR 3 各 deploy/apply ジョブに `environment: production` と `if: github.ref == 'refs/heads/master'` |
| §4.5 Terraform Cloud local execution mode + TF_VAR_* 注入 | PR 2/3 の env ブロック（PR plan は read-only credentials、production apply は production credentials） |
| §4.6 Wrangler secrets 更新順序 | `scripts/ci-update-wrangler-secrets.sh` の Worker 単位 bulk 登録順 |
| §5.3 concurrency 制御 | PR 3 workflow-level + job-level `graft-ai-terraform-apply` |
| §6.2 backend 設定 | PR 1 `cloud {}` ブロック |
| §8 マスク・最小権限 | PR 3 `::add-mask::`、PR 2/3 env 注入 |
| §10 デプロイ後検証 | PR 3 `verify-deployment` job + `scripts/ci-verify-deployment.sh`（status allowlist、timeout/retry、correlation ID の Loki query_range 検証を含む） |

### 2. Placeholder scan

- 「TBD/TODO/実装後」等の文字は含めていない。
- 全タスクに具体的なコード、コマンド、期待結果を記述している。
- 関数・ジョブ名はタスク間で一致している。

### 3. Type / naming consistency

- Terraform workspace 名: `graft-ai-cloudflare`, `graft-ai-grafana`
- Concurrency group: `graft-ai-terraform-apply`
- Wrangler config ファイル名: `wrangler.jsonc`, `wrangler.proxy.jsonc`, `wrangler.tail.jsonc`, `wrangler.ollama.jsonc`, `wrangler.provider-metrics.jsonc`
- Terraform 出力名: `logpush_job_id`（cloudflare）, `grafana_loki_url` / `grafana_loki_username` / `grafana_loki_write_token`（grafana）
- Environment: `production`

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-11-grafana-cloud-github-actions-pipeline.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per PR/task, review between tasks, fast iteration. Required sub-skill: `superpowers:subagent-driven-development`.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach would you like?
