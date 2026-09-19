# graft-ai Provider Usage Metrics 拡張設計書

## 1. 目的

本書は、graft-ai の Provider Metrics Worker における AI Provider / Coding Agent サービスの利用状況・クォータ・レート制限・残高・リセット時刻等の収集機能を拡張するための設計を定める。

対象サービスは以下とする。

- OpenAI API
- Codex（ChatGPT Subscription）
- Ollama Cloud
- OpenCode / OpenCode Go
- CommandCode

本書は issue #93 の要件定義に基づき、実装方式を確定する。

## 2. スコープ

本設計・実装の対象は issue #93 の P0 と P1 とする。P2 は後続フェーズで対応する。

### P0（最優先）

1. OpenCode Go `/zen/go/v1/usage` API key ベース取得対応
2. Ollama Cloud `/api/usage` API key ベース取得対応
3. Ollama Cloud monthly plan 対応

### P1

4. CommandCode Provider 追加
5. Provider scrape health / last success metrics 導入

### P2（対象外）

- Codex multi-limit abstraction
- OpenAI request-time rate-limit metrics
- OpenCode Zen balance legacy adapter の整理

## 3. 背景

現行の Provider Metrics Worker は以下の取得経路を使用している。

- OpenAI API: Organization Costs API / Organization Usage API（公式 API）
- Codex: ChatGPT backend `/wham/usage`（内部 API）
- OpenCode Go: HTML scraping + `_server` RPC（session cookie 必須）
- Ollama Cloud: `/settings` HTML scraping（session cookie 必須）

2026 年 9 月時点で、OpenCode Go には first-party usage endpoint、Ollama Cloud には JSON usage endpoint、CommandCode には subscription usage API が確認されている。これらを primary 取得経路とし、HTML scraping や cookie への依存を減らす。

## 4. 設計方針

### 4.1 共通 Provider Adapter パターン

各 Provider adapter は共通の内部表現 `ProviderResult` を返す。Prometheus OTLP metric 生成は共通 builder で行う。

```text
OpenAI adapter ──┐
Codex adapter ───┤
OpenCodeGo ──────┤──→ ProviderResult ──→ OTLP gauge metrics
Ollama ──────────┤
CommandCode ─────┘
```

### 4.2 内部表現

```ts
export type SupportLevel =
  | "official-public"
  | "official-internal"
  | "web-internal"
  | "scraping"
  | "fallback";

export type QuotaPeriod =
  | "session"
  | "hourly"
  | "weekly"
  | "monthly"
  | "rolling";

export interface QuotaWindow {
  period: QuotaPeriod | string;
  usageRatio?: number;
  used?: number;
  limit?: number;
  resetTimestampSeconds?: number;
  exceeded?: boolean;
}

export interface ProviderCredits {
  remaining?: number;
  monthly?: number;
  purchased?: number;
  free?: number;
  resetCredits?: number;
  resetCreditsAvailableCount?: number;
}

export interface ProviderResult {
  provider: string;
  supportLevel: SupportLevel;
  windows: QuotaWindow[];
  plan?: string;
  credits?: ProviderCredits;
  metadata?: Record<string, unknown>;
}
```

### 4.3 Adapter 関数型

```ts
export type ProviderAdapter = (
  env: ProviderMetricsEnv,
  ctx: ProviderContext,
) => Promise<ProviderResult>;
```

`ProviderContext` には `fetchFn`、`scheduledTimeSeconds`、optional の `browserBinding` を含む。

### 4.4 Orchestrator の流れ

1. 各 Provider の有効化判定（credential の有無）
2. `Promise.allSettled` で各 adapter を並列実行
3. 各 adapter の結果を `ProviderResult` に変換
4. scrape health metric（success / timestamp / duration）を収集
5. Prometheus OTLP payload を共通 builder で生成
6. Grafana Cloud へ push

## 5. ファイル構成

```text
workers/src/provider-metrics/
├── types.ts              # 共通型・adapter interface
├── adapters.ts           # adapter registry / 実行ラッパー
├── prometheus.ts         # OTLP metric 生成（ProviderResult を受け取る）
├── health.ts             # scrape health metric 生成
├── openai-api.ts         # 現行を維持しつつ ProviderResult へ変換
├── codex.ts              # 現行を維持、内部を window 配列へ拡張
├── opencodego/
│   ├── index.ts          # adapter エントリ
│   ├── api-key.ts        # /zen/go/v1/usage 取得
│   └── zen-balance.ts    # cookie/RPC fallback（optional）
├── ollama/
│   ├── index.ts          # adapter エントリ
│   ├── api-usage.ts      # /api/usage JSON
│   └── settings-html.ts  # cookie/HTML fallback
└── commandcode/
    ├── index.ts          # adapter エントリ
    └── billing.ts        # /alpha/billing/*（schema 実装時に確定）
```

## 6. Provider 別設計

### 6.1 OpenCode Go

**Primary 取得経路を API key ベースに移行する。**

```text
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OpenCode Go API key>
```

