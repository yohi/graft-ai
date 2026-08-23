import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

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
});
