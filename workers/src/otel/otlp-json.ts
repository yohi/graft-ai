import { DURATION_BUCKETS, CANONICAL_METRIC_NAMES, METRIC_LABEL_KEYS } from "./contracts";
import { projectLokiRecord } from "./spanlog";
import type {
  JsonValue,
  LokiRecord,
  MetricSample,
  MetricWindow,
  RedactedSpan,
  SelectedTrace,
} from "./types";

export function toMetricSamples(trace: SelectedTrace): readonly MetricSample[] {
  const span = trace.requestSpan;
  if (!span) return [];
  const labels = metricLabels(span);
  const samples: MetricSample[] = [
    {
      sampleId: metricSampleId(trace.traceId, CANONICAL_METRIC_NAMES[0], labels),
      name: CANONICAL_METRIC_NAMES[0],
      kind: "sum",
      value: 1,
      labels,
    },
  ];
  samples.push({
    sampleId: metricSampleId(trace.traceId, CANONICAL_METRIC_NAMES[1], labels),
    name: CANONICAL_METRIC_NAMES[1],
    kind: "sum",
    value: isError(span) ? 1 : 0,
    labels,
  });
  const duration = durationSeconds(span);
  samples.push({
    sampleId: metricSampleId(trace.traceId, CANONICAL_METRIC_NAMES[2], labels),
    name: CANONICAL_METRIC_NAMES[2],
    kind: "histogram",
    value: duration,
    labels,
    count: "1",
    bucketCounts: durationBuckets(duration),
    explicitBounds: DURATION_BUCKETS,
  });
  return samples;
}

export function encodeMetricsJson(
  samples: readonly MetricSample[],
  window: MetricWindow,
): Uint8Array {
  const metrics = samples.map((sample) => {
    if (sample.kind === "histogram") {
      return {
        name: sample.name,
        unit: "s",
        histogram: {
          aggregationTemporality: 1,
          dataPoints: [
            {
              attributes: metricAttributes(sample.labels),
              startTimeUnixNano: window.startTimeUnixNano,
              timeUnixNano: window.endTimeUnixNano,
              count: sample.count ?? "1",
              sum: sample.value,
              bucketCounts: sample.bucketCounts ?? [],
              explicitBounds: sample.explicitBounds ?? [],
            },
          ],
        },
      };
    }
    return {
      name: sample.name,
      unit: "1",
      sum: {
        aggregationTemporality: 1,
        isMonotonic: true,
        dataPoints: [
          {
            attributes: metricAttributes(sample.labels),
            startTimeUnixNano: window.startTimeUnixNano,
            timeUnixNano: window.endTimeUnixNano,
            asDouble: sample.value,
          },
        ],
      },
    };
  });
  return encode({
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "graft-ai-otel" } }],
        },
        scopeMetrics: [{ scope: { name: "graft-ai-otel" }, metrics }],
      },
    ],
  });
}

export function toTempoTrace(trace: SelectedTrace, sampled: boolean): readonly RedactedSpan[] {
  return sampled ? trace.spans : [];
}

export function encodeTempoJson(trace: SelectedTrace, sampled: boolean): Uint8Array {
  const spans = toTempoTrace(trace, sampled);
  const resource = spans[0]?.resourceAttributes ?? {};
  return encode({
    resourceSpans:
      spans.length === 0
        ? []
        : [
            {
              resource: { attributes: tempoAttributes(resource) },
              scopeSpans: [{ scope: { name: "graft-ai-otel" }, spans: spans.map(tempoSpan) }],
            },
          ],
  });
}

export function toLokiRecords(trace: SelectedTrace, sampled: boolean): readonly LokiRecord[] {
  if (!sampled || !trace.requestSpan) return [];
  const record = projectLokiRecord(trace.requestSpan);
  return record ? [record] : [];
}

export function encodeLokiJson(records: readonly LokiRecord[]): Uint8Array {
  return encode({
    streams: records.map((record) => ({
      stream: record.labels,
      values: [[record.timestampUnixNano, record.line]],
    })),
  });
}

