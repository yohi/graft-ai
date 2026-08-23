import { MAX_JSON_DEPTH, REDACTED_VALUE } from "./contracts";
import type { CanonicalSpan, JsonValue, RedactedSpan } from "./types";

const payloadKeys = new Set([
  "gen_ai.prompt_json",
  "gen_ai.completion_json",
  "cf-aig-metadata",
  "prompt",
  "completion",
]);

const numericKeys = new Set([
  "input_tokens",
  "gen_ai.usage.input_tokens",
  "output_tokens",
  "gen_ai.usage.output_tokens",
  "total_tokens",
  "gen_ai.usage.total_tokens",
  "gen_ai.usage.cache_read.input_tokens",
  "gen_ai.usage.cache_creation.input_tokens",
  "cost_usd",
  "gen_ai.usage.cost_usd",
  "duration_ms",
  "gen_ai.duration_ms",
]);

const credentialPatterns = [
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:api[_-]?key|access[_-]?token|secret|password|credential)\s*[:=]\s*[^\s,;]+/gi,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:ghp|gho|github_pat|xox[baprs])-[A-Za-z0-9_-]+\b/g,
];

export function redactSpan(span: CanonicalSpan): RedactedSpan {
  const attributes: Record<string, JsonValue> = {};
  const resourceAttributes: Record<string, JsonValue> = {};
  let payloadDropped = false;
  let payloadDropReason: string | undefined;

  for (const [key, value] of Object.entries(span.attributes)) {
    if (payloadKeys.has(key.toLowerCase())) {
      try {
        attributes[key] = redactPayload(value);
      } catch {
        payloadDropped = true;
        payloadDropReason = "redaction_failure";
      }
      continue;
    }
    attributes[key] = redactAttribute(key, value);
  }
  for (const [key, value] of Object.entries(span.resourceAttributes)) {
    resourceAttributes[key] = redactAttribute(key, value);
  }

  return {
    ...span,
    attributes,
    resourceAttributes,
    payloadDropped,
    ...(payloadDropReason ? { payloadDropReason } : {}),
  };
}

function redactAttribute(key: string, value: JsonValue): JsonValue {
  if (isSecretKey(key)) return REDACTED_VALUE;
  return redactJsonValue(value, 0);
}

function redactPayload(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const parsed: unknown = JSON.parse(trimmed);
      return JSON.stringify(redactJsonValue(asJsonValue(parsed), 0));
    }
    return redactString(value);
  }
  return redactJsonValue(value, 0);
}

function redactJsonValue(value: JsonValue, depth: number): JsonValue {
  if (depth > MAX_JSON_DEPTH) throw new Error("redaction depth exceeded");
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((child) => redactJsonValue(child, depth + 1));
  if (isJsonObject(value)) {
    const clean: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      clean[key] = isSecretKey(key) ? REDACTED_VALUE : redactJsonValue(child, depth + 1);
    }
    return clean;
  }
  return value;
}

function asJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(asJsonValue);
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, asJsonValue(child)]),
    );
  }
  throw new Error("invalid JSON value");
}

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (numericKeys.has(lower)) return false;
  return [
    "authorization",
    "api_key",
    "api-key",
    "apikey",
    "secret",
    "token",
    "password",
    "credential",
  ].some((marker) => lower.includes(marker));
}

function redactString(value: string): string {
  return credentialPatterns.reduce(
    (current, pattern) => current.replace(pattern, REDACTED_VALUE),
    value,
  );
}

function isJsonObject(value: JsonValue | unknown): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
