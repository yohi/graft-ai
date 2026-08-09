import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/provider-metrics";
import type { ProviderMetricsEnv } from "../../src/provider-metrics/types";

const baseEnv = {
  GRAFANA_CLOUD_PROMETHEUS_URL: "https://otlp-gateway-prod-us-central1.grafana.net/otlp",
  GRAFANA_CLOUD_PROMETHEUS_USERNAME: "123456",
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "token",
  OPENAI_ADMIN_API_KEY: "sk-admin-test",
  CODEX_ACCESS_TOKEN: "codex-token",
  OPENCODEGO_SESSION_COOKIE: "session=abc",
} satisfies ProviderMetricsEnv;

const openAiOnlyEnv = {
  GRAFANA_CLOUD_PROMETHEUS_URL: baseEnv.GRAFANA_CLOUD_PROMETHEUS_URL,
  GRAFANA_CLOUD_PROMETHEUS_USERNAME: baseEnv.GRAFANA_CLOUD_PROMETHEUS_USERNAME,
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: baseEnv.GRAFANA_CLOUD_ACCESS_POLICY_TOKEN,
  OPENAI_ADMIN_API_KEY: baseEnv.OPENAI_ADMIN_API_KEY,
} satisfies ProviderMetricsEnv;

const scheduledEvent = {
  scheduledTime: new Date("2026-01-01T00:00:00Z").getTime(),
  cron: "*/5 * * * *",
} as ScheduledEvent;

const ctx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

