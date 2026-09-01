import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { payloadStoreForPointer, resolvePayloadStoreBackend } from "../../src/otel/storage";
import type { MetricSample, OtelEnv } from "../../src/otel/types";

const otelEnv = env as OtelEnv;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OtelMetricsAggregate", () => {
  it("deduplicates samples and flushes at the two-hundred-sample bound", async () => {
    const stub = otelEnv.OTEL_METRICS_AGGREGATE.getByName(`metrics-${crypto.randomUUID()}`);
    const nowMs = Date.now();
    const base: MetricSample = {
      sampleId: "base-sample",
      name: "ai_gateway_requests_total",
      kind: "sum",
      value: 1,
      labels: { env: "prod", gateway: "main" },
    };

    const first = await stub.fetch("https://metrics/append", {
      method: "POST",
      body: JSON.stringify({ samples: [base], nowMs }),
    });
    expect(await first.json()).toMatchObject({ accepted: 1, pending: 1, flushed: false });

    const duplicate = await stub.fetch("https://metrics/append", {
      method: "POST",
      body: JSON.stringify({ samples: [{ ...base, value: 999 }], nowMs }),
    });
    expect(await duplicate.json()).toMatchObject({ accepted: 0, pending: 1, flushed: false });

    let final: Response | undefined;
    for (let index = 1; index < 200; index += 1) {
      final = await stub.fetch("https://metrics/append", {
        method: "POST",
        body: JSON.stringify({
          samples: [
            {
              ...base,
              sampleId: `sample-${index}`,
              value: index,
              labels: { env: "prod", gateway: `main-${index}` },
            },
          ],
          nowMs,
        }),
      });
    }
    expect(final).toBeDefined();
    expect(await final?.json()).toMatchObject({ accepted: 1, pending: 0, flushed: true });
  });

  it("queues a Prometheus payload when the metrics window alarm flushes", async () => {
    const stub = otelEnv.OTEL_METRICS_AGGREGATE.getByName(`export-${crypto.randomUUID()}`);
    const sample: MetricSample = {
      sampleId: "window-sample",
      name: "ai_gateway_requests_total",
      kind: "sum",
      value: 1,
      labels: { env: "prod", gateway: "main" },
    };
    const prometheusSend = vi.spyOn(otelEnv.OTEL_PROMETHEUS_QUEUE, "send");

    await stub.fetch("https://metrics/append", {
      method: "POST",
      body: JSON.stringify({ samples: [sample], nowMs: Date.now() }),
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    const pointer = prometheusSend.mock.calls.at(-1)?.[0];
    if (!pointer) throw new Error("Prometheus pointer was not queued");
    if (pointer.schemaVersion !== 2) throw new Error("Prometheus pointer is not current");
    expect(pointer.storageBackend).toBe(resolvePayloadStoreBackend(otelEnv.OTEL_PAYLOAD_STORE));
    const bytes = await payloadStoreForPointer(otelEnv, pointer).readBytesObject(pointer);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("keeps cumulative values and the original start time across flushes", async () => {
    const stub = otelEnv.OTEL_METRICS_AGGREGATE.getByName(`cumulative-${crypto.randomUUID()}`);
    const prometheusSend = vi.spyOn(otelEnv.OTEL_PROMETHEUS_QUEUE, "send");
    const labels = { env: "prod", gateway: "main" };
    const nowMs = Date.now();

    await stub.fetch("https://metrics/append", {
      method: "POST",
      body: JSON.stringify({
        samples: [
          {
            sampleId: "cumulative-sample-1",
            name: "ai_gateway_requests_total",
            kind: "sum",
            value: 1,
            labels,
          },
        ],
        nowMs,
      }),
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    await stub.fetch("https://metrics/append", {
      method: "POST",
      body: JSON.stringify({
        samples: [
          {
            sampleId: "cumulative-sample-2",
            name: "ai_gateway_requests_total",
            kind: "sum",
            value: 2,
            labels,
          },
        ],
        nowMs,
      }),
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    const pointers = prometheusSend.mock.calls
      .map(([pointer]) => pointer)
      .filter((pointer) => pointer.schemaVersion === 2);
    expect(pointers).toHaveLength(2);
    const payloads = await Promise.all(
      pointers.map(async (pointer) =>
        JSON.parse(
          new TextDecoder().decode(
            await payloadStoreForPointer(otelEnv, pointer).readBytesObject(pointer),
          ),
        ),
      ),
    );
    const points = payloads.map(
      (payload) => payload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0],
    );

    expect(points.map((point) => point.asDouble)).toEqual([1, 3]);
    expect(points[1].startTimeUnixNano).toBe(points[0].startTimeUnixNano);
  });

  it("keeps the first start time separately for each metric series", async () => {
    const stub = otelEnv.OTEL_METRICS_AGGREGATE.getByName(`series-start-${crypto.randomUUID()}`);
    const prometheusSend = vi.spyOn(otelEnv.OTEL_PROMETHEUS_QUEUE, "send");
    const firstStartMs = Date.now();
    const secondStartMs = firstStartMs + 1_000;
    const firstSeries: MetricSample = {
      sampleId: "series-a-1",
      name: "ai_gateway_requests_total",
      kind: "sum",
      value: 1,
      labels: { env: "prod", gateway: "main" },
    };
    const secondSeries: MetricSample = {
      ...firstSeries,
      sampleId: "series-b-1",
      labels: { env: "prod", gateway: "secondary" },
    };

    await stub.fetch("https://metrics/append", {
      method: "POST",
      body: JSON.stringify({ samples: [firstSeries], nowMs: firstStartMs }),
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    await stub.fetch("https://metrics/append", {
      method: "POST",
      body: JSON.stringify({ samples: [secondSeries], nowMs: secondStartMs }),
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    const pointer = prometheusSend.mock.calls.at(-1)?.[0];
    if (!pointer) throw new Error("Prometheus pointer was not queued");
    const payload = JSON.parse(
      new TextDecoder().decode(
        await payloadStoreForPointer(otelEnv, pointer).readBytesObject(pointer),
      ),
    );
    const dataPoints: readonly {
      attributes: Array<{ key: string; value: { stringValue: string } }>;
      startTimeUnixNano: string;
    }[] = payload.resourceMetrics[0].scopeMetrics[0].metrics.flatMap(
      (metric: {
        sum: {
          dataPoints: readonly {
            attributes: Array<{ key: string; value: { stringValue: string } }>;
            startTimeUnixNano: string;
          }[];
        };
      }) => metric.sum.dataPoints,
    );
    const startsByGateway = Object.fromEntries(
      dataPoints.map((point) => [
        point.attributes.find((attribute) => attribute.key === "gateway")?.value.stringValue,
        point.startTimeUnixNano,
      ]),
    );

    expect(startsByGateway.main).toBe(String(BigInt(firstStartMs) * 1_000_000n));
    expect(startsByGateway.secondary).toBe(String(BigInt(secondStartMs) * 1_000_000n));
  });
});
