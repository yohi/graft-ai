import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueBackendJob } from "../../src/otel/exporter";
import { handleQueue } from "../../src/otel/queue";
import { payloadStoreForPointer, sha256Hex } from "../../src/otel/storage";
import type { JobDescriptor, OtelEnv, QueuePointer } from "../../src/otel/types";

const otelEnv = {
  ...(env as unknown as OtelEnv),
  GRAFANA_CLOUD_OTLP_TRACES_URL: "https://tempo.example/v1/traces",
  GRAFANA_CLOUD_OTLP_AUTHORIZATION: "Basic tempo-token",
} as OtelEnv;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
    const dlq = {
      send: vi.fn(async (_pointer: QueuePointer) => undefined),
    } as unknown as Queue<QueuePointer>;
    const testEnv = { ...otelEnv, OTEL_TEMPO_DLQ: dlq } as OtelEnv;
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

    await expect(handleQueue(batch, testEnv, {} as ExecutionContext)).resolves.toBeUndefined();

    expect(actions).toEqual(["ack"]);
    expect(dlq.send).toHaveBeenCalledWith(pointer);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.skipIf(!otelEnv.OTEL_PAYLOAD_KV)("retries a KV payload read after a stale read", async () => {
    const testEnv = { ...otelEnv, OTEL_PAYLOAD_STORE: "kv" } as OtelEnv;
    const bytes = new TextEncoder().encode('{"resourceSpans":[]}');
    const descriptor: JobDescriptor = {
      jobId: `queue-kv-stale-read-${crypto.randomUUID()}`,
      backend: "tempo",
      contentType: "application/json",
      identity: { kind: "trace", traceId: "11223344556677889900aabbccddeeff" },
      payloadSha256: await sha256Hex(bytes),
    };
    const pointer = await enqueueBackendJob(testEnv, descriptor, bytes);
    await payloadStoreForPointer(testEnv, pointer).deleteObject(pointer);

    const message = {
      body: pointer,
      attempts: 1,
      id: "message-kv-stale-read",
      timestamp: new Date(),
      ack: vi.fn(),
      retry: vi.fn(),
    } as unknown as Message<QueuePointer>;
    const batch = {
      queue: "graft-ai-aig-otel-tempo-v1",
      messages: [message],
    } as unknown as MessageBatch<QueuePointer>;

    await handleQueue(batch, testEnv, {} as ExecutionContext);
    await handleQueue(batch, testEnv, {} as ExecutionContext);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenNthCalledWith(1, { delaySeconds: 5 });
    expect(message.retry).toHaveBeenNthCalledWith(2, { delaySeconds: 15 });
    expect(message.retry).toHaveBeenCalledTimes(2);
  });

  it.skipIf(!otelEnv.OTEL_OBJECTS)(
    "sends an R2 payload read failure straight to its DLQ without retrying",
    async () => {
      const testEnv = { ...otelEnv, OTEL_PAYLOAD_STORE: "r2" } as OtelEnv;
      const bytes = new TextEncoder().encode('{"resourceSpans":[]}');
      const descriptor: JobDescriptor = {
        jobId: `queue-r2-temporary-read-${crypto.randomUUID()}`,
        backend: "tempo",
        contentType: "application/json",
        identity: { kind: "trace", traceId: "223344556677889900aabbccddeeff11" },
        payloadSha256: await sha256Hex(bytes),
      };
      const pointer = await enqueueBackendJob(testEnv, descriptor, bytes);
      try {
        const objects = testEnv.OTEL_OBJECTS;
        if (!objects) throw new Error("R2 payload binding is unavailable");
        const getSpy = vi
          .spyOn(objects, "get")
          .mockRejectedValue(new Error("temporary R2 read failure"));

        const actions: string[] = [];
        const dlq = {
          send: vi.fn(async (_pointer: QueuePointer) => undefined),
        } as unknown as Queue<QueuePointer>;
        const testEnvWithDlq = { ...testEnv, OTEL_TEMPO_DLQ: dlq } as OtelEnv;
        const message = {
          body: pointer,
          attempts: 1,
          id: "message-r2-temporary-read",
          timestamp: new Date(),
          ack: () => actions.push("ack"),
          retry: () => actions.push("retry"),
        } as unknown as Message<QueuePointer>;
        const batch = {
          queue: "graft-ai-aig-otel-tempo-v1",
          messages: [message],
        } as unknown as MessageBatch<QueuePointer>;

        await handleQueue(batch, testEnvWithDlq, {} as ExecutionContext);

        expect(getSpy).toHaveBeenCalled();
        expect(actions).toEqual(["ack"]);
        expect(dlq.send).toHaveBeenCalledWith(pointer);
      } finally {
        await payloadStoreForPointer(testEnv, pointer).deleteObject(pointer);
      }
    },
  );

  it.skipIf(!otelEnv.OTEL_PAYLOAD_KV)(
    "retries a KV payload read after a temporary failure with escalating delays",
    async () => {
      const testEnv = { ...otelEnv, OTEL_PAYLOAD_STORE: "kv" } as OtelEnv;
      const bytes = new TextEncoder().encode('{"resourceSpans":[]}');
      const descriptor: JobDescriptor = {
        jobId: `queue-kv-temporary-read-${crypto.randomUUID()}`,
        backend: "tempo",
        contentType: "application/json",
        identity: { kind: "trace", traceId: "33445566778899aabbccddeeff112233" },
        payloadSha256: await sha256Hex(bytes),
      };
      const pointer = await enqueueBackendJob(testEnv, descriptor, bytes);

      const kvNamespace = testEnv.OTEL_PAYLOAD_KV;
      if (!kvNamespace) throw new Error("KV payload binding is unavailable");
      const getSpy = vi
        .spyOn(kvNamespace, "getWithMetadata")
        .mockRejectedValue(new Error("temporary KV read failure"));

      const dlq = {
        send: vi.fn(async (_pointer: QueuePointer) => undefined),
      } as unknown as Queue<QueuePointer>;
      const testEnvWithDlq = { ...testEnv, OTEL_TEMPO_DLQ: dlq } as OtelEnv;
      const message = {
        body: pointer,
        attempts: 1,
        id: "message-kv-temporary-read",
        timestamp: new Date(),
        ack: vi.fn(),
        retry: vi.fn(),
      } as unknown as Message<QueuePointer>;
      const batch = {
        queue: "graft-ai-aig-otel-tempo-v1",
        messages: [message],
      } as unknown as MessageBatch<QueuePointer>;

      await handleQueue(batch, testEnvWithDlq, {} as ExecutionContext);
      await handleQueue(batch, testEnvWithDlq, {} as ExecutionContext);
      await handleQueue(batch, testEnvWithDlq, {} as ExecutionContext);
      await handleQueue(batch, testEnvWithDlq, {} as ExecutionContext);
      await handleQueue(batch, testEnvWithDlq, {} as ExecutionContext);

      expect(message.ack).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenNthCalledWith(1, { delaySeconds: 5 });
      expect(message.retry).toHaveBeenNthCalledWith(2, { delaySeconds: 15 });
      expect(message.retry).toHaveBeenNthCalledWith(3, { delaySeconds: 30 });
      expect(message.retry).toHaveBeenNthCalledWith(4, { delaySeconds: 60 });
      expect(message.retry).toHaveBeenNthCalledWith(5, { delaySeconds: 120 });
      expect(message.retry).toHaveBeenCalledTimes(5);
      expect(getSpy).toHaveBeenCalledTimes(5);

      // The 6th failure exhausts the KV propagation budget and moves to DLQ.
      await handleQueue(batch, testEnvWithDlq, {} as ExecutionContext);
      expect(message.ack).toHaveBeenCalledTimes(1);
      expect(dlq.send).toHaveBeenCalledWith(pointer);
    },
  );
});
