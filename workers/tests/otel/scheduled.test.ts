import { describe, expect, it, vi } from "vitest";
import worker from "../../src/otel";
import { D1PayloadStore } from "../../src/otel/storage";
import type { OtelEnv } from "../../src/otel/types";

describe("OTel Worker scheduled handler", () => {
  it("purges expired payloads when OTEL_PAYLOAD_D1 is configured", async () => {
    const deleteExpiredSpy = vi
      .spyOn(D1PayloadStore.prototype, "deleteExpired")
      .mockResolvedValue(5);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const mockEnv = {
      OTEL_PAYLOAD_D1: {} as D1Database,
    } as unknown as OtelEnv;

    const event = {
      cron: "0 4 * * *",
      scheduledTime: Date.now(),
      type: "scheduled",
    } as ScheduledEvent;

    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    await worker.scheduled(event, mockEnv, ctx);

    expect(deleteExpiredSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Removed 5 expired payload records"),
    );

    deleteExpiredSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it("logs and re-throws errors so Cloudflare marks the cron as failed", async () => {
    const purgeError = new Error("D1 temporary lock");
    const deleteExpiredSpy = vi
      .spyOn(D1PayloadStore.prototype, "deleteExpired")
      .mockRejectedValue(purgeError);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const mockEnv = {
      OTEL_PAYLOAD_D1: {} as D1Database,
    } as unknown as OtelEnv;

    const event = {
      cron: "0 4 * * *",
      scheduledTime: Date.now(),
      type: "scheduled",
    } as ScheduledEvent;
    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    await expect(worker.scheduled(event, mockEnv, ctx)).rejects.toThrow("D1 temporary lock");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[D1 Purge] Scheduled purge error:"),
      purgeError,
    );

    deleteExpiredSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("safely completes when OTEL_PAYLOAD_D1 is undefined", async () => {
    const mockEnv = {} as unknown as OtelEnv;
    const event = {
      cron: "0 4 * * *",
      scheduledTime: Date.now(),
      type: "scheduled",
    } as ScheduledEvent;
    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    await expect(worker.scheduled(event, mockEnv, ctx)).resolves.toBeUndefined();
  });
});