function tempoSpan(span: RedactedSpan): Record<string, JsonValue> {
  const attributes = tempoAttributes(span.attributes);
  const result: Record<string, JsonValue> = {
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    kind: spanKind(span.kind),
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    attributes,
    status: {
      code: span.statusCode,
      message: span.statusMessage,
    },
  };
  if (span.parentSpanId) result.parentSpanId = span.parentSpanId;
  return result;
}

function tempoAttributes(attributes: Readonly<Record<string, JsonValue>>): readonly JsonValue[] {
  const allowlist = new Set([
    "trace_id",
    "span_id",
    "request_id",
    "graft_ai.request_span",
    "model",
    "provider",
    "status",
    "status_code",
    "gateway",
    "env",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cost_usd",
    "duration_ms",
    "payload_truncated",
    "payload_dropped",
    "payload_drop_reason",
    "service.name",
    "service.version",
    "deployment.environment",
    "cloud.provider",
    "cloud.region",
  ]);
  return Object.entries(attributes)
    .filter(([key]) => allowlist.has(key.toLowerCase()))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, value: anyValue(value) }));
}

function metricLabels(span: RedactedSpan): Readonly<Record<string, string>> {
  const labels: Record<string, string> = {};
  for (const key of METRIC_LABEL_KEYS) {
    labels[key] = stringAttribute(span, key) || "unknown";
  }
  return labels;
}

function metricAttributes(labels: Readonly<Record<string, string>>): readonly JsonValue[] {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, value: { stringValue: value } }));
}

function metricSampleId(
  traceId: string,
  name: string,
  labels: Readonly<Record<string, string>>,
): string {
  return `trace:${traceId}:${name}:${JSON.stringify(
    Object.fromEntries(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right))),
  )}`;
}

function anyValue(value: JsonValue): JsonValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return { doubleValue: value };
  if (value === null) return { stringValue: "null" };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(anyValue) } };
  return {
    kvlistValue: {
      values: Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => ({ key, value: anyValue(child) })),
    },
  };
}

function durationBuckets(duration: number): readonly string[] {
  const index = DURATION_BUCKETS.findIndex((bound) => duration <= bound);
  return [...DURATION_BUCKETS, Infinity].map((_, bucketIndex) =>
    bucketIndex === (index >= 0 ? index : DURATION_BUCKETS.length) ? "1" : "0",
  );
}

function durationSeconds(span: RedactedSpan): number {
  const durationMs = numericAttribute(span, "duration_ms", "gen_ai.duration_ms");
  if (durationMs !== null && durationMs >= 0) return durationMs / 1_000;
  try {
    const start = BigInt(span.startTimeUnixNano);
    const end = BigInt(span.endTimeUnixNano);
    if (end < start) return 0;
    const seconds = Number(end - start) / 1_000_000_000;
    return Number.isFinite(seconds) ? seconds : 0;
  } catch {
    return 0;
  }
}

function isError(span: RedactedSpan): boolean {
  if (span.statusCode.toUpperCase() === "ERROR") return true;
  const statusCode = numericAttribute(span, "status_code", "http.response.status_code");
  return statusCode !== null && statusCode >= 400;
}

function stringAttribute(span: RedactedSpan, key: string): string {
  const aliases: Record<string, readonly string[]> = {
    model: ["model", "gen_ai.request.model"],
    provider: ["provider", "gen_ai.model.provider", "gen_ai.provider.name", "gen_ai.system"],
    status_code: ["status_code", "http.response.status_code"],
    env: ["env"],
    gateway: ["gateway"],
  };
  const value = aliases[key]?.map((candidate) => span.attributes[candidate]).find(Boolean);
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function numericAttribute(span: RedactedSpan, ...keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = span.attributes[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function spanKind(kind: string): string {
  const normalized = kind.toLowerCase();
  if (normalized === "server") return "SPAN_KIND_SERVER";
  if (normalized === "client") return "SPAN_KIND_CLIENT";
  if (normalized === "producer") return "SPAN_KIND_PRODUCER";
  if (normalized === "consumer") return "SPAN_KIND_CONSUMER";
  return "SPAN_KIND_INTERNAL";
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
