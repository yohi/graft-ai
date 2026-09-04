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
##### Logpush Mode
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

##### Free Tier Proxy-Only Mode

[Client/App]
↓ X-Proxy-Secret header
[Cloudflare Workers - proxy.ts (graft-ai-aig-proxy)]
├─ validates X-Proxy-Secret
├─ forwards to Cloudflare AI Gateway (my-gateway)
└─ returns the upstream response unchanged
```

#### 2.3 構成要素

| Component        | Managed By                                                           | Responsibility                                                           |
| ---------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| AI Gateway       | 既存サービス                                                         | AI requests を proxy し、access logs を生成します。                      |
| Logpush Job      | Terraform (`terraform_data.aig_logpush_job` + Cloudflare API helper) | Gateway logs を取得し、Worker に NDJSON を POST します。                 |
| Transform Worker | Wrangler (`workers/src/index.ts`)                                    | 入口検証、解凍、復号、変換、Loki への push を実行します。                |
| Credentials      | Wrangler secrets + `TF_VAR_*` env vars                               | Grafana token、origin secret、RSA private key を保持します。             |
| Loki             | Grafana Cloud managed                                                | 変換後 logs を14日間保存します。                                         |
| Proxy Worker     | Wrangler (`workers/src/proxy.ts`)                                    | X-Proxy-Secret を検証し、AI Gateway に転送して上流レスポンスを返します。 |
| Tail Worker      | 有料プランのオプションコンポーネント                                 | Free Tier proxy-only mode では使用しません。                             |
| Ollama Cloud Worker   | Wrangler (`workers/src/ollama-cloud.ts`)                             | 厳密な ISO 8601 anchor から reset metrics を算出し、OTLP metrics を push します。 |
| Ollama Cloud alerts   | Grafana Alerting API (`grafana/alerts/`)                              | Prometheus metrics から session/weekly reset alert を発火します。             |
| Dashboard             | `grafana/dashboards/graft-ai-overview.json`                           | 13 パネルの Grafana dashboard を gcx API 経由で import します。                |
| Ollama dashboard      | `grafana/dashboards/graft-ai-ollama-cloud.json`                       | Ollama Cloud reset metrics dashboard を gcx API 経由で import します。         |
| Grafana Access Policy | Terraform (`terraform/grafana/`) または手動                           | OTel と Loki/Prometheus delivery 用の `logs:write`、`metrics:write`、`traces:write` scope を持つ Cloud Access Policy を管理します。 |

### Provider Metrics Worker (`graft-ai-provider-metrics`)

Cron `* * * * *` で実行する Worker です。Codex、OpenAI API、OpenCodeGo
の使用量メトリクスを各プロバイダーから取得し、OTLP/JSON 形式で Grafana Cloud
Prometheus に push します。

**Providers:**

- **OpenAI API:** `GET /v1/organization/costs` と
  `GET /v1/organization/usage/completions`（Bearer Admin Key、日次 window）
- 取得期間は `OPENAI_API_HISTORY_DAYS` で指定し、未設定時のデフォルトは1日、
  指定可能な範囲は1〜31日の整数です。
- `OPENAI_API_HISTORY_DAYS` が未設定の場合はデフォルトの1日で取得します。
  明示的に不正な値が設定された場合のみ OpenAI fetch をスキップし、他のプロバイダーは
  継続実行します。
- OpenAI レスポンスに cost bucket と token bucket がともに0件の場合、結果は空とみなし
  push ペイロードから除外します。
- **Codex:** `GET https://chatgpt.com/backend-api/wham/usage`（Bearer OAuth Access Token、`CODEX_PROXY_URL` または `CODEX_API_BASE_URL` でプロキシ/カスタムBase URLを指定可能）
- `primary_window` または `secondary_window` のうち少なくとも1つの有効なウィンドウが必要です。`secondary_window` が欠落または null の場合（単一ウィンドウプラン等）、その使用率とリセット時刻は 0 として扱われます。
- 直接リクエストで HTTP 403（Cloudflare WAF Turnstile チャレンジ）が発生した場合、`CODEX_PROXY_URL`（Cloudflare Tunnel を介した住宅用プロキシ等）経由で通信するか、Cloudflare Browser Rendering へフォールバックします。
- `GET .../wham/rate-limit-reset-credits` は補助エンドポイントです。失敗時も Codex
  usage メトリクスは push され、`codex_reset_credits` と
  `codex_reset_credits_available_count` のみ省略されます。
