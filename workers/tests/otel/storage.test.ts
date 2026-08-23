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
    const original = await otelEnv.OTEL_OBJECTS.get(key);
    if (!original) throw new Error("stored object missing");
    await otelEnv.OTEL_OBJECTS.put(key, "changed", {
      httpMetadata: original.httpMetadata,
      customMetadata: original.customMetadata,
    });
    await expect(readJsonObject(otelEnv.OTEL_OBJECTS, pointer)).rejects.toThrow(
      "R2 object checksum mismatch",
    );
  });
});
