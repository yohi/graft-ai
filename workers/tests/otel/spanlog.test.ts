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
});
