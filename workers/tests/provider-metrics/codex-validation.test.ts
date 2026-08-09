import { describe, expect, it, vi } from "vitest";
import { fetchCodexMetrics } from "../../src/provider-metrics/codex";

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

describe("fetchCodexMetrics usage response validation", () => {
  it.each([
    [
      "primary_window",
      {
        ...MOCK_USAGE_RESPONSE,
        rate_limit: { ...MOCK_USAGE_RESPONSE.rate_limit, primary_window: undefined },
      },
    ],
    [
      "secondary_window",
      {
        ...MOCK_USAGE_RESPONSE,
        rate_limit: { ...MOCK_USAGE_RESPONSE.rate_limit, secondary_window: undefined },
      },
    ],
  ])("throws when %s is missing", async (_window, incompleteResponse) => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(incompleteResponse), { status: 200 }));

    await expect(fetchCodexMetrics("token", undefined, mockFetch)).rejects.toThrow(
      /required window/,
    );
  });

  it.each([
    ["null root", null],
    ["array root", []],
    ["non-object rate_limit", { ...MOCK_USAGE_RESPONSE, rate_limit: "invalid" }],
    [
      "non-object primary_window",
      {
        ...MOCK_USAGE_RESPONSE,
        rate_limit: { ...MOCK_USAGE_RESPONSE.rate_limit, primary_window: [] },
      },
    ],
  ])("rejects malformed usage object: %s", async (_case, malformedResponse) => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(malformedResponse), { status: 200 }));

    await expect(fetchCodexMetrics("token", undefined, mockFetch)).rejects.toThrow(
      /invalid Codex API response/i,
    );
  });

  it.each([-1, 101, null, "45"])("rejects invalid used_percent value %s", async (usedPercent) => {
    const invalidResponse = {
      ...MOCK_USAGE_RESPONSE,
      rate_limit: {
        ...MOCK_USAGE_RESPONSE.rate_limit,
        primary_window: {
          ...MOCK_USAGE_RESPONSE.rate_limit.primary_window,
          used_percent: usedPercent,
        },
      },
    };
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(invalidResponse), { status: 200 }));

    await expect(fetchCodexMetrics("token", undefined, mockFetch)).rejects.toThrow(
      /invalid Codex API response/i,
    );
  });

  it("rejects non-finite used_percent", async () => {
    const body = JSON.stringify(MOCK_USAGE_RESPONSE).replace(
      '"used_percent":45',
      '"used_percent":1e400',
    );
    const mockFetch = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));

    await expect(fetchCodexMetrics("token", undefined, mockFetch)).rejects.toThrow(
      /invalid Codex API response/i,
    );
  });

  it.each([-1, 1.5, null, "1786161204"])("rejects invalid reset_at value %s", async (resetAt) => {
    const invalidResponse = {
      ...MOCK_USAGE_RESPONSE,
      rate_limit: {
        ...MOCK_USAGE_RESPONSE.rate_limit,
        primary_window: {
          ...MOCK_USAGE_RESPONSE.rate_limit.primary_window,
          reset_at: resetAt,
        },
      },
    };
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(invalidResponse), { status: 200 }));

    await expect(fetchCodexMetrics("token", undefined, mockFetch)).rejects.toThrow(
      /invalid Codex API response/i,
    );
  });

  it.each([
    ["numeric plan", { ...MOCK_USAGE_RESPONSE, plan_type: 1 }],
    ["null plan", { ...MOCK_USAGE_RESPONSE, plan_type: null }],
    ["boolean balance", { ...MOCK_USAGE_RESPONSE, credits: { balance: true } }],
    ["object balance", { ...MOCK_USAGE_RESPONSE, credits: { balance: {} } }],
  ])("rejects wrong plan or balance type: %s", async (_case, invalidResponse) => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(invalidResponse), { status: 200 }));

    await expect(fetchCodexMetrics("token", undefined, mockFetch)).rejects.toThrow(
      /invalid Codex API response/i,
    );
  });

  it("preserves null credits as an unavailable balance", async () => {
    const nullCredits = { ...MOCK_USAGE_RESPONSE, credits: null };
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(nullCredits), { status: 200 }));

    const result = await fetchCodexMetrics("token", undefined, mockFetch);

    expect(result.creditsRemaining).toBeNull();
  });

  it("parses a finite numeric string credit balance", async () => {
    const stringBalance = { ...MOCK_USAGE_RESPONSE, credits: { balance: "3.5" } };
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(stringBalance), { status: 200 }));

    const result = await fetchCodexMetrics("token", undefined, mockFetch);

    expect(result.creditsRemaining).toBe(3.5);
  });
});
