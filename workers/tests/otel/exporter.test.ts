import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueBackendJob, exportPointer } from "../../src/otel/exporter";
import { sha256Hex } from "../../src/otel/storage";
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(otelEnv.GRAFANA_CLOUD_OTLP_TRACES_URL);
      expect(init?.headers).toMatchObject({
        "content-type": "application/json",
        authorization: "Basic tempo-token",
      });
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(exportPointer(pointer, otelEnv)).resolves.toEqual({
      kind: "success",
      status: 200,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
});
