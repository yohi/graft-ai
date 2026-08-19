import { describe, expect, it, vi } from "vitest";
import { fetchOpenCodeGoMetrics } from "../../src/provider-metrics/opencodego";

const MOCK_WORKSPACE_HTML = `<script>self.__next_f=[["wrk_abc123"]]</script>`;

const MOCK_USAGE_HTML = `
<script id="__NEXT_DATA__" type="application/json">
{
  "props": {
    "pageProps": {
      "subscription": {
        "usagePercent": 30,
        "weeklyUsagePercent": 15,
        "monthlyUsagePercent": 50,
        "resetInSec": 3600,
        "weeklyResetInSec": 86400,
        "monthlyResetInSec": 1296000
      }
    }
  }
}
</script>`;

const MOCK_ZEN_HTML = `<script>{"zenBalance":23.45}</script>`;

const MOCK_USAGE_TOP_LEVEL_JSON = JSON.stringify({
  usagePercent: 42,
  weeklyUsagePercent: 20,
  monthlyUsagePercent: 60,
  resetInSec: 1800,
  weeklyResetInSec: 43200,
  monthlyResetInSec: 648000,
});

const MOCK_USAGE_RSC_HTML = `<script>
self.__next_f.push(["rollingUsage", {"usagePercent": 55, "resetInSec": 900}])
self.__next_f.push(["weeklyUsage", {"weeklyUsagePercent": 25, "weeklyResetInSec": 1800}])
self.__next_f.push(["monthlyUsage", {"monthlyUsagePercent": 65, "monthlyResetInSec": 3600}])
</script>`;

const MOCK_USAGE_SOLIDSTART_HTML = `<script>
window._$HY||(e=>{});
self.$R=self.$R||[];
_$HY.r["userEmail[\"wrk_01KCS72BF56XAPBNN6A0HFKECP\"]"]=$R[0];
self.$R[0].resolve({"usagePercent": 45, "weeklyUsagePercent": 20, "monthlyUsagePercent": 50, "resetInSec": 1200, "weeklyResetInSec": 7200, "monthlyResetInSec": 86400});
</script>`;

const MOCK_USAGE_TEXT_BODY = `page content "usagePercent": 72, "resetInSec": 600 more content`;

