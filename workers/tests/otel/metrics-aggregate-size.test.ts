import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_GRAFANA_OTLP_BYTES, MAX_METRICS_STATE_BYTES } from "../../src/otel/contracts";
import { payloadStoreForPointer } from "../../src/otel/storage";
import type { MetricSample, OtelEnv } from "../../src/otel/types";

const otelEnv = env as OtelEnv;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OtelMetricsAggregate size boundaries", () => {
  it("rolls over cumulative state before the Durable Object value limit is reached", async () => {
    const stub = otelEnv.OTEL_METRICS_AGGREGATE.getByName(`rollover-${crypto.randomUUID()}`);
    const prometheusSend = vi.spyOn(otelEnv.OTEL_PROMETHEUS_QUEUE, "send");
    const makeSamples = (prefix: string): readonly MetricSample[] =>
      Array.from({ length: 200 }, (_, index) => ({
        sampleId: `${prefix}-${index}`,
        name: "ai_gateway_requests_total",
        kind: "sum",
        value: 1,
        labels: { gateway: `${prefix}-${index}-${"x".repeat(4_000)}` },
      }));
    const firstNowMs = Date.now();
    const secondNowMs = firstNowMs + 1_000;

    const first = await stub.fetch("https://metrics/append", {
      method: "POST",
      body: JSON.stringify({ samples: makeSamples("first"), nowMs: firstNowMs }),
    });
    expect(await first.json()).toMatchObject({ accepted: 200, pending: 0, flushed: true });

    const second = await stub.fetch("https://metrics/append", {
      method: "POST",
      body: JSON.stringify({ samples: makeSamples("second"), nowMs: secondNowMs }),
    });
    expect(await second.json()).toMatchObject({ accepted: 200, pending: 0, flushed: true });

    const pointers = prometheusSend.mock.calls
      .map(([pointer]) => pointer)
      .filter((pointer) => pointer.schemaVersion === 2);
    expect(pointers).toHaveLength(2);
    const payloads = await Promise.all(
      pointers.map(async (pointer) => {
        const bytes = await payloadStoreForPointer(otelEnv, pointer).readBytesObject(pointer);
        return { bytes, body: JSON.parse(new TextDecoder().decode(bytes)) };
      }),
    );
    const secondMetrics = payloads[1]?.body.resourceMetrics[0].scopeMetrics[0].metrics;
    const secondPoint = secondMetrics[0].sum.dataPoints[0];

    expect(payloads[1]?.bytes.byteLength).toBeLessThanOrEqual(MAX_GRAFANA_OTLP_BYTES);
    expect(secondMetrics).toHaveLength(200);
    expect(secondPoint.attributes[0].value.stringValue).toContain("second-0-");
    expect(secondPoint.startTimeUnixNano).toBe(String(BigInt(secondNowMs) * 1_000_000n));
  });

  it("returns an explicit error when the current metrics window cannot fit in Durable Object state", async () => {
    const stub = otelEnv.OTEL_METRICS_AGGREGATE.getByName(`oversized-${crypto.randomUUID()}`);
    const prometheusSend = vi.spyOn(otelEnv.OTEL_PROMETHEUS_QUEUE, "send");
    const response = await stub.fetch("https://metrics/append", {
      method: "POST",
      body: JSON.stringify({
        samples: [
          {
            sampleId: "oversized-window",
            name: "ai_gateway_requests_total",
            kind: "sum",
            value: 1,
            labels: { gateway: "x".repeat(MAX_METRICS_STATE_BYTES + 100_000) },
          },
        ],
        nowMs: Date.now(),
      }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "metrics_window_too_large" });
    expect(prometheusSend).not.toHaveBeenCalled();

    const recovery = await stub.fetch("https://metrics/append", {
      method: "POST",
      body: JSON.stringify({
        samples: [
          {
            sampleId: "recovery-window",
            name: "ai_gateway_requests_total",
            kind: "sum",
            value: 1,
            labels: { gateway: "main" },
          },
        ],
        nowMs: Date.now(),
      }),
    });
    expect(await recovery.json()).toMatchObject({ accepted: 1, pending: 1, flushed: false });
  });
});
