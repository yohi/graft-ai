import { SAMPLING_SEED } from "./contracts";
import type { JsonValue, RedactedSpan, SelectedTrace } from "./types";

export function selectRequestSpan(spans: readonly RedactedSpan[]): SelectedTrace {
  const traceId = spans[0]?.traceId ?? "";
  const selectedIndex = spans.reduce<number>((current, span, index) => {
    if (!isRequestCandidate(span)) return current;
    if (current < 0) return index;
    return spanBefore(span, spans[current] ?? span) ? index : current;
  }, -1);

  const selectedSpans = spans.map((span, index) => {
    const attributes: Record<string, JsonValue> = {
      ...span.attributes,
      "graft_ai.request_span": index === selectedIndex,
    };
    return { ...span, attributes };
  });

  return {
    traceId,
    spans: selectedSpans,
    requestSpan: selectedIndex >= 0 ? (selectedSpans[selectedIndex] ?? null) : null,
  };
}

export async function shouldSampleTrace(traceId: string, decimalRate: string): Promise<boolean> {
  const ratePpm = parseRatePpm(decimalRate);
  if (ratePpm === null || !/^[0-9a-f]{32}$/.test(traceId)) return false;

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(traceId + SAMPLING_SEED),
  );
  const bytes = new Uint8Array(digest);
  let hash64 = 0n;
  for (let index = 0; index < 8; index += 1) {
    hash64 = (hash64 << 8n) | BigInt(bytes[index] ?? 0);
  }
  const highProduct = (hash64 * 1_000_000n) >> 64n;
  return highProduct < BigInt(ratePpm);
}

function isRequestCandidate(span: RedactedSpan): boolean {
  if (attributeString(span, "span.kind") !== "server") return false;
  const parentSpanId = span.parentSpanId;
  const requestId = attributeString(span, "request_id");
  return parentSpanId === "" || requestId !== "";
}

function spanBefore(left: RedactedSpan, right: RedactedSpan): boolean {
  const timeOrder = compareDecimalStrings(left.startTimeUnixNano, right.startTimeUnixNano);
  return timeOrder === 0 ? left.spanId < right.spanId : timeOrder < 0;
}

function compareDecimalStrings(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length < normalizedRight.length ? -1 : 1;
  }
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}

function attributeString(span: RedactedSpan, key: string): string {
  const value = span.attributes[key];
  return typeof value === "string" ? value.toLowerCase() : "";
}

function parseRatePpm(decimalRate: string): number | null {
  const value = decimalRate.trim();
  const parts = value.split(".");
  if (parts.length > 2 || (parts[0] !== "0" && parts[0] !== "1")) return null;
  const fraction = parts[1] ?? "";
  if (!/^\d*$/.test(fraction)) return null;
  if (parts[0] === "1" && fraction.replaceAll("0", "") !== "") return null;
  const padded = (fraction.slice(0, 6) + "000000").slice(0, 6);
  const ppm = Number(padded);
  return parts[0] === "1" ? 1_000_000 : ppm;
}
