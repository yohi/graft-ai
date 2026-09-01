import {
  MAX_GRAFANA_OTLP_BYTES,
  MAX_METRICS_STATE_BYTES,
  METRICS_FLUSH_INTERVAL_MS,
  METRICS_FLUSH_SAMPLE_LIMIT,
} from "./contracts";
import { enqueueBackendJob, metricsJobId } from "./exporter";
import {
  aggregateKey,
  isRecord,
  METRICS_WINDOW_TOO_LARGE_MESSAGE,
  mergeSample,
  mergeSamples,
  readNumber,
  readSamples,
  stateSizeBytes,
  toNanoseconds,
  type FlushResult,
  type MetricsState,
} from "./metrics-aggregate-state";
import { encodeMetricsJson } from "./otlp-json";
import { sha256Hex } from "./storage";
import type { OtelEnv } from "./types";

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
        const id = sample.sampleId;
        if (ids.has(id)) continue;
        ids.add(id);
        aggregate = mergeSample(aggregate, sample);
        accepted += 1;
      }
      const windowStartMs = current.windowStartMs ?? (accepted > 0 ? nowMs : null);
      const shouldFlush = ids.size >= METRICS_FLUSH_SAMPLE_LIMIT;
      if (shouldFlush) {
        const result = await this.flush(
          {
            ...current,
            windowStartMs,
            samples: aggregate,
            sampleIds: [...ids],
          },
          nowMs,
        );
        if (result.kind === "too_large") return metricsWindowTooLargeResponse();
        await this.state.storage.put("metrics", result.state satisfies MetricsState);
        return Response.json({ accepted, pending: 0, flushed: true });
      }
      const pendingState: MetricsState = {
        ...current,
        windowStartMs,
        samples: aggregate,
        sampleIds: [...ids],
      };
      if (stateSizeBytes(pendingState) > MAX_METRICS_STATE_BYTES) {
        const result = await this.flush(pendingState, nowMs);
        if (result.kind === "too_large") return metricsWindowTooLargeResponse();
        await this.state.storage.put("metrics", result.state satisfies MetricsState);
        return Response.json({ accepted, pending: 0, flushed: true });
      }
      await this.state.storage.put("metrics", pendingState);
      if (windowStartMs !== null)
        await this.state.storage.setAlarm(windowStartMs + METRICS_FLUSH_INTERVAL_MS);
      return Response.json({ accepted, pending: ids.size, flushed: false });
    });
  }

  async alarm(): Promise<void> {
    const tooLarge = await this.state.blockConcurrencyWhile(async () => {
      const current = await this.state.storage.get<MetricsState>("metrics");
      if (!current || current.samples.length === 0 || current.windowStartMs === null) return false;
      const result = await this.flush(current, Date.now());
      if (result.kind === "too_large") return true;
      await this.state.storage.put("metrics", result.state satisfies MetricsState);
      return false;
    });
    if (tooLarge) throw new Error(METRICS_WINDOW_TOO_LARGE_MESSAGE);
  }

  private async flush(current: MetricsState, endMs: number): Promise<FlushResult> {
    const cumulativeSamples = mergeSamples(current.cumulativeSamples ?? [], current.samples);
    const cumulativeStartMs = current.cumulativeStartMs ?? current.windowStartMs ?? endMs;
    const legacyStartTimesMs = current.cumulativeStartTimesMs ?? {};
    const samplesWithStartTimes = cumulativeSamples.map((sample) => ({
      ...sample,
      startTimeUnixNano:
        sample.startTimeUnixNano ??
        toNanoseconds(
          legacyStartTimesMs[aggregateKey(sample)] ?? current.windowStartMs ?? cumulativeStartMs,
        ),
    }));
    const fullState: MetricsState = {
      windowStartMs: null,
      samples: [],
      sampleIds: [],
      cumulativeSamples: samplesWithStartTimes,
      cumulativeStartMs,
    };
    let exportStartMs = cumulativeStartMs;
    let exportSamples = samplesWithStartTimes;
    let payload = encodeMetricsJson(exportSamples, {
      startTimeUnixNano: toNanoseconds(exportStartMs),
      endTimeUnixNano: toNanoseconds(endMs),
    });
    if (
      payload.byteLength > MAX_GRAFANA_OTLP_BYTES ||
      stateSizeBytes(fullState) > MAX_METRICS_STATE_BYTES
    ) {
      exportStartMs = current.windowStartMs ?? endMs;
      exportSamples = current.samples.map((sample) => ({
        ...sample,
        startTimeUnixNano: toNanoseconds(exportStartMs),
      }));
      payload = encodeMetricsJson(exportSamples, {
        startTimeUnixNano: toNanoseconds(exportStartMs),
        endTimeUnixNano: toNanoseconds(endMs),
      });
      const rolloverState: MetricsState = {
        windowStartMs: null,
        samples: [],
        sampleIds: [],
        cumulativeSamples: exportSamples,
        cumulativeStartMs: exportStartMs,
      };
      if (
        payload.byteLength > MAX_GRAFANA_OTLP_BYTES ||
        stateSizeBytes(rolloverState) > MAX_METRICS_STATE_BYTES
      ) {
        return { kind: "too_large" };
      }
    }
    const window = {
      startTimeUnixNano: toNanoseconds(exportStartMs),
      endTimeUnixNano: toNanoseconds(endMs),
    };
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
      sampleCount: exportSamples.length,
      payloadBytes: payload.byteLength,
      payloadSha256,
    });
    return {
      kind: "flushed",
      state: {
        windowStartMs: null,
        samples: [],
        sampleIds: [],
        cumulativeSamples: exportSamples,
        cumulativeStartMs: exportStartMs,
      },
    };
  }
}

function metricsWindowTooLargeResponse(): Response {
  return Response.json({ error: "metrics_window_too_large" }, { status: 413 });
}
