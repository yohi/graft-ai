import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueBackendJob, exportPointer } from "../../src/otel/exporter";
import { payloadStoreForPointer, sha256Hex } from "../../src/otel/storage";
import type { JobDescriptor, OtelEnv } from "../../src/otel/types";

const otelEnv = {
  ...(env as unknown as OtelEnv),
  GRAFANA_CLOUD_OTLP_TRACES_URL: "https://tempo.example/v1/traces",
  GRAFANA_CLOUD_OTLP_METRICS_URL: "https://metrics.example/v1/metrics",
  GRAFANA_CLOUD_OTLP_AUTHORIZATION: "Basic tempo-token",
  GRAFANA_CLOUD_LOKI_URL: "https://loki.example/loki/api/v1/push",
  GRAFANA_CLOUD_LOKI_AUTHORIZATION: "Basic loki-token",
} as OtelEnv;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OTel backend exporter", () => {
  it("persists a redacted payload before queue submission and posts JSON to Tempo", async () => {
    const bytes = new TextEncoder().encode('{"resourceSpans":[]}');
    const descriptor: JobDescriptor = {
      jobId: "tempo-job",
      backend: "tempo",
      contentType: "application/json",
      identity: { kind: "trace", traceId: "00112233445566778899aabbccddeeff" },
      payloadSha256: await sha256Hex(bytes),
    };
    const pointer = await enqueueBackendJob(otelEnv, descriptor, bytes);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(exportPointer(pointer, otelEnv)).resolves.toEqual({
      kind: "success",
      status: 200,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe(otelEnv.GRAFANA_CLOUD_OTLP_TRACES_URL);
    expect(requestInit?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Basic tempo-token",
    });
  });

  it("deletes an export payload once when the ready transition is rejected", async () => {
    const bytes = new TextEncoder().encode('{"resourceSpans":[]}');
    const descriptor: JobDescriptor = {
      jobId: `rejected-ready-${crypto.randomUUID()}`,
      backend: "tempo",
      contentType: "application/json",
      identity: { kind: "trace", traceId: "00112233445566778899aabbccddeeff" },
      payloadSha256: await sha256Hex(bytes),
    };
    const testEnv = { ...otelEnv, OTEL_PAYLOAD_STORE: "kv" } as OtelEnv;
    const payloadKv = testEnv.OTEL_PAYLOAD_KV;
    if (!payloadKv) throw new Error("KV payload binding is unavailable");

    const ledger = testEnv.OTEL_LEDGER.getByName(`rejected-ready-${crypto.randomUUID()}`);
    vi.spyOn(testEnv.OTEL_LEDGER, "getByName").mockReturnValue(ledger);
    const operations: string[] = [];
    vi.spyOn(ledger, "fetch").mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { operation: string };
      operations.push(request.operation);
      if (request.operation === "export.register") return Response.json({ kind: "reserved" });
      if (request.operation === "export.ready") return Response.json(false);
      if (request.operation === "export.release-reservation") return Response.json(true);
      throw new Error(`unexpected ledger operation: ${request.operation}`);
    });
    const deleteSpy = vi.spyOn(payloadKv, "delete");

    await expect(enqueueBackendJob(testEnv, descriptor, bytes)).rejects.toThrow(
      "export ready transition rejected",
    );

    expect(operations).toEqual(["export.register", "export.ready", "export.release-reservation"]);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });

  it("classifies retryable and terminal backend responses", async () => {
    const bytes = new TextEncoder().encode('{"resourceSpans":[]}');
    const retryPointer = await enqueueBackendJob(
      otelEnv,
      {
        jobId: "retry-job",
        backend: "tempo",
        contentType: "application/json",
        identity: { kind: "trace", traceId: "00112233445566778899aabbccddeeff" },
        payloadSha256: await sha256Hex(bytes),
      },
      bytes,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 429, headers: { "retry-after": "4" } })),
    );
    await expect(exportPointer(retryPointer, otelEnv)).resolves.toEqual({
      kind: "retryable",
      reason: "http",
      status: 429,
      retryAfterSeconds: 4,
    });

    const terminalPointer = await enqueueBackendJob(
      otelEnv,
      {
        jobId: "terminal-job",
        backend: "tempo",
        contentType: "application/json",
        identity: { kind: "trace", traceId: "00112233445566778899aabbccddeeff" },
        payloadSha256: await sha256Hex(bytes),
      },
      bytes,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await expect(exportPointer(terminalPointer, otelEnv)).resolves.toEqual({
      kind: "terminal",
      status: 401,
    });
  });

  it("does not overwrite an existing R2 object when a job ID collides", async () => {
    const originalBytes = new TextEncoder().encode('{"resourceSpans":[{"name":"original"}]}');
    const conflictingBytes = new TextEncoder().encode('{"resourceSpans":[{"name":"conflicting"}]}');
    const jobId = `collision-${crypto.randomUUID()}`;

    const original = await enqueueBackendJob(
      otelEnv,
      {
        jobId,
        backend: "tempo",
        contentType: "application/json",
        identity: { kind: "trace", traceId: "00112233445566778899aabbccddeeff" },
        payloadSha256: await sha256Hex(originalBytes),
      },
      originalBytes,
    );
    await expect(
      enqueueBackendJob(
        otelEnv,
        {
          jobId,
          backend: "tempo",
          contentType: "application/json",
          identity: { kind: "trace", traceId: "00112233445566778899aabbccddeeff" },
          payloadSha256: await sha256Hex(conflictingBytes),
        },
        conflictingBytes,
      ),
    ).rejects.toThrow("export job collision");

    await expect(
      payloadStoreForPointer(otelEnv, original).readBytesObject(original),
    ).resolves.toEqual(originalBytes);
  });
});
