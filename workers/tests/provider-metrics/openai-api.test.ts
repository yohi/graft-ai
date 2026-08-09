import { describe, it, expect, vi } from "vitest";
import { fetchOpenAIMetrics } from "../../src/provider-metrics/openai-api";

// OPENAI_API_HISTORY_DAYS で指定した UTC 日数分の costs レスポンス例
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
        { object: "usage", amount: { value: 0.05, currency: "usd" }, line_item: null },
      ],
    },
  ],
  has_more: false,
  next_page: null,
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
        { object: "usage", model: null, num_model_requests: 1, input_tokens: 2, output_tokens: 3 },
      ],
    },
  ],
  has_more: false,
  next_page: null,
};

describe("fetchOpenAIMetrics", () => {
  it("returns metrics and normalizes nullable labels", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      const body = url.includes("/costs")
        ? JSON.stringify(MOCK_COSTS_RESPONSE)
        : JSON.stringify(MOCK_COMPLETIONS_RESPONSE);
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const result = await fetchOpenAIMetrics("sk-admin-test", 1, mockFetch);

    expect(result.costs).toHaveLength(3);
    expect(result.costs[0]).toEqual({ lineItem: "Chat Completions", costUSD: 0.42 });
    expect(result.costs[1]).toEqual({ lineItem: "Embeddings", costUSD: 0.1 });
    expect(result.costs[2]).toEqual({ lineItem: "Unknown", costUSD: 0.05 });

    expect(result.tokens).toHaveLength(2);
    expect(result.tokens[0]).toMatchObject({
      model: "gpt-4o",
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 100,
      requests: 10,
    });
    expect(result.tokens[1]).toMatchObject({
      model: "unknown",
      inputTokens: 2,
      outputTokens: 3,
      cachedTokens: 0,
      requests: 1,
    });
  });

  it("sends Bearer auth header", async () => {
    const mockFetch = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: [], has_more: false, next_page: null }), {
          status: 200,
        }),
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

  it("retries a transient HTTP 503 before succeeding", async () => {
    let attempts = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts === 1) return new Response("Unavailable", { status: 503 });
      return new Response(JSON.stringify({ data: [], has_more: false, next_page: null }), {
        status: 200,
      });
    });

    await fetchOpenAIMetrics("sk-admin-test", 1, mockFetch);

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("throws when a successful response has an invalid nested shape", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      const body = url.includes("/costs")
        ? {
            data: [
              {
                results: [
                  { amount: { value: "0.42", currency: "usd" }, line_item: "Chat Completions" },
                ],
              },
            ],
            has_more: false,
            next_page: null,
          }
        : { data: [], has_more: false, next_page: null };
      return new Response(JSON.stringify(body), { status: 200 });
    });

    await expect(fetchOpenAIMetrics("sk-admin-test", 1, mockFetch)).rejects.toThrow(
      /invalid OpenAI API response/i,
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid historyDays value %s",
    async (historyDays) => {
      const mockFetch = vi.fn();

      await expect(fetchOpenAIMetrics("sk-admin-test", historyDays, mockFetch)).rejects.toThrow(
        /positive integer/,
      );
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  it("aggregates results from has_more pagination", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname.endsWith("/costs") && !parsedUrl.searchParams.has("page")) {
        // costs page 1
        return new Response(
          JSON.stringify({
            data: [
              {
                start_time: 1700000000,
                end_time: 1700086400,
                results: [
                  { amount: { value: 0.1, currency: "usd" }, line_item: "Chat Completions" },
                ],
              },
            ],
            has_more: true,
            next_page: "cursor_abc",
          }),
          { status: 200 },
        );
      }
      if (
        parsedUrl.pathname.endsWith("/costs") &&
        parsedUrl.searchParams.get("page") === "cursor_abc"
      ) {
        // costs page 2
        return new Response(
          JSON.stringify({
            data: [
              {
                start_time: 1700000000,
                end_time: 1700086400,
                results: [
                  { amount: { value: 0.2, currency: "usd" }, line_item: "Chat Completions" },
                ],
              },
            ],
            has_more: false,
            next_page: null,
          }),
          { status: 200 },
        );
      }
      // completions は costs のページング状態に影響されない
      return new Response(JSON.stringify(MOCK_COMPLETIONS_RESPONSE), { status: 200 });
    });

    const result = await fetchOpenAIMetrics("sk-admin-test", 1, mockFetch);
    const chatCost = result.costs.find((c) => c.lineItem === "Chat Completions");
    expect(chatCost?.costUSD).toBeCloseTo(0.3);
    const costsUrls = mockFetch.mock.calls.flatMap((call) => {
      const url = call[0];
      return typeof url === "string" && url.includes("/costs") ? [url] : [];
    });
    expect(costsUrls).toHaveLength(2);
    expect(costsUrls[1]).toContain("page=cursor_abc");
  });

  it("throws after the 100-page pagination cap", async () => {
    let costsPages = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (!url.includes("/costs")) {
        return new Response(JSON.stringify({ data: [], has_more: false, next_page: null }), {
          status: 200,
        });
      }
      costsPages += 1;
      return new Response(
        JSON.stringify({
          data: [],
          has_more: true,
          next_page: `cursor_${costsPages}`,
        }),
        { status: 200 },
      );
    });

    await expect(fetchOpenAIMetrics("sk-admin-test", 1, mockFetch)).rejects.toThrow(
      /pagination exceeded 100 pages/,
    );
    expect(costsPages).toBe(100);
  });

  it("aggregates the configured historyDays interval", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      const parsedUrl = new URL(url);
      const bucket = parsedUrl.pathname.endsWith("/costs")
        ? {
            data: [{ results: [{ amount: { value: 0.25 }, line_item: "Chat Completions" }] }],
            has_more: false,
            next_page: null,
          }
        : {
            data: [
              {
                results: [
                  {
                    model: "gpt-4o",
                    input_tokens: 10,
                    output_tokens: 5,
                    input_cached_tokens: 1,
                    num_model_requests: 1,
                  },
                ],
              },
            ],
            has_more: false,
            next_page: null,
          };
      return new Response(JSON.stringify(bucket), { status: 200 });
    });

    await fetchOpenAIMetrics("sk-admin-test", 3, mockFetch, Date.UTC(2026, 0, 4, 12, 34, 56));

    for (const [url] of mockFetch.mock.calls as [string, RequestInit][]) {
      const parsedUrl = new URL(url);
      expect(parsedUrl.searchParams.get("start_time")).toBe("1767225600");
      expect(parsedUrl.searchParams.get("end_time")).toBe("1767484800");
    }
  });

  it("returns empty arrays when API returns no data", async () => {
    const mockFetch = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: [], has_more: false, next_page: null }), {
          status: 200,
        }),
    );
    const result = await fetchOpenAIMetrics("sk-admin-test", 1, mockFetch);
    expect(result.costs).toHaveLength(0);
    expect(result.tokens).toHaveLength(0);
  });
});
