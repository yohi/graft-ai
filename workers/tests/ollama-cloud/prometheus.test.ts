import { describe, it, expect, vi } from "vitest";
import { pushMetrics } from "../../src/ollama-cloud/prometheus";
import type { ResetCalculation } from "../../src/ollama-cloud/calc";

const env = {
  GRAFANA_CLOUD_PROMETHEUS_URL: "https://otlp-gateway-prod-us-central1.grafana.net/otlp",
  GRAFANA_CLOUD_PROMETHEUS_USERNAME: "123456",
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "test-token",
};

const calc: ResetCalculation = {
  period: "session",
  intervalSeconds: 18000,
  nextResetTimestampSeconds: 18000,
  remainingSeconds: 14400,
  progressRatio: 0.2,
};

describe("pushMetrics", () => {
  it("returns ok on HTTP 200", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    const result = await pushMetrics(env, [calc], "pro", mockFetch);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("sends JSON Content-Type and Basic Auth", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    await pushMetrics(env, [calc], "pro", mockFetch);
    const call = mockFetch.mock.calls[0]!;
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe(`Basic ${btoa("123456:test-token")}`);
  });

  it("posts to the OTLP metrics endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    await pushMetrics(env, [calc], "pro", mockFetch);
    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toBe("https://otlp-gateway-prod-us-central1.grafana.net/otlp/v1/metrics");
  });

  it("retries on HTTP 429 up to 2 times", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Too Many Requests", { status: 429 }));
    const result = await pushMetrics(env, [calc], "pro", mockFetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry on HTTP 400", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Bad Request", { status: 400 }));
    const result = await pushMetrics(env, [calc], "pro", mockFetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on network failure up to 2 times", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));
    const result = await pushMetrics(env, [calc], "pro", mockFetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("includes all metric names in the payload", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    await pushMetrics(env, [calc], "pro", mockFetch);
    const call = mockFetch.mock.calls[0]!;
    const init = call[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics;
    const names = metrics.map((m: { name: string }) => m.name);
    expect(names).toContain("ollama_cloud_reset_seconds_remaining");
    expect(names).toContain("ollama_cloud_reset_timestamp_seconds");
    expect(names).toContain("ollama_cloud_reset_progress_ratio");
    expect(names).toContain("ollama_cloud_plan_info");
  });
});
