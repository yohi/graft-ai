# Provider Metrics Worker — 設計書

**作成日**: 2026-08-09  
**対象**: `graft-ai` — Cloudflare Workers スケジューラ型 Worker の新規追加  
**ステータス**: 承認済み

---

## 概要

Codex・OpenAI API・OpenCodeGo の使用量メトリクスを Grafana Cloud Prometheus に送信する、新しいスケジューラ型 Cloudflare Worker（`graft-ai-provider-metrics`）を追加する。

`oss/CodexBar` の実装を参照し、各プロバイダーが利用する API エンドポイント・データ構造・認証方式を確認したうえで設計する。既実装の Ollama Cloud Worker（`graft-ai-ollama-cloud`）とパターンを揃え、OTLP/v1 over HTTPS で Grafana Cloud Prometheus に push する。

---

## コンテキスト

### 既実装

| 機能 | Worker 名 | 状態 |
|---|---|---|
| Cloudflare AI Gateway ログ → Loki | `graft-ai-aig-logpush` | ✅ 完全実装済み |
| Ollama Cloud リセット時刻 → Prometheus | `graft-ai-ollama-cloud` | ✅ 完全実装済み |
| Codex 使用量 → Prometheus | — | ❌ 未実装 |
| OpenAI API 使用量 → Prometheus | — | ❌ 未実装 |
| OpenCodeGo 使用量 → Prometheus | — | ❌ 未実装 |

### CodexBar 参照

`oss/CodexBar/Sources/CodexBarCore/Providers/` 以下の実装を参照して API 詳細を確定した。

---

## アーキテクチャ

```text
Cloudflare Workers scheduled (*/5 * * * *)
└── graft-ai-provider-metrics
    ├── fetchOpenAIMetrics()      → api.openai.com              (Bearer Admin Key)
    ├── fetchCodexMetrics()       → chatgpt.com/backend-api     (Bearer Access Token)
    └── fetchOpenCodeGoMetrics()  → opencode.ai                 (Session Cookie)
    └── pushMetrics()             → Grafana Cloud Prometheus (OTLPv1/metrics)
```

各フェッチャーは独立して実行し、1 つ失敗しても残りのメトリクスは送信を継続する（best-effort 並列実行）。

---

## 各プロバイダーの仕様

### OpenAI API

**参照**: `Providers/OpenAI/OpenAIAPIUsageFetcher.swift`

| 項目 | 詳細 |
|---|---|
| エンドポイント 1 | `GET https://api.openai.com/v1/organization/costs` |
| エンドポイント 2 | `GET https://api.openai.com/v1/organization/usage/completions` |
| 認証 | `Authorization: Bearer <OPENAI_ADMIN_API_KEY>` |
| クエリパラメータ | `start_time`, `end_time`, `bucket_width=1d`, `limit`, `group_by=line_item`(costs) / `group_by=model`(completions) |
| ページネーション | `has_more` + `page` カーソル（最大 31 日ごとにチャンク分割） |

**取得データ**:
- 日次コスト (USD)、モデル別 / line_item 別内訳
- 入力・出力・キャッシュ入力トークン数
- リクエスト数

**スコープ**: 直近 1 日分（前日 UTC 00:00〜当日 UTC 00:00）のみ取得。ゲージとして扱うため過去履歴の保存は Worker 内では行わない。

---

### Codex

**参照**: `Providers/Codex/CodexOAuth/CodexOAuthUsageFetcher.swift`

| 項目 | 詳細 |
|---|---|
| エンドポイント（使用量） | `GET https://chatgpt.com/backend-api/wham/usage` |
| エンドポイント（リセットクレジット） | `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits` |
| 認証 | `Authorization: Bearer <CODEX_ACCESS_TOKEN>` |
| 追加ヘッダー | `ChatGPT-Account-Id: <ACCOUNT_ID>`（オプション）|

