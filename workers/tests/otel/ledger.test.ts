import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { OtelLedger } from "../../src/otel/ledger";
import type { ExportPointer, IngressPointer, JobDescriptor, OtelEnv } from "../../src/otel/types";

const otelEnv = env as unknown as {
  readonly OTEL_LEDGER: DurableObjectNamespace;
};

async function rpc<T>(stub: DurableObjectStub, operation: string, input: Record<string, unknown>) {
  const response = await stub.fetch("https://ledger/rpc", {
    method: "POST",
    body: JSON.stringify({ operation, ...input }),
  });
  return (await response.json()) as T;
}

describe("OtelLedger", () => {
  it("preserves the earliest alarm across later ledger transitions", async () => {
    const { alarms, state } = createLedgerState();
    const ledger = new OtelLedger(state, env as unknown as OtelEnv);
    const nowMs = Date.now();

    await ledger.reserveIngress({
      ingressId: "ingress-one",
      payloadSha256: "a".repeat(64),
      ownerId: "owner-one",
      fencingToken: "1",
      nowMs,
    });

    const descriptor: JobDescriptor = {
      jobId: "export-one",
      backend: "tempo",
      contentType: "application/json",
      identity: { kind: "trace", traceId: "00112233445566778899aabbccddeeff" },
      payloadSha256: "b".repeat(64),
    };
    await ledger.registerExport(descriptor, nowMs);
    const pointer: ExportPointer = {
      schemaVersion: 1,
      id: descriptor.jobId,
      objectKey: "otel/export/tempo/1970-01-01/export-one.json",
      sha256: descriptor.payloadSha256,
      createdAtMs: nowMs,
      kind: "export",
      ...descriptor,
    };
    await ledger.markExportReady(descriptor.jobId, pointer, nowMs);
    await ledger.claimExport(descriptor.jobId, "export-owner", nowMs);
    await ledger.reserveIngress({
      ingressId: "ingress-two",
      payloadSha256: "c".repeat(64),
      ownerId: "owner-two",
      fencingToken: "2",
      nowMs: nowMs + 1_000,
    });

    expect(alarms).toHaveLength(2);
    expect(alarms[1]).toBeLessThan(alarms[0] ?? Number.POSITIVE_INFINITY);
  });

  it("retains a ready export through the R2 retention failsafe", async () => {
    const stub = otelEnv.OTEL_LEDGER.getByName(`retention-${crypto.randomUUID()}`);
    const nowMs = Date.now();
    const pointer = {
      schemaVersion: 1,
      id: "retention-job",
      objectKey: "otel/export/tempo/1970-01-01/retention-job.json",
      sha256: "a".repeat(64),
      contentType: "application/json",
      createdAtMs: nowMs,
      kind: "export",
      jobId: "retention-job",
      backend: "tempo",
      identity: { kind: "trace", traceId: "00112233445566778899aabbccddeeff" },
      payloadSha256: "a".repeat(64),
    };
    const descriptor = {
      jobId: "retention-job",
      backend: "tempo",
      identity: { kind: "trace", traceId: "00112233445566778899aabbccddeeff" },
      payloadSha256: "a".repeat(64),
      contentType: "application/json",
      createdAtMs: nowMs,
    };
    await expect(rpc(stub, "export.register", { descriptor, nowMs })).resolves.toMatchObject({
      kind: "reserved",
    });
    await expect(
      rpc(stub, "export.ready", { jobId: "retention-job", pointer, nowMs }),
    ).resolves.toBe(true);

    const claim = await rpc<{ kind: string }>(stub, "export.claim", {
      jobId: "retention-job",
      ownerId: "retention-owner",
      nowMs: nowMs + 26 * 60 * 60 * 1_000,
    });
    expect(claim.kind).toBe("claimed");
  });

  it("treats an already-enqueued ingress transition as idempotent", async () => {
    const { state } = createLedgerState();
    const ledger = new OtelLedger(state, env as unknown as OtelEnv);
    const nowMs = Date.now();
    const ingressId = "ingress-idempotent";
    const ownerId = "owner-idempotent";
    const fencingToken = "1";
    const pointer: IngressPointer = {
      schemaVersion: 1,
      id: ingressId,
      objectKey: "otel/ingress/1970-01-01/ingress-idempotent.json",
      sha256: "a".repeat(64),
      contentType: "application/json",
      createdAtMs: nowMs,
      kind: "ingress",
      ingressId,
    };

    await ledger.reserveIngress({
      ingressId,
      payloadSha256: pointer.sha256,
      ownerId,
      fencingToken,
      nowMs,
    });
    await ledger.markIngressReady(ingressId, pointer, ownerId, fencingToken);
    await ledger.markIngressEnqueued(ingressId, ownerId, fencingToken);

    await expect(
      ledger.markIngressEnqueued(ingressId, ownerId, fencingToken),
    ).resolves.toBeUndefined();
    await ledger.completeIngress(ingressId);
    await expect(
      ledger.markIngressEnqueued(ingressId, ownerId, fencingToken),
    ).resolves.toBeUndefined();
  });
});

function createLedgerState(): { state: DurableObjectState; alarms: number[] } {
  let storedState: unknown;
  const alarms: number[] = [];
  const storage = {
    get: async <T>(_key: string): Promise<T | undefined> => storedState as T | undefined,
    put: async (_key: string, value: unknown): Promise<void> => {
      storedState = value;
    },
    setAlarm: async (deadlineMs: number): Promise<void> => {
      alarms.push(deadlineMs);
    },
    getAlarm: async (): Promise<number | null> => alarms.at(-1) ?? null,
  };
  const state = {
    storage,
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>): Promise<T> => callback(),
  } as unknown as DurableObjectState;
  return { state, alarms };
}
