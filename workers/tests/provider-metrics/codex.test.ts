import { describe, expect, it, vi } from "vitest";
import { codexAdapter } from "../../src/provider-metrics/codex";
import type {
  AdapterOutcome,
  ProviderContext,
  ProviderError,
  ProviderMetricsEnv,
  ProviderResult,
} from "../../src/provider-metrics/types";

const ACCESS_TOKEN = "codex-access-token-secret";
const ACCOUNT_ID = "acct-123";
const RESPONSE_BODY = "sentinel-codex-response-body";
const RAW_ERROR = "sentinel-browser-error-message";
const PRIMARY_SOURCE_ID = "codex-wham-usage";
const BROWSER_SOURCE_ID = "codex-browser-rendering";

const MOCK_USAGE_RESPONSE = {
  plan_type: "pro",
  rate_limit: {
    primary_window: {
      used_percent: 45,
      reset_at: 1786161204,
      limit_window_seconds: 18000,
    },
    secondary_window: {
      used_percent: 20,
      reset_at: 1786247604,
      limit_window_seconds: 604800,
    },
  },
  credits: { balance: 3.5 },
};

const MOCK_RESET_CREDITS_RESPONSE = { credits: 12, available_count: 8 };

type CodexResult = Extract<ProviderResult, { provider: "codex" }>;

function response(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

function env(overrides: Partial<ProviderMetricsEnv> = {}): ProviderMetricsEnv {
  return {
    GRAFANA_CLOUD_PROMETHEUS_URL: "https://prometheus.example",
    GRAFANA_CLOUD_PROMETHEUS_USERNAME: "user",
    GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "token",
    CODEX_ACCESS_TOKEN: ACCESS_TOKEN,
    ...overrides,
  };
}

function context(fetchFn: typeof fetch, browserBinding?: Fetcher): ProviderContext {
  return {
    fetchFn,
    scheduledTimeSeconds: 1_000,
    openaiHistoryDays: 1,
    nowSeconds: () => 1_000,
    monotonicNowMs: () => 0,
    ...(browserBinding === undefined ? {} : { browserBinding }),
  };
}

function browserBinding(): Fetcher {
  return { fetch: vi.fn<typeof fetch>(), connect: vi.fn() } as Fetcher;
}

function successfulFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi
    .fn<typeof fetch>()
    .mockImplementation(async (input) =>
      String(input).endsWith("rate-limit-reset-credits")
        ? response(200, JSON.stringify(MOCK_RESET_CREDITS_RESPONSE))
        : response(200, JSON.stringify(MOCK_USAGE_RESPONSE)),
    );
}

function successfulCodex(outcome: AdapterOutcome): CodexResult {
  expect(outcome.status).toBe("success");
  if (outcome.status !== "success" || outcome.result.provider !== "codex") {
    throw new Error("expected a successful Codex result");
  }
  return outcome.result;
}

function expectFailure(outcome: AdapterOutcome, error: ProviderError): void {
  expect(outcome).toEqual({ status: "failed", error });
  const serialized = JSON.stringify(outcome);
  for (const secret of [ACCESS_TOKEN, RESPONSE_BODY, RAW_ERROR, `Bearer ${ACCESS_TOKEN}`]) {
    expect(serialized).not.toContain(secret);
  }
}

function browserPage(body: string): {
  readonly setRequestInterception: ReturnType<typeof vi.fn>;
  readonly on: ReturnType<typeof vi.fn>;
  readonly goto: ReturnType<typeof vi.fn>;
  readonly evaluate: ReturnType<typeof vi.fn>;
} {
  return {
    setRequestInterception: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    goto: vi.fn().mockResolvedValue({ text: vi.fn().mockResolvedValue(body) }),
    evaluate: vi.fn().mockResolvedValue(""),
  };
}