- **OpenCodeGo:** `opencode.ai/workspace/{id}/go` の HTML scraping および `_server` RPC（Session Cookie）
- OpenCodeGo の rolling usage と rolling reset は必須フィールドです。欠損時は fetch
  が失敗します。weekly と monthly ウィンドウは任意で、レスポンスに含まれない場合は
  それらのメトリクスは省略されます。サブスクリプション RPC が null を返した場合（従量課金/Zen ワークスペース等）、Billing RPC エンドポイントにフォールバックします。
- `OPENCODEGO_WORKSPACE_ID` 未設定時、使用量ページをスクレイピングする前に
  OpenCodeGo の `_server` エンドポイントからワークスペース ID を自動取得します。
- **Ollama Cloud:** `ollama.com/settings` の HTML scraping（Session Cookie）
- プラン名（`Free`, `Pro`, `Max` 等）、Session/Hourly 利用率、Weekly 利用率、および `data-time` の ISO リセット日時を抽出します。ウィンドウが存在しない場合は該当メトリクスを省略します。

**Metrics pushed:**

- `openai_api_cost_usd{line_item}`、`openai_api_{input,output,cached}_tokens{model}`、`openai_api_requests{model}`
- `codex_usage_ratio{period}`、`codex_reset_timestamp_seconds{period}`、`codex_credits_remaining`、`codex_reset_credits`、`codex_reset_credits_available_count`、`codex_plan_info{plan}`
- `opencodego_usage_ratio{period}`、`opencodego_reset_seconds_remaining{period}`、`opencodego_zen_balance_usd`
- `ollama_cloud_usage_ratio{period}`、`ollama_cloud_reset_timestamp_seconds{period}`、`ollama_cloud_plan_info{plan}`

**Error handling:** Provider ごとの fetch は独立しており、1つの失敗が他のメトリクス
push を妨げません。HTTP 401 と 403 は即時失敗（cookie/key 期限切れ）として扱い、
再試行しません。HTTP 429 と 5xx、およびネットワーク障害は指数バックオフで最大3回
再試行します。それ以外の 4xx は再試行しません。全プロバイダーがスキップ・設定
不正・メトリクス空の場合、Worker はエラーログを出力し push せずに終了します。

### Ollama Cloud Worker (`graft-ai-ollama-cloud`)

Cron `* * * * *` で実行する Worker です。設定した ISO 8601 のアンカー時刻と
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
  `GRAFANA_CLOUD_ACCESS_POLICY_TOKEN` はメトリクス送信に必須です。トークンには
  `metrics:write` scope が必要で、Loki の `logs:write` 専用 token とは分離してください。

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

### OpenTelemetry Pipeline の Grafana Cloud export

自己ホスト構成は `deploy/otel/docker-compose.yml` を使用し、Grafana Cloud
export は `deploy/otel/docker-compose.grafana-cloud.yml` を override として重ねます。
Cloud endpoint と `Authorization` header は環境変数から渡し、commit 済みの Compose
ファイルには credential を埋め込みません。Grafana Cloud の telemetry 用 Access
Policy には `logs:write`、`metrics:write`、`traces:write` が必要です。Loki の
Logpush/Tail Worker には `logs:write` だけを持つ別のAccess Policyを使用します。
Dashboard と alert のデプロイ時は `GRAFANA_OTEL_PROMETHEUS_DATASOURCE_UID`、
`GRAFANA_OTEL_LOKI_DATASOURCE_UID`、`GRAFANA_OTEL_TEMPO_DATASOURCE_UID` で
datasource UIDだけを置換します。`GRAFANA_OTEL_DATASOURCE_UIDS_REQUIRED=true` の
場合は3つすべてをGrafana API呼び出し前に必須とし、expression datasourceの
`-100` と無関係な UID は保持します。

