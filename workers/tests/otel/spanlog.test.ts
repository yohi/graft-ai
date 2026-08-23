import { describe, expect, it } from "vitest";
import { parseOtlpJson } from "../../src/otel/otlp";
import { redactSpan } from "../../src/otel/redaction";
import { projectLokiRecord } from "../../src/otel/spanlog";
import { validOtlpJson } from "./fixtures";

describe("projectLokiRecord", () => {
  it("emits exactly the four canonical labels and redacted fields", () => {
    const parsed = parseOtlpJson(validOtlpJson);
    const firstSpan = parsed[0];
    if (!firstSpan) throw new Error("fixture did not produce a span");
    const span = redactSpan(firstSpan);
    const record = projectLokiRecord(span);

    expect(record).not.toBeNull();
    expect(Object.keys(record?.labels ?? {}).sort()).toEqual([
      "env",
      "gateway",
      "model",
      "status_code",
    ]);
    expect(record?.labels).toEqual({
      model: "smoke-model",
      status_code: "200",
      env: "prod",
      gateway: "main",
    });
    expect(record?.line).toContain("[REDACTED]");
    expect(record?.line).not.toContain("sk-live-test-secret");
  });

  it("truncates UTF-8 payload fields without splitting a code point", () => {
    const parsed = parseOtlpJson(validOtlpJson);
    const firstSpan = parsed[0];
    if (!firstSpan) throw new Error("fixture did not produce a span");
    const span = redactSpan(firstSpan);
    const record = projectLokiRecord({
      ...span,
      attributes: {
        ...span.attributes,
        "gen_ai.prompt_json": "😀".repeat(200_000),
      },
    });

    expect(record).not.toBeNull();
    expect(new TextEncoder().encode(record?.line ?? "").byteLength).toBeLessThanOrEqual(262_144);
    expect(record?.line).toContain("[TRUNCATED]");
    expect(() => JSON.parse(record?.line ?? "{}")).not.toThrow();
  });

  it("drops the record when metadata alone exceeds the line limit", () => {
    const parsed = parseOtlpJson(validOtlpJson);
    const firstSpan = parsed[0];
    if (!firstSpan) throw new Error("fixture did not produce a span");
    const span = redactSpan(firstSpan);
    const record = projectLokiRecord({
      ...span,
      attributes: {
        ...span.attributes,
        model: "m".repeat(300_000),
      },
    });

    expect(record).toBeNull();
  });

  it("retains a completion-only payload when truncating an oversized line", () => {
    const parsed = parseOtlpJson(validOtlpJson);
    const firstSpan = parsed[0];
    if (!firstSpan) throw new Error("fixture did not produce a span");
    const attributes = { ...firstSpan.attributes };
    delete attributes["gen_ai.prompt_json"];
    attributes["gen_ai.completion_json"] = "😀".repeat(200_000);

    const record = projectLokiRecord(redactSpan({ ...firstSpan, attributes }));
    expect(record).not.toBeNull();
    const line = JSON.parse(record?.line ?? "{}");
    expect(line.completion).toEqual(expect.any(String));
    expect(line.completion.length).toBeGreaterThan(0);
    expect(line.completion).not.toBe("[TRUNCATED]");
    expect(new TextEncoder().encode(record?.line ?? "").byteLength).toBeLessThanOrEqual(262_144);
  });

  it("calculates duration from nanosecond strings without Number precision loss", () => {
    const parsed = parseOtlpJson(validOtlpJson);
    const firstSpan = parsed[0];
    if (!firstSpan) throw new Error("fixture did not produce a span");
    const start = 1_700_000_000_000_000_000n;
    const end = start + 123_456_789n;
    const record = projectLokiRecord(
      redactSpan({
        ...firstSpan,
        startTimeUnixNano: String(start),
        endTimeUnixNano: String(end),
      }),
    );
    const line = JSON.parse(record?.line ?? "{}");

    expect(line.duration_ms).toBeCloseTo(123.456789, 6);
  });

  it("falls back to timestamp duration when an explicit duration is negative", () => {
    const parsed = parseOtlpJson(validOtlpJson);
    const firstSpan = parsed[0];
    if (!firstSpan) throw new Error("fixture did not produce a span");

    const record = projectLokiRecord(
      redactSpan({
        ...firstSpan,
        attributes: { ...firstSpan.attributes, "gen_ai.duration_ms": -20 },
      }),
    );
    const line = JSON.parse(record?.line ?? "{}");

    expect(line.duration_ms).toBeCloseTo(125, 9);
  });
});
