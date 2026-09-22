import { afterEach, describe, expect, it, vi } from "vitest";
// allow: SIZE_OK - Task 12 keeps its required wire-level scenario matrix in one test file.
import {
  collectAndPushProviderMetrics,
  type ProviderDiagnosticReport,
} from "../../src/provider-metrics";
import worker from "../../src/provider-metrics";
import type { ProviderMetricsEnv } from "../../src/provider-metrics/types";

const baseEnv = {
  GRAFANA_CLOUD_PROMETHEUS_URL: "https://otlp-gateway.example/otlp",
  GRAFANA_CLOUD_PROMETHEUS_USERNAME: "123456",
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "grafana-token",
} satisfies ProviderMetricsEnv;

const scheduledTimeMs = Date.parse("2026-01-01T00:00:00Z");
const openAiCredential = "openai-credential";
const codexCredential = "codex-credential";
const ollamaCredential = "ollama-credential";

type RouteProvider = "openai" | "codex" | "opencodego" | "ollama" | "commandcode";
type RouteMode = "success" | "empty" | "failure";
type RouteModes = Partial<Record<RouteProvider, RouteMode>>;
type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function env(overrides: Partial<ProviderMetricsEnv> = {}): ProviderMetricsEnv {
  return { ...baseEnv, ...overrides };
}

function urlOf(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createFetch(modes: RouteModes = {}): FetchMock {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = urlOf(input);
    if (url.includes("/v1/metrics")) return new Response("", { status: 200 });
    if (url.includes("api.openai.com")) {
      const mode = modes.openai ?? "success";
      if (mode === "failure") return new Response("openai-response-sentinel", { status: 401 });
      const result = url.includes("/costs")
        ? { line_item: "tokens", amount: { value: 1.25 } }
        : {
            model: "gpt-5",
            input_tokens: 10,
            output_tokens: 4,
            input_cached_tokens: 2,
            num_model_requests: 1,
          };
      return jsonResponse(200, {
        data: mode === "empty" ? [] : [{ results: [result] }],
        has_more: false,
        next_page: null,
      });
    }
    if (url.includes("chatgpt.com")) {
      if (modes.codex === "failure")
        return new Response("codex-response-sentinel", { status: 401 });
      if (url.includes("rate-limit-reset-credits"))
        return jsonResponse(200, { credits: 12, available_count: 8 });
      return jsonResponse(200, {
        plan_type: "pro",
        rate_limit: {
          primary_window: {
            used_percent: 50,
            reset_at: 1_767_268_800,
            limit_window_seconds: 18_000,
          },
          secondary_window: {
            used_percent: 30,
            reset_at: 1_767_830_400,
            limit_window_seconds: 604_800,
          },
        },
        credits: { balance: 7 },
      });
    }
    if (url.includes("opencode.ai/zen/go/v1/usage")) {
      if (modes.opencodego === "empty")
        return jsonResponse(403, { error: { type: "EntitlementError" } });
      if (modes.opencodego === "failure")
        return new Response("opencodego-response-sentinel", { status: 401 });
      return jsonResponse(200, {
        usage: {
          rolling: { status: "ok", percent: 12, resetsAt: "2026-01-01T01:00:00Z" },
          weekly: { status: "ok", percent: 8, resetsAt: "2026-01-02T00:00:00Z" },
          monthly: { status: "ok", percent: 35, resetsAt: "2026-01-03T00:00:00Z" },
        },
      });
    }
    if (url.includes("ollama.com/api/usage")) {
      if (modes.ollama === "failure")
        return new Response("ollama-response-sentinel", { status: 400 });
      return jsonResponse(200, {
        limits: { session: { usage: 0.03, models: [] }, weekly: { usage: 0.005, models: [] } },
        activity: { cost: "12.34" },
      });
    }
    if (url.includes("api.commandcode.ai")) {
      if (modes.commandcode === "failure")
        return new Response("commandcode-response-sentinel", { status: 401 });
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/whoami")) return jsonResponse(200, { org: { id: "org-1" } });
      if (pathname.endsWith("/billing/credits"))
        return jsonResponse(200, {
          credits: { monthlyCredits: 70 },
          windowLimits: { limited: false },
        });
      if (pathname.endsWith("/billing/subscriptions"))
        return jsonResponse(200, { data: { planId: "pro" } });
      return jsonResponse(200, { totalCount: 1 });
    }
    throw new Error(`Unexpected URL in test: ${url}`);
  });
}

