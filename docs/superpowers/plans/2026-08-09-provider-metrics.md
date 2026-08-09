# Provider Metrics Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codex・OpenAI API・OpenCodeGo の使用量メトリクスを Grafana Cloud Prometheus に push する新しいスケジューラ型 Cloudflare Worker を追加する。

**Architecture:** `workers/src/provider-metrics.ts` を新規 scheduled Worker として追加し、`workers/src/provider-metrics/` 以下にプロバイダーごとのフェッチャーと共通の Prometheus push モジュールを配置する。各フェッチャーは独立して実行し、失敗しても他のメトリクスは送信を継続する best-effort 並列実行。Prometheus 送信は既存 `ollama-cloud/prometheus.ts` と同じ OTLPv1 over HTTPS パターンを踏襲する。

**Tech Stack:** TypeScript (strict), Cloudflare Workers scheduled handler, OTLP/v1 JSON over HTTPS, Vitest

## Global Constraints

- TypeScript strict モード必須（`workers/tsconfig.json` 準拠）
- パッケージマネージャは npm（`workers/` 内）
- 新しい npm 依存関係は追加しない
- `make test` と `make typecheck` が全タスク完了後に通過すること
- コミットメッセージは日本語 Conventional Commits（`feat:`, `test:`, `docs:` 等）
- Loki ラベルの高カーディナリティ追加禁止（今回は Prometheus のみなので影響なし）
- 環境変数名はすべて UPPER_SNAKE_CASE
- `console.error()` のみでロギング（`console.log` 不使用）

---

### Task 1: 型定義と wrangler 設定

**Files:**
- Create: `workers/src/provider-metrics/types.ts`
- Create: `workers/wrangler.provider-metrics.jsonc`
- Modify: `workers/.dev.vars.example`
- Modify: `Makefile`

**Interfaces:**
- Produces:
  - `ProviderMetricsEnv` interface — scheduled handler が受け取る env 型
  - `OpenAIFetchResult` interface — OpenAI fetcher の戻り値型
  - `CodexFetchResult` interface — Codex fetcher の戻り値型
  - `OpenCodeGoFetchResult` interface — OpenCodeGo fetcher の戻り値型

---

- [ ] **Step 1: `workers/src/provider-metrics/types.ts` を作成する**

```typescript
// workers/src/provider-metrics/types.ts

export interface ProviderMetricsEnv {
  // Grafana Cloud Prometheus (shared with OllamaCloudEnv pattern)
  GRAFANA_CLOUD_PROMETHEUS_URL: string;
  GRAFANA_CLOUD_PROMETHEUS_USERNAME: string;
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: string;

  // OpenAI API
  OPENAI_ADMIN_API_KEY?: string;
  OPENAI_API_HISTORY_DAYS?: string; // デフォルト "1"

  // Codex OAuth
  CODEX_ACCESS_TOKEN?: string;
  CODEX_ACCOUNT_ID?: string; // optional workspace account id

  // OpenCodeGo
  OPENCODEGO_SESSION_COOKIE?: string;
  OPENCODEGO_WORKSPACE_ID?: string; // optional override, fetched if missing
}

/** OpenAI API fetcher の結果 */
export interface OpenAIMetric {
  /** line_item ラベル値（costs エンドポイント由来） */
  lineItem: string;
  /** 前日コスト USD */
  costUSD: number;
}

export interface OpenAITokenMetric {
  /** model ラベル値（completions エンドポイント由来） */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  requests: number;
}

export interface OpenAIFetchResult {
  costs: OpenAIMetric[];
  tokens: OpenAITokenMetric[];
}

/** Codex fetcher の結果 */
export interface CodexFetchResult {
  /** セッション(5h)使用率 0.0–1.0 */
  sessionUsageRatio: number;
  /** 週次使用率 0.0–1.0 */
  weeklyUsageRatio: number;
  /** セッションリセット Unix 秒 */
  sessionResetTimestampSeconds: number;
  /** 週次リセット Unix 秒 */
  weeklyResetTimestampSeconds: number;
  /** クレジット残高（取得できない場合は null） */
  creditsRemaining: number | null;
  /** プラン名 */
  plan: string;
}

/** OpenCodeGo fetcher の結果 */
export interface OpenCodeGoFetchResult {
  /** ローリング(5h)使用率 0.0–1.0 */
  rollingUsageRatio: number;
  /** 週次使用率 0.0–1.0 */
  weeklyUsageRatio: number;
  /** 月次使用率 0.0–1.0 */
  monthlyUsageRatio: number;
  /** ローリングリセット残秒 */
  rollingResetSeconds: number;
  /** 週次リセット残秒 */
  weeklyResetSeconds: number;
  /** 月次リセット残秒 */
  monthlyResetSeconds: number;
  /** Zen クレジット残高 USD（取得できない場合は null） */
  zenBalanceUSD: number | null;
}
```

- [ ] **Step 2: `workers/wrangler.provider-metrics.jsonc` を作成する**

```jsonc
// workers/wrangler.provider-metrics.jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "graft-ai-provider-metrics",
  "main": "src/provider-metrics.ts",
  "compatibility_date": "2026-07-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": {
    "enabled": true
  },
  "triggers": {
    "crons": ["*/5 * * * *"]
  },
  "vars": {
    "OPENAI_API_HISTORY_DAYS": "1"
  }
}
```

- [ ] **Step 3: `.dev.vars.example` にプロバイダーメトリクス変数を追記する**

`workers/.dev.vars.example` の末尾に追記:

```dotenv
# Provider metrics (Codex / OpenAI API / OpenCodeGo → Prometheus)
OPENAI_ADMIN_API_KEY=sk-admin-xxxxxxxxxxxx
CODEX_ACCESS_TOKEN=
CODEX_ACCOUNT_ID=
OPENCODEGO_SESSION_COOKIE=
OPENCODEGO_WORKSPACE_ID=
```

- [ ] **Step 4: `Makefile` に `deploy-provider-metrics` ターゲットを追加する**

`Makefile` の `.PHONY` 行と末尾にそれぞれ追加:

```makefile
.PHONY: install fmt validate test typecheck plan apply dev deploy deploy-ollama deploy-provider-metrics clean setup-free-tier setup-grafana

deploy-provider-metrics:
	cd workers && npx wrangler deploy --config wrangler.provider-metrics.jsonc
```

- [ ] **Step 5: typecheck を確認する**

```bash
make typecheck
```

Expected: エラーなし（新ファイルを参照する entrypoint はまだないので型チェックは通る）

- [ ] **Step 6: コミットする**

```bash
cd /home/y_ohi/program/private/graft-ai
git add workers/src/provider-metrics/types.ts \
        workers/wrangler.provider-metrics.jsonc \
        workers/.dev.vars.example \
        Makefile
git commit -m "feat: provider metrics Worker の型定義・設定ファイルを追加"
```

---

### Task 2: Prometheus push モジュール

**Files:**
- Create: `workers/src/provider-metrics/prometheus.ts`
- Create: `workers/tests/provider-metrics/prometheus.test.ts`

**Interfaces:**
- Consumes: `ProviderMetricsEnv`, `OpenAIFetchResult`, `OpenAIMetric`, `OpenAITokenMetric`, `CodexFetchResult`, `OpenCodeGoFetchResult` （Task 1 で定義）
- Consumes: `postWithRetry` from `../http-retry`
- Produces:
  - `pushProviderMetrics(env, results, fetchFn?): Promise<{ ok: boolean; status: number }>`
    - `results: { openai?: OpenAIFetchResult; codex?: CodexFetchResult; openCodeGo?: OpenCodeGoFetchResult }`

---

- [ ] **Step 1: 失敗するテストを書く**

`workers/tests/provider-metrics/prometheus.test.ts` を作成:

