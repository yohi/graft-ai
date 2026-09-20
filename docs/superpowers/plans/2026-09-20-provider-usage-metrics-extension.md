# Provider Usage Metrics Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the Provider Metrics Worker to a common `ProviderResult` / `ProviderAdapter` architecture, migrate OpenCode Go and Ollama Cloud to API-key primary endpoints, add CommandCode as a new provider, and introduce scrape health metrics.

**Architecture:** Each provider adapter consumes `ProviderMetricsEnv` + `ProviderContext` and returns a closed `AdapterOutcome`. A common OTLP builder converts `ProviderResult` into gauge metrics; a separate health builder converts adapter outcomes into `provider_metrics_scrape_*` metrics. The orchestrator runs adapters in parallel with `Promise.allSettled`, skips providers without credentials, and pushes a health-only payload when at least one provider was attempted.

**Tech Stack:** TypeScript (strict), Vitest, Cloudflare Workers runtime, existing `workers/src/http-retry.ts`, no new runtime dependencies.

## Global Constraints

- The spec's external API endpoints, authentication, response shapes, units, and failure handling are fixed and must not be changed at implementation time.
- `workers/package.json` dependencies must not be changed; no JSON Schema or validation library may be introduced.
- Type error suppression (`as any`, `@ts-ignore`, `@ts-expect-error`) is forbidden.
- API keys, OAuth tokens, session cookies, and Authorization headers must never appear in logs, metric labels, error messages, or diagnostic output.
- HTTP response bodies must not be logged or returned in errors; only status, provider, source, and error category may be recorded.
- Unknown source periods, model strings, plan names, or error messages must not become arbitrary Prometheus labels.
- Metric names and existing label values must remain compatible with the "Existing metric compatibility" table in the spec.
- Commit messages follow Conventional Commits in Japanese.
- All CI gates (`make typecheck`, `make test`, `make fmt`, `make validate`) must pass before the work is considered complete.

---

## File Structure

### Modified files

- `workers/src/provider-metrics/types.ts` — extend with common `ProviderResult`, `ProviderAdapter`, `AdapterOutcome`, `ProviderContext`, and new credential env keys.
- `workers/src/provider-metrics/prometheus.ts` — rewrite OTLP builder to consume `ProviderResult[]` and emit quota, plan, credits, usage, and model metrics.
- `workers/src/provider-metrics.ts` — replace sequential `Promise.allSettled` orchestrator with adapter registry, health metric generation, and health-only push.
- `workers/src/provider-metrics/codex.ts` — refactor to `ProviderResult` + Browser Rendering fallback on HTTP 403.
- `workers/src/provider-metrics/openai-api.ts` — refactor to `ProviderResult` while keeping existing costs/usage endpoints.
- `workers/src/provider-metrics/ollama.ts` — move HTML parser to `ollama/settings-html.ts`.
- `workers/tests/provider-metrics/scheduled.test.ts` — update orchestrator expectations.
- `workers/tests/provider-metrics/prometheus.test.ts` — rewrite for `ProviderResult` input.
- `docs/provider-metrics.md` — document new credential variables and source support levels.

### Created files

- `workers/src/provider-metrics/health.ts` — scrape health metric builder.
- `workers/src/provider-metrics/adapters.ts` — adapter registry and execution wrapper.
- `workers/src/provider-metrics/opencodego/index.ts` — adapter entry.
- `workers/src/provider-metrics/opencodego/api-key.ts` — `GET /zen/go/v1/usage` with API key.
- `workers/src/provider-metrics/opencodego/zen-balance.ts` — cookie/RPC Zen balance enrichment.
- `workers/src/provider-metrics/ollama/index.ts` — adapter entry.
- `workers/src/provider-metrics/ollama/api-usage.ts` — `GET /api/usage` JSON.
- `workers/src/provider-metrics/ollama/settings-html.ts` — HTML fallback/enrichment.
- `workers/src/provider-metrics/commandcode/index.ts` — adapter entry.
- `workers/src/provider-metrics/commandcode/billing.ts` — whoami / credits / subscriptions / usage summary chain.
- `workers/tests/provider-metrics/opencodego-api-key.test.ts` — API-key adapter tests.
- `workers/tests/provider-metrics/opencodego-zen-balance.test.ts` — Zen balance enrichment tests.
- `workers/tests/provider-metrics/ollama-api-usage.test.ts` — JSON API adapter tests.
- `workers/tests/provider-metrics/ollama-settings-html.test.ts` — HTML fallback/enrichment tests.
- `workers/tests/provider-metrics/commandcode.test.ts` — CommandCode adapter tests.
- `workers/tests/provider-metrics/health.test.ts` — health metric builder tests.
- `workers/tests/provider-metrics/adapters.test.ts` — registry and execution wrapper tests.

---

## Task 1: Define common provider types

**Files:**
- Modify: `workers/src/provider-metrics/types.ts`

**Interfaces:**
- Produces: `ProviderId`, `SupportLevel`, `SourceRole`, `ProviderSource`, `QuotaPeriod`, `QuotaWindow`, `ProviderCredits`, `ProviderSubscription`, `ProviderUsageSummary`, `ProviderResult`, `ProviderContext`, `ProviderErrorKind`, `ProviderError`, `AdapterOutcome`.

- [ ] **Step 1: Write the failing typecheck test**

Create `workers/tests/provider-metrics/types-smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AdapterOutcome, ProviderResult } from "../../src/provider-metrics/types";

describe("common provider types", () => {
  it("compiles a success outcome", () => {
    const outcome: AdapterOutcome = {
      status: "success",
      result: {
        provider: "commandcode",
        sources: [{ id: "commandcode-billing-credits", supportLevel: "official-internal", role: "primary" }],
        windows: [{ period: "session", usageRatio: 0.5 }],
      } satisfies ProviderResult,
    };
    expect(outcome.status).toBe("success");
  });
});
```

Run: `npx vitest run workers/tests/provider-metrics/types-smoke.test.ts`
Expected: FAIL with "Cannot find module" or TypeScript compile error because types do not exist yet.

- [ ] **Step 2: Add common types to `types.ts`**

Append the following to `workers/src/provider-metrics/types.ts`:

```ts
export type ProviderId =
  | "openai_api"
  | "codex"
  | "opencodego"
  | "ollama_cloud"
  | "commandcode";

export type SupportLevel =
  | "official-public"
  | "official-internal"
  | "web-internal"
  | "scraping";

export type SourceRole = "primary" | "enrichment" | "fallback";

export interface ProviderSource {
  id: string;
  supportLevel: SupportLevel;
  role: SourceRole;
}

export type QuotaPeriod = "session" | "weekly" | "monthly" | "rolling";

export interface QuotaWindow {
  period: QuotaPeriod;
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

export interface ProviderResult {
  provider: ProviderId;
  sources: ProviderSource[];
  windows: QuotaWindow[];
  plan?: string;
  subscription?: ProviderSubscription;
  credits?: ProviderCredits;
  usage?: ProviderUsageSummary;
}

export interface ProviderContext {
  fetchFn: typeof fetch;
  scheduledTimeSeconds: number;
  nowSeconds: () => number;
  browserBinding?: Fetcher;
}

export type ProviderErrorKind =
  | "auth"
  | "forbidden"
  | "rate_limit"
  | "upstream_5xx"
  | "network"
  | "timeout"
  | "schema"
  | "parse";

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

- [ ] **Step 3: Add new credential env keys to `ProviderMetricsEnv`**

In `workers/src/provider-metrics/types.ts`, add inside `ProviderMetricsEnv`:

```ts
  // OpenCodeGo
  OPENCODEGO_API_KEY?: string;
  OPENCODEGO_SESSION_COOKIE?: string;
  OPENCODEGO_WORKSPACE_ID?: string;

  // Ollama Cloud
  OLLAMA_API_KEY?: string;
  OLLAMA_SESSION_COOKIE?: string;

  // CommandCode
  COMMAND_CODE_API_KEY?: string;
```

- [ ] **Step 4: Verify typecheck and test**

Run: `cd workers && npx vitest run tests/provider-metrics/types-smoke.test.ts`
Expected: PASS.

Run: `cd workers && npm run typecheck`
Expected: PASS (only new types added; no consumers yet).

- [ ] **Step 5: Commit**

```bash
git add workers/src/provider-metrics/types.ts workers/tests/provider-metrics/types-smoke.test.ts
git commit -m "feat(provider-metrics): 共通 ProviderResult / AdapterOutcome 型を定義"
```

---

## Task 2: Implement scrape health metric builder

**Files:**
- Create: `workers/src/provider-metrics/health.ts`
- Create: `workers/tests/provider-metrics/health.test.ts`

**Interfaces:**
- Consumes: `ProviderId`, `AdapterOutcome` from Task 1.
- Produces: `buildHealthMetrics(outcomes, nowUnixNano)` returning OTLP gauge metric objects.

- [ ] **Step 1: Write the failing test**

Create `workers/tests/provider-metrics/health.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildHealthMetrics } from "../../src/provider-metrics/health";
import type { ScrapeHealthOutcome } from "../../src/provider-metrics/health";

describe("buildHealthMetrics", () => {
  it("emits success, timestamp, and duration for a successful scrape", () => {
    const outcomes: ScrapeHealthOutcome[] = [
      { provider: "opencodego", success: true, durationSeconds: 0.123, timestampSeconds: 1_000 },
    ];
    const metrics = buildHealthMetrics(outcomes, "1234000000000");
    const names = metrics.map((m) => m.name);
    expect(names).toContain("provider_metrics_scrape_success");
    expect(names).toContain("provider_metrics_scrape_timestamp_seconds");
    expect(names).toContain("provider_metrics_scrape_duration_seconds");
  });

  it("omits timestamp for failed scrapes", () => {
    const outcomes: ScrapeHealthOutcome[] = [
      { provider: "ollama_cloud", success: false, durationSeconds: 0.456 },
    ];
    const metrics = buildHealthMetrics(outcomes, "1234000000000");
    const timestampMetric = metrics.find((m) => m.name === "provider_metrics_scrape_timestamp_seconds");
    expect(timestampMetric).toBeUndefined();
  });
});
```

Run: `npx vitest run tests/provider-metrics/health.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 2: Implement `health.ts`**

