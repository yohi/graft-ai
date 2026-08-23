import { ATTRIBUTE_ALIASES } from "./contracts";
import type { Attributes, CanonicalSpan, JsonValue } from "./types";

export class OtelParseError extends Error {
  readonly name = "OtelParseError";
}

type RecordValue = Record<string, unknown>;

export function parseOtlpJson(body: unknown): readonly CanonicalSpan[] {
  const root = record(body, "OTLP body");
  const resourceSpans = array(root["resourceSpans"], "resourceSpans");
  const spans: CanonicalSpan[] = [];

  for (const resourceSpanValue of resourceSpans) {
    const resourceSpan = record(resourceSpanValue, "resource span");
    const resourceAttributes = parseAttributes(recordValue(resourceSpan["resource"])["attributes"]);
    const scopeSpans = array(
      resourceSpan["scopeSpans"] ?? resourceSpan["instrumentationLibrarySpans"],
      "scopeSpans",
    );
    for (const scopeSpanValue of scopeSpans) {
      const scopeSpan = record(scopeSpanValue, "scope span");
      const spanValues = array(scopeSpan["spans"], "spans");
      for (const spanValue of spanValues) {
        spans.push(parseSpan(spanValue, resourceAttributes));
      }
    }
  }

  if (spans.length === 0) throw new OtelParseError("OTLP body contains no spans");
  return spans;
}

function parseSpan(value: unknown, resourceAttributes: Attributes): CanonicalSpan {
  const span = record(value, "span");
  const traceId = hexId(span["traceId"], 32, "trace ID");
  const spanId = hexId(span["spanId"], 16, "span ID");
  const parentSpanId = span["parentSpanId"]
    ? hexId(span["parentSpanId"], 16, "parent span ID")
    : "";
  const attributes = normalizeAttributes(parseAttributes(span["attributes"]));
  const status = recordValue(span["status"]);
  const canonicalAttributes: Record<string, JsonValue> = {
    ...attributes,
    "span.kind": spanKind(span["kind"]),
  };
  for (const [canonical, aliases] of Object.entries(ATTRIBUTE_ALIASES)) {
    const valueForAlias = aliases
      .map((alias) => canonicalAttributes[alias])
      .find((candidate) => candidate !== undefined);
    if (valueForAlias !== undefined) canonicalAttributes[canonical] = valueForAlias;
  }
  for (const key of ["model", "provider", "gateway", "env"] as const) {
    if (canonicalAttributes[key] === undefined) canonicalAttributes[key] = "unknown";
  }

  return {
    traceId,
    spanId,
    parentSpanId,
    name: stringValue(span["name"]) ?? "unknown",
    kind: spanKind(span["kind"]),
    statusCode: statusCode(status["code"]),
    statusMessage: stringValue(status["message"]) ?? "",
    startTimeUnixNano: uint64(span["startTimeUnixNano"], "start time") ?? "0",
    endTimeUnixNano: uint64(span["endTimeUnixNano"], "end time") ?? "0",
    attributes: sortAttributes(canonicalAttributes),
    resourceAttributes: sortAttributes(resourceAttributes),
  };
}

function parseAttributes(value: unknown): Attributes {
  if (value === undefined || value === null) return {};
  if (Array.isArray(value)) {
    const entries: Array<readonly [string, JsonValue]> = [];
    for (const item of value) {
      const attribute = record(item, "attribute");
      const key = stringValue(attribute["key"]);
      if (!key) throw new OtelParseError("attribute key is missing");
      entries.push([key, readAttributeValue(attribute["value"]) ?? null]);
    }
    return Object.fromEntries(entries);
  }
  const object = record(value, "attributes");
  return Object.fromEntries(
    Object.entries(object).map(([key, child]) => [key, readAttributeValue(child) ?? null]),
  );
}

function readAttributeValue(value: unknown): JsonValue | undefined {
  if (!isRecord(value)) return jsonValue(value);
  if ("stringValue" in value) return jsonValue(value["stringValue"]);
  if ("intValue" in value) return integerValue(value["intValue"]);
  if ("doubleValue" in value) return numberValue(value["doubleValue"]);
  if ("boolValue" in value) return jsonValue(value["boolValue"]);
  if ("bytesValue" in value) return jsonValue(value["bytesValue"]);
  if ("arrayValue" in value) {
    const array = record(value["arrayValue"], "array value");
    return arrayValue(array["values"]);
  }
  if ("kvlistValue" in value) {
    const list = record(value["kvlistValue"], "key-value list");
    return parseAttributes(list["values"]);
  }
  return jsonValue(value);
}

function arrayValue(value: unknown): readonly JsonValue[] {
  return array(value, "array value").map((child) => readAttributeValue(child) ?? null);
}

function normalizeAttributes(attributes: Attributes): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function sortAttributes(attributes: Record<string, JsonValue>): Attributes {
  return Object.fromEntries(
    Object.entries(attributes)
      .sort(([left], [right]) => compareKeys(left, right))
      .map(([key, value]) => [key, sortJson(value)]),
  );
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareKeys(left, right))
        .map(([key, child]) => [key, sortJson(child as JsonValue)]),
    );
  }
  return value;
}

function compareKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function spanKind(value: unknown): string {
  if (typeof value === "number") {
    return (
      ["unspecified", "internal", "server", "client", "producer", "consumer"][value] ??
      "unspecified"
    );
  }
  const text = stringValue(value)?.toLowerCase().replace("span_kind_", "");
  return text ?? "unspecified";
}

function statusCode(value: unknown): string {
  if (value === 1 || stringValue(value)?.toUpperCase() === "STATUS_CODE_OK") return "OK";
  if (value === 2 || stringValue(value)?.toUpperCase() === "STATUS_CODE_ERROR") return "ERROR";
  return "UNSET";
}

function hexId(value: unknown, length: number, label: string): string {
  const text = stringValue(value)?.toLowerCase();
  if (!text || !new RegExp(`^[0-9a-f]{${length}}$`).test(text)) {
    throw new OtelParseError(`invalid ${label}`);
  }
  return text;
}

function uint64(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new OtelParseError(`invalid ${label}`);
    return String(value);
  }
  const text = stringValue(value);
  if (!text || !/^\d+$/.test(text)) throw new OtelParseError(`invalid ${label}`);
  return text;
}

function integerValue(value: unknown): JsonValue {
  const text = stringValue(value);
  if (text && /^-?\d+$/.test(text)) return text;
  return jsonValue(value) ?? null;
}

function numberValue(value: unknown): JsonValue {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new OtelParseError("non-finite numeric attribute");
    return value;
  }
  const text = stringValue(value);
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw new OtelParseError("non-finite numeric attribute");
  return parsed;
}

function jsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new OtelParseError("non-finite attribute");
    return value;
  }
  if (Array.isArray(value)) return value.map((child) => jsonValue(child) ?? null);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, jsonValue(child) ?? null]),
    );
  }
  return undefined;
}

function recordValue(value: unknown): RecordValue {
  return isRecord(value) ? value : {};
}

function record(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw new OtelParseError(`${label} must be an object`);
  return value;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new OtelParseError(`${label} must be an array`);
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
