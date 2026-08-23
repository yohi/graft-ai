import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleIngress, handleQueue } from "../../src/otel";
import type { Backend } from "../../src/otel/contracts";
import { sha256Hex } from "../../src/otel/storage";
import type {
  ExportPointer,
  IngressPointer,
  JobDescriptor,
  OtelEnv,
  QueuePointer,
} from "../../src/otel/types";
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

    const beforeIngress = await objectKeys("otel/ingress/");
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

    const ingressKey = await newObjectKey("otel/ingress/", beforeIngress);
    const ingressBytes = await readObject(ingressKey);
    const ingressText = new TextDecoder().decode(ingressBytes);
    expect(ingressText).toContain("[REDACTED]");
    expect(ingressText).not.toContain("sk-live-test-secret");
    const ingressPointer = await ingressPointerFor(ingressKey, ingressBytes);

    const ingressBatch = createMessageBatch<QueuePointer>("graft-ai-aig-otel-ingress-v1", [
      { body: ingressPointer, id: "pipeline-ingress", timestamp: new Date(), attempts: 1 },
    ]);
    const ingressContext = createExecutionContext();
    await handleQueue(ingressBatch, otelEnv, ingressContext);
    expect(await getQueueResult(ingressBatch, ingressContext)).toMatchObject({
      explicitAcks: ["pipeline-ingress"],
    });

    const trace = otelEnv.OTEL_TRACE_AGGREGATE.getByName(validTraceId);
    const beforeExports = new Set([
      ...(await objectKeys("otel/export/tempo/")),
      ...(await objectKeys("otel/export/loki/")),
      ...(await objectKeys("otel/export/prometheus/")),
    ]);
    await expect(runDurableObjectAlarm(trace)).resolves.toBe(true);

    const metrics = otelEnv.OTEL_METRICS_AGGREGATE.getByName("global");
    await expect(runDurableObjectAlarm(metrics)).resolves.toBe(true);

    const exportKeys = [
      ...(await newObjectKeys("otel/export/tempo/", beforeExports)),
      ...(await newObjectKeys("otel/export/loki/", beforeExports)),
      ...(await newObjectKeys("otel/export/prometheus/", beforeExports)),
    ];
    expect(exportKeys).toHaveLength(3);

    for (const [index, key] of exportKeys.entries()) {
      const backend = backendFromObjectKey(key);
      const bytes = await readObject(key);
      const pointer = await exportPointerFor(key, bytes, backend);
      const batch = createMessageBatch<QueuePointer>(queueNameFor(backend), [
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

async function objectKeys(prefix: string): Promise<Set<string>> {
  const listed = await otelEnv.OTEL_OBJECTS.list({ prefix });
  return new Set(listed.objects.map((object) => object.key));
}

async function newObjectKeys(
  prefix: string,
  before: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const listed = await otelEnv.OTEL_OBJECTS.list({ prefix });
  return listed.objects.map((object) => object.key).filter((key) => !before.has(key));
}

async function newObjectKey(prefix: string, before: ReadonlySet<string>): Promise<string> {
  const keys = await newObjectKeys(prefix, before);
  const key = keys[0];
  if (!key) throw new Error(`no new R2 object under ${prefix}`);
  return key;
}

async function readObject(key: string): Promise<Uint8Array> {
  const object = await otelEnv.OTEL_OBJECTS.get(key);
  if (!object) throw new Error(`missing R2 object ${key}`);
  return new Uint8Array(await object.arrayBuffer());
}

async function ingressPointerFor(key: string, bytes: Uint8Array): Promise<IngressPointer> {
  const payloadSha256 = await sha256Hex(bytes);
  const ingressId = key.slice(key.lastIndexOf("/") + 1).replace(/\.json$/, "");
  return {
    schemaVersion: 1,
    id: ingressId,
    objectKey: key,
    sha256: payloadSha256,
    contentType: "application/json",
    createdAtMs: Date.now(),
    kind: "ingress",
    ingressId,
  };
}

async function exportPointerFor(
  key: string,
  bytes: Uint8Array,
  backend: Backend,
): Promise<ExportPointer> {
  const sha256 = await sha256Hex(bytes);
  const jobId = key.slice(key.lastIndexOf("/") + 1).replace(/\.json$/, "");
  const identity =
    backend === "prometheus"
      ? { kind: "metrics" as const, windowStartUnixNano: "0", windowEndUnixNano: "1" }
      : { kind: "trace" as const, traceId: validTraceId };
  const descriptor: JobDescriptor = {
    jobId,
    backend,
    contentType: "application/json",
    identity,
    payloadSha256: sha256,
  };
  return {
    schemaVersion: 1,
    id: jobId,
    objectKey: key,
    sha256,
    createdAtMs: Date.now(),
    kind: "export",
    ...descriptor,
  };
}

function backendFromObjectKey(key: string): Backend {
  if (key.includes("/tempo/")) return "tempo";
  if (key.includes("/loki/")) return "loki";
  return "prometheus";
}

function queueNameFor(backend: Backend): string {
  return `graft-ai-aig-otel-${backend}-v1`;
}
