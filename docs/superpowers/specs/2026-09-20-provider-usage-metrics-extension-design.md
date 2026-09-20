<!-- markdownlint-disable MD013 -->

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

本書に記載する外部 API の endpoint、認証、response shape、単位、失敗時の扱いは実装時に変更しない。外部 API が未公開であっても、実装対象とする観測済み contract を本書で固定し、fixture と schema validator はその contract に従う。

### P0（最優先）

1. OpenCode Go `/zen/go/v1/usage` API key ベース取得対応
2. Ollama Cloud `/api/usage` API key ベース取得対応
3. Ollama Cloud monthly plan 対応

### P1

1. CommandCode Provider 追加
2. Provider scrape health / last success metrics 導入

### P2（対象外）

- Codex の未知の limit ID および複数 limit の一般化
- OpenAI request-time rate-limit metrics
- OpenCode Zen balance legacy adapter の整理

## 3. 背景

現行の Provider Metrics Worker は以下の取得経路を使用している。

- OpenAI API: Organization Costs API / Organization Usage API（公式 API）
- Codex: ChatGPT backend `/wham/usage`（内部 API）
- OpenCode Go: HTML scraping + `_server` RPC（session cookie 必須）
- Ollama Cloud: `/settings` HTML scraping（session cookie 必須）

2026 年 9 月時点で、OpenCode Go には first-party usage endpoint、Ollama Cloud には API key で呼び出せる JSON usage endpoint、Command Code には CLI が使用する alpha usage endpoint 群が確認されている。これらを primary 取得経路とし、HTML scraping や cookie への依存を減らす。

外部 contract の根拠は次のとおりである。

- OpenCode Go: `GET https://opencode.ai/zen/go/v1/usage` の実クライアント実装と response fixture。`usage.rolling`、`usage.weekly`、`usage.monthly` が percent と ISO 8601 の `resetsAt` を返す。
- Ollama Cloud: `GET https://ollama.com/api/usage` の観測 response と公式 pricing の月次プラン説明。endpoint は未公開 contract であり、legacy の session/weekly limit と新しい monthly plan の activity を別々に扱う。
- Command Code: 公式 `command-code` CLI の `/usage` 実装（2026-09-20 時点の npm package `command-code@1.58.0`）で確認した alpha endpoint 群。endpoint は公開 Provider API contract ではないため、versioned fixture と厳格な schema validation を必須とする。

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
export type ProviderId =
  "openai_api" | "codex" | "opencodego" | "ollama_cloud" | "commandcode";

export type SupportLevel =
  "official-public" | "official-internal" | "web-internal" | "scraping";

export type SourceRole = "primary" | "enrichment" | "fallback";

export interface ProviderSource {
  /** source identity is diagnostic-only and is never a metric label */
  id: string;
  supportLevel: SupportLevel;
  role: SourceRole;
}

export type QuotaPeriod = "session" | "weekly" | "monthly" | "rolling";

export interface QuotaWindow {
  /** Only this closed set may be emitted as the Prometheus period label. */
  period: QuotaPeriod;
  /** Source period for diagnostics; never emitted as a label. */
  rawPeriod?: string;
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

export interface ProviderSubscription {
  status?: string;
  billingPeriodEndSeconds?: number;
}

export interface ProviderUsageSummary {
  costUSD?: number;
  requests?: number;
  tokens?: number;
}

export interface OpenAICostMetric {
  lineItem: string;
  costUSD: number;
}

export interface ProviderModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  requests: number;
}

export interface ProviderModelRequest {
  period: "session" | "weekly";
  model: string;
  requestCount: number;
}

export interface ProviderResultBase<P extends ProviderId> {
  provider: P;
  /** Sources that actually contributed to this result, not supported sources. */
  sources: ProviderSource[];
  windows: QuotaWindow[];
}

export type ProviderResult =
  | (ProviderResultBase<"openai_api"> & {
      costs: OpenAICostMetric[];
      modelUsage: ProviderModelUsage[];
    })
  | (ProviderResultBase<"codex"> & {
      plan?: string;
      credits?: ProviderCredits;
    })
  | (ProviderResultBase<"opencodego"> & {
      zenBalanceUSD?: number;
    })
  | (ProviderResultBase<"ollama_cloud"> & {
      plan?: string;
      modelRequests: ProviderModelRequest[];
      activityCostUSD?: number;
    })
  | (ProviderResultBase<"commandcode"> & {
      plan?: string;
      subscription?: ProviderSubscription;
      credits?: ProviderCredits;
      usage?: ProviderUsageSummary;
    });
```

`rawPeriod` は診断用の値であり、任意の文字列を Prometheus label に流用しない。未知の source period はその window を emit せず、必要な場合だけ安全な diagnostic report に記録する。

`ProviderResult` は `provider` を discriminator とする closed union である。provider 固有 metric の payload は対応する union member に必ず保持し、共通 `usage` へ異なる意味の値を畳み込まない。OpenAI の `costs` と `modelUsage`、OpenCode Go の `zenBalanceUSD`、Ollama の `modelRequests` と `activityCostUSD` はそれぞれ専用 field を使用する。builder は `provider` の exhaustive dispatch で exact metric name と label を選択する。

`sources` は adapter が実際に result の生成へ寄与した取得経路だけを含む。registry が提供する静的な supported-source metadata は runtime provenance と別の metadata として扱い、`ProviderResult` の `sources` には含めない。

`SourceRole` は `ProviderResult.sources` に公開する取得経路にだけ適用する。adapter 内部で別の request の入力を準備する prerequisite は `ProviderSource` として返さず、必要な場合だけ `ProviderError.sourceId` に使用する。

### 4.3 Adapter 関数型

```ts
export type ProviderAdapter = (
  env: ProviderMetricsEnv,
  ctx: ProviderContext,
) => Promise<AdapterOutcome>;
```

`ProviderContext` は次の interface を使用する。`ScheduledEvent.scheduledTime` は milliseconds であるため、orchestrator が一度だけ `Math.floor(event.scheduledTime / 1000)` へ変換して渡す。`openaiHistoryDays` は OpenAI preflight で検証済みの値であり、OpenAI adapterだけが使用する。`nowSeconds` は health timestamp と enrichment の判定時刻に使い、`monotonicNowMs` は adapter invocation の duration 計測だけに使う。いずれもテストでは固定値を注入する。

```ts
export interface ProviderContext {
  fetchFn: typeof fetch;
  scheduledTimeSeconds: number;
  /** OpenAI preflightで正規化した履歴日数。OpenAI adapterだけが使用する。 */
  openaiHistoryDays: number;
  nowSeconds: () => number;
  monotonicNowMs: () => number;
  browserBinding?: Fetcher;
}
```

adapter の return type は次の closed outcome とする。credential がない場合、または OpenAI preflight configuration が invalid な場合の `skipped` は orchestrator が作り、adapter は呼び出さない。preflight skip は `ProviderError` ではない。

```ts
export type ProviderErrorKind =
  | "auth"
  | "forbidden"
  | "upstream_4xx"
  | "rate_limit"
  | "upstream_5xx"
  | "network"
  | "timeout"
  | "schema"
  | "parse"
  | "internal";

export interface ProviderError {
  kind: ProviderErrorKind;
  provider: ProviderId;
  sourceId: string;
  statusCode?: number;
}

export type AdapterOutcome =
  | { status: "success"; result: ProviderResult }
  | { status: "empty"; reason: "no-supported-window" | "no-activity" }
  | { status: "failed"; error: ProviderError };
