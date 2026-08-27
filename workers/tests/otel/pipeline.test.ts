import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleIngress, handleQueue } from "../../src/otel";
import { resolvePayloadStoreBackend } from "../../src/otel/storage";
import type { ExportPointer, OtelEnv, QueuePointer } from "../../src/otel/types";
import { validOtlpJson, validTraceId } from "./fixtures";

const otelEnv = {
  ...(env as unknown as OtelEnv),
  OTEL_INGEST_TOKEN: "test-token",
  OTEL_RATE_LIMIT_HMAC_KEY: "test-rate-key",
  OTEL_SAMPLING_RATE: "1",
  GRAFANA_CLOUD_OTLP_TRACES_URL: "https://tempo.example/v1/traces",
  GRAFANA_CLOUD_OTLP_METRICS_URL: "https://prometheus.example/v1/metrics",
  GRAFANA_CLOUD_OTLP_AUTHORIZATION: "Basic test-token",
  GRAFANA_CLOUD_LOKI_URL: "https://loki.example/loki/api/v1/push",
  GRAFANA_CLOUD_LOKI_AUTHORIZATION: "Basic test-token",
} as OtelEnv;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OTel Worker pipeline", () => {
  it("routes redacted ingress through trace, metrics, and backend queues", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return new Response(null, { status: 204 });
      }),
    );
    const ingressSend = vi.spyOn(otelEnv.OTEL_INGRESS_QUEUE, "send");
    const tempoSend = vi.spyOn(otelEnv.OTEL_TEMPO_QUEUE, "send");
    const lokiSend = vi.spyOn(otelEnv.OTEL_LOKI_QUEUE, "send");
    const prometheusSend = vi.spyOn(otelEnv.OTEL_PROMETHEUS_QUEUE, "send");

    const ingressResponse = await handleIngress(
      new Request("https://worker.example/v1/traces", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.11",
        },
        body: JSON.stringify(validOtlpJson),
      }),
      otelEnv,
    );
    expect(ingressResponse.status).toBe(200);
    expect(await ingressResponse.json()).toMatchObject({ reason: "accepted" });

    const ingressPointer = ingressSend.mock.calls.at(-1)?.[0];
    if (!ingressPointer) throw new Error("ingress pointer was not queued");
    if (ingressPointer.schemaVersion !== 2) throw new Error("ingress pointer is not current");
    expect(ingressPointer.storageBackend).toBe(
      resolvePayloadStoreBackend(otelEnv.OTEL_PAYLOAD_STORE),
    );

    const ingressBatch = createMessageBatch<QueuePointer>("graft-ai-aig-otel-ingress-v1", [
      { body: ingressPointer, id: "pipeline-ingress", timestamp: new Date(), attempts: 1 },
    ]);
    const ingressContext = createExecutionContext();
    await handleQueue(ingressBatch, otelEnv, ingressContext);
    expect(await getQueueResult(ingressBatch, ingressContext)).toMatchObject({
      explicitAcks: ["pipeline-ingress"],
    });

    const trace = otelEnv.OTEL_TRACE_AGGREGATE.getByName(validTraceId);
    await expect(runDurableObjectAlarm(trace)).resolves.toBe(true);

    const metrics = otelEnv.OTEL_METRICS_AGGREGATE.getByName("global");
    await expect(runDurableObjectAlarm(metrics)).resolves.toBe(true);

    const exportPointers = [
      tempoSend.mock.calls.at(-1)?.[0],
      lokiSend.mock.calls.at(-1)?.[0],
      prometheusSend.mock.calls.at(-1)?.[0],
    ];
    expect(exportPointers.every(Boolean)).toBe(true);

    for (const [index, pointer] of exportPointers.entries()) {
      if (!pointer) throw new Error("export pointer was not queued");
      const batch = createMessageBatch<QueuePointer>(queueNameFor(pointer.backend), [
        { body: pointer, id: `pipeline-export-${index}`, timestamp: new Date(), attempts: 1 },
      ]);
      const context = createExecutionContext();
      await handleQueue(batch, otelEnv, context);
      expect(await getQueueResult(batch, context)).toMatchObject({
        explicitAcks: [`pipeline-export-${index}`],
      });
    }

    expect(requests).toHaveLength(3);
    const bodies = await Promise.all(requests.map((request) => request.clone().text()));
    expect(bodies.join("\n")).toContain("[REDACTED]");
    expect(bodies.join("\n")).not.toContain("sk-live-test-secret");
  });
});

function queueNameFor(backend: ExportPointer["backend"]): string {
  return `graft-ai-aig-otel-${backend}-v1`;
}
