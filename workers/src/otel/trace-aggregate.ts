import { TRACE_IDLE_ALARM_MS } from "./contracts";
import { enqueueBackendJob, traceJobId } from "./exporter";
import { selectRequestSpan, shouldSampleTrace } from "./selection";
import {
  encodeLokiJson,
  encodeTempoJson,
  toMetricSamples,
  toLokiRecords,
  toTempoTrace,
} from "./otlp-json";
import { sha256Hex } from "./storage";
import type { MetricSample, OtelEnv, RedactedSpan, SelectedTrace } from "./types";

type TraceState = Readonly<{
  traceId: string;
  ingressIds: readonly string[];
  spans: readonly RedactedSpan[];
  lastReceivedAtMs: number;
  completed: boolean;
  sampled?: boolean;
}>;

export class TraceAggregate {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: OtelEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/ingest") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return this.state.blockConcurrencyWhile(async () => {
      const body: unknown = await request.json();
      if (!isRecord(body) || typeof body["ingressId"] !== "string") {
        return Response.json({ error: "invalid_ingress" }, { status: 400 });
      }
      const spans = readSpans(body["spans"]);
      const receivedAtMs = readNumber(body["receivedAtMs"]);
      if (!spans || receivedAtMs === null) {
        return Response.json({ error: "invalid_trace" }, { status: 400 });
      }
      const current = await this.readState(body["traceId"] as string | undefined, spans);
      if (current.completed) return Response.json({ accepted: false, reason: "late_span" });
      if (current.ingressIds.includes(body["ingressId"])) {
        return Response.json({ accepted: false, reason: "duplicate" });
      }
      const next: TraceState = {
        traceId: current.traceId,
        ingressIds: [...current.ingressIds, body["ingressId"]],
        spans: [...current.spans, ...spans],
        lastReceivedAtMs: receivedAtMs,
        completed: false,
      };
      await this.state.storage.put("trace", next);
      const idleDeadlineMs = receivedAtMs + TRACE_IDLE_ALARM_MS;
      await this.scheduleAlarm(Math.max(idleDeadlineMs, Date.now()));
      return Response.json({ accepted: true, duplicate: false });
    });
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<TraceState>("trace");
      if (!stored || stored.completed) return;
      const selected = selectRequestSpan(stored.spans);
      const metrics = toMetricSamples(selected);
      await this.appendMetrics(metrics, stored.lastReceivedAtMs);
      const sampled = await shouldSampleTrace(selected.traceId, this.env.OTEL_SAMPLING_RATE || "0");
      if (sampled) {
        await this.enqueueSampledSignals(selected);
        await this.rememberSampledSignals(selected);
      }
      await this.state.storage.put("trace", { ...stored, completed: true, sampled });
    });
  }

  private async appendMetrics(samples: readonly MetricSample[], nowMs: number): Promise<void> {
    if (samples.length === 0) return;
    const stub = this.env.OTEL_METRICS_AGGREGATE.getByName("global");
    const response = await stub.fetch("https://metrics/append", {
      method: "POST",
      body: JSON.stringify({ samples, nowMs }),
    });
    if (!response.ok) throw new Error(`metrics aggregate rejected: ${response.status}`);
  }

  private async rememberSampledSignals(trace: SelectedTrace): Promise<void> {
    const state = {
      tempoSpans: toTempoTrace(trace, true).length,
      lokiRecords: toLokiRecords(trace, true).length,
    };
    await this.state.storage.put("lastSampledSignals", state);
  }

  private async enqueueSampledSignals(trace: SelectedTrace): Promise<void> {
    const tempoBytes = encodeTempoJson(trace, true);
    const tempoHash = await sha256Hex(tempoBytes);
    await enqueueBackendJob(
      this.env,
      {
        jobId: await traceJobId("tempo", trace.traceId, tempoHash),
        backend: "tempo",
        contentType: "application/json",
        identity: { kind: "trace", traceId: trace.traceId },
        payloadSha256: tempoHash,
      },
      tempoBytes,
    );

    const lokiRecords = toLokiRecords(trace, true);
    if (lokiRecords.length === 0) return;
    const lokiBytes = encodeLokiJson(lokiRecords);
    const lokiHash = await sha256Hex(lokiBytes);
    await enqueueBackendJob(
      this.env,
      {
        jobId: await traceJobId("loki", trace.traceId, lokiHash),
        backend: "loki",
        contentType: "application/json",
        identity: { kind: "trace", traceId: trace.traceId },
        payloadSha256: lokiHash,
      },
      lokiBytes,
    );
  }

  private async readState(
    traceId: string | undefined,
    spans: readonly RedactedSpan[],
  ): Promise<TraceState> {
    const stored = await this.state.storage.get<TraceState>("trace");
    if (stored) return stored;
    const firstTraceId = traceId ?? spans[0]?.traceId ?? "";
    return {
      traceId: firstTraceId,
      ingressIds: [],
      spans: [],
      lastReceivedAtMs: 0,
      completed: false,
    };
  }

  private async scheduleAlarm(deadlineMs: number): Promise<void> {
    const scheduled = await this.state.storage.getAlarm();
    if (scheduled === null || deadlineMs < scheduled) {
      await this.state.storage.setAlarm(deadlineMs);
    }
  }
}

function readSpans(value: unknown): readonly RedactedSpan[] | null {
  if (!Array.isArray(value)) return null;
  const spans: RedactedSpan[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item["traceId"] !== "string" ||
      typeof item["spanId"] !== "string"
    ) {
      return null;
    }
    spans.push(item as unknown as RedactedSpan);
  }
  return spans;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
