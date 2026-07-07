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
series、50GB logs）の制約内で動作するように最適化されています。デフォルトのデプロイ経路は Cloudflare
**Workers Logpush** を使用し、これには **Cloudflare Workers Paid plan** が必要です。一方で、Cloudflare
Worker と Tail Worker で通信を中継する **Free Tier proxy mode** も利用できるため、Logpush job なしでも運用できます。
> **注記:** Tail Worker の利用には **Cloudflare Workers Paid または Enterprise plan** が必要です。"Free Tier" は Grafana Cloud の無料枠を指し、Cloudflare の無料プランではありません。

### 📊 機能サポート・ロードマップ マトリクス

本プロジェクトの現在のサポート状況、および将来の対応予定は以下の通りです。

| 機能 / プロバイダ | 現在できること (現状のサポート) | できないこと / 制限事項 | 将来の対応予定 (ロードマップ) |
| :--- | :--- | :--- | :--- |
| **Workers AI** | AI Gateway を経由したログの収集と Grafana Loki への転送 (Logpush / Free Proxy 両モード対応) | - | - |
| **OpenAI (via AI Gateway)** | AI Gateway を経由したログの収集と Grafana Loki への転送 | usage API を介した直接の使用量取得 | usage API を介した usage scraping 機能 (個別 API キーからの直接取得) |
| **Anthropic (via AI Gateway)** | AI Gateway を経由したログの収集と Grafana Loki への転送 | usage API を介した直接の使用量取得 | - |
| **Ollama Cloud** | セッション/週次のレートリミットリセット時間の算出と Grafana Metrics (Prometheus 形式) への転送 | リアルタイムアクセスログの転送 | リセット時間アンカーの動的な自動検出（現在は固定値ベース） |
| **OpenAI (直接接続)** | - (AI Gateway 経由のみ) | APIキーを指定した使用量データの直接取得 | OpenAI API からの使用量データの自動定期スクレイピング |


## 🏗️ アーキテクチャ

- **Cloudflare AI Gateway:** Workers
  Logpush 経由でプロキシログとレイテンシを Grafana Loki に送信します。
- **OpenAI GPT Usage:** Management
  API からトークン消費量とドル建てコストを取得し、Grafana
  Prometheus に送ります。
- **Ollama Cloud:** 設定されたアンカー時刻と間隔から session / weekly
  レート制限リセット時刻を派生させ、Grafana Cloud Metrics に push します。

## 📁 ディレクトリ構成

```text
graft-ai/
├── workers/          # AI Gateway telemetry 用 TypeScript Cloudflare Workers
│   ├── src/
│   │   ├── index.ts      # fetch handler: auth → decompress → decrypt → transform → push
│   │   ├── proxy.ts      # Free Tier proxy: client → AI Gateway + telemetry log
│   │   ├── tail-worker.ts # Tail Worker: telemetry log → Loki
│   │   ├── crypto.ts     # 暗号化フィールド向け RSA-OAEP unwrap + AES-GCM decrypt
│   │   ├── transform.ts  # NDJSON → Loki JSON streams（labels, timestamp, log line）
│   │   ├── loki.ts       # Basic Auth と 429 retry を持つ Loki HTTP push client
│   │   ├── types.ts      # 共有 TypeScript 型
│   │   ├── ollama-cloud.ts      # Cron Worker: reset メトリクスを派生させ Grafana に push
│   │   └── ollama-cloud/        # reset 計算機 + OTLP/JSON メトリクス client
│   │       ├── calc.ts
│   │       └── prometheus.ts
│   ├── tests/        # Vitest による unit / integration tests（50 cases）
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── wrangler.jsonc       # Logpush mode Worker config
│   ├── wrangler.proxy.jsonc # Free Tier proxy Worker config
│   ├── wrangler.tail.jsonc  # Free Tier Tail Worker config
│   └── wrangler.ollama.jsonc # Ollama Cloud reset metrics Worker config
├── grafana/
│   └── dashboards/
│       ├── graft-ai-overview.json      # AI Gateway ダッシュボード定義（13 パネル）
│       └── graft-ai-ollama-cloud.json  # Ollama Cloud reset metrics ダッシュボード
├── scripts/
│   ├── setup.sh              # ワンコマンドセットアップ（Free Tier proxy mode）
│   └── setup-free-tier.sh   # 旧スクリプト: setup.sh に統合済み
├── terraform/        # Terraform: Cloudflare Logpush job + Grafana リソース（optional）
│   ├── main.tf
│   ├── variables.tf
│   ├── outputs.tf
│   ├── grafana.tf       # Grafana Cloud provider: Access Policy + token（optional）
│   └── versions.tf
├── tests/fixtures/   # AI Gateway NDJSON サンプル fixture
├── Makefile          # install, typecheck, test, fmt, validate, deploy, setup-free-tier, setup-grafana 用ターゲット
├── README.md         # 英語版 README
└── README.ja.md      # このファイル
```

