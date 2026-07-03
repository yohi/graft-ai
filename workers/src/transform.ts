import type { AIGatewayLog, LokiStream, LokiPushPayload } from "./types";

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
  const s = Math.floor(requestTime).toString();
  if (s.length <= 10) {
    // Seconds → nanoseconds
    return (BigInt(requestTime) * 1_000_000_000n).toString();
  }
  if (s.length <= 13) {
    // Milliseconds → nanoseconds
    return (BigInt(requestTime) * 1_000_000n).toString();
  }
  // Already nanoseconds (≥19 digits)
  return BigInt(requestTime).toString();
}

export function buildLogLine(log: AIGatewayLog): string {
  const line = {
    request_id: log.RequestID,
    cache_status: log.CacheStatus,
    prompt_tokens: log.PromptTokens,
    completion_tokens: log.CompletionTokens,
    total_tokens: log.TotalTokens,
    duration_ms: log.RequestDuration,
    path: log.Path,
    method: log.Method,
  };
  return JSON.stringify(line);
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
): LokiStream {
  return {
    stream: {
      model: normalizeModelName(log.Model),
      status_code: log.StatusCode.toString(),
      env: envLabel,
      gateway: gatewayName,
    },
    values: [[requestTimeToNanos(log.RequestTime), buildLogLine(log)]],
  };
}

export function transformNdjsonToLokiPayload(
  ndjson: string,
  gatewayName: string,
  envLabel: string,
): LokiPushPayload {
  const lines = ndjson.split("\n").filter((line) => line.trim().length > 0);
  const streamMap = new Map<string, LokiStream>();

  for (const line of lines) {
    try {
      const log = JSON.parse(line) as AIGatewayLog;
      const stream = transformLogToLokiStream(log, gatewayName, envLabel);
      const key = labelKey(stream.stream);
      const existing = streamMap.get(key);
      if (existing) {
        existing.values.push(...stream.values);
      } else {
        streamMap.set(key, stream);
      }
    } catch (err) {
      // Skip invalid JSON line, log to console (Workers Logs)
      console.error(
        `Failed to parse log line: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { streams: Array.from(streamMap.values()) };
}