> **注意**: CodexStatusProbe（CLI/PTY 経由）は Cloudflare Worker から実行不可能。OAuth アクセストークンを Secrets に設定して HTTP API を直接呼ぶ。

**取得データ** (`CodexUsageResponse`):
- `plan_type`: プラン名 (guest/free/plus/pro 等)
- `rate_limit.primary_percent_remaining`: セッション(5h)残%
- `rate_limit.secondary_percent_remaining`: 週次残%
- `rate_limit.primary_resets_at`: セッションリセット時刻 (ISO 8601)
- `rate_limit.secondary_resets_at`: 週次リセット時刻 (ISO 8601)
- `credits.total_granted` / `credits.total_used`: クレジット残高計算

---

### OpenCodeGo

**参照**: `Providers/OpenCodeGo/OpenCodeGoUsageFetcher.swift`, `OpenCodeGoUsageSnapshot.swift`

| 項目 | 詳細 |
|---|---|
| ステップ 1: Workspace ID 取得 | `GET https://opencode.ai/_server?id=def399...` |
| ステップ 2: 使用量ページ取得 | `GET https://opencode.ai/workspace/{workspaceID}/go` |
| Zen 残高（任意） | `GET https://opencode.ai/_server?id=c83b78...&args=["{workspaceID}"]` |
| 認証 | `Cookie: <OPENCODEGO_SESSION_COOKIE>` |
| 追加ヘッダー | `X-Server-Id`, `Referer`, `Origin`, `User-Agent` (Chrome UA) |

**取得データ**:
- `rollingUsagePercent`: ローリング(5h)使用率 (0–100)
- `weeklyUsagePercent`: 週次使用率 (0–100)
- `monthlyUsagePercent`: 月次使用率 (0–100)
- `rollingResetInSec` / `weeklyResetInSec` / `monthlyResetInSec`: 各リセット残秒数
- `zenBalanceUSD`: Zen クレジット残高 (USD)

**データ抽出**: HTML 内に埋め込まれた JSON を複数のキー候補でフォールバック検索（`usagePercent`, `usedPercent`, `usage_percent` 等。CodexBar 参照）。

**Cookie 期限**: Session Cookie は定期更新が必要。期限切れは 401/403 で検出しエラーログに記録する。

---

## Prometheus メトリクス定義

全メトリクスは OTLPv1 Gauge。`service.name = "graft-ai-provider-metrics"` として送信。

### OpenAI API

| メトリクス名 | ラベル | 説明 |
|---|---|---|
| `openai_api_cost_usd` | `line_item` | 前日コスト (USD) — `costs` エンドポイント由来、line_item 別 |
| `openai_api_input_tokens` | `model` | 前日入力トークン数 — `completions` エンドポイント由来 |
| `openai_api_output_tokens` | `model` | 前日出力トークン数 |
| `openai_api_cached_tokens` | `model` | 前日キャッシュ入力トークン数 |
| `openai_api_requests` | `model` | 前日リクエスト数 |

### Codex

| メトリクス名 | ラベル | 説明 |
|---|---|---|
| `codex_usage_ratio` | `period="session"\|"weekly"` | 使用率 (0.0–1.0) |
| `codex_reset_timestamp_seconds` | `period` | 次リセット Unix 時刻 |
| `codex_credits_remaining` | — | クレジット残高 |
| `codex_plan_info` | `plan` | プラン情報ゲージ (常に 1) |

### OpenCodeGo

| メトリクス名 | ラベル | 説明 |
|---|---|---|
| `opencodego_usage_ratio` | `period="rolling"\|"weekly"\|"monthly"` | 使用率 (0.0–1.0) |
| `opencodego_reset_seconds_remaining` | `period` | リセットまでの残秒数 |
| `opencodego_zen_balance_usd` | — | Zen クレジット残高 (USD) |

---

## モジュール構成