async function collect(
  providerEnv: ProviderMetricsEnv,
  fetchMock: FetchMock,
  scheduledTime = scheduledTimeMs,
): Promise<ProviderDiagnosticReport> {
  vi.stubGlobal("fetch", fetchMock);
  return collectAndPushProviderMetrics(providerEnv, scheduledTime);
}

function metricsCalls(
  fetchMock: FetchMock,
): readonly (readonly [RequestInfo | URL, RequestInit?])[] {
  return fetchMock.mock.calls.filter(([input]) => urlOf(input).includes("/v1/metrics"));
}

function payloadMetrics(fetchMock: FetchMock): Record<string, unknown>[] {
  const call = metricsCalls(fetchMock)[0];
  if (call === undefined) throw new Error("Expected one metrics request");
  const body = call[1]?.body;
  if (typeof body !== "string") throw new Error("Expected a serialized metrics payload");
  const payload = JSON.parse(body) as {
    resourceMetrics?: { scopeMetrics?: { metrics?: Record<string, unknown>[] }[] }[];
  };
  const metrics = payload.resourceMetrics?.[0]?.scopeMetrics?.[0]?.metrics;
  if (metrics === undefined) throw new Error("Expected OTLP scope metrics");
  return metrics;
}

function metricNames(metrics: readonly Record<string, unknown>[]): string[] {
  return metrics.flatMap((metric) => (typeof metric.name === "string" ? [metric.name] : []));
}

function healthMetric(
  metrics: readonly Record<string, unknown>[],
  name: string,
  provider: string,
): Record<string, unknown> | undefined {
  return metrics.find((metric) => {
    if (metric.name !== name) return false;
    const gauge = metric.gauge as {
      dataPoints?: { attributes?: { key: string; value: { stringValue: string } }[] }[];
    };
    return gauge.dataPoints?.[0]?.attributes?.some(
      (attribute) => attribute.key === "provider" && attribute.value.stringValue === provider,
    );
  });
}

function metricTimeUnixNano(metric: Record<string, unknown>): string | undefined {
  const gauge = metric.gauge as { dataPoints?: { timeUnixNano?: string }[] };
  return gauge.dataPoints?.[0]?.timeUnixNano;
}