#### OTel Worker の payload store

専用Workerは `OTEL_PAYLOAD_STORE=d1` をデフォルトとし、レダクション済み payload を
`OTEL_PAYLOAD_D1` D1 データベース binding に保存します。Cloudflare D1 は Workers Free
においてクレジットカード登録不要（zero credit card requirement）で利用可能であり、
100,000 writes/day（100,000書き込み/日）、5,000,000 reads/day（5,000,000読み取り/日）、
アカウント全体の合計 5 GB/account 保存容量、および 1データベースあたり 500 MB/database
の上限を提供します。D1 は強整合性（strong consistency）を持ちます。D1 pointer では
`queueDeliveryDelaySeconds` が 0秒（意図的な遅延なし）を返しますが、Queue 配信は非同期です。
consumer のスケジューリング、バッチタイムアウト、backlog、再試行により、実際の即時配信は
保証されません。

Worker は D1 に保存する各 payload を `MAX_D1_PAYLOAD_BYTES = 1,900,000` bytes に制限します。
これは D1 の 2,000,000-byte maximum row size より余裕を持って小さい値です。この上限は
`MAX_GRAFANA_OTLP_BYTES = 4,000,000` の export payload cap とは別です。D1 ingress payload が
1,900,000 bytes を超える場合、reservation の解放に成功すれば Worker は
`{"error":"payload_too_large"}` の HTTP 413 を返し、Queue message を登録しません。解放に
失敗した場合は HTTP 503 を返します。D1-backed export が 4,000,000-byte export cap 以下で
1,900,000 bytes を超える場合は、D1 payload-store のサイズガードが SQL write 前、かつ Queue
enqueue 前に拒否します。ledger の export reservation は解放され、Queue message は登録されません。
4,000,000 bytes を超える payload は export validation の段階で先に失敗します。

以前のデフォルトであった Workers KV (`OTEL_PAYLOAD_STORE=kv`、`OTEL_PAYLOAD_KV` binding)
および Cloudflare R2 (`OTEL_PAYLOAD_STORE=r2`、`OTEL_OBJECTS` binding) も、明示的な
設定により引き続き利用可能です。`OTEL_OBJECTS` は任意の R2 binding であり、
`OTEL_PAYLOAD_STORE=r2` または明示的な `OTEL_PAYLOAD_R2_DRAIN=true` の場合だけ
必要です。Workers Free の KV には 1 GB 保存容量、1,000 writes/day
（1,000書き込み/日）、100,000 reads/day（100,000読み取り/日）、1,000 deletes/day
（1,000削除/日）、25 MiB value limit があります。4 MB export payload
cap はこの value limit 未満で、Free limit 到達時は操作が失敗し paid overage へ
自動移行しません。KV の eventual consistency のため最初の Queue delivery は 60秒遅延します。

新規 Queue pointer は schema version 2 と `storageBackend`（`"d1"`, `"kv"`, `"r2"`）を
永続化します。schema-version-1 pointer は常に R2 から読み取り・削除し、schema-version-2 の
R2 pointer も KV/R2 drain 中は現在の write selector に関係なく R2 を使います。
`OTEL_PAYLOAD_STORE=d1` 稼働時でも、キュー内の既存 KV および R2 pointer は各ストアから
正常に読み取り・削除されます。

##### D1 スキーマ定義とインデックス

D1 のテーブルスキーマは `workers/migrations/0001_create_otel_payloads.sql` で管理されます:

```sql
CREATE TABLE IF NOT EXISTS otel_payloads (
  object_key TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_otel_payloads_expires_at ON otel_payloads(expires_at);
```

フィールド一覧:
- `object_key`: 一意なキー識別子（例: `otel/ingress/<date>/<uuid>.json`、
  `otel/export/<backend>/<date>/<job_id>.json`）。
