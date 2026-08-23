import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { readJsonObject, putJsonObject } from "../../src/otel/storage";
import type { OtelEnv } from "../../src/otel/types";

const otelEnv = env as unknown as OtelEnv;

describe("R2 object storage", () => {
  it("writes JSON with a checksum and rejects changed bytes", async () => {
    const key = `otel/test/${crypto.randomUUID()}.json`;
    const pointer = await putJsonObject(otelEnv.OTEL_OBJECTS, key, {
      safe: "[REDACTED]",
    });

    await expect(readJsonObject(otelEnv.OTEL_OBJECTS, pointer)).resolves.toEqual({
      safe: "[REDACTED]",
    });
    await otelEnv.OTEL_OBJECTS.put(key, "changed");
    await expect(readJsonObject(otelEnv.OTEL_OBJECTS, pointer)).rejects.toThrow(
      /checksum|content type|metadata/i,
    );
  });
});
