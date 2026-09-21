import { describe, expect, it, vi } from "vitest";
import { HttpTransportError } from "../../src/http-retry";
import { fetchOllamaApiUsage } from "../../src/provider-metrics/ollama/api-usage";
import type {
  AdapterOutcome,
  ProviderContext,
  ProviderErrorKind,
  ProviderResult,
} from "../../src/provider-metrics/types";

const URL = "https://ollama.com/api/usage";
const API_KEY = "ollama-api-secret";
const SOURCE_ID = "ollama-api-usage";
type OllamaResult = Extract<ProviderResult, { provider: "ollama_cloud" }>;

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
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

function model(name: unknown, requestCount: unknown): Record<string, unknown> {
  return { name, request_count: requestCount };
}

function expectSuccess(outcome: AdapterOutcome): OllamaResult {
  if (outcome.status !== "success" || outcome.result.provider !== "ollama_cloud") {
    throw new Error("expected an Ollama success result");
  }
  expect(outcome.result.sources).toEqual([
    { id: SOURCE_ID, supportLevel: "official-internal", role: "primary" },
  ]);
  return outcome.result;
}

function expectFailure(
  outcome: AdapterOutcome,
  kind: ProviderErrorKind,
  statusCode?: number,
): void {
  expect(outcome).toEqual({
    status: "failed",
    error: {
      kind,
      provider: "ollama_cloud",
      sourceId: SOURCE_ID,
      ...(statusCode === undefined ? {} : { statusCode }),
    },
  });
}

function limitsBody(): Record<string, unknown> {
  return {
    limits: {
      session: {
        usage: 0.03,
        models: [model("glm-5.3-flash", 3), model("glm-5.3-flash", 4)],
      },
      weekly: {
        usage: 0.005,
        models: [model("glm-5.3-flash", 2)],
      },
    },
    activity: {
      cost: "12.34000",
      period: { type: "last_4_weeks" },
      models: [model("activity-only-model", 999)],
    },
  };
}