- `sha256`: ペイロード `data` の 16進表記 SHA-256 ダイジェスト。
- `content_type`: ペイロードの MIME タイプ（厳格に `"application/json"`）。
- `kind`: ステージ分類（`"ingress"` または `"export"`）。
- `data`: シリアライズされたペイロードを格納するバイナリ BLOB。
- `created_at`: Unix エポック秒の登録日時。
- `expires_at`: Unix エポック秒の有効期限日時（`created_at + 7日`）。
- `idx_otel_payloads_expires_at`: テーブルフルスキャンを回避し、期限切れレコードを
  高速に範囲削除するための B-tree インデックス。

##### クリーンアップ invariant と日次 Cron Trigger

通常運用時、ペイロードはエクスポート完了時に `deleteObject(pointer)` で削除されます
（`DELETE FROM otel_payloads WHERE object_key = ?`）。孤立レコード（失敗した配信や
破棄されたトレースなど）に対するフェイルセーフとして、日次 Cron Trigger（`0 4 * * *` UTC）が
`D1PayloadStore.deleteExpired(nowSeconds)`（`DELETE FROM otel_payloads WHERE expires_at < ?`）
を実行して期限切れレコードをパージします。この定期クリーンアップはトレース受信の
ホットパス外で完全に独立して動作し、受信レイテンシに影響を与えません。クリーンアップ実行時の
エラーは再送出され、Cloudflare Workers の可観測性上で失敗として確実に記録されます。

##### KV 監視と R2 移行

Cloudflare KV Analytics または GraphQL API を、読み取り、書き込み、削除、保存データ
という4つの独立した監視軸のsource of truthとします。80,000 reads/day、800
writes/day、800 deletes/day、0.8 GiB保存データで alert し、quota-related Worker
failure が確認できた場合だけ page します。削除 quota failure は読み取り・書き込み
停止を意味しません。R2 選択は quota exhaustion の確認、または次の 00:00 UTC reset
前の枯渇予測に対する手動対応であり、一時的な削除エラーへの自動反応ではありません。
R2 lifecycle rule は R2 payload だけに適用し、KV payload は削除しません。

#### OTel signal 契約（設計 invariant）

以下の invariant は専用 OTel Worker と legacy Alloy/Tunnel reference stack の
両方に適用されます。設計レビューで固定された内容であり、実装間でずらしては
いけません。

**deterministic sampling:**

- 既定の sampling rate は 100% です。運用で指定する decimal rate は `0..1` に
  検証し、浮動小数点を使わず `rate_ppm = floor(rate * 1_000_000)`（範囲
  `0..1,000,000`）の整数へ正規化します。
- decision は UTF-8 連結 `trace_id + "graft-ai-otel-v1"`（小文字 32 桁 hex）の
  SHA-256 を使い、先頭 8 バイトを big-endian unsigned integer `hash` として
  `hash * 1_000_000 < rate_ppm * 2^64` の厳密な `<` と exact integer arithmetic で
  決めます。64-bit hash を float へ変換してはいけません。sampling priority
  override は受け付けず、同じ `trace_id`/`rate_ppm`/seed は常に同じ decision に
  なります。
- Tempo trace と Loki payload は同じ trace 単位 decision を共有し、sampled out の
  trace はどちらの backend にも存在しません。RED metrics は sampling 前の選択済み
  request spans から生成し、payload sampling で値を減らしません。
- acceptance fixture（seed `graft-ai-otel-v1`）: trace
  `00000000000000000000000000000001` は SHA-256 prefix `f75a2b34049e94d6`
  （rate 0.5 で out）、trace `ffffffffffffffffffffffffffffffff` は
  `1d4e75600b429028`（rate 0.5 で in）、trace
  `11111111111111111111111111111111` は `db81a30e59fe0b64`（rate 0.5 で out）。
  rate `0` は全件 out、rate `1` は全件 in を期待値とします。

**fail-closed redaction:**

- redaction はあらゆる exporter、debug log、durable store、Queue handoff より先に
  実行します。`gen_ai.prompt_json`、`gen_ai.completion_json`、`cf-aig-metadata`、
  文字列属性中の Bearer/Basic/API key 形式の credential と明示的な
  `secret`/`token`/`password` 系の値を `[REDACTED]` に置換します。
