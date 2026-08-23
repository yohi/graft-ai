import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { enqueueBackendJob } from "../../src/otel/exporter";
import { handleQueue } from "../../src/otel/queue";
import { sha256Hex } from "../../src/otel/storage";
import type { JobDescriptor, OtelEnv, QueuePointer } from "../../src/otel/types";

const otelEnv = {
  ...(env as unknown as OtelEnv),
  GRAFANA_CLOUD_OTLP_TRACES_URL: "https://tempo.example/v1/traces",
  GRAFANA_CLOUD_OTLP_AUTHORIZATION: "Basic tempo-token",
} as OtelEnv;

describe("OTel backend Queue consumer", () => {
  it("acknowledges a successful export and does not post a duplicate", async () => {
    const bytes = new TextEncoder().encode('{"resourceSpans":[]}');
    const descriptor: JobDescriptor = {
      jobId: "queue-tempo-job",
      backend: "tempo",
      contentType: "application/json",
      identity: { kind: "trace", traceId: "00112233445566778899aabbccddeeff" },
      payloadSha256: await sha256Hex(bytes),
    };
    const pointer = await enqueueBackendJob(otelEnv, descriptor, bytes);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions: string[] = [];
    const message = {
      body: pointer,
      attempts: 1,
      id: "message-1",
      timestamp: new Date(),
      ack: () => actions.push("ack"),
      retry: () => actions.push("retry"),
    } as unknown as Message<QueuePointer>;
    const batch = {
      queue: "graft-ai-aig-otel-tempo-v1",
      messages: [message],
    } as unknown as MessageBatch<QueuePointer>;

    await handleQueue(batch, otelEnv, {} as ExecutionContext);
    await handleQueue(batch, otelEnv, {} as ExecutionContext);

    expect(actions).toEqual(["ack", "ack"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets terminal export failures reach the DLQ without retrying", async () => {
    const bytes = new TextEncoder().encode('{"resourceSpans":[]}');
    const descriptor: JobDescriptor = {
      jobId: "queue-terminal-job",
      backend: "tempo",
      contentType: "application/json",
      identity: { kind: "trace", traceId: "ffeeddccbbaa99887766554433221100" },
      payloadSha256: await sha256Hex(bytes),
    };
    const pointer = await enqueueBackendJob(otelEnv, descriptor, bytes);
    const fetchMock = vi.fn(async () => new Response(null, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const actions: string[] = [];
    const message = {
      body: pointer,
      attempts: 1,
      id: "message-terminal",
      timestamp: new Date(),
      ack: () => actions.push("ack"),
      retry: () => actions.push("retry"),
    } as unknown as Message<QueuePointer>;
    const batch = {
      queue: "graft-ai-aig-otel-tempo-v1",
      messages: [message],
    } as unknown as MessageBatch<QueuePointer>;

    await expect(handleQueue(batch, otelEnv, {} as ExecutionContext)).rejects.toThrow("DLQ");

    expect(actions).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