Create `workers/src/provider-metrics/health.ts`:

```ts
import type { ProviderId } from "./types";

export interface ScrapeHealthOutcome {
  provider: ProviderId;
  success: boolean;
  durationSeconds: number;
  timestampSeconds?: number;
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

export function buildHealthMetrics(
  outcomes: ScrapeHealthOutcome[],
  nowUnixNano: string,
): Record<string, unknown>[] {
  return outcomes.flatMap((outcome) => {
    const providerAttr = attr("provider", outcome.provider);
    const metrics: Record<string, unknown>[] = [
      gaugeMetric(
        "provider_metrics_scrape_success",
        [providerAttr],
        outcome.success ? 1 : 0,
        nowUnixNano,
      ),
      gaugeMetric(
        "provider_metrics_scrape_duration_seconds",
        [providerAttr],
        outcome.durationSeconds,
        nowUnixNano,
      ),
    ];
    if (outcome.success && outcome.timestampSeconds !== undefined) {
      metrics.push(
        gaugeMetric(
          "provider_metrics_scrape_timestamp_seconds",
          [providerAttr],
          outcome.timestampSeconds,
          nowUnixNano,
        ),
      );
    }
    return metrics;
  });
}
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run tests/provider-metrics/health.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add workers/src/provider-metrics/health.ts workers/tests/provider-metrics/health.test.ts
git commit -m "feat(provider-metrics): scrape health metric builder を追加"
```

---

## Task 3: Implement common OTLP builder from `ProviderResult`

**Files:**
- Modify: `workers/src/provider-metrics/prometheus.ts`
- Modify: `workers/tests/provider-metrics/prometheus.test.ts`

**Interfaces:**
- Consumes: `ProviderResult`, `QuotaWindow`, `ProviderCredits`, `ProviderSubscription`, `ProviderUsageSummary` from Task 1.
- Produces: `buildProviderMetrics(results, nowUnixNano)` returning OTLP gauge metric objects.

- [ ] **Step 1: Write the failing test**

Replace `workers/tests/provider-metrics/prometheus.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { buildProviderMetrics } from "../../src/provider-metrics/prometheus";
import type { ProviderResult } from "../../src/provider-metrics/types";

describe("buildProviderMetrics", () => {
  it("emits quota and reset metrics for all supported windows", () => {
    const result: ProviderResult = {
      provider: "opencodego",
      sources: [{ id: "opencodego-usage-api", supportLevel: "official-internal", role: "primary" }],
      windows: [
        { period: "rolling", usageRatio: 0.12, resetTimestampSeconds: 1_000 },
        { period: "weekly", usageRatio: 0.08, resetTimestampSeconds: 2_000 },
      ],
    };
    const metrics = buildProviderMetrics([result], "1234000000000");
    const names = metrics.map((m) => m.name);
    expect(names).toContain("opencodego_usage_ratio");
    expect(names).toContain("opencodego_reset_timestamp_seconds");
    const rolling = metrics.find((m) => m.name === "opencodego_usage_ratio")!;
    expect(rolling.gauge.dataPoints).toHaveLength(2);
  });

  it("emits credits and plan metrics for CommandCode", () => {
    const result: ProviderResult = {
      provider: "commandcode",
      sources: [{ id: "commandcode-billing-credits", supportLevel: "official-internal", role: "primary" }],
      windows: [],
      plan: "individual-go",
      credits: { remaining: 74.43, monthly: 70, purchased: 5, free: 0 },
    };
    const metrics = buildProviderMetrics([result], "1234000000000");
    const names = metrics.map((m) => m.name);
    expect(names).toContain("commandcode_credits_remaining");
    expect(names).toContain("commandcode_credits_monthly");
    expect(names).toContain("commandcode_credits_purchased");
    expect(names).toContain("commandcode_credits_free");
    expect(names).toContain("commandcode_plan_info");
  });
});
```

Run: `npx vitest run tests/provider-metrics/prometheus.test.ts`
Expected: FAIL with export not found.

- [ ] **Step 2: Rewrite `prometheus.ts` to consume `ProviderResult`**

Replace `workers/src/provider-metrics/prometheus.ts` with:

```ts
import type { ProviderResult, QuotaWindow } from "./types";
import { postWithRetry, validatePrometheusConfig } from "../http-retry";

type PrometheusEnv = {
  GRAFANA_CLOUD_PROMETHEUS_URL: string;
  GRAFANA_CLOUD_PROMETHEUS_USERNAME: string;
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: string;
};

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

function buildQuotaMetrics(
  provider: string,
  window: QuotaWindow,
  nowUnixNano: string,
): Record<string, unknown>[] {
  const periodAttr = [attr("period", window.period)];
  const metrics: Record<string, unknown>[] = [];
  if (window.usageRatio !== undefined) {
    metrics.push(gaugeMetric(`${provider}_usage_ratio`, periodAttr, window.usageRatio, nowUnixNano));
  }
  if (window.resetTimestampSeconds !== undefined) {
    metrics.push(
      gaugeMetric(
        `${provider}_reset_timestamp_seconds`,
        periodAttr,
        window.resetTimestampSeconds,
        nowUnixNano,
      ),
    );
  }
  return metrics;
}

function buildProviderSpecificMetrics(
  result: ProviderResult,
  nowUnixNano: string,
): Record<string, unknown>[] {
  const metrics: Record<string, unknown>[] = [];
  const p = result.provider;

  if (result.credits) {
    const c = result.credits;
    if (c.remaining !== undefined) {
      metrics.push(gaugeMetric(`${p}_credits_remaining`, [], c.remaining, nowUnixNano));
    }
    if (c.monthly !== undefined) {
      metrics.push(gaugeMetric(`${p}_credits_monthly`, [], c.monthly, nowUnixNano));
    }
    if (c.purchased !== undefined) {
      metrics.push(gaugeMetric(`${p}_credits_purchased`, [], c.purchased, nowUnixNano));
    }
    if (c.free !== undefined) {
      metrics.push(gaugeMetric(`${p}_credits_free`, [], c.free, nowUnixNano));
    }
    if (c.resetCredits !== undefined) {
      metrics.push(gaugeMetric(`${p}_reset_credits`, [], c.resetCredits, nowUnixNano));
    }
    if (c.resetCreditsAvailableCount !== undefined) {
      metrics.push(
        gaugeMetric(`${p}_reset_credits_available_count`, [], c.resetCreditsAvailableCount, nowUnixNano),
      );
    }
  }

  if (result.plan) {
    metrics.push(gaugeMetric(`${p}_plan_info`, [attr("plan", result.plan)], 1, nowUnixNano));
  }

  if (result.subscription) {
    const s = result.subscription;
    if (s.status !== undefined && result.plan) {
      metrics.push(
        gaugeMetric(
          `${p}_subscription_info`,
          [attr("plan", result.plan), attr("status", s.status)],
          1,
          nowUnixNano,
        ),
      );
    }
    if (s.billingPeriodEndSeconds !== undefined) {
      metrics.push(
        gaugeMetric(
          `${p}_billing_period_end_seconds`,
          [],
          s.billingPeriodEndSeconds,
          nowUnixNano,
        ),
      );
    }
  }

  if (result.usage) {
    const u = result.usage;
    if (u.costUSD !== undefined) {
      metrics.push(gaugeMetric(`${p}_usage_cost_usd`, [], u.costUSD, nowUnixNano));
    }
    if (u.requests !== undefined) {
      metrics.push(gaugeMetric(`${p}_usage_requests`, [], u.requests, nowUnixNano));
    }
    if (u.tokens !== undefined) {
      metrics.push(gaugeMetric(`${p}_usage_tokens`, [], u.tokens, nowUnixNano));
    }
  }

  return metrics;
}

export function buildProviderMetrics(
  results: ProviderResult[],
  nowUnixNano: string,
): Record<string, unknown>[] {
  return results.flatMap((result) => [
    ...result.windows.flatMap((window) => buildQuotaMetrics(result.provider, window, nowUnixNano)),
    ...buildProviderSpecificMetrics(result, nowUnixNano),
  ]);
}

function buildOtlpPayload(results: ProviderResult[], nowUnixNano: string): Record<string, unknown> {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "graft-ai-provider-metrics" } }],
        },
        scopeMetrics: [
          {
            scope: { name: "graft-ai-provider-metrics" },
            metrics: buildProviderMetrics(results, nowUnixNano),
          },
        ],
      },
    ],
  };
}

export async function pushProviderMetrics(
  env: PrometheusEnv,
  results: ProviderResult[],
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  const url = validatePrometheusConfig(
    env.GRAFANA_CLOUD_PROMETHEUS_URL,
    env.GRAFANA_CLOUD_PROMETHEUS_USERNAME,
    env.GRAFANA_CLOUD_ACCESS_POLICY_TOKEN,
  );
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

- [ ] **Step 3: Run the test**

Run: `npx vitest run tests/provider-metrics/prometheus.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS (other callers of `pushProviderMetrics` will still fail until later tasks).

- [ ] **Step 4: Commit**

```bash
git add workers/src/provider-metrics/prometheus.ts workers/tests/provider-metrics/prometheus.test.ts
git commit -m "feat(provider-metrics): ProviderResult から OTLP metric を生成する共通 builder を追加"
```

---

## Task 4: Implement adapter registry and execution wrapper

**Files:**
- Create: `workers/src/provider-metrics/adapters.ts`
- Create: `workers/tests/provider-metrics/adapters.test.ts`

