import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { validOtlpJson } from "./fixtures";
import { parseOtlpJson } from "../../src/otel/otlp";
import { redactSpan } from "../../src/otel/redaction";

const otelEnv = env as unknown as {
  readonly OTEL_TRACE_AGGREGATE: DurableObjectNamespace;
  readonly OTEL_OBJECTS: R2Bucket;
};

describe("TraceAggregate", () => {
  it("deduplicates an ingress ID across Durable Object eviction", async () => {
    const trace = parseOtlpJson(validOtlpJson)[0];
    if (!trace) throw new Error("fixture did not produce a span");
    const stub = otelEnv.OTEL_TRACE_AGGREGATE.getByName(trace.traceId);
    const body = {
      ingressId: "ingress-1",
      receivedAtMs: 1_000,
      spans: [redactSpan(trace)],
    };

    const first = await stub.fetch("https://trace/ingest", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(await first.json()).toMatchObject({ accepted: true });

    const duplicate = await stub.fetch("https://trace/ingest", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(await duplicate.json()).toMatchObject({ accepted: false, reason: "duplicate" });
  });

  it("queues sampled Tempo and Loki payloads after the idle alarm", async () => {
    const trace = parseOtlpJson(validOtlpJson)[0];
    if (!trace) throw new Error("fixture did not produce a span");
    const stub = otelEnv.OTEL_TRACE_AGGREGATE.getByName(`export-${crypto.randomUUID()}`);
    const body = {
      ingressId: `ingress-${crypto.randomUUID()}`,
      receivedAtMs: Date.now(),
      spans: [redactSpan(trace)],
    };

    await stub.fetch("https://trace/ingest", { method: "POST", body: JSON.stringify(body) });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    const tempoObjects = await otelEnv.OTEL_OBJECTS.list({ prefix: "otel/export/tempo/" });
    const lokiObjects = await otelEnv.OTEL_OBJECTS.list({ prefix: "otel/export/loki/" });
    expect(tempoObjects.objects.length).toBe(1);
    expect(lokiObjects.objects.length).toBe(1);
  });
});
