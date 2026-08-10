<!-- markdownlint-disable MD013 -->

# graft-ai 仕様

English version: [SPEC.md](./SPEC.md)

## 1. 目的

暗号化された Cloudflare AI Gateway access logs を Loki JSON streams に変換し、Grafana Cloud
Loki に push します。同時に、Grafana Cloud Free
Tier の制限（14日間保持、10k active series、50GB logs）内に収めます。

> **注記:** Ollama Cloud のレート制限リセットメトリクスとプロバイダー利用
> メトリクスは本仕様書に記載し、下記のスケジュール実行 Worker で実装します。

## 2. サブシステム

### Subsystem 1 — Cloudflare AI Gateway → Grafana Cloud Loki

#### 2.1 目標

Cloudflare Logpush から暗号化された AI Gateway access
logs をほぼリアルタイムで受信し、Loki JSON streams に変換して Grafana Cloud
Loki に push します。

#### 2.2 アーキテクチャ

```text
[Client/App]
    ↓
[Cloudflare AI Gateway] ── logs ──→ [Cloudflare Logpush]
                                       ↓ encrypted, gzip-compressed NDJSON
[Cloudflare Workers (receive/decrypt/decompress)]
                                       ↓ NDJSON
[Cloudflare Workers (transform)]
                                       ↓ JSON streams
[Grafana Cloud Loki]
                                       ↓
[Grafana Cloud Dashboard]
```

#### 2.3 構成要素

| Component        | Managed By                             | Responsibility                                               |
| ---------------- | -------------------------------------- | ------------------------------------------------------------ |
| AI Gateway       | 既存サービス                           | AI requests を proxy し、access logs を生成します。          |
| Logpush Job      | Terraform (`cloudflare_logpush_job`)   | Gateway logs を取得し、Worker に NDJSON を POST します。     |
| Transform Worker | Wrangler (`workers/src/index.ts`)      | 入口検証、解凍、復号、変換、Loki への push を実行します。    |
| Credentials      | Wrangler secrets + `TF_VAR_*` env vars | Grafana token、origin secret、RSA private key を保持します。 |
| Loki             | Grafana Cloud managed                  | 変換後 logs を14日間保存します。                             |

### Provider Metrics Worker (`graft-ai-provider-metrics`)

Cron `*/5 * * * *` で実行する Worker です。Codex、OpenAI API、OpenCodeGo
から使用量メトリクスを取得し、OTLP/v1 JSON で Grafana Cloud Prometheus に push します。

**Providers:**

- **OpenAI API:** `GET /v1/organization/costs` と
  `GET /v1/organization/usage/completions`（Bearer Admin Key、日次 window）
- 取得期間は `OPENAI_API_HISTORY_DAYS` で指定し、未設定時のデフォルトは1日、
  指定可能な範囲は1〜31日の整数です。
- `OPENAI_API_HISTORY_DAYS` が未設定または不正の場合、OpenAI fetch をスキップし、
  他のプロバイダーは継続実行します。
- OpenAI レスポンスに cost bucket と token bucket がともに0件の場合、結果は空とみなし
  push ペイロードから除外します。
- **Codex:** `GET https://chatgpt.com/backend-api/wham/usage`（Bearer OAuth Access Token）
- Codex の `primary_window` と `secondary_window` は必須です。欠損や範囲外の値は
  Codex fetch 全体を失敗させます。
- `GET .../wham/rate-limit-reset-credits` は補助エンドポイントです。失敗時も Codex
  usage メトリクスは push され、`codex_reset_credits` と
  `codex_reset_credits_available_count` のみ省略されます。
- **OpenCodeGo:** `opencode.ai/workspace/{id}/go` の HTML scraping（Session Cookie）
- OpenCodeGo の rolling usage と rolling reset は必須フィールドです。欠損時は fetch
  が失敗します。weekly と monthly ウィンドウは任意で、レスポンスに含まれない場合は
  それらのメトリクスは省略されます。
- `OPENCODEGO_WORKSPACE_ID` 未設定時、使用量ページをスクレイピングする前に
  OpenCodeGo の `_server` エンドポイントからワークスペース ID を自動取得します。

