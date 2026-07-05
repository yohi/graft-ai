<!-- markdownlint-disable MD013 -->


# Ollama Cloud Rate Limit Reset Metrics

## 1. Purpose

`graft-ai` の README および SPEC には「Ollama Cloud のメトリクスを Grafana
Prometheus に送る」という記述がありますが、現状のコードベースには未実装です。
本設計は、そのうちの **レート制限リセット時間** に焦点を当て、Grafana
Cloud で可視化するためのサブシステムを定義します。

## 2. Background and Constraints

### 2.1 公式 API の制約

Ollama Cloud の「残り quota / リセット時刻 / 使用済み量」を返す **公式 API は
2026-07-05 時点で存在しません**。

- `POST /api/me` は基本情報（`id`, `email`, `name`, `bio`, `avatarurl`）のみを返します。
- 料金ページには「session は 5 時間ごと、weekly は 7 日ごとにリセット」と記載されていますが、機械可読なフィールドは提供されていません。
- Cloudflare AI Gateway には公式に Ollama プロバイダーは存在せず、AI Gateway のレート制限は Cloudflare 側の機能です。

refs:

- `https://docs.ollama.com/cloud`
- `https://ollama.com/pricing`
- `https://docs.ollama.com/api/authentication`
- `https://github.com/ollama/ollama/blob/main/server/routes.go#L1881-L1887`
- `https://github.com/ollama/ollama/blob/main/api/client.go#L501-L507`
- `https://github.com/ollama/ollama/blob/main/api/types.go#L965-L970`

### 2.2 設計方針

公式 API で取得できない情報（実際の used / limit 値）を無理に取得しようとする
ダッシュボードスクレイピングは、もろく規約違反の可能性があるため採用しません。
代わりに、**公式に文書化されたリセット間隔**（5h / 7d）と、ユーザーが指定する
**基準時刻（anchor）** から、次回リセット時刻・残り時間・進捗率を派生します。

## 3. Scope

本設計の範囲は以下に限定します。

- Ollama Cloud の `session` / `weekly` リセット時刻の派生メトリクス
- Grafana Cloud Prometheus への remote write
- 専用 Grafana ダッシュボードの提供

範囲外：

- 実際の使用済みリクエスト数・トークン数の自動取得
- 使用率（used / limit）の自動計算
- Ollama Cloud ダッシュボードのスクレイピング

## 4. Architecture

### 4.1 Components

```text
[Cron Trigger: */5 * * * *]
  ↓
[workers/src/ollama-cloud.ts]
  ├─ loads configuration (anchor, intervals, plan)
  ├─ computes next session / weekly reset timestamps
  ├─ computes remaining seconds and progress ratio
  ├─ builds Prometheus remote write payload
  └─ POST to Grafana Cloud Prometheus
       ↓
[Grafana Cloud Prometheus]
       ↓
[Grafana Dashboard: graft-ai-ollama-cloud.json]
```

| Component | File | Responsibility |
| --- | --- | --- |
| Scheduled Worker | `workers/src/ollama-cloud.ts` | Cron entry point. Validates config, computes metrics, pushes to Prometheus. |
| Reset calculator | `workers/src/ollama-cloud/calc.ts` | Computes next reset, remaining seconds, and progress ratio from anchor and interval. |
| Prometheus client | `workers/src/ollama-cloud/prometheus.ts` | Builds remote write payload and sends with retry. |
| Worker config | `workers/wrangler.ollama.jsonc` | Cron trigger, environment bindings. |
| Dashboard | `grafana/dashboards/graft-ai-ollama-cloud.json` | Visualizes reset metrics and alerts. |

### 4.2 Rationale

- AI Gateway ログパイプライン（`index.ts`, `proxy.ts`, `tail-worker.ts`）とは分離し、単一責任の Worker とする。
- 将来 `/api/me` などが quota 情報を返すようになっても、この Worker に追加実装するだけで対応可能。
- README/SPEC にある「Prometheus 向けスクレイパー」という位置づけに合致する。

## 5. Metrics

### 5.1 Metric Definitions

| Metric | Type | Labels | Description |
| --- | --- | --- | --- |
| `ollama_cloud_reset_seconds_remaining` | Gauge | `period` (`session` \| `weekly`) | Seconds until the next reset. |
| `ollama_cloud_reset_timestamp_seconds` | Gauge | `period` (`session` \| `weekly`) | Unix timestamp of the next reset. |
| `ollama_cloud_reset_progress_ratio` | Gauge | `period` (`session` \| `weekly`) | Elapsed proportion of the current reset interval, 0.0 to 1.0. |
| `ollama_cloud_plan_info` | Gauge | `plan`, `session_interval`, `weekly_interval` | Static info metric describing the configured plan. |

### 5.2 Calculation

