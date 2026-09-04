import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  D1PayloadStore,
  exportObjectKey,
  payloadStoreForPointer,
  payloadStoreForWrite,
  queueDeliveryDelaySeconds,
  resolvePayloadStoreBackend,
} from "../../src/otel/storage";
import type { CurrentObjectPointer, OtelEnv } from "../../src/otel/types";

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

it("defaults an unset selector to D1 and rejects an unsupported selector", () => {
  expect(resolvePayloadStoreBackend(undefined)).toBe("d1");
  expect(resolvePayloadStoreBackend(" ")).toBe("d1");
  expect(resolvePayloadStoreBackend("kv")).toBe("kv");
  expect(resolvePayloadStoreBackend("r2")).toBe("r2");
  expect(() => resolvePayloadStoreBackend("s3")).toThrow(/OTEL_PAYLOAD_STORE/);
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
  const d1Pointer = { ...kvPointer, id: "d1", storageBackend: "d1" } as const;
  const legacyPointer = { ...kvPointer, id: "legacy", schemaVersion: 1 } as const;

  expect(queueDeliveryDelaySeconds(kvPointer)).toBe(60);
  expect(queueDeliveryDelaySeconds(r2Pointer)).toBe(0);
  expect(queueDeliveryDelaySeconds(d1Pointer)).toBe(0);
  expect(queueDeliveryDelaySeconds(legacyPointer)).toBe(0);
});