```

`empty` は response を正常に取得・検証したが、出力対象の data point がない状態であり、health 上は scrape success とする。`failed` は primary request の中間状態ではなく、Provider-specific recovery / status interpretation を適用した後の最終 outcome である。required primary result を recovery 後も成立させられない request failure（auth、forbidden、upstream 4xx、rate limit、upstream 5xx、network、timeout を含む）、または required primary contract を満たせない fatal な schema/parse failure に限る。

required primary source の transport、HTTP status、fallback / recovery に関する最終 outcome は、次の precedence で一意に決定する。

1. primary request を実行する。
2. response または request failure を Provider-specific contract で分類し、status interpretation または fallback / recovery の対象かを判定する。
3. Provider-specific contract が fallback / recovery を定義している場合は、それを実行する。primary request の失敗を検知した時点では `failed` を確定しない。
4. recovery が有効な result を生成した場合は `AdapterOutcome.success` とする。
5. Provider-specific status interpretation が empty を定義し、recovery が不要または定義されていない場合は `AdapterOutcome.empty` とする。
6. recovery が存在しない、利用不能、または失敗し、success / empty の contract を満たせない場合だけ `AdapterOutcome.failed` とする。

この precedence では、transport / HTTP status / fallback に関する Provider-specific contract を generic failure rule より優先する。recovery で result が成立した場合は、失敗した primary source を success result の provenance に含めない。response が正常に取得された後の schema / parse failure、optional field failure、optional enrichment-source failure の ownership は、以下の三分類と §6.x の Provider-specific rule に従い、この precedence によって変更しない。

`getWithRetry()` は retry exhausted の transport failure を typed `HttpTransportError` として返し、`kind` に `network` または `timeout` を保持する。raw exception message、response body、credential は `HttpTransportError` の公開情報に含めない。HTTP response を取得できた場合は adapter が status を endpoint 固有の `ProviderError.sourceId` と結び付ける。adapter wrapper が予期しない rejection を受け取った場合は、registry の固定 `primarySourceId` を使用し、`statusCode` を持たない `ProviderError.kind = "internal"` の `failed` outcomeへ変換する。`internal` は adapter が `AdapterOutcome` contract に反して reject した場合だけに使用し、raw exception message、response body、credential は公開しない。既知の transport / HTTP / schema / parse failure を `internal` に変換してはならない。

schema / parse failure の ownership は次の順序で決定する。

- **Fatal required-contract failure:** required primary source または `ProviderResult` の生成に必須な field の failure は `AdapterOutcome.status = "failed"` とし、`ProviderError.kind` に `schema` または `parse` を設定する。該当 Provider の data metric は push しない。
- **Optional field failure:** Provider-specific contract が optional と定義した field の validation / parse failure は、その field または metric だけを omit する。`ProviderError` は返さず、primary result を `success` として維持する。
- **Optional enrichment-source failure:** primary result が成立した後の optional enrichment source の transport / schema / parse failure は、その enrichment contribution だけを omit する。`ProviderError` は返さず、primary result を `success` として維持する。

§6.x に field-level omission または enrichment-only failure が明示されている場合は、その Provider-specific rule が generic schema-failure rule より優先する。generic schema mismatch を `failed` とするのは、required primary contract を満たせず、かつ Provider-specific partial-success rule が存在しない場合だけである。

### 4.4 Orchestrator の流れ

1. orchestrator が Provider ごとの primary credential と preflight configuration の有効性を判定する。credential がない Provider、または OpenAI の `OPENAI_API_HISTORY_DAYS` が無効な Provider は `skipped` とし、adapter を呼び出さない。
2. credential と preflight configuration が有効な Provider の adapter を `Promise.allSettled` で並列実行する。
3. adapter は `AdapterOutcome` を返し、orchestrator は result、failure、empty を分離する。
4. 各 adapter invocation の直前に monotonic start を取得し、adapter promise が settle した直後に monotonic end と success/empty timestamp を取得する。retry と enrichment は同じ計測区間に含める。
5. 成功した Provider の data metric と、試行した全 Provider の health metric を共通 OTLP builder で生成する。
6. 少なくとも1 Provider が試行された場合は、data metric が0件でも health-only payload を Grafana Cloud へ push する。
7. 全 Provider が credential 不足または invalid preflight configuration で skipped の場合だけ push を省略する。

diagnostic report の provider status は `skipped`、`success`、`empty`、`failed` の4値とする。`empty` は health metric では `scrape_success=1` として扱うが、report では `empty` を保持する。registry の provider 順序で全 status を生成し、success/empty/failed の outcome を skipped に変換しない。

`failed` の diagnostic は `ProviderError` から `statusCode?`、`provider`、`sourceId`、`kind` だけを投影する。例外メッセージ、response body、credential、Authorization header は Worker log と diagnostic report のどちらにも含めない。

## 5. ファイル構成

```text
workers/src/provider-metrics/
├── types.ts              # 共通型・adapter interface
├── adapters.ts           # adapter registry / 実行ラッパー
├── prometheus.ts         # OTLP metric 生成（ProviderResult を受け取る）
├── health.ts             # scrape health metric 生成
├── openai-api.ts         # 現行を維持しつつ ProviderResult へ変換
├── codex.ts              # 現行の session / weekly semantics を維持して変換
├── opencodego/
│   ├── index.ts          # adapter エントリ
│   ├── api-key.ts        # /zen/go/v1/usage 取得
│   └── zen-balance.ts    # cookie/RPC enrichment（optional）
├── ollama/
│   ├── index.ts          # adapter エントリ
│   ├── api-usage.ts      # /api/usage JSON
│   └── settings-html.ts  # cookie/HTML enrichment or fallback
└── commandcode/
    ├── index.ts          # adapter エントリ
    └── billing.ts        # alpha billing/usage endpoints