```typescript
import { describe, it, expect, vi } from "vitest";
import { pushProviderMetrics } from "../../src/provider-metrics/prometheus";
import type { OpenAIFetchResult, CodexFetchResult, OpenCodeGoFetchResult } from "../../src/provider-metrics/types";

const env = {
  GRAFANA_CLOUD_PROMETHEUS_URL: "https://otlp-gateway-prod-us-central1.grafana.net/otlp",
  GRAFANA_CLOUD_PROMETHEUS_USERNAME: "123456",
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "test-token",
};

const sampleOpenAI: OpenAIFetchResult = {
  costs: [{ lineItem: "Chat Completions", costUSD: 0.42 }],
  tokens: [{ model: "gpt-4o", inputTokens: 1000, outputTokens: 500, cachedTokens: 100, requests: 10 }],
};

const sampleCodex: CodexFetchResult = {
  sessionUsageRatio: 0.45,
  weeklyUsageRatio: 0.2,
  sessionResetTimestampSeconds: 1700010000,
  weeklyResetTimestampSeconds: 1700100000,
  creditsRemaining: 3.5,
  plan: "pro",
};

const sampleOpenCodeGo: OpenCodeGoFetchResult = {
  rollingUsageRatio: 0.3,
  weeklyUsageRatio: 0.15,
  monthlyUsageRatio: 0.5,
  rollingResetSeconds: 3600,
  weeklyResetSeconds: 86400,
  monthlyResetSeconds: 1296000,
  zenBalanceUSD: 23.45,
};

describe("pushProviderMetrics", () => {
  it("returns ok on HTTP 200", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    const result = await pushProviderMetrics(
      env,
      { openai: sampleOpenAI, codex: sampleCodex, openCodeGo: sampleOpenCodeGo },
      mockFetch,
    );
    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("posts to OTLP metrics endpoint with Basic Auth", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    await pushProviderMetrics(env, { codex: sampleCodex }, mockFetch);
    const [url, init] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://otlp-gateway-prod-us-central1.grafana.net/otlp/v1/metrics");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Basic ${btoa("123456:test-token")}`);
  });

  it("includes openai_api_cost_usd metric when openai result provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    await pushProviderMetrics(env, { openai: sampleOpenAI }, mockFetch);
    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics as Array<{ name: string }>;
    const names = metrics.map((m) => m.name);
    expect(names).toContain("openai_api_cost_usd");
    expect(names).toContain("openai_api_input_tokens");
    expect(names).toContain("openai_api_requests");
  });

  it("includes codex metrics when codex result provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    await pushProviderMetrics(env, { codex: sampleCodex }, mockFetch);
    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics as Array<{ name: string }>;
    const names = metrics.map((m) => m.name);
    expect(names).toContain("codex_usage_ratio");
    expect(names).toContain("codex_reset_timestamp_seconds");
    expect(names).toContain("codex_credits_remaining");
    expect(names).toContain("codex_plan_info");
  });

  it("includes opencodego metrics when openCodeGo result provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    await pushProviderMetrics(env, { openCodeGo: sampleOpenCodeGo }, mockFetch);
    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics as Array<{ name: string }>;
    const names = metrics.map((m) => m.name);
    expect(names).toContain("opencodego_usage_ratio");
    expect(names).toContain("opencodego_reset_seconds_remaining");
    expect(names).toContain("opencodego_zen_balance_usd");
  });

  it("retries on HTTP 429 up to 2 times", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Too Many Requests", { status: 429 }));
    const result = await pushProviderMetrics(env, { codex: sampleCodex }, mockFetch);
    expect(result.ok).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry on HTTP 400", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Bad Request", { status: 400 }));
    const result = await pushProviderMetrics(env, { codex: sampleCodex }, mockFetch);
    expect(result.ok).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("omits codex_credits_remaining when creditsRemaining is null", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    const noCredits: CodexFetchResult = { ...sampleCodex, creditsRemaining: null };
    await pushProviderMetrics(env, { codex: noCredits }, mockFetch);
    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics as Array<{ name: string }>;
    const names = metrics.map((m) => m.name);
    expect(names).not.toContain("codex_credits_remaining");
  });

  it("omits opencodego_zen_balance_usd when zenBalanceUSD is null", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    const noZen: OpenCodeGoFetchResult = { ...sampleOpenCodeGo, zenBalanceUSD: null };
    await pushProviderMetrics(env, { openCodeGo: noZen }, mockFetch);
    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics as Array<{ name: string }>;
    const names = metrics.map((m) => m.name);
    expect(names).not.toContain("opencodego_zen_balance_usd");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
cd /home/y_ohi/program/private/graft-ai && npx vitest run workers/tests/provider-metrics/prometheus.test.ts 2>&1 | head -20
```

Expected: `Cannot find module '../../src/provider-metrics/prometheus'` でエラー

- [ ] **Step 3: `workers/src/provider-metrics/prometheus.ts` を実装する**

```typescript
// workers/src/provider-metrics/prometheus.ts

import type { ProviderMetricsEnv, OpenAIFetchResult, CodexFetchResult, OpenCodeGoFetchResult } from "./types";
import { postWithRetry } from "../http-retry";

type PrometheusEnv = Pick<
  ProviderMetricsEnv,
  | "GRAFANA_CLOUD_PROMETHEUS_URL"
  | "GRAFANA_CLOUD_PROMETHEUS_USERNAME"
  | "GRAFANA_CLOUD_ACCESS_POLICY_TOKEN"
>;

interface MetricResults {
  openai?: OpenAIFetchResult;
  codex?: CodexFetchResult;
  openCodeGo?: OpenCodeGoFetchResult;
}

function attr(key: string, value: string): Record<string, unknown> {
  return { key, value: { stringValue: value } };
}

function gaugeMetric(
  name: string,
  attributes: Record<string, unknown>[],
  value: number,
  nowUnixNano: string,
): Record<string, unknown> {
  return {
    name,
    gauge: {
      dataPoints: [{ attributes, asDouble: value, timeUnixNano: nowUnixNano }],
    },
  };
}

function buildMetrics(results: MetricResults, nowUnixNano: string): Record<string, unknown>[] {
  const metrics: Record<string, unknown>[] = [];

  // OpenAI API metrics
  if (results.openai) {
    for (const cost of results.openai.costs) {
      metrics.push(
        gaugeMetric(
          "openai_api_cost_usd",
          [attr("line_item", cost.lineItem)],
          cost.costUSD,
          nowUnixNano,
        ),
      );
    }
    for (const token of results.openai.tokens) {
      const modelAttr = [attr("model", token.model)];
      metrics.push(gaugeMetric("openai_api_input_tokens", modelAttr, token.inputTokens, nowUnixNano));
      metrics.push(gaugeMetric("openai_api_output_tokens", modelAttr, token.outputTokens, nowUnixNano));
      metrics.push(gaugeMetric("openai_api_cached_tokens", modelAttr, token.cachedTokens, nowUnixNano));
      metrics.push(gaugeMetric("openai_api_requests", modelAttr, token.requests, nowUnixNano));
    }
  }

  // Codex metrics
  if (results.codex) {
    const c = results.codex;
    for (const [period, ratio, reset] of [
      ["session", c.sessionUsageRatio, c.sessionResetTimestampSeconds],
      ["weekly", c.weeklyUsageRatio, c.weeklyResetTimestampSeconds],
    ] as [string, number, number][]) {
      const periodAttr = [attr("period", period)];
      metrics.push(gaugeMetric("codex_usage_ratio", periodAttr, ratio, nowUnixNano));
      metrics.push(gaugeMetric("codex_reset_timestamp_seconds", periodAttr, reset, nowUnixNano));
    }
    if (c.creditsRemaining !== null) {
      metrics.push(gaugeMetric("codex_credits_remaining", [], c.creditsRemaining, nowUnixNano));
    }
    metrics.push(gaugeMetric("codex_plan_info", [attr("plan", c.plan)], 1, nowUnixNano));
  }

  // OpenCodeGo metrics
  if (results.openCodeGo) {
    const g = results.openCodeGo;
    for (const [period, ratio, remaining] of [
      ["rolling", g.rollingUsageRatio, g.rollingResetSeconds],
      ["weekly", g.weeklyUsageRatio, g.weeklyResetSeconds],
      ["monthly", g.monthlyUsageRatio, g.monthlyResetSeconds],
    ] as [string, number, number][]) {
      const periodAttr = [attr("period", period)];
      metrics.push(gaugeMetric("opencodego_usage_ratio", periodAttr, ratio, nowUnixNano));
      metrics.push(
        gaugeMetric("opencodego_reset_seconds_remaining", periodAttr, remaining, nowUnixNano),
      );
    }
    if (g.zenBalanceUSD !== null) {
      metrics.push(gaugeMetric("opencodego_zen_balance_usd", [], g.zenBalanceUSD, nowUnixNano));
    }
  }

  return metrics;
}

function buildOtlpPayload(results: MetricResults, nowUnixNano: string): Record<string, unknown> {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "graft-ai-provider-metrics" } }],
        },
        scopeMetrics: [
          {
            scope: { name: "graft-ai-provider-metrics" },
            metrics: buildMetrics(results, nowUnixNano),
          },
        ],
      },
    ],
  };
}

