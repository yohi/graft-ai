<!-- markdownlint-disable MD013 -->

# graft-ai

Grafana Cloud 向けの Cloudflare AI Gateway、OpenAI、Ollama
Cloud テレメトリ（メトリクス/ログ）集約基盤です。

English version: [README.md](./README.md)

---

## 📌 概要

`graft-ai`
は、複数の AI プロバイダーエンドポイントから得られるコスト、トークン使用量、アクセスログを、統一された
**Grafana Cloud** ダッシュボードへ集約するためのテレメトリパイプラインです。

本プロジェクトは **Grafana Cloud Free Tier**（14日間保持、10k active
series、50GB logs）の制約内で動作するように最適化されています。

## 🏗️ アーキテクチャ

- **Cloudflare AI Gateway:** Workers
  Logpush 経由でプロキシログとレイテンシを Grafana Loki に送信します。
- **OpenAI GPT Usage:** Management
  API からトークン消費量とドル建てコストを取得し、Grafana
  Prometheus に送ります。
- **Ollama Cloud:** GPU 実行時間メトリクスとアカウント制限を Grafana
  Prometheus で追跡します。

## 📁 ディレクトリ構成

```text
graft-ai/
├── workers/          # AI Gateway ログ収集用 TypeScript Cloudflare Worker
│   ├── src/
│   │   ├── index.ts      # fetch handler: auth → decompress → decrypt → transform → push
│   │   ├── crypto.ts     # 暗号化フィールド向け RSA-OAEP unwrap + AES-GCM decrypt
│   │   ├── transform.ts  # NDJSON → Loki JSON streams（labels, timestamp, log line）
│   │   ├── loki.ts       # Basic Auth と 429 retry を持つ Loki HTTP push client
│   │   └── types.ts      # 共有 TypeScript 型
│   ├── tests/        # Vitest による unit / integration tests（46 cases）
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   └── wrangler.jsonc
├── terraform/        # Terraform: Cloudflare Logpush job のみ（Worker は Wrangler で deploy）
│   ├── main.tf
│   ├── variables.tf
│   ├── outputs.tf
│   └── versions.tf
├── tests/fixtures/   # AI Gateway NDJSON サンプル fixture
├── Makefile          # install, typecheck, test, fmt, validate, deploy 用ターゲット
├── README.md         # 英語版 README
└── README.ja.md      # このファイル
```

## 🔌 サブシステム

### Subsystem 1 — Cloudflare AI Gateway ログ収集

このサブシステムは、Cloudflare Logpush から暗号化された AI
Gateway アクセスログを受信し、Loki JSON streams へ変換して Grafana Cloud
Loki に push します。

#### データフロー

```text
[Cloudflare AI Gateway] ── logs ──→ [Cloudflare Logpush]
                                       ↓ gzip + RSA-encrypted NDJSON
[Cloudflare Workers]
  ├─ X-Origin-Secret header を検証
  ├─ gzip body を解凍
  ├─ 暗号化フィールドを復号（RSA-OAEP unwrap AES key, AES-GCM decrypt）
  ├─ NDJSON lines を parse
  ├─ 各行を Loki stream entry に変換
  │     ├─ timestamp: seconds/milliseconds → nanoseconds
  │     ├─ labels: model, status_code, env, gateway
  │     └─ log line: snake_case の選択フィールド
  └─ HTTPS + Basic Auth で Grafana Cloud Loki に push
```

#### 主要な設計ルール

- **入口認証:** Logpush は `X-Origin-Secret` ヘッダーを送信し、Worker は
  `env.ORIGIN_SECRET` と定数時間比較します。不一致の場合は retry
  loop を避けるため `401` を返します。
- **タイムスタンプ処理:** `RequestTime`
  は10桁以下なら秒、11〜13桁ならミリ秒として扱い、14桁以上は精度損失の可能性があるため拒否します。該当ログ行はスキップされ、ログに記録されます。
- **モデル名正規化:** `@cf/meta/llama-3.1-8b-instruct` のような Cloudflare model
  ID から `llama-3.1-8b-instruct` を抽出します。
- **カーディナリティ制御:** Loki labels は
  `model`、`status_code`、`env`、`gateway` に厳密に限定します。
