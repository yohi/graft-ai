import { describe, expect, it, vi } from "vitest";
import { ollamaAdapter } from "../../src/provider-metrics/ollama";
import type {
  AdapterOutcome,
  ProviderContext,
  ProviderMetricsEnv,
} from "../../src/provider-metrics/types";

const API_USAGE_BODY = JSON.stringify({
  limits: {
    session: { usage: 0.03, models: [{ name: "api-model", request_count: 3 }] },
    weekly: { usage: 0.005, models: [{ name: "api-model", request_count: 2 }] },
  },
  activity: { cost: "12.34000" },
});

const MOCK_OLLAMA_HTML_PLAN_RESET =
  '<html><body><span>Cloud Usage</span><span>Pro</span><h3>Session usage</h3><div>91% used</div><span data-time="2026-08-20T06:00:00.000Z">Resets later</span><h3>Weekly usage</h3><div>88% used</div><span data-time="2026-08-26T00:00:00.000Z">Resets later</span></body></html>';

const MOCK_OLLAMA_HTML_FALLBACK =
  '<html><body><span>Cloud Usage</span><span>Free</span><h3>Session usage</h3><div>35% used</div><span data-time="2026-08-20T06:00:00.000Z">Resets later</span><h3>Weekly usage</h3><div>12% used</div><span data-time="2026-08-26T00:00:00.000Z">Resets later</span></body></html>';

const MOCK_OLLAMA_HTML_RESET_ONLY =
  '<html><body><h3>Session usage</h3><span data-time="2026-08-20T06:00:00.000Z">Resets later</span></body></html>';

const MOCK_OLLAMA_HTML_QUOTA_ONLY = `
<html><body><h3>Session usage</h3><div>91% used</div></body></html>
`;

const MOCK_OLLAMA_HTML_SIGNED_OUT =
  '<html><body><h2>Sign in to Ollama</h2><form action="/api/auth/signin"><input type="password" name="password" /></form></body></html>';

const API_KEY = "ollama-api-secret";
const SESSION_COOKIE = "ollama-session-secret";

