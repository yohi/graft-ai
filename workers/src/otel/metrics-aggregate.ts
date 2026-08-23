import { METRICS_FLUSH_INTERVAL_MS, METRICS_FLUSH_SAMPLE_LIMIT } from "./contracts";
import { enqueueBackendJob, metricsJobId } from "./exporter";
import { encodeMetricsJson } from "./otlp-json";
import { sha256Hex } from "./storage";
import type { JsonValue, MetricSample, OtelEnv } from "./types";

type MetricsState = Readonly<{
  windowStartMs: number | null;
  samples: readonly MetricSample[];
  sampleIds: readonly string[];
}>;

export class OtelMetricsAggregate {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: OtelEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/append") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return this.state.blockConcurrencyWhile(async () => {
      const body: unknown = await request.json();
      if (!isRecord(body) || !Array.isArray(body["samples"])) {
        return Response.json({ error: "invalid_samples" }, { status: 400 });
      }
      const samples = readSamples(body["samples"]);
      const nowMs = readNumber(body["nowMs"]) ?? Date.now();
      if (!samples) return Response.json({ error: "invalid_samples" }, { status: 400 });
      const current = (await this.state.storage.get<MetricsState>("metrics")) ?? {
        windowStartMs: null,
        samples: [],
        sampleIds: [],
      };
      const ids = new Set(current.sampleIds);
      let aggregate = [...current.samples];
      let accepted = 0;
      for (const sample of samples) {
        const id = sampleId(sample);
        if (ids.has(id)) continue;
        ids.add(id);
        aggregate = mergeSample(aggregate, sample);
        accepted += 1;
      }
      const windowStartMs = current.windowStartMs ?? (accepted > 0 ? nowMs : null);
      const shouldFlush = ids.size >= METRICS_FLUSH_SAMPLE_LIMIT;
      if (shouldFlush) {
        await this.flush(aggregate, windowStartMs ?? nowMs, nowMs);
        await this.state.storage.put("metrics", {
          windowStartMs: null,
          samples: [],
          sampleIds: [],
        } satisfies MetricsState);
        return Response.json({ accepted, pending: 0, flushed: true });
      }
      await this.state.storage.put("metrics", {
        windowStartMs,
        samples: aggregate,
        sampleIds: [...ids],
      } satisfies MetricsState);
      if (windowStartMs !== null)
        await this.state.storage.setAlarm(windowStartMs + METRICS_FLUSH_INTERVAL_MS);
      return Response.json({ accepted, pending: ids.size, flushed: false });
    });
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      const current = await this.state.storage.get<MetricsState>("metrics");
      if (!current || current.samples.length === 0 || current.windowStartMs === null) return;
      await this.flush(current.samples, current.windowStartMs, Date.now());
      await this.state.storage.put("metrics", {
        windowStartMs: null,
        samples: [],
        sampleIds: [],
      } satisfies MetricsState);
    });
  }

  private async flush(
    samples: readonly MetricSample[],
    startMs: number,
    endMs: number,
  ): Promise<void> {
    const window = {
      startTimeUnixNano: toNanoseconds(startMs),
      endTimeUnixNano: toNanoseconds(endMs),
    };
    const payload = encodeMetricsJson(samples, window);
    const payloadSha256 = await sha256Hex(payload);
    const jobId = await metricsJobId(
      "prometheus",
      window.startTimeUnixNano,
      window.endTimeUnixNano,
      payloadSha256,
    );
    await enqueueBackendJob(
      this.env,
      {
        jobId,
        backend: "prometheus",
        contentType: "application/json",
        identity: {
          kind: "metrics",
          windowStartUnixNano: window.startTimeUnixNano,
          windowEndUnixNano: window.endTimeUnixNano,
        },
        payloadSha256,
      },
      payload,
    );
    await this.state.storage.put("lastFlush", {
      window,
      samples,
      payloadSha256,
    });
  }
}

function mergeSample(samples: readonly MetricSample[], sample: MetricSample): MetricSample[] {
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

function aggregateKey(sample: MetricSample): string {
  return JSON.stringify({
    name: sample.name,
    kind: sample.kind,
    labels: Object.fromEntries(
      Object.entries(sample.labels).sort(([left], [right]) => left.localeCompare(right)),
    ),
  });
}

function sampleId(sample: MetricSample): string {
  return sample.sampleId;
}

function readSamples(value: unknown): readonly MetricSample[] | null {
  if (!Array.isArray(value)) return null;
  const samples: MetricSample[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item["name"] !== "string" ||
      (item["kind"] !== "sum" && item["kind"] !== "histogram")
    )
      return null;
    if (typeof item["sampleId"] !== "string" || item["sampleId"].length === 0) return null;
    if (
      typeof item["value"] !== "number" ||
      !Number.isFinite(item["value"]) ||
      !isRecord(item["labels"])
    )
      return null;
    samples.push(item as unknown as MetricSample);
  }
  return samples;
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

function toNanoseconds(milliseconds: number): string {
  return String(BigInt(Math.trunc(milliseconds)) * 1_000_000n);
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, JsonValue | unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