**Interfaces:**
- Consumes: `ProviderMetricsEnv`, `ProviderContext`, `ProviderAdapter`, `AdapterOutcome` from Task 1.
- Produces: `RegisteredProvider[]`, `runAdapters(env, ctx)` returning `{ outcomes: AdapterOutcome[]; health: ScrapeHealthOutcome[]; attempted: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `workers/tests/provider-metrics/adapters.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { runAdapters } from "../../src/provider-metrics/adapters";
import type { ProviderAdapter, ProviderMetricsEnv } from "../../src/provider-metrics/types";

const env: ProviderMetricsEnv = {
  GRAFANA_CLOUD_PROMETHEUS_URL: "https://example.com/otlp",
  GRAFANA_CLOUD_PROMETHEUS_USERNAME: "u",
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "t",
  COMMAND_CODE_API_KEY: "key",
};

const ctx = { fetchFn: fetch, scheduledTimeSeconds: 1_000, nowSeconds: () => 1_000 };

describe("runAdapters", () => {
  it("runs only providers with credentials and returns health outcomes", async () => {
    const adapter: ProviderAdapter = async () => ({
      status: "success",
      result: {
        provider: "commandcode",
        sources: [{ id: "x", supportLevel: "official-internal", role: "primary" }],
        windows: [],
      },
    });
    const { outcomes, health, attempted } = await runAdapters(env, ctx, [
      { provider: "commandcode", credentialKey: "COMMAND_CODE_API_KEY", adapter },
    ]);
    expect(attempted).toBe(true);
    expect(outcomes).toHaveLength(1);
    expect(health[0]).toMatchObject({ provider: "commandcode", success: true });
  });

  it("skips providers without credentials", async () => {
    const adapter: ProviderAdapter = vi.fn();
    const { attempted, outcomes } = await runAdapters(
      { ...env, COMMAND_CODE_API_KEY: undefined },
      ctx,
      [{ provider: "commandcode", credentialKey: "COMMAND_CODE_API_KEY", adapter }],
    );
    expect(attempted).toBe(false);
    expect(outcomes).toHaveLength(0);
    expect(adapter).not.toHaveBeenCalled();
  });
});
```

Run: `npx vitest run tests/provider-metrics/adapters.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 2: Implement `adapters.ts`**

Create `workers/src/provider-metrics/adapters.ts`:

```ts
import type {
  AdapterOutcome,
  ProviderAdapter,
  ProviderContext,
  ProviderId,
  ProviderMetricsEnv,
} from "./types";
import type { ScrapeHealthOutcome } from "./health";

export interface RegisteredProvider {
  provider: ProviderId;
  credentialKey: keyof ProviderMetricsEnv;
  adapter: ProviderAdapter;
}

function isNonEmptyCredential(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function shouldRun(provider: RegisteredProvider, env: ProviderMetricsEnv): boolean {
  return isNonEmptyCredential(env[provider.credentialKey]);
}

export interface AdapterRunSummary {
  outcomes: AdapterOutcome[];
  health: ScrapeHealthOutcome[];
  attempted: boolean;
}

export async function runAdapters(
  env: ProviderMetricsEnv,
  ctx: ProviderContext,
  registry: RegisteredProvider[],
): Promise<AdapterRunSummary> {
  const toRun = registry.filter((p) => shouldRun(p, env));
  if (toRun.length === 0) {
    return { outcomes: [], health: [], attempted: false };
  }

  const startByProvider = new Map<ProviderId, number>();
  const settled = await Promise.allSettled(
    toRun.map(async (p) => {
      startByProvider.set(p.provider, performance.now());
      return p.adapter(env, ctx);
    }),
  );

  const outcomes: AdapterOutcome[] = [];
  const health: ScrapeHealthOutcome[] = [];

  for (let i = 0; i < toRun.length; i++) {
    const p = toRun[i]!;
    const settledResult = settled[i]!;
    const end = performance.now();
    const start = startByProvider.get(p.provider) ?? end;
    const durationSeconds = (end - start) / 1000;

    if (settledResult.status === "fulfilled") {
      const outcome = settledResult.value;
      outcomes.push(outcome);
      health.push({
        provider: p.provider,
        success: outcome.status === "success" || outcome.status === "empty",
        durationSeconds,
        ...(outcome.status === "success" || outcome.status === "empty"
          ? { timestampSeconds: ctx.nowSeconds() }
          : {}),
      });
    } else {
      outcomes.push({
        status: "failed",
        error: {
          kind: "network",
          provider: p.provider,
          sourceId: `${p.provider}-adapter`,
        },
      });
      health.push({
        provider: p.provider,
        success: false,
        durationSeconds,
      });
    }
  }

  return { outcomes, health, attempted: true };
}
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run tests/provider-metrics/adapters.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add workers/src/provider-metrics/adapters.ts workers/tests/provider-metrics/adapters.test.ts
git commit -m "feat(provider-metrics): adapter registry と実行ラッパーを追加"
```

---

## Task 5: Implement OpenCodeGo API-key adapter

**Files:**
- Create: `workers/src/provider-metrics/opencodego/api-key.ts`
- Create: `workers/src/provider-metrics/opencodego/index.ts`
- Create: `workers/tests/provider-metrics/opencodego-api-key.test.ts`

**Interfaces:**
- Consumes: `ProviderMetricsEnv`, `ProviderContext`.
- Produces: `AdapterOutcome` for `opencodego` via `/zen/go/v1/usage`.

- [ ] **Step 1: Write the failing test**

Create `workers/tests/provider-metrics/opencodego-api-key.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { fetchOpenCodeGoUsageApi } from "../../src/provider-metrics/opencodego/api-key";

describe("fetchOpenCodeGoUsageApi", () => {
  it("returns success with rolling/weekly/monthly windows", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          usage: {
            rolling: { status: "ok", percent: 12, resetsAt: "2026-09-20T17:00:00.000Z" },
            weekly: { status: "ok", percent: 8, resetsAt: "2026-09-22T00:00:00.000Z" },
            monthly: { status: "ok", percent: 35, resetsAt: "2026-10-04T11:18:32.000Z" },
          },
        }),
        { status: 200 },
      ),
    );

    const result = await fetchOpenCodeGoUsageApi("key", mockFetch);
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("unexpected");
    expect(result.result.windows).toHaveLength(3);
    expect(result.result.windows[0]).toMatchObject({ period: "rolling", usageRatio: 0.12 });
  });

  it("returns empty on 403 EntitlementError", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ type: "EntitlementError" }), { status: 403 }),
    );
    const result = await fetchOpenCodeGoUsageApi("key", mockFetch);
    expect(result.status).toBe("empty");
  });
});
```

Run: `npx vitest run tests/provider-metrics/opencodego-api-key.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 2: Implement `api-key.ts`**

Create `workers/src/provider-metrics/opencodego/api-key.ts`:

```ts
import { getWithRetry } from "../../http-retry";
import type { AdapterOutcome, ProviderContext, ProviderResult } from "../types";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const TIMEOUT_MS = 10000;
const SOURCE_ID = "opencodego-usage-api";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFinitePercent(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  if (value < 0 || value > 100) {
    throw new Error(`${path} must be between 0 and 100`);
  }
  return value;
}

function parseStatus(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function parseResetsAt(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`${path} must be an ISO 8601 timestamp`);
  }
  return Math.floor(ms / 1000);
}

function parseWindow(value: unknown, period: string): {
  usageRatio: number;
  resetTimestampSeconds?: number;
  exceeded: boolean;
} {
  if (!isRecord(value)) {
    throw new Error(`usage.${period} must be an object`);
  }
  const status = parseStatus(value["status"], `usage.${period}.status`);
  const percent = parseFinitePercent(value["percent"], `usage.${period}.percent`);
  const exceeded = status === "rate-limited" || status === "exhausted";
  if (exceeded && percent < 100) {
    throw new Error(`usage.${period}.percent must be 100 when status is ${status}`);
  }
  let resetTimestampSeconds: number | undefined;
  try {
    resetTimestampSeconds = parseResetsAt(value["resetsAt"], `usage.${period}.resetsAt`);
  } catch {
    resetTimestampSeconds = undefined;
  }
  return { usageRatio: percent / 100, resetTimestampSeconds, exceeded };
}

export async function fetchOpenCodeGoUsageApi(
  apiKey: string,
  fetchFn: typeof fetch,
): Promise<AdapterOutcome> {
  const response = await getWithRetry({
    url: USAGE_URL,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    fetchFn,
    logLabel: "OpenCodeGo usage API",
    isRetryableStatus: (status) => status === 429 || status >= 500,
    perAttemptTimeoutMs: TIMEOUT_MS,
  });

  if (response.status === 403) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (isRecord(body) && body["type"] === "EntitlementError") {
      return { status: "empty", reason: "no-supported-window" };
    }
    return {
      status: "failed",
      error: {
        kind: "forbidden",
        provider: "opencodego",
        sourceId: SOURCE_ID,
        statusCode: 403,
      },
    };
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const kind =
      response.status === 401
        ? "auth"
        : response.status === 429
          ? "rate_limit"
          : response.status >= 500
            ? "upstream_5xx"
            : "network";
    return {
      status: "failed",
      error: {
        kind,
        provider: "opencodego",
        sourceId: SOURCE_ID,
        statusCode: response.status,
      },
    };
  }

  const body: unknown = await response.json();
  if (!isRecord(body) || !isRecord(body["usage"])) {
    return {
      status: "failed",
      error: { kind: "schema", provider: "opencodego", sourceId: SOURCE_ID },
    };
  }

  const usage = body["usage"] as Record<string, unknown>;
  const periods = ["rolling", "weekly", "monthly"] as const;
  const windows: ProviderResult["windows"] = [];

  try {
    for (const period of periods) {
      const raw = usage[period];
      if (raw === undefined) {
        throw new Error(`usage.${period} is required`);
      }
      const parsed = parseWindow(raw, period);
      windows.push({
        period,
        usageRatio: parsed.usageRatio,
        resetTimestampSeconds: parsed.resetTimestampSeconds,
        exceeded: parsed.exceeded,
      });
    }
  } catch (err) {
    return {
      status: "failed",
      error: {
        kind: "schema",
        provider: "opencodego",
        sourceId: SOURCE_ID,
        statusCode: 200,
      },
    };
  }

  const result: ProviderResult = {
    provider: "opencodego",
    sources: [{ id: SOURCE_ID, supportLevel: "official-internal", role: "primary" }],
    windows,
  };
  return { status: "success", result };
}
```

- [ ] **Step 3: Implement `opencodego/index.ts` adapter entry**

Create `workers/src/provider-metrics/opencodego/index.ts`:

```ts
import type { AdapterOutcome, ProviderAdapter } from "../types";
import { fetchOpenCodeGoUsageApi } from "./api-key";

