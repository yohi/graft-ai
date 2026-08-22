# Grafana Cloud + GitHub Actions デプロイパイプライン設計書

> **適用範囲:** この文書は Workers Paid plan の Logpush/Tail Worker と Terraform
> を含む旧デプロイ設計を記録したものです。現在の production CD は
> `docs/superpowers/plans/2026-08-13-proxy-only-deploy-workflow.md` に定義された
> proxy-only構成へ置き換えられており、Proxy/Ollama/Provider Metrics Worker と
> 明示的に選択した Grafana dashboard および alert rules を配備します。以下の5
> Worker/Terraform自動 deploy要件は現行CDの要件ではありません。

## 1. 背景と目的

`graft-ai` は Cloudflare Workers と Terraform を用いたテレメトリパイプラインである。
本番デプロイは `.github/workflows/deploy.yml` の production CD が担い、`make deploy` や
各種 `scripts/*.sh` は手動・ローカル運用にも維持されている。現行の production CD は
Proxy Worker、Ollama Cloud Worker、Provider Metrics Worker、Grafana dashboards、および
`scripts/deploy-alert-rules.mjs` による Grafana alert rules を配備する。

- ローカル運用と production CD の責務・対象範囲が分かれている
- CI/CD による継続的な検証と自動デプロイの対象範囲を明文化する必要がある
- Terraform state はローカル保存されており、チーム運用や並列実行に不安がある
- PR 時点で Terraform の変更影響や Worker デプロイの成否が確認できない

本設計は、GitHub Actions を用いて上記課題を解消し、安全で再現性の高いデプロイパイプラインを構築することを目的とする。

## 2. ゴールと非ゴール

### 2.1 ゴール

- Pull Request 作成時にテスト、型検査、フォーマット検査、Terraform plan を実行する
- `master` ブランチへの push 時に、Cloudflare Workers（3 種）、Grafana dashboards、
  および Grafana alert rules を自動デプロイする
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
| `GRAFANA_CLOUD_LOKI_URL` | GitHub Secrets | Cloudflare Logpush Terraform の Loki destination |
| `GRAFANA_CLOUD_LOKI_USERNAME` | GitHub Secrets | Cloudflare Logpush Terraform の Loki tenant ID |
| `GRAFANA_CLOUD_ACCESS_POLICY_TOKEN` | GitHub Secrets | Cloudflare Logpush Terraform の Loki `logs:write` token |

`CLOUDFLARE_API_TOKEN` は account-scope の `Logs: Write`、`Workers Scripts: Edit`、
`AI Gateway: Read`、`Memberships: Read` を含む最小権限 token とする。
`TF_API_TOKEN` は HCP Terraform の workspace 操作用であり、Cloudflare API token
とは別の secret とする。`TF_API_TOKEN` だけでは local Terraform CLI の入力変数や
provider 認証情報を満たせないため、各 job へ必要な値を明示的に注入する。

Terraform の sensitive 変数は、後述する local execution mode では GitHub Secrets
から `TF_VAR_*` として各 job に注入する。HCP Terraform Variables は state と
workspace の管理情報として保持するが、GitHub Actions の local run に自動注入
される前提にはしない。特に Cloudflare 側の `terraform/` には
`TF_VAR_grafana_cloud_loki_url`、`TF_VAR_grafana_cloud_loki_username`、
`TF_VAR_grafana_cloud_access_policy_token` も必要である。

fork および Dependabot の Pull Request では通常の repository Secrets が利用できない
場合がある。Secrets 不要の test / typecheck / fmt / Terraform validate workflow と、
信頼済みコードでのみ実行する Terraform plan workflow を分離する。fork・Dependabot
の PR は secret を必要とする plan の対象外とし、`pull_request_target` で PR のコードを
checkout または実行しない。

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
| `master` ブランチ push | `deploy.yml` | Worker 並列デプロイ / Terraform apply / Wrangler secrets 更新 / 検証 |
| 手動 | `deploy.yml` | `workflow_dispatch` で `master` ref を選択した場合のみ本番デプロイ可能 |

### 4.3 本番デプロイ保護