```

既存の `workers/src/provider-metrics/opencodego.ts` は、Cookie/RPC の必要な処理を `opencodego/zen-balance.ts` へ移行した後に削除する。既存の `workers/src/provider-metrics/opencodego-parser.ts` は legacy HTML/RPC parser helper の owner として残し、無関係な parser refactor は行わない。

runtime schema validation は新規 validation library を追加せず、各 Provider module の `unknown` 入力に対する type guard と numeric/date validator で実装する。`workers/package.json` の依存関係は変更しない。JSON Schema library を導入する設計は採用しない。

共有 retry helper の typed transport error seam と、その unit test のため `workers/src/http-retry.ts` は変更対象に含める。provider adapter はこの seam を介して network/timeout を source-local な `ProviderError` へ変換する。

## 6. Provider 別設計

### 6.1 OpenCode Go

**Primary 取得経路を API key ベースに移行する。**

```text
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OpenCode Go API key>
Accept: application/json
```

request body と query は持たず、成功 status は `200` とする。timeout は 10 秒である。401 は `auth` とし、403 は response body の安全な error type が `EntitlementError` の場合に `empty/no-supported-window`、それ以外は `forbidden` とする。403 の判定は §4.3 の recovery / status precedence における Provider-specific status interpretation であり、HTTP status だけで generic `failed` を先に確定しない。

- `403 + EntitlementError` は `AdapterOutcome.empty`、`provider_metrics_scrape_success{provider="opencodego"}=1`、scrape timestamp 更新とする。Provider data metric は生成しない。
- その他の 403 は `AdapterOutcome.failed`、`ProviderError.kind = "forbidden"`、`ProviderError.sourceId = "opencodego-usage-api"`、`statusCode = 403` とする。`scrape_success=0` とし、scrape timestamp は更新しない。

expected response は次の JSON shape とする。`usage` と3 window は必須、`resetsAt` は upstream が省略する場合があるため optional とする。unknown field は ignore する。

```json
{
  "usage": {
    "rolling": {
      "status": "ok",
      "percent": 12,
      "resetsAt": "2026-09-20T17:00:00.000Z"
    },
    "weekly": {
      "status": "ok",
      "percent": 8,
      "resetsAt": "2026-09-22T00:00:00.000Z"
    },
    "monthly": {
      "status": "ok",
      "percent": 35,
      "resetsAt": "2026-10-04T11:18:32.000Z"
    }
  }
}
```

- `status` は空でない string とし、`percent` は finite な `0..100` の number とする。
- `percent` は「使用済み percent」であり、`usageRatio = percent / 100` とする。
- `resetsAt` は absolute ISO 8601 timestamp とし、parse 後に Unix epoch seconds へ変換する。残秒数 variant は受け付けない。
- `status` が `ok` 以外でも、percent が範囲内なら値を採用する。`rate-limited`、`exhausted` は `exceeded=true` とし、percent が100未満なら schema error とする。
- `rolling`、`weekly`、`monthly` をそれぞれ canonical period の `rolling`、`weekly`、`monthly` へ変換する。`usage` または各 required window の欠落、`status` / `percent` の型・範囲不正は required primary contract の fatal `schema` failure とする。`resetsAt` は optional field とし、欠落は正常として扱い、存在しても ISO 8601 として parse できない場合は reset metric だけを omit して quota result を `success` とする。この場合は `ProviderError` を返さない。
- Zen balance は Go usage endpoint が返さない場合のみ、既存 cookie/RPC adapter を `enrichment` として実行する。
- Zen balance 取得失敗は Go quota の失敗にせず、`opencodego_zen_balance_usd` を emit しない。
- Zen balance が取得できた場合は `ProviderResult.zenBalanceUSD` へ格納する。`ProviderCredits.remaining` は使用せず、共通 credits builder から `opencodego_credits_remaining` を生成してはならない。
- Cookie/RPC 経路を primary にしない。

**Support level:** `official-internal`

### 6.2 Ollama Cloud

**Primary 取得経路を API key ベースに移行する。**

```text
GET https://ollama.com/api/usage
Authorization: Bearer <Ollama API key>
Accept: application/json
```

request body と query は持たず、成功 status は `200` とする。`OLLAMA_API_KEY` がない場合は adapter を起動せず orchestrator が skip する。401/403 は `auth`/`forbidden`、429 は `rate_limit`、500 以上は `upstream_5xx`、その他の non-2xx（HTTP 400 を含む）は `upstream_4xx` とする。HTTP 400 は `ProviderError.kind = "upstream_4xx"`、`ProviderError.sourceId = "ollama-api-usage"`、`statusCode = 400` として保持する。これらの primary API request failure（`network`、`timeout`、`auth`、`forbidden`、`upstream_4xx`、`rate_limit`、`upstream_5xx`）は、`OLLAMA_SESSION_COOKIE` がある場合に限り、§4.3 の precedence に従って HTML fallback の判定対象となる。HTTP `200` response の required primary schema / parse failure は HTML fallback に変換せず、fatal schema / parse ownership を維持する。

API の観測済み envelope は次のとおりである。`limits` と `activity` はそれぞれ optional contribution であり、少なくともどちらか一方の認識可能な primary content があれば `success` とする。片方の optional field、model entry、または activity cost の schema / parse failure は該当 contribution だけを omit し、もう片方の認識可能な primary content による result を維持する。両方が欠落、または両方が認識不能な場合だけ required primary content の fatal `schema` failure とする。

```json
{
  "activity": {
    "cost": "12.34000",
    "period": {
      "type": "last_4_weeks",
      "starting_at": "2026-09-01T00:00:00Z",
      "ending_at": "2026-09-20T12:00:00Z"
    },
    "models": [{ "name": "glm-5.3-flash", "request_count": 54 }]
  },
  "limits": {
    "session": {
      "usage": 0.03,
      "models": [{ "name": "glm-5.3-flash", "request_count": 54 }]
    },
    "weekly": {
      "usage": 0.005,
      "models": [{ "name": "glm-5.3-flash", "request_count": 458 }]
    }
  }
}
```

- `limits.session.usage` と `limits.weekly.usage` は 5-hour / 7-day allowance の使用済み ratio `0..1` であり、そのまま `usageRatio` とする。percent への変換は行わない。
- `limits.session` / `limits.weekly` が存在しない monthly plan では、quota window を合成しない。`activity.cost` があれば monthly-plan の usage cost として `ollama_cloud_activity_cost_usd` を emit する。
- `activity.period.type` の `last_4_weeks` は activity 集計期間であり、quota の `monthly` label には変換しない。`activity.period.starting_at` / `ending_at` は diagnostic-only とする。
- `request_count` は finite な非負 safe integer とする。不正な model entry はその entry だけを捨て、limits 本体を failure にしない。
- `activity.cost` は非負の decimal string とし、number へ変換できない場合は activity cost だけを omit する。limits が有効なら Provider success を維持する。
- legacy と monthly の fields が同時に存在する場合、session/weekly limits と activity cost を独立に採用する。monthly plan の存在を理由に legacy limits を上書きしない。
- JSON に plan や exact reset timestamp は存在しないため、API response だけでは plan/reset metric を生成しない。
- `OLLAMA_SESSION_COOKIE` があり、JSON API が成功したものの plan/reset の不足 field がある場合は、`/settings` を **HTML enrichment path** として実行する。JSON API の primary request が `network`、`timeout`、`auth`、`forbidden`、`upstream_4xx`、`rate_limit`、`upstream_5xx` のいずれかで失敗した場合は、HTML が少なくとも1つの valid な quota window、plan、または reset timestamp を寄与できたときだけ ProviderResult 全体を代替する **HTML fallback path** として実行する。HTTP 400 もこの fallback candidate に含め、valid HTML なら `success`、HTML が失敗または有効な contribution を返さなければ元の `upstream_4xx`、`statusCode = 400`、`sourceId = "ollama-api-usage"` を保持する。HTML の `Session usage` または `Hourly usage` は必ず canonical `session`、`Weekly usage` は `weekly`、`Monthly usage` は `monthly` に変換する。`Hourly usage` の mapping は現行 parser の contract として固定し、実装者判断にしない。
- API が quota/activity を返した場合に HTML から valid な plan または reset timestamp を少なくとも1つ取得できれば、JSON の primary result を維持し、`ollama-settings-html` を `enrichment` として追加する。plan と各 reset timestamp は独立した optional field とし、invalid / missing な field はその field だけを omit する。HTML が有効な field を1つも寄与できない場合も HTML enrichment-only failure とし、API の primary failure にはしない。API request が失敗した場合は、HTML が valid な quota window、plan、または reset timestamp を1つも返さなければ fallback failure とし、`AdapterOutcome.failed`、`scrape_success=0`、scrape timestamp 未更新、`ProviderError.sourceId = "ollama-api-usage"` とする。final `ProviderError.kind` と `statusCode` は元の API failure を保持し、fallback 側の error で置換しない。fallback が成功した場合は `AdapterOutcome.success`、`scrape_success=1`、scrape timestamp 更新、`ollama-settings-html` を `fallback` として追加する。
- API と HTML の両方が同じ field を返した場合は API の quota/activity を優先し、HTML は plan/reset の不足分だけを補う。
- 認識できない top-level period や limit key は arbitrary label として emit しない。

`limits.session.models[]` と `limits.weekly.models[]` の `models[].name` を `model` label に使用する際の policy は次のとおり固定する。

- wire value は `string` のみ受け付け、他の型から文字列へ coercion しない。
- `trimmed = name.trim()` を検証に使用し、`trimmed` の長さは 1..128 の ASCII characters とする。`name !== trimmed` の場合は先頭または末尾の whitespace として invalid とし、trim 結果を label に使用しない。
- `name` は `^[A-Za-z0-9._:/-]+$` に完全一致しなければならない。内部 whitespace、Unicode 文字、その他の文字は受け付けない。
- invalid、oversized、unsupported な model name は `unknown` / `other` へ変換せず、その model entry の data point だけを omit する。ほかの valid entry と limits 本体の success は維持する。
- valid な name は lower-case 化、alias 化、文字置換をせず、元の文字列をそのまま `model` label に使用する。したがって `Foo` と `foo` は別の identifier として扱う。
- duplicate aggregation は model-label validation の後に行い、同じ `period` と完全一致する model identifier の `request_count` だけを同一 window 内で合算する。正規化による別名への collision は作らない。

`ollama_cloud_model_requests{period,model}` の source-to-label mapping は次のとおり固定する。

| wire source               | public metric                 | `period` value | handling                             |
| ------------------------- | ----------------------------- | -------------- | ------------------------------------ |
| `limits.session.models[]` | `ollama_cloud_model_requests` | `session`      | `request_count` を model ごとに emit |
| `limits.weekly.models[]`  | `ollama_cloud_model_requests` | `weekly`       | `request_count` を model ごとに emit |
| `activity.models[]`       | なし                          | なし           | `model_requests` には使用しない      |

同じ `model` が session と weekly の双方に存在する場合は、別の `period` series として独立して emit し、合算・dedupe しない。同一 window の同一 model が複数 entry に分かれている場合は、その window 内で `request_count` を合算して1 seriesにする。不正な model entry は該当 entry だけを omit する。`activity.period.type` の値から `monthly` などの label を合成しない。

API adapter は validated な model entry を `ProviderResult.modelRequests` へ保持し、`activity.cost` は `ProviderResult.activityCostUSD` へ保持する。これらを `ProviderResult.usage` の `requests` / `costUSD` に変換しない。builder は `modelRequests` から `ollama_cloud_model_requests{period,model}` を、`activityCostUSD` から `ollama_cloud_activity_cost_usd` を生成する。

**Support level:** `official-internal`（`/api/usage`）、`scraping`（`/settings` HTML）。`ollama-api-usage` は `primary` とし、`ollama-settings-html` は JSON API 成功時の不足 field 補完では `enrichment`、API 失敗時の ProviderResult 代替では `fallback` とする。

### 6.3 CommandCode

**新規 Provider として追加する。**

```text
COMMAND_CODE_API_KEY
```

Command Code CLI の convention に合わせ、project-local alias `COMMANDCODE_API_KEY` は追加しない。base URL は `https://api.commandcode.ai` に固定する。CLI `command-code@1.58.0` の `dist/cli.mjs` にある `buildUsageEndpoint` と `fetchUsageData` の request construction を authoritative source とし、query、body、入力依存関係を次の表で固定する。CLI の共通 client が付ける必須 header は `Authorization: Bearer <COMMAND_CODE_API_KEY>` と `Content-Type: application/json` である。`Accept` は CLI の request construction に含まれないため、存在を前提にしない。

使用する endpoint は次の4つに限定する。

| endpoint path                  | method | query parameters                                                | body | required headers                                  | input dependency                                        | success status |
| ------------------------------ | ------ | --------------------------------------------------------------- | ---- | ------------------------------------------------- | ------------------------------------------------------- | -------------- |
| `/alpha/whoami`                | GET    | `limits=1`                                                      | none | `Authorization`, `Content-Type: application/json` | none                                                    | `200`          |
| `/alpha/billing/credits`       | GET    | `orgId=<whoami.org.id>`                                         | none | `Authorization`, `Content-Type: application/json` | `whoami.org.id`                                         | `200`          |
| `/alpha/billing/subscriptions` | GET    | `orgId=<whoami.org.id>`                                         | none | `Authorization`, `Content-Type: application/json` | `whoami.org.id`                                         | `200`          |
| `/alpha/usage/summary`         | GET    | `orgId=<whoami.org.id>`; `since=<currentPeriodStart>`（存在時） | none | `Authorization`, `Content-Type: application/json` | `whoami.org.id`; subscription `data.currentPeriodStart` | `200`          |

全 endpoint の URL は `https://api.commandcode.ai` と path を連結し、query parameter は URL encoding する。`since` は subscription response に有効な `data.currentPeriodStart` がある場合だけ付け、ない場合は `orgId` だけを送る。4 endpoint とも request body は持たない。

request dependency は次の実行 graph に固定する。

```text
GET /alpha/whoami?limits=1
  └─ whoami.org.id
       ├─ GET /alpha/billing/credits?orgId=<org.id>
       └─ GET /alpha/billing/subscriptions?orgId=<org.id>
              └─ data.currentPeriodStart（存在時）
                   └─ GET /alpha/usage/summary?orgId=<org.id>&since=<currentPeriodStart>
```

`whoami` の `org.id` は non-empty string として検証し、欠落または型不正なら `schema` failure として後続 endpoint は呼ばない。`credits` と `subscriptions` は `org.id` が得られた後に並列で開始し、`summary` は両方の response が確定した後に呼ぶ。subscription failure または `currentPeriodStart` 欠落時も `summary` は `orgId` だけで呼び出す。

