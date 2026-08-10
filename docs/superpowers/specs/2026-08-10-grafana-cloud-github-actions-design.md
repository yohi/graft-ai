# Grafana Cloud + GitHub Actions デプロイパイプライン設計書

## 1. 背景と目的

`graft-ai` は Cloudflare Workers と Terraform を用いたテレメトリパイプラインである。現在は `make deploy` や各種 `scripts/*.sh` による手動・ローカルデプロイが中心であり、以下の課題がある。

- 本番デプロイが個人のローカル環境に依存している
- CI/CD による継続的な検証と自動デプロイがない
- Terraform state はローカル保存されており、チーム運用や並列実行に不安がある
- PR 時点で Terraform の変更影響や Worker デプロイの成否が確認できない

本設計は、GitHub Actions を用いて上記課題を解消し、安全で再現性の高いデプロイパイプラインを構築することを目的とする。

## 2. ゴールと非ゴール

### 2.1 ゴール

- Pull Request 作成時にテスト、型検査、フォーマット検査、Terraform plan を実行する
- `main` ブランチへの push 時に、Cloudflare Workers（5 種）と Terraform リソースを自動デプロイする
- Terraform state をリモートバックエンド（Terraform Cloud）で管理する
- Wrangler secrets を Terraform 出力から自動反映する仕組みを CI に組み込む
- 将来的な staging / production 分離や追加 Worker に対応できる拡張性を持たせる

### 2.2 非ゴール

- 複数環境（staging / production）の完全分離（単一環境を前提とする）
- Terraform Cloud の VCS 連携を用いた自動 plan（GitHub Actions から手動実行する）
- ローカルデプロイ用スクリプトの廃止（並行して維持する）
- Grafana ダッシュボードの自動生成や Terraform 化（本設計では対象外）

## 3. 前提条件

### 3.1 既存プロジェクト構成

```text
graft-ai/
├── .github/workflows/          # 新規作成
├── scripts/                    # 既存スクリプトを維持・更新
├── terraform/                  # Cloudflare Logpush job
│   ├── main.tf
│   ├── variables.tf
│   └── versions.tf             # 新規：Terraform Cloud backend 設定
├── terraform/grafana/          # Grafana Access Policy + Token
│   ├── main.tf
│   ├── variables.tf
│   └── versions.tf             # 新規：Terraform Cloud backend 設定
├── workers/                    # 5 種の Cloudflare Workers
│   ├── src/
│   ├── package.json
│   ├── wrangler.jsonc          # graft-ai-aig-logpush
│   ├── wrangler.proxy.jsonc    # graft-ai-aig-proxy
│   ├── wrangler.tail.jsonc     # graft-ai-aig-tail
│   ├── wrangler.ollama.jsonc   # graft-ai-ollama-cloud
│   └── wrangler.provider-metrics.jsonc
└── README.md / SPEC.md / Makefile
```

### 3.2 必須 Cloudflare プラン

- Cloudflare Workers Logpush は **Workers Paid plan（$5/月〜）** が必須
- Tail Workers も **Workers Paid / Enterprise** が必須
- AI Gateway のコア機能は Free plan でも利用可能だが、Logpush 機能は Paid plan に限定される

### 3.3 必須アカウント・Secrets

| シークレット | 保存場所 | 用途 |
|-------------|----------|------|
| `TF_API_TOKEN` | GitHub Secrets | Terraform Cloud API 認証 |
| `CLOUDFLARE_API_TOKEN` | GitHub Secrets | Wrangler および Terraform Cloudflare provider 認証 |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Secrets | Wrangler および Terraform Cloudflare provider |

Terraform 変数（sensitive）は Terraform Cloud 各 workspace の Variables に保存する。

## 4. 設計判断

### 4.1 デプロイ対象

Cloudflare Workers 5 種と Terraform 2 ディレクトリを対象とする。

| コンポーネント | 管理方法 | 備考 |
|---------------|----------|------|
| `graft-ai-aig-logpush` | Wrangler deploy | Logpush 宛先として動作 |
| `graft-ai-aig-proxy` | Wrangler deploy | AI Gateway へのプロキシ |
| `graft-ai-aig-tail` | Wrangler deploy | Tail Worker；Loki 送信 |
| `graft-ai-ollama-cloud` | Wrangler deploy | Cron トリガー付き |
| `graft-ai-provider-metrics` | Wrangler deploy | Cron トリガー付き |
| Cloudflare Logpush job | Terraform apply | Workers デプロイ後に実行 |
| Grafana Access Policy + Token | Terraform apply | Worker から独立して管理 |