function response(status: number, body: string, contentType = "application/json"): Response {
  return new Response(body, { status, headers: { "Content-Type": contentType } });
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

function env(cookie = SESSION_COOKIE): ProviderMetricsEnv {
  return {
    GRAFANA_CLOUD_PROMETHEUS_URL: "https://prometheus.example",
    GRAFANA_CLOUD_PROMETHEUS_USERNAME: "user",
    GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "token",
    OLLAMA_API_KEY: API_KEY,
    OLLAMA_SESSION_COOKIE: cookie,
  };
}

function expectOllamaFailure(outcome: AdapterOutcome, kind: string, statusCode?: number): void {
  expect(outcome).toEqual({
    status: "failed",
    error: {
      kind,
      provider: "ollama_cloud",
      sourceId: "ollama-api-usage",
      ...(statusCode === undefined ? {} : { statusCode }),
    },
  });
}

describe("ollamaAdapter HTML ownership", () => {
  it("keeps API quota and activity primary while enriching plan and missing resets", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, API_USAGE_BODY))
      .mockResolvedValueOnce(response(200, MOCK_OLLAMA_HTML_PLAN_RESET, "text/html"));

    const outcome = await ollamaAdapter(env(), context(fetchFn));

    expect(outcome).toEqual({
      status: "success",
      result: {
        provider: "ollama_cloud",
        sources: [
          { id: "ollama-api-usage", supportLevel: "official-internal", role: "primary" },
          { id: "ollama-settings-html", supportLevel: "scraping", role: "enrichment" },
        ],
        windows: [
          {
            period: "session",
            usageRatio: 0.03,
            resetTimestampSeconds: Math.floor(Date.parse("2026-08-20T06:00:00.000Z") / 1000),
          },
          {
            period: "weekly",
            usageRatio: 0.005,
            resetTimestampSeconds: Math.floor(Date.parse("2026-08-26T00:00:00.000Z") / 1000),
          },
        ],
        modelRequests: [
          { period: "session", model: "api-model", requestCount: 3 },
          { period: "weekly", model: "api-model", requestCount: 2 },
        ],
        activityCostUSD: 12.34,
        plan: "Pro",
      },
    });
  });

  it("does not add HTML quota usage to an API-success result", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, API_USAGE_BODY))
      .mockResolvedValueOnce(response(200, MOCK_OLLAMA_HTML_QUOTA_ONLY, "text/html"));

    const outcome = await ollamaAdapter(env(), context(fetchFn));

    expect(outcome).toEqual({
      status: "success",
      result: expect.objectContaining({
        sources: [{ id: "ollama-api-usage", supportLevel: "official-internal", role: "primary" }],
        windows: [
          { period: "session", usageRatio: 0.03 },
          { period: "weekly", usageRatio: 0.005 },
        ],
      }),
    });
  });

  it("does not call HTML after an API 200 schema failure", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(200, JSON.stringify({})));

    const outcome = await ollamaAdapter(env(), context(fetchFn));

    expectOllamaFailure(outcome, "schema");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("replaces an API 500 failure with a complete HTML fallback", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response(500, "server error"))
        .mockResolvedValueOnce(response(500, "server error"))
        .mockResolvedValueOnce(response(500, "server error"))
        .mockResolvedValueOnce(response(200, MOCK_OLLAMA_HTML_FALLBACK, "text/html"));

      const promise = ollamaAdapter(env(), context(fetchFn));
      await vi.runAllTimersAsync();
      const outcome = await promise;

      expect(outcome).toEqual({
        status: "success",
        result: {
          provider: "ollama_cloud",
          sources: [{ id: "ollama-settings-html", supportLevel: "scraping", role: "fallback" }],
          windows: [
            {
              period: "session",
              usageRatio: 0.35,
              resetTimestampSeconds: Math.floor(Date.parse("2026-08-20T06:00:00.000Z") / 1000),
            },
            {
              period: "weekly",
              usageRatio: 0.12,
              resetTimestampSeconds: Math.floor(Date.parse("2026-08-26T00:00:00.000Z") / 1000),
            },
          ],
          modelRequests: [],
          plan: "Free",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces an API 400 failure with valid HTML and marks the source as fallback", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(400, "bad request"))
      .mockResolvedValueOnce(response(200, MOCK_OLLAMA_HTML_FALLBACK, "text/html"));

    const outcome = await ollamaAdapter(env(), context(fetchFn));

    expect(outcome).toMatchObject({
      status: "success",
      result: {
        sources: [{ id: "ollama-settings-html", supportLevel: "scraping", role: "fallback" }],
      },
    });
  });

  it("uses HTML fallback after an API body transport failure", async () => {
    const apiResponse = response(200, "{}");
    vi.spyOn(apiResponse, "json").mockRejectedValue(new TypeError("network-body-secret"));
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(apiResponse)
      .mockResolvedValueOnce(response(200, MOCK_OLLAMA_HTML_FALLBACK, "text/html"));

    const outcome = await ollamaAdapter(env(), context(fetchFn));

    expect(outcome).toMatchObject({
      status: "success",
      result: {
        sources: [{ id: "ollama-settings-html", supportLevel: "scraping", role: "fallback" }],
      },
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("preserves an API 400 failure when HTML is unavailable", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(400, "bad request"))
      .mockResolvedValueOnce(response(200, MOCK_OLLAMA_HTML_SIGNED_OUT, "text/html"));

    const outcome = await ollamaAdapter(env(), context(fetchFn));

    expectOllamaFailure(outcome, "upstream_4xx", 400);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["network", new TypeError("network-secret")],
    ["timeout", new DOMException("timeout-secret", "TimeoutError")],
  ] as const)(
    "preserves an API %s failure when there is no HTML cookie fallback",
    async (kind, error) => {
      vi.useFakeTimers();
      try {
        const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(error);
        const promise = ollamaAdapter(env(""), context(fetchFn));
        await vi.runAllTimersAsync();
        const outcome = await promise;

        expectOllamaFailure(outcome, kind);
        expect(fetchFn).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("does not add the HTML source when the API succeeds without valid enrichment", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, API_USAGE_BODY))
      .mockResolvedValueOnce(response(200, "<html><body>empty</body></html>", "text/html"));

    const outcome = await ollamaAdapter(env(), context(fetchFn));

    expect(outcome).toMatchObject({
      status: "success",
      result: {
        sources: [{ id: "ollama-api-usage", supportLevel: "official-internal", role: "primary" }],
      },
    });
  });

  it("uses an HTML reset-only window as a sufficient fallback contribution", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(400, "bad request"))
      .mockResolvedValueOnce(response(200, MOCK_OLLAMA_HTML_RESET_ONLY, "text/html"));

    const outcome = await ollamaAdapter(env(), context(fetchFn));

    expect(outcome).toEqual({
      status: "success",
      result: {
        provider: "ollama_cloud",
        sources: [{ id: "ollama-settings-html", supportLevel: "scraping", role: "fallback" }],
        windows: [
          {
            period: "session",
            resetTimestampSeconds: Math.floor(Date.parse("2026-08-20T06:00:00.000Z") / 1000),
          },
        ],
        modelRequests: [],
      },
    });
  });
});