export async function pushProviderMetrics(
  env: PrometheusEnv,
  results: MetricResults,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  const url = `${env.GRAFANA_CLOUD_PROMETHEUS_URL}/v1/metrics`;
  const basicAuth = btoa(
    `${env.GRAFANA_CLOUD_PROMETHEUS_USERNAME}:${env.GRAFANA_CLOUD_ACCESS_POLICY_TOKEN}`,
  );
  const nowUnixNano = `${Date.now()}000000`;
  const body = JSON.stringify(buildOtlpPayload(results, nowUnixNano));

  return postWithRetry({
    url,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${basicAuth}`,
    },
    body,
    fetchFn,
    logLabel: "Provider metrics push",
    isRetryableStatus: (status) => !(status >= 400 && status < 500 && status !== 429),
  });
}
```

- [ ] **Step 4: テストを実行して通過することを確認する**

```bash
cd /home/y_ohi/program/private/graft-ai && npx vitest run workers/tests/provider-metrics/prometheus.test.ts
```

Expected: 全テスト PASS

- [ ] **Step 5: typecheck を実行する**

```bash
cd /home/y_ohi/program/private/graft-ai && make typecheck
```

Expected: エラーなし

- [ ] **Step 6: コミットする**

```bash
cd /home/y_ohi/program/private/graft-ai
git add workers/src/provider-metrics/prometheus.ts \
        workers/tests/provider-metrics/prometheus.test.ts
git commit -m "feat: provider metrics の Prometheus push モジュールを追加"
```

---

### Task 3: OpenAI API フェッチャー

**Files:**
- Create: `workers/src/provider-metrics/openai-api.ts`
- Create: `workers/tests/provider-metrics/openai-api.test.ts`

**Interfaces:**
- Consumes: `OpenAIFetchResult`, `OpenAIMetric`, `OpenAITokenMetric` （Task 1 で定義）
- Produces:
  - `fetchOpenAIMetrics(apiKey: string, historyDays?: number, fetchFn?: typeof fetch): Promise<OpenAIFetchResult>`

---

- [ ] **Step 1: 失敗するテストを書く**

`workers/tests/provider-metrics/openai-api.test.ts` を作成:

```typescript
import { describe, it, expect, vi } from "vitest";
import { fetchOpenAIMetrics } from "../../src/provider-metrics/openai-api";

// 前日の costs レスポンス例
const MOCK_COSTS_RESPONSE = {
  object: "page",
  data: [
    {
      object: "bucket",
      start_time: 1700000000,
      end_time: 1700086400,
      results: [
        { object: "usage", amount: { value: 0.42, currency: "usd" }, line_item: "Chat Completions" },
        { object: "usage", amount: { value: 0.10, currency: "usd" }, line_item: "Embeddings" },
      ],
    },
  ],
  has_more: false,
  page: null,
};

// completions レスポンス例
const MOCK_COMPLETIONS_RESPONSE = {
  object: "page",
  data: [
    {
      object: "bucket",
      start_time: 1700000000,
      end_time: 1700086400,
      results: [
        {
          object: "usage",
          model: "gpt-4o",
          num_model_requests: 10,
          input_tokens: 1000,
          input_cached_tokens: 100,
          output_tokens: 500,
          input_audio_tokens: 0,
          output_audio_tokens: 0,
        },
      ],
    },
  ],
  has_more: false,
  page: null,
};

describe("fetchOpenAIMetrics", () => {
  it("returns cost and token metrics parsed from API responses", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      const body = callCount === 1
        ? JSON.stringify(MOCK_COSTS_RESPONSE)
        : JSON.stringify(MOCK_COMPLETIONS_RESPONSE);
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const result = await fetchOpenAIMetrics("sk-admin-test", 1, mockFetch);

    expect(result.costs).toHaveLength(2);
    expect(result.costs[0]).toEqual({ lineItem: "Chat Completions", costUSD: 0.42 });
    expect(result.costs[1]).toEqual({ lineItem: "Embeddings", costUSD: 0.10 });

    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0]).toMatchObject({
      model: "gpt-4o",
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 100,
      requests: 10,
    });
  });

  it("sends Bearer auth header", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [], has_more: false, page: null }), { status: 200 }),
    );
    await fetchOpenAIMetrics("sk-admin-test", 1, mockFetch);
    const [, init] = mockFetch.mock.calls[0]! as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-admin-test");
  });

  it("throws on HTTP 401", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    await expect(fetchOpenAIMetrics("bad-key", 1, mockFetch)).rejects.toThrow(/401/);
  });

  it("aggregates results from has_more pagination", async () => {
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      call++;
      if (call === 1) {
        // costs page 1
        return new Response(
          JSON.stringify({
            data: [{ start_time: 1700000000, end_time: 1700086400, results: [{ amount: { value: 0.10, currency: "usd" }, line_item: "Chat Completions" }] }],
            has_more: true,
            page: "cursor_abc",
          }),
          { status: 200 },
        );
      }
      if (call === 2) {
        // costs page 2
        return new Response(
          JSON.stringify({
            data: [{ start_time: 1700000000, end_time: 1700086400, results: [{ amount: { value: 0.20, currency: "usd" }, line_item: "Chat Completions" }] }],
            has_more: false,
            page: null,
          }),
          { status: 200 },
        );
      }
      // completions
      return new Response(
        JSON.stringify({ data: [], has_more: false, page: null }),
        { status: 200 },
      );
    });

    const result = await fetchOpenAIMetrics("sk-admin-test", 1, mockFetch);
    const chatCost = result.costs.find((c) => c.lineItem === "Chat Completions");
    expect(chatCost?.costUSD).toBeCloseTo(0.30);
  });

  it("returns empty arrays when API returns no data", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [], has_more: false, page: null }), { status: 200 }),
    );
    const result = await fetchOpenAIMetrics("sk-admin-test", 1, mockFetch);
    expect(result.costs).toHaveLength(0);
    expect(result.tokens).toHaveLength(0);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
cd /home/y_ohi/program/private/graft-ai && npx vitest run workers/tests/provider-metrics/openai-api.test.ts 2>&1 | head -20
```

Expected: `Cannot find module` エラー

- [ ] **Step 3: `workers/src/provider-metrics/openai-api.ts` を実装する**

```typescript
// workers/src/provider-metrics/openai-api.ts

import type { OpenAIFetchResult, OpenAIMetric, OpenAITokenMetric } from "./types";

const COSTS_URL = "https://api.openai.com/v1/organization/costs";
const COMPLETIONS_URL = "https://api.openai.com/v1/organization/usage/completions";
const MAX_PAGES = 100;
const TIMEOUT_MS = 20000;

interface CostBucket {
  start_time: number;
  end_time: number;
  results: Array<{
    amount?: { value: number; currency: string };
    line_item?: string;
  }>;
}

interface CompletionBucket {
  start_time: number;
  end_time: number;
  results: Array<{
    model?: string;
    num_model_requests?: number;
    input_tokens?: number;
    input_cached_tokens?: number;
    output_tokens?: number;
    input_audio_tokens?: number;
    output_audio_tokens?: number;
  }>;
}

interface PageResponse<T> {
  data: T[];
  has_more: boolean;
  page: string | null;
}

async function fetchPage<T>(
  url: string,
  apiKey: string,
  fetchFn: typeof fetch,
): Promise<PageResponse<T>> {
  const response = await fetchFn(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`OpenAI API error: HTTP ${response.status} at ${url}`);
  }

  return response.json() as Promise<PageResponse<T>>;
}

function buildUrl(base: string, startTime: number, endTime: number, groupBy: string, page?: string): string {
  const params = new URLSearchParams({
    start_time: String(startTime),
    end_time: String(endTime),
    bucket_width: "1d",
    limit: "31",
    group_by: groupBy,
  });
  if (page) params.set("page", page);
  return `${base}?${params.toString()}`;
}

async function fetchAllPages<T>(
  baseUrl: string,
  groupBy: string,
  apiKey: string,
  startTime: number,
  endTime: number,
  fetchFn: typeof fetch,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    if (++pages > MAX_PAGES) throw new Error(`OpenAI API pagination exceeded ${MAX_PAGES} pages`);
    const url = buildUrl(baseUrl, startTime, endTime, groupBy, cursor);
    const page = await fetchPage<T>(url, apiKey, fetchFn);
    all.push(...page.data);
    cursor = page.has_more && page.page ? page.page : undefined;
  } while (cursor);

  return all;
}

export async function fetchOpenAIMetrics(
  apiKey: string,
  historyDays = 1,
  fetchFn: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<OpenAIFetchResult> {
  // 前日完全 UTC 日を基準とする（scheduledTime を受け取り UTC 当日 00:00 を算出）
  const dayMs = 86400 * 1000;
  const todayUtcMs = Math.floor(nowMs / dayMs) * dayMs;
  const endTime = todayUtcMs / 1000;           // UTC 当日 00:00 Unix 秒
  const startTime = endTime - historyDays * 86400; // N 日前 UTC 00:00 Unix 秒

  const [costBuckets, completionBuckets] = await Promise.all([
    fetchAllPages<CostBucket>(COSTS_URL, "line_item", apiKey, startTime, endTime, fetchFn),
    fetchAllPages<CompletionBucket>(COMPLETIONS_URL, "model", apiKey, startTime, endTime, fetchFn),
  ]);

  // Aggregate costs by line_item
  const costMap = new Map<string, number>();
  for (const bucket of costBuckets) {
    for (const r of bucket.results) {
      const lineItem = r.line_item ?? "Unknown";
      costMap.set(lineItem, (costMap.get(lineItem) ?? 0) + (r.amount?.value ?? 0));
    }
  }
  const costs: OpenAIMetric[] = [...costMap.entries()].map(([lineItem, costUSD]) => ({
    lineItem,
    costUSD,
  }));

  // Aggregate tokens by model
  const tokenMap = new Map<string, OpenAITokenMetric>();
  for (const bucket of completionBuckets) {
    for (const r of bucket.results) {
      const model = r.model ?? "unknown";
      const existing = tokenMap.get(model) ?? {
        model,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        requests: 0,
      };
      tokenMap.set(model, {
        model,
        inputTokens: existing.inputTokens + (r.input_tokens ?? 0) + (r.input_audio_tokens ?? 0),
        outputTokens: existing.outputTokens + (r.output_tokens ?? 0) + (r.output_audio_tokens ?? 0),
        cachedTokens: existing.cachedTokens + (r.input_cached_tokens ?? 0),
        requests: existing.requests + (r.num_model_requests ?? 0),
      });
    }
  }
  const tokens: OpenAITokenMetric[] = [...tokenMap.values()];

  return { costs, tokens };
}
```

- [ ] **Step 4: テストを実行して通過することを確認する**

```bash
cd /home/y_ohi/program/private/graft-ai && npx vitest run workers/tests/provider-metrics/openai-api.test.ts
```

Expected: 全テスト PASS

- [ ] **Step 5: typecheck**

```bash
cd /home/y_ohi/program/private/graft-ai && make typecheck
```

Expected: エラーなし

- [ ] **Step 6: コミットする**

```bash
cd /home/y_ohi/program/private/graft-ai
git add workers/src/provider-metrics/openai-api.ts \
        workers/tests/provider-metrics/openai-api.test.ts
git commit -m "feat: OpenAI API フェッチャーを追加"
```

---

### Task 4: Codex フェッチャー

**Files:**
- Create: `workers/src/provider-metrics/codex.ts`
- Create: `workers/tests/provider-metrics/codex.test.ts`

**Interfaces:**
- Consumes: `CodexFetchResult` （Task 1 で定義）
- Produces:
  - `fetchCodexMetrics(accessToken: string, accountId?: string, fetchFn?: typeof fetch): Promise<CodexFetchResult>`

---

- [ ] **Step 1: 失敗するテストを書く**

`workers/tests/provider-metrics/codex.test.ts` を作成:

```typescript
import { describe, it, expect, vi } from "vitest";
import { fetchCodexMetrics } from "../../src/provider-metrics/codex";

// CodexBar の CodexUsageResponse 形式に準拠したモックレスポンス
const MOCK_USAGE_RESPONSE = {
  plan_type: "pro",
  rate_limit: {
    primary_percent_remaining: 55,
    secondary_percent_remaining: 80,
    primary_resets_at: "2026-08-09T15:00:00Z",
    secondary_resets_at: "2026-08-10T00:00:00Z",
  },
  credits: {
    total_granted: 10.0,
    total_used: 6.5,
  },
};

describe("fetchCodexMetrics", () => {
  it("parses usage ratio and reset timestamps", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(MOCK_USAGE_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await fetchCodexMetrics("test-access-token", undefined, mockFetch);

    // primary_percent_remaining=55 → usage_ratio = (100-55)/100 = 0.45
    expect(result.sessionUsageRatio).toBeCloseTo(0.45);
    // secondary_percent_remaining=80 → usage_ratio = (100-80)/100 = 0.2
    expect(result.weeklyUsageRatio).toBeCloseTo(0.2);
    // credits: 10.0 - 6.5 = 3.5
    expect(result.creditsRemaining).toBeCloseTo(3.5);
    expect(result.plan).toBe("pro");

    const sessionReset = new Date("2026-08-09T15:00:00Z").getTime() / 1000;
    expect(result.sessionResetTimestampSeconds).toBeCloseTo(sessionReset, -2);
  });

  it("sends Bearer auth header and correct URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(MOCK_USAGE_RESPONSE), { status: 200 }),
    );
    await fetchCodexMetrics("test-token", undefined, mockFetch);
    const [url, init] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token");
  });

  it("sends ChatGPT-Account-Id header when accountId provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(MOCK_USAGE_RESPONSE), { status: 200 }),
    );
    await fetchCodexMetrics("token", "acct-123", mockFetch);
    const [, init] = mockFetch.mock.calls[0]! as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["ChatGPT-Account-Id"]).toBe("acct-123");
  });

  it("throws on HTTP 401", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    await expect(fetchCodexMetrics("bad-token", undefined, mockFetch)).rejects.toThrow(/401/);
  });

  it("sets creditsRemaining to null when credits field absent", async () => {
    const noCredits = { plan_type: "free", rate_limit: MOCK_USAGE_RESPONSE.rate_limit };
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(noCredits), { status: 200 }),
    );
    const result = await fetchCodexMetrics("token", undefined, mockFetch);
    expect(result.creditsRemaining).toBeNull();
  });

  it("defaults plan to 'unknown' when plan_type absent", async () => {
    const noPlan = { rate_limit: MOCK_USAGE_RESPONSE.rate_limit };
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(noPlan), { status: 200 }),
    );
    const result = await fetchCodexMetrics("token", undefined, mockFetch);
    expect(result.plan).toBe("unknown");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
cd /home/y_ohi/program/private/graft-ai && npx vitest run workers/tests/provider-metrics/codex.test.ts 2>&1 | head -20
```

Expected: `Cannot find module` エラー

- [ ] **Step 3: `workers/src/provider-metrics/codex.ts` を実装する**

```typescript
// workers/src/provider-metrics/codex.ts

import type { CodexFetchResult } from "./types";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TIMEOUT_MS = 30000;

interface RateLimit {
  primary_percent_remaining?: number;
  secondary_percent_remaining?: number;
  primary_resets_at?: string;
  secondary_resets_at?: string;
}

interface Credits {
  total_granted?: number;
  total_used?: number;
}

interface CodexUsageResponse {
  plan_type?: string;
  rate_limit?: RateLimit;
  credits?: Credits;
}

function parseResetTimestamp(isoString?: string): number {
  if (!isoString) return 0;
  const ms = Date.parse(isoString);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

export async function fetchCodexMetrics(
  accessToken: string,
  accountId?: string,
  fetchFn: typeof fetch = fetch,
): Promise<CodexFetchResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "graft-ai",
  };
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }

  const response = await fetchFn(USAGE_URL, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Codex API error: HTTP ${response.status}`);
  }

  const data = (await response.json()) as CodexUsageResponse;

  const primaryRemaining = data.rate_limit?.primary_percent_remaining ?? 0;
  const secondaryRemaining = data.rate_limit?.secondary_percent_remaining ?? 0;

  let creditsRemaining: number | null = null;
  if (data.credits?.total_granted !== undefined && data.credits?.total_used !== undefined) {
    creditsRemaining = data.credits.total_granted - data.credits.total_used;
  }

  return {
    sessionUsageRatio: (100 - primaryRemaining) / 100,
    weeklyUsageRatio: (100 - secondaryRemaining) / 100,
    sessionResetTimestampSeconds: parseResetTimestamp(data.rate_limit?.primary_resets_at),
    weeklyResetTimestampSeconds: parseResetTimestamp(data.rate_limit?.secondary_resets_at),
    creditsRemaining,
    plan: data.plan_type ?? "unknown",
  };
}
```

- [ ] **Step 4: テストを実行して通過することを確認する**

```bash
cd /home/y_ohi/program/private/graft-ai && npx vitest run workers/tests/provider-metrics/codex.test.ts
```

Expected: 全テスト PASS

- [ ] **Step 5: typecheck**

```bash
cd /home/y_ohi/program/private/graft-ai && make typecheck
```

Expected: エラーなし

- [ ] **Step 6: コミットする**

```bash
cd /home/y_ohi/program/private/graft-ai
git add workers/src/provider-metrics/codex.ts \
        workers/tests/provider-metrics/codex.test.ts