### 4.2 トリガー戦略

| イベント | ワークフロー | 実行内容 |
|---------|-------------|----------|
| Pull Request 作成・更新 | `ci.yml` | テスト / 型検査 / fmt 検査 / Terraform plan（2 workspace） |
| `main` ブランチ push | `deploy.yml` | Worker 並列デプロイ / Terraform apply / Wrangler secrets 更新 / 検証 |
| 手動 | `deploy.yml` | `workflow_dispatch` でも本番デプロイ可能（将来の選択肢） |

### 4.3 環境戦略

現状は単一環境（production）とし、Wrangler / Terraform の設定に環境名を埋め込まず、将来の分離に備える。

- Wrangler config の `vars.ENV_LABEL` は当面 `prod` のまま維持
- Terraform workspace 名に環境接頭辞を持たせる（例：`graft-ai-cloudflare`、`graft-ai-grafana`）
- 将来 staging を追加する場合は、GitHub Actions ジョブをマトリックス化し、workspace 名を切り替える

### 4.4 Terraform State 管理

**Terraform Cloud（HCP Terraform）を採用する。**

- Workers Paid plan（$5/月）が既に必要なため、Terraform Cloud の追加コストは実質無視できる（管理リソース 3 個で約 $0.30/月）
- state ロックが組み込まれている
- Terraform Cloud Variables で sensitive 値を管理できる
- GitHub Actions 側の Secrets は最小限（`TF_API_TOKEN` のみ）で済む

workspace は **local execution mode** とし、GitHub Actions ランナー上で `terraform init` / `plan` / `apply` / `output` を実行する。これにより、Terraform 出力から Wrangler secrets を取得して登録する step を同一 workflow 内で完結できる。

### 4.5 Wrangler Secrets 管理

Wrangler secrets の登録値は以下の 2 系統に分類する。

| 値 | 取得元 | 更新方法 |
|----|--------|----------|
| `RSA_PRIVATE_KEY_PEM` | 手動生成 | GitHub Secrets または Terraform Cloud variable 経由で CI に渡す |
| `ORIGIN_SECRET` | 手動生成 | GitHub Secrets または Terraform Cloud variable 経由で CI に渡す |
| `GRAFANA_CLOUD_LOKI_URL` | Terraform Cloud output | `terraform output -raw` で取得し `wrangler secret put` |
| `GRAFANA_CLOUD_LOKI_USERNAME` | Terraform Cloud output | `terraform output -raw` で取得し `wrangler secret put` |
| `GRAFANA_CLOUD_ACCESS_POLICY_TOKEN` | Terraform Cloud output | `terraform output -raw` で取得し `wrangler secret put` |

## 5. ワークフロー設計

### 5.1 `ci.yml` — 継続的検証

```yaml
triggers:
  pull_request:
    branches: ['main']
  push:
    branches-ignore: ['main']

jobs:
  test-workers:
    # npm test, typecheck, fmt:check

  terraform-plan-cloudflare:
    # terraform init / plan for terraform/

  terraform-plan-grafana:
    # terraform init / plan for terraform/grafana/
```

### 5.2 `deploy.yml` — 本番自動デプロイ

```yaml
triggers:
  push:
    branches: ['main']
  workflow_dispatch:

concurrency:
  group: graft-ai-terraform-apply
  cancel-in-progress: false

jobs:
  deploy-logpush-worker:
    # wrangler deploy --config wrangler.jsonc

  deploy-proxy-worker:
    # wrangler deploy --config wrangler.proxy.jsonc

  deploy-tail-worker:
    # wrangler deploy --config wrangler.tail.jsonc

  deploy-ollama-worker:
    # wrangler deploy --config wrangler.ollama.jsonc

  deploy-provider-metrics-worker:
    # wrangler deploy --config wrangler.provider-metrics.jsonc

  terraform-apply-cloudflare:
    needs: [deploy-logpush-worker, deploy-proxy-worker, ...]
    # terraform init / apply for terraform/

  terraform-apply-grafana:
    needs: [deploy-logpush-worker, deploy-proxy-worker, ...]
    # terraform init / apply for terraform/grafana/

  update-wrangler-secrets:
    needs: [terraform-apply-grafana]
    # terraform output -raw + wrangler secret put

  verify-deployment:
    needs: [terraform-apply-cloudflare, terraform-apply-grafana, update-wrangler-secrets]
    # 疎通確認 / verify-deployment-env.sh 相当
```

