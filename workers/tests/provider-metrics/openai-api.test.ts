import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenAIMetrics } from "../../src/provider-metrics/openai-api";
import { buildProviderMetrics } from "../../src/provider-metrics/prometheus";
import type {
  AdapterOutcome,
  ProviderContext,
  ProviderErrorKind,
  ProviderMetricsEnv,
  ProviderResult,
} from "../../src/provider-metrics/types";

const SOURCE_ID = "openai-organization-api";
const SCHEDULED_TIME_SECONDS = 1_767_528_000;

const env = {
  GRAFANA_CLOUD_PROMETHEUS_URL: "https://prometheus.example",
  GRAFANA_CLOUD_PROMETHEUS_USERNAME: "user",
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "token",
  OPENAI_ADMIN_API_KEY: "sk-admin-test",
  OPENAI_API_HISTORY_DAYS: "31",
} satisfies ProviderMetricsEnv;

function context(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    fetchFn: fetch,
    scheduledTimeSeconds: SCHEDULED_TIME_SECONDS,
    openaiHistoryDays: 1,
    nowSeconds: () => 123,
    monotonicNowMs: () => 0,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const EMPTY_PAGE = { data: [], has_more: false, next_page: null };

const MOCK_COSTS_RESPONSE = {
  object: "page",
  data: [
    {
      object: "bucket",
      start_time: 1700000000,
      end_time: 1700086400,
      results: [
        {
          object: "usage",
          amount: { value: 0.42, currency: "usd" },
          line_item: "Chat Completions",
        },
        { object: "usage", amount: { value: 0.1, currency: "usd" }, line_item: "Embeddings" },
      ],
    },
  ],
  has_more: false,
  next_page: null,
};

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
        {
          object: "usage",
          model: "gpt-4o-mini",
          num_model_requests: 0,
          input_tokens: 0,
          input_cached_tokens: 0,
          output_tokens: 0,
          input_audio_tokens: 0,
          output_audio_tokens: 0,
        },
      ],
    },
  ],
  has_more: false,
  next_page: null,
};

type FetchMock = {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  readonly mock: { readonly calls: readonly (readonly unknown[])[] };
};

function fixtureFetch(): FetchMock {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    return jsonResponse(url.includes("/costs") ? MOCK_COSTS_RESPONSE : MOCK_COMPLETIONS_RESPONSE);
  });
}

function mockAsFetch(mockFetch: FetchMock): typeof fetch {
  return (input, init) => mockFetch(input, init);
}

function successResult(outcome: AdapterOutcome): Extract<ProviderResult, { provider: "openai_api" }> {
  if (outcome.status !== "success" || outcome.result.provider !== "openai_api") {
    throw new Error("Expected OpenAI success result");
  }
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
      provider: "openai_api",
      sourceId: SOURCE_ID,
      ...(statusCode === undefined ? {} : { statusCode }),
    },
  });
}

