import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validOtlpJson } from "./fixtures";
import { TRACE_IDLE_ALARM_MS } from "../../src/otel/contracts";
import { parseOtlpJson } from "../../src/otel/otlp";
import { redactSpan } from "../../src/otel/redaction";
import { payloadStoreForPointer, resolvePayloadStoreBackend } from "../../src/otel/storage";
import { TraceAggregate } from "../../src/otel/trace-aggregate";
import type { OtelEnv } from "../../src/otel/types";

const otelEnv = env as unknown as OtelEnv;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TraceAggregate", () => {
  it("deletes completed trace storage during maintenance cleanup", async () => {
    const { state, deleteAlarm, deleteAll } = createTraceAggregateState({
      storedState: {
        traceId: "completed-trace",
        ingressIds: ["ingress-1"],
        spans: [],
        lastReceivedAtMs: 1_000,
        completed: true,
      },
    });
    const aggregate = new TraceAggregate(state, env as unknown as OtelEnv);

    await expect(aggregate.cleanup()).resolves.toEqual({ kind: "deleted" });
    expect(deleteAlarm).toHaveBeenCalledOnce();
    expect(deleteAll).toHaveBeenCalledOnce();
  });

  it("keeps an active trace during maintenance cleanup", async () => {
    const { state, deleteAlarm, deleteAll } = createTraceAggregateState({
      storedState: {
        traceId: "active-trace",
        ingressIds: ["ingress-1"],
        spans: [],
        lastReceivedAtMs: 1_000,
        completed: false,
      },
    });
    const aggregate = new TraceAggregate(state, env as unknown as OtelEnv);

    await expect(aggregate.cleanup()).resolves.toEqual({ kind: "active" });
    expect(deleteAlarm).not.toHaveBeenCalled();
    expect(deleteAll).not.toHaveBeenCalled();
  });

  it("deduplicates an ingress ID across Durable Object eviction", async () => {
    const trace = parseOtlpJson(validOtlpJson)[0];
    if (!trace) throw new Error("fixture did not produce a span");
    const traceId = crypto.randomUUID().replaceAll("-", "");
    const testSpan = { ...redactSpan(trace), traceId };
    const stub = otelEnv.OTEL_TRACE_AGGREGATE.getByName(traceId);
    const testTimeMs = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(testTimeMs);
    const body = {
      ingressId: "ingress-1",
      receivedAtMs: testTimeMs,
      spans: [testSpan],
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

  it("keeps the earlier idle alarm when a later ingress arrives", async () => {
    const trace = parseOtlpJson(validOtlpJson)[0];
    if (!trace) throw new Error("fixture did not produce a span");
    const { alarms, state } = createTraceAggregateState();
    const aggregate = new TraceAggregate(state, env as unknown as OtelEnv);
    const firstReceivedAtMs = Date.now();

    await aggregate.fetch(
      new Request("https://trace/ingest", {
        method: "POST",
        body: JSON.stringify({
          ingressId: "ingress-1",
          receivedAtMs: firstReceivedAtMs,
          spans: [redactSpan(trace)],
        }),
      }),
    );
    await aggregate.fetch(
      new Request("https://trace/ingest", {
        method: "POST",
        body: JSON.stringify({
          ingressId: "ingress-2",
          receivedAtMs: firstReceivedAtMs + 1_000,
          spans: [redactSpan(trace)],
        }),
      }),
    );

    expect(alarms).toEqual([firstReceivedAtMs + TRACE_IDLE_ALARM_MS]);
  });

  it("clamps a stale idle deadline to the current time", async () => {
    const trace = parseOtlpJson(validOtlpJson)[0];
    if (!trace) throw new Error("fixture did not produce a span");
    const { alarms, state } = createTraceAggregateState();
    const aggregate = new TraceAggregate(state, env as unknown as OtelEnv);
    const nowMs = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);

    try {
      await aggregate.fetch(
        new Request("https://trace/ingest", {
          method: "POST",
          body: JSON.stringify({
            ingressId: "stale-ingress",
            receivedAtMs: 1_000,
            spans: [redactSpan(trace)],
          }),
        }),
      );
    } finally {
      nowSpy.mockRestore();
    }

    expect(alarms).toEqual([nowMs]);
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
    const tempoSend = vi.spyOn(otelEnv.OTEL_TEMPO_QUEUE, "send");
    const lokiSend = vi.spyOn(otelEnv.OTEL_LOKI_QUEUE, "send");

    await stub.fetch("https://trace/ingest", { method: "POST", body: JSON.stringify(body) });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    const tempoPointer = tempoSend.mock.calls.at(-1)?.[0];
    const lokiPointer = lokiSend.mock.calls.at(-1)?.[0];
    if (!tempoPointer || !lokiPointer) throw new Error("sampled pointers were not queued");
    if (tempoPointer.schemaVersion !== 2 || lokiPointer.schemaVersion !== 2) {
      throw new Error("sampled pointers are not current");
    }
    const expectedBackend = resolvePayloadStoreBackend(otelEnv.OTEL_PAYLOAD_STORE);
    expect(tempoPointer.storageBackend).toBe(expectedBackend);
    expect(lokiPointer.storageBackend).toBe(expectedBackend);
    await expect(
      payloadStoreForPointer(otelEnv, tempoPointer).readBytesObject(tempoPointer),
    ).resolves.toBeInstanceOf(Uint8Array);
    await expect(
      payloadStoreForPointer(otelEnv, lokiPointer).readBytesObject(lokiPointer),
    ).resolves.toBeInstanceOf(Uint8Array);
  });
});

function createTraceAggregateState({ storedState: initialState }: { storedState?: unknown } = {}): {
  state: DurableObjectState;
  alarms: number[];
  deleteAlarm: ReturnType<typeof vi.fn>;
  deleteAll: ReturnType<typeof vi.fn>;
} {
  let storedState: unknown = initialState;
  const alarms: number[] = [];
  const deleteAlarm = vi.fn(async (): Promise<void> => undefined);
  const deleteAll = vi.fn(async (): Promise<void> => undefined);
  const storage = {
    get: async <T>(_key: string): Promise<T | undefined> => storedState as T | undefined,
    put: async (_key: string, value: unknown): Promise<void> => {
      storedState = value;
    },
    setAlarm: async (deadlineMs: number): Promise<void> => {
      alarms.push(deadlineMs);
    },
    getAlarm: async (): Promise<number | null> => alarms.at(-1) ?? null,
    deleteAlarm,
    deleteAll,
  };
  const state = {
    storage,
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>): Promise<T> => callback(),
  } as unknown as DurableObjectState;
  return { state, alarms, deleteAlarm, deleteAll };
}