本番デプロイは GitHub Actions の `production` environment を経由させる。
`deploy.yml` の全デプロイ関連ジョブには `environment: production` と
`if: github.ref == 'refs/heads/master'` を設定し、`workflow_dispatch` で
`master` 以外の ref が選択された場合はジョブを実行しない。

リポジトリ管理者は、ワークフローを有効化する前に GitHub repository settings の
**Environments → production** で次を設定する。

- **Required reviewers** に、本番デプロイを承認できる maintainer を 1 名以上登録する。
- **Deployment branches and tags** を `Selected branches and tags` にし、`master` のみを許可する。
- 必要に応じて、承認待ち時間を制御する wait timer と、環境へアクセス可能な repository roles を設定する。

`environment: production` の記述だけでは承認やブランチ制限は発生しないため、上記の
GitHub 側設定を本番デプロイの必須前提とする。設定後は、environment の存在、Required
reviewers、`master` の deployment branch policy を GitHub UI または API で確認する。

### 4.4 環境戦略

現状は単一環境（production）とし、Wrangler / Terraform の設定に環境名を埋め込まず、将来の分離に備える。

- Wrangler config の `vars.ENV_LABEL` は当面 `prod` のまま維持
- Terraform workspace 名に環境接頭辞を持たせる（例：`graft-ai-cloudflare`、`graft-ai-grafana`）
- 将来 staging を追加する場合は、GitHub Actions ジョブをマトリックス化し、workspace 名を切り替える

### 4.5 Terraform State 管理

**Terraform Cloud（HCP Terraform）を採用する。**

- Workers Paid plan（$5/月）が既に必要なため、Terraform Cloud の追加コストは実質無視できる（管理リソース 3 個で約 $0.30/月）
- state ロックが組み込まれている
- Terraform Cloud Variables で sensitive 値を管理できる
- GitHub Actions 側では `TF_API_TOKEN` に加えて、local execution に必要な
  `TF_VAR_*` と provider 環境変数を各 job へ明示的に注入する

workspace は **local execution mode** とし、GitHub Actions ランナー上で `terraform init` / `plan` / `apply` / `output` を実行する。これにより、Terraform 出力から Wrangler secrets を取得して登録する step を同一 workflow 内で完結できる。

各 Terraform job は同じ変数契約を使用する。Cloudflare 側の job には GitHub
Secrets から `TF_VAR_cloudflare_account_id`、`TF_VAR_cloudflare_api_token`、
`TF_VAR_workers_subdomain`、`TF_VAR_origin_secret`、`TF_VAR_rsa_private_key_pem` を
注入する。さらに `GRAFANA_CLOUD_LOKI_URL`、`GRAFANA_CLOUD_LOKI_USERNAME`、
`GRAFANA_CLOUD_ACCESS_POLICY_TOKEN` から、それぞれ
`TF_VAR_grafana_cloud_loki_url`、`TF_VAR_grafana_cloud_loki_username`、
`TF_VAR_grafana_cloud_access_policy_token` を設定する。Cloudflare provider 用の
`CLOUDFLARE_API_TOKEN` も同じ token に設定する。
`logpush_dataset`、`worker_script_name`、`logpush_job_name`、upload 制限値は非 secret
の repository variable または workspace 固有の `TF_VAR_*` として明示的に設定する。
Grafana 側の job には GitHub Secrets から `TF_VAR_grafana_cloud_api_key` と
`TF_VAR_grafana_stack_slug` を注入する。HCP Terraform の Variables は state / workspace
管理用に保持するが、local execution の Terraform CLI へ自動注入される前提にはしない。
Grafana の Loki output は `update-wrangler-secrets` が取得して Tail Worker に渡す。
`terraform-apply-cloudflare` は Grafana Terraform の output を参照せず、
`terraform-apply-grafana` に依存しない。Cloudflare 側の Terraform に必要な Loki URL、
username、Access Policy token は GitHub Secrets から直接注入する。

### 4.6 Wrangler Secrets 管理

Wrangler secrets の登録値は以下の 2 系統に分類する。

