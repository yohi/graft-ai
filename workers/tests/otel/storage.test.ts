import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  exportObjectKey,
  payloadStoreForPointer,
  payloadStoreForWrite,
  queueDeliveryDelaySeconds,
  resolvePayloadStoreBackend,
} from "../../src/otel/storage";
import type { OtelEnv } from "../../src/otel/types";

const otelEnv = env as unknown as OtelEnv;
const configuredBackends = otelEnv.OTEL_OBJECTS ? (["kv", "r2"] as const) : (["kv"] as const);

describe.each(configuredBackends)("%s payload store", (backend) => {
  it("writes JSON with a checksum and records its backend", async () => {
    const store = payloadStoreForWrite({
      ...otelEnv,
      OTEL_PAYLOAD_STORE: backend,
    });
    const pointer = await store.putJsonObject(
      `otel/test/${crypto.randomUUID()}.json`,
      { safe: "[REDACTED]" },
      "ingress",
    );

    expect(pointer.schemaVersion).toBe(2);
    expect(pointer.storageBackend).toBe(backend);
    await expect(store.readJsonObject(pointer)).resolves.toEqual({
      safe: "[REDACTED]",
    });

    await expect(store.deleteObject(pointer)).resolves.toBeUndefined();
    await expect(store.deleteObject(pointer)).resolves.toBeUndefined();
  });

  it("marks JSON under export paths with export metadata", async () => {
    const store = payloadStoreForWrite({
      ...otelEnv,
      OTEL_PAYLOAD_STORE: backend,
    });
    const objectKey = exportObjectKey("tempo", crypto.randomUUID(), "2026-08-25");
    const pointer = await store.putJsonObject(objectKey, { safe: "[REDACTED]" }, "export");

    if (backend === "kv") {
      const namespace = otelEnv.OTEL_PAYLOAD_KV;
      if (!namespace) throw new Error("KV binding is missing");
      const stored = await namespace.getWithMetadata(objectKey, { type: "arrayBuffer" });
      expect(stored.metadata).toMatchObject({ kind: "export" });
    } else {
      const bucket = otelEnv.OTEL_OBJECTS;
      if (!bucket) throw new Error("R2 binding is missing");
      const stored = await bucket.head(objectKey);
      expect(stored?.customMetadata).toMatchObject({ kind: "export" });
    }

    await expect(store.deleteObject(pointer)).resolves.toBeUndefined();
  });
});

it.skipIf(!otelEnv.OTEL_PAYLOAD_KV)("records the explicit kind for a JSON payload", async () => {
  const payloadKv = otelEnv.OTEL_PAYLOAD_KV;
  if (!payloadKv) throw new Error("KV payload binding is unavailable");
  const store = payloadStoreForWrite({ ...otelEnv, OTEL_PAYLOAD_STORE: "kv" });
  const objectKey = `otel/custom/${crypto.randomUUID()}.json`;
  const pointer = await store.putJsonObject(objectKey, { safe: "[REDACTED]" }, "export");

  const stored = await payloadKv.getWithMetadata<{ kind: "ingress" | "export" }>(objectKey, {
    type: "arrayBuffer",
  });

  expect(stored.metadata?.kind).toBe("export");
  await store.deleteObject(pointer);
});

it("defaults an unset selector to KV and rejects an unsupported selector", () => {
  expect(resolvePayloadStoreBackend(undefined)).toBe("kv");
  expect(resolvePayloadStoreBackend(" ")).toBe("kv");
  expect(() => resolvePayloadStoreBackend("d1")).toThrow(/OTEL_PAYLOAD_STORE/);
});

it.skipIf(!otelEnv.OTEL_OBJECTS)(
  "uses R2 for a legacy pointer even when new payloads use KV",
  async () => {
    const key = `otel/test/legacy-${crypto.randomUUID()}.json`;
    const r2Store = payloadStoreForWrite({ ...otelEnv, OTEL_PAYLOAD_STORE: "r2" });
    const pointer = await r2Store.putJsonObject(key, { safe: "[REDACTED]" }, "ingress");
    const legacyPointer = {
      schemaVersion: 1,
      id: pointer.id,
      objectKey: pointer.objectKey,
      sha256: pointer.sha256,
      contentType: pointer.contentType,
      createdAtMs: pointer.createdAtMs,
    } as const;

    await expect(
      payloadStoreForPointer(
        { ...otelEnv, OTEL_PAYLOAD_STORE: "kv" },
        legacyPointer,
      ).readJsonObject(legacyPointer),
    ).resolves.toEqual({ safe: "[REDACTED]" });
  },
);

it("delays only KV-backed first delivery", () => {
  const kvPointer = {
    schemaVersion: 2,
    id: "kv",
    objectKey: "otel/test/kv.json",
    sha256: "a".repeat(64),
    contentType: "application/json",
    createdAtMs: 1,
    storageBackend: "kv",
  } as const;
  const r2Pointer = { ...kvPointer, id: "r2", storageBackend: "r2" } as const;
  const legacyPointer = { ...kvPointer, id: "legacy", schemaVersion: 1 } as const;

  expect(queueDeliveryDelaySeconds(kvPointer)).toBe(60);
  expect(queueDeliveryDelaySeconds(r2Pointer)).toBe(0);
  expect(queueDeliveryDelaySeconds(legacyPointer)).toBe(0);
});