- **ログ本文フィールド:**
  `request_id`、`cache_status`、`prompt_tokens`、`completion_tokens`、`total_tokens`、`duration_ms`、`path`、`method`
  を含めます。復号済みの `request_body`、`response_body`、`metadata` は
  `env.INCLUDE_*`
  flags が明示的に有効な場合のみ含めます。デフォルトでは prompt、response
  body、metadata の保護のため除外します。
- **Retry policy:** Loki 429
  response は指数バックオフで最大3回 retry します。Loki 側の最終失敗時は upstream の status を返し、Worker 側で
  `429` と `>=500` を `503`、それ以外の non-2xx を `400` に変換します。
- **Security:** Secrets は `*.tfvars` に保存しません。`TF_VAR_*`
  環境変数または Wrangler secrets を使用します。
- **Encryption:** Logpush payload fields は RSA-OAEP で wrap された AES-GCM
  key によって暗号化されます。Worker は設定済み PKCS#8 RSA private
  key（`env.RSA_PRIVATE_KEY_PEM`）で復号します。

#### よく使うコマンド

```bash
make typecheck   # TypeScript type check
make test        # Vitest suite を実行
make fmt         # Terraform と Workers source を format
make validate    # terraform validate
make deploy      # wrangler deploy + terraform apply
```

## 🛠️ セットアップとデプロイ

### クイックスタート

このリポジトリを初めて使う場合は、下の手順を上から順に実行してください。
目標はシンプルで、最後に `make test`、`make validate`、`make deploy` が
ファイル不足や secret 不足で止まらない状態にすることです。

### 必要なもの

- ターミナル
- `workers/` で使う最近の Node.js LTS
- `npm`
- Terraform `>= 1.5.0`
- Cloudflare AI Gateway と Logpush へのアクセス権
- Grafana Cloud Loki の tenant URL、username、access policy token
- Logpush/Logs 権限を持つ Cloudflare API token

### 初回セットアップ

1. Worker ワークスペースから Cloudflare にログインします。

   ```bash
   cd workers
   npx wrangler login
   cd ..
   ```

   ブラウザが開き、ローカル環境と Cloudflare がつながります。

2. 依存関係をインストールし、Worker の型を生成します。

   ```bash
   make install
   ```

   失敗する場合は、`npm` が入っているか、repo ルートで実行しているかを確認
   してください。

3. example file をコピーし、値を適切な場所に入れます。

   ```bash
   cp workers/.dev.vars.example workers/.dev.vars
   cp terraform/terraform.tfvars.example terraform/terraform.tfvars
   ```

   - `workers/.dev.vars` はローカル Worker 開発用です。
   - `terraform/terraform.tfvars` には secret 以外の Terraform 入力だけを置きます。
   - secret 値は `TF_VAR_*` 環境変数か Wrangler secrets に保持します。

4. `workers/.dev.vars` に値を入れます。

   - `GRAFANA_CLOUD_LOKI_URL` - Loki の endpoint
   - `GRAFANA_CLOUD_LOKI_USERNAME` - Loki の tenant ID / username
   - `GRAFANA_CLOUD_ACCESS_POLICY_TOKEN` - Grafana token
   - `ORIGIN_SECRET` - Logpush → Worker 用の共有 secret
   - `RSA_PRIVATE_KEY_PEM` - Logpush payload を復号する private key

   `your-random-origin-secret-here` のような値は、自分で決めた文字列に置き換えて
   ください。

5. `terraform/terraform.tfvars` に値を入れます。

   - `cloudflare_account_id` - Cloudflare account ID
   - `logpush_dataset` - 通常は `ai_gateway_events`
   - `worker_script_name` - Cloudflare 上の Worker script 名
   - `logpush_job_name` - Logpush job の名前
   - `workers_subdomain` - Worker に使う subdomain

6. Worker runtime secrets を Wrangler で設定します。

   ```bash
   cd workers
   npx wrangler secret put ORIGIN_SECRET
   npx wrangler secret put RSA_PRIVATE_KEY_PEM
   npx wrangler secret put GRAFANA_CLOUD_LOKI_URL
   npx wrangler secret put GRAFANA_CLOUD_LOKI_USERNAME
   npx wrangler secret put GRAFANA_CLOUD_ACCESS_POLICY_TOKEN
   cd ..
   ```

   プロンプトが出たら、セットアップ済みの値をそのまま貼り付けます。