describe("Ollama Cloud API-key adapter", () => {
  it("fetches the API endpoint and preserves independent primary contributions", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(200, JSON.stringify(limitsBody())));

    const outcome = await fetchOllamaApiUsage(API_KEY, context(fetchFn));

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" },
      }),
    );
    const result = expectSuccess(outcome);
    expect(result.windows).toEqual([
      { period: "session", usageRatio: 0.03 },
      { period: "weekly", usageRatio: 0.005 },
    ]);
    expect(result.modelRequests).toEqual([
      { period: "session", model: "glm-5.3-flash", requestCount: 7 },
      { period: "weekly", model: "glm-5.3-flash", requestCount: 2 },
    ]);
    expect(result.activityCostUSD).toBe(12.34);
  });

  it("succeeds with activity cost when the legacy limits are absent", async () => {
    const body = {
      activity: {
        cost: "1.250",
        period: { type: "last_4_weeks" },
        models: [model("ignored-activity-model", 12)],
      },
    };
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(200, JSON.stringify(body)));

    const result = expectSuccess(await fetchOllamaApiUsage(API_KEY, context(fetchFn)));
    expect(result.windows).toEqual([]);
    expect(result.activityCostUSD).toBe(1.25);
  });

  it("keeps only bounded model labels and aggregates after validation", async () => {
    const valid128 = "a".repeat(128);
    const body = {
      limits: {
        session: {
          usage: 0,
          models: [
            model("model.v1:/foo-bar", 3),
            model("model.v1:/foo-bar", 4),
            model(valid128, 5),
            model("a".repeat(129), 6),
            model(" leading", 7),
            model("trailing ", 8),
            model("internal space", 9),
            model("   ", 10),
            model("control\u0000name", 11),
            model(42, 12),
            model("Foo", 13),
            model("string-count", "14"),
          ],
        },
        weekly: {
          usage: 0.5,
          models: [model("model.v1:/foo-bar", 2), model(valid128, 1)],
        },
      },
    };
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(200, JSON.stringify(body)));

    const outcome = await fetchOllamaApiUsage(API_KEY, context(fetchFn));

    const result = expectSuccess(outcome);
    expect(result.windows).toEqual([
      { period: "session", usageRatio: 0 },
      { period: "weekly", usageRatio: 0.5 },
    ]);
    expect(result.modelRequests).toEqual([
      { period: "session", model: "model.v1:/foo-bar", requestCount: 7 },
      { period: "session", model: valid128, requestCount: 5 },
      { period: "session", model: "Foo", requestCount: 13 },
      { period: "weekly", model: "model.v1:/foo-bar", requestCount: 2 },
      { period: "weekly", model: valid128, requestCount: 1 },
    ]);
  });

  it("omits duplicate model counts whose aggregate is not a safe integer", async () => {
    const body = {
      limits: {
        session: {
          usage: 0,
          models: [
            model("overflow-model", Number.MAX_SAFE_INTEGER),
            model("overflow-model", 1),
            model("safe-model", Number.MAX_SAFE_INTEGER),
          ],
        },
      },
    };
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(200, JSON.stringify(body)));

    const outcome = await fetchOllamaApiUsage(API_KEY, context(fetchFn));

    const result = expectSuccess(outcome);
    expect(result.modelRequests).toEqual([
      { period: "session", model: "safe-model", requestCount: Number.MAX_SAFE_INTEGER },
    ]);
  });

  it("omits an invalid activity cost while preserving valid limits", async () => {
    const body = { ...limitsBody(), activity: { cost: "not-a-decimal" } };
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(200, JSON.stringify(body)));

    const outcome = await fetchOllamaApiUsage(API_KEY, context(fetchFn));

    const result = expectSuccess(outcome);
    expect(result.activityCostUSD).toBeUndefined();
  });

  it.each([
    {},
    { ignored: true },
    { limits: { monthly: { usage: 0.1 } } },
    { activity: { models: [] } },
  ])("returns a fatal schema failure for an unrecognized primary body: %j", async (body) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(200, JSON.stringify(body)));

    const outcome = await fetchOllamaApiUsage(API_KEY, context(fetchFn));

    expectFailure(outcome, "schema");
  });

  it("maps invalid JSON to a fatal parse failure without fallback interpretation", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(200, "{"));

    const outcome = await fetchOllamaApiUsage(API_KEY, context(fetchFn));

    expectFailure(outcome, "parse");
  });

  it.each([
    ["network", new HttpTransportError("network")],
    ["timeout", new HttpTransportError("timeout")],
  ] as const)("maps %s errors during a 200 body read", async (kind, error) => {
    const apiResponse = response(200, "{}");
    vi.spyOn(apiResponse, "json").mockRejectedValue(error);
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(apiResponse);

    const outcome = await fetchOllamaApiUsage(API_KEY, context(fetchFn));

    expectFailure(outcome, kind);
  });

  it("maps unexpected parser exceptions to internal without exposing the message", async () => {
    const rawError = new Error("raw-parser-secret");
    const body = Object.defineProperty({}, "limits", {
      enumerable: true,
      get: () => {
        throw rawError;
      },
    });
    const apiResponse = response(200, "{}");
    vi.spyOn(apiResponse, "json").mockResolvedValue(body);
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(apiResponse);

    const outcome = await fetchOllamaApiUsage(API_KEY, context(fetchFn));

    expectFailure(outcome, "internal");
    expect(JSON.stringify(outcome)).not.toContain(rawError.message);
  });

  it.each([
    [400, "upstream_4xx"],
    [401, "auth"],
    [403, "forbidden"],
    [429, "rate_limit"],
    [500, "upstream_5xx"],
  ] as const)("maps HTTP %i to %s without exposing response data", async (status, kind) => {
    const credential = `credential-${status}`;
    const sentinel = `sentinel-response-${status}`;
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(status, sentinel));

    const outcome = await fetchOllamaApiUsage(credential, context(fetchFn));

    expectFailure(outcome, kind, status);
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain(`Bearer ${credential}`);
  });

  it.each([
    ["network", new TypeError("network-secret")],
    ["timeout", new DOMException("timeout-secret", "TimeoutError")],
  ] as const)(
    "maps %s transport failures without exposing exception details",
    async (kind, error) => {
      const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(error);

      const outcome = await fetchOllamaApiUsage(API_KEY, context(fetchFn));

      expectFailure(outcome, kind);
      expect(JSON.stringify(outcome)).not.toContain(error.message);
      expect(JSON.stringify(outcome)).not.toContain(API_KEY);
    },
  );
});