function installBrowser(page: ReturnType<typeof browserPage>): {
  readonly launch: ReturnType<typeof vi.fn>;
  readonly browser: {
    readonly newPage: ReturnType<typeof vi.fn>;
    readonly close: ReturnType<typeof vi.fn>;
  };
} {
  const browser = {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const launch = vi.fn().mockResolvedValue(browser);
  vi.doMock("@cloudflare/puppeteer", () => ({ launch }));
  return { launch, browser };
}

describe("Codex adapter", () => {
  it("returns normalized usage, credits, plan, and primary provenance", async () => {
    const outcome = await codexAdapter(env(), context(successfulFetch()));

    expect(successfulCodex(outcome)).toEqual({
      provider: "codex",
      sources: [{ id: PRIMARY_SOURCE_ID, supportLevel: "official-internal", role: "primary" }],
      windows: [
        { period: "session", usageRatio: 0.45, resetTimestampSeconds: 1786161204 },
        { period: "weekly", usageRatio: 0.2, resetTimestampSeconds: 1786247604 },
      ],
      plan: "pro",
      credits: { remaining: 3.5, resetCredits: 12, resetCreditsAvailableCount: 8 },
    });
  });

  it("passes account, proxy, and proxy-secret settings to primary and enrichment requests", async () => {
    const fetchFn = successfulFetch();
    await codexAdapter(
      env({
        CODEX_ACCOUNT_ID: ACCOUNT_ID,
        CODEX_PROXY_URL: "https://proxy.example.com/",
        CODEX_PROXY_SECRET: "proxy-secret",
      }),
      context(fetchFn),
    );

    for (const [input, init] of fetchFn.mock.calls as [RequestInfo | URL, RequestInit][]) {
      expect(String(input)).toMatch(/^https:\/\/proxy\.example\.com\/backend-api\/wham\//);
      const headers = new Headers(init.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(headers.get("ChatGPT-Account-Id")).toBe(ACCOUNT_ID);
      expect(headers.get("X-Proxy-Secret")).toBe("proxy-secret");
    }
  });

  it("keeps usage success when reset-credit enrichment fails", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) =>
        String(input).endsWith("rate-limit-reset-credits")
          ? response(200, "invalid-reset-credit-json")
          : response(200, JSON.stringify(MOCK_USAGE_RESPONSE)),
      );

    const result = successfulCodex(await codexAdapter(env(), context(fetchFn)));

    expect(result.windows).toHaveLength(2);
    expect(result.credits).toEqual({ remaining: 3.5 });
  });

  it("uses Browser Rendering as the only provenance after primary 403 recovery", async () => {
    const page = browserPage(JSON.stringify(MOCK_USAGE_RESPONSE));
    const { launch, browser } = installBrowser(page);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) =>
        String(input).endsWith("rate-limit-reset-credits")
          ? response(200, JSON.stringify(MOCK_RESET_CREDITS_RESPONSE))
          : response(403, RESPONSE_BODY),
      );
    const binding = browserBinding();

    const result = successfulCodex(await codexAdapter(env(), context(fetchFn, binding)));

    expect(result.sources).toEqual([
      { id: BROWSER_SOURCE_ID, supportLevel: "web-internal", role: "fallback" },
    ]);
    expect(result.windows).toHaveLength(2);
    expect(launch).toHaveBeenCalledWith(binding);
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("forwards proxy-secret authentication through Browser Rendering fallback", async () => {
    type InterceptedRequest = {
      readonly url: () => string;
      readonly headers: () => Record<string, string>;
      readonly continue: ReturnType<typeof vi.fn>;
    };

    const page = browserPage(JSON.stringify(MOCK_USAGE_RESPONSE));
    const targetUrl = "https://proxy.example.com/backend-api/wham/usage";
    const interceptedRequest: InterceptedRequest = {
      url: () => targetUrl,
      headers: () => ({}),
      continue: vi.fn(),
    };
    let requestHandler: ((request: InterceptedRequest) => void) | undefined;
    page.on.mockImplementation((event: string, handler: (request: InterceptedRequest) => void) => {
      if (event === "request") requestHandler = handler;
    });
    page.goto.mockImplementation(async () => {
      requestHandler?.(interceptedRequest);
      return { text: vi.fn().mockResolvedValue(JSON.stringify(MOCK_USAGE_RESPONSE)) };
    });
    installBrowser(page);

    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) =>
        String(input).endsWith("rate-limit-reset-credits")
          ? response(200, JSON.stringify(MOCK_RESET_CREDITS_RESPONSE))
          : response(403, RESPONSE_BODY),
      );
    const binding = browserBinding();

    await codexAdapter(
      env({
        CODEX_PROXY_URL: "https://proxy.example.com",
        CODEX_PROXY_SECRET: "proxy-secret",
      }),
      context(fetchFn, binding),
    );

    expect(interceptedRequest.continue).toHaveBeenCalledWith({
      headers: expect.objectContaining({ "X-Proxy-Secret": "proxy-secret" }),
    });
  });

  it("does not invoke Browser Rendering when the primary binding is unavailable", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(403, RESPONSE_BODY));

    const outcome = await codexAdapter(env(), context(fetchFn));

    expectFailure(outcome, {
      kind: "forbidden",
      provider: "codex",
      sourceId: PRIMARY_SOURCE_ID,
      statusCode: 403,
    });
  });

  it.each([
    [401, "auth"],
    [429, "rate_limit"],
    [503, "upstream_5xx"],
  ] as const)("keeps primary HTTP %i as %s without browser fallback", async (status, kind) => {
    const launch = vi.fn();
    vi.doMock("@cloudflare/puppeteer", () => ({ launch }));
    const binding = browserBinding();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(status, RESPONSE_BODY));

    const outcome = await codexAdapter(env(), context(fetchFn, binding));

    expectFailure(outcome, {
      kind,
      provider: "codex",
      sourceId: PRIMARY_SOURCE_ID,
      statusCode: status,
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([
    ["network", new TypeError("primary-network-secret")],
    ["timeout", new DOMException("primary-timeout-secret", "TimeoutError")],
  ] as const)("maps primary %s transport failure to the fixed source", async (kind, error) => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(error);

    const outcome = await codexAdapter(env(), context(fetchFn));

    expectFailure(outcome, { kind, provider: "codex", sourceId: PRIMARY_SOURCE_ID });
  });

  it.each([
    ["parse", "primary-parse-secret"],
    ["schema", JSON.stringify({ rate_limit: {} })],
  ] as const)("maps primary 200 %s failure without browser fallback", async (kind, body) => {
    const launch = vi.fn();
    vi.doMock("@cloudflare/puppeteer", () => ({ launch }));
    const binding = browserBinding();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(200, body));

    const outcome = await codexAdapter(env(), context(fetchFn, binding));

    expectFailure(outcome, { kind, provider: "codex", sourceId: PRIMARY_SOURCE_ID });
    expect(launch).not.toHaveBeenCalled();
  });

  it("classifies Browser Rendering launch failure as network", async () => {
    const launch = vi.fn().mockRejectedValue(new TypeError(RAW_ERROR));
    vi.doMock("@cloudflare/puppeteer", () => ({ launch }));
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(403, RESPONSE_BODY));

    const outcome = await codexAdapter(env(), context(fetchFn, browserBinding()));

    expectFailure(outcome, { kind: "network", provider: "codex", sourceId: BROWSER_SOURCE_ID });
  });

  it("classifies Browser Rendering navigation failure as network", async () => {
    const page = browserPage(JSON.stringify(MOCK_USAGE_RESPONSE));
    page.goto.mockRejectedValue(new TypeError(RAW_ERROR));
    installBrowser(page);
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(403, RESPONSE_BODY));

    const outcome = await codexAdapter(env(), context(fetchFn, browserBinding()));

    expectFailure(outcome, { kind: "network", provider: "codex", sourceId: BROWSER_SOURCE_ID });
  });

  it("classifies Browser Rendering response timeout as timeout", async () => {
    const page = browserPage(JSON.stringify(MOCK_USAGE_RESPONSE));
    page.goto.mockResolvedValue({
      text: vi.fn().mockRejectedValue(new DOMException(RAW_ERROR, "TimeoutError")),
    });
    installBrowser(page);
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(403, RESPONSE_BODY));

    const outcome = await codexAdapter(env(), context(fetchFn, browserBinding()));

    expectFailure(outcome, { kind: "timeout", provider: "codex", sourceId: BROWSER_SOURCE_ID });
  });

  it.each([
    ["parse", "browser-parse-secret"],
    ["schema", JSON.stringify({ rate_limit: {} })],
  ] as const)(
    "classifies Browser Rendering %s failure with browser ownership",
    async (kind, body) => {
      installBrowser(browserPage(body));
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(403, RESPONSE_BODY));

      const outcome = await codexAdapter(env(), context(fetchFn, browserBinding()));

      expectFailure(outcome, { kind, provider: "codex", sourceId: BROWSER_SOURCE_ID });
    },
  );

  it("keeps unknown window types out of the normalized result", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) =>
      String(input).endsWith("rate-limit-reset-credits")
        ? response(200, JSON.stringify(MOCK_RESET_CREDITS_RESPONSE))
        : response(
            200,
            JSON.stringify({
              plan_type: "plus",
              rate_limit: {
                primary_window: { used_percent: 60, reset_at: 1786161204 },
                secondary_window: {
                  used_percent: 20,
                  reset_at: 1786247604,
                  limit_window_seconds: 604800,
                },
              },
            }),
          ),
    );

    const result = successfulCodex(await codexAdapter(env(), context(fetchFn)));

    expect(result.windows).toEqual([
      { period: "weekly", usageRatio: 0.2, resetTimestampSeconds: 1786247604 },
    ]);
  });
});