- レスポンス schema は実装時に確定し、adapter 内で runtime validation を行う
- 取得可能な window（rolling / weekly / monthly）を `QuotaWindow[]` に正規化
- reset 情報が「残秒数」の場合、`scheduledTimeSeconds + remaining` で timestamp に変換
- Zen balance は Go usage endpoint が返さない場合のみ、既存 cookie/RPC adapter を optional 実行
- Zen balance 取得失敗は Go quota の失敗にしない
- Cookie/RPC 経路を primary にしない

**Support level:** `official-internal`

### 6.2 Ollama Cloud

**Primary 取得経路を API key ベースに移行する。**

```text
GET https://ollama.com/api/usage
Authorization: Bearer <Ollama API key>
```

- レスポンスに存在する window を動的に検出する
- 既知 period: `session`, `hourly`, `weekly`, `monthly`
- `hourly` は意味上同一であることが確認できる場合 `session` に正規化してよい
- 旧 plan（session/hourly/weekly）と新 plan（monthly）のどちらも扱う
- `session` / `weekly` が必ず存在するという前提を持たない
- model 別 request 数や cost 情報が含まれる場合は別 metric として出力
- JSON API で reset timestamp や plan が得られない場合、または取得失敗時のみ `/settings` HTML scraping fallback を実行
- `OLLAMA_SESSION_COOKIE` は optional fallback とする

**Support level:** `official-internal`（`/api/usage`）、`fallback`（HTML）

### 6.3 CommandCode

**新規 Provider として追加する。**

```text
COMMANDCODE_API_KEY
```

- endpoint は `/alpha/billing/*` 系を想定（詳細は実装時に確定）
- 取得対象:
  - 5-hour window quota
  - weekly window quota
  - credits（monthly / purchased / free）
  - plan / subscription status / billing period end
  - usage summary（cost / requests / tokens）— quota に必要でなければ失敗しても全体失敗にしない
- undocumented API の依存を `commandcode/` ディレクトリ内に閉じる
- レスポンス schema は実装時に確定

**Support level:** `official-internal`

### 6.4 OpenAI API

**現行実装を維持し、構造だけ `ProviderResult` へ適合させる。**

- Organization Costs API / Organization Usage API は現行通り
- metric 名・label は維持
- request-time rate-limit header 観測は P2 で追加

**Support level:** `official-public`

### 6.5 Codex

**現行 `/wham/usage` 実装を維持し、内部表現を拡張する。**

- `primary_window` / `secondary_window` の分類は当面維持
- 内部で `QuotaWindow[]` へ変換する層を追加
- 未知の limit ID が出てきた場合も window 配列で表現できる構造とする
- Browser Rendering は optional fallback のまま
- reset credits 補助 endpoint の失敗は Codex 全体の失敗にしない

**Support level:** `official-internal`

## 7. Metric 設計

### 7.1 共通 quota metric

共通 builder は `ProviderResult` を受け取り、以下の metric を生成する。

```text
<provider>_usage_ratio{period}
<provider>_reset_timestamp_seconds{period}
```

### 7.2 Provider 固有 metric

```text
# OpenAI
openai_api_cost_usd{line_item}
openai_api_input_tokens{model}
openai_api_output_tokens{model}
openai_api_cached_tokens{model}
openai_api_requests{model}

# Codex
codex_credits_remaining
codex_reset_credits
codex_reset_credits_available_count
codex_plan_info{plan}

# OpenCodeGo
opencodego_zen_balance_usd

# Ollama Cloud
ollama_cloud_plan_info{plan}
ollama_cloud_model_requests{period,model}
ollama_cloud_activity_cost_usd

# CommandCode
commandcode_credits_remaining
commandcode_credits_monthly
commandcode_credits_purchased
commandcode_credits_free
commandcode_plan_info{plan}
```

### 7.3 存在しない値の扱い

未知・未対応・未取得の値は `0` として送信しない。該当する data point を emit しない。

- weekly window が存在しない → 該当 metric を送信しない
- Zen balance が取得できない → `opencodego_zen_balance_usd` を送信しない
- reset timestamp が不明 → `*_reset_timestamp_seconds` を送信しない

### 7.4 Plan info metric

info metric 形式を使用する。

```text
codex_plan_info{plan="plus"} 1
ollama_cloud_plan_info{plan="pro"} 1
commandcode_plan_info{plan="goat"} 1
```

label cardinality を抑えるため、plan 名以外の識別子は含めない。

### 7.5 Provider scrape health metrics

P1 で以下を導入する。

```text
provider_metrics_scrape_success{provider}
provider_metrics_scrape_timestamp_seconds{provider}
provider_metrics_scrape_duration_seconds{provider}
```

- `scrape_success`: 取得成功時 `1`、失敗時 `0`（skipped 時は emit しない）
- `scrape_timestamp_seconds`: 最終成功時刻
- `scrape_duration_seconds`: 取得処理時間（秒）

### 7.6 Stale data 防止

取得失敗時に過去の metric を再送しない。失敗した Provider の metric はその回の push に含めない。

## 8. エラー処理・セキュリティ

