import { describe, it, expect, vi } from "vitest";
import { fetchCodexMetrics } from "../../src/provider-metrics/codex";

// CodexBar の CodexUsageResponse 形式（参照リビジョン: 5f872ecca9b722f2d906534826baf62e8939f6fd）に準拠したモックレスポンス
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
  credits: {
    has_credits: true,
    unlimited: false,
    balance: 3.5,
  },
};

const MOCK_RESET_CREDITS_RESPONSE = {
  credits: 12,
  available_count: 8,
};

describe("fetchCodexMetrics", () => {
  it("parses usage ratio and reset timestamps", async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.endsWith("rate-limit-reset-credits")
                ? MOCK_RESET_CREDITS_RESPONSE
                : MOCK_USAGE_RESPONSE,
            ),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );

    const result = await fetchCodexMetrics("test-access-token", undefined, mockFetch);

    // primary_window.used_percent=45 → usage_ratio = 0.45
    expect(result.sessionUsageRatio).toBeCloseTo(0.45);
    // secondary_window.used_percent=20 → usage_ratio = 0.2
    expect(result.weeklyUsageRatio).toBeCloseTo(0.2);
    // credits.balance: 3.5
    expect(result.creditsRemaining).toBeCloseTo(3.5);
    expect(result.plan).toBe("pro");

    expect(result.sessionResetTimestampSeconds).toBe(1786161204);
    expect(result.weeklyResetTimestampSeconds).toBe(1786247604);
    expect(result.resetCredits).toEqual({ credits: 12, availableCount: 8 });
  });

  it("sends Bearer auth header and correct URL", async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.endsWith("rate-limit-reset-credits")
                ? MOCK_RESET_CREDITS_RESPONSE
                : MOCK_USAGE_RESPONSE,
            ),
            { status: 200 },
          ),
      );
    await fetchCodexMetrics("test-token", undefined, mockFetch);
    const calls = mockFetch.mock.calls as [string, RequestInit][];
    const usageCall = calls.find(([url]) => url.endsWith("/wham/usage"));
    const resetCreditsCall = calls.find(([url]) => url.endsWith("/wham/rate-limit-reset-credits"));
    const usageHeaders = new Headers(usageCall?.[1].headers);
    const resetCreditsHeaders = new Headers(resetCreditsCall?.[1].headers);
    expect(usageCall?.[0]).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(resetCreditsCall?.[0]).toBe(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
    );
    expect(usageHeaders.get("Authorization")).toBe("Bearer test-token");
    expect(usageHeaders.get("Accept")).toBe("application/json");
    expect(usageHeaders.get("User-Agent")).toContain("Mozilla/5.0");
    expect(usageHeaders.get("Origin")).toBe("https://chatgpt.com");
    expect(usageHeaders.get("Referer")).toBe("https://chatgpt.com/");
    expect(usageHeaders.get("OpenAI-Beta")).toBe("codex-1");
    expect(usageHeaders.get("originator")).toBe("Codex Desktop");
    expect(resetCreditsHeaders.get("Authorization")).toBe("Bearer test-token");
    expect(resetCreditsHeaders.get("Accept")).toBe("application/json");
    expect(resetCreditsHeaders.get("User-Agent")).toContain("Mozilla/5.0");
    expect(resetCreditsHeaders.get("OpenAI-Beta")).toBe("codex-1");
    expect(resetCreditsHeaders.get("originator")).toBe("Codex Desktop");
  });

  it("sends ChatGPT-Account-Id header when accountId provided", async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.endsWith("rate-limit-reset-credits")
                ? MOCK_RESET_CREDITS_RESPONSE
                : MOCK_USAGE_RESPONSE,
            ),
            { status: 200 },
          ),
      );
    await fetchCodexMetrics("token", "acct-123", mockFetch);
    for (const [, init] of mockFetch.mock.calls as [string, RequestInit][]) {
      const headers = init.headers as Record<string, string>;
      expect(headers["ChatGPT-Account-Id"]).toBe("acct-123");
    }
  });

  it("throws on HTTP 401", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    await expect(fetchCodexMetrics("bad-token", undefined, mockFetch)).rejects.toThrow(/401/);
  });

  it("retries a transient usage HTTP 503 before succeeding", async () => {
    let attempts = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/wham/usage")) {
        attempts++;
        if (attempts === 1) return new Response("Unavailable", { status: 503 });
        return new Response(JSON.stringify(MOCK_USAGE_RESPONSE), { status: 200 });
      }
      return new Response(JSON.stringify(MOCK_RESET_CREDITS_RESPONSE), { status: 200 });
    });

    await fetchCodexMetrics("test-token", undefined, mockFetch);

    expect(attempts).toBe(2);
  });

  it("keeps usage metrics when reset-credits fetch fails", async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation(async (url: string) =>
        url.endsWith("rate-limit-reset-credits")
          ? new Response("Unavailable", { status: 503 })
          : new Response(JSON.stringify(MOCK_USAGE_RESPONSE), { status: 200 }),
      );
    const result = await fetchCodexMetrics("token", undefined, mockFetch);
    expect(result.sessionUsageRatio).toBeCloseTo(0.45);
    expect(result.resetCredits).toBeUndefined();
  });

  it("sets creditsRemaining to null when credits field absent", async () => {
    const noCredits = { plan_type: "free", rate_limit: MOCK_USAGE_RESPONSE.rate_limit };
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(noCredits), { status: 200 }));
    const result = await fetchCodexMetrics("token", undefined, mockFetch);
    expect(result.creditsRemaining).toBeNull();
  });

  it("handles null or missing secondary_window without error", async () => {
    const responseWithNullSecondary = {
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 60,
          reset_at: 1786161204,
        },
        secondary_window: null,
      },
    };
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(responseWithNullSecondary), { status: 200 }));
    const result = await fetchCodexMetrics("token", undefined, mockFetch);
    expect(result.sessionUsageRatio).toBeCloseTo(0.6);
    expect(result.weeklyUsageRatio).toBeUndefined();
    expect(result.sessionResetTimestampSeconds).toBe(1786161204);
    expect(result.weeklyResetTimestampSeconds).toBeUndefined();
    expect(result.plan).toBe("plus");
  });

  it("ignores non-finite reset credits without losing usage metrics", async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation(async (url: string) =>
        url.endsWith("rate-limit-reset-credits")
          ? new Response('{"credits":1e400,"available_count":8}', { status: 200 })
          : new Response(JSON.stringify(MOCK_USAGE_RESPONSE), { status: 200 }),
      );

    const result = await fetchCodexMetrics("token", undefined, mockFetch);

    expect(result.sessionUsageRatio).toBeCloseTo(0.45);
    expect(result.resetCredits).toBeUndefined();
  });

  it("routes requests to custom proxyUrl when provided", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      expect(url.startsWith("https://proxy.example.com/backend-api/")).toBe(true);
      return new Response(JSON.stringify(MOCK_USAGE_RESPONSE), { status: 200 });
    });

    const result = await fetchCodexMetrics(
      "token",
      undefined,
      mockFetch,
      "https://proxy.example.com/",
    );
    expect(result.sessionUsageRatio).toBeCloseTo(0.45);
  });

  it("falls back to browser rendering on 403 when browserBinding is provided and fetches reset credits", async () => {
    let requestHandler: ((req: any) => void) | undefined;
    const mockPage = {
      setRequestInterception: vi.fn().mockResolvedValue(undefined),
      on: vi.fn().mockImplementation((event: string, handler: (req: any) => void) => {
        if (event === "request") requestHandler = handler;
      }),
      goto: vi.fn().mockImplementation(async (url: string) => {
        // Simulate intercepted requests: one target URL, one external origin
        if (requestHandler) {
          const targetReq = {
            url: () => url,
            headers: () => ({ "Existing-Header": "val" }),
            continue: vi.fn(),
          };
          requestHandler(targetReq);
          expect(targetReq.continue).toHaveBeenCalledWith({
            headers: {
              "Existing-Header": "val",
              Authorization: "Bearer token",
              "ChatGPT-Account-Id": "acct-123",
              "OpenAI-Beta": "codex-1",
              originator: "Codex Desktop",
              Accept: "application/json",
            },
          });

          const externalReq = {
            url: () => "https://cdn.example.com/asset.js",
            headers: () => ({ "Existing-Header": "val" }),
            continue: vi.fn(),
          };
          requestHandler(externalReq);
          expect(externalReq.continue).toHaveBeenCalledWith();
        }
        return {
          text: vi.fn().mockResolvedValue(JSON.stringify(MOCK_USAGE_RESPONSE)),
        };
      }),
      evaluate: vi.fn().mockResolvedValue(""),
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const mockLaunch = vi.fn().mockResolvedValue(mockBrowser);

    vi.doMock("@cloudflare/puppeteer", () => ({
      default: { launch: mockLaunch },
    }));

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/wham/usage")) {
        return new Response("Forbidden", { status: 403 });
      }
      return new Response(JSON.stringify(MOCK_RESET_CREDITS_RESPONSE), { status: 200 });
    });
    const mockBrowserBinding = {} as Fetcher;

    const result = await fetchCodexMetrics(
      "token",
      "acct-123",
      mockFetch,
      undefined,
      mockBrowserBinding,
    );

    expect(result.sessionUsageRatio).toBeCloseTo(0.45);
    expect(result.resetCredits).toEqual({ credits: 12, availableCount: 8 });
    expect(mockPage.setRequestInterception).toHaveBeenCalledWith(true);
    expect(mockLaunch).toHaveBeenCalledWith(mockBrowserBinding);
    expect(mockBrowser.close).toHaveBeenCalled();
  });

  it("handles puppeteer without default export on 403", async () => {
    const mockPage = {
      setRequestInterception: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      goto: vi.fn().mockResolvedValue({
        text: vi.fn().mockResolvedValue(JSON.stringify(MOCK_USAGE_RESPONSE)),
      }),
      evaluate: vi.fn().mockResolvedValue(""),
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const mockLaunch = vi.fn().mockResolvedValue(mockBrowser);

    vi.doMock("@cloudflare/puppeteer", () => ({
      launch: mockLaunch,
    }));

    const mockFetch = vi.fn().mockResolvedValue(new Response("Forbidden", { status: 403 }));
    const mockBrowserBinding = {} as Fetcher;

    const result = await fetchCodexMetrics(
      "token",
      undefined,
      mockFetch,
      undefined,
      mockBrowserBinding,
    );

    expect(result.sessionUsageRatio).toBeCloseTo(0.45);
    expect(mockLaunch).toHaveBeenCalledWith(mockBrowserBinding);
  });

  it("throws descriptive error when browser rendering returns non-JSON HTML", async () => {
    const mockPage = {
      setRequestInterception: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      goto: vi.fn().mockResolvedValue({
        text: vi.fn().mockResolvedValue("<html><body>Just a moment...</body></html>"),
      }),
      evaluate: vi.fn().mockResolvedValue(""),
    };
    const mockBrowser = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn().mockResolvedValue(undefined),
    };

    vi.doMock("@cloudflare/puppeteer", () => ({
      launch: vi.fn().mockResolvedValue(mockBrowser),
    }));

    const mockFetch = vi.fn().mockResolvedValue(new Response("Forbidden", { status: 403 }));
    const mockBrowserBinding = {} as Fetcher;

    await expect(
      fetchCodexMetrics("token", undefined, mockFetch, undefined, mockBrowserBinding),
    ).rejects.toThrow(/Browser rendering returned non-JSON response/);
  });

  it("sends X-Proxy-Secret header when proxySecret is provided", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      return new Response(
        JSON.stringify(
          url.endsWith("rate-limit-reset-credits")
            ? MOCK_RESET_CREDITS_RESPONSE
            : MOCK_USAGE_RESPONSE,
        ),
        { status: 200 },
      );
    });

    await fetchCodexMetrics(
      "token",
      undefined,
      mockFetch,
      "https://proxy.example.com",
      undefined,
      new Date(),
      "my-secret-proxy-key",
    );

    for (const [, init] of mockFetch.mock.calls as [string, RequestInit][]) {
      const headers = new Headers(init.headers);
      expect(headers.get("X-Proxy-Secret")).toBe("my-secret-proxy-key");
    }
  });

  it("classifies weekly window correctly even when less than 24 hours remain", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("rate-limit-reset-credits")) {
        return new Response(JSON.stringify(MOCK_RESET_CREDITS_RESPONSE), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 75,
              reset_at: 1786247604,
              limit_window_seconds: 604800, // 7-day window
            },
          },
        }),
        { status: 200 },
      );
    });

    // Injected 'now' is only 1 hour before reset_at (1786247604 - 3600 = 1786244004)
    const now = new Date((1786247604 - 3600) * 1000);
    const result = await fetchCodexMetrics(
      "token",
      undefined,
      mockFetch,
      undefined,
      undefined,
      now,
    );

    expect(result.weeklyUsageRatio).toBeCloseTo(0.75);
    expect(result.weeklyResetTimestampSeconds).toBe(1786247604);
    expect(result.sessionUsageRatio).toBeUndefined();
  });

  it("preserves secondary window even when it lacks limit_window_seconds", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("rate-limit-reset-credits")) {
        return new Response(JSON.stringify(MOCK_RESET_CREDITS_RESPONSE), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: 30,
              reset_at: 1786161204,
              limit_window_seconds: 18000, // session window
            },
            secondary_window: {
              used_percent: 60,
              reset_at: 1786247604,
              // limit_window_seconds is omitted
            },
          },
        }),
        { status: 200 },
      );
    });

    const result = await fetchCodexMetrics("token", undefined, mockFetch);
    expect(result.sessionUsageRatio).toBeCloseTo(0.3);
    expect(result.sessionResetTimestampSeconds).toBe(1786161204);
    expect(result.weeklyUsageRatio).toBeCloseTo(0.6);
    expect(result.weeklyResetTimestampSeconds).toBe(1786247604);
  });

  it("assigns primary to session and secondary to weekly when neither has limit_window_seconds", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("rate-limit-reset-credits")) {
        return new Response(JSON.stringify(MOCK_RESET_CREDITS_RESPONSE), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          plan_type: "free",
          rate_limit: {
            primary_window: {
              used_percent: 10,
              reset_at: 1786161204,
            },
            secondary_window: {
              used_percent: 50,
              reset_at: 1786247604,
            },
          },
        }),
        { status: 200 },
      );
    });

    const result = await fetchCodexMetrics("token", undefined, mockFetch);
    expect(result.sessionUsageRatio).toBeCloseTo(0.1);
    expect(result.sessionResetTimestampSeconds).toBe(1786161204);
    expect(result.weeklyUsageRatio).toBeCloseTo(0.5);
    expect(result.weeklyResetTimestampSeconds).toBe(1786247604);
  });
});
