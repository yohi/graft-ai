import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { enqueueBackendJob } from "../../src/otel/exporter";
import type { JobDescriptor, OtelEnv } from "../../src/otel/types";

const mockLedgerCall = vi.hoisted(() => vi.fn());
const mockDeleteObject = vi.hoisted(() => vi.fn(async () => undefined));
const mockPayloadStoreForWrite = vi.hoisted(() =>
  vi.fn(() => ({
    putBytesObject: vi.fn(async () => ({
      schemaVersion: 2,
      storageBackend: "kv",
      id: "rejected-ready-job",
      objectKey: "object-key",
      sha256: "payload-hash",
      contentType: "application/json",
      createdAtMs: 0,
    })),
    deleteObject: mockDeleteObject,
  })),
);

vi.mock("../../src/otel/ledger", () => ({ ledgerCall: mockLedgerCall }));
vi.mock("../../src/otel/storage", () => ({
  exportObjectKey: vi.fn(() => "object-key"),
  payloadStoreForPointer: vi.fn(),
  payloadStoreForWrite: mockPayloadStoreForWrite,
  queueDeliveryDelaySeconds: vi.fn(() => 0),
  sha256Hex: vi.fn(async () => "payload-hash"),
}));

describe("export cleanup", () => {
  it("releases the reservation and deletes the payload once when ready is rejected", async () => {
    mockLedgerCall.mockImplementation(async (_stub: DurableObjectStub, operation: string) => {
      if (operation === "export.register") return { kind: "reserved" };
      if (operation === "export.ready") return false;
      if (operation === "export.release-reservation") return true;
      throw new Error(`unexpected ledger operation: ${operation}`);
    });
    const descriptor: JobDescriptor = {
      jobId: "rejected-ready-job",
      backend: "tempo",
      contentType: "application/json",
      identity: { kind: "trace", traceId: "00112233445566778899aabbccddeeff" },
      payloadSha256: "payload-hash",
    };

    await expect(
      enqueueBackendJob(env as unknown as OtelEnv, descriptor, new Uint8Array([1, 2, 3])),
    ).rejects.toThrow("export ready transition rejected");
    expect(mockLedgerCall.mock.calls.map(([, operation]) => operation)).toEqual([
      "export.register",
      "export.ready",
      "export.release-reservation",
    ]);
    expect(mockDeleteObject).toHaveBeenCalledTimes(1);
  });
});
