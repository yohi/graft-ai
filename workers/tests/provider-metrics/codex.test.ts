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
    expect(usageHeaders.get("User-Agent")).toBe("graft-ai");
    expect(resetCreditsHeaders.get("Authorization")).toBe("Bearer test-token");
    expect(resetCreditsHeaders.get("Accept")).toBe("application/json");
    expect(resetCreditsHeaders.get("User-Agent")).toBe("graft-ai");
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

  it("defaults plan to 'unknown' when plan_type absent", async () => {
    const noPlan = { rate_limit: MOCK_USAGE_RESPONSE.rate_limit };
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(noPlan), { status: 200 }));
    const result = await fetchCodexMetrics("token", undefined, mockFetch);
    expect(result.plan).toBe("unknown");
  });
});