export const openCodeGoAdapter: ProviderAdapter = async (env, ctx): Promise<AdapterOutcome> => {
  const apiKey = env.OPENCODEGO_API_KEY?.trim();
  if (!apiKey) {
    return {
      status: "failed",
      error: {
        kind: "auth",
        provider: "opencodego",
        sourceId: "opencodego-usage-api",
      },
    };
  }
  return fetchOpenCodeGoUsageApi(apiKey, ctx.fetchFn);
};
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/provider-metrics/opencodego-api-key.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/src/provider-metrics/opencodego workers/tests/provider-metrics/opencodego-api-key.test.ts
git commit -m "feat(provider-metrics): OpenCode Go /zen/go/v1/usage API key adapter を追加"
```

---

## Task 6: Implement OpenCodeGo Zen balance enrichment

**Files:**
- Create: `workers/src/provider-metrics/opencodego/zen-balance.ts`
- Create: `workers/tests/provider-metrics/opencodego-zen-balance.test.ts`
- Modify: `workers/src/provider-metrics/opencodego/index.ts`

**Interfaces:**
- Consumes: `OPENCODEGO_SESSION_COOKIE`, `OPENCODEGO_WORKSPACE_ID`, `ProviderContext`.
- Produces: `Promise<number | null>` for Zen balance USD.

- [ ] **Step 1: Write the failing test**

Create `workers/tests/provider-metrics/opencodego-zen-balance.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { fetchZenBalanceEnrichment } from "../../src/provider-metrics/opencodego/zen-balance";

const WORKSPACE_HTML = `<script>["wrk_zen123"]</script>`;
const BILLING_HTML = `{"zenBalance":2345000000}`;

describe("fetchZenBalanceEnrichment", () => {
  it("returns balance when cookie is configured", async () => {
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) return new Response(WORKSPACE_HTML, { status: 200 });
      return new Response(BILLING_HTML, { status: 200 });
    });
    const balance = await fetchZenBalanceEnrichment("session=abc", undefined, mockFetch);
    expect(balance).toBeCloseTo(23.45);
  });

  it("returns null when cookie is missing", async () => {
    const balance = await fetchZenBalanceEnrichment(undefined, undefined, fetch);
    expect(balance).toBeNull();
  });
});
```

Run: `npx vitest run tests/provider-metrics/opencodego-zen-balance.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 2: Extract and adapt Zen balance logic**

Create `workers/src/provider-metrics/opencodego/zen-balance.ts`:

```ts
import { fetchOpenCodeGoMetrics } from "../opencodego";

export async function fetchZenBalanceEnrichment(
  sessionCookie: string | undefined,
  workspaceIdOverride: string | undefined,
  fetchFn: typeof fetch,
): Promise<number | null> {
  if (!sessionCookie || sessionCookie.trim().length === 0) {
    return null;
  }
  try {
    const result = await fetchOpenCodeGoMetrics(sessionCookie, workspaceIdOverride, fetchFn);
    return result.zenBalanceUSD;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Wire enrichment into `opencodego/index.ts`**

Modify `workers/src/provider-metrics/opencodego/index.ts`:

```ts
import type { AdapterOutcome, ProviderAdapter } from "../types";
import { fetchOpenCodeGoUsageApi } from "./api-key";
import { fetchZenBalanceEnrichment } from "./zen-balance";

export const openCodeGoAdapter: ProviderAdapter = async (env, ctx): Promise<AdapterOutcome> => {
  const apiKey = env.OPENCODEGO_API_KEY?.trim();
  if (!apiKey) {
    return {
      status: "failed",
      error: {
        kind: "auth",
        provider: "opencodego",
        sourceId: "opencodego-usage-api",
      },
    };
  }
  const outcome = await fetchOpenCodeGoUsageApi(apiKey, ctx.fetchFn);
  if (outcome.status !== "success") {
    return outcome;
  }

  const balance = await fetchZenBalanceEnrichment(
    env.OPENCODEGO_SESSION_COOKIE,
    env.OPENCODEGO_WORKSPACE_ID,
    ctx.fetchFn,
  );
  if (balance !== null) {
    outcome.result.credits = { ...outcome.result.credits, remaining: balance };
    outcome.result.sources.push({
      id: "opencodego-zen-rpc",
      supportLevel: "web-internal",
      role: "enrichment",
    });
  }
  return outcome;
};
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/provider-metrics/opencodego-zen-balance.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/src/provider-metrics/opencodego workers/tests/provider-metrics/opencodego-zen-balance.test.ts
git commit -m "feat(provider-metrics): OpenCode Go Zen balance enrichment を追加"
```

---

## Task 7: Implement Ollama Cloud API-key adapter

**Files:**
- Create: `workers/src/provider-metrics/ollama/api-usage.ts`
- Create: `workers/tests/provider-metrics/ollama-api-usage.test.ts`

**Interfaces:**
- Consumes: `OLLAMA_API_KEY`, `ProviderContext`.
- Produces: `Promise<Partial<ProviderResult>>` with primary quota/activity content; returns `null` if no primary content is usable.

- [ ] **Step 1: Write the failing test**

Create `workers/tests/provider-metrics/ollama-api-usage.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { fetchOllamaApiUsage } from "../../src/provider-metrics/ollama/api-usage";

describe("fetchOllamaApiUsage", () => {
  it("returns primary result from limits and activity", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          limits: {
            session: { usage: 0.03, models: [{ name: "glm-5.3-flash", request_count: 54 }] },
            weekly: { usage: 0.005, models: [{ name: "glm-5.3-flash", request_count: 458 }] },
          },
          activity: { cost: "12.34000", period: { type: "last_4_weeks" }, models: [] },
        }),
        { status: 200 },
      ),
    );
    const result = await fetchOllamaApiUsage("key", mockFetch);
    expect(result).not.toBeNull();
    expect(result!.windows).toHaveLength(2);
    expect(result!.windows[0]).toMatchObject({ period: "session", usageRatio: 0.03 });
    expect(result!.usage).toMatchObject({ costUSD: 12.34 });
  });

  it("returns null when neither limits nor activity are present", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const result = await fetchOllamaApiUsage("key", mockFetch);
    expect(result).toBeNull();
  });
});
```

Run: `npx vitest run tests/provider-metrics/ollama-api-usage.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 2: Implement `api-usage.ts`**

Create `workers/src/provider-metrics/ollama/api-usage.ts`:

```ts
import { getWithRetry } from "../../http-retry";
import type { ProviderResult, QuotaWindow } from "../types";

const USAGE_URL = "https://ollama.com/api/usage";
const TIMEOUT_MS = 10000;
const SOURCE_ID = "ollama-api-usage";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidModelName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return false;
  if (name !== trimmed) return false;
  return /^[A-Za-z0-9._:/-]+$/.test(name);
}

function parseUsageRatio(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  if (value < 0 || value > 1) {
    throw new Error(`${path} must be between 0 and 1`);
  }
  return value;
}

function parseRequestCount(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  return value;
}

interface ModelEntry {
  name: string;
  requestCount: number;
}

function parseModels(value: unknown, path: string): ModelEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ModelEntry[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!isRecord(item)) continue;
    const name = item["name"];
    if (typeof name !== "string" || !isValidModelName(name)) continue;
    try {
      const requestCount = parseRequestCount(item["request_count"], `${path}[${i}].request_count`);
      entries.push({ name, requestCount });
    } catch {
      continue;
    }
  }
  return entries;
}

function aggregateModels(entries: ModelEntry[]): ModelEntry[] {
  const map = new Map<string, number>();
  for (const entry of entries) {
    map.set(entry.name, (map.get(entry.name) ?? 0) + entry.requestCount);
  }
  return [...map.entries()].map(([name, requestCount]) => ({ name, requestCount }));
}

interface LimitContent {
  windows: QuotaWindow[];
  modelMetrics: { period: "session" | "weekly"; model: string; requestCount: number }[];
}

function parseLimits(value: unknown): LimitContent {
  const windows: QuotaWindow[] = [];
  const modelMetrics: LimitContent["modelMetrics"] = [];
  if (!isRecord(value)) return { windows, modelMetrics };

  for (const [wirePeriod, canonical] of [
    ["session", "session"],
    ["weekly", "weekly"],
  ] as [string, "session" | "weekly"][]) {
    const raw = value[wirePeriod];
    if (!isRecord(raw)) continue;
    const usage = parseUsageRatio(raw["usage"], `limits.${wirePeriod}.usage`);
    windows.push({ period: canonical, usageRatio: usage });
    const models = parseModels(raw["models"], `limits.${wirePeriod}.models`);
    for (const entry of aggregateModels(models)) {
      modelMetrics.push({ period: canonical, model: entry.name, requestCount: entry.requestCount });
    }
  }

  return { windows, modelMetrics };
}

function parseActivityCost(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

export interface OllamaApiUsageResult {
  result: ProviderResult;
  sourceId: string;
}

export async function fetchOllamaApiUsage(
  apiKey: string,
  fetchFn: typeof fetch,
): Promise<ProviderResult | null> {
  const response = await getWithRetry({
    url: USAGE_URL,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    fetchFn,
    logLabel: "Ollama Cloud API usage",
    isRetryableStatus: (status) => status === 429 || status >= 500,
    perAttemptTimeoutMs: TIMEOUT_MS,
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new OllamaApiError(response.status);
  }

  const body: unknown = await response.json();
  if (!isRecord(body)) return null;

  const { windows, modelMetrics } = parseLimits(body["limits"]);
  const activityCost = isRecord(body["activity"])
    ? parseActivityCost(body["activity"]["cost"])
    : undefined;

  if (windows.length === 0 && activityCost === undefined) {
    return null;
  }

  const result: ProviderResult = {
    provider: "ollama_cloud",
    sources: [{ id: SOURCE_ID, supportLevel: "official-internal", role: "primary" }],
    windows,
  };

  if (activityCost !== undefined) {
    result.usage = { costUSD: activityCost };
  }

  return result;
}

export class OllamaApiError extends Error {
  constructor(readonly statusCode: number) {
    super(`Ollama API usage request failed: HTTP ${statusCode}`);
  }
}
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run tests/provider-metrics/ollama-api-usage.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add workers/src/provider-metrics/ollama workers/tests/provider-metrics/ollama-api-usage.test.ts
git commit -m "feat(provider-metrics): Ollama Cloud /api/usage JSON adapter を追加"
```