### 8.1 Provider 障害分離

- 各 adapter は `Promise.allSettled` で並列実行
- 1 Provider の失敗は他 Provider の取得・送信を妨げない
- 1 つ以上の Provider が成功していれば、成功した Provider の metric を push する
- 全 Provider が skipped / failed / empty の場合のみ push を中止

### 8.2 Retry policy

| 状況 | retry |
|---|---|
| 401 | なし |
| 403 | 原則なし |
| 429 | あり |
| 5xx | あり |
| network error | あり |
| schema / parse error | なし |

bounded exponential backoff を使用する。

### 8.3 Timeout

各 Provider request に有限の timeout を設定する。

| Provider | timeout |
|---|---|
| OpenAI API | 20s |
| Codex | 30s |
| OpenCodeGo API | 10s |
| Ollama Cloud API | 10s |
| CommandCode | 10s |

### 8.4 Schema validation

- 外部サービスからの response は使用前に runtime validation
- JSON field の存在、型、範囲、timestamp 形式を検証
- schema mismatch は parse/schema error として扱い、その Provider の metric 生成を停止
- 他 Provider は継続

### 8.5 Credential 非露出

- API key / OAuth token / session cookie / Authorization header をログ・metric label・error message に出力しない
- HTTP error body をログに出す場合は、Credential が含まれないことを保証
- 環境変数は Wrangler secret として設定

### 8.6 Metric label cardinality

以下を無制限に label として使用しない。

- user ID
- request ID
- session ID
- API key ID
- arbitrary error message
- 正規化戦略のない model 名

### 8.7 Undocumented API の明示

`official-internal` / `web-internal` / `scraping` / `fallback` の取得経路は、adapter コード内の `supportLevel` フィールドとドキュメントで明示する。

## 9. Configuration と移行

### 9.1 環境変数

```text
# OpenAI
OPENAI_ADMIN_API_KEY
OPENAI_API_HISTORY_DAYS

# Codex
CODEX_ACCESS_TOKEN
CODEX_ACCOUNT_ID
CODEX_PROXY_URL
CODEX_PROXY_SECRET
CODEX_API_BASE_URL

# OpenCodeGo
OPENCODEGO_API_KEY
OPENCODEGO_SESSION_COOKIE
OPENCODEGO_WORKSPACE_ID

# Ollama Cloud
OLLAMA_API_KEY
OLLAMA_SESSION_COOKIE

# CommandCode
COMMANDCODE_API_KEY

# Shared
GRAFANA_CLOUD_PROMETHEUS_URL
GRAFANA_CLOUD_PROMETHEUS_USERNAME
GRAFANA_CLOUD_ACCESS_POLICY_TOKEN
MYBROWSER
```

### 9.2 移行方針

| Provider | 移行内容 |
|---|---|
| OpenAI | 現行維持、破壊的変更なし |
| Codex | 現行 `/wham/usage` 維持、内部を `QuotaWindow[]` へ拡張 |
| OpenCodeGo | Primary を API key 経由 `/zen/go/v1/usage` へ。Cookie/RPC は Zen balance fallback のみ残す |
| Ollama Cloud | Primary を API key 経由 `/api/usage` へ。Cookie/HTML は optional fallback |
| CommandCode | 新規追加 |

## 10. テスト戦略

### 10.1 Unit test

各 Provider adapter について以下をテストする。

- valid response
- optional field 欠落
- zero usage
- quota near limit
- quota exhausted
- reset timestamp
- multiple windows
- HTTP 401 / 403 / 429 / 500
- timeout
- invalid JSON
- unexpected HTML
- schema mismatch
- negative percentage
- percentage > 100
- invalid timestamp
- missing required field

### 10.2 Orchestrator test

- 複数 Provider を同時実行し、1 Provider 失敗時に他 Provider の metric が送信されることを確認
- 全 Provider 失敗時に push が行われないことを確認
- health metric が正しく生成されることを確認

### 10.3 CI gates

- `make typecheck`
- `make test`
- `make fmt`
- `make validate`

## 11. Acceptance Criteria

本改修は以下をすべて満たした時点で完了とする。

- OpenAI API costs / usage の既存 metric が維持されている
- OpenCode Go quota を API key のみで取得できる
- OpenCode Go quota 取得に browser cookie を必要としない
- OpenCode Go rolling / weekly / monthly を扱える
- Ollama Cloud usage を API key のみで取得できる
- Ollama legacy session / weekly を扱える
- Ollama 新 plan monthly usage を扱える
- Ollama の存在しない window を `0` として出力しない
- CommandCode の 5h / weekly quota を取得できる
- CommandCode credits を取得できる
- Codex 現行 quota 取得がデグレしていない
- Codex adapter が将来的な multiple limit に対応可能な構造になっている
- 1 Provider の failure で他 Provider の metric が失われない
- undocumented API の schema mismatch を安全に検知できる
- Credential が log / metric へ露出しない
- Provider ごとの最終成功時刻を監視可能である
- Provider adapter ごとの unit test が存在する
- ドキュメントに各取得経路の support level が記載されている
