import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { MetricSample } from "../../src/otel/types";

const otelEnv = env as unknown as {
  readonly OTEL_METRICS_AGGREGATE: DurableObjectNamespace;
  readonly OTEL_OBJECTS: R2Bucket;
};

describe("OtelMetricsAggregate", () => {
  it("deduplicates samples and flushes at the two-hundred-sample bound", async () => {
    const stub = otelEnv.OTEL_METRICS_AGGREGATE.getByName(`metrics-${crypto.randomUUID()}`);
    const nowMs = Date.now();
    const base: MetricSample = {
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
      body: JSON.stringify({ samples: [base], nowMs }),
    });
    expect(await duplicate.json()).toMatchObject({ accepted: 0, pending: 1, flushed: false });

    let final: Response | undefined;
    for (let index = 1; index < 200; index += 1) {
      final = await stub.fetch("https://metrics/append", {
        method: "POST",
        body: JSON.stringify({
          samples: [{ ...base, value: index, labels: { env: "prod", gateway: `main-${index}` } }],
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
      name: "ai_gateway_requests_total",
      kind: "sum",
      value: 1,
      labels: { env: "prod", gateway: "main" },
    };
    const before = await otelEnv.OTEL_OBJECTS.list({ prefix: "otel/export/prometheus/" });

    await stub.fetch("https://metrics/append", {
      method: "POST",
      body: JSON.stringify({ samples: [sample], nowMs: Date.now() }),
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    const objects = await otelEnv.OTEL_OBJECTS.list({ prefix: "otel/export/prometheus/" });
    expect(objects.objects.length).toBe(before.objects.length + 1);
  });
});