**Metrics pushed:**

- `openai_api_cost_usd{line_item}`、`openai_api_{input,output,cached}_tokens{model}`、`openai_api_requests{model}`
- `codex_usage_ratio{period}`、`codex_reset_timestamp_seconds{period}`、`codex_credits_remaining`、`codex_reset_credits`、`codex_reset_credits_available_count`、`codex_plan_info{plan}`
- `opencodego_usage_ratio{period}`、`opencodego_reset_seconds_remaining{period}`、`opencodego_zen_balance_usd`

**Error handling:** Provider ごとの fetch は独立しており、1つの失敗が他のメトリクス
push を妨げません。HTTP 401 と 403 は即時失敗（cookie/key 期限切れ）として扱い、
再試行しません。HTTP 429 と 5xx、およびネットワーク障害は指数バックオフで最大3回
再試行します。それ以外の 4xx は再試行しません。全プロバイダーがスキップ・設定
不正・メトリクス空の場合、Worker はエラーログを出力し push せずに終了します。

### Ollama Cloud Worker (`graft-ai-ollama-cloud`)

Cron `*/5 * * * *` で実行する Worker です。設定した ISO 8601 のアンカー時刻と
公式に文書化されたリセット間隔から、session と weekly のレート制限リセット
メトリクスを派生します。Ollama Cloud のダッシュボードをスクレイピングしたり、
実際の使用量を推測したりはしません。結果は OTLP/v1 JSON で Grafana Cloud
Prometheus に push します。

**設定:**

- `OLLAMA_CLOUD_RESET_ANCHOR_ISO` は必須で、タイムゾーン情報を含む厳密な ISO 8601
  時刻を指定します。
- `OLLAMA_CLOUD_SESSION_INTERVAL_SECONDS` のデフォルトは `18000`（5時間）です。
- `OLLAMA_CLOUD_WEEKLY_INTERVAL_SECONDS` のデフォルトは `604800`（7日）です。
- `OLLAMA_CLOUD_PLAN` は任意で、未設定時は `unknown` です。
- `GRAFANA_CLOUD_PROMETHEUS_URL`、`GRAFANA_CLOUD_PROMETHEUS_USERNAME`、
  `GRAFANA_CLOUD_ACCESS_POLICY_TOKEN` はメトリクス送信に必須です。

**算出方法:** 各期間について `elapsed = now - anchor`、
`remainder = ((elapsed % interval) + interval) % interval` として計算します。
Worker は `progress_ratio = remainder / interval`、
`remaining_seconds = interval - remainder`、
`next_reset_timestamp = now + remaining_seconds` を送信します。この正規化された
剰余により、実行時刻がアンカーより前でも正しい範囲になります。

**送信メトリクス:**

- `ollama_cloud_reset_seconds_remaining{period}`
- `ollama_cloud_reset_timestamp_seconds{period}`
- `ollama_cloud_reset_progress_ratio{period}`
- `ollama_cloud_plan_info{plan,session_interval,weekly_interval}`

**エラー処理:** アンカーまたは間隔の設定が未設定・不正な場合はログを出力し、
メトリクスを送信せずスケジュール実行を終了します。Prometheus の 429、5xx、
ネットワーク障害は指数バックオフで最大3回まで再試行します。それ以外の 4xx は
再試行しません。

**アラート:** Grafana アラートルール
（`grafana/alerts/graft-ai-ollama-cloud-rules.json`）は、
`ollama_cloud_reset_seconds_remaining{period="session"} < 3600`（session リセット1時間前）
および `ollama_cloud_reset_seconds_remaining{period="weekly"} < 86400`
（weekly リセット24時間前）で発火します。

#### 2.4 データ変換ルール

1. **Timestamp and Encryption**
   - Incoming payload は gzip-compressed NDJSON です。各 encrypted
     field は hybrid encryption を使用します。AES-GCM
     key は RSA-OAEP-SHA256 で wrap され、payload は AES-GCM で暗号化されます。Worker は PKCS#8
     RSA private
     key（`env.RSA_PRIVATE_KEY_PEM`）を import し、unwrap と decrypt を行います。
   - `RequestTime` は10桁以下なら秒、11〜13桁ならミリ秒です。
   - Loki 用に nanoseconds へ変換します。
   - 14桁以上の値は precision-lost として扱い、該当 log line を skip します。
