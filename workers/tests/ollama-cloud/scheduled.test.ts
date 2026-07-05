import { describe, it, expect, vi } from "vitest";
import worker from "../../src/ollama-cloud";

const baseEnv = {
  OLLAMA_CLOUD_PLAN: "pro",
  GRAFANA_CLOUD_PROMETHEUS_URL: "https://otlp-gateway-prod-us-central1.grafana.net/otlp",
  GRAFANA_CLOUD_PROMETHEUS_USERNAME: "123456",
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "token",
};

describe("ollama-cloud scheduled handler", () => {
  it("pushes metrics when anchor is configured", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    const scheduledEvent = {
      scheduledTime: new Date("2026-01-01T00:00:00Z").getTime(),
      cron: "*/5 * * * *",
    } as ScheduledEvent;

    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    await worker.scheduled(
      scheduledEvent,
      {
        ...baseEnv,
        OLLAMA_CLOUD_RESET_ANCHOR_ISO: "2026-01-01T00:00:00Z",
      } as typeof baseEnv & { OLLAMA_CLOUD_RESET_ANCHOR_ISO: string },
      ctx,
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toBe("https://otlp-gateway-prod-us-central1.grafana.net/otlp/v1/metrics");

    vi.unstubAllGlobals();
  });

  it("logs error and skips when anchor is missing", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const scheduledEvent = {
      scheduledTime: new Date("2026-01-01T00:00:00Z").getTime(),
      cron: "*/5 * * * *",
    } as ScheduledEvent;

    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    await worker.scheduled(
      scheduledEvent,
      {
        ...baseEnv,
        OLLAMA_CLOUD_RESET_ANCHOR_ISO: "",
      } as typeof baseEnv & { OLLAMA_CLOUD_RESET_ANCHOR_ISO: string },
      ctx,
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("OLLAMA_CLOUD_RESET_ANCHOR_ISO"),
    );

    consoleError.mockRestore();
    vi.unstubAllGlobals();
  });
});