`whoami` の expected response は次の shape とする。`org.id` は後続3 endpoint の `orgId` query に使用し、login/name は diagnostic-only である。

```json
{
  "org": { "id": "org_123", "login": "example" },
  "user": { "userName": "example", "name": "Example", "keyName": "ci" }
}
```

`billing/credits` の expected response は次の shape とする。`windowLimits` は `credits` の外側にある top-level sibling である。

```json
{
  "credits": {
    "monthlyCredits": 70.0,
    "purchasedCredits": 5.0,
    "freeCredits": 0.0
  },
  "windowLimits": {
    "limited": true,
    "fiveHour": { "used": 0.57, "cap": 14.0, "resetAt": 1789923600000 },
    "weekly": { "used": 0.57, "cap": 35.0, "resetAt": 1790355600000 }
  }
}
```

- `credits` が存在しない、または `monthlyCredits` が finite な非負 number でない場合は `schema` failure とする。
- `purchasedCredits` と `freeCredits` は optional な非負 number とし、欠落時はその個別 metric を omit する。0 として補完しない。
- `remainingCredits` は wire field として信頼せず、`monthlyCredits + purchasedCredits + freeCredits` のうち存在する値だけを合計して算出する。monthly が存在しない場合は remaining metric を omit する。
- `windowLimits` は optional とし、欠落時は quota window を生成せず credits result を success とする。存在する場合は `limited` を boolean として検証し、型不正なら optional quota contribution だけを omit して credits result を維持する。`limited=false` は Provider が bounded quota を適用していない明示的な unlimited semantics とし、`fiveHour` / `weekly` が存在しても quota window を生成しない。`usageRatio`、`used`、`limit`、`exceeded`、reset metric のいずれも emit しない。
- `limited=true` の場合は `fiveHour` と `weekly` の両方を bounded quota の required entry とし、それぞれ canonical `session` / `weekly` へ変換する。いずれかの entry の欠落、`used` / `cap` の型・範囲不正、または `cap==0` は `billing/credits` の required quota contract に対する fatal `schema` failure とし、`ProviderError` を生成する。0 除算による `usageRatio=0` / `1` の補完は行わない。
- `windowLimits.*.resetAt` の accepted wire representation は JSON number のみとする。finite な非負値について、10^12 以上は epoch milliseconds、それ未満は epoch seconds として扱い、`resetTimestampSeconds` はそれぞれ `Math.floor(resetAt / 1000)` または `Math.floor(resetAt)` で算出する。numeric string、ISO 8601 string、負値、非有限値は current contract 外の invalid optional field とし、ISO parse や数値 coercion は行わず、その window の reset timestamp だけを omit する。quota window、usage ratio、exceeded は success のまま維持する。

CommandCode quota の `QuotaWindow` normalization は次の規則で固定する。

```text
windowLimits.fiveHour.used → period="session", used
windowLimits.fiveHour.cap  → period="session", limit
windowLimits.weekly.used   → period="weekly", used
windowLimits.weekly.cap    → period="weekly", limit
```

`cap>0` の bounded window では、`rawRatio = used / cap`、`usageRatio = min(rawRatio, 1)` とする。`usageRatio` は常に public contract の `0..1` に clamp するが、`used` と `limit` には wire の非負 finite な値をそのまま保持する。したがって `used>cap` は許容し、over-cap の raw 値を保持したまま `usageRatio=1`、`exceeded=true` とする。`used<cap` は `exceeded=false`、`used==cap` は `usageRatio=1` かつ `exceeded=true` とする。`resetAt` が valid な場合だけ `resetTimestampSeconds` を設定する。

`billing/subscriptions` の expected response は次の shape とする。

```json
{
  "data": {
    "planId": "individual-go",
    "status": "active",
    "currentPeriodStart": "2026-09-01T00:00:00Z",
    "currentPeriodEnd": "2026-10-01T00:00:00Z"
  }
}
```

`data` がない場合は subscription enrichment の schema failure とし、`AdapterOutcome.failed` や `ProviderError` にはせず、credits/quota result を維持する。`planId`、`status`、`currentPeriodStart`、`currentPeriodEnd` は存在時に non-empty string として検証する。`currentPeriodStart` と `currentPeriodEnd` は subscription 固有の ISO 8601 string contract とし、`resetAt` の numeric seconds/milliseconds rule は適用しない。ISO 8601 として parse できる場合だけ採用し、`currentPeriodStart` が欠落または parse 不能なら subscription metadata の他フィールドは維持して summary request から `since` だけを省略する。`currentPeriodEnd` が欠落または parse 不能なら `billingPeriodEndSeconds` だけを omit する。subscription endpoint の 401/403/429/5xx、network、timeout は subscription metadata のみ omit し、quota failure にはしない。

`usage/summary` の expected response は次の shape とする。

```json
{
  "totalCost": 0.57,
  "totalCount": 45,
  "totalTokens": 3100000
}
```

`totalCost` と `totalCount` は存在時に非負 finite number、`totalTokens` は optional な非負 safe integer とする。summary endpoint の transport、HTTP、schema failure は optional enrichment-source failure として usage summary のみ omit し、`AdapterOutcome.failed` や `ProviderError` にはせず、quota result は `success` のまま維持する。summary が成功した場合だけ cost/requests/tokens metric を emit する。

failure ownership は次のとおり固定する。

- `whoami` failure、`org.id` 欠落、または `billing/credits` failure → CommandCode provider failure。plan/credits/quota を push payload に含めない。
- `billing/subscriptions` failure → credits/quota は success のまま、plan/status/billing period end を omit。
- `usage/summary` failure → credits/quota は success のまま、usage summary metric を omit。
- 401 は `auth`、403 は `forbidden`、429 は `rate_limit`、500 以上は `upstream_5xx`、その他の non-2xx は `upstream_4xx`、network error は `network`、timeout は `timeout` とする。required primary endpoint の JSON shape 不一致、wire contract 上 required な numeric field の型・範囲不正、required な timestamp string の parse 不能は、それぞれ required primary contract の `schema` / `parse` failure として `ProviderError` を生成する。ただし、optional な `resetAt`、`currentPeriodStart`、`currentPeriodEnd` の扱いは上記の field-level omission を優先し、CommandCode provider failure や `ProviderError` にはしない。subscription / summary の optional enrichment-source failure も同様に partial success として扱う。
- undocumented API の依存は `commandcode/` ディレクトリ内に閉じ、response body、Authorization header、API key は error、log、diagnostic report、metric label のいずれにも出力しない。

`ProviderError.sourceId` は endpoint ごとに `whoami` → `commandcode-whoami`、`billing/credits` → `commandcode-billing-credits`、`billing/subscriptions` → `commandcode-billing-subscriptions`、`usage/summary` → `commandcode-usage-summary` と固定する。

**Support level:** `official-internal`

### 6.4 OpenAI API

**現行実装を維持し、構造だけ `ProviderResult` へ適合させる。**

- Organization Costs API / Organization Usage API は現行通り
- metric 名・label は維持
- `OPENAI_API_HISTORY_DAYS` は §9.1 の preflight contract に従い、normalized `1..31` を `ProviderContext.openaiHistoryDays` から adapter へ渡す。history window は `ProviderContext.scheduledTimeSeconds` を UTC anchor とする。
- invalid な `OPENAI_API_HISTORY_DAYS` は OpenAI adapter を呼ばず `skipped` とし、`ProviderError` / failure health / timestamp を生成しない。valid preflight の他 Provider は継続する。
- request-time rate-limit header 観測は P2 で追加

**Support level:** `official-public`

### 6.5 Codex

**現行 `/wham/usage` 実装を維持し、内部表現を拡張する。**

- `primary_window` / `secondary_window` の分類は当面維持
- 現行の session / weekly の2 window だけを `QuotaWindow[]` へ変換する層を追加
- `primary_window` は現行 classifier が session または weekly と判定した場合だけ emit する
- `secondary_window` も同じく session または weekly の場合だけ emit する
- 未知の limit ID、任意個数の window、`limitId` フィールドは今回追加しない。未知値は diagnostic に記録せず omit する
- primary `/wham/usage` request が HTTP 403 を返し、`browserBinding` が利用可能な場合だけ Browser Rendering fallback を試す。401、429、5xx、network、timeout、403 以外の HTTP failure、または HTTP 200 response の schema / parse failure では Browser Rendering fallback を試さず、primary failure / fatal contract failure とする。
- Browser Rendering が valid な usage response（少なくとも1つの supported window を含む）を生成した場合は、`AdapterOutcome.success`、`scrape_success=1`、scrape timestamp 更新、`codex-browser-rendering` を `fallback` として記録する。失敗した `codex-wham-usage` は success result の `ProviderResult.sources` に含めない。
- HTTP 403 で Browser Rendering fallback を試した後に browser launch、navigation、response、schema、parse のいずれかが失敗した場合は `AdapterOutcome.failed`、`scrape_success=0`、scrape timestamp 未更新とし、final `ProviderError.sourceId = "codex-browser-rendering"` とする。`ProviderError.kind` は Browser Rendering 側の最終 failure category を使用し、primary の 403 で置換しない。`browserBinding` がなく fallback を実行できない場合は fallback 未実行として `ProviderError.kind = "forbidden"`、`ProviderError.sourceId = "codex-wham-usage"`、`statusCode = 403` とする。
- reset credits 補助 endpoint の失敗は Codex 全体の失敗にしない

**Support level:** `official-internal`