git commit -m "feat: Codex OAuth フェッチャーを追加"
```

---

### Task 5: OpenCodeGo フェッチャー

**Files:**
- Create: `workers/src/provider-metrics/opencodego.ts`
- Create: `workers/tests/provider-metrics/opencodego.test.ts`

**Interfaces:**
- Consumes: `OpenCodeGoFetchResult` （Task 1 で定義）
- Produces:
  - `fetchOpenCodeGoMetrics(cookie: string, workspaceIdOverride?: string, fetchFn?: typeof fetch): Promise<OpenCodeGoFetchResult>`

---

- [ ] **Step 1: 失敗するテストを書く**

`workers/tests/provider-metrics/opencodego.test.ts` を作成:

```typescript
import { describe, it, expect, vi } from "vitest";
import { fetchOpenCodeGoMetrics } from "../../src/provider-metrics/opencodego";

// workspaceID 取得レスポンス例（_server エンドポイント）
const MOCK_WORKSPACE_HTML = `<script>self.__next_f=[["wrk_abc123"]]</script>`;

// 使用量ページ HTML 例（__NEXT_DATA__ 等に埋め込まれた JSON）
const MOCK_USAGE_HTML = `
<script id="__NEXT_DATA__" type="application/json">
{
  "props": {
    "pageProps": {
      "subscription": {
        "usagePercent": 30,
        "weeklyUsagePercent": 15,
        "monthlyUsagePercent": 50,
        "resetInSec": 3600,
        "weeklyResetInSec": 86400,
        "monthlyResetInSec": 1296000
      }
    }
  }
}
</script>`;