| Worker | Config | Secret |
|--------|--------|--------|
| `graft-ai-aig-logpush` | `workers/wrangler.jsonc` | `ORIGIN_SECRET`, `RSA_PRIVATE_KEY_PEM`, `GRAFANA_CLOUD_LOKI_URL`, `GRAFANA_CLOUD_LOKI_USERNAME`, `GRAFANA_CLOUD_ACCESS_POLICY_TOKEN` |
| `graft-ai-aig-tail` | `workers/wrangler.tail.jsonc` | `GRAFANA_CLOUD_LOKI_URL`, `GRAFANA_CLOUD_LOKI_USERNAME`, `GRAFANA_CLOUD_ACCESS_POLICY_TOKEN` |
| `graft-ai-aig-proxy` | `workers/wrangler.proxy.jsonc` | `PROXY_SECRET` |

`update-wrangler-secrets` は次の順序で、表に記載した対応する `--config` を
指定して、上記すべての Secret を更新する。

1. Grafana Terraform output から Loki URL、username、Access Policy token を取得し、
   Logpush Worker と Tail Worker の両方へ登録する。
2. GitHub Secret から `ORIGIN_SECRET` と `RSA_PRIVATE_KEY_PEM` を読み取り、Logpush
   Worker へ登録する。
3. GitHub Secret の `PROXY_SECRET` を Proxy Worker へ登録する。
4. Tail Worker の存在、Proxy Worker の Tail consumer、Loki ingestion を検証する。

Ollama、provider-metrics Worker の provider 固有 Secret は本 workflow の管理対象外で
あり、独立した運用手順で登録する。

## 5. ワークフロー設計

### 5.1 `ci.yml` — 継続的検証

```yaml
on:
  pull_request:
    branches: ['master']
  push:
    branches-ignore: ['master']

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
on:
  push:
    branches: ['master']
  workflow_dispatch:

concurrency:
  group: graft-ai-terraform-apply
  cancel-in-progress: false

jobs:
  deploy-logpush-worker:
    if: github.ref == 'refs/heads/master'
    environment: production
    # wrangler deploy --config wrangler.jsonc

  deploy-proxy-worker:
    needs: [deploy-tail-worker]
    if: github.ref == 'refs/heads/master'
    environment: production
    # wrangler deploy --config wrangler.proxy.jsonc

  deploy-tail-worker:
    if: github.ref == 'refs/heads/master'
    environment: production
    # wrangler deploy --config wrangler.tail.jsonc

  deploy-ollama-worker:
    if: github.ref == 'refs/heads/master'
    environment: production
    # wrangler deploy --config wrangler.ollama.jsonc

  deploy-provider-metrics-worker:
    if: github.ref == 'refs/heads/master'
    environment: production
    # wrangler deploy --config wrangler.provider-metrics.jsonc

  terraform-apply-cloudflare:
    needs: [deploy-logpush-worker, deploy-proxy-worker, deploy-ollama-worker, deploy-provider-metrics-worker]
    if: github.ref == 'refs/heads/master'
    environment: production
    concurrency:
      group: graft-ai-terraform-apply
      cancel-in-progress: false
    # GitHub Secrets → TF_VAR_* と CLOUDFLARE_API_TOKEN を env に設定し、
    # terraform init -input=false / terraform apply -auto-approve for terraform/

  terraform-apply-grafana:
    needs: [deploy-logpush-worker, deploy-proxy-worker, deploy-ollama-worker, deploy-provider-metrics-worker]
    if: github.ref == 'refs/heads/master'
    environment: production
    concurrency:
      group: graft-ai-terraform-apply
      cancel-in-progress: false
    # GitHub Secrets → TF_VAR_grafana_cloud_api_key / TF_VAR_grafana_stack_slug を env に設定し、
    # terraform init -input=false / terraform apply -auto-approve for terraform/grafana/

  update-wrangler-secrets:
    needs: [terraform-apply-grafana]
    if: github.ref == 'refs/heads/master'
    environment: production
    # checkout, setup Terraform CLI, set TF_API_TOKEN and required TF_VAR_* values, then
    # terraform -chdir=terraform/grafana init -input=false before terraform output -raw
    # and wrangler secret put with each worker's explicit --config

  verify-deployment:
    needs: [terraform-apply-cloudflare, terraform-apply-grafana, update-wrangler-secrets]
    if: github.ref == 'refs/heads/master'
    environment: production
    # Tail Worker existence, proxy tail-consumer configuration, and Loki ingestion
    # after a real proxy request; Logpush mode additionally runs the Logpush smoke test.
```