describe("D1 payload store", () => {
  let mockDb: D1Database;
  let store: D1PayloadStore;
  const rows = new Map<
    string,
    {
      object_key: string;
      sha256: string;
      content_type: string;
      kind: string;
      data: Uint8Array;
      created_at: number;
      expires_at: number;
    }
  >();

  beforeEach(() => {
    rows.clear();
    mockDb = {
      prepare(query: string) {
        return {
          bind(...params: unknown[]) {
            return {
              async run() {
                if (query.startsWith("INSERT OR REPLACE")) {
                  const [object_key, sha256, content_type, kind, data, created_at, expires_at] =
                    params as [string, string, string, string, Uint8Array, number, number];
                  rows.set(object_key, {
                    object_key,
                    sha256,
                    content_type,
                    kind,
                    data,
                    created_at,
                    expires_at,
                  });
                  return { success: true, meta: { changes: 1 } };
                }
                if (query.startsWith("DELETE FROM otel_payloads WHERE object_key")) {
                  const [key] = params as [string];
                  rows.delete(key);
                  return { success: true, meta: { changes: 1 } };
                }
                if (query.startsWith("DELETE FROM otel_payloads WHERE expires_at <")) {
                  const [threshold] = params as [number];
                  let changes = 0;
                  for (const [key, row] of rows.entries()) {
                    if (row.expires_at < threshold) {
                      rows.delete(key);
                      changes += 1;
                    }
                  }
                  return { success: true, meta: { changes } };
                }
                return { success: true, meta: { changes: 0 } };
              },
              async first() {
                if (query.startsWith("SELECT data, sha256, content_type")) {
                  const [key] = params as [string];
                  const row = rows.get(key);
                  if (!row) return null;
                  return { data: row.data, sha256: row.sha256, content_type: row.content_type };
                }
                return null;
              },
            } as unknown as D1PreparedStatement;
          },
        } as unknown as D1Database;
      },
    } as unknown as D1Database;
    store = new D1PayloadStore(mockDb);
  });

  it("writes and reads JSON payload with integrity verification", async () => {
    const key = "otel/ingress/2026-09-04/test-1.json";
    const pointer = await store.putJsonObject(key, { message: "hello d1" }, "ingress");

    expect(pointer.schemaVersion).toBe(2);
    expect(pointer.storageBackend).toBe("d1");

    const read = await store.readJsonObject<{ message: string }>(pointer);
    expect(read).toEqual({ message: "hello d1" });

    await store.deleteObject(pointer);
    await expect(store.readJsonObject(pointer)).rejects.toThrow(/payload object missing/);
  });

  it("rejects oversized payloads before executing a D1 write", async () => {
    const prepare = vi.fn();
    const oversizedDb = { prepare } as unknown as D1Database;
    const oversizedStore = new D1PayloadStore(oversizedDb);
    const oversizedPayload = new Uint8Array(1_900_001);

    await expect(
      oversizedStore.putBytesObject("otel/oversized.json", oversizedPayload, "ingress"),
    ).rejects.toThrow(/D1 payload exceeds safe row size/);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("detects checksum mismatch and throws PayloadStoreIntegrityError", async () => {
    const key = "otel/ingress/2026-09-04/tampered.json";
    const pointer = await store.putJsonObject(key, { valid: true }, "ingress");

    // Tamper row data
    const row = rows.get(key)!;
    row.data = new TextEncoder().encode(JSON.stringify({ valid: false }));

    await expect(store.readJsonObject(pointer)).rejects.toThrow(/checksum mismatch/);
  });

  it("purges expired payloads via deleteExpired", async () => {
    const now = Math.floor(Date.now() / 1000);
    rows.set("old", {
      object_key: "old",
      sha256: "a",
      content_type: "application/json",
      kind: "ingress",
      data: new Uint8Array(),
      created_at: now - 800000,
      expires_at: now - 10,
    });
    rows.set("new", {
      object_key: "new",
      sha256: "b",
      content_type: "application/json",
      kind: "ingress",
      data: new Uint8Array(),
      created_at: now,
      expires_at: now + 604800,
    });

    const deleted = await store.deleteExpired(now);
    expect(deleted).toBe(1);
    expect(rows.has("old")).toBe(false);
    expect(rows.has("new")).toBe(true);
  });

  it("resolves D1 payload store when configured or default", () => {
    const storeDefault = payloadStoreForWrite({
      ...otelEnv,
      OTEL_PAYLOAD_STORE: undefined,
      OTEL_PAYLOAD_D1: mockDb,
    });
    expect(storeDefault).toBeInstanceOf(D1PayloadStore);

    const storeD1 = payloadStoreForWrite({
      ...otelEnv,
      OTEL_PAYLOAD_STORE: "d1",
      OTEL_PAYLOAD_D1: mockDb,
    });
    expect(storeD1).toBeInstanceOf(D1PayloadStore);

    const d1Pointer: CurrentObjectPointer = {
      schemaVersion: 2,
      id: "d1-test",
      objectKey: "otel/ingress/test.json",
      sha256: "a".repeat(64),
      contentType: "application/json",
      createdAtMs: Date.now(),
      storageBackend: "d1",
    };
    const storePointer = payloadStoreForPointer({ ...otelEnv, OTEL_PAYLOAD_D1: mockDb }, d1Pointer);
    expect(storePointer).toBeInstanceOf(D1PayloadStore);

    expect(() =>
      payloadStoreForWrite({
        ...otelEnv,
        OTEL_PAYLOAD_STORE: "d1",
        OTEL_PAYLOAD_D1: undefined,
      }),
    ).toThrow(/OTEL_PAYLOAD_D1 binding is missing/);
  });

  it("classifies D1 database errors correctly", async () => {
    const errorDb = {
      prepare() {
        return {
          bind() {
            return {
              async run() {
                throw new Error("database is locked");
              },
              async first() {
                throw new Error("D1 daily limit exceeded");
              },
            } as unknown as D1PreparedStatement;
          },
        } as unknown as D1Database;
      },
    } as unknown as D1Database;

    const errStore = new D1PayloadStore(errorDb);
    await expect(errStore.putJsonObject("key", { a: 1 }, "ingress")).rejects.toThrow(
      /temporarily unavailable/,
    );
    await expect(
      errStore.readJsonObject({
        schemaVersion: 2,
        id: "1",
        objectKey: "key",
        sha256: "a".repeat(64),
        contentType: "application/json",
        createdAtMs: 1,
        storageBackend: "d1",
      }),
    ).rejects.toThrow(/quota exceeded/);
  });
});