### 5.3 Concurrency 制御

Terraform apply は同時実行を禁止する。

```yaml
concurrency:
  group: terraform-apply
  cancel-in-progress: false
```

Wrangler deploy は並列実行可能であるが、同一 Worker 名に対する同時更新は Wrangler 側で直列化されるため、同一 workflow 内での並列は許容する。

## 6. Terraform Cloud 設定

### 6.1 Workspace 構成

| Workspace | パス | Execution mode | Variables |
|-----------|------|----------------|-----------|
| `graft-ai-cloudflare` | `terraform/` | local | `cloudflare_account_id`, `cloudflare_api_token`, `workers_subdomain`, `origin_secret`, `grafana_cloud_loki_url`, `grafana_cloud_loki_username`, `grafana_cloud_access_policy_token`, `rsa_private_key_pem` |
| `graft-ai-grafana` | `terraform/grafana/` | local | `grafana_cloud_api_key`, `grafana_stack_slug` |

### 6.2 Backend 設定（versions.tf）

各 `terraform/` 配下に以下を追加する。

```hcl
terraform {
  cloud {
    organization = "graft-ai"
    workspaces {
      name = "graft-ai-cloudflare" # or "graft-ai-grafana"
    }
  }
  required_providers { ... }
}
```

## 7. 実装後の既存スクリプトの扱い

| スクリプト | 扱い |
|-----------|------|
| `scripts/setup.sh` | ローカル初期セットアップ用に維持 |
| `scripts/setup-free-tier.sh` | ローカル初期セットアップ用に維持 |
| `scripts/setup-grafana.sh` | ローカル初期セットアップ用に維持 |
| `scripts/deploy.sh` | CI 用の参照実装として更新、または CI 専用スクリプトを新設 |
| `scripts/verify-deployment-env.sh` | CI 検証 step として再利用 |
| `scripts/tf-apply-grafana.sh` | 参考として維持、または CI 用に簡略化 |

## 8. セキュリティ考慮

- すべての API token、private key、access policy token は GitHub Secrets または Terraform Cloud Variables（sensitive）に保存する
- `terraform output` で取得した sensitive 値は GitHub Actions の step 間で `::add-mask::` を自動適用されるようにする
- `CLOUDFLARE_API_TOKEN` は最小権限（Workers、Logpush、Account 読み取り）に設定する
- Terraform Cloud の `TF_API_TOKEN` は Team token または Organization token を使用し、必要最小限の workspace 権限を付与する

## 9. エラー処理・通知

- `deploy.yml` 失敗時は、失敗したジョブ名と step を GitHub Actions 通知で受け取る
- 将来的に Slack / メール通知を追加する場合は、別途通知 workflow を設ける
- Terraform apply 失敗時は、GitHub Actions の concurrency 制御により次回の apply はロックが自動解除されるまで待機する

## 10. テスト戦略

| 対象 | 方法 |
|------|------|
| TypeScript コード | `npm test`, `npm run typecheck`, `npm run fmt:check` |
| Terraform | `terraform fmt -check`, `terraform validate`, `terraform plan` |
| デプロイ後検証 | `verify-deployment-env.sh` 相当のチェック、Loki エンドポイント疎通確認 |

## 11. 将来の拡張

- staging 環境追加：workspace 名を環境ごとに分け、GitHub Actions マトリックスで切り替え
- Grafana ダッシュボードの Terraform 化：`terraform/grafana/` に `grafana_dashboard` リソースを追加
- 通知連携：Slack / Discord 通知 step の追加
- Terraform Cloud remote execution mode への移行：必要に応じて API 経由で output 取得

## 12. リスクと対策

| リスク | 対策 |
|--------|------|
| Terraform apply の並列実行による state 破損 | Terraform Cloud のロック + GitHub Actions concurrency 制御 |
| Wrangler secret 登録値のマスク漏れ | `wrangler secret put` 実行前に `::add-mask::` を明示的に呼び出す |
| Terraform Cloud local execution mode の差異 | CI 用コンテナイメージを固定し、Terraform バージョンをワークフローでピン留め |
| `main` マージ時の誤デプロイ | main ブランチ保護ルールと PR レビューを維持 |

---

*設計承認日：2026-08-10*
