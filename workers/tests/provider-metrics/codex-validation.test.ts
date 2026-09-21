import { describe, expect, it, vi } from "vitest";
import { codexAdapter } from "../../src/provider-metrics/codex";
import type {
  AdapterOutcome,
  ProviderContext,
  ProviderMetricsEnv,
  ProviderResult,
} from "../../src/provider-metrics/types";

const ACCESS_TOKEN = "codex-access-token-secret";
const RESPONSE_BODY = "sentinel-codex-response-body";
const SOURCE_ID = "codex-wham-usage";

const MOCK_USAGE_RESPONSE = {
  plan_type: "pro",
  rate_limit: {
    primary_window: { used_percent: 45, reset_at: 1786161204, limit_window_seconds: 18000 },
    secondary_window: { used_percent: 20, reset_at: 1786247604, limit_window_seconds: 604800 },
  },
  credits: { balance: 3.5 },
};

type CodexResult = Extract<ProviderResult, { provider: "codex" }>;

function env(): ProviderMetricsEnv {
  return {
    GRAFANA_CLOUD_PROMETHEUS_URL: "https://prometheus.example",
    GRAFANA_CLOUD_PROMETHEUS_USERNAME: "user",
    GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "token",
    CODEX_ACCESS_TOKEN: ACCESS_TOKEN,
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

function successfulCodex(outcome: AdapterOutcome): CodexResult {
  expect(outcome.status).toBe("success");
  if (outcome.status !== "success" || outcome.result.provider !== "codex") {
    throw new Error("expected a successful Codex result");
  }
  return outcome.result;
}

function expectSchemaFailure(outcome: AdapterOutcome): void {
  expect(outcome).toEqual({
    status: "failed",
    error: { kind: "schema", provider: "codex", sourceId: SOURCE_ID },
  });
  expect(JSON.stringify(outcome)).not.toContain(RESPONSE_BODY);
  expect(JSON.stringify(outcome)).not.toContain(ACCESS_TOKEN);
}

describe("Codex adapter usage response validation", () => {
  it("returns a schema failure when both usage windows are missing", async () => {
    const body = {
      ...MOCK_USAGE_RESPONSE,
      rate_limit: { primary_window: undefined, secondary_window: undefined },
    };
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

    expectSchemaFailure(await codexAdapter(env(), context(fetchFn)));
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
  ])("returns a schema failure for malformed usage object: %s", async (_name, body) => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

    expectSchemaFailure(await codexAdapter(env(), context(fetchFn)));
  });

  it.each([-1, 101, null, "45"])(
    "returns a schema failure for used_percent=%s",
    async (usedPercent) => {
      const body = {
        ...MOCK_USAGE_RESPONSE,
        rate_limit: {
          ...MOCK_USAGE_RESPONSE.rate_limit,
          primary_window: {
            ...MOCK_USAGE_RESPONSE.rate_limit.primary_window,
            used_percent: usedPercent,
          },
        },
      };
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

      expectSchemaFailure(await codexAdapter(env(), context(fetchFn)));
    },
  );

  it.each([-1, 1.5, null, "1786161204"])(
    "returns a schema failure for reset_at=%s",
    async (resetAt) => {
      const body = {
        ...MOCK_USAGE_RESPONSE,
        rate_limit: {
          ...MOCK_USAGE_RESPONSE.rate_limit,
          primary_window: { ...MOCK_USAGE_RESPONSE.rate_limit.primary_window, reset_at: resetAt },
        },
      };
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

      expectSchemaFailure(await codexAdapter(env(), context(fetchFn)));
    },
  );

  it.each([
    ["numeric plan", { ...MOCK_USAGE_RESPONSE, plan_type: 1 }],
    ["null plan", { ...MOCK_USAGE_RESPONSE, plan_type: null }],
    ["boolean balance", { ...MOCK_USAGE_RESPONSE, credits: { balance: true } }],
    ["object balance", { ...MOCK_USAGE_RESPONSE, credits: { balance: {} } }],
  ])("returns a schema failure for %s", async (_name, body) => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

    expectSchemaFailure(await codexAdapter(env(), context(fetchFn)));
  });

  it("omits credits when the upstream credits value is null", async () => {
    const body = { ...MOCK_USAGE_RESPONSE, credits: null };
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

    expect(successfulCodex(await codexAdapter(env(), context(fetchFn))).credits).toBeUndefined();
  });

  it("parses a finite numeric-string credit balance", async () => {
    const body = { ...MOCK_USAGE_RESPONSE, credits: { balance: "3.5" } };
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

    expect(successfulCodex(await codexAdapter(env(), context(fetchFn))).credits).toEqual({
      remaining: 3.5,
    });
  });
});