## 7. Metric 設計

### 7.1 共通 quota metric

共通 builder は `ProviderResult` を受け取り、以下の metric を生成する。

```text
<provider>_usage_ratio{period}
<provider>_reset_timestamp_seconds{period}
```

`period` は `QuotaPeriod` の closed set だけを使用する。各 window の `usageRatio` が存在する場合だけ usage metric、`resetTimestampSeconds` が存在する場合だけ reset metric を emit する。`used`、`limit`、`rawPeriod` は arbitrary label に変換しない。

`usageRatio` の public range は全 Provider で `0..1` とする。wire の使用量と上限を持つ Provider は、raw value と public ratio の normalization を Provider 別設計で固定し、共通 builder は既に検証済みの `QuotaWindow` を再解釈しない。

builder の時間引数は `buildProviderMetrics(results, nowUnixNano, nowSeconds)` とする。`opencodego_reset_seconds_remaining{period}` は各 window の `resetTimestampSeconds` から `Math.max(resetTimestampSeconds - nowSeconds, 0)` で算出する。`nowSeconds` は呼び出し元から注入し、builder 内で wall clock を直接読まない。

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
opencodego_reset_seconds_remaining{period}
opencodego_zen_balance_usd

# Ollama Cloud
ollama_cloud_plan_info{plan}
ollama_cloud_model_requests{period,model}
ollama_cloud_activity_cost_usd

# CommandCode
commandcode_usage_ratio{period}
commandcode_reset_timestamp_seconds{period}
commandcode_credits_remaining
commandcode_credits_monthly
commandcode_credits_purchased
commandcode_credits_free
commandcode_plan_info{plan}
commandcode_subscription_info{plan,status}
commandcode_billing_period_end_seconds
commandcode_usage_cost_usd
commandcode_usage_requests
commandcode_usage_tokens
```

`ollama_cloud_model_requests{period,model}` は §6.2 の mapping と model-label policy に従い、validated model identifier だけを `model` label に使用する。`limits.session.models[]` だけを `period="session"`、`limits.weekly.models[]` だけを `period="weekly"` として emit し、invalid / oversized / unsupported な model string は data point を emit しない。`activity.models[]` はこの metric に使用しない。同じ model の session/weekly request は別 series であり、`monthly` series は生成しない。不正な model entry は該当 entry だけを omit し、同一 window 内の同じ `period` と exact model identifier は request count を合算する。

Provider 固有 field と metric の対応は次のとおり固定する。

| ProviderResult field                     | metric                                                                                                   | labels / value                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `openai_api.costs[].lineItem`, `costUSD` | `openai_api_cost_usd`                                                                                    | `line_item`, cost USD                |
| `openai_api.modelUsage[]`                | `openai_api_input_tokens`, `openai_api_output_tokens`, `openai_api_cached_tokens`, `openai_api_requests` | `model`, corresponding numeric field |
| `opencodego.zenBalanceUSD`               | `opencodego_zen_balance_usd`                                                                             | no label, balance USD                |
| `ollama_cloud.modelRequests[]`           | `ollama_cloud_model_requests`                                                                            | `period`, `model`, request count     |
| `ollama_cloud.activityCostUSD`           | `ollama_cloud_activity_cost_usd`                                                                         | no label, activity cost USD          |

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

- `provider` は `ProviderId` の closed set だけを使用する。
- `scrape_success`: adapter を試行し、response を正常に処理できた場合は `1`（data が空の `empty` を含む）、failure は `0`、credential 不足または invalid preflight configuration の skipped は emit しない。
- `scrape_timestamp_seconds`: success または empty の outcome が settle した直後に取得した `ProviderContext.nowSeconds()` の値を emit する。failure 時はこの series を更新しないため、Grafana 側に保存された最新値が last successful scrape time になる。Worker は値を永続保持しない。
- `scrape_duration_seconds`: adapter invocation の開始直前に取得した `ProviderContext.monotonicNowMs()` から、同じ adapter promise が settle した直後に取得した値までの秒数。retry、timeout、optional enrichment を含み、success/failure/empty の全試行で emit する。他 provider の settle 待機時間は含めない。
- last success query は `last_over_time(provider_metrics_scrape_timestamp_seconds{provider="..."}[2h])` とし、`time() - last_over_time(...)` で経過秒を求める。2時間以内に成功値がなければ stale と判定する。

### 7.6 Stale data 防止

取得失敗時に過去の metric を再送しない。失敗した Provider の metric はその回の push に含めない。

ただし、failure health metric は health-only または他 Provider の data payload とともに必ず push する。last-success timestamp の旧 data point は backend に保持させるが、Provider data metric の旧値を再送することはしない。

## 8. エラー処理・セキュリティ

### 8.1 Provider 障害分離

- 各 adapter は `Promise.allSettled` で並列実行
- 1 Provider の失敗は他 Provider の取得・送信を妨げない
- credential と preflight configuration が有効な Provider の `success` / `empty` / `failed` は health outcome として記録する
- 1 つ以上の Provider が試行された場合、data payload が0件でも health-only payload を push する
- 全 Provider が credential 不足または invalid preflight configuration で skipped の場合だけ push を省略する
- `success` は required primary result が成立していれば、optional field の omission または optional enrichment source failure を含んでも維持する
- §4.3 の recovery / status precedence に従い、required primary request failure を検知しただけでは `failed` を確定しない。Provider-specific fallback が成功した場合は `success`、contract-defined status interpretation が empty を返す場合は `empty` とする。
- `failed` は recovery / status interpretation の適用後も required primary result を成立させられない request failure、または required primary contract の fatal schema/parse failure に限定する。optional field validation failure、optional enrichment source failure、Provider-specific contract で omission が定義された parse failure は `failed` にしない。
- Ollama の API failure を HTML fallback が回復した場合、Codex の primary 403 を Browser Rendering fallback が回復した場合、OpenCode Go の `EntitlementError` 403 は、それぞれ `failed` ではない。fallback failure、または recovery / empty rule が適用されない primary failure は `failed` とする。
- adapter wrapper の予期しない rejection は `ProviderError.kind = "internal"`、registry 固定の primary `sourceId`、`statusCode` なしの `failed` とし、既知の transport / HTTP / schema / parse failureには使用しない。他 Provider の実行は継続する。

### 8.2 Retry policy

| 状況                 | retry    |
| -------------------- | -------- |
| 401                  | なし     |
| 403                  | 原則なし |
| 429                  | あり     |
| 5xx                  | あり     |
| network error        | あり     |
| schema / parse error | なし     |

bounded exponential backoff を使用する。

retry exhausted の network/timeout は `HttpTransportError.kind` を保持して adapter へ渡す。HTTP response が存在する 401/403/429/5xx とその他の non-2xx は response status を失わず、adapter がそれぞれ `auth` / `forbidden` / `rate_limit` / `upstream_5xx` / `upstream_4xx` へ変換する。schema / parse error は response status と混同しない。

### 8.3 Timeout

各 Provider request に有限の timeout を設定する。

| Provider         | timeout |
| ---------------- | ------- |
| OpenAI API       | 20s     |
| Codex            | 30s     |
| OpenCodeGo API   | 10s     |
| Ollama Cloud API | 10s     |
| CommandCode      | 10s     |

### 8.4 Schema validation

- 外部サービスからの response は `unknown` として受け取り、Provider-local type guard で使用前に runtime validation
- JSON field の存在、型、範囲、timestamp 形式、numeric unit を Provider ごとに検証
- schema validation failure の影響範囲は Provider-specific contract（§6.x）で定義した ownership に従う。field-level omission または enrichment-only failure が明示されている場合は、generic schema-failure rule より Provider-specific rule を優先する
- required primary contract を満たせない fatal schema/parse failure は `AdapterOutcome.failed` とし、`ProviderError.kind = "schema" | "parse"` を設定して、その Provider の data metric を停止する。他 Provider は継続する
- optional field の validation / parse failure は該当 field または metric だけを omit し、`ProviderError` を返さず primary result を `success` として維持する
- primary result 成立後の optional enrichment source の transport / schema / parse failure は enrichment contribution だけを omit し、`ProviderError` を返さず primary result を `success` として維持する
- Provider-specific partial-success rule が存在しない generic schema mismatch だけを、required primary contract の failure として `AdapterOutcome.failed` にする
- unknown field は ignore するが、required field の欠落を0や空文字で補完しない
- current contract にない response variant を推測して変換しない

### 8.5 Credential 非露出

- API key / OAuth token / session cookie / Authorization header をログ・metric label・error message に出力しない
- HTTP response body は error/log/diagnostic に出力しない
- HTTP failure の error/log/diagnostic は、`statusCode`（response が存在する場合）、`provider`、`sourceId`、`kind` の固定 allowlist 情報だけで構成する。任意の status text、response body、credential、Authorization header、raw exception message は公開しない
- Worker log と diagnostic report は同じ allowlist 契約に従い、adapter の例外メッセージをそのまま転送しない
- parser が必要とする response body は parser の scope 内だけで扱い、失敗後に保持しない
- 環境変数は Wrangler secret として設定

### 8.6 Metric label cardinality

以下を無制限に label として使用しない。

- user ID
- request ID
- session ID
- API key ID
- arbitrary error message
- arbitrary upstream model string

Ollama の `ollama_cloud_model_requests{period,model}` における `model` label は、§6.2 の bounded validation policy（1..128 の ASCII characters、`^[A-Za-z0-9._:/-]+$`、先頭/末尾 whitespace 不受理、置換・case folding なし）を通過した identifier だけを使用する。invalid value を `unknown` / `other` に集約せず、該当 data point を omit する。

### 8.7 Undocumented API の明示

各取得経路は source ID、`supportLevel`、`SourceRole` をコードとドキュメントで明示する。ただし、adapter 内部 prerequisite は `ProviderResult.sources` の provenance source ではないため、`SourceRole` を割り当てず、source ID を error ownership 用にだけ使用する。

| source ID                           | provider       | support level       | role / `ProviderResult.sources` handling           |
| ----------------------------------- | -------------- | ------------------- | -------------------------------------------------- |
| `openai-organization-api`           | `openai_api`   | `official-public`   | primary                                            |
| `codex-wham-usage`                  | `codex`        | `official-internal` | primary                                            |
| `codex-browser-rendering`           | `codex`        | `web-internal`      | fallback                                           |
| `opencodego-usage-api`              | `opencodego`   | `official-internal` | primary                                            |
| `opencodego-zen-rpc`                | `opencodego`   | `web-internal`      | enrichment                                         |
| `ollama-api-usage`                  | `ollama_cloud` | `official-internal` | primary                                            |
| `ollama-settings-html`              | `ollama_cloud` | `scraping`          | runtime: enrichment/fallback                       |
| `commandcode-whoami`                | `commandcode`  | `official-internal` | internal prerequisite; never included in `sources` |
| `commandcode-billing-credits`       | `commandcode`  | `official-internal` | primary                                            |
| `commandcode-billing-subscriptions` | `commandcode`  | `official-internal` | enrichment                                         |
| `commandcode-usage-summary`         | `commandcode`  | `official-internal` | enrichment                                         |

Ollama の `ProviderResult.sources` は実際に result へ寄与した runtime path で role を決定する。JSON API が quota/activity を生成し、HTML が plan/reset の不足分を補った場合は `ollama-api-usage` を `primary`、`ollama-settings-html` を `enrichment` として追加する。JSON API が失敗し、HTML が ProviderResult 全体を代替して成功した場合は `ollama-settings-html` だけを `fallback` として追加し、失敗した API を `primary` として追加しない。HTML を呼ばなかった場合、または呼んでも result に有効な field を寄与しなかった場合は `ollama-settings-html` を追加しない。同一 adapter 実行の `ProviderResult.sources` に同じ source ID を複数 role で重複追加せず、実際の path に対応する role を1つだけ選択する。API failure が回復せず ProviderResult を生成しない場合の final `ProviderError.sourceId` は常に `ollama-api-usage` とし、元の API failure の `kind` / `statusCode` を保持する。HTML fallback の failure でこの ownership を置換しない。

Codex の `ProviderResult.sources` は、Browser Rendering が実際に usage result を生成した場合に `codex-browser-rendering` を `fallback` として追加する。HTTP 403 で失敗した `codex-wham-usage` は fallback success の provenance に含めない。Browser Rendering fallback を試して失敗した場合は ProviderResult を返さず、final `ProviderError.sourceId` は `codex-browser-rendering` とする。HTTP 403 でも `browserBinding` がなく fallback を実行しなかった場合は、final `ProviderError.sourceId` を `codex-wham-usage` とする。

OpenCode Go の `403 + EntitlementError` は `AdapterOutcome.empty` であり、ProviderResult.sources を生成しない。その他の 403 は `ProviderError.sourceId = "opencodego-usage-api"` の `forbidden` failure とする。

CommandCode の `ProviderResult.sources` は次の規則で生成する。`billing/credits` が成功した場合は `commandcode-billing-credits` を必ず追加する。subscription の valid field が1つ以上 result へ採用された場合だけ `commandcode-billing-subscriptions` を追加し、summary の valid field が1つ以上 result へ採用された場合だけ `commandcode-usage-summary` を追加する。配列順も `billing-credits`、`billing-subscriptions`、`usage-summary` の固定順とする。`commandcode-whoami` は `org.id` を後続 request の入力としてだけ使用し、成功時も `sources` へ追加しない。required source が失敗して `ProviderResult` を生成しない場合、`sources` も返さない。これにより credits/quota、subscription、usage summary の各 data point の寄与元が一意になる。

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
COMMAND_CODE_API_KEY

# Shared
GRAFANA_CLOUD_PROMETHEUS_URL
GRAFANA_CLOUD_PROMETHEUS_USERNAME
GRAFANA_CLOUD_ACCESS_POLICY_TOKEN
MYBROWSER
```

