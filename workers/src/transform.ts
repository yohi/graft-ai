import type { AIGatewayLog, LokiStream, LokiPushPayload } from "./types";

// Loki has a per-line size limit; Grafana Cloud Free Tier accepts up to ~64KB per line.
// We leave a margin for JSON overhead and labels.
const MAX_LOG_LINE_BYTES = 60_000;

export function normalizeModelName(modelId: string): string {
  if (modelId.startsWith("@cf/")) {
    const withoutPrefix = modelId.slice(4);
    const slashIndex = withoutPrefix.indexOf("/");
    if (slashIndex >= 0) {
      return withoutPrefix.slice(slashIndex + 1);
    }
    return withoutPrefix;
  }
  return modelId;
}

export function requestTimeToNanos(requestTime: number): string {
  const n = BigInt(Math.floor(requestTime));
  const s = n.toString();
  if (s.length <= 10) {
    // Seconds → nanoseconds
    return (n * 1_000_000_000n).toString();
  }
  if (s.length <= 13) {
    // Milliseconds → nanoseconds
    return (n * 1_000_000n).toString();
  }
  throw new Error(
    `RequestTime precision lost: ${requestTime} has ${s.length} digits; ` +
      `expected seconds or milliseconds. Set timestamp_format to "unix".`,
  );
}

export function buildLogLine(
  log: AIGatewayLog,
  include?: {
    requestBody?: boolean;
    responseBody?: boolean;
    metadata?: boolean;
  },
): string {
  const line: Record<string, unknown> = {
    request_id: log.RequestID,
    cache_status: log.CacheStatus,
    prompt_tokens: log.PromptTokens,
    completion_tokens: log.CompletionTokens,
    total_tokens: log.TotalTokens,
    duration_ms: log.RequestDuration,
    path: log.Path,
    method: log.Method,
  };
  if (include?.requestBody && log.RequestBody !== undefined) {
    line.request_body = log.RequestBody;
  }
  if (include?.responseBody && log.ResponseBody !== undefined) {
    line.response_body = log.ResponseBody;
  }
  if (include?.metadata && log.Metadata !== undefined) {
    line.metadata = log.Metadata;
  }
  const json = JSON.stringify(line);
  const bytes = new TextEncoder().encode(json);
  if (bytes.length <= MAX_LOG_LINE_BYTES) {
    return json;
  }

  const trimmed: Record<string, unknown> = { ...line };
  for (const key of ["request_body", "response_body", "metadata"] as const) {
    if (key in trimmed) {
      delete trimmed[key];
      const trimmedJson = JSON.stringify(trimmed);
      const trimmedBytes = new TextEncoder().encode(trimmedJson);
      if (trimmedBytes.length <= MAX_LOG_LINE_BYTES) {
        return trimmedJson;
      }
    }
  }

  throw new Error(`Log line exceeds maximum size even after trimming: ${bytes.length} bytes`);
}

function labelKey(stream: {
  model: string;
  status_code: string;
  env: string;
  gateway: string;
}): string {
  return `${stream.model}|${stream.status_code}|${stream.env}|${stream.gateway}`;
}

export function transformLogToLokiStream(
  log: AIGatewayLog,
  gatewayName: string,
  envLabel: string,
  include?: Parameters<typeof buildLogLine>[1],
): LokiStream {
  return {
    stream: {
      model: normalizeModelName(log.Model),
      status_code: log.StatusCode.toString(),
      env: envLabel,
      gateway: gatewayName,
    },
    values: [[requestTimeToNanos(log.RequestTime), buildLogLine(log, include)]],
  };
}

export function transformNdjsonToLokiPayload(
  ndjson: string,
  gatewayName: string,
  envLabel: string,
  include?: Parameters<typeof buildLogLine>[1],
): LokiPushPayload {
  const lines = ndjson.split("\n").filter((line) => line.trim().length > 0);
  const streamMap = new Map<string, LokiStream>();

  for (const line of lines) {
    try {
      const log = JSON.parse(line) as AIGatewayLog;
      const stream = transformLogToLokiStream(log, gatewayName, envLabel, include);
      const key = labelKey(stream.stream);
      const existing = streamMap.get(key);
      if (existing) {
        existing.values.push(...stream.values);
      } else {
        streamMap.set(key, stream);
      }
    } catch (err) {
      console.error(
        `Failed to parse or trim log line: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { streams: Array.from(streamMap.values()) };
}
