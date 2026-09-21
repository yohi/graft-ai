import { describe, expect, it, vi } from "vitest";
import { openCodeGoAdapter } from "../../src/provider-metrics/opencodego/index";
import type { ProviderContext, ProviderMetricsEnv } from "../../src/provider-metrics/types";

const URL = "https://opencode.ai/zen/go/v1/usage";
const API_KEY = "opencode-secret";
const SOURCE_ID = "opencodego-usage-api";

const validWindow = (percent: number, resetsAt: string) => ({
  status: "ok",
  percent,
  resetsAt,
});

const validBody = (): string =>
  JSON.stringify({
    usage: {
      rolling: validWindow(12, "1970-01-01T00:10:00.000Z"),
      weekly: validWindow(8, "1970-01-02T00:00:00.000Z"),
      monthly: validWindow(35, "1970-01-03T00:00:00.000Z"),
    },
  });

function env(): ProviderMetricsEnv {
  return {
    GRAFANA_CLOUD_PROMETHEUS_URL: "https://prometheus.example",
    GRAFANA_CLOUD_PROMETHEUS_USERNAME: "user",
    GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "token",
    OPENCODEGO_API_KEY: API_KEY,
  };
}

function context(fetchFn: typeof fetch): ProviderContext {
  return {
    fetchFn,
    scheduledTimeSeconds: 1_000,
    openaiHistoryDays: 1,
    nowSeconds: () => 1_000,
    monotonicNowMs: () => 0,
  };
}

function response(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OpenCode Go API-key adapter", () => {
  it("fetches the usage endpoint with the API key and builds three quota windows", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(200, validBody()));

    const outcome = await openCodeGoAdapter(env(), context(fetchFn));

    expect(fetchFn).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" },
      }),
    );
    expect(outcome).toEqual({
      status: "success",
      result: {
        provider: "opencodego",
        sources: [{ id: SOURCE_ID, supportLevel: "official-internal", role: "primary" }],
        windows: [
          {
            period: "rolling",
            usageRatio: 0.12,
            resetTimestampSeconds: 600,
            exceeded: false,
          },
          {
            period: "weekly",
            usageRatio: 0.08,
            resetTimestampSeconds: 86_400,
            exceeded: false,
          },
          {
            period: "monthly",
            usageRatio: 0.35,
            resetTimestampSeconds: 172_800,
            exceeded: false,
          },
        ],
      },
    });
  });

  it.each([
    ["rate-limited", 100],
    ["exhausted", 100],
  ])("marks %s at 100 percent as exceeded", async (status, percent) => {
    const body = JSON.stringify({
      usage: {
        rolling: { status, percent },
        weekly: validWindow(8, "1970-01-02T00:00:00.000Z"),
        monthly: validWindow(35, "1970-01-03T00:00:00.000Z"),
      },
    });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(200, body));

    const outcome = await openCodeGoAdapter(env(), context(fetchFn));

    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("expected successful usage response");
    expect(outcome.result.windows[0]).toMatchObject({
      period: "rolling",
      usageRatio: 1,
      exceeded: true,
    });
  });

  it.each([
    ["rate-limited", 99],
    ["exhausted", 0],
  ])("rejects %s below 100 percent as a schema failure", async (status, percent) => {
    const body = JSON.stringify({
      usage: {
        rolling: { status, percent },
        weekly: validWindow(8, "1970-01-02T00:00:00.000Z"),
        monthly: validWindow(35, "1970-01-03T00:00:00.000Z"),
      },
    });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(200, body));

    const outcome = await openCodeGoAdapter(env(), context(fetchFn));

    expect(outcome).toEqual({
      status: "failed",
      error: { kind: "schema", provider: "opencodego", sourceId: SOURCE_ID },
    });
  });

  it.each([
    ["missing required window", { rolling: validWindow(12, "1970-01-01T00:10:00.000Z") }],
    ["invalid percent", { rolling: { status: "ok", percent: 101 } }],
  ])("returns schema failure for %s", async (_name, usage) => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(200, JSON.stringify({ usage })));

    const outcome = await openCodeGoAdapter(env(), context(fetchFn));

    expect(outcome).toEqual({
      status: "failed",
      error: { kind: "schema", provider: "opencodego", sourceId: SOURCE_ID },
    });
  });

  it("omits only an invalid optional reset timestamp", async () => {
    const body = JSON.stringify({
      usage: {
        rolling: { status: "ok", percent: 12, resetsAt: "not-a-timestamp" },
        weekly: validWindow(8, "1970-01-02T00:00:00.000Z"),
        monthly: validWindow(35, "1970-01-03T00:00:00.000Z"),
      },
    });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(200, body));

    const outcome = await openCodeGoAdapter(env(), context(fetchFn));

    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") throw new Error("expected successful usage response");
    expect(outcome.result.windows).toEqual([
      { period: "rolling", usageRatio: 0.12, exceeded: false },
      {
        period: "weekly",
        usageRatio: 0.08,
        resetTimestampSeconds: 86_400,
        exceeded: false,
      },
      {
        period: "monthly",
        usageRatio: 0.35,
        resetTimestampSeconds: 172_800,
        exceeded: false,
      },
    ]);
  });

  it("maps invalid JSON to a parse failure", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(200, "{"));

    const outcome = await openCodeGoAdapter(env(), context(fetchFn));

    expect(outcome).toEqual({
      status: "failed",
      error: { kind: "parse", provider: "opencodego", sourceId: SOURCE_ID },
    });
  });

  it("treats a safe EntitlementError response as empty", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(403, JSON.stringify({ error: { type: "EntitlementError" } })));

    await expect(openCodeGoAdapter(env(), context(fetchFn))).resolves.toEqual({
      status: "empty",
      reason: "no-supported-window",
    });
  });

  it.each([
    [401, "auth"],
    [403, "forbidden"],
    [429, "rate_limit"],
    [500, "upstream_5xx"],
  ] as const)("maps HTTP %i to %s with the fixed source", async (status, kind) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(status, "sentinel-body"));

    const outcome = await openCodeGoAdapter(env(), context(fetchFn));

    expect(outcome).toEqual({
      status: "failed",
      error: { kind, provider: "opencodego", sourceId: SOURCE_ID, statusCode: status },
    });
  });

  it.each([
    ["network", new TypeError("network-secret")],
    ["timeout", new DOMException("timeout-secret", "TimeoutError")],
  ] as const)("preserves %s transport failures", async (kind, error) => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(error);

    const outcome = await openCodeGoAdapter(env(), context(fetchFn));

    expect(outcome).toEqual({
      status: "failed",
      error: { kind, provider: "opencodego", sourceId: SOURCE_ID },
    });
  });
});