```text
workers/src/
├── provider-metrics.ts              # Worker entrypoint + scheduled handler
└── provider-metrics/
    ├── types.ts                     # ProvidersMetricsEnv、各フェッチャーの戻り値型
    ├── openai-api.ts                # OpenAI API fetcher
    ├── codex.ts                     # Codex OAuth fetcher
    ├── opencodego.ts                # OpenCodeGo Cookie fetcher
    └── prometheus.ts                # OTLP payload builder + pushMetrics()

workers/wrangler.provider-metrics.jsonc  # Worker 設定（cron, vars）
```

### Wrangler 設定

```jsonc
{
  "name": "graft-ai-provider-metrics",
  "main": "src/provider-metrics.ts",
  "compatibility_date": "2026-07-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "triggers": { "crons": ["*/5 * * * *"] },
  "vars": {
    "OPENAI_API_HISTORY_DAYS": "1"
  }
}
```

### 環境変数 / Secrets

| 変数名 | 種別 | 用途 |
|---|---|---|
| `OPENAI_ADMIN_API_KEY` | Secret | OpenAI Admin API キー |
| `CODEX_ACCESS_TOKEN` | Secret | Codex OAuth アクセストークン |
| `CODEX_ACCOUNT_ID` | Secret (任意) | Codex ワークスペース AccountId |
| `OPENCODEGO_SESSION_COOKIE` | Secret | OpenCode Go セッション Cookie 文字列 |
| `OPENCODEGO_WORKSPACE_ID` | Secret (任意) | Workspace ID（省略時はスクレイピングで取得） |
| `GRAFANA_CLOUD_PROMETHEUS_URL` | Secret | Grafana Cloud Prometheus OTLPエンドポイント |
| `GRAFANA_CLOUD_PROMETHEUS_USERNAME` | Secret | Prometheus Basic Auth ユーザー名 |
| `GRAFANA_CLOUD_ACCESS_POLICY_TOKEN` | Secret | Grafana Cloud アクセストークン |
| `OPENAI_API_HISTORY_DAYS` | Var | 取得日数（デフォルト: 1） |

---

## エラー戦略

| 状況 | 挙動 |
|---|---|
| 特定プロバイダーの fetch 失敗 | `console.error()` でログ記録し、他プロバイダーのメトリクスは送信継続 |
| 401 / 403 | 即時失敗（リトライなし）、認証情報の期限切れとしてログ |
| 5xx / 429 | 既存 `http-retry.ts` の `postWithRetry` を再利用 |
| 全プロバイダー失敗 | Worker は正常終了（scheduled handler は常に完了） |
| OpenCodeGo Cookie 切れ | エラーメッセージに「Cookie expired, update OPENCODEGO_SESSION_COOKIE」を付記 |

---

## テスト戦略

既存の `workers/tests/` パターンに倣い Vitest でユニットテストを追加する。

| ファイル | 内容 |
|---|---|
| `openai-api.test.ts` | モックレスポンスに対するパース・集計ロジック |
| `codex.test.ts` | `CodexUsageResponse` デコードと Prometheus payload 生成 |
| `opencodego.test.ts` | HTML スクレイピング（フィクスチャ HTML を使用） |
| `provider-metrics.test.ts` | 統合テスト（各 fetcher をモック化した scheduled handler） |

---

## Makefile コマンド

既存の Makefile のパターン（`deploy-ollama`）に倣い以下を追加する:

```makefile
deploy-provider-metrics:
    cd workers && npx wrangler deploy --config wrangler.provider-metrics.jsonc
```

---

## 実装外のスコープ

- `graft-ai-ollama-cloud` の変更は行わない（既実装完了）
- Grafana ダッシュボード JSON の更新は別タスク
- Codex OAuth トークンの自動リフレッシュは実装しない（Worker Secrets として手動更新）
- OpenAI API の 31 日超え履歴取得は実装しない（`OPENAI_API_HISTORY_DAYS=1` がデフォルト）