```typescript
const elapsed = nowSeconds - anchorSeconds;
const progress = (elapsed % intervalSeconds) / intervalSeconds;
const remaining = intervalSeconds - (elapsed % intervalSeconds);
const nextResetTimestamp = nowSeconds + remaining;
```

### 5.3 Dashboard Panels

- **Stat panel**: `ollama_cloud_reset_seconds_remaining{period="session"}` → "Next session reset in 2h 15m"
- **Gauge panel**: `ollama_cloud_reset_progress_ratio{period="weekly"}` → 0-100% progress ring
- **Alert**: `ollama_cloud_reset_seconds_remaining < 3600` → alert 1 hour before session reset
- **Alert**: `ollama_cloud_reset_seconds_remaining < 86400` → alert 24 hours before weekly reset

## 6. Configuration

### 6.1 Environment Variables

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `OLLAMA_CLOUD_PLAN` | No | - | Plan name for `ollama_cloud_plan_info`. |
| `OLLAMA_CLOUD_SESSION_INTERVAL_SECONDS` | Yes | `18000` | Session reset interval in seconds (5h). |
| `OLLAMA_CLOUD_WEEKLY_INTERVAL_SECONDS` | Yes | `604800` | Weekly reset interval in seconds (7d). |
| `OLLAMA_CLOUD_RESET_ANCHOR_ISO` | Yes | - | Last known reset time in ISO 8601 format. |
| `GRAFANA_CLOUD_PROMETHEUS_URL` | Yes | - | Grafana Cloud Prometheus remote write URL. |
| `GRAFANA_CLOUD_PROMETHEUS_USERNAME` | Yes | - | Prometheus tenant ID / username. |
| `GRAFANA_CLOUD_ACCESS_POLICY_TOKEN` | Yes (secret) | - | Access Policy Token with `metrics:write` scope. |

### 6.2 Cron Schedule

`wrangler.ollama.jsonc`:

```jsonc
"triggers": {
  "crons": ["*/5 * * * *"]
}
```

5 分ごとに更新。リセット時刻の精度は 5 分以内で十分。

### 6.3 Security

- `GRAFANA_CLOUD_ACCESS_POLICY_TOKEN` は Wrangler secret として管理する。
- `.dev.vars` はローカル開発のみ。
- Terraform や `*.tfvars` に秘密情報を含めない（プロジェクト全体の方針）。

## 7. Error Handling

| Failure | Behavior |
| --- | --- |
| `OLLAMA_CLOUD_RESET_ANCHOR_ISO` missing | Log error, skip metric emission, exit Cron normally. |
| Anchor parse error | Log error, skip metric emission, exit Cron normally. |
| Prometheus connection / 429 | Retry up to 3 times with exponential backoff. |
| Prometheus 4xx (non-429) | Log error, no retry. |
| Prometheus 5xx | Retry up to 3 times; log on final failure. |

## 8. Testing

| Target | File | Coverage |
| --- | --- | --- |
| Reset calculator | `workers/tests/ollama-cloud/calc.test.ts` | Next reset, remaining seconds, progress ratio, boundary values. |
| Prometheus client | `workers/tests/ollama-cloud/prometheus.test.ts` | Payload construction, Basic Auth, retry on 429/5xx. |
| Scheduled handler | `workers/tests/ollama-cloud/scheduled.test.ts` | End-to-end Cron trigger test, missing config behavior. |
| Type safety | `make typecheck` | Includes all new modules. |

## 9. Deployment

### 9.1 New Files

- `workers/src/ollama-cloud.ts`
- `workers/src/ollama-cloud/calc.ts`
- `workers/src/ollama-cloud/prometheus.ts`
- `workers/wrangler.ollama.jsonc`
- `workers/tests/ollama-cloud/*.test.ts`
- `grafana/dashboards/graft-ai-ollama-cloud.json`

### 9.2 Updated Files

- `Makefile`: add `deploy-ollama` target.
- `scripts/setup.sh`: optionally register Ollama Cloud Wrangler secrets.
- `.gitignore`: no changes required.

### 9.3 Deployment Command

```bash
make deploy-ollama
```

This deploys only the Ollama Cloud Worker defined in `wrangler.ollama.jsonc`.

## 10. Dashboard

Create a new dashboard `grafana/dashboards/graft-ai-ollama-cloud.json` instead of
adding panels to the existing AI Gateway dashboard. The two subsystems have
different data sources and operational concerns, so separation improves clarity.

## 11. Open Questions

1. Should the default Cron interval remain 5 minutes, or should it be configurable
   per deployment?
2. Should the Worker also attempt to call `POST /api/me` to validate that the
   configured API key is valid, even though quota data is not returned?
3. Should the Makefile integrate `deploy-ollama` into the main `deploy` target,
   or keep it separate?
