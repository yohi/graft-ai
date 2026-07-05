import { pushToLoki } from "./loki";
import { transformLogToLokiStream } from "./transform";
import type { AIGatewayLog, Env, LokiPushPayload, LokiStream, TelemetryEvent } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === "string" ? value : fallback;
}

function numberValue(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseTelemetryPayload(value: unknown): TelemetryEvent | null {
  if (!isRecord(value) || value["_graft_ai_telemetry"] !== true) {
    return null;
  }
  return {
    _graft_ai_telemetry: true,
    request_id: stringValue(value, "request_id", crypto.randomUUID()),
    timestamp: stringValue(value, "timestamp", new Date(0).toISOString()),
    model: stringValue(value, "model", "unknown"),
    status_code: numberValue(value, "status_code"),
    cache_status: stringValue(value, "cache_status", "unknown"),
    prompt_tokens: numberValue(value, "prompt_tokens"),
    completion_tokens: numberValue(value, "completion_tokens"),
    total_tokens: numberValue(value, "total_tokens"),
    duration_ms: numberValue(value, "duration_ms"),
    path: stringValue(value, "path", "/"),
    method: stringValue(value, "method", "UNKNOWN"),
    gateway: stringValue(value, "gateway", "unknown"),
    env: stringValue(value, "env", "unknown"),
  };
}

function parseTelemetryLine(line: string): TelemetryEvent | null {
  try {
    return parseTelemetryPayload(JSON.parse(line));
  } catch (err) {
    if (err instanceof SyntaxError) {
      return null;
    }
    throw err;
  }
}

function logMessageToTelemetry(message: unknown): TelemetryEvent | null {
  if (typeof message === "string") {
    return parseTelemetryLine(message);
  }
  if (Array.isArray(message)) {
    for (const item of message) {
      if (typeof item !== "string") {
        continue;
      }
      const telemetry = parseTelemetryLine(item);
      if (telemetry) {
        return telemetry;
      }
    }
  }
  return null;
}

function telemetryToAIGatewayLog(event: TelemetryEvent): AIGatewayLog {
  const timestampMs = Date.parse(event.timestamp);
  return {
    RequestID: event.request_id,
    RequestTime: Number.isFinite(timestampMs) ? timestampMs : 0,
    CacheStatus: event.cache_status,
    StatusCode: event.status_code,
    Model: event.model,
    PromptTokens: event.prompt_tokens,
    CompletionTokens: event.completion_tokens,
    TotalTokens: event.total_tokens,
    RequestDuration: event.duration_ms,
    Path: event.path,
    Method: event.method,
  };
}

export default {
  async tail(events: TraceItem[], env: Env, _ctx: ExecutionContext): Promise<void> {
    const payload: LokiPushPayload = { streams: [] };
    const streamMap = new Map<string, LokiStream>();
    for (const event of events) {
      for (const log of event.logs) {
        const telemetry = logMessageToTelemetry(log.message);
        if (telemetry) {
          const stream = transformLogToLokiStream(
            telemetryToAIGatewayLog(telemetry),
            telemetry.gateway,
            telemetry.env,
          );
          const key = `${stream.stream.model}|${stream.stream.status_code}|${stream.stream.env}|${stream.stream.gateway}`;
          const existing = streamMap.get(key);
          if (existing) {
            existing.values.push(...stream.values);
          } else {
            streamMap.set(key, stream);
          }
        }
      }
    }

    payload.streams.push(...streamMap.values());
    if (payload.streams.length === 0) {
      return;
    }

    const result = await pushToLoki(env, payload);
    if (!result.ok) {
      console.error(`Tail Worker Loki push failed: ${result.status}`);
    }
  },
} satisfies ExportedHandler<Env>;