7. Terraform variables を shell に export します（commit しないでください）。

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

   Terraform を実行する間は、このターミナルを開いたままにします。

8. デプロイ前にローカルチェックを実行します。

   ```bash
   make typecheck
   make test
   make validate
   ```

   成功とは、これらのコマンドがエラーなしで終わることです。

9. デプロイし、end-to-end で検証します。

   ```bash
   make deploy
   ```

   その後、下記の **Deployment Verification Flow** に従います。

### Deployment Verification Flow

設計時と同じ段階的な検証を行います。

1. `terraform plan` — `cloudflare_logpush_job`
   のみが作成されることを確認します。
2. `make test` — Worker unit / integration tests を実行します。
3. `wrangler dev` — gzipped NDJSON sample payload を POST し、`200`
   が返ることを確認します。
4. Real request — AI
   Gateway 経由で request を送信し、Loki に log が表示されるまで待ちます。
5. Grafana dashboard — `sum by (status_code) (count_over_time(...))`
   が data を返すことを確認します。

### セットアップ時の確認ポイント

- `make install` が失敗する場合は、`npm` が入っているか、repo ルートで実行し
  ているかを確認します。
- Terraform に secret 値を入れないでください。必要な値は `TF_VAR_*`
  環境変数に戻します。
- `make deploy` が Terraform apply の前に失敗する場合は、
  `scripts/verify-deployment-env.sh` の出力と Cloudflare の login 状態を確認します。
- Logpush が届かない場合は、`terraform/terraform.tfvars` の dataset 名が
  Cloudflare アカウントと一致しているか、RSA public key を Logpush settings に
  upload 済みかを確認します。

### コピペ確認リスト

デプロイ前に、次を満たしているか確認してください。

- `workers/.dev.vars` が存在し、ローカル Worker 用の値が入っている
- `terraform/terraform.tfvars` が存在し、secret 以外の値だけが入っている
- `workers/` で `npx wrangler login` を実行済み
- `make install` が成功済み
- `make typecheck`、`make test`、`make validate` がすべて成功済み
- 使っている shell に `TF_VAR_*` 環境変数が入っている

### よくある初心者のミス

- `workers/` ではなく repo ルートで `npx wrangler secret put ...` を実行する
- secret 値を `terraform/terraform.tfvars` に書いてしまう
- `your-random-origin-secret-here` のような placeholder をそのまま残す
- Cloudflare account ID や worker subdomain を間違える
- `make install` を飛ばして先に `make test` を実行する

## ⚠️ 運用メモ

- Terraform state は現在デフォルトでローカル保存です。本番利用前に remote
  encrypted backend（例: S3 with SSE + DynamoDB locking）を設定してください。
- 適用前に Cloudflare API で Cloudflare Logpush dataset
  name と利用可能 field を確認してください（`/accounts/{id}/logpush/datasets/{dataset}/fields`）。`terraform/variables.tf`
  の default dataset は `ai_gateway_events`
  です。アカウントと一致するか確認してください。
- RSA _public_ key を AI Gateway Logpush settings に upload し、private key は
  `TF_VAR_rsa_private_key_pem` に保持します。
- 適用前に Cloudflare API
  token が最小限必要な Logpush/Logs 権限を持つことを確認してください（正確な権限は Cloudflare
  docs を参照してください）。
- **Quota and monitoring:** この pipeline は Grafana Cloud Free
  Tier 向けに設計されています。変換後 log size は 1 request あたり約 0.5〜1.5
  KB（raw は 3〜8 KB）です。100k requests/day の場合、月間約 1.5〜4.5
  GB であり、50 GB/month limit を十分下回ります。デプロイ後は Workers
  Analytics の exceptions/subrequest errors、Logpush `last_delivery`
  status、Grafana Cloud Logs
  Usage を監視し、この見積もりと週次で比較してください。

## 📄 ライセンス

[LICENSE](./LICENSE) を参照してください。