describe("fetchOpenCodeGoMetrics", () => {
  it("parses usage ratios from embedded JSON", async () => {
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      if (call === 2) return new Response(MOCK_USAGE_HTML, { status: 200 });
      return new Response(MOCK_ZEN_HTML, { status: 200 });
    });

    const result = await fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch);

    expect(result.rollingUsageRatio).toBeCloseTo(0.3);
    expect(result.weeklyUsageRatio).toBeCloseTo(0.15);
    expect(result.monthlyUsageRatio).toBeCloseTo(0.5);
    expect(result.rollingResetSeconds).toBe(3600);
    expect(result.weeklyResetSeconds).toBe(86400);
    expect(result.monthlyResetSeconds).toBe(1296000);
    expect(result.zenBalanceUSD).toBe(23.45);
  });

  it("uses workspaceIdOverride when provided", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("7abeebee")) {
        return new Response(MOCK_USAGE_HTML, { status: 200 });
      }
      return new Response(MOCK_ZEN_HTML, { status: 200 });
    });

    await fetchOpenCodeGoMetrics("session=abc", "wrk_override", mockFetch);

    const urls = (mockFetch.mock.calls as [string, RequestInit][]).map(([url]) => url);
    expect(urls.some((url) => url.includes("_server") && url.includes("def399"))).toBe(false);
    expect(urls.some((url) => url.includes("7abeebee") && url.includes("wrk_override"))).toBe(true);
  });

  it("discovers the workspace when workspaceIdOverride is blank", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("_server") && url.includes("def399")) {
        return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      }
      if (url.includes("7abeebee")) {
        return new Response(MOCK_USAGE_HTML, { status: 200 });
      }
      return new Response(MOCK_ZEN_HTML, { status: 200 });
    });

    await fetchOpenCodeGoMetrics("session=abc", "   ", mockFetch);

    const urls = (mockFetch.mock.calls as [string, RequestInit][]).map(([url]) => url);
    expect(urls.some((url) => url.includes("def399"))).toBe(true);
    expect(urls.some((url) => url.includes("7abeebee") && url.includes("wrk_abc123"))).toBe(true);
  });

  it("sends Cookie header and normalizes raw tokens", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("_server") && url.includes("def399")) {
        return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      }
      if (url.includes("7abeebee")) return new Response(MOCK_USAGE_HTML, { status: 200 });
      return new Response(MOCK_ZEN_HTML, { status: 200 });
    });

    await fetchOpenCodeGoMetrics("__Secure-session=xyz", undefined, mockFetch);

    for (const [, init] of mockFetch.mock.calls as [string, RequestInit][]) {
      const headers = new Headers(init.headers);
      expect(headers.get("Cookie")).toContain("__Secure-session=xyz");
    }
  });

  it("sets follow redirects for RPC requests", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      expect(init.redirect).toBe("follow");
      if (url.includes("_server") && url.includes("def399")) {
        return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      }
      if (url.includes("c7389bd0") || url.includes("7abeebee")) {
        return new Response(MOCK_USAGE_HTML, { status: 200 });
      }
      return new Response(MOCK_ZEN_HTML, { status: 200 });
    });

    await fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch);
  });

  it("sends X-Server-Id and X-Server-Instance headers for _server requests", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("_server") && url.includes("def399")) {
        return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      }
      if (url.includes("7abeebee")) return new Response(MOCK_USAGE_HTML, { status: 200 });
      return new Response(MOCK_ZEN_HTML, { status: 200 });
    });

    await fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch);

    const calls = mockFetch.mock.calls as [string, RequestInit][];
    const serverCall = calls.find(([url]) => url.includes("_server") && url.includes("def399"));
    expect(serverCall).toBeDefined();
    if (serverCall === undefined) {
      throw new Error("workspace discovery request was not issued");
    }
    const headers = new Headers(serverCall[1].headers);
    expect(headers.get("X-Server-Id")).toBe(
      "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f",
    );
    expect(headers.get("X-Server-Instance")).toMatch(/^server-fn:[0-9a-f-]{36}$/);
  });

  it("throws on HTTP 401 for workspace fetch", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }));

    await expect(fetchOpenCodeGoMetrics("expired-session", undefined, mockFetch)).rejects.toThrow(
      /401|expired|Cookie/i,
    );
  });

  it("retries a transient workspace HTTP 503 before succeeding", async () => {
    let attempts = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("_server") && url.includes("def399")) {
        attempts++;
        if (attempts === 1) return new Response("Unavailable", { status: 503 });
        return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      }
      if (url.includes("7abeebee")) return new Response(MOCK_USAGE_HTML, { status: 200 });
      return new Response(MOCK_ZEN_HTML, { status: 200 });
    });

    await fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch);

    expect(attempts).toBe(2);
  });

  it("returns zenBalanceUSD null when zen fetch fails", async () => {
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      if (call === 2) return new Response(MOCK_USAGE_HTML, { status: 200 });
      return new Response("Not Found", { status: 404 });
    });

    const result = await fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch);

    expect(result.zenBalanceUSD).toBeNull();
  });

  it("parses usage from top-level JSON response", async () => {
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      if (call === 2) return new Response(MOCK_USAGE_TOP_LEVEL_JSON, { status: 200 });
      return new Response("{}", { status: 200 });
    });

    const result = await fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch);

    expect(result.rollingUsageRatio).toBeCloseTo(0.42);
    expect(result.rollingResetSeconds).toBe(1800);
  });

  it("parses usage from RSC hydration containing rollingUsage", async () => {
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      if (call === 2) return new Response(MOCK_USAGE_RSC_HTML, { status: 200 });
      return new Response("{}", { status: 200 });
    });

    const result = await fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch);

    expect(result.rollingUsageRatio).toBeCloseTo(0.55);
    expect(result.rollingResetSeconds).toBe(900);
    expect(result.weeklyUsageRatio).toBeCloseTo(0.25);
    expect(result.weeklyResetSeconds).toBe(1800);
    expect(result.monthlyUsageRatio).toBeCloseTo(0.65);
    expect(result.monthlyResetSeconds).toBe(3600);
  });

  it("parses usage from SolidStart resource streaming", async () => {
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      if (call === 2) return new Response(MOCK_USAGE_SOLIDSTART_HTML, { status: 200 });
      return new Response("{}", { status: 200 });
    });

    const result = await fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch);

    expect(result.rollingUsageRatio).toBeCloseTo(0.45);
    expect(result.rollingResetSeconds).toBe(1200);
    expect(result.weeklyUsageRatio).toBeCloseTo(0.2);
    expect(result.weeklyResetSeconds).toBe(7200);
    expect(result.monthlyUsageRatio).toBeCloseTo(0.5);
    expect(result.monthlyResetSeconds).toBe(86400);
  });

  it("parses usage via regex text fallback when no JSON structure found", async () => {
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      if (call === 2) return new Response(MOCK_USAGE_TEXT_BODY, { status: 200 });
      return new Response("{}", { status: 200 });
    });

    const result = await fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch);

    expect(result.rollingUsageRatio).toBeCloseTo(0.72);
  });

  it.each([
    ["rolling usage", `page content "resetInSec": 600 more content`],
    ["rolling reset", `page content "usagePercent": 72 more content`],
  ])("throws when required %s is absent", async (_field, body) => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("_server") && url.includes("def399")) {
        return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      }
      if (url.includes("7abeebee")) return new Response(body, { status: 200 });
      return new Response("{}", { status: 200 });
    });

    await expect(fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch)).rejects.toThrow();
  });

  it("uses the workspace ID in the optional billing request", async () => {
    let call = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      if (call === 2) return new Response(MOCK_USAGE_HTML, { status: 200 });
      throw new TypeError("billing endpoint unavailable");
    });

    const result = await fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch);
    const billingCall = (mockFetch.mock.calls as [string, RequestInit][])[2];

    expect(result.zenBalanceUSD).toBeNull();
    expect(billingCall?.[0]).toBe(
      "https://opencode.ai/_server?id=c83b78a614689c38ebee981f9b39a8b377716db85c1fd7dbab604adc02d3313d&args=%5B%22wrk_abc123%22%5D",
    );
    expect(new Headers(billingCall?.[1].headers).get("X-Server-Id")).toBe(
      "c83b78a614689c38ebee981f9b39a8b377716db85c1fd7dbab604adc02d3313d",
    );
  });

  it("falls back to billing RPC when subscription RPC returns explicit null payload", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("_server") && url.includes("def399")) {
        return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      }
      if (url.includes("7abeebee")) {
        // Real null response returned by opencode.ai for pay-as-you-go workspaces
        return new Response(
          ';0x00000051;((self.$R=self.$R||{})["server-fn:a6e760b8-2733-4fc6-a764-a3f84559c8e8"]=[],null)',
          { status: 200 },
        );
      }
      if (url.includes("c83b78a6")) {
        return new Response(
          '{"customerID":"cust_123","monthlyUsage":500000000,"monthlyLimit":20,"balance":1500000000,"subscription":null}',
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    });

    const result = await fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch);

    expect(result.rollingUsageRatio).toBeCloseTo(0.25); // 5.0 / 20.0
    expect(result.monthlyUsageRatio).toBeCloseTo(0.25);
    expect(result.zenBalanceUSD).toBeCloseTo(15.0);
  });

  it("clamps ratio to 0 when billing monthlyUsage is negative", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("_server") && url.includes("def399")) {
        return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      }
      if (url.includes("7abeebee")) {
        return new Response("null", { status: 200 });
      }
      if (url.includes("c83b78a6")) {
        return new Response(
          '{"customerID":"cust_123","monthlyUsage":-500000000,"monthlyLimit":20,"balance":1500000000}',
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    });

    const result = await fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch);

    expect(result.rollingUsageRatio).toBe(0);
    expect(result.monthlyUsageRatio).toBe(0);
  });

  it("throws OpenCodeGoFetchError explaining unresolved usage when subscription is null and billing fails", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("_server") && url.includes("def399")) {
        return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      }
      if (url.includes("7abeebee")) {
        return new Response("null", { status: 200 });
      }
      if (url.includes("c83b78a6")) {
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    await expect(fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch)).rejects.toThrow(
      /Could not resolve subscription or billing usage for workspace/i,
    );
  });

  it("extracts billing from array structures and nested objects in billing response", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("_server") && url.includes("def399")) {
        return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
      }
      if (url.includes("7abeebee")) {
        return new Response("null", { status: 200 });
      }
      if (url.includes("c83b78a6")) {
        return new Response(
          JSON.stringify([
            { dummy: true },
            { nested: { monthlyUsage: 200000000, monthlyLimit: 10, balance: 500000000 } },
          ]),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    });

    const result = await fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch);

    expect(result.rollingUsageRatio).toBeCloseTo(0.2);
    expect(result.monthlyUsageRatio).toBeCloseTo(0.2);
    expect(result.zenBalanceUSD).toBeCloseTo(5.0);
  });

  it.each([401, 403])(
    "rethrows subscription HTTP %i authentication error when billing fallback returns no info",
    async (status) => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("_server") && url.includes("def399")) {
          return new Response(MOCK_WORKSPACE_HTML, { status: 200 });
        }
        if (url.includes("7abeebee")) {
          return new Response("Unauthorized", { status });
        }
        if (url.includes("c83b78a6")) {
          return new Response("Unauthorized", { status });
        }
        return new Response("{}", { status: 200 });
      });

      await expect(fetchOpenCodeGoMetrics("session=abc", undefined, mockFetch)).rejects.toThrow(
        new RegExp(`OpenCodeGo: HTTP ${status} — Cookie expired, update OPENCODEGO_SESSION_COOKIE`),
      );
    },
  );
});
