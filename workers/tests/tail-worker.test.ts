import { describe, expect, it, vi } from "vitest";
import tailWorker from "../src/tail-worker";
import type { TailEnv, LokiPushPayload, TelemetryEvent } from "../src/types";

const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };

function buildEnv(overrides: Partial<TailEnv> = {}): TailEnv {
  return {
    GRAFANA_CLOUD_LOKI_URL: "https://logs-prod-xxx.grafana.net",
    GRAFANA_CLOUD_LOKI_USERNAME: "123456",
    GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "glc_testtoken",
    GATEWAY_NAME: "main",
    ENV_LABEL: "prod",
    ...overrides,
  };
}

function buildTraceItem(logMessages: readonly unknown[]): TraceItem {
  return {
    event: null,
    eventTimestamp: 1_720_032_000_000,
    logs: logMessages.map((message, index) => ({
      timestamp: 1_720_032_000_000 + index,
      level: "log",
      message,
    })),
    exceptions: [],
    diagnosticsChannelEvents: [],
    scriptName: "graft-ai-aig-proxy",
    outcome: "ok",
    executionModel: "stateless",
    truncated: false,
    cpuTime: 1,
    wallTime: 2,
  };
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

const telemetry: TelemetryEvent = {
  _graft_ai_telemetry: true,
  request_id: "req-tail",
  timestamp: "2024-07-04T00:00:00.000Z",
  model: "@cf/meta/llama-3.1-8b-instruct",
  status_code: 200,
  cache_status: "miss",
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
  duration_ms: 123,
  path: "/v1/chat/completions",
  method: "POST",
  gateway: "main",
  env: "prod",
};

describe("AI Gateway telemetry Tail Worker", () => {
  it("filters marked console logs and pushes transformed Loki payload", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await tailWorker.tail?.(
      [
        buildTraceItem([
          "not-json",
          [JSON.stringify(telemetry)],
          JSON.stringify({ ignored: true }),
        ]),
      ],
      buildEnv(),
      mockCtx as unknown as ExecutionContext,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [input, init] = fetchSpy.mock.calls[0] ?? [];
    if (input === undefined) {
      throw new Error("expected Loki fetch input");
    }
    expect(fetchInputUrl(input)).toBe("https://logs-prod-xxx.grafana.net/loki/api/v1/push");
    expect(typeof init?.body).toBe("string");
    const payload = JSON.parse(String(init?.body)) as LokiPushPayload;
    expect(payload.streams).toHaveLength(1);
    expect(payload.streams[0]?.stream).toEqual({
      model: "llama-3.1-8b-instruct",
      status_code: "200",
      env: "prod",
      gateway: "main",
    });
    const value = payload.streams[0]?.values[0];
    expect(value?.[0]).toBe("1720051200000000000");
    const line = JSON.parse(value?.[1] ?? "{}");
    expect(line).toEqual({
      request_id: "req-tail",
      cache_status: "miss",
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      duration_ms: 123,
      path: "/v1/chat/completions",
      method: "POST",
    });

    vi.restoreAllMocks();
  });

  it("does not push to Loki when no marked telemetry logs are present", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await tailWorker.tail?.(
      [buildTraceItem(["plain log", JSON.stringify({ ignored: true })])],
      buildEnv(),
      mockCtx as unknown as ExecutionContext,
    );

    expect(fetchSpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("merges multiple telemetry logs with same stream labels and sorts values by timestamp", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    // 同一ラベル、異なるタイムスタンプ（順不同で入力）
    const telemetry1 = { ...telemetry, timestamp: "2024-07-04T00:00:01.000Z" };
    const telemetry2 = { ...telemetry, timestamp: "2024-07-04T00:00:03.000Z" };
    const telemetry3 = { ...telemetry, timestamp: "2024-07-04T00:00:02.000Z" };

    await tailWorker.tail?.(
      [
        buildTraceItem([
          JSON.stringify(telemetry1),
          JSON.stringify(telemetry3),
          JSON.stringify(telemetry2),
        ]),
      ],
      buildEnv(),
      mockCtx as unknown as ExecutionContext,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect(typeof init?.body).toBe("string");
    const payload = JSON.parse(String(init?.body)) as LokiPushPayload;

    // 同一ラベルは1つの stream にマージされる
    expect(payload.streams).toHaveLength(1);

    // values はタイムスタンプ昇順にソートされる
    const values = payload.streams[0]?.values ?? [];
    expect(values).toHaveLength(3);
    expect(values[0]?.[0]).toBe("1720051201000000000");
    expect(values[1]?.[0]).toBe("1720051202000000000");
    expect(values[2]?.[0]).toBe("1720051203000000000");

    vi.restoreAllMocks();
  });
});