function urlOf(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

function providerResponse(input: RequestInfo | URL): Response {
  const url = urlOf(input);

  if (url.includes("api.openai.com")) {
    return new Response(JSON.stringify({ data: [], has_more: false, next_page: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("rate-limit-reset-credits")) {
    return new Response(JSON.stringify({ credits: 12, available_count: 8 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("chatgpt.com")) {
    return new Response(
      JSON.stringify({
        plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 50, reset_at: 1767268800 },
          secondary_window: { used_percent: 30, reset_at: 1767830400 },
        },
        credits: { balance: 7 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  if (url.includes("opencode.ai") && url.includes("def399")) {
    return new Response('<script>["wrk_test123"]</script>', { status: 200 });
  }
  if (url.includes("opencode.ai") && url.includes("/go")) {
    return new Response(
      '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"subscription":{"usagePercent":30,"resetInSec":3600}}}}</script>',
      { status: 200 },
    );
  }
  if (url.includes("opencode.ai")) {
    return new Response('{"zenBalance":10.0}', { status: 200 });
  }
  if (url.includes("/v1/metrics")) {
    return new Response("", { status: 200 });
  }

  throw new Error(`Unexpected URL in test: ${url}`);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("provider-metrics scheduled handler", () => {
  it("pushes provider metrics when all provider secrets are configured", async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> =>
      providerResponse(input),
    );
    vi.stubGlobal("fetch", mockFetch);

    await worker.scheduled(scheduledEvent, baseEnv, ctx);

    const prometheusCalls = mockFetch.mock.calls.filter(([input]) =>
      urlOf(input).includes("/v1/metrics"),
    );
    expect(prometheusCalls).toHaveLength(1);
  });

  it("does not push when configured providers produce no actual metrics", async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> =>
      providerResponse(input),
    );
    vi.stubGlobal("fetch", mockFetch);
    await worker.scheduled(scheduledEvent, openAiOnlyEnv, ctx);

    const prometheusCalls = mockFetch.mock.calls.filter(([input]) =>
      urlOf(input).includes("/v1/metrics"),
    );
    expect(prometheusCalls).toHaveLength(0);
  });

  it("uses the scheduled time for the OpenAI history window", async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> =>
      providerResponse(input),
    );
    vi.stubGlobal("fetch", mockFetch);
    await worker.scheduled(scheduledEvent, openAiOnlyEnv, ctx);

    const openAiCalls = mockFetch.mock.calls.filter(([input]) =>
      urlOf(input).includes("api.openai.com"),
    );
    expect(openAiCalls).toHaveLength(2);
    for (const [input] of openAiCalls) {
      const requestUrl = new URL(urlOf(input));
      expect(requestUrl.searchParams.get("start_time")).toBe("1767139200");
      expect(requestUrl.searchParams.get("end_time")).toBe("1767225600");
    }
  });

  it("skips OpenAI fetching when history days is invalid", async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> =>
      providerResponse(input),
    );
    vi.stubGlobal("fetch", mockFetch);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const invalidHistoryEnv = {
      GRAFANA_CLOUD_PROMETHEUS_URL: baseEnv.GRAFANA_CLOUD_PROMETHEUS_URL,
      GRAFANA_CLOUD_PROMETHEUS_USERNAME: baseEnv.GRAFANA_CLOUD_PROMETHEUS_USERNAME,
      GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: baseEnv.GRAFANA_CLOUD_ACCESS_POLICY_TOKEN,
      OPENAI_ADMIN_API_KEY: baseEnv.OPENAI_ADMIN_API_KEY,
      OPENAI_API_HISTORY_DAYS: "0",
    } satisfies ProviderMetricsEnv;

    await worker.scheduled(scheduledEvent, invalidHistoryEnv, ctx);

    expect(mockFetch.mock.calls.some(([input]) => urlOf(input).includes("api.openai.com"))).toBe(
      false,
    );
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("OpenAI fetch をスキップ"));
  });

  it("does not push metrics when no provider secret is configured", async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> =>
      providerResponse(input),
    );
    vi.stubGlobal("fetch", mockFetch);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const grafanaOnlyEnv = {
      GRAFANA_CLOUD_PROMETHEUS_URL: baseEnv.GRAFANA_CLOUD_PROMETHEUS_URL,
      GRAFANA_CLOUD_PROMETHEUS_USERNAME: baseEnv.GRAFANA_CLOUD_PROMETHEUS_USERNAME,
      GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: baseEnv.GRAFANA_CLOUD_ACCESS_POLICY_TOKEN,
    } satisfies ProviderMetricsEnv;

    await worker.scheduled(scheduledEvent, grafanaOnlyEnv, ctx);

    expect(mockFetch.mock.calls).toHaveLength(0);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("No metrics to push"));
  });

  it("pushes OpenCodeGo metrics when OpenAI and Codex fetches fail", async () => {
    const mockFetch = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
        const url = urlOf(input);
        if (url.includes("api.openai.com") || url.includes("chatgpt.com")) {
          return new Response("Unauthorized", { status: 401 });
        }
        return providerResponse(input);
      },
    );
    vi.stubGlobal("fetch", mockFetch);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await worker.scheduled(scheduledEvent, baseEnv, ctx);

    const prometheusCalls = mockFetch.mock.calls.filter(([input]) =>
      urlOf(input).includes("/v1/metrics"),
    );
    expect(consoleError).toHaveBeenCalled();
    expect(prometheusCalls).toHaveLength(1);

    const firstPrometheusCall = prometheusCalls[0];
    if (firstPrometheusCall === undefined) {
      throw new Error("Expected a Prometheus metrics request");
    }
    const body = firstPrometheusCall[1]?.body;
    if (typeof body !== "string") {
      throw new Error("Expected a serialized Prometheus metrics payload");
    }
    expect(body).toContain('"opencodego_usage_ratio"');
    expect(body).not.toContain('"openai_api_');
    expect(body).not.toContain('"codex_');
  });

  it("does not throw when the Prometheus push fails", async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      if (urlOf(input).includes("/v1/metrics")) {
        return new Response("Server Error", { status: 500 });
      }
      return providerResponse(input);
    });
    vi.stubGlobal("fetch", mockFetch);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(worker.scheduled(scheduledEvent, baseEnv, ctx)).resolves.toBeUndefined();

    const prometheusCalls = mockFetch.mock.calls.filter(([input]) =>
      urlOf(input).includes("/v1/metrics"),
    );
    expect(prometheusCalls.length).toBeGreaterThan(0);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("Prometheus push failed"));
  });
});
