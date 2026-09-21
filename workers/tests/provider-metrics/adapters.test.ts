import { describe, expect, it } from "vitest";
import { runAdapters, type RegisteredProvider } from "../../src/provider-metrics/adapters";
import type { ProviderContext, ProviderMetricsEnv } from "../../src/provider-metrics/types";

const env: ProviderMetricsEnv = {
  GRAFANA_CLOUD_PROMETHEUS_URL: "https://prometheus.example",
  GRAFANA_CLOUD_PROMETHEUS_USERNAME: "user",
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "token",
  OPENAI_ADMIN_API_KEY: "openai-key",
  CODEX_ACCESS_TOKEN: "   ",
};

function context(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    fetchFn: fetch,
    scheduledTimeSeconds: 1_000,
    openaiHistoryDays: 1,
    nowSeconds: () => 123,
    monotonicNowMs: () => 0,
    ...overrides,
  };
}

function registryEntry(
  provider: RegisteredProvider["provider"],
  credentialKey: RegisteredProvider["credentialKey"],
  adapter: RegisteredProvider["adapter"],
  primarySourceId = `${provider}-primary`,
): RegisteredProvider {
  return { provider, credentialKey, primarySourceId, adapter };
}

describe("runAdapters", () => {
  it("skips absent or blank credentials without invoking the adapter", async () => {
    let calls = 0;
    const registry = [
      registryEntry("openai_api", "OPENAI_ADMIN_API_KEY", async () => {
        calls += 1;
        return { status: "empty", reason: "no-activity" };
      }),
      registryEntry("codex", "CODEX_ACCESS_TOKEN", async () => {
        calls += 1;
        return { status: "empty", reason: "no-activity" };
      }),
    ];

    const records = await runAdapters(env, context(), registry);

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ provider: "openai_api", status: "attempted" });
    expect(records[1]).toEqual({ provider: "codex", status: "skipped" });
    expect(calls).toBe(1);
  });

  it("runs selected adapters in parallel and preserves registry order", async () => {
    let releaseSlow: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const order: string[] = [];
    const registry = [
      registryEntry("codex", "OPENAI_ADMIN_API_KEY", async () => {
        order.push("slow-start");
        await slow;
        order.push("slow-end");
        return { status: "empty", reason: "no-activity" };
      }),
      registryEntry("openai_api", "OPENAI_ADMIN_API_KEY", async () => {
        order.push("fast");
        return { status: "empty", reason: "no-activity" };
      }),
    ];

    const promise = runAdapters(env, context(), registry);
    await Promise.resolve();
    expect(order).toEqual(["slow-start", "fast"]);
    releaseSlow?.();
    const records = await promise;

    expect(records.map((record) => record.provider)).toEqual(["codex", "openai_api"]);
  });

  it("maps success, empty, and failed outcomes to health records", async () => {
    const registry = [
      registryEntry("openai_api", "OPENAI_ADMIN_API_KEY", async () => ({
        status: "success",
        result: { provider: "openai_api", sources: [], windows: [], costs: [], modelUsage: [] },
      })),
      registryEntry("codex", "OPENAI_ADMIN_API_KEY", async () => ({
        status: "empty",
        reason: "no-supported-window",
      })),
      registryEntry("opencodego", "OPENAI_ADMIN_API_KEY", async () => ({
        status: "failed",
        error: { kind: "network", provider: "opencodego", sourceId: "source" },
      })),
    ];

    const records = await runAdapters(env, context(), registry);

    expect(records.map((record) => record.status)).toEqual(["attempted", "attempted", "attempted"]);
    expect(records.map((record) => record.status === "attempted" && record.health.status)).toEqual([
      "success",
      "empty",
      "failed",
    ]);
  });

  it("measures each adapter at completion rather than batch completion", async () => {
    let releaseSlow: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const ticks = [0, 0, 100, 10_000];
    const timestamps = [1, 2];
    const registry = [
      registryEntry("openai_api", "OPENAI_ADMIN_API_KEY", async () => {
        await slow;
        return { status: "empty", reason: "no-activity" };
      }),
      registryEntry("codex", "OPENAI_ADMIN_API_KEY", async () => ({
        status: "empty",
        reason: "no-activity",
      })),
    ];

    const promise = runAdapters(
      env,
      context({
        monotonicNowMs: () => ticks.shift() ?? 10_000,
        nowSeconds: () => timestamps.shift() ?? 3,
      }),
      registry,
    );
    await Promise.resolve();
    releaseSlow?.();
    const records = await promise;

    expect(
      records.map((record) => record.status === "attempted" && record.health.durationSeconds),
    ).toEqual([10, 0.1]);
    expect(
      records.map((record) => record.status === "attempted" && record.health.timestampSeconds),
    ).toEqual([2, 1]);
  });

  it("isolates an unexpected rejection as an internal failure", async () => {
    const registry = [
      registryEntry(
        "openai_api",
        "OPENAI_ADMIN_API_KEY",
        async () => {
          throw new Error("secret rejection");
        },
        "fixed-source",
      ),
      registryEntry("codex", "OPENAI_ADMIN_API_KEY", async () => ({
        status: "empty",
        reason: "no-activity",
      })),
    ];

    const records = await runAdapters(env, context(), registry);
    const failed = records[0];

    if (failed?.status !== "attempted") throw new Error("expected attempted record");
    expect(failed.outcome).toEqual({
      status: "failed",
      error: { kind: "internal", provider: "openai_api", sourceId: "fixed-source" },
    });
    expect(records[1]).toMatchObject({ provider: "codex", status: "attempted" });
  });
});