`OPENAI_API_HISTORY_DAYS` の configuration contract は次のとおり固定する。

- 未指定時の default は `1`。
- configured value は `Number(rawValue)` で数値化し、`Number.isInteger(value)` かつ `1..31` の場合だけ valid とする。
- `ProviderContext.openaiHistoryDays` には、orchestrator の preflight で検証した normalized integer を渡す。OpenAI adapter はこの値を使い、raw environment value を再解釈しない。
- OpenAI の history window は `ProviderContext.scheduledTimeSeconds` を UTC anchor とする。`endTime = floor(scheduledTimeSeconds / 86400) * 86400`、`startTime = endTime - openaiHistoryDays * 86400` とする。
- configured value が invalid（`0`、`32`、non-integer、non-numeric を含む）な場合は OpenAI adapter を実行せず、OpenAI の diagnostic status を `skipped` とする。この preflight skip は `ProviderError`、failure health、timestamp を生成しない。
- invalid OpenAI configuration でも他 Provider の adapter は実行する。他に1つでも attempted Provider があれば、その Provider の health/data を通常どおり push し、OpenAI の health は含めない。全 Provider が skipped の場合は no-push とする。

### 9.2 移行方針

| Provider     | 移行内容                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI       | 現行 metric と `OPENAI_API_HISTORY_DAYS` の default `1`、valid range `1..31`、invalid value の fetch skip、scheduled-time anchor を維持し、破壊的変更なし |
| Codex        | 現行 `/wham/usage` と session/weekly metric を維持。共通 `QuotaWindow[]` への最小変換のみ追加し、未知 limit の一般化は行わない               |
| OpenCodeGo   | Primary を API key 経由 `/zen/go/v1/usage` へ。Cookie/RPC は Zen balance enrichment。cookie-only 構成は breaking change として API key へ移行する |
| Ollama Cloud | Primary を API key 経由 `/api/usage` へ。Cookie/HTML は runtime の enrichment/fallback。cookie-only 構成は breaking change として API key へ移行する。JSON の monthly activity に quota ratio を推測しない |
| CommandCode  | 新規追加                                                                                                                                     |

`OPENCODEGO_API_KEY`、`OLLAMA_API_KEY`、`COMMAND_CODE_API_KEY` が primary credential の正式名である。既存の `OPENCODEGO_SESSION_COOKIE` と `OLLAMA_SESSION_COOKIE` は fallback/enrichment 専用であり、primary の代替 credential として扱わない。

この変更は、OpenCode Go と Ollama Cloud の cookie-only deployment に対する breaking change である。新規設定および既存環境の移行では、次の手順を適用する。

- `OPENCODEGO_API_KEY` を設定し、OpenCode Go quota の primary request を API key で認証する
- `OLLAMA_API_KEY` を設定し、Ollama Cloud usage の primary request を API key で認証する
- 既存の `OPENCODEGO_SESSION_COOKIE` は、API key primary が成功した後の Zen balance enrichment にだけ使用する。`OPENCODEGO_WORKSPACE_ID` は cookie/RPC enrichment の workspace override として必要な場合だけ設定する
- 既存の `OLLAMA_SESSION_COOKIE` は、API key primary の optional HTML enrichment または primary request failure 後の fallback にだけ使用する
- cookie-only deployment から移行する際は、API key を Wrangler secret として登録してから scheduled run を確認し、cookie は enrichment/fallback が不要になるまで保持できる
- API key がなく cookie だけが設定されている場合、両 provider は `skipped` とし、OpenCode Go adapter と Ollama adapter を呼び出さない。別の provider が attempted ならその health/data push は継続し、全 provider が skipped の場合だけ no-push とする
- API key と cookie の両方が設定されている場合、primary adapter は API key で実行し、cookie は対応する enrichment/fallback 経路に限って使用する。cookie を API key の代替として使用しない

### 9.3 Existing metric compatibility

| Provider / metric                                                                                                  | 方針                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `openai_api_*`                                                                                                     | unchanged。既存 name/label を維持                                                                                                          |
| `codex_usage_ratio{period}`                                                                                        | unchanged。`session` / `weekly` のみ維持                                                                                                   |
| `codex_reset_timestamp_seconds{period}`                                                                            | unchanged                                                                                                                                  |
| `codex_credits_remaining`、`codex_reset_credits`、`codex_reset_credits_available_count`、`codex_plan_info{plan}`   | unchanged。値が取得できない場合だけ data point を omit                                                                                     |
| `opencodego_usage_ratio{period}`                                                                                   | unchanged。`rolling` / `weekly` / `monthly` の label value を維持                                                                          |
| `opencodego_reset_timestamp_seconds{period}`                                                                       | unchanged                                                                                                                                  |
| `opencodego_reset_seconds_remaining{period}`                                                                       | retained compatibility metric。reset timestamp から `max(timestamp - now, 0)` を算出し、dashboard migration が完了するまで emit            |
| `opencodego_zen_balance_usd`                                                                                       | unchanged。取得不能時は omit                                                                                                               |
| `ollama_cloud_usage_ratio{period}`、`ollama_cloud_reset_timestamp_seconds{period}`、`ollama_cloud_plan_info{plan}` | unchanged。存在しない window は emit しない                                                                                                |
| `ollama_cloud_model_requests{period,model}`                                                                        | `limits.session.models[]` は `session`、`limits.weekly.models[]` は `weekly`。`activity.models[]` は使用せず、`monthly` label を生成しない |
| `workers/src/ollama-cloud/prometheus.ts` の `ollama_cloud_reset_*`                                                 | provider-metrics Worker の変更対象外であり、既存 dashboard/alert contract を維持                                                           |
| `commandcode_*`                                                                                                    | 新規 metric。既存 compatibility はなし                                                                                                     |