### 5.3 Concurrency 制御

Terraform apply は同時実行を禁止する。

```yaml
concurrency:
  group: terraform-apply
  cancel-in-progress: false
```

上記の workflow-level concurrency は維持し、同一 workflow run 内の
`terraform-apply-cloudflare` と `terraform-apply-grafana` にも同じ job-level group
`graft-ai-terraform-apply` を設定する。これにより実行中の apply は 1 件、保留中の
apply は 1 件だけとなり、後続 run が到着した場合は古い保留 run を置き換える。
`cancel-in-progress: false` により実行中の apply はキャンセルしない。

Wrangler deploy は並列実行可能であるが、同一 Worker 名に対する同時更新は Wrangler 側で直列化されるため、同一 workflow 内での並列は許容する。

## 6. Terraform Cloud 設定

### 6.1 Workspace 構成

| Workspace | パス | Execution mode | Variables |
|-----------|------|----------------|-----------|
| `graft-ai-cloudflare` | `terraform/` | local | `cloudflare_account_id`, `cloudflare_api_token`, `grafana_cloud_loki_url`, `grafana_cloud_loki_username`, `grafana_cloud_access_policy_token`, `workers_subdomain`, `origin_secret`, `rsa_private_key_pem` |
| `graft-ai-grafana` | `terraform/grafana/` | local | `grafana_cloud_api_key`, `grafana_stack_slug` |

Workspace Variables は workspace の管理情報としても同じ変数名で登録するが、local
execution の GitHub Actions runner には自動注入されない。したがって、ワークフローでは
GitHub Secrets を `TF_VAR_*` と provider 環境変数へ明示的にマッピングする。

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

既存の local state を HCP Terraform backend へ移行する場合は、通常 CI と分離した
一回限りの migration workflow を実行する。

1. `terraform.tfstate` と `terraform.tfstate.backup` を暗号化された保管場所へ退避し、
   backup の hash と resource count を記録する。秘密値をログや artifact に出力しない。
2. 対象ディレクトリで Terraform CLI と `TF_API_TOKEN` を準備し、backend 設定を追加する。
3. `terraform init -input=false -migrate-state -force-copy` を実行して state を HCP
   Terraform workspace へ移行する。移行確認は migration workflow 内でのみ行う。
4. HCP Terraform の state version が更新され、resource count が移行前と一致することを
   Terraform API または workspace UI で確認する。
5. `terraform plan` を実行し、意図しない create / destroy がないことを確認する。

移行後の通常 CI は migration flag を使わず、`terraform init -input=false` の後に
`terraform plan` または保存済み plan file に対する `terraform apply` を実行する。

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
- `terraform output -raw` で取得した各 sensitive 値は、変数に格納した直後、
  `wrangler secret put` に渡す前に `echo "::add-mask::${VALUE}"` で明示的に mask する。
  masking は自動適用されるとみなさない。
- secret を `set -x` の command expansion、通常ログ、artifact、job output、
  `GITHUB_ENV`、`GITHUB_OUTPUT` に書き出さない。Terraform の plan / output も
  `-no-color` と secret の非表示を徹底する。
- `CLOUDFLARE_API_TOKEN` は account-scope の Workers Scripts: Edit、Logs: Write、
  AI Gateway: Read、Memberships: Read を含む最小権限に設定する。
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
| デプロイ後検証 | `verify-deployment-env.sh` 相当のチェック、Tail Worker 存在確認、実リクエスト後の Loki ingestion 確認 |
| Logpush smoke test | `terraform output -raw logpush_job_id` を取得し、Cloudflare API の `GET /accounts/{account_id}/logpush/jobs/{job_id}` で job の存在、dataset、destination、enabled 状態を確認 |

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
| `master` マージ時の誤デプロイ | master ブランチ保護ルールと PR レビューを維持 |

---

*設計承認日：2026-08-10*
