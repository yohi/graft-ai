import { describe, expect, it, vi } from "vitest";
import { fetchOpenCodeGoMetrics } from "../../src/provider-metrics/opencodego";

const WORKSPACE_HTML = `<script>self.__next_f=[["wrk_abc123"]]</script>`;
const ZEN_HTML = `<script>{"zenBalance":23.45}</script>`;
const VALID_USAGE = `{"usagePercent":50,"resetInSec":600}`;

function mockFetchForUsage(usageBody: string, zenBody = "{}") {
  let call = 0;
  return vi.fn().mockImplementation(async () => {
    call++;
    if (call === 1) return new Response(WORKSPACE_HTML, { status: 200 });
    if (call === 2) return new Response(usageBody, { status: 200 });
    return new Response(zenBody, { status: 200 });
  });
}

describe("fetchOpenCodeGoMetrics usage response validation", () => {
  it.each([
    ["negative rolling usage", `{"usagePercent":-1,"resetInSec":600}`],
    ["rolling usage above 100", `{"usagePercent":101,"resetInSec":600}`],
    ["non-finite rolling usage", `{"usagePercent":1e400,"resetInSec":600}`],
    [
      "optional weekly usage above 100",
      `{"usagePercent":50,"resetInSec":600,"weeklyUsagePercent":101}`,
    ],
    [
      "non-finite optional monthly usage",
      `{"usagePercent":50,"resetInSec":600,"monthlyUsagePercent":1e400}`,
    ],
  ])("rejects invalid usage percentage: %s", async (_case, body) => {
    await expect(
      fetchOpenCodeGoMetrics("session=abc", undefined, mockFetchForUsage(body)),
    ).rejects.toThrow(/usage percentage must be finite and between 0 and 100/i);
  });

  it.each([
    ["negative rolling reset", `{"usagePercent":50,"resetInSec":-1}`],
    ["fractional rolling reset", `{"usagePercent":50,"resetInSec":1.5}`],
    ["non-finite rolling reset", `{"usagePercent":50,"resetInSec":1e400}`],
    [
      "negative optional weekly reset",
      `{"usagePercent":50,"resetInSec":600,"weeklyResetInSec":-1}`,
    ],
    [
      "fractional optional monthly reset",
      `{"usagePercent":50,"resetInSec":600,"monthlyResetInSec":1.5}`,
    ],
  ])("rejects invalid reset seconds: %s", async (_case, body) => {
    await expect(
      fetchOpenCodeGoMetrics("session=abc", undefined, mockFetchForUsage(body)),
    ).rejects.toThrow(/reset seconds must be a finite non-negative safe integer/i);
  });

  it("does not read inherited usage percentage", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, "usagePercent");
    Object.defineProperty(Object.prototype, "usagePercent", {
      configurable: true,
      value: 50,
    });

    try {
      await expect(
        fetchOpenCodeGoMetrics("session=abc", undefined, mockFetchForUsage(`{"resetInSec":600}`)),
      ).rejects.toThrow(/could not parse usage|missing required rolling/i);
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(Object.prototype, "usagePercent");
      } else {
        Object.defineProperty(Object.prototype, "usagePercent", descriptor);
      }
    }
  });

  it("does not read inherited reset seconds", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, "resetInSec");
    Object.defineProperty(Object.prototype, "resetInSec", {
      configurable: true,
      value: 600,
    });

    try {
      const result = await fetchOpenCodeGoMetrics(
        "session=abc",
        undefined,
        mockFetchForUsage(`{"usagePercent":50}`),
      );
      expect(result.rollingResetSeconds).toBeUndefined();
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(Object.prototype, "resetInSec");
      } else {
        Object.defineProperty(Object.prototype, "resetInSec", descriptor);
      }
    }
  });

  it("treats a non-finite Zen balance as unavailable", async () => {
    const result = await fetchOpenCodeGoMetrics(
      "session=abc",
      undefined,
      mockFetchForUsage(VALID_USAGE, `<script>{"zenBalance":1e400}</script>`),
    );

    expect(result.zenBalanceUSD).toBeNull();
  });

  it("treats a negative Zen balance as unavailable", async () => {
    const result = await fetchOpenCodeGoMetrics(
      "session=abc",
      undefined,
      mockFetchForUsage(VALID_USAGE, `<script>{"zenBalance":-1}</script>`),
    );

    expect(result.zenBalanceUSD).toBeNull();
  });

  it.each([
    [
      "usage percentage",
      `{"usagePercent":50,"usedPercent":-1,"resetInSec":600}`,
      /usage percentage must be finite and between 0 and 100/i,
    ],
    [
      "reset seconds",
      `{"usagePercent":50,"resetInSec":600,"resetSeconds":-1}`,
      /reset seconds must be a finite non-negative safe integer/i,
    ],
  ])("rejects an invalid later %s alias", async (_field, body, expectedError) => {
    await expect(
      fetchOpenCodeGoMetrics("session=abc", undefined, mockFetchForUsage(body)),
    ).rejects.toThrow(expectedError);
  });

  it("skips non-numeric values and picks valid numeric candidate", async () => {
    const body = `<script>
      self.__next_f=[["wrk_abc123"]];
      self.otherData = {"usagePercent": "unlimited", "resetInSec": "soon"};
      self.actualUsage = {"usagePercent": 40, "resetInSec": 1800};
    </script>`;

    let call = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) return new Response(WORKSPACE_HTML, { status: 200 });
      if (call === 2) return new Response(body, { status: 200 });
      return new Response(ZEN_HTML, { status: 200 });
    });

    const result = await fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch);
    expect(result.rollingUsageRatio).toBeCloseTo(0.4);
    expect(result.rollingResetSeconds).toBe(1800);
  });
});