- JSON parse または deterministic redaction に失敗した payload は原文を保存せず、
  payload 属性だけを `payload_dropped=true`、
  `payload_drop_reason="redaction_failure"` で削除し、安全な metadata は維持します。

**spanlogs / Loki payload log:**

- Loki label は `model`、`status_code`、`env`、`gateway` の4つだけです。
  `trace_id`、`request_id`、`provider`、payload 内容は log field に留めます。
- serialized UTF-8 log line の上限は 262,144 bytes（256 KiB）です。redaction 後に
  JSON escaping 後のサイズで判定し、超過時は `prompt` と `completion` に 50:50
  （片方のみなら 100:0）で budget を割り当て、UTF-8 code point 境界で切り詰めて
  `[TRUNCATED]` suffix を budget 内に収め、identity/numeric field と
  `payload_truncated=true` を保持します。metadata だけでも超過する場合は payload を
  reason `line_size` で削除し、それでも超過する場合は record を破棄して
  `otel_spanlogs_dropped_total{reason="line_size_metadata"}` だけを増加させます。
  drop log には trace ID、URL、payload を含めません。
- token/cost field（`input_tokens`、`output_tokens`、`total_tokens`、`cost_usd`、
  `duration_ms`）は引用符なしの有限 decimal JSON number とし、NaN、Infinity、
  変換不能値は field を欠損扱いにして `numeric_field_invalid` を記録します。
  集計 panel は Loki を `| json | unwrap` で query します。

**canonical RED metrics:**

- `ai_gateway_requests_total`、`ai_gateway_errors_total`、
  `ai_gateway_request_duration_seconds` のみを公開し、label は `model`、`provider`、
  `status_code`、`env`、`gateway` です。duration histogram の bucket は
  `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, +Inf]` 秒に固定します。

**ingress 上限と rate limiting:**

- receiver 上限は body 8 MiB、header 5 秒 / read 30 秒 / write 10 秒 timeout、
  同時 request 100、dispatcher ingress queue 1,000 item（drop-new）です。queue が
  満杯の場合は新しい item だけを固定 reason `capacity` で破棄し、client には `200` を
  返します。backend の status を送信元へ返しません。
- source rate limit は token bucket capacity 20、refill 2/秒（120 request/分）です。
  bucket key は
  `HMAC-SHA-256(OTEL_RATE_LIMIT_HMAC_KEY, "otel-ingress-source-v1" || NUL || canonical_ip)`
  で、raw IP は永続化・label 化しません。client 指定の forwarding header は常に無視し、
  trusted path（Worker では常に trusted、Alloy では `OTEL_TRUSTED_PROXY_CIDRS` 内の
  peer のみ。それ以外は `403` / `untrusted_source`）の Cloudflare edge 由来の
  `CF-Connecting-IP` だけを source として使い、未取得時は共有 `unknown` bucket へ
  送ります。`429` 応答の `Retry-After` は ASCII decimal の delta-seconds（切り上げ、
  最小 1）です。
- ingress 運用 metric は固定です:
  `otel_ingress_requests_total{status}`、reason enum `auth`、
  `untrusted_source`、`path`、`parse`、`content_type`、`compression`、
  `body_size`、`timeout` を持つ `otel_ingress_rejections_total{reason}`、
  さらに `otel_ingress_rate_limited_total`、
  `otel_ingress_queue_dropped_total{reason="capacity"}`、
  `otel_ingress_active_requests`、`otel_ingress_request_bytes`、
  `otel_ingress_queue_items`/`otel_ingress_queue_capacity{queue="dispatcher"}`
  です。source IP、token、prompt/completion は label にしません。reject の
  status は `401` auth、`403` untrusted source、`404` path、`400` parse、
  `415` content type または compression、`413` body size、`408` handler
  timeout、`429` rate limited に固定します。

**Alloy reference の backend dispatch:**