## 🔌 サブシステム

### Subsystem 1 — Cloudflare AI Gateway ログ収集

このサブシステムは2つのモードをサポートします。

- **Logpush mode:** Cloudflare Logpush から暗号化された AI Gateway
  アクセスログを受信し、Loki JSON streams へ変換して Grafana Cloud Loki に push します。
- **Free Tier proxy mode:** client traffic を proxy Worker 経由にし、request ごとに marker 付きの構造化
  `console.log()` telemetry line を出力します。Tail Worker がそのログを Loki 形式へ変換し、Grafana Cloud
  Loki に push します。

#### データフロー

##### Logpush Mode (Workers Paid Plan)

```text
[Cloudflare AI Gateway] ── logs ──→ [Cloudflare Logpush]
                                       ↓ gzip + RSA-encrypted NDJSON
[Cloudflare Workers - workers/src/index.ts]
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

##### Free Tier Proxy Mode (Logpush 不要)

```text
[Client/App]
  └─ AI Gateway ではなく proxy Worker を直接呼ぶ
       ↓
[Cloudflare Workers - workers/src/proxy.ts]
  ├─ Cloudflare AI Gateway にリクエストを forward
  ├─ AI Gateway response を client にそのまま返す
  └─ request ごとに JSON telemetry line を1行出力
       ↓ Tail Worker logs
[Cloudflare Workers - workers/src/tail-worker.ts]
  ├─ marker 付き console.log line を filter
  ├─ telemetry を transform.ts と同じ AI Gateway log shape に変換
  └─ loki.ts 経由で Loki JSON streams を push
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
make typecheck        # TypeScript type check
make test             # Vitest suite を実行
make fmt              # Terraform と Workers source を format
make validate         # terraform validate（Logpush mode only）
make deploy           # wrangler deploy + terraform apply（Logpush mode only）
make setup-free-tier  # scripts/setup.sh を実行（Free Tier proxy mode、ワンコマンド）
make setup-grafana    # scripts/tf-apply-grafana.sh を実行し、Access Policy トークンの作成/ローテーションと Wrangler シークレットの再登録を行う
```

### Free Tier セットアップ（No Logpush）

Cloudflare アカウントで Workers Logpush を使えない場合は、このモードを使います。Logpush は Paid Workers plan が必要です。既存の Logpush receiver は `workers/src/index.ts` に残し、`wrangler.jsonc` でデプロイします。Free Tier proxy Worker は `workers/src/proxy.ts` にあり、`wrangler.proxy.jsonc` でデプロイします。Tail Worker は `workers/src/tail-worker.ts` にあり、`wrangler.tail.jsonc` でデプロイします。

#### ワンコマンドセットアップ（推奨）

次のスクリプトで Free Tier パイプライン全体を自動セットアップできます。

```bash
bash scripts/setup.sh
```

スクリプトは次の 10 ステップを自動で実行します。

1. 前提ツールの確認（`npx wrangler`、`curl`、`jq`、`gcx`）
2. `gcx` ログイン状態の確認
3. `gcx` API を使用した Loki 接続情報（URL、ユーザー名）の自動取得
4. Cloud Access Policy トークンの取得（Terraform による自動構築、または手動入力フォールバック）
5. Cloudflare AI Gateway ID の自動検出（`CF_ACCOUNT_ID` は `wrangler.proxy.jsonc` から読み取られ、未設定または初期値の場合は処理を中断）
6. `PROXY_SECRET` の自動生成
7. Proxy Worker および Tail Worker への Wrangler secrets（`PROXY_SECRET`等）の登録
8. ローカル開発用の `.dev.vars` ファイルの生成
9. Tail Worker（`wrangler.tail.jsonc`）および Proxy Worker（`wrangler.proxy.jsonc`）のデプロイ
10. `gcx` API を使用した Grafana ダッシュボード（`grafana/dashboards/graft-ai-overview.json`）の自動インポートとサマリー表示

`make setup-free-tier` でも実行できます。

#### Cloud Access Policy トークン

Tail Worker が Grafana Cloud Loki にログを push するには、`logs:write` スコープを持つ **Cloud Access Policy トークン**が必要です。

> **重要:** Cloud Access Policy の UI は grafana.com ポータルではなく、**Grafana インスタンス内**にあります。
> 次の URL からアクセスしてください:
> `https://{stack}.grafana.net/admin/access-policies`
> （Administration → Cloud access policies）
>
> **注意:** Grafana Cloud API Key（`grafana.com/orgs/.../api-keys`）は**廃止**されています。Service Account トークンも Loki への push には**使えません**。`logs:write` スコープを持つ Cloud Access Policy トークンを必ず使用してください。

