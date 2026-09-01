import type { MetricSample } from "./types";

export type MetricsState = Readonly<{
  windowStartMs: number | null;
  samples: readonly MetricSample[];
  sampleIds: readonly string[];
  cumulativeSamples?: readonly MetricSample[];
  cumulativeStartMs?: number | null;
  cumulativeStartTimesMs?: Readonly<Record<string, number>>;
}>;

export type FlushResult =
  Readonly<{ kind: "flushed"; state: MetricsState }> | Readonly<{ kind: "too_large" }>;

export const METRICS_WINDOW_TOO_LARGE_MESSAGE = "metrics payload exceeds safe rollover limits";

export function mergeSamples(
  samples: readonly MetricSample[],
  additions: readonly MetricSample[],
): MetricSample[] {
  return additions.reduce((aggregate, sample) => mergeSample(aggregate, sample), [...samples]);
}

export function mergeSample(
  samples: readonly MetricSample[],
  sample: MetricSample,
): MetricSample[] {
  const key = aggregateKey(sample);
  const index = samples.findIndex((candidate) => aggregateKey(candidate) === key);
  if (index < 0) return [...samples, sample];
  const existing = samples[index];
  if (!existing || existing.kind !== sample.kind) return [...samples, sample];
  const merged: MetricSample =
    sample.kind === "sum"
      ? { ...existing, value: existing.value + sample.value }
      : {
          ...existing,
          value: existing.value + sample.value,
          count: addInteger(existing.count ?? "0", sample.count ?? "0"),
          bucketCounts: mergeIntegers(existing.bucketCounts ?? [], sample.bucketCounts ?? []),
        };
  return samples.map((candidate, candidateIndex) =>
    candidateIndex === index ? merged : candidate,
  );
}

export function aggregateKey(sample: MetricSample): string {
  return JSON.stringify({
    name: sample.name,
    kind: sample.kind,
    labels: Object.fromEntries(
      Object.entries(sample.labels).sort(([left], [right]) => left.localeCompare(right)),
    ),
    ...(sample.kind === "histogram" ? { explicitBounds: sample.explicitBounds ?? [] } : {}),
  });
}

export function readSamples(value: unknown): readonly MetricSample[] | null {
  if (!Array.isArray(value)) return null;
  const samples: MetricSample[] = [];
  for (const item of value) {
    const sample = readSample(item);
    if (!sample) return null;
    samples.push(sample);
  }
  return samples;
}

function readSample(value: unknown): MetricSample | null {
  if (!isRecord(value)) return null;
  const name = value["name"];
  const kind = value["kind"];
  const sampleId = value["sampleId"];
  const sampleValue = value["value"];
  if (
    typeof name !== "string" ||
    (kind !== "sum" && kind !== "histogram") ||
    typeof sampleId !== "string" ||
    sampleId.length === 0 ||
    typeof sampleValue !== "number" ||
    !Number.isFinite(sampleValue)
  )
    return null;
  const labels = readLabels(value["labels"]);
  const count = readOptionalString(value["count"]);
  const bucketCounts = readOptionalStringArray(value["bucketCounts"]);
  const explicitBounds = readOptionalNumberArray(value["explicitBounds"]);
  const startTimeUnixNano = readOptionalString(value["startTimeUnixNano"]);
  if (
    !labels ||
    count === null ||
    bucketCounts === null ||
    explicitBounds === null ||
    startTimeUnixNano === null
  )
    return null;
  return {
    sampleId,
    name,
    kind,
    value: sampleValue,
    labels,
    ...(count === undefined ? {} : { count }),
    ...(bucketCounts === undefined ? {} : { bucketCounts }),
    ...(explicitBounds === undefined ? {} : { explicitBounds }),
    ...(startTimeUnixNano === undefined ? {} : { startTimeUnixNano }),
  };
}

function readLabels(value: unknown): Readonly<Record<string, string>> | null {
  if (!isRecord(value)) return null;
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(value)) {
    if (typeof label !== "string") return null;
    labels[key] = label;
  }
  return labels;
}

function readOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

function readOptionalStringArray(value: unknown): readonly string[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    values.push(item);
  }
  return values;
}

function readOptionalNumberArray(value: unknown): readonly number[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const values: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) return null;
    values.push(item);
  }
  return values;
}

function mergeIntegers(left: readonly string[], right: readonly string[]): readonly string[] {
  const length = Math.max(left.length, right.length);
  return Array.from({ length }, (_, index) => addInteger(left[index] ?? "0", right[index] ?? "0"));
}

function addInteger(left: string, right: string): string {
  try {
    return String(BigInt(left) + BigInt(right));
  } catch {
    return "0";
  }
}

export function toNanoseconds(milliseconds: number): string {
  return String(BigInt(Math.trunc(milliseconds)) * 1_000_000n);
}

export function stateSizeBytes(state: MetricsState): number {
  return new TextEncoder().encode(JSON.stringify(state)).byteLength;
}

export function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