2. **Labels**
   - 厳密に `model`、`status_code`、`env`、`gateway` の4つです。
   - `model` は `@cf/<scope>/` prefix を取り除いて正規化します。
3. **Log Line Fields**
   - 常に含める field は
     `request_id`、`cache_status`、`prompt_tokens`、`completion_tokens`、`total_tokens`、`duration_ms`、`path`、`method`
     です。
   - `env.INCLUDE_REQUEST_BODY`、`env.INCLUDE_RESPONSE_BODY`、`env.INCLUDE_METADATA`
     で明示的に有効化された場合のみ、復号済みの
     `request_body`、`response_body`、`metadata`
     を含めます。これらは prompts、response bodies、その他 sensitive
     data を含む可能性があるため opt-in です。
   - Headers、user IPs、auth tokens、raw prompts/response
     bodies はデフォルトで除外します。

#### 2.5 信頼性とエラー処理

| Failure Point                   | Behavior                                                                    |
| ------------------------------- | --------------------------------------------------------------------------- |
| Missing/wrong `X-Origin-Secret` | `401` を返します。Logpush retry は発生しません。                            |
| Malformed gzip body             | `400` を返します。Logpush retry は発生しません。                            |
| Invalid RSA private key         | `400` を返します。Logpush retry は発生しません。                            |
| Unparseable NDJSON line         | 該当行を skip し、他の行の処理を継続します。                                |
| Loki 429                        | Exponential backoff で最大3回 retry します。最終失敗時は `503` を返します。 |
| Loki 5xx                        | Exponential backoff で最大3回 retry します。最終失敗時は `503` を返します。 |
| Loki ネットワーク障害 (status 0) | Fetch 失敗。Loki handler は status 0 を返します。Worker は `503` に変換します。 |
| Loki 4xx (non-429)              | `400` を返します。Logpush retry は発生しません。                            |

#### 2.6 セキュリティ

- Logpush → Worker と Worker → Loki は HTTPS のみです。
- Loki push は HTTP Basic Auth を使用します。username は Grafana Cloud Loki
  tenant ID、password は `logs:write` scope を持つ Access Policy Token です。
- Secrets は commit せず、`*.tfvars` にも保存しません。環境変数または Wrangler
  secrets を使用します。
- Terraform state は encrypted remote backend を使用するべきです。

#### 2.7 テストと検証

- Crypto、transform、Loki modules の unit
  tests（`@cloudflare/vitest-pool-workers`）。
- Worker fetch handler 全体の integration test。
- CI checks: `terraform fmt`、`terraform validate`、TypeScript type
  check、Vitest run。
- Test fixtures は `tests/fixtures/sample_aigateway_log.json`
  にあり、200/400/500 status codes、cache hit/miss、2つの model
  names をカバーします。

## 3. 全体制約

- Workers implementation language: TypeScript。
- Terraform provider: `cloudflare/cloudflare` v5.x。
- Worker deployment は Wrangler で行い、Terraform は Logpush
  job のみを管理します。
- Grafana Cloud Free Tier limits が適用されます。

## 4. 運用メモ

- Terraform 適用前に Cloudflare API で Logpush dataset name と field
  names を確認します。
- RSA public key を AI Gateway Logpush settings に upload します。private
  key は Worker が使用します。
- 本番利用前に encrypted remote Terraform backend を設定します。
- **Monitoring checklist:** Workers Analytics の exceptions と subrequest
  errors、Terraform output または Cloudflare dashboard の Logpush
  `last_delivery` status、Grafana Cloud **Logs Usage** dashboard、実際の log
  volume と設計見積もり（変換後 request あたり約 0.5〜1.5 KB）の週次比較。
- **Quota estimate:** 変換後 logs は 1 request あたり約 0.5〜1.5
  KB、raw は約 3〜8 KB です。100k requests/day の場合、月間約 1.5〜4.5
  GB となり、Grafana Cloud Free Tier の 50 GB/month logs
  allowance 内に収まります。