`scripts/setup.sh` は gcx CLI 経由で Loki URL と username を自動取得します。Access Policy トークンの作成のみ手動で行い、プロンプトに貼り付けてください。

#### 変数リファレンス

**ルーティング変数**（上流 AI Gateway URL の構築に使用）:

- `CF_ACCOUNT_ID` — Cloudflare アカウント ID
- `AI_GATEWAY_ID` — URL パス中の AI Gateway スラッグ（例: `my-gateway`）。`scripts/setup.sh` が自動検出します。**実際の gateway スラッグと一致している必要があります**。

**Loki ラベル変数**（低カーディナリティラベルのみ、ルーティングには不要）:

- `GATEWAY_NAME` — Loki の `gateway` ラベル値。`AI_GATEWAY_ID` と別でも構いません。ダッシュボード向けの識別子です。
- `ENV_LABEL` — Loki の `env` ラベル値。例: `prod`、`staging`。

デプロイ前に非シークレット値を `workers/wrangler.proxy.jsonc` に記入してください。

#### Free Tier データフロー

```text
[Client/App]
  └─ AI Gateway URL を直接呼ばず、proxy Worker を呼び出す
       ↓
[workers/src/proxy.ts]
  ├─ X-Proxy-Secret ヘッダーを検証
  ├─ method, headers, body, path, query を Cloudflare AI Gateway に forward
  ├─ AI Gateway response を client へそのまま返す
  └─ "_graft_ai_telemetry": true 付きの JSON telemetry line を 1 request につき 1 行出力
       ↓ Tail Worker logs
[workers/src/tail-worker.ts]
  ├─ marker 付き console.log line を filter
  ├─ telemetry を transform.ts と同じ AI Gateway log shape に変換
  └─ loki.ts 経由で Loki JSON streams を push
```



## 🛠️ Logpush セットアップとデプロイ（Workers Paid）

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
- Cloudflare API token (Workers のデプロイやシークレットの書き込みを行う場合、`Account.Workers Scripts: Edit`、`Account.AI Gateway: Read`、`User.Memberships: Read` の権限を持つトークンが必要です)

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
- **対応サービス (LLM) プロバイダの追加・拡張:**
  - **AI Gateway 経由での利用 (OpenAI, Anthropic 等):** すでにデプロイ済みの Proxy Worker がリクエストを自動で中継するため、`setup.sh` の再実行や再デプロイは不要です。アプリ側の接続先を Proxy Worker URL に向け、各モデルを設定するだけで収集されます。
  - **新規 Worker や独自の API キーの追加:** 将来的に AI Gateway 以外の収集 Worker や、プロバイダ固有の API キーを増やす場合は、`setup.sh` に新しい Worker のデプロイ処理やシークレット設定を追加した上で、スクリプトを再実行して適用してください。

## 📄 ライセンス

[LICENSE](./LICENSE) を参照してください。