---

## Task 8: Implement Ollama HTML fallback/enrichment and adapter entry

**Files:**
- Create: `workers/src/provider-metrics/ollama/settings-html.ts`
- Modify: `workers/src/provider-metrics/ollama.ts` → move to `ollama/settings-html.ts`
- Create: `workers/src/provider-metrics/ollama/index.ts`
- Create: `workers/tests/provider-metrics/ollama-settings-html.test.ts`

**Interfaces:**
- Consumes: `OLLAMA_SESSION_COOKIE`, `ProviderContext`.
- Produces: `AdapterOutcome` combining JSON primary and HTML fallback/enrichment.

- [ ] **Step 1: Write the failing test**

Create `workers/tests/provider-metrics/ollama-settings-html.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { fetchOllamaSettingsHtml } from "../../src/provider-metrics/ollama/settings-html";

const HTML = `<html><body><span>Cloud Usage</span><span>Pro</span><h3>Session usage</h3><div style="width: 25%">25% used</div><span data-time="2026-08-19T06:00:00Z"></span><h3>Weekly usage</h3><div style="width: 12%">12% used</div><span data-time="2026-08-25T00:00:00Z"></span></body></html>`;

describe("fetchOllamaSettingsHtml", () => {
  it("parses session and weekly from HTML", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(HTML, { status: 200 }));
    const result = await fetchOllamaSettingsHtml("cookie", mockFetch);
    expect(result).not.toBeNull();
    expect(result!.plan).toBe("Pro");
    expect(result!.windows).toHaveLength(2);
  });

  it("returns null for empty cookie", async () => {
    const result = await fetchOllamaSettingsHtml("", fetch);
    expect(result).toBeNull();
  });
});
```

Run: `npx vitest run tests/provider-metrics/ollama-settings-html.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 2: Move HTML parser to `ollama/settings-html.ts`**

Create `workers/src/provider-metrics/ollama/settings-html.ts` by copying the HTML parsing functions from `workers/src/provider-metrics/ollama.ts` and wrapping them in:

```ts
import { getWithRetry } from "../../http-retry";
import type { ProviderResult, QuotaWindow } from "../types";

const OLLAMA_SETTINGS_URL = "https://ollama.com/settings";
const SOURCE_ID = "ollama-settings-html";

// ... existing helpers: firstCapture, parsePlanName, parsePercent, parseISODateSeconds, etc.