- retryable は network failure、`408`、`429`、`5xx` で、その他の `4xx` は終端です。
  各 backend は合計 3 attempt（per-attempt timeout 10 秒）で、
  `delay = min(base * 2^retry_index * uniform(0.8, 1.2), 5s)`（Tempo は base 1s/2s、
  Loki/Prometheus は 500ms/1s）の backoff を使います。
- 境界付き in-memory queue: Tempo は 64 MiB または 2,000 span、Loki は 64 MiB または
  500 record、Prometheus は 16 MiB または 100 batch（batch は 200 data point または
  1 秒で flush）。eviction は Tempo が最古の complete trace（なければ最古 item）、
  Loki が最低 priority の record（priority は metrics 3 > trace metadata 2 >
  payload 1）の後に最古、Prometheus が最古 batch の順です。
- drop reason は固定 enum の `queue_capacity`、`retry_exhausted`、
  `line_size_metadata`、`numeric_field_invalid`、`shutdown_loss`、
  `trace_state_evicted` とします。運用 metric は
  `otel_backend_export_retries_total{backend}`、
  `otel_backend_export_failures_total{backend,status_class}`、
  `otel_backend_export_exhausted_total{backend}`、
  `otel_backend_queue_dropped_total{backend,signal,reason}` と queue utilization/age で、
  backend failure log には `backend`、`status_class`、`attempt`、`reason`、
  `queue_items`、`queue_capacity` だけを記録します。
- alert は export exhausted または queue drop が 5 分継続で critical、queue
  utilization 0.80 超が 5 分継続、または 5 分以内の rate-limited request が 1 件
  以上で warning です。

**retention gate（Alloy reference）:**

- self-hosted baseline retention は Tempo 14 日、Loki 7 日、Prometheus 14 日を
  Compose の明示設定で固定します。Grafana Cloud の payload log export は、実効 Cloud
  Logs retention が 14 日以下の正の期間として解決できる場合だけ有効化し、それ以外は
  固定の sanitized reason `retention_unavailable`、`retention_lookup_failed`、
  `retention_invalid`、`retention_exceeds_14d` で無効化します。Cloud の既定値を 7 日や
  30 日と仮定せず、tenant の実効値を受入時に記録します。

**OTel Worker の耐久性と identity:**

- Queue semantics は at-least-once で、すべての ingress/export record は安定 ID、
  Durable Object による idempotency、25 時間（`DEDUPLICATION_TOMBSTONE_MS`）の
  deduplication tombstone を持ちます。exactly-once delivery は主張しません。
- Durable Object aggregation のパラメータ: trace aggregate は 1 秒の idle alarm で
  trace state を flush し、metrics aggregate は 30 秒または 200 sample の先着で
  cumulative sample window を flush します。各 series の最初の start time は保持します。
  SQLite-backed Durable Object の 2 MiB value limit を下回るよう、serialized metrics
  state は 1,500,000 UTF-8 bytes に制限します。series ごとの start time は sample 内に
  持たせ、last flush には compact な metadata だけを保存します。cumulative payload
  または state が cap を超える場合は current flush window へ rollover してその window
  の cumulative start time をリセットします。current window 単独でも大きすぎる場合は、
  受信した input sample を Durable Object state に保存せず、既存 state も変更せず、
  enqueue もせずに、`/append` が `metrics_window_too_large` の HTTP 413 を返して
  リクエストを拒否します。送信側はこの 413 を sample の受理・保持済みと解釈せず、
  window を縮小するか複数に分割し、収まる単位で再送する必要があります。単一 sample
  自体が上限を超える場合は、window の分割では解決しないため、その sample の内容を
  見直す必要があります。alarm は concurrency gate の外側で同じ失敗を報告します。
- envelope を serialize する前に、文字列として格納された payload JSON 内の
  オブジェクトキーを再帰的に辞書順でソートします（配列の順序は保持します）。この
  canonicalization により、同値の payload は同じ canonical envelope bytes、`ingressId`、
  `payloadSha256` を生成します。
- `ingressId = SHA-256("graft-ai-otel-ingress-v1" || NUL || canonical_redacted_envelope_bytes)`
  です。同一 ID で payload hash が一致すれば accepted duplicate、hash が異なれば元の
  状態を変更せず collision として失敗させます。AI Gateway の delivery ID
  （`cf-aig-otel-trace-id`、span ID、request ID）は ingress ID に使いません。
