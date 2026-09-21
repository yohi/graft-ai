import { describe, expect, it, vi } from "vitest";
import { commandcodeAdapter } from "../../src/provider-metrics/commandcode";
import type {
  ProviderContext,
  ProviderMetricsEnv,
  ProviderResult,
} from "../../src/provider-metrics/types";

const BASE_URL = "https://api.commandcode.ai";
const API_KEY = "command-code-secret";
const SOURCE_IDS = {
  whoami: "commandcode-whoami",
  credits: "commandcode-billing-credits",
  subscriptions: "commandcode-billing-subscriptions",
  summary: "commandcode-usage-summary",
} as const;

type Route = { readonly status: number; readonly body: string | Error };
type CommandCodeResult = Extract<ProviderResult, { provider: "commandcode" }>;

function env(): ProviderMetricsEnv {
  return {
    GRAFANA_CLOUD_PROMETHEUS_URL: "https://prometheus.example",
    GRAFANA_CLOUD_PROMETHEUS_USERNAME: "user",
    GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "token",
    COMMAND_CODE_API_KEY: API_KEY,
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

function json(status: number, value: unknown): Route {
  return { status, body: JSON.stringify(value) };
}

function defaultRoutes(orgId = "org/encoded id"): Record<string, Route> {
  return {
    "/alpha/whoami": json(200, { org: { id: orgId } }),
    "/alpha/billing/credits": json(200, {
      credits: { monthlyCredits: 70, purchasedCredits: 5, freeCredits: 0 },
      windowLimits: {
        limited: true,
        fiveHour: { used: 0.57, cap: 14, resetAt: 1_789_923_600_000 },
        weekly: { used: 16, cap: 14, resetAt: 1_790_355_600 },
      },
    }),
    "/alpha/billing/subscriptions": json(200, {
      data: {
        planId: "individual-go",
        status: "active",
        currentPeriodStart: "2026-09-01T00:00:00Z",
        currentPeriodEnd: "2026-10-01T00:00:00Z",
      },
    }),
    "/alpha/usage/summary": json(200, { totalCost: 0.57, totalCount: 45, totalTokens: 3_100_000 }),
  };
}

function mockFetch(routes: Record<string, Route>): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input));
    const route = routes[url.pathname];
    if (route === undefined) throw new Error(`unexpected route ${url.pathname}`);
    if (route.body instanceof Error) throw route.body;
    return new Response(route.body, { status: route.status });
  });
}

function resultOf(outcome: Awaited<ReturnType<typeof commandcodeAdapter>>): CommandCodeResult {
  if (outcome.status !== "success" || outcome.result.provider !== "commandcode") {
    throw new Error("expected a CommandCode success result");
  }
  return outcome.result;
}

