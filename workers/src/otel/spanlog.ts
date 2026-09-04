import {
  DURATION_OVERFLOW_SENTINEL,
  LINE_SIZE_METADATA_REASON,
  LOKI_LABEL_KEYS,
  MAX_LOKI_LINE_BYTES,
  TRUNCATED_SUFFIX,
} from "./contracts";
import type { JsonValue, LokiRecord, RedactedSpan } from "./types";
import { normalizeModelName } from "../transform";

const numericAliases = {
  input_tokens: ["input_tokens", "gen_ai.usage.input_tokens"],
  output_tokens: ["output_tokens", "gen_ai.usage.output_tokens"],
  total_tokens: ["total_tokens", "gen_ai.usage.total_tokens"],
  cost_usd: ["cost_usd", "gen_ai.usage.cost_usd", "gen_ai.usage.cost"],
  duration_ms: ["duration_ms", "gen_ai.duration_ms"],
} as const;

export function projectLokiRecord(span: RedactedSpan): LokiRecord | null {
  const labels = canonicalLabels(span);
  const fields: Record<string, JsonValue> = {
    trace_id: span.traceId,
    span_id: span.spanId,
    status: span.statusCode,
    model: normalizeModelName(firstString(span, "model", "gen_ai.request.model")),
    provider: firstString(span, "provider", "gen_ai.model.provider", "gen_ai.system"),
    status_code: firstString(span, "status_code", "http.response.status_code") || span.statusCode,
    gateway: firstString(span, "gateway"),
    env: firstString(span, "env"),
  };
  const requestId = firstValue(span, "request_id", "cf-aig-request-id");
  if (requestId !== undefined) fields.request_id = requestId;

  let numericFieldInvalid = false;
  for (const [target, aliases] of Object.entries(numericAliases)) {
    const value = firstValue(span, ...aliases);
    if (value === undefined) continue;
    const numeric = finiteNumber(value);
    if (numeric === null || (target === "duration_ms" && numeric < 0)) {
      numericFieldInvalid = true;
      continue;
    }
    fields[target] = numeric;
  }
  if (fields.duration_ms === undefined) {
    const duration = durationMilliseconds(span);
    if (duration !== null) fields.duration_ms = duration;
  }

  const prompt = payloadValue(firstValue(span, "gen_ai.prompt_json", "prompt"));
  const completion = payloadValue(firstValue(span, "gen_ai.completion_json", "completion"));
  if (prompt !== undefined) fields.prompt = prompt;
  if (completion !== undefined) fields.completion = completion;
  if (span.payloadDropped) {
    fields.payload_dropped = true;
    fields.payload_drop_reason = span.payloadDropReason ?? "redaction_failure";
  } else if (numericFieldInvalid) {
    fields.payload_dropped = true;
    fields.payload_drop_reason = "numeric_field_invalid";
  }

  const serialized = fitLine(fields);
  if (!serialized) return null;
  return {
    labels,
    timestampUnixNano: span.endTimeUnixNano !== "0" ? span.endTimeUnixNano : span.startTimeUnixNano,
    line: serialized,
  };
}

function canonicalLabels(span: RedactedSpan): Record<(typeof LOKI_LABEL_KEYS)[number], string> {
  return {
    model: normalizeModelName(firstString(span, "model", "gen_ai.request.model")),
    status_code:
      firstString(span, "status_code", "http.response.status_code") || span.statusCode || "unknown",
    env: firstString(span, "env") || "unknown",
    gateway: firstString(span, "gateway") || "unknown",
  };
}