- OTLP payload はすべて JSON（`application/json`）で、各 export document は 4,000,000
  UTF-8 バイト（Cloud 取り込み上限 5 MB 未満）に cap します。Worker 経路に protobuf
  runtime 依存はありません。
- Terraform は Queue、DLQ、KV namespace、任意の R2 resource を管理し、Wrangler は
  Queue consumer と Durable Object binding を管理します。Terraform 側に
  `cloudflare_queue_consumer` resource は追加しません。

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
   - `INCLUDE_*` flag を有効化した場合も Worker は本文や metadata を自動で
     マスキングしません。有効化した内容は PII や認証情報を含み得る機密データ
     として扱い、送信前に無害化してください。決定的にマスキングできない場合は
     flag を無効のままにします。Loki の保持期間は14日以内とし、最小権限の
     Grafana ユーザー／チームと `logs:write` のみを持つ token にアクセスを制限します。

#### 2.5 信頼性とエラー処理

| Failure Point                    | Behavior                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------- |
| Missing/wrong `X-Origin-Secret`  | `401` を返します。Logpush retry は発生しません。                                |
| Malformed gzip body              | `400` を返します。Logpush retry は発生しません。                                |
| Invalid RSA private key          | `400` を返します。Logpush retry は発生しません。                                |
| Unparseable NDJSON line          | 該当行を skip し、他の行の処理を継続します。                                    |
| Loki 429                         | Exponential backoff で最大3回 retry します。最終失敗時は `503` を返します。     |
| Loki 5xx                         | Exponential backoff で最大3回 retry します。最終失敗時は `503` を返します。     |
| Loki ネットワーク障害 (status 0) | Fetch 失敗。Loki handler は status 0 を返します。Worker は `503` に変換します。 |
| Loki 4xx (non-429)               | `400` を返します。Logpush retry は発生しません。                                |

#### 2.6 セキュリティ

- Logpush → Worker と Worker → Loki は HTTPS のみです。
- Loki push は HTTP Basic Auth を使用します。username は Grafana Cloud Loki
  tenant ID、password は `logs:write` scope を持つ Access Policy Token です。
- Secrets は commit せず、`*.tfvars` にも保存しません。環境変数または Wrangler
  secrets を使用します。
- Terraform state は設定済みの暗号化 Terraform Cloud workspace に保存します。

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
- 設定済みの暗号化 Terraform Cloud workspace にログインしてから適用します。
- **Monitoring checklist:** Workers Analytics の exceptions と subrequest
  errors、Terraform output または Cloudflare dashboard の Logpush
  `last_delivery` status、Grafana Cloud **Logs Usage** dashboard、実際の log
  volume と設計見積もり（変換後 request あたり約 0.5〜1.5 KB）の週次比較。
- **Quota estimate:** 変換後 logs は 1 request あたり約 0.5〜1.5
  KB、raw は約 3〜8 KB です。100k requests/day の場合、月間約 1.5〜4.5
  GB となり、Grafana Cloud Free Tier の 50 GB/month logs
  allowance 内に収まります。
- **エラー率100% / 429 の切り分け:** Loki 上のログが全件 `model="unknown"` かつ
  `total_tokens=0` になっている場合、プロバイダ側のレート制限ではなく AI
  Gateway 自体がモデル呼び出し前にリクエストを拒否している可能性が高いです
  （`cf-aig-model` / `cf-aig-tokens` レスポンスヘッダーはモデル呼び出しが実際に
  発生したときのみ付与されるため）。gateway 自体の `rate_limiting_limit` /
  `rate_limiting_interval` は
  `GET /accounts/{account_id}/ai-gateway/gateways/{gateway_id}` で確認してくだ
  さい。デフォルト値はバースト的な、または複数クライアント（例: 複数の AI
  エージェントが1つの gateway を共有する場合）からのトラフィックには小さすぎる
  場合があります。