async function withFakeTimers<T>(action: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const pending = action();
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

describe("CommandCode adapter", () => {
  it("follows the four-endpoint graph and preserves endpoint provenance", async () => {
    const fetchFn = mockFetch(defaultRoutes());
    const outcome = await commandcodeAdapter(env(), context(fetchFn));
    const result = resultOf(outcome);
    const calls = fetchFn.mock.calls;
    const urls = calls.map(([input]) => String(input));

    expect(urls[0]).toBe(`${BASE_URL}/alpha/whoami?limits=1`);
    expect(urls.slice(1, 3)).toEqual([
      `${BASE_URL}/alpha/billing/credits?orgId=org%2Fencoded%20id`,
      `${BASE_URL}/alpha/billing/subscriptions?orgId=org%2Fencoded%20id`,
    ]);
    expect(urls[3]).toBe(
      `${BASE_URL}/alpha/usage/summary?orgId=org%2Fencoded%20id&since=2026-09-01T00%3A00%3A00Z`,
    );
    for (const [, init] of calls) {
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${API_KEY}`);
      expect(headers.get("Content-Type")).toBe("application/json");
    }
    expect(result).toEqual({
      provider: "commandcode",
      sources: [
        { id: SOURCE_IDS.credits, supportLevel: "official-internal", role: "primary" },
        { id: SOURCE_IDS.subscriptions, supportLevel: "official-internal", role: "enrichment" },
        { id: SOURCE_IDS.summary, supportLevel: "official-internal", role: "enrichment" },
      ],
      windows: [
        {
          period: "session",
          used: 0.57,
          limit: 14,
          usageRatio: 0.57 / 14,
          resetTimestampSeconds: 1_789_923_600,
          exceeded: false,
        },
        {
          period: "weekly",
          used: 16,
          limit: 14,
          usageRatio: 1,
          resetTimestampSeconds: 1_790_355_600,
          exceeded: true,
        },
      ],
      plan: "individual-go",
      subscription: { status: "active", billingPeriodEndSeconds: 1_790_812_800 },
      credits: { monthly: 70, purchased: 5, free: 0, remaining: 75 },
      usage: { costUSD: 0.57, requests: 45, tokens: 3_100_000 },
    });
  });

  it("omits optional enrichment after failures while keeping credits success", async () => {
    const routes = defaultRoutes();
    routes["/alpha/billing/subscriptions"] = json(500, "subscription-secret");
    routes["/alpha/usage/summary"] = { status: 200, body: "{" };
    const fetchFn = mockFetch(routes);
    const result = resultOf(await commandcodeAdapter(env(), context(fetchFn)));

    expect(result.sources).toEqual([
      {
        id: SOURCE_IDS.credits,
        supportLevel: "official-internal",
        role: "primary",
      },
    ]);
    expect(result.plan).toBeUndefined();
    expect(result.subscription).toBeUndefined();
    expect(result.usage).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("subscription-secret");
  });

  it("treats unlimited accounts as successful credits without quota windows", async () => {
    const routes = defaultRoutes();
    routes["/alpha/billing/credits"] = json(200, {
      credits: { monthlyCredits: 10 },
      windowLimits: { limited: false, fiveHour: { used: 4, cap: 5 } },
    });
    const result = resultOf(await commandcodeAdapter(env(), context(mockFetch(routes))));
    expect(result.windows).toEqual([]);
    expect(result.credits).toEqual({ monthly: 10, remaining: 10 });
  });

  it("omits only an invalid optional resetAt", async () => {
    const routes = defaultRoutes();
    routes["/alpha/billing/credits"] = json(200, {
      credits: { monthlyCredits: 10 },
      windowLimits: {
        limited: true,
        fiveHour: { used: 0, cap: 14, resetAt: "2026-09-01T00:00:00Z" },
        weekly: { used: 13.9, cap: 14, resetAt: -1 },
      },
    });
    const result = resultOf(await commandcodeAdapter(env(), context(mockFetch(routes))));
    expect(result.windows).toEqual([
      { period: "session", used: 0, limit: 14, usageRatio: 0, exceeded: false },
      { period: "weekly", used: 13.9, limit: 14, usageRatio: 13.9 / 14, exceeded: false },
    ]);
  });

  it.each([
    ["missing whoami org", "/alpha/whoami", json(200, { org: {} }), SOURCE_IDS.whoami, "schema"],
    [
      "invalid credits",
      "/alpha/billing/credits",
      json(200, { credits: {} }),
      SOURCE_IDS.credits,
      "schema",
    ],
    [
      "zero quota cap",
      "/alpha/billing/credits",
      json(200, {
        credits: { monthlyCredits: 1 },
        windowLimits: { limited: true, fiveHour: { used: 0, cap: 0 }, weekly: { used: 0, cap: 1 } },
      }),
      SOURCE_IDS.credits,
      "schema",
    ],
  ] as const)(
    "returns a required %s failure with its own source",
    async (_name, path, route, sourceId, kind) => {
      const routes = defaultRoutes();
      routes[path] = route;
      const outcome = await commandcodeAdapter(env(), context(mockFetch(routes)));
      expect(outcome).toEqual({
        status: "failed",
        error: { kind, provider: "commandcode", sourceId },
      });
    },
  );

  it.each([
    [401, "auth"],
    [403, "forbidden"],
    [429, "rate_limit"],
    [500, "upstream_5xx"],
  ] as const)("maps whoami HTTP %i to %s with whoami ownership", async (status, kind) => {
    const routes = defaultRoutes();
    routes["/alpha/whoami"] = json(status, "response-secret");
    const outcome = await withFakeTimers(() =>
      commandcodeAdapter(env(), context(mockFetch(routes))),
    );
    expect(outcome).toEqual({
      status: "failed",
      error: { kind, provider: "commandcode", sourceId: SOURCE_IDS.whoami, statusCode: status },
    });
  });

  it.each([
    ["network", new TypeError("network-secret")],
    ["timeout", new DOMException("timeout-secret", "TimeoutError")],
  ] as const)("preserves %s transport ownership", async (kind, error) => {
    const routes = defaultRoutes();
    routes["/alpha/whoami"] = { status: 200, body: error };
    const outcome = await withFakeTimers(() =>
      commandcodeAdapter(env(), context(mockFetch(routes))),
    );
    expect(outcome).toEqual({
      status: "failed",
      error: { kind, provider: "commandcode", sourceId: SOURCE_IDS.whoami },
    });
  });
});