function fitLine(fields: Record<string, JsonValue>): string | null {
  const initial = JSON.stringify(fields);
  if (byteLength(initial) <= MAX_LOKI_LINE_BYTES) return initial;

  const originalPrompt = fields.prompt;
  const originalCompletion = fields.completion;
  const metadata = { ...fields };
  delete metadata.prompt;
  delete metadata.completion;
  metadata.payload_truncated = true;
  const metadataSize = byteLength(JSON.stringify(metadata));
  if (metadataSize > MAX_LOKI_LINE_BYTES) return null;

  const payloadKeys = [
    originalPrompt === undefined ? null : "prompt",
    originalCompletion === undefined ? null : "completion",
  ].filter((key): key is "prompt" | "completion" => key !== null);
  if (payloadKeys.length === 0) return fitDroppedPayload(metadata);

  const empty = { ...metadata };
  for (const key of payloadKeys) empty[key] = "";
  let remaining = Math.max(MAX_LOKI_LINE_BYTES - byteLength(JSON.stringify(empty)), 0);
  const hasPrompt = originalPrompt !== undefined;
  const hasCompletion = originalCompletion !== undefined;
  let promptBudget =
    payloadKeys.length === 2 ? Math.floor(remaining / 2) : hasPrompt ? remaining : 0;
  let completionBudget =
    payloadKeys.length === 2 ? remaining - promptBudget : hasCompletion ? remaining : 0;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = { ...metadata };
    if (originalPrompt !== undefined)
      candidate.prompt = truncateValue(originalPrompt, promptBudget);
    if (originalCompletion !== undefined) {
      candidate.completion = truncateValue(originalCompletion, completionBudget);
    }
    const serialized = JSON.stringify(candidate);
    const size = byteLength(serialized);
    if (size <= MAX_LOKI_LINE_BYTES) return serialized;
    const excess = size - MAX_LOKI_LINE_BYTES + 1;
    if (payloadKeys.length === 2) {
      const promptReduction = Math.ceil(excess / 2);
      promptBudget = Math.max(promptBudget - promptReduction, 0);
      completionBudget = Math.max(completionBudget - (excess - promptReduction), 0);
    } else {
      promptBudget = Math.max(promptBudget - excess, 0);
      completionBudget = Math.max(completionBudget - excess, 0);
    }
    remaining = promptBudget + completionBudget;
    if (remaining === 0) break;
  }
  return fitDroppedPayload(metadata);
}

function fitDroppedPayload(metadata: Record<string, JsonValue>): string | null {
  const dropped = { ...metadata };
  delete dropped.payload_truncated;
  dropped.payload_dropped = true;
  dropped.payload_drop_reason = LINE_SIZE_METADATA_REASON;
  const serialized = JSON.stringify(dropped);
  return byteLength(serialized) <= MAX_LOKI_LINE_BYTES ? serialized : null;
}

function truncateValue(value: JsonValue, budget: number): JsonValue {
  if (typeof value === "string") return truncateUtf8(value, budget);
  const serialized = JSON.stringify(value);
  if (byteLength(serialized) <= budget) return value;
  return truncateUtf8(serialized, budget);
}

function truncateUtf8(value: string, budget: number): string {
  if (budget <= 0) return TRUNCATED_SUFFIX;
  const suffixBytes = byteLength(TRUNCATED_SUFFIX);
  const target = Math.max(budget - suffixBytes, 0);
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= budget) return value;
  let end = Math.min(target, bytes.byteLength);
  while (end > 0) {
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        bytes.slice(0, end),
      );
      return decoded + TRUNCATED_SUFFIX;
    } catch {
      end -= 1;
    }
  }
  return TRUNCATED_SUFFIX;
}

function payloadValue(value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined || typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isJsonValue(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function firstValue(span: RedactedSpan, ...keys: readonly string[]): JsonValue | undefined {
  return keys.map((key) => span.attributes[key]).find((value) => value !== undefined);
}

function firstString(span: RedactedSpan, ...keys: readonly string[]): string {
  const value = firstValue(span, ...keys);
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function finiteNumber(value: JsonValue): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function durationMilliseconds(span: RedactedSpan): number | null {
  try {
    const start = BigInt(span.startTimeUnixNano);
    const end = BigInt(span.endTimeUnixNano);
    if (start <= 0n || end <= 0n || end < start) return null;
    const duration = Number(end - start) / 1_000_000;
    return Number.isFinite(duration) ? duration : DURATION_OVERFLOW_SENTINEL;
  } catch {
    return null;
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}