function reportWithOpenAi(overrides: Partial<ProviderMetricsEnv> = {}): ProviderMetricsEnv {
  return env({ OPENAI_ADMIN_API_KEY: openAiCredential, ...overrides });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("provider-metrics scheduled orchestrator", () => {
  it("joins success, empty, failed, and skipped provider records with health semantics", async () => {
    const fetchMock = createFetch({ opencodego: "empty", ollama: "failure" });
    const report = await collect(
      env({
        OPENAI_ADMIN_API_KEY: openAiCredential,
        OPENCODEGO_API_KEY: "opencode-key",
        OLLAMA_API_KEY: ollamaCredential,
      }),
      fetchMock,
    );
    const metrics = payloadMetrics(fetchMock);

    expect(report.providers).toMatchObject({
      openai_api: { status: "success" },
      codex: { status: "skipped" },
      opencodego: { status: "empty" },
      ollama_cloud: {
        status: "failed",
        error: {
          statusCode: 400,
          provider: "ollama_cloud",
          sourceId: "ollama-api-usage",
          kind: "upstream_4xx",
        },
      },
      commandcode: { status: "skipped" },
    });
    for (const provider of ["openai_api", "opencodego"] as const) {
      expect(healthMetric(metrics, "provider_metrics_scrape_success", provider)).toBeDefined();
      expect(
        healthMetric(metrics, "provider_metrics_scrape_timestamp_seconds", provider),
      ).toBeDefined();
    }
    expect(healthMetric(metrics, "provider_metrics_scrape_success", "ollama_cloud")).toBeDefined();
    expect(
      healthMetric(metrics, "provider_metrics_scrape_timestamp_seconds", "ollama_cloud"),
    ).toBeUndefined();
  });

  it("pushes health metrics for every attempted provider when all data fetches fail", async () => {
    const fetchMock = createFetch({
      openai: "failure",
      codex: "failure",
      opencodego: "failure",
      ollama: "failure",
      commandcode: "failure",
    });
    await collect(
      env({
        OPENAI_ADMIN_API_KEY: openAiCredential,
        CODEX_ACCESS_TOKEN: codexCredential,
        OPENCODEGO_API_KEY: "opencode-key",
        OLLAMA_API_KEY: ollamaCredential,
        COMMAND_CODE_API_KEY: "commandcode-key",
      }),
      fetchMock,
    );
    const metrics = payloadMetrics(fetchMock);

    expect(metricsCalls(fetchMock)).toHaveLength(1);
    for (const provider of ["openai_api", "codex", "opencodego", "ollama_cloud", "commandcode"]) {
      expect(healthMetric(metrics, "provider_metrics_scrape_success", provider)).toBeDefined();
      expect(
        healthMetric(metrics, "provider_metrics_scrape_duration_seconds", provider),
      ).toBeDefined();
    }
    expect(metricNames(metrics)).not.toContain("openai_api_cost_usd");
  });

  it("pushes a successful health-only payload for the only empty provider", async () => {
    const fetchMock = createFetch({ opencodego: "empty" });
    const report = await collect(env({ OPENCODEGO_API_KEY: "opencode-key" }), fetchMock);
    const metrics = payloadMetrics(fetchMock);

    expect(report.providers.opencodego.status).toBe("empty");
    expect(metricsCalls(fetchMock)).toHaveLength(1);
    expect(healthMetric(metrics, "provider_metrics_scrape_success", "opencodego")).toBeDefined();
    expect(
      healthMetric(metrics, "provider_metrics_scrape_timestamp_seconds", "opencodego"),
    ).toBeDefined();
    expect(
      healthMetric(metrics, "provider_metrics_scrape_duration_seconds", "opencodego"),
    ).toBeDefined();
  });

  it("does not push when every provider is skipped", async () => {
    const fetchMock = createFetch();
    const report = await collect(env(), fetchMock);

    expect(Object.values(report.providers).every(({ status }) => status === "skipped")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends successful data and health metrics in the same OTLP payload", async () => {
    const fetchMock = createFetch();
    await collect(reportWithOpenAi(), fetchMock);
    const names = metricNames(payloadMetrics(fetchMock));

    expect(names).toContain("openai_api_cost_usd");
    expect(names).toContain("provider_metrics_scrape_success");
  });

  it("uses one timestamp for data and health metrics in the OTLP payload", async () => {
    const pushNowMs = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(pushNowMs);
    const fetchMock = createFetch();

    await collect(reportWithOpenAi(), fetchMock);

    const metrics = payloadMetrics(fetchMock);
    const dataMetric = metrics.find((metric) => metric.name === "openai_api_cost_usd");
    const health = healthMetric(metrics, "provider_metrics_scrape_success", "openai_api");
    const nowUnixNano = `${pushNowMs}000000`;

    expect(metricTimeUnixNano(dataMetric ?? {})).toBe(nowUnixNano);
    expect(metricTimeUnixNano(health ?? {})).toBe(nowUnixNano);
  });

  it("keeps only the Ollama HTML fallback result after API failure", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = urlOf(input);
      if (url.includes("ollama.com/api/usage"))
        return new Response("ollama-api-sentinel", { status: 400 });
      if (url.includes("ollama.com/settings")) {
        return new Response(
          '<html><body><span>Cloud Usage</span><span>Free</span><h3>Session usage</h3><div>35% used</div><span data-time="2026-01-01T01:00:00Z"></span></body></html>',
          { status: 200, headers: { "Content-Type": "text/html" } },
        );
      }
      if (url.includes("/v1/metrics")) return new Response("", { status: 200 });
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    const report = await collect(
      env({ OLLAMA_API_KEY: ollamaCredential, OLLAMA_SESSION_COOKIE: "ollama-cookie" }),
      fetchMock,
    );

    expect(report.providers.ollama_cloud.status).toBe("success");
    const payload = payloadMetrics(fetchMock);
    expect(metricNames(payload)).toContain("ollama_cloud_plan_info");
    expect(metricNames(payload)).not.toContain("ollama_cloud_activity_cost_usd");
    expect(metricNames(payload)).not.toContain("ollama_cloud_model_requests");
    expect(JSON.stringify({ report, payload })).not.toContain("ollama-api-usage");
  });

  it("uses one history day when OpenAI history configuration is unset", async () => {
    const fetchMock = createFetch();
    await collect(reportWithOpenAi(), fetchMock);
    const openAiUrl = fetchMock.mock.calls.find(([input]) =>
      urlOf(input).includes("api.openai.com"),
    );
    if (openAiUrl === undefined) throw new Error("Expected an OpenAI request");
    expect(new URL(urlOf(openAiUrl[0])).searchParams.get("start_time")).toBe("1767139200");
  });

  it.each([
    ["1", true],
    ["31", true],
    ["0", false],
    ["32", false],
    ["1.5", false],
    ["not-a-number", false],
  ] as const)("preflights OPENAI_API_HISTORY_DAYS=%s", async (historyDays, valid) => {
    const fetchMock = createFetch();
    const report = await collect(
      reportWithOpenAi({ OPENAI_API_HISTORY_DAYS: historyDays }),
      fetchMock,
    );

    if (valid) {
      expect(report.providers.openai_api.status).toBe("success");
      expect(fetchMock.mock.calls.some(([input]) => urlOf(input).includes("api.openai.com"))).toBe(
        true,
      );
    } else {
      expect(report.providers.openai_api.status).toBe("skipped");
      expect(fetchMock.mock.calls.some(([input]) => urlOf(input).includes("api.openai.com"))).toBe(
        false,
      );
      expect(metricsCalls(fetchMock)).toHaveLength(0);
    }
  });

  it("skips invalid OpenAI preflight without blocking another provider", async () => {
    const fetchMock = createFetch();
    const report = await collect(
      env({
        OPENAI_ADMIN_API_KEY: openAiCredential,
        OPENAI_API_HISTORY_DAYS: "0",
        CODEX_ACCESS_TOKEN: codexCredential,
      }),
      fetchMock,
    );

    expect(report.providers).toMatchObject({
      openai_api: { status: "skipped" },
      codex: { status: "success" },
    });
    expect(metricsCalls(fetchMock)).toHaveLength(1);
    expect(metricNames(payloadMetrics(fetchMock))).toContain("provider_metrics_scrape_success");
  });

  it("uses scheduled time as the OpenAI UTC window anchor", async () => {
    const fetchMock = createFetch();
    const scheduled = Date.parse("2026-01-02T12:34:56.789Z");
    await collect(reportWithOpenAi({ OPENAI_API_HISTORY_DAYS: "31" }), fetchMock, scheduled);
    const openAiCalls = fetchMock.mock.calls.filter(([input]) =>
      urlOf(input).includes("api.openai.com"),
    );
    const requestUrl = new URL(urlOf(openAiCalls[0]?.[0] ?? "https://invalid.example"));

    expect(requestUrl.searchParams.get("end_time")).toBe("1767312000");
    expect(requestUrl.searchParams.get("start_time")).toBe(String(1767312000 - 31 * 86_400));
  });

  it("forwards the scheduled event time through the Worker entrypoint", async () => {
    const fetchMock = createFetch();
    vi.stubGlobal("fetch", fetchMock);
    const scheduled = Date.parse("2026-01-02T12:34:56.789Z");
    const event = { scheduledTime: scheduled } as ScheduledEvent;

    await worker.scheduled(
      event,
      reportWithOpenAi({ OPENAI_API_HISTORY_DAYS: "31" }),
      {} as ExecutionContext,
    );

    const openAiCalls = fetchMock.mock.calls.filter(([input]) =>
      urlOf(input).includes("api.openai.com"),
    );
    const requestUrl = new URL(urlOf(openAiCalls[0]?.[0] ?? "https://invalid.example"));
    expect(requestUrl.searchParams.get("end_time")).toBe("1767312000");
  });

  it("keeps Codex and Ollama failures on the fixed diagnostic allowlist", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = createFetch({ codex: "failure", ollama: "failure" });
    const report = await collect(
      env({ CODEX_ACCESS_TOKEN: codexCredential, OLLAMA_API_KEY: ollamaCredential }),
      fetchMock,
    );
    const serialized = JSON.stringify({ report, logs: consoleError.mock.calls });

    expect(report.providers).toMatchObject({
      codex: {
        status: "failed",
        error: { statusCode: 401, provider: "codex", sourceId: "codex-wham-usage", kind: "auth" },
      },
      ollama_cloud: {
        status: "failed",
        error: {
          statusCode: 400,
          provider: "ollama_cloud",
          sourceId: "ollama-api-usage",
          kind: "upstream_4xx",
        },
      },
    });
    for (const secret of [
      "codex-response-sentinel",
      "ollama-response-sentinel",
      codexCredential,
      ollamaCredential,
      "Bearer",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
