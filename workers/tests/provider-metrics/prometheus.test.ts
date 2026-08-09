import { describe, it, expect, vi } from "vitest";
import { pushProviderMetrics } from "../../src/provider-metrics/prometheus";
import type {
  OpenAIFetchResult,
  CodexFetchResult,
  OpenCodeGoFetchResult,
} from "../../src/provider-metrics/types";

const env = {
  GRAFANA_CLOUD_PROMETHEUS_URL: "https://otlp-gateway-prod-us-central1.grafana.net/otlp",
  GRAFANA_CLOUD_PROMETHEUS_USERNAME: "123456",
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "test-token",
};

const sampleOpenAI: OpenAIFetchResult = {
  costs: [{ lineItem: "Chat Completions", costUSD: 0.42 }],
  tokens: [
    { model: "gpt-4o", inputTokens: 1000, outputTokens: 500, cachedTokens: 100, requests: 10 },
  ],
};

const sampleCodex: CodexFetchResult = {
  sessionUsageRatio: 0.45,
  weeklyUsageRatio: 0.2,
  sessionResetTimestampSeconds: 1700010000,
  weeklyResetTimestampSeconds: 1700100000,
  creditsRemaining: 3.5,
  resetCredits: { credits: 12, availableCount: 8 },
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
    expect(names).toContain("codex_reset_credits");
    expect(names).toContain("codex_reset_credits_available_count");
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

  it("omits metrics for OpenCodeGo windows that are absent", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    const noSecondaryWindows: OpenCodeGoFetchResult = {
      ...sampleOpenCodeGo,
      weeklyUsageRatio: undefined,
      weeklyResetSeconds: undefined,
      monthlyUsageRatio: undefined,
      monthlyResetSeconds: undefined,
    };
    await pushProviderMetrics(env, { openCodeGo: noSecondaryWindows }, mockFetch);
    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics as Array<{
      name: string;
      gauge: { dataPoints: Array<{ attributes: Array<{ value: { stringValue: string } }> }> };
    }>;
    const periods = metrics
      .filter((metric) => metric.name === "opencodego_usage_ratio")
      .flatMap((metric) => metric.gauge.dataPoints[0]?.attributes ?? [])
      .map((attribute) => attribute.value.stringValue);
    expect(periods).toEqual(["rolling"]);
  });
});