metric name または既存 label value の削除・rename は本改修では行わない。削除が必要になった場合は、replacement query と dashboard/alert migration を別設計で定義する。

## 10. テスト戦略

### 10.1 Unit test

各 Provider adapter について以下をテストする。

- valid response
- exact endpoint、method、required headers、request body/query が fixture で固定されていること
- optional field 欠落
- zero usage
- quota near limit
- quota exhausted
- reset timestamp
- multiple windows
- HTTP 400 / 401 / 403 / 429 / 500
- timeout
- invalid JSON
- unexpected HTML
- schema mismatch
- negative percentage
- percentage > 100
- invalid timestamp
- missing required field
- unknown period/key が arbitrary metric label にならず omit されること
- credentials、Authorization、cookie、response body が error text/log に含まれないこと
- Codex と Ollama の non-2xx fixture に sentinel response body と credential を含め、`ProviderError`、Worker log、diagnostic report に `statusCode`、`provider`、`sourceId`、`kind` 以外の値が出力されないこと
- Worker log と diagnostic report に raw exception message が転送されず、response body、credential、Authorization header も出力されないこと
- OpenAI の line item cost と model usage、OpenCode Go の Zen balance、Ollama の model request/activity cost が provider-specific field から exact metric name/label へ生成されること
- `opencodego_reset_seconds_remaining` が注入された `nowSeconds` に対する残秒数であり、wall clock に依存しないこと
- network / timeout / HTTP status / schema / parse の各 failure が固定 source ID と組み合わされ、raw error message を公開しないこと
- adapter の unexpected rejection が `internal`、registry 固定の primary source、`statusCode` なしの failure になり、既知の failure categoryへ誤分類されないこと

Provider-specific fixture は次を必須とする。

- OpenCode Go: `usage.rolling/weekly/monthly` の percent scale、ISO `resetsAt`、status non-ok、window 欠落、invalid percent/timestamp
- Ollama legacy: `limits.session/weekly` の 0..1 ratio、session/weekly `models[]` の `period` mapping、同一 window 内の重複 model の合算、同一 model の別 window series、activity models の未使用、activity cost/period
- Ollama monthly: `limits` 欠落または session/weekly 欠落、activity-only success、activity models を model metric にしないこと、`last_4_weeks` を `monthly` にしないこと、plan/reset の HTML enrichment、API と HTML の同時存在
- Ollama API status: HTTP 400 は `upstream_4xx`、`sourceId = "ollama-api-usage"`、`statusCode = 400` とし、valid HTML があれば fallback success、HTML failure 時は元の error を保持すること
- Ollama HTML ownership: API success + HTML の有効 contribution なしは primary success のまま enrichment field を omit、API failure + HTML の valid な quota/plan/reset ありは fallback success、両方なしは元の API failure
- Ollama model label: valid identifier、empty model、whitespace-only model、先頭/末尾 whitespace、128 characters 超過、許可文字外、invalid model entry だけの omit、同一 window 内の同じ valid model の aggregation、rejected string が `model` label に流入しないこと
- Command Code request: `whoami?limits=1`、`orgId` の credits/subscriptions への伝播、subscription `currentPeriodStart` の summary `since` への伝播、body なし、required headers、query encoding
- Command Code response: `whoami`、`billing/credits`、`billing/subscriptions`、`usage/summary` の exact shape、`windowLimits` の top-level 所在、numeric seconds `resetAt` → epoch seconds、numeric milliseconds `resetAt` → epoch seconds、invalid / negative / non-finite `resetAt` → reset timestamp だけ omit して quota success、ISO string `resetAt` を parse せず current contract 外として受け付けないこと
- Command Code subscription: valid ISO `currentPeriodStart` の `since` 伝播、invalid `currentPeriodStart` で `since` なしの summary 実行、valid ISO `currentPeriodEnd` の epoch seconds 化、invalid `currentPeriodEnd` で billing-period-end だけ omit
- CommandCode quota normalization: `fiveHour.used/cap` が `session` の `used/limit`、`weekly.used/cap` が `weekly` の `used/limit` へ対応すること
- CommandCode quota boundary: `used=0, cap=14` が `usageRatio=0`、`exceeded=false` になること
- CommandCode quota boundary: `used=13.9, cap=14` が `usageRatio=13.9/14`、`exceeded=false` になること
- CommandCode quota boundary: `used=14, cap=14` が `usageRatio=1`、`exceeded=true` になること
- CommandCode quota boundary: `used=16, cap=14` が raw `used=16` / `limit=14` を保持し、`usageRatio=1`、`exceeded=true` になること
- CommandCode quota boundary: `limited=false` が quota window を生成せず、`limited=true` の `cap=0` が `schema` failure になること
- Command Code partial failure: credits success + subscription failure、credits success + summary failure、required endpoint failure
- CommandCode `windowLimits`: absent / invalid `limited` の optional omission、`limited=false` の unlimited semantics、`limited=true` の fiveHour/weekly 欠落・型不正・`cap=0` の fatal schema failure

OpenAI の既存 configuration compatibility は次を必須とする。

- `OPENAI_API_HISTORY_DAYS` 未指定は normalized `historyDays=1`
- configured `"1"` と `"31"` は valid、`"0"`、`"32"`、non-integer、non-numeric は invalid
- valid value は `ProviderContext.openaiHistoryDays` として OpenAI adapter に渡し、`ProviderContext.scheduledTimeSeconds` を UTC history window の anchor にする
- invalid value は OpenAI adapter を呼ばず、OpenAI status を `skipped`、OpenAI health を未生成、他 Provider を継続、all-skipped 時を no-push とする

#### Global recovery / status precedence

- primary request failure を検知しただけでは `AdapterOutcome.failed` を確定せず、Provider-specific fallback / status rule を適用した後に final outcome を決めること
- Ollama の API HTTP 500 + HTML fallback success → `AdapterOutcome.success`、`provider_metrics_scrape_success{provider="ollama_cloud"}=1`、scrape timestamp 更新、`ollama-settings-html=fallback` だけが `sources` に存在すること
- Ollama の API network failure + cookie / fallback unavailable → `AdapterOutcome.failed`、`provider_metrics_scrape_success{provider="ollama_cloud"}=0`、scrape timestamp 未更新、final `ProviderError.sourceId = "ollama-api-usage"`、original `kind = "network"` となること
- Ollama の API failure + HTML fallback failure → `AdapterOutcome.failed`、`scrape_success=0`、scrape timestamp 未更新、final `ProviderError` が original API failure の `sourceId` / `kind` / `statusCode` を保持し、HTML error で置換されないこと
- Codex の primary `/wham/usage` HTTP 403 + Browser Rendering success → `AdapterOutcome.success`、`scrape_success=1`、scrape timestamp 更新、`codex-browser-rendering=fallback` となること
- Codex の primary HTTP 403 + Browser Rendering failure → `AdapterOutcome.failed`、`scrape_success=0`、scrape timestamp 未更新、final `ProviderError.sourceId = "codex-browser-rendering"` となること
- Codex の primary HTTP 403 + `browserBinding` unavailable → fallback を実行せず、`AdapterOutcome.failed`、`ProviderError.kind = "forbidden"`、`ProviderError.sourceId = "codex-wham-usage"`、`statusCode = 403` となること
- Codex の 403 以外の primary failure では Browser Rendering fallback を実行しないこと
- OpenCode Go の 403 + safe `EntitlementError` → `AdapterOutcome.empty`、`scrape_success=1`、scrape timestamp 更新となること
- OpenCode Go の 403 + other response → `AdapterOutcome.failed`、`ProviderError.kind = "forbidden"`、`scrape_success=0`、scrape timestamp 未更新となること

#### Error ownership / partial success

次のケースでは、schema / parse failure の ownership と `AdapterOutcome`、health semantics の対応を固定する。

- required primary schema mismatch → `AdapterOutcome.failed`、`ProviderError.kind = schema`、`scrape_success=0`、Provider data metric なし
- CommandCode の invalid optional `resetAt` → quota success、reset timestamp metric だけ omit
- CommandCode の subscription schema failure → credits/quota success、subscription metric だけ omit
- CommandCode の summary schema failure → credits/quota success、usage summary metric だけ omit
- Ollama の invalid model entry と valid limits → invalid entry だけ omit、Provider success
- Ollama の invalid `activity.cost` と valid limits → activity cost だけ omit、quota success
- optional enrichment の transport failure → primary `ProviderResult` success、`scrape_success=1`
- fatal required-contract の schema / parse failure → partial success へ downgrade せず、Provider failed として扱う