function requestUrls(mockFetch: FetchMock): string[] {
  return mockFetch.mock.calls.map((call) => String(call[0]));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchOpenAIMetrics", () => {
  it("returns the OpenAI ProviderResult with every cost line item and model field", async () => {
    const mockFetch = fixtureFetch();

    const outcome = await fetchOpenAIMetrics(env, context({ fetchFn: mockAsFetch(mockFetch) }));

    expect(outcome).toEqual({
      status: "success",
      result: {
        provider: "openai_api",
        sources: [{ id: SOURCE_ID, supportLevel: "official-public", role: "primary" }],
        windows: [],
        costs: [
          { lineItem: "Chat Completions", costUSD: 0.42 },
          { lineItem: "Embeddings", costUSD: 0.1 },
        ],
        modelUsage: [
          {
            model: "gpt-4o",
            inputTokens: 1000,
            outputTokens: 500,
            cachedTokens: 100,
            requests: 10,
          },
          {
            model: "gpt-4o-mini",
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            requests: 0,
          },
        ],
      },
    });
  });

  it("maps costs and model usage to the existing metric names and labels", async () => {
    const mockFetch = fixtureFetch();
    const result = successResult(
      await fetchOpenAIMetrics(env, context({ fetchFn: mockAsFetch(mockFetch) })),
    );
    const metrics = buildProviderMetrics([result], "1000000000000", 1_000);

    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "openai_api_cost_usd",
          gauge: expect.objectContaining({
            dataPoints: expect.arrayContaining([
              expect.objectContaining({
                asDouble: 0.42,
                attributes: expect.arrayContaining([
                  { key: "line_item", value: { stringValue: "Chat Completions" } },
                ]),
              }),
            ]),
          }),
        }),
        expect.objectContaining({
          name: "openai_api_cost_usd",
          gauge: expect.objectContaining({
            dataPoints: expect.arrayContaining([
              expect.objectContaining({
                asDouble: 0.1,
                attributes: expect.arrayContaining([
                  { key: "line_item", value: { stringValue: "Embeddings" } },
                ]),
              }),
            ]),
          }),
        }),
        expect.objectContaining({
          name: "openai_api_input_tokens",
          gauge: expect.objectContaining({
            dataPoints: expect.arrayContaining([
              expect.objectContaining({
                asDouble: 0,
                attributes: expect.arrayContaining([
                  { key: "model", value: { stringValue: "gpt-4o-mini" } },
                ]),
              }),
            ]),
          }),
        }),
        expect.objectContaining({
          name: "openai_api_output_tokens",
          gauge: expect.objectContaining({
            dataPoints: expect.arrayContaining([
              expect.objectContaining({
                asDouble: 500,
                attributes: expect.arrayContaining([
                  { key: "model", value: { stringValue: "gpt-4o" } },
                ]),
              }),
            ]),
          }),
        }),
        expect.objectContaining({
          name: "openai_api_cached_tokens",
          gauge: expect.objectContaining({
            dataPoints: expect.arrayContaining([
              expect.objectContaining({
                asDouble: 100,
                attributes: expect.arrayContaining([
                  { key: "model", value: { stringValue: "gpt-4o" } },
                ]),
              }),
            ]),
          }),
        }),
        expect.objectContaining({
          name: "openai_api_requests",
          gauge: expect.objectContaining({
            dataPoints: expect.arrayContaining([
              expect.objectContaining({
                asDouble: 10,
                attributes: expect.arrayContaining([
                  { key: "model", value: { stringValue: "gpt-4o" } },
                ]),
              }),
            ]),
          }),
        }),
      ]),
    );
    expect(metrics.some((metric) => metric["name"] === "openai_api_usage_cost_usd")).toBe(false);
  });

  it.each([
    [1, "1767398400", "1767484800"],
    [31, "1764806400", "1767484800"],
  ] as const)(
    "uses the scheduled UTC day anchor for %s history days and ignores the raw environment value",
    async (historyDays, expectedStartTime, expectedEndTime) => {
      const mockFetch = vi.fn(async () => jsonResponse(EMPTY_PAGE));

      const outcome = await fetchOpenAIMetrics(
        env,
        context({ fetchFn: mockAsFetch(mockFetch), openaiHistoryDays: historyDays }),
      );

      expect(outcome.status).toBe("success");
      expect(requestUrls(mockFetch)).toHaveLength(2);
      for (const url of requestUrls(mockFetch)) {
        const parsedUrl = new URL(url);
        expect(parsedUrl.searchParams.get("start_time")).toBe(expectedStartTime);
        expect(parsedUrl.searchParams.get("end_time")).toBe(expectedEndTime);
      }
    },
  );

  it.each([
    [401, "auth"],
    [403, "forbidden"],
    [429, "rate_limit"],
    [500, "upstream_5xx"],
  ] as const)("maps HTTP %s to a fixed OpenAI source error", async (status, kind) => {
    const mockFetch = vi.fn(async () => new Response("sentinel response", { status }));

    const outcome = await fetchOpenAIMetrics(env, context({ fetchFn: mockAsFetch(mockFetch) }));

    expectFailure(outcome, kind, status);
  });

  it("maps an exhausted network failure to the fixed OpenAI source", async () => {
    const fetchFn: typeof fetch = async () => {
      throw new TypeError("network credential sentinel");
    };

    const outcome = await fetchOpenAIMetrics(env, context({ fetchFn }));

    expectFailure(outcome, "network");
  });

  it("maps an exhausted timeout failure to the fixed OpenAI source", async () => {
    const fetchFn: typeof fetch = async () => {
      throw new DOMException("timeout credential sentinel", "TimeoutError");
    };

    const outcome = await fetchOpenAIMetrics(env, context({ fetchFn }));

    expectFailure(outcome, "timeout");
  });

  it("maps invalid JSON to a parse failure", async () => {
    const fetchFn: typeof fetch = async () => new Response("not-json", { status: 200 });

    const outcome = await fetchOpenAIMetrics(env, context({ fetchFn }));

    expectFailure(outcome, "parse");
  });

  it("maps a missing required page field to a schema failure", async () => {
    const fetchFn: typeof fetch = async () =>
      jsonResponse({ data: [], has_more: false });

    const outcome = await fetchOpenAIMetrics(env, context({ fetchFn }));

    expectFailure(outcome, "schema");
  });

  it("maps a malformed required cost value to a schema failure", async () => {
    const fetchFn: typeof fetch = async (input) => {
      if (String(input).includes("/costs")) {
        return jsonResponse({
          data: [{ results: [{ amount: { value: "0.42" }, line_item: "Chat Completions" }] }],
          has_more: false,
          next_page: null,
        });
      }
      return jsonResponse(EMPTY_PAGE);
    };

    const outcome = await fetchOpenAIMetrics(env, context({ fetchFn }));

    expectFailure(outcome, "schema");
  });

  it("aggregates all pages without losing line items or model values", async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const parsedUrl = new URL(String(input));
      if (parsedUrl.pathname.endsWith("/costs") && !parsedUrl.searchParams.has("page")) {
        return jsonResponse({
          data: [
            {
              results: [
                { amount: { value: 0.1, currency: "usd" }, line_item: "Chat Completions" },
              ],
            },
          ],
          has_more: true,
          next_page: "cursor_abc",
        });
      }
      if (
        parsedUrl.pathname.endsWith("/costs") &&
        parsedUrl.searchParams.get("page") === "cursor_abc"
      ) {
        return jsonResponse({
          data: [
            {
              results: [{ amount: { value: 0.2, currency: "usd" }, line_item: "Embeddings" }],
            },
          ],
          has_more: false,
          next_page: null,
        });
      }
      return jsonResponse(MOCK_COMPLETIONS_RESPONSE);
    });

    const result = successResult(
      await fetchOpenAIMetrics(env, context({ fetchFn: mockAsFetch(mockFetch) })),
    );

    expect(result.costs).toEqual([
      { lineItem: "Chat Completions", costUSD: 0.1 },
      { lineItem: "Embeddings", costUSD: 0.2 },
    ]);
    expect(result.modelUsage).toEqual([
      {
        model: "gpt-4o",
        inputTokens: 1000,
        outputTokens: 500,
        cachedTokens: 100,
        requests: 10,
      },
      {
        model: "gpt-4o-mini",
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        requests: 0,
      },
    ]);
    const costsUrls = requestUrls(mockFetch).filter((url) => url.includes("/costs"));
    expect(costsUrls).toHaveLength(2);
    expect(costsUrls[1]).toContain("page=cursor_abc");
  });

  it("maps pagination exhaustion to a schema failure", async () => {
    let costsPages = 0;
    const fetchFn: typeof fetch = async (input) => {
      if (!String(input).includes("/costs")) return jsonResponse(EMPTY_PAGE);
      costsPages += 1;
      return jsonResponse({
        data: [],
        has_more: true,
        next_page: `cursor_${costsPages}`,
      });
    };

    const outcome = await fetchOpenAIMetrics(env, context({ fetchFn }));

    expectFailure(outcome, "schema");
    expect(costsPages).toBe(100);
  });

  it("returns a successful empty ProviderResult when both endpoints have no data", async () => {
    const fetchFn: typeof fetch = async () => jsonResponse(EMPTY_PAGE);

    const outcome = await fetchOpenAIMetrics(env, context({ fetchFn }));

    expect(outcome).toEqual({
      status: "success",
      result: {
        provider: "openai_api",
        sources: [{ id: SOURCE_ID, supportLevel: "official-public", role: "primary" }],
        windows: [],
        costs: [],
        modelUsage: [],
      },
    });
  });
});