export async function fetchOllamaSettingsHtml(
  sessionCookie: string | undefined,
  fetchFn: typeof fetch,
): Promise<ProviderResult | null> {
  if (!sessionCookie || sessionCookie.trim().length === 0) return null;

  const trimmedCookie = sessionCookie.trim();
  const cookieHeader = trimmedCookie.includes("=")
    ? trimmedCookie
    : `ollama_session=${trimmedCookie}; wos-session=${trimmedCookie}`;

  const response = await getWithRetry({
    url: OLLAMA_SETTINGS_URL,
    headers: {
      Cookie: cookieHeader,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    },
    logLabel: "Ollama Cloud settings HTML",
    isRetryableStatus: (status) => status === 429 || status >= 500,
    fetchFn,
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }

  const html = await response.text();
  const sessionBlock = parseUsageBlockWithLabels(["Session usage", "Hourly usage"], html);
  const weeklyBlock = parseUsageBlock("Weekly usage", html);

  if (sessionBlock === null && weeklyBlock === null) {
    return null;
  }

  const windows: QuotaWindow[] = [];
  if (sessionBlock) {
    windows.push({
      period: "session",
      usageRatio: sessionBlock.usedPercent / 100,
      resetTimestampSeconds: sessionBlock.resetTimestampSeconds,
    });
  }
  if (weeklyBlock) {
    windows.push({
      period: "weekly",
      usageRatio: weeklyBlock.usedPercent / 100,
      resetTimestampSeconds: weeklyBlock.resetTimestampSeconds,
    });
  }

  const plan = parsePlanName(html);
  const result: ProviderResult = {
    provider: "ollama_cloud",
    sources: [{ id: SOURCE_ID, supportLevel: "scraping", role: "fallback" }],
    windows,
  };
  if (plan) result.plan = plan;
  return result;
}
```

- [ ] **Step 3: Delete the old `ollama.ts` adapter**

`workers/src/provider-metrics/ollama.ts` will be removed; the existing `ollama.test.ts` should be replaced/updated later.

- [ ] **Step 4: Implement `ollama/index.ts` adapter entry**

Create `workers/src/provider-metrics/ollama/index.ts`:

```ts
import type { AdapterOutcome, ProviderAdapter, ProviderResult } from "../types";
import { fetchOllamaApiUsage, OllamaApiError } from "./api-usage";
import { fetchOllamaSettingsHtml } from "./settings-html";

function mergeApiAndHtml(apiResult: ProviderResult, htmlResult: ProviderResult): ProviderResult {
  const merged: ProviderResult = {
    ...apiResult,
    sources: [...apiResult.sources],
  };

  if (htmlResult.plan && !merged.plan) {
    merged.plan = htmlResult.plan;
  }
  for (const window of htmlResult.windows) {
    const existing = merged.windows.find((w) => w.period === window.period);
    if (!existing) {
      merged.windows.push(window);
    } else if (existing.resetTimestampSeconds === undefined && window.resetTimestampSeconds !== undefined) {
      existing.resetTimestampSeconds = window.resetTimestampSeconds;
    }
  }

  merged.sources.push({
    id: "ollama-settings-html",
    supportLevel: "scraping",
    role: "enrichment",
  });
  return merged;
}

export const ollamaAdapter: ProviderAdapter = async (env, ctx): Promise<AdapterOutcome> => {
  const apiKey = env.OLLAMA_API_KEY?.trim();
  if (!apiKey) {
    return {
      status: "failed",
      error: {
        kind: "auth",
        provider: "ollama_cloud",
        sourceId: "ollama-api-usage",
      },
    };
  }

  let apiResult: ProviderResult | null = null;
  let apiStatusCode: number | undefined;
  try {
    apiResult = await fetchOllamaApiUsage(apiKey, ctx.fetchFn);
  } catch (err) {
    apiStatusCode = err instanceof OllamaApiError ? err.statusCode : undefined;
  }

  const htmlResult = await fetchOllamaSettingsHtml(env.OLLAMA_SESSION_COOKIE, ctx.fetchFn);

  if (apiResult) {
    if (htmlResult && (htmlResult.plan || htmlResult.windows.length > 0)) {
      return { status: "success", result: mergeApiAndHtml(apiResult, htmlResult) };
    }
    return { status: "success", result: apiResult };
  }

  if (htmlResult && (htmlResult.windows.length > 0 || htmlResult.plan)) {
    htmlResult.sources = [{ id: "ollama-settings-html", supportLevel: "scraping", role: "fallback" }];
    return { status: "success", result: htmlResult };
  }

  const kind =
    apiStatusCode === 401
      ? "auth"
      : apiStatusCode === 403
        ? "forbidden"
        : apiStatusCode === 429
          ? "rate_limit"
          : apiStatusCode !== undefined && apiStatusCode >= 500
            ? "upstream_5xx"
            : "network";
  return {
    status: "failed",
    error: {
      kind,
      provider: "ollama_cloud",
      sourceId: "ollama-api-usage",
      statusCode: apiStatusCode,
    },
  };
};
```

- [ ] **Step 5: Update old Ollama tests**

Rename `workers/tests/provider-metrics/ollama.test.ts` to `workers/tests/provider-metrics/ollama-settings-html.test.ts` and update imports. The test from Step 1 already covers the new module; extend it with the existing cases for Free plan and signed-out HTML.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/provider-metrics/ollama-settings-html.test.ts tests/provider-metrics/ollama-api-usage.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS (old `ollama.ts` import failures remain until orchestrator is updated).

- [ ] **Step 7: Commit**

```bash
git add workers/src/provider-metrics/ollama workers/tests/provider-metrics/ollama-settings-html.test.ts workers/tests/provider-metrics/ollama-api-usage.test.ts workers/tests/provider-metrics/ollama.test.ts
git rm workers/src/provider-metrics/ollama.ts
git commit -m "feat(provider-metrics): Ollama Cloud HTML fallback/enrichment と adapter entry を追加"
```

---

## Task 9: Implement CommandCode adapter

**Files:**
- Create: `workers/src/provider-metrics/commandcode/billing.ts`
- Create: `workers/src/provider-metrics/commandcode/index.ts`
- Create: `workers/tests/provider-metrics/commandcode.test.ts`

**Interfaces:**
- Consumes: `COMMAND_CODE_API_KEY`, `ProviderContext`.
- Produces: `AdapterOutcome` for `commandcode`.

- [ ] **Step 1: Write the failing test**

Create `workers/tests/provider-metrics/commandcode.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { commandCodeAdapter } from "../../src/provider-metrics/commandcode";

describe("commandCodeAdapter", () => {
  it("returns success with quota, credits, plan, and usage", async () => {
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      call++;
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("/alpha/whoami")) {
        return new Response(JSON.stringify({ org: { id: "org_123", login: "x" } }), { status: 200 });
      }
      if (url.includes("/alpha/billing/credits")) {
        return new Response(
          JSON.stringify({
            credits: { monthlyCredits: 70, purchasedCredits: 5, freeCredits: 0 },
            windowLimits: {
              limited: true,
              fiveHour: { used: 0.57, cap: 14, resetAt: 1_789_923_600_000 },
              weekly: { used: 0.57, cap: 35, resetAt: 1_790_355_600_000 },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/alpha/billing/subscriptions")) {
        return new Response(
          JSON.stringify({
            data: {
              planId: "individual-go",
              status: "active",
              currentPeriodStart: "2026-09-01T00:00:00Z",
              currentPeriodEnd: "2026-10-01T00:00:00Z",
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/alpha/usage/summary")) {
        return new Response(
          JSON.stringify({ totalCost: 0.57, totalCount: 45, totalTokens: 3_100_000 }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const outcome = await commandCodeAdapter(
      { COMMAND_CODE_API_KEY: "key" } as never,
      { fetchFn: mockFetch, scheduledTimeSeconds: 1_000, nowSeconds: () => 1_000 },
    );

    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("unexpected");
    expect(outcome.result.windows).toHaveLength(2);
    expect(outcome.result.credits).toMatchObject({ remaining: 75, monthly: 70, purchased: 5, free: 0 });
    expect(outcome.result.plan).toBe("individual-go");
    expect(outcome.result.usage).toMatchObject({ costUSD: 0.57, requests: 45, tokens: 3_100_000 });
  });
});
```

Run: `npx vitest run tests/provider-metrics/commandcode.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 2: Implement `billing.ts`**

Create `workers/src/provider-metrics/commandcode/billing.ts`:

```ts
import { getWithRetry } from "../../http-retry";
import type { ProviderResult, QuotaWindow } from "../types";

const BASE_URL = "https://api.commandcode.ai";
const TIMEOUT_MS = 10000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFiniteNonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative finite number`);
  }
  return value;
}

function parseFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function parseBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function parseIsoTimestampSeconds(value: unknown, path: string): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  return Math.floor(ms / 1000);
}

function parseResetTimestampSeconds(value: unknown, path: string): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  if (value >= 1e12) return Math.floor(value / 1000);
  return Math.floor(value);
}

async function getJson(
  path: string,
  apiKey: string,
  fetchFn: typeof fetch,
): Promise<unknown> {
  const response = await getWithRetry({
    url: `${BASE_URL}${path}`,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    fetchFn,
    logLabel: `CommandCode ${path}`,
    isRetryableStatus: (status) => status === 429 || status >= 500,
    perAttemptTimeoutMs: TIMEOUT_MS,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new CommandCodeHttpError(response.status);
  }
  return response.json();
}

export class CommandCodeHttpError extends Error {
  constructor(readonly statusCode: number) {
    super(`CommandCode HTTP ${statusCode}`);
  }
}

export interface CommandCodeFetchResult {
  result: ProviderResult;
  sourceIds: { credits: string; subscriptions?: string; summary?: string };
}

export async function fetchCommandCodeResult(
  apiKey: string,
  fetchFn: typeof fetch,
): Promise<CommandCodeFetchResult> {
  const whoami: unknown = await getJson("/alpha/whoami?limits=1", apiKey, fetchFn);
  if (!isRecord(whoami) || !isRecord(whoami["org"])) {
    throw new Error("whoami.org is required");
  }
  const orgId = whoami["org"]["id"];
  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new Error("whoami.org.id must be a non-empty string");
  }

  const [creditsRaw, subscriptionsRaw] = await Promise.all([
    getJson(`/alpha/billing/credits?orgId=${encodeURIComponent(orgId)}`, apiKey, fetchFn),
    getJson(`/alpha/billing/subscriptions?orgId=${encodeURIComponent(orgId)}`, apiKey, fetchFn).catch(
      () => undefined,
    ),
  ]);

  const result: ProviderResult = {
    provider: "commandcode",
    sources: [{ id: "commandcode-billing-credits", supportLevel: "official-internal", role: "primary" }],
    windows: [],
  };

  // credits
  if (!isRecord(creditsRaw) || !isRecord(creditsRaw["credits"])) {
    throw new Error("credits object is required");
  }
  const creditsObj = creditsRaw["credits"] as Record<string, unknown>;
  const monthlyCredits = parseFiniteNonNegativeNumber(
    creditsObj["monthlyCredits"],
    "credits.monthlyCredits",
  );
  result.credits = { monthly: monthlyCredits };
  let remaining = monthlyCredits;
  if (creditsObj["purchasedCredits"] !== undefined) {
    const purchased = parseFiniteNonNegativeNumber(
      creditsObj["purchasedCredits"],
      "credits.purchasedCredits",
    );
    result.credits.purchased = purchased;
    remaining += purchased;
  }
  if (creditsObj["freeCredits"] !== undefined) {
    const free = parseFiniteNonNegativeNumber(creditsObj["freeCredits"], "credits.freeCredits");
    result.credits.free = free;
    remaining += free;
  }
  result.credits.remaining = remaining;

  // windowLimits
  if (isRecord(creditsRaw["windowLimits"])) {
    const windowLimits = creditsRaw["windowLimits"] as Record<string, unknown>;
    let limited: boolean;
    try {
      limited = parseBoolean(windowLimits["limited"], "windowLimits.limited");
    } catch {
      limited = false;
    }
    if (limited) {
      const windows: QuotaWindow[] = [];
      for (const [wireKey, period] of [
        ["fiveHour", "session"],
        ["weekly", "weekly"],
      ] as [string, "session" | "weekly"][]) {
        const raw = windowLimits[wireKey];
        if (!isRecord(raw)) {
          throw new Error(`windowLimits.${wireKey} is required when limited=true`);
        }
        const used = parseFiniteNonNegativeNumber(raw["used"], `windowLimits.${wireKey}.used`);
        const cap = parseFiniteNonNegativeNumber(raw["cap"], `windowLimits.${wireKey}.cap`);
        if (cap === 0) {
          throw new Error(`windowLimits.${wireKey}.cap must be > 0`);
        }
        const rawRatio = used / cap;
        const usageRatio = Math.min(rawRatio, 1);
        windows.push({
          period,
          used,
          limit: cap,
          usageRatio,
          exceeded: used >= cap,
          resetTimestampSeconds: parseResetTimestampSeconds(
            raw["resetAt"],
            `windowLimits.${wireKey}.resetAt`,
          ),
        });
      }
      result.windows = windows;
    }
  }

  const sourceIds: CommandCodeFetchResult["sourceIds"] = {
    credits: "commandcode-billing-credits",
  };

  // subscriptions
  let since: string | undefined;
  if (subscriptionsRaw !== undefined && isRecord(subscriptionsRaw)) {
    const data = subscriptionsRaw["data"];
    if (isRecord(data)) {
      const planId =
        typeof data["planId"] === "string" && data["planId"].length > 0
          ? data["planId"]
          : undefined;
      const status =
        typeof data["status"] === "string" && data["status"].length > 0
          ? data["status"]
          : undefined;
      const currentPeriodStart = parseIsoTimestampSeconds(
        data["currentPeriodStart"],
        "data.currentPeriodStart",
      );
      const currentPeriodEnd = parseIsoTimestampSeconds(
        data["currentPeriodEnd"],
        "data.currentPeriodEnd",
      );
      if (planId) result.plan = planId;
      if (status || currentPeriodEnd) {
        result.subscription = { status, billingPeriodEndSeconds: currentPeriodEnd };
      }
      if (typeof data["currentPeriodStart"] === "string" && currentPeriodStart !== undefined) {
        since = data["currentPeriodStart"] as string;
      }
      sourceIds.subscriptions = "commandcode-billing-subscriptions";
    }
  }

  // usage summary
  const summaryPath = since
    ? `/alpha/usage/summary?orgId=${encodeURIComponent(orgId)}&since=${encodeURIComponent(since)}`
    : `/alpha/usage/summary?orgId=${encodeURIComponent(orgId)}`;
  try {
    const summaryRaw: unknown = await getJson(summaryPath, apiKey, fetchFn);
    if (isRecord(summaryRaw)) {
      const usage: ProviderResult["usage"] = {};
      if (summaryRaw["totalCost"] !== undefined) {
        usage.costUSD = parseFiniteNonNegativeNumber(summaryRaw["totalCost"], "totalCost");
      }
      if (summaryRaw["totalCount"] !== undefined) {
        usage.requests = parseFiniteNonNegativeNumber(summaryRaw["totalCount"], "totalCount");
      }
      if (summaryRaw["totalTokens"] !== undefined) {
        const tokens = parseFiniteNumber(summaryRaw["totalTokens"], "totalTokens");
        if (tokens >= 0 && Number.isInteger(tokens)) usage.tokens = tokens;
      }
      if (Object.keys(usage).length > 0) {
        result.usage = usage;
        sourceIds.summary = "commandcode-usage-summary";
      }
    }
  } catch {
    // summary is enrichment-only; ignore failure
  }

  return { result, sourceIds };
}
```

- [ ] **Step 3: Implement `commandcode/index.ts`**

Create `workers/src/provider-metrics/commandcode/index.ts`:

```ts
import type { AdapterOutcome, ProviderAdapter } from "../types";
import { fetchCommandCodeResult, CommandCodeHttpError } from "./billing";

export const commandCodeAdapter: ProviderAdapter = async (env, ctx): Promise<AdapterOutcome> => {
  const apiKey = env.COMMAND_CODE_API_KEY?.trim();
  if (!apiKey) {
    return {
      status: "failed",
      error: {
        kind: "auth",
        provider: "commandcode",
        sourceId: "commandcode-whoami",
      },
    };
  }

  try {
    const { result, sourceIds } = await fetchCommandCodeResult(apiKey, ctx.fetchFn);
    if (sourceIds.subscriptions) {
      result.sources.push({
        id: sourceIds.subscriptions,
        supportLevel: "official-internal",
        role: "enrichment",
      });
    }
    if (sourceIds.summary) {
      result.sources.push({
        id: sourceIds.summary,
        supportLevel: "official-internal",
        role: "enrichment",
      });
    }
    return { status: "success", result };
  } catch (err) {
    const statusCode = err instanceof CommandCodeHttpError ? err.statusCode : undefined;
    const kind =
      statusCode === 401
        ? "auth"
        : statusCode === 403
          ? "forbidden"
          : statusCode === 429
            ? "rate_limit"
            : statusCode !== undefined && statusCode >= 500
              ? "upstream_5xx"
              : err instanceof Error && err.message.includes("whoami")
                ? "schema"
                : "network";
    return {
      status: "failed",
      error: {
        kind,
        provider: "commandcode",
        sourceId: "commandcode-billing-credits",
        statusCode,
      },
    };
  }
};
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/provider-metrics/commandcode.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/src/provider-metrics/commandcode workers/tests/provider-metrics/commandcode.test.ts
git commit -m "feat(provider-metrics): CommandCode adapter を追加"
```

---

## Task 10: Refactor Codex adapter to `ProviderResult`

**Files:**
- Modify: `workers/src/provider-metrics/codex.ts`
- Modify: `workers/tests/provider-metrics/codex.test.ts`
- Modify: `workers/tests/provider-metrics/codex-validation.test.ts`

**Interfaces:**
- Consumes: `ProviderContext`, `env.CODEX_*`, `browserBinding`.
- Produces: `AdapterOutcome` for `codex`.

- [ ] **Step 1: Update Codex tests to expect `AdapterOutcome`**

Modify `workers/tests/provider-metrics/codex.test.ts` so that existing assertions check `result.status === "success"` and `result.result.windows` instead of the old `CodexFetchResult` shape.

Example update:

```ts
const outcome = await fetchCodexMetrics("token", undefined, mockFetch);
expect(outcome.status).toBe("success");
if (outcome.status !== "success") throw new Error("unexpected");
expect(outcome.result.windows).toContainEqual(
  expect.objectContaining({ period: "session", usageRatio: 0.5 }),
);
```

Run: `npx vitest run tests/provider-metrics/codex.test.ts`
Expected: FAIL because `fetchCodexMetrics` no longer returns the expected shape.

- [ ] **Step 2: Refactor `codex.ts` to return `AdapterOutcome`**

Change the signature of `fetchCodexMetrics` to:

```ts
export async function fetchCodexMetrics(
  accessToken: string,
  accountId: string | undefined,
  fetchFn: typeof fetch,
  proxyUrlOrBaseUrl?: string,
  browserBinding?: Fetcher,
  _now?: Date,
  proxySecret?: string,
): Promise<AdapterOutcome>
```

At the end of the function, return:

```ts
const result: ProviderResult = {
  provider: "codex",
  sources: [{ id: "codex-wham-usage", supportLevel: "official-internal", role: "primary" }],
  windows,
  plan: data.plan,
  credits: {
    remaining: data.creditsRemaining ?? undefined,
    ...(resetCredits
      ? { resetCredits: resetCredits.credits, resetCreditsAvailableCount: resetCredits.availableCount }
      : {}),
  },
};
return { status: "success", result };
```

When Browser Rendering fallback is used, set `result.sources = [{ id: "codex-browser-rendering", supportLevel: "web-internal", role: "fallback" }]`.

For HTTP failures other than 403 or when browserBinding is unavailable, return:

```ts
{
  status: "failed",
  error: {
    kind: response.status === 401 ? "auth" : "forbidden",
    provider: "codex",
    sourceId: "codex-wham-usage",
    statusCode: response.status,
  },
}
```

For Browser Rendering failure after 403, return:

```ts
{
  status: "failed",
  error: {
    kind: "forbidden",
    provider: "codex",
    sourceId: "codex-browser-rendering",
  },
}
```

- [ ] **Step 3: Update validation tests**

Adjust `codex-validation.test.ts` to call the new signature and unwrap `AdapterOutcome`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/provider-metrics/codex.test.ts tests/provider-metrics/codex-validation.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/src/provider-metrics/codex.ts workers/tests/provider-metrics/codex.test.ts workers/tests/provider-metrics/codex-validation.test.ts
git commit -m "refactor(provider-metrics): Codex adapter を ProviderResult に移行"
```

---

## Task 11: Refactor OpenAI adapter to `ProviderResult`

**Files:**
- Modify: `workers/src/provider-metrics/openai-api.ts`
- Modify: `workers/tests/provider-metrics/openai-api.test.ts`

**Interfaces:**
- Consumes: `ProviderContext`, `env.OPENAI_ADMIN_API_KEY`, `env.OPENAI_API_HISTORY_DAYS`.
- Produces: `AdapterOutcome` for `openai_api` with `ProviderUsageSummary` and per-model token metrics.

- [ ] **Step 1: Update OpenAI tests to expect `AdapterOutcome`**

Modify `workers/tests/provider-metrics/openai-api.test.ts` so assertions check `outcome.status === "success"` and `outcome.result.usage` / custom metric builder output.

- [ ] **Step 2: Refactor `openai-api.ts`**

Change `fetchOpenAIMetrics` to return `AdapterOutcome`. Keep existing page fetching and aggregation logic, then build:

```ts
const result: ProviderResult = {
  provider: "openai_api",
  sources: [{ id: "openai-organization-api", supportLevel: "official-public", role: "primary" }],
  windows: [],
  usage: {
    costUSD: totalCost,
    requests: totalRequests,
    tokens: totalTokens,
  },
};
return { status: "success", result };
```

Also store per-model token metrics. Since the common builder does not support per-model labels yet, extend `ProviderResult` with an optional `modelUsage` field or keep the existing `OpenAITokenMetric` shape and emit it in `prometheus.ts` under `buildProviderSpecificMetrics` for `openai_api`:

```ts
export interface ProviderModelUsage {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  requests?: number;
}
```

Add `modelUsage?: ProviderModelUsage[]` to `ProviderResult` in Task 1 before this task.

Then in `prometheus.ts` under `buildProviderSpecificMetrics`:

```ts
if (result.modelUsage) {
  for (const m of result.modelUsage) {
    const modelAttr = [attr("model", m.model)];
    if (m.inputTokens !== undefined) metrics.push(gaugeMetric(`${p}_input_tokens`, modelAttr, m.inputTokens, nowUnixNano));
    if (m.outputTokens !== undefined) metrics.push(gaugeMetric(`${p}_output_tokens`, modelAttr, m.outputTokens, nowUnixNano));
    if (m.cachedTokens !== undefined) metrics.push(gaugeMetric(`${p}_cached_tokens`, modelAttr, m.cachedTokens, nowUnixNano));
    if (m.requests !== undefined) metrics.push(gaugeMetric(`${p}_requests`, modelAttr, m.requests, nowUnixNano));
  }
}
```

For OpenAI HTTP errors, return:

```ts
{
  status: "failed",
  error: {
    kind: response.status === 401 ? "auth" : response.status === 429 ? "rate_limit" : "upstream_5xx",
    provider: "openai_api",
    sourceId: "openai-organization-api",
    statusCode: response.status,
  },
}
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run tests/provider-metrics/openai-api.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add workers/src/provider-metrics/openai-api.ts workers/src/provider-metrics/types.ts workers/src/provider-metrics/prometheus.ts workers/tests/provider-metrics/openai-api.test.ts
git commit -m "refactor(provider-metrics): OpenAI adapter を ProviderResult に移行"
```

---

## Task 12: Refactor orchestrator in `provider-metrics.ts`

**Files:**
- Modify: `workers/src/provider-metrics.ts`
- Modify: `workers/tests/provider-metrics/scheduled.test.ts`

**Interfaces:**
- Consumes: `runAdapters` from Task 4, `buildHealthMetrics` from Task 2, `buildProviderMetrics` + `pushProviderMetrics` from Task 3, all adapters from Tasks 5–11.
- Produces: `ProviderDiagnosticReport` and OTLP push.

- [ ] **Step 1: Rewrite `provider-metrics.ts`**

Replace the contents of `workers/src/provider-metrics.ts` with:

```ts
import { runAdapters } from "./provider-metrics/adapters";
import { commandCodeAdapter } from "./provider-metrics/commandcode";
import { fetchCodexMetrics } from "./provider-metrics/codex";
import { buildHealthMetrics } from "./provider-metrics/health";
import { ollamaAdapter } from "./provider-metrics/ollama";
import { openCodeGoAdapter } from "./provider-metrics/opencodego";
import { fetchOpenAIMetrics } from "./provider-metrics/openai-api";
import { pushProviderMetrics } from "./provider-metrics/prometheus";
import type { AdapterOutcome, ProviderContext, ProviderMetricsEnv, ProviderResult } from "./provider-metrics/types";

export interface ProviderMetricsWorker {
  scheduled(event: ScheduledEvent, env: ProviderMetricsEnv, ctx: ExecutionContext): Promise<void>;
  fetch?(request: Request, env: ProviderMetricsEnv, ctx: ExecutionContext): Promise<Response>;
}

export interface ProviderDiagnosticReport {
  timestamp: string;
  providers: Record<string, { status: "skipped" | "success" | "failed"; error?: string }>;
  prometheusPush: { status: "skipped" | "success" | "failed"; statusCode?: number };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function adapterOutcomeToReport(
  provider: string,
  outcome: AdapterOutcome,
): { status: "success" | "failed"; error?: string } {
  if (outcome.status === "success" || outcome.status === "empty") {
    return { status: "success" };
  }
  return { status: "failed", error: `${outcome.error.kind}:${outcome.error.sourceId}` };
}

const registry = [
  { provider: "openai_api" as const, credentialKey: "OPENAI_ADMIN_API_KEY" as const, adapter: openAiAdapter },
  { provider: "codex" as const, credentialKey: "CODEX_ACCESS_TOKEN" as const, adapter: codexAdapter },
  { provider: "opencodego" as const, credentialKey: "OPENCODEGO_API_KEY" as const, adapter: openCodeGoAdapter },
  { provider: "ollama_cloud" as const, credentialKey: "OLLAMA_API_KEY" as const, adapter: ollamaAdapter },
  { provider: "commandcode" as const, credentialKey: "COMMAND_CODE_API_KEY" as const, adapter: commandCodeAdapter },
];

function openAiAdapter(env: ProviderMetricsEnv, ctx: ProviderContext): ReturnType<typeof fetchOpenAIMetrics> {
  const rawHistoryDays = env.OPENAI_API_HISTORY_DAYS;
  const candidateHistoryDays = rawHistoryDays === undefined ? 1 : Number(rawHistoryDays);
  const historyDays =
    Number.isInteger(candidateHistoryDays) && candidateHistoryDays >= 1 && candidateHistoryDays <= 31
      ? candidateHistoryDays
      : undefined;

  if (rawHistoryDays !== undefined && historyDays === undefined) {
    console.error(
      `Provider metrics: OPENAI_API_HISTORY_DAYS="${rawHistoryDays}" は無効です。1 から 31 の整数が必要です。OpenAI fetch をスキップします。`,
    );
  }

  if (historyDays === undefined) {
    return Promise.resolve({
      status: "failed",
      error: { kind: "schema", provider: "openai_api", sourceId: "openai-organization-api" },
    });
  }

  return fetchOpenAIMetrics(env.OPENAI_ADMIN_API_KEY!, historyDays, ctx.fetchFn, ctx.scheduledTimeSeconds * 1000);
}

function codexAdapter(env: ProviderMetricsEnv, ctx: ProviderContext): ReturnType<typeof fetchCodexMetrics> {
  return fetchCodexMetrics(
    env.CODEX_ACCESS_TOKEN!,
    env.CODEX_ACCOUNT_ID,
    ctx.fetchFn,
    env.CODEX_PROXY_URL || env.CODEX_API_BASE_URL,
    ctx.browserBinding,
    new Date(ctx.scheduledTimeSeconds * 1000),
    env.CODEX_PROXY_SECRET,
  );
}

export async function collectAndPushProviderMetrics(
  env: ProviderMetricsEnv,
  scheduledTime: number = Date.now(),
): Promise<ProviderDiagnosticReport> {
  const report: ProviderDiagnosticReport = {
    timestamp: new Date(scheduledTime).toISOString(),
    providers: {},
    prometheusPush: { status: "skipped" },
  };

  const ctx: ProviderContext = {
    fetchFn: fetch,
    scheduledTimeSeconds: Math.floor(scheduledTime / 1000),
    nowSeconds: () => Math.floor(Date.now() / 1000),
    browserBinding: env.MYBROWSER,
  };

  const { outcomes, health, attempted } = await runAdapters(env, ctx, registry);

  for (const provider of registry) {
    const outcome = outcomes.find((o) =>
      o.status === "failed" ? o.error.provider === provider.provider : false,
    );
    if (outcome) {
      report.providers[provider.provider] = adapterOutcomeToReport(provider.provider, outcome);
    } else {
      report.providers[provider.provider] = { status: "skipped" };
    }
  }

  if (!attempted) {
    console.error("Provider metrics: No providers attempted (all skipped)");
    return report;
  }

  const successfulResults: ProviderResult[] = outcomes
    .filter((o): o is { status: "success"; result: ProviderResult } => o.status === "success")
    .map((o) => o.result);

  const nowUnixNano = `${Date.now()}000000`;
  const metrics = [
    ...buildProviderMetrics(successfulResults, nowUnixNano),
    ...buildHealthMetrics(health, nowUnixNano),
  ];

  const pushResult = await pushProviderMetrics(env, successfulResults);

  if (pushResult.ok) {
    report.prometheusPush = { status: "success", statusCode: pushResult.status };
  } else {
    console.error(`Provider metrics: Prometheus push failed: status=${pushResult.status}`);
    report.prometheusPush = { status: "failed", statusCode: pushResult.status };
  }

  return report;
}

const worker: ProviderMetricsWorker = {
  async scheduled(event, env, _ctx) {
    await collectAndPushProviderMetrics(env, event.scheduledTime);
  },
  async fetch(_request, env, _ctx) {
    const report = await collectAndPushProviderMetrics(env, Date.now());
    return new Response(JSON.stringify(report, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  },
};

export default worker;
```

Note: `pushProviderMetrics` currently only accepts `ProviderResult[]`; the health metrics must also be included. Update `pushProviderMetrics` in Task 3 to accept an optional second `healthMetrics` array, or merge health metrics into the OTLP payload in the orchestrator by calling `buildOtlpPayload` directly. Prefer updating `pushProviderMetrics` signature to:

```ts
export async function pushProviderMetrics(
  env: PrometheusEnv,
  results: ProviderResult[],
  healthMetrics?: Record<string, unknown>[],
  fetchFn?: typeof fetch,
): Promise<{ ok: boolean; status: number }>
```

- [ ] **Step 2: Update `pushProviderMetrics` to include health metrics**

Modify `workers/src/provider-metrics/prometheus.ts` so `buildOtlpPayload` receives both data and health metrics:

```ts
function buildOtlpPayload(
  results: ProviderResult[],
  healthMetrics: Record<string, unknown>[],
  nowUnixNano: string,
): Record<string, unknown> {
  // ... merge buildProviderMetrics(results, nowUnixNano) and healthMetrics
}

export async function pushProviderMetrics(
  env: PrometheusEnv,
  results: ProviderResult[],
  healthMetrics: Record<string, unknown>[] = [],
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  // ...
  const body = JSON.stringify(buildOtlpPayload(results, healthMetrics, nowUnixNano));
  // ...
}
```

- [ ] **Step 3: Update scheduled tests**

Rewrite `workers/tests/provider-metrics/scheduled.test.ts` to:
- Use `OPENCODEGO_API_KEY` and `OLLAMA_API_KEY` instead of session cookies where primary credentials are required.
- Keep `OPENCODEGO_SESSION_COOKIE` and `OLLAMA_SESSION_COOKIE` for fallback/enrichment tests.
- Add new provider response fixtures for `/zen/go/v1/usage`, `/api/usage`, and CommandCode endpoints.
- Assert that health metrics appear in the pushed payload.
- Assert that a health-only push occurs when all providers fail.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/provider-metrics/scheduled.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/src/provider-metrics.ts workers/src/provider-metrics/prometheus.ts workers/tests/provider-metrics/scheduled.test.ts
git commit -m "refactor(provider-metrics): orchestrator を adapter registry + health metric push に移行"
```

---

## Task 13: Final verification and documentation

**Files:**
- Modify: `docs/provider-metrics.md`
- Modify: `workers/src/provider-metrics/types.ts` (add `modelUsage` if not done in Task 11)

- [ ] **Step 1: Add `modelUsage` to `ProviderResult`**

In `workers/src/provider-metrics/types.ts`, add:

```ts
export interface ProviderModelUsage {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  requests?: number;
}
```

And add `modelUsage?: ProviderModelUsage[];` to `ProviderResult`.

- [ ] **Step 2: Update documentation**

In `docs/provider-metrics.md`, add a section listing:
- New primary credentials: `OPENCODEGO_API_KEY`, `OLLAMA_API_KEY`, `COMMAND_CODE_API_KEY`.
- Fallback/enrichment credentials: `OPENCODEGO_SESSION_COOKIE`, `OLLAMA_SESSION_COOKIE`.
- Source support levels table matching §8.7 of the spec.
- New metric names for CommandCode and scrape health.

- [ ] **Step 3: Run full CI gates**

Run:

```bash
cd workers
npm run typecheck
npm run test
npm run fmt:check
```

Expected: all pass.

Run from repo root:

```bash
make validate
```

Expected: PASS (or equivalent non-zero exit on failure; fix any issues).

- [ ] **Step 4: Commit**

```bash
git add docs/provider-metrics.md workers/src/provider-metrics/types.ts
git commit -m "docs(provider-metrics): 新 credential、metric、source support level を記載"
```

---

## Self-Review

### 1. Spec coverage

| Spec section | Implementing task |
|---|---|
| §4.1 common adapter pattern | Tasks 1, 4 |
| §4.2 internal representation (`ProviderResult`, etc.) | Task 1 |
| §4.3 adapter outcome / precedence / schema ownership | Tasks 5, 7, 8, 9, 10, 11 |
| §4.4 orchestrator flow / health-only push | Tasks 4, 12 |
| §5 file structure | All tasks |
| §6.1 OpenCode Go API-key + Zen enrichment | Tasks 5, 6 |
| §6.2 Ollama API-key + HTML fallback/enrichment | Tasks 7, 8 |
| §6.3 CommandCode | Task 9 |
| §6.4 OpenAI | Task 11 |
| §6.5 Codex + Browser Rendering fallback | Task 10 |
| §7 metric design | Tasks 2, 3, 12 |
| §8 error handling / security / label cardinality | Enforced in all adapter tasks |
| §9 config migration | Task 13 |
| §10 testing | Each task |
| §11 acceptance criteria | Verified by CI gates in Task 13 |

### 2. Placeholder scan

No placeholders remain. Every task includes concrete file paths, code blocks, test commands, and expected results.

### 3. Type consistency

- `ProviderContext.nowSeconds` is `() => number`.
- `AdapterOutcome` is a closed union.
- `QuotaWindow.period` is the closed `QuotaPeriod` set.
- `ProviderResult.sources` uses `ProviderSource` with `SourceRole`.
- `pushProviderMetrics` accepts both data and health metrics in Task 12.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-20-provider-usage-metrics-extension.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

**Which approach?**