### 10.2 Orchestrator test

- 複数 Provider を同時実行し、1 Provider 失敗時に他 Provider の metric が送信されることを確認
- 全 Provider が failed でも health-only push が行われることを確認
- 唯一の attempted Provider が `empty` の場合も health-only push が行われ、`scrape_success=1`、timestamp、duration が送信されることを確認する
- 全 Provider が skipped の場合は push されないことを確認
- `OPENCODEGO_API_KEY` と `OLLAMA_API_KEY` がなく対応する cookie だけが設定されている場合、両 provider が `skipped` となり、両 adapter が呼び出されないことを確認する。API key と cookie の両方がある場合は API key primary と cookie enrichment/fallback の経路を維持する。
- `OPENAI_API_HISTORY_DAYS` の invalid preflight で OpenAI だけが skipped となり、他 Provider の実行・health・push が継続することを確認する。OpenAI だけが invalid preflight の場合は no-push とする。
- OpenAI の valid history window が `scheduledTimeSeconds` を anchor とし、normalized `historyDays` が adapter request の start/end に反映されることを確認する。
- success / failed / empty / skipped の health semantics が正しく生成されることを確認
- `scrape_success=0` の場合に timestamp を更新せず、backend の last-success query semantics を維持することを確認
- retry と optional enrichment を含めた duration が計測されることを確認
- 完了時間の異なる2つの adapter を使い、速い adapter の duration/timestamp が遅い adapter の settle 待ちで変化しないことを確認
- optional enrichment failure で primary quota result が残り、`scrape_success=1` になることを確認
- fatal required-contract schema failure で `scrape_success=0` になり、Provider data metric が送信されないことを確認
- source provenance が primary / fallback / enrichment を実際に寄与した経路として返すことを確認
- Ollama の API success + HTML plan/reset contribution で `ollama-api-usage=primary`、`ollama-settings-html=enrichment` になることを確認
- Ollama の API failure + HTML replacement success で `ollama-settings-html=fallback` だけが sources に入り、API failure source は primary にならないことを確認
- Ollama が HTML を呼ばなかった場合、または HTML が result に有効な field を寄与しなかった場合に `ollama-settings-html` が sources に入らないことを確認
- OpenCode Go usage + Zen balance success で `opencodego-usage-api=primary`、`opencodego-zen-rpc=enrichment` になることを確認
- CommandCode の `whoami` を `sources` に含めず、credits/subscription/summary の valid output ごとに固定 source ID と role が返り、endpoint failure の `ProviderError.sourceId` も固定されることを確認
- existing metric compatibility table の name/label snapshot が維持されることを確認

### 10.3 CI gates

- `make typecheck`
- `make test`
- `make fmt`
- `make validate`

## 11. Acceptance Criteria

本改修は以下をすべて満たした時点で完了とする。

- OpenAI API costs / usage の既存 metric が維持されている
- `OPENAI_API_HISTORY_DAYS` が default `1`、valid range `1..31`、invalid configured value の fetch skip、`scheduledTimeSeconds` anchor を維持し、invalid preflight は `skipped` として health failure / ProviderError を生成しない
- OpenCode Go quota を API key のみで取得できる。対応する API key がなく cookie だけが設定されている場合は `skipped` とし、OpenCode Go adapter を呼び出さない
- OpenCode Go quota 取得に browser cookie を必要としない
- OpenCode Go rolling / weekly / monthly を扱える
- OpenCode Go の `403 + EntitlementError` は `AdapterOutcome.empty`、`scrape_success=1`、scrape timestamp 更新となり、その他の 403 は `forbidden` failure、`scrape_success=0`、`ProviderError.sourceId = "opencodego-usage-api"` となる
- Ollama Cloud usage を API key のみで取得できる。対応する API key がなく cookie だけが設定されている場合は `skipped` とし、Ollama adapter を呼び出さない
- Ollama legacy session / weekly を扱える
- Ollama 新 plan monthly usage は、JSON の activity cost と optional HTML plan/reset enrichment として扱える。JSON に存在しない monthly quota ratio は合成しない
- Ollama API success 後の HTML enrichment は valid な field がなくても primary success を維持し、API failure 後の HTML fallback は valid な quota window、plan、または reset timestamp が1つ以上ある場合だけ success とする
- Ollama API failure が HTML fallback により回復した場合は `AdapterOutcome.success` / `scrape_success=1` / scrape timestamp 更新とし、`ProviderResult.sources` は `ollama-settings-html=fallback` だけを含める。cookie / fallback unavailable または fallback failure の場合は `AdapterOutcome.failed` / `scrape_success=0` / scrape timestamp 未更新とし、final `ProviderError` は `ollama-api-usage` の original `kind` / `statusCode` を保持する
- Ollama の存在しない window を `0` として出力しない
- Ollama `ollama_cloud_model_requests{period,model}` が session/weekly limits だけから生成され、activity models や `last_4_weeks` が public label に流入しない
- Ollama `ollama_cloud_model_requests` の `model` label が §6.2 の 1..128 ASCII characters / `^[A-Za-z0-9._:/-]+$` / whitespace policy を通過した identifier だけを verbatim に使用し、invalid / oversized / unsupported model name を omit する
- CommandCode の 5h / weekly quota を取得できる
- CommandCode の `fiveHour` / `weekly` の wire `used` / `cap` が、それぞれ `QuotaWindow.used` / `limit` / `usageRatio` / `exceeded` へ本書の規則どおり一意に正規化される
- CommandCode の `usageRatio` が `rawRatio=used/cap` の 0..1 clamp と `used>=cap` の `exceeded=true` semantics を維持する
- CommandCode の `windowLimits` は absent または invalid `limited` を optional quota omission とし、`limited=false` は明示的 unlimited semantics として quota window を emit せず、`limited=true` は fiveHour/weekly を required として欠落・型不正・`cap==0` を fatal `schema` failure とする
- CommandCode の `resetAt` は numeric epoch seconds または numeric epoch milliseconds だけを受け付け、ISO string を parse せず、invalid optional value は reset timestamp のみ omit する
- CommandCode subscription の ISO `currentPeriodStart` / `currentPeriodEnd` はそれぞれ `since` / billing-period-end の field-level omission semantics を維持する
- CommandCode credits を取得できる
- CommandCode の exact endpoint、auth、response shape、failure ownership が本書どおり固定されている
- CommandCode の `org.id`、`orgId`、`currentPeriodStart` の request dependency と各 endpoint の query/body/header contract が本書どおり固定されている
- Codex 現行 quota 取得がデグレしていない
- Codex adapter が現行 session / weekly contract を維持している
- Codex の Browser Rendering fallback は primary `/wham/usage` の HTTP 403 かつ `browserBinding` が利用可能な場合だけ実行し、success 時は `scrape_success=1` / scrape timestamp 更新と `codex-browser-rendering=fallback`、fallback failure 時は `scrape_success=0` / scrape timestamp 未更新と `ProviderError.sourceId = "codex-browser-rendering"`、binding unavailable 時は `ProviderError.sourceId = "codex-wham-usage"` となる
- required primary request failure は Provider-specific recovery / status rule の適用後に final `AdapterOutcome` を決定し、recovery success は `success`、contract-defined status exception は `empty`、回復不能時だけ `failed` とする
- 1 Provider の failure で他 Provider の metric が失われない
- 全 Provider failed でも health-only payload が push され、全 Provider skipped の場合だけ push が省略される
- last-success timestamp が Worker-side persistent state なしで Grafana query から確認できる
- `ProviderId`、canonical period、unknown-period policy が固定されている
- `ProviderResult.sources` が mixed-source result の実際の provenance を表現できる
- Ollama の JSON API success + HTML 補完では `ollama-settings-html` が `enrichment`、API failure + HTML 代替では `fallback` となり、同じ source ID を同一 result に複数 role で重複追加しない
- OpenCode Go の Zen balance source が `fallback` ではなく `enrichment` として記録される
- CommandCode の `ProviderResult.sources` が `commandcode-billing-credits`、`commandcode-billing-subscriptions`、`commandcode-usage-summary` の実際の寄与だけを表し、`commandcode-whoami` を含めない
- `opencodego_reset_seconds_remaining` を含む existing metric compatibility が維持されている
- undocumented API の required primary contract に対する fatal schema mismatch を安全に検知し、optional field / enrichment failure は設計された scope だけを omit できる
- schema / parse failure の error ownership が Provider-specific contract と global policy で一致している
- adapter の unexpected rejection が `ProviderError.kind = "internal"`、registry 固定の primary source、`statusCode` なしで isolation され、他 Provider が継続する
- required primary contract の fatal schema / parse failure だけが `AdapterOutcome.failed` と `ProviderError.kind = schema | parse` を生成し、optional field / optional enrichment failure は primary `ProviderResult` と `scrape_success=1` を維持する
- Credential が log / metric へ露出しない
- Codex / Ollama の HTTP failure、Worker log、diagnostic report が response body、credential、Authorization header、raw exception message を露出せず、`statusCode`、`provider`、`sourceId`、`kind` の固定 allowlist だけを扱う
- Provider ごとの最終成功時刻を監視可能である
- Provider adapter ごとの unit test が存在する
- ドキュメントに各取得経路の support level が記載されている
- architecture-relevant placeholder、未確定の endpoint/schema、実装者裁量に依存する mapping が残っていない
