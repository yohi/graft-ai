import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const otelEnv = env as unknown as {
  readonly OTEL_RATE_LIMIT: DurableObjectNamespace;
};

describe("OtelRateLimit", () => {
  it("allows twenty requests, then returns a retry delay until a token refills", async () => {
    const stub = otelEnv.OTEL_RATE_LIMIT.getByName(`rate-${crypto.randomUUID()}`);
    const results: Array<{ readonly allowed: boolean; readonly retryAfterSeconds: number }> = [];
    for (let index = 0; index < 20; index += 1) {
      const response = await stub.fetch("https://rate/take", {
        method: "POST",
        body: JSON.stringify({ sourceHash: "source", nowMs: 0 }),
      });
      expect(response.status).toBe(200);
      results.push((await response.json()) as { allowed: boolean; retryAfterSeconds: number });
    }

    expect(results.every((result) => result.allowed)).toBe(true);
    const limited = await stub.fetch("https://rate/take", {
      method: "POST",
      body: JSON.stringify({ sourceHash: "source", nowMs: 0 }),
    });

    expect(limited.status).toBe(200);
    expect(await limited.json()).toEqual({ allowed: false, retryAfterSeconds: 1 });

    const refilled = await stub.fetch("https://rate/take", {
      method: "POST",
      body: JSON.stringify({ sourceHash: "source", nowMs: 500 }),
    });
    expect(await refilled.json()).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });
});
