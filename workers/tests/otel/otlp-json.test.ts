import { describe, expect, it } from "vitest";
import {
  encodeMetricsJson,
  encodeTempoJson,
  toLokiRecords,
  toMetricSamples,
  toTempoTrace,
} from "../../src/otel/otlp-json";
import { parseOtlpJson } from "../../src/otel/otlp";
import { redactSpan } from "../../src/otel/redaction";
import { selectRequestSpan } from "../../src/otel/selection";
import { validOtlpJson } from "./fixtures";

describe("OTLP JSON encoders", () => {
  it("keeps metrics for sampled-out traces and encodes DELTA data", () => {
    const parsed = parseOtlpJson(validOtlpJson);
    const firstSpan = parsed[0];
    if (!firstSpan) throw new Error("fixture did not produce a span");
    const selected = selectRequestSpan([redactSpan(firstSpan)]);
    const samples = toMetricSamples(selected);
    const payload = JSON.parse(
      new TextDecoder().decode(
        encodeMetricsJson(samples, {
          startTimeUnixNano: "1700000000000000000",
          endTimeUnixNano: "1700000030000000000",
        }),
      ),
    );

    expect(samples).toHaveLength(3);
    expect(payload.resourceMetrics[0].scopeMetrics[0].metrics).toHaveLength(3);
    expect(payload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.aggregationTemporality).toBe(
      1,
    );
    expect(payload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.isMonotonic).toBe(true);
  });

  it("uses eleven finite histogram bounds and a twelfth +Inf bucket count", () => {
    const parsed = parseOtlpJson(validOtlpJson);
    const firstSpan = parsed[0];
    if (!firstSpan) throw new Error("fixture did not produce a span");
    const selected = selectRequestSpan([redactSpan(firstSpan)]);
    const samples = toMetricSamples(selected);
    const duration = samples.find(
      (sample) => sample.name === "ai_gateway_request_duration_seconds",
    );
    if (!duration) throw new Error("duration sample missing");

    const payload = JSON.parse(
      new TextDecoder().decode(
        encodeMetricsJson([duration], {
          startTimeUnixNano: "1",
          endTimeUnixNano: "2",
        }),
      ),
    );
    const point = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0];

    expect(point.explicitBounds).toHaveLength(11);
    expect(point.bucketCounts).toHaveLength(12);
    expect(JSON.stringify(payload)).not.toContain("Infinity");
  });

  it("encodes sampled Tempo and Loki output with the same trace ID", () => {
    const parsed = parseOtlpJson(validOtlpJson);
    const firstSpan = parsed[0];
    if (!firstSpan) throw new Error("fixture did not produce a span");
    const selected = selectRequestSpan([redactSpan(firstSpan)]);
    const tempo = toTempoTrace(selected, true);
    const loki = toLokiRecords(selected, true);

    expect(
      JSON.parse(new TextDecoder().decode(encodeTempoJson(selected, true))).resourceSpans[0]
        .scopeSpans[0].spans[0].traceId,
    ).toBe(selected.traceId);
    expect(loki[0]?.line).toContain(selected.traceId);
    expect(toTempoTrace(selected, false)).toEqual([]);
    expect(toLokiRecords(selected, false)).toEqual([]);
    expect(tempo).toHaveLength(1);
  });
});