// Zen 残高レスポンス例
const MOCK_ZEN_HTML = `<script>{"zenBalance":23.45}</script>`;

// トップレベル JSON 形式の使用量レスポンス例
const MOCK_USAGE_TOP_LEVEL_JSON = JSON.stringify({
  usagePercent: 42,
  weeklyUsagePercent: 20,
  monthlyUsagePercent: 60,
  resetInSec: 1800,
  weeklyResetInSec: 43200,
  monthlyResetInSec: 648000,
});

// RSC ハイドレーション形式の使用量レスポンス例
const MOCK_USAGE_RSC_HTML = `<script>
self.__next_f.push(["rollingUsage", {"usagePercent": 55, "resetInSec": 900}])
</script>`;

// テキストフォールバック形式の使用量レスポンス例（JSON 構造なし）
const MOCK_USAGE_TEXT_BODY = `page content "usagePercent": 72, "resetInSec": 600 more content`;

describe("fetchOpenCodeGoMetrics", () => {
  it("parses usage ratios from embedded JSON", async () => {
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      if (call === 2) return new Response(MOCK_USAGE_HTML, { status: 200 });
      // Zen balance (optional)
      return new Response(MOCK_ZEN_HTML, { status: 200 });
    });

    const result = await fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch);

    expect(result.rollingUsageRatio).toBeCloseTo(0.3);
    expect(result.weeklyUsageRatio).toBeCloseTo(0.15);
    expect(result.monthlyUsageRatio).toBeCloseTo(0.5);
    expect(result.rollingResetSeconds).toBe(3600);
    expect(result.weeklyResetSeconds).toBe(86400);
    expect(result.monthlyResetSeconds).toBe(1296000);
  });

  it("uses workspaceIdOverride when provided", async () => {
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      call++;
      if (url.includes("/workspace/wrk_override/go"))
        return new Response(MOCK_USAGE_HTML, { status: 200 });
      return new Response(MOCK_ZEN_HTML, { status: 200 });
    });

    await fetchOpenCodeGoMetrics("session=abc", "wrk_override", mockFetch);
    // workspaceID 取得リクエスト（_server）は呼ばれない
    const urls = mockFetch.mock.calls.map(([u]: [string]) => u);
    expect(urls.some((u) => u.includes("_server") && u.includes("def399"))).toBe(false);
    expect(urls.some((u) => u.includes("/workspace/wrk_override/go"))).toBe(true);
  });

  it("sends Cookie header", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("_server") && url.includes("def399"))
        return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      if (url.includes("/go")) return new Response(MOCK_USAGE_HTML, { status: 200 });
      return new Response(MOCK_ZEN_HTML, { status: 200 });
    });

    await fetchOpenCodeGoMetrics("__Secure-session=xyz", undefined, mockFetch);

    for (const [, init] of mockFetch.mock.calls as [string, RequestInit][]) {
      const headers = init.headers as Record<string, string>;
      expect(headers["Cookie"]).toContain("__Secure-session=xyz");
    }
  });

  it("throws on HTTP 401 for workspace fetch", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    await expect(
      fetchOpenCodeGoMetrics("expired-session", undefined, mockFetch),
    ).rejects.toThrow(/401|expired|Cookie/i);
  });

  it("returns zenBalanceUSD null when zen fetch fails", async () => {
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      if (call === 2) return new Response(MOCK_USAGE_HTML, { status: 200 });
      return new Response("Not Found", { status: 404 });
    });

    const result = await fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch);
    expect(result.zenBalanceUSD).toBeNull();
  });

  it("parses usage from top-level JSON response", async () => {
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      if (call === 2) return new Response(MOCK_USAGE_TOP_LEVEL_JSON, { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const result = await fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch);
    expect(result.rollingUsageRatio).toBeCloseTo(0.42);
    expect(result.rollingResetSeconds).toBe(1800);
  });

  it("parses usage from RSC hydration containing rollingUsage", async () => {
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      if (call === 2) return new Response(MOCK_USAGE_RSC_HTML, { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const result = await fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch);
    expect(result.rollingUsageRatio).toBeCloseTo(0.55);
    expect(result.rollingResetSeconds).toBe(900);
  });

  it("parses usage via regex text fallback when no JSON structure found", async () => {
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      if (call === 2) return new Response(MOCK_USAGE_TEXT_BODY, { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const result = await fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch);
    expect(result.rollingUsageRatio).toBeCloseTo(0.72);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
cd /home/y_ohi/program/private/graft-ai && npx vitest run workers/tests/provider-metrics/opencodego.test.ts 2>&1 | head -20
```

Expected: `Cannot find module` エラー

- [ ] **Step 3: `workers/src/provider-metrics/opencodego.ts` を実装する**

```typescript
// workers/src/provider-metrics/opencodego.ts

import type { OpenCodeGoFetchResult } from "./types";

const BASE_URL = "https://opencode.ai";
const WORKSPACES_SERVER_ID = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";
const BILLING_SERVER_ID = "c83b78a614689c38ebee981f9b39a8b377716db85c1fd7dbab604adc02d3313d";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const TIMEOUT_MS = 20000;

// CodexBar の percentKeys に倣ったフォールバックキー群
const PERCENT_KEYS = [
  "usagePercent",
  "usedPercent",
  "percentUsed",
  "percent",
  "usage_percent",
  "used_percent",
  "utilization",
  "utilizationPercent",
  "utilization_percent",
  "usage",
] as const;

const WEEKLY_PERCENT_KEYS = ["weeklyUsagePercent", "weeklyUsedPercent", "weekly_usage_percent"] as const;
const MONTHLY_PERCENT_KEYS = ["monthlyUsagePercent", "monthlyUsedPercent", "monthly_usage_percent"] as const;
const RESET_IN_KEYS = [
  "resetInSec",
  "resetInSeconds",
  "resetSeconds",
  "reset_sec",
  "reset_in_sec",
  "resetsInSec",
  "resetsInSeconds",
  "resetIn",
  "resetSec",
] as const;
const WEEKLY_RESET_KEYS = ["weeklyResetInSec", "weeklyResetInSeconds", "weekly_reset_in_sec"] as const;
const MONTHLY_RESET_KEYS = ["monthlyResetInSec", "monthlyResetInSeconds", "monthly_reset_in_sec"] as const;

function pick<T extends Record<string, unknown>>(obj: T, keys: readonly string[]): number | undefined {
  for (const k of keys) {
    if (k in obj && typeof obj[k] === "number") return obj[k] as number;
  }
  return undefined;
}

function extractFromNextData(html: string): Record<string, unknown> | null {
  const match = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match?.[1]) return null;
  try {
    const data = JSON.parse(match[1]) as Record<string, unknown>;
    // 再帰的に subscription / usage 相当のオブジェクトを探す
    return findUsageObject(data);
  } catch {
    return null;
  }
}

function findUsageObject(obj: unknown): Record<string, unknown> | null {
  if (typeof obj !== "object" || obj === null) return null;
  const record = obj as Record<string, unknown>;
  // usagePercent 等のキーがあるオブジェクトを発見
  if (PERCENT_KEYS.some((k) => k in record)) return record;
  for (const v of Object.values(record)) {
    const found = findUsageObject(v);
    if (found) return found;
  }
  return null;
}

function extractFromTopLevelJson(html: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(html.trim()) as Record<string, unknown>;
    return findUsageObject(data);
  } catch {
    return null;
  }
}

function extractFromScriptTags(html: string): Record<string, unknown> | null {
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    const content = match[1]?.trim();
    if (!content) continue;
    try {
      const data = JSON.parse(content) as Record<string, unknown>;
      const found = findUsageObject(data);
      if (found) return found;
    } catch {
      // JSON でない script タグはスキップ
    }
  }
  return null;
}

function extractFromRscHydration(html: string): Record<string, unknown> | null {
  // RSC ハイドレーション: "rollingUsage", {...} パターンを検索
  const roMatch = html.match(/"rollingUsage"\s*,\s*(\{[^{}]+\})/);
  if (roMatch?.[1]) {
    try {
      const obj = JSON.parse(roMatch[1]) as Record<string, unknown>;
      if (findUsageObject(obj)) return obj;
    } catch { /* continue */ }
  }
  return null;
}

function extractFromTextFallback(html: string): Record<string, unknown> | null {
  // usagePercent 等を正規表現で直接抽出（最終フォールバック）
  const usageMatch = html.match(/"(?:usagePercent|rollingUsagePercent|usedPercent)"\s*:\s*(\d+(?:\.\d+)?)/);
  if (!usageMatch?.[1]) return null;
  const usagePercent = parseFloat(usageMatch[1]);
  const resetMatch = html.match(/"resetInSec(?:onds)?"\s*:\s*(\d+)/);
  const resetInSec = resetMatch?.[1] ? parseInt(resetMatch[1], 10) : 0;
  return { usagePercent, resetInSec };
}

/** 複数フォーマットを順に試して使用量オブジェクトを返す */
function extractUsageData(html: string): Record<string, unknown> | null {
  return (
    extractFromNextData(html) ??
    extractFromTopLevelJson(html) ??
    extractFromScriptTags(html) ??
    extractFromRscHydration(html) ??
    extractFromTextFallback(html)
  );
}

function extractWorkspaceId(html: string): string | null {
  // "wrk_..." 形式の ID を HTML から抽出
  const match = html.match(/"(wrk_[a-zA-Z0-9]+)"/);
  return match?.[1] ?? null;
}

function extractZenBalance(html: string): number | null {
  const match = html.match(/"zenBalance"\s*:\s*([\d.]+)/);
  if (match?.[1]) {
    const v = parseFloat(match[1]);
    return Number.isNaN(v) ? null : v;
  }
  return null;
}

async function get(url: string, cookie: string, fetchFn: typeof fetch): Promise<Response> {
  return fetchFn(url, {
    method: "GET",
    headers: {
      Cookie: cookie,
      "User-Agent": USER_AGENT,
      Referer: BASE_URL,
      Origin: BASE_URL,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function fetchWorkspaceId(cookie: string, fetchFn: typeof fetch): Promise<string> {
  const url = `${BASE_URL}/_server?id=${WORKSPACES_SERVER_ID}`;
  const response = await get(url, cookie, fetchFn);

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `OpenCodeGo: HTTP ${response.status} — Cookie expired, update OPENCODEGO_SESSION_COOKIE`,
      );
    }
    throw new Error(`OpenCodeGo workspace fetch failed: HTTP ${response.status}`);
  }

  const html = await response.text();
  const id = extractWorkspaceId(html);
  if (!id) throw new Error("OpenCodeGo: Could not extract workspace ID from response");
  return id;
}

async function fetchZenBalance(
  workspaceId: string,
  cookie: string,
  fetchFn: typeof fetch,
): Promise<number | null> {
  const args = JSON.stringify([workspaceId]);
  const url = `${BASE_URL}/_server?id=${BILLING_SERVER_ID}&args=${encodeURIComponent(args)}`;
  try {
    const response = await get(url, cookie, fetchFn);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const html = await response.text();
    return extractZenBalance(html);
  } catch {
    return null;
  }
}

export async function fetchOpenCodeGoMetrics(
  cookie: string,
  workspaceIdOverride?: string,
  fetchFn: typeof fetch = fetch,
): Promise<OpenCodeGoFetchResult> {
  const workspaceId =
    workspaceIdOverride ?? (await fetchWorkspaceId(cookie, fetchFn));

  const usageUrl = `${BASE_URL}/workspace/${workspaceId}/go`;
  const usageResponse = await get(usageUrl, cookie, fetchFn);

  if (!usageResponse.ok) {
    await usageResponse.body?.cancel().catch(() => undefined);
    if (usageResponse.status === 401 || usageResponse.status === 403) {
      throw new Error(
        `OpenCodeGo: HTTP ${usageResponse.status} — Cookie expired, update OPENCODEGO_SESSION_COOKIE`,
      );
    }
    throw new Error(`OpenCodeGo usage page fetch failed: HTTP ${usageResponse.status}`);
  }

  const html = await usageResponse.text();
  const usageObj = extractUsageData(html);
  if (!usageObj) {
    throw new Error("OpenCodeGo: Could not parse usage data from page HTML");
  }

  const rollingPercent = pick(usageObj, PERCENT_KEYS) ?? 0;
  const weeklyPercent = pick(usageObj, WEEKLY_PERCENT_KEYS) ?? 0;
  const monthlyPercent = pick(usageObj, MONTHLY_PERCENT_KEYS) ?? 0;
  const rollingReset = pick(usageObj, RESET_IN_KEYS) ?? 0;
  const weeklyReset = pick(usageObj, WEEKLY_RESET_KEYS) ?? 0;
  const monthlyReset = pick(usageObj, MONTHLY_RESET_KEYS) ?? 0;

  // Zen balance はベストエフォート
  const zenBalanceUSD = await fetchZenBalance(workspaceId, cookie, fetchFn);

  return {
    rollingUsageRatio: rollingPercent / 100,
    weeklyUsageRatio: weeklyPercent / 100,
    monthlyUsageRatio: monthlyPercent / 100,
    rollingResetSeconds: Math.round(rollingReset),
    weeklyResetSeconds: Math.round(weeklyReset),
    monthlyResetSeconds: Math.round(monthlyReset),
    zenBalanceUSD,
  };
}
```

- [ ] **Step 4: テストを実行して通過することを確認する**

```bash
cd /home/y_ohi/program/private/graft-ai && npx vitest run workers/tests/provider-metrics/opencodego.test.ts
```

Expected: 全テスト PASS

- [ ] **Step 5: typecheck**

```bash
cd /home/y_ohi/program/private/graft-ai && make typecheck
```

Expected: エラーなし

- [ ] **Step 6: コミットする**

```bash
cd /home/y_ohi/program/private/graft-ai
git add workers/src/provider-metrics/opencodego.ts \
        workers/tests/provider-metrics/opencodego.test.ts
git commit -m "feat: OpenCodeGo Cookie フェッチャーを追加"
```

---

### Task 6: Worker エントリポイントと統合テスト

**Files:**
- Create: `workers/src/provider-metrics.ts`
- Create: `workers/tests/provider-metrics/scheduled.test.ts`

**Interfaces:**
- Consumes: `ProviderMetricsEnv` （Task 1）
- Consumes: `fetchOpenAIMetrics` （Task 3）
- Consumes: `fetchCodexMetrics` （Task 4）
- Consumes: `fetchOpenCodeGoMetrics` （Task 5）
- Consumes: `pushProviderMetrics` （Task 2）

---

- [ ] **Step 1: 失敗するテストを書く**

`workers/tests/provider-metrics/scheduled.test.ts` を作成:

```typescript
import { describe, it, expect, vi } from "vitest";
import worker from "../../src/provider-metrics";

const baseEnv = {
  GRAFANA_CLOUD_PROMETHEUS_URL: "https://otlp-gateway-prod-us-central1.grafana.net/otlp",
  GRAFANA_CLOUD_PROMETHEUS_USERNAME: "123456",
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "token",
  OPENAI_ADMIN_API_KEY: "sk-admin-test",
  CODEX_ACCESS_TOKEN: "codex-token",
  OPENCODEGO_SESSION_COOKIE: "session=abc",
};

const scheduledEvent = {
  scheduledTime: new Date("2026-01-01T00:00:00Z").getTime(),
  cron: "*/5 * * * *",
} as ScheduledEvent;

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

describe("provider-metrics scheduled handler", () => {
  it("calls Prometheus push when all providers configured", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      // OpenAI API — JSON が必要
      if ((url as string).includes("api.openai.com")) {
        return new Response(
          JSON.stringify({ data: [], has_more: false, page: null }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Codex — JSON が必要
      if ((url as string).includes("chatgpt.com")) {
        return new Response(
          JSON.stringify({
            plan_type: "pro",
            rate_limit: {
              primary_percent_remaining: 50,
              secondary_percent_remaining: 70,
              primary_resets_at: "2026-01-01T12:00:00Z",
              secondary_resets_at: "2026-01-08T00:00:00Z",
            },
            credits: { total_granted: 10, total_used: 3 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // OpenCodeGo — workspace ID 取得
      if ((url as string).includes("opencode.ai") && (url as string).includes("def399")) {
        return new Response(`<script>["wrk_test123"]</script>`, { status: 200 });
      }
      // OpenCodeGo — 使用量ページ
      if ((url as string).includes("opencode.ai") && (url as string).includes("/go")) {
        return new Response(
          `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"subscription":{"usagePercent":30,"resetInSec":3600}}}}</script>`,
          { status: 200 },
        );
      }
      // OpenCodeGo — Zen balance（任意）
      if ((url as string).includes("opencode.ai")) {
        return new Response(`{"zenBalance":10.0}`, { status: 200 });
      }
      // Prometheus push
      return new Response("", { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);

    await worker.scheduled(scheduledEvent, baseEnv, ctx);

    // 最低 1 回は Prometheus push が呼ばれる
    const prometheusCalls = mockFetch.mock.calls.filter(([url]: [string]) =>
      (url as string).includes("/v1/metrics"),
    );
    expect(prometheusCalls.length).toBeGreaterThan(0);

    vi.unstubAllGlobals();
  });

  it("does not push metrics when no provider secrets configured", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const envNoSecrets = {
      GRAFANA_CLOUD_PROMETHEUS_URL: baseEnv.GRAFANA_CLOUD_PROMETHEUS_URL,
      GRAFANA_CLOUD_PROMETHEUS_USERNAME: baseEnv.GRAFANA_CLOUD_PROMETHEUS_USERNAME,
      GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: baseEnv.GRAFANA_CLOUD_ACCESS_POLICY_TOKEN,
    };

    await worker.scheduled(scheduledEvent, envNoSecrets, ctx);

    const prometheusCalls = mockFetch.mock.calls.filter(([url]: [string]) =>
      (url as string).includes("/v1/metrics"),
    );
    expect(prometheusCalls.length).toBe(0);

    consoleError.mockRestore();
    vi.unstubAllGlobals();
  });

  it("continues and pushes partial metrics when one provider fails", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      // OpenAI API を 401 で失敗させる
      if ((url as string).includes("api.openai.com")) {
        return new Response("Unauthorized", { status: 401 });
      }
      // Codex を 401 で失敗させる
      if ((url as string).includes("chatgpt.com")) {
        return new Response("Unauthorized", { status: 401 });
      }
      // Prometheus push は成功
      if ((url as string).includes("/v1/metrics")) {
        return new Response("", { status: 200 });
      }
      // OpenCodeGo — workspace ID 取得
      if ((url as string).includes("opencode.ai") && (url as string).includes("def399")) {
        return new Response(`<script>["wrk_ocg123"]</script>`, { status: 200 });
      }
      // OpenCodeGo — 使用量ページ
      if ((url as string).includes("opencode.ai") && (url as string).includes("/go")) {
        return new Response(
          `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"subscription":{"usagePercent":30,"resetInSec":3600}}}}</script>`,
          { status: 200 },
        );
      }
      // OpenCodeGo — Zen balance
      return new Response(`{"zenBalance":5.0}`, { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await worker.scheduled(scheduledEvent, baseEnv, ctx);

    // OpenAI / Codex の失敗がログされている
    expect(consoleError).toHaveBeenCalled();

    // Prometheus push が正確に 1 回呼ばれる（OpenCodeGo 分のみ）
    const prometheusCalls = mockFetch.mock.calls.filter(([url]: [string]) =>
      (url as string).includes("/v1/metrics"),
    );
    expect(prometheusCalls.length).toBe(1);

    // ペイロードに OpenCodeGo メトリクスのみ含まれ、OpenAI / Codex は含まれない
    const [, init] = prometheusCalls[0]! as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics as Array<{ name: string }>;
    const names = metrics.map((m) => m.name);
    expect(names.some((n) => n.startsWith("opencodego_"))).toBe(true);
    expect(names.some((n) => n.startsWith("openai_"))).toBe(false);
    expect(names.some((n) => n.startsWith("codex_"))).toBe(false);

    consoleError.mockRestore();
    vi.unstubAllGlobals();
  });

  it("completes without throwing even when Prometheus push fails", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Server Error", { status: 500 }));
    vi.stubGlobal("fetch", mockFetch);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(worker.scheduled(scheduledEvent, baseEnv, ctx)).resolves.not.toThrow();

    consoleError.mockRestore();
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
cd /home/y_ohi/program/private/graft-ai && npx vitest run workers/tests/provider-metrics/scheduled.test.ts 2>&1 | head -20
```

Expected: `Cannot find module '../../src/provider-metrics'` エラー

- [ ] **Step 3: `workers/src/provider-metrics.ts` を実装する**

```typescript
// workers/src/provider-metrics.ts

import type { ProviderMetricsEnv } from "./provider-metrics/types";
import { fetchOpenAIMetrics } from "./provider-metrics/openai-api";
import { fetchCodexMetrics } from "./provider-metrics/codex";
import { fetchOpenCodeGoMetrics } from "./provider-metrics/opencodego";
import { pushProviderMetrics } from "./provider-metrics/prometheus";
import type { OpenAIFetchResult, CodexFetchResult, OpenCodeGoFetchResult } from "./provider-metrics/types";

export interface ProviderMetricsWorker {
  scheduled(event: ScheduledEvent, env: ProviderMetricsEnv, ctx: ExecutionContext): Promise<void>;
}

const worker: ProviderMetricsWorker = {
  async scheduled(event, env, _ctx) {
    const rawHistoryDays = Number.parseInt(env.OPENAI_API_HISTORY_DAYS ?? "1", 10);
    let historyDays = 1;
    if (Number.isFinite(rawHistoryDays) && rawHistoryDays >= 1 && rawHistoryDays <= 31) {
      historyDays = rawHistoryDays;
    } else if (env.OPENAI_API_HISTORY_DAYS !== undefined) {
      console.error(
        `Provider metrics: OPENAI_API_HISTORY_DAYS="${env.OPENAI_API_HISTORY_DAYS}" は無効です。正の整数かつ 31 以下が必要です。デフォルト 1 を使用します。`,
      );
    }

    // 各プロバイダーを並列で取得、失敗は個別にキャッチして継続
    const [openaiResult, codexResult, openCodeGoResult] = await Promise.all([
      env.OPENAI_ADMIN_API_KEY
        ? fetchOpenAIMetrics(env.OPENAI_ADMIN_API_KEY, historyDays, fetch, event.scheduledTime).catch((err: unknown) => {
            console.error(
              `Provider metrics: OpenAI API fetch failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
          })
        : Promise.resolve(null),

      env.CODEX_ACCESS_TOKEN
        ? fetchCodexMetrics(env.CODEX_ACCESS_TOKEN, env.CODEX_ACCOUNT_ID).catch((err: unknown) => {
            console.error(
              `Provider metrics: Codex fetch failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
          })
        : Promise.resolve(null),

      env.OPENCODEGO_SESSION_COOKIE
        ? fetchOpenCodeGoMetrics(env.OPENCODEGO_SESSION_COOKIE, env.OPENCODEGO_WORKSPACE_ID).catch(
            (err: unknown) => {
              console.error(
                `Provider metrics: OpenCodeGo fetch failed: ${err instanceof Error ? err.message : String(err)}`,
              );
              return null;
            },
          )
        : Promise.resolve(null),
    ]);

    const results: {
      openai?: OpenAIFetchResult;
      codex?: CodexFetchResult;
      openCodeGo?: OpenCodeGoFetchResult;
    } = {};

    if (openaiResult) results.openai = openaiResult;
    if (codexResult) results.codex = codexResult;
    if (openCodeGoResult) results.openCodeGo = openCodeGoResult;

    // 送信するメトリクスがなければ終了
    if (!results.openai && !results.codex && !results.openCodeGo) {
      console.error("Provider metrics: No metrics to push (all providers skipped or failed)");
      return;
    }

    const pushResult = await pushProviderMetrics(env, results);
    if (!pushResult.ok) {
      console.error(
        `Provider metrics: Prometheus push failed: status=${pushResult.status}`,
      );
    }
  },
};

export default worker;
```

- [ ] **Step 4: テストを実行して通過することを確認する**

```bash
cd /home/y_ohi/program/private/graft-ai && npx vitest run workers/tests/provider-metrics/scheduled.test.ts
```

Expected: 全テスト PASS

- [ ] **Step 5: テストスイート全体を実行する**

```bash
cd /home/y_ohi/program/private/graft-ai && make test
```

Expected: 全テスト PASS（既存テストも含む）

- [ ] **Step 6: typecheck を実行する**

```bash
cd /home/y_ohi/program/private/graft-ai && make typecheck
```

Expected: エラーなし

- [ ] **Step 7: コミットする**

```bash
cd /home/y_ohi/program/private/graft-ai
git add workers/src/provider-metrics.ts \
        workers/tests/provider-metrics/scheduled.test.ts
git commit -m "feat: provider metrics Worker のエントリポイントと統合テストを追加"
```

---

### Task 7: ドキュメント更新と最終確認

**Files:**
- Modify: `README.md`
- Modify: `README.ja.md`
- Modify: `SPEC.md`
- Modify: `SPEC.ja.md`

---

- [ ] **Step 1: README.md の「Workers」セクションに provider-metrics を追記する**

`README.md` の Workers の一覧表（`| Worker | Trigger |` 形式の表）に行を追加:

```markdown
| `graft-ai-provider-metrics` | Cron `*/5 * * * *` | Fetches Codex / OpenAI API / OpenCodeGo usage and pushes to Grafana Cloud Prometheus |
```

`README.md` の Secrets セクションに以下を追記（`graft-ai-provider-metrics` 向け）:

````markdown
### graft-ai-provider-metrics secrets

```sh
npx wrangler secret put OPENAI_ADMIN_API_KEY --config wrangler.provider-metrics.jsonc
npx wrangler secret put CODEX_ACCESS_TOKEN --config wrangler.provider-metrics.jsonc
npx wrangler secret put CODEX_ACCOUNT_ID --config wrangler.provider-metrics.jsonc      # optional
npx wrangler secret put OPENCODEGO_SESSION_COOKIE --config wrangler.provider-metrics.jsonc
npx wrangler secret put OPENCODEGO_WORKSPACE_ID --config wrangler.provider-metrics.jsonc  # optional
npx wrangler secret put GRAFANA_CLOUD_PROMETHEUS_URL --config wrangler.provider-metrics.jsonc
npx wrangler secret put GRAFANA_CLOUD_PROMETHEUS_USERNAME --config wrangler.provider-metrics.jsonc
npx wrangler secret put GRAFANA_CLOUD_ACCESS_POLICY_TOKEN --config wrangler.provider-metrics.jsonc
```
````

- [ ] **Step 2: README.ja.md に同内容を日本語で追記する**

README.ja.md の対応箇所に同等の内容を日本語で追記する（README.md の追記内容を参照して日本語訳を作成する）。

- [ ] **Step 3: SPEC.md に Worker の説明を追記する**

`SPEC.md` のシステム構成セクションに:

```markdown
### Provider Metrics Worker (`graft-ai-provider-metrics`)

A scheduled Worker (cron `*/5 * * * *`) that fetches usage metrics from Codex, OpenAI API, and OpenCodeGo and pushes them to Grafana Cloud Prometheus via OTLP/v1 JSON.

**Providers:**
- **OpenAI API**: `GET /v1/organization/costs` + `GET /v1/organization/usage/completions` (Bearer Admin Key, daily window)
- **Codex**: `GET https://chatgpt.com/backend-api/wham/usage` (Bearer OAuth Access Token)
- **OpenCodeGo**: HTML scraping of `opencode.ai/workspace/{id}/go` (Session Cookie)

**Metrics pushed:**
- `openai_api_cost_usd{line_item}`, `openai_api_{input,output,cached}_tokens{model}`, `openai_api_requests{model}`
- `codex_usage_ratio{period}`, `codex_reset_timestamp_seconds{period}`, `codex_credits_remaining`, `codex_plan_info{plan}`
- `opencodego_usage_ratio{period}`, `opencodego_reset_seconds_remaining{period}`, `opencodego_zen_balance_usd`

**Error handling:** Each provider fetch is independent; a single failure does not prevent other metrics from being pushed.
```

- [ ] **Step 4: SPEC.ja.md に同内容を日本語で追記する**

SPEC.ja.md の対応箇所に日本語で同等の内容を追記する。

- [ ] **Step 5: 最終テスト・typecheck・fmt を実行する**

```bash
cd /home/y_ohi/program/private/graft-ai
make fmt
make test
make typecheck
```

Expected: 全チェック PASS

- [ ] **Step 6: コミットする**

```bash
cd /home/y_ohi/program/private/graft-ai
git add README.md README.ja.md SPEC.md SPEC.ja.md
git commit -m "docs: provider metrics Worker をドキュメントに追記"
```

---

## 全タスク完了後の確認コマンド

```bash
cd /home/y_ohi/program/private/graft-ai
make test       # 全テスト PASS
make typecheck  # 型エラーなし
make fmt        # フォーマット差分なし
```

デプロイ準備ができたら:

```bash
cd workers
npx wrangler secret put OPENAI_ADMIN_API_KEY --config wrangler.provider-metrics.jsonc
npx wrangler secret put CODEX_ACCESS_TOKEN --config wrangler.provider-metrics.jsonc
npx wrangler secret put OPENCODEGO_SESSION_COOKIE --config wrangler.provider-metrics.jsonc
npx wrangler secret put GRAFANA_CLOUD_PROMETHEUS_URL --config wrangler.provider-metrics.jsonc
npx wrangler secret put GRAFANA_CLOUD_PROMETHEUS_USERNAME --config wrangler.provider-metrics.jsonc
npx wrangler secret put GRAFANA_CLOUD_ACCESS_POLICY_TOKEN --config wrangler.provider-metrics.jsonc
cd ..
make deploy-provider-metrics
```
