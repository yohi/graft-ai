import { describe, expect, it } from "vitest";
import { parseOtlpJson } from "../../src/otel/otlp";
import { redactSpan } from "../../src/otel/redaction";
import type { JsonValue } from "../../src/otel/types";
import { validOtlpJson } from "./fixtures";

describe("redactSpan", () => {
  it("redacts credentials in nested payloads and ordinary attributes", () => {
    const span = parseOtlpJson(validOtlpJson)[0];
    if (!span) throw new Error("fixture did not produce a span");

    const redacted = redactSpan({
      ...span,
      attributes: {
        ...span.attributes,
        password: "plain-secret",
        metadata: { nested: { api_key: "sk-nested-secret" } },
      },
    });

    const serialized = JSON.stringify(redacted);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("sk-live-test-secret");
    expect(serialized).not.toContain("sk-nested-secret");
    expect(redacted.attributes.password).toBe("[REDACTED]");
  });

  it("drops only malformed payload fields and records the failure reason", () => {
    const span = parseOtlpJson(validOtlpJson)[0];
    if (!span) throw new Error("fixture did not produce a span");

    const redacted = redactSpan({
      ...span,
      attributes: { ...span.attributes, "gen_ai.prompt_json": '{"unclosed":' },
    });

    expect(redacted.attributes["gen_ai.prompt_json"]).toBeUndefined();
    expect(redacted.payloadDropped).toBe(true);
    expect(redacted.payloadDropReason).toBe("redaction_failure");
    expect(redacted.attributes.model).toBe("smoke-model");
  });

  it("fails closed for payloads deeper than the maximum supported depth", () => {
    const span = parseOtlpJson(validOtlpJson)[0];
    if (!span) throw new Error("fixture did not produce a span");
    let payload: JsonValue = null;
    for (let index = 0; index < 65; index += 1) payload = { nested: payload };

    const redacted = redactSpan({
      ...span,
      attributes: { ...span.attributes, "gen_ai.prompt_json": payload },
    });

    expect(redacted.attributes["gen_ai.prompt_json"]).toBeUndefined();
    expect(redacted.payloadDropReason).toBe("redaction_failure");
  });

  it("redacts unknown token-like keys instead of treating them as numeric", () => {
    const span = parseOtlpJson(validOtlpJson)[0];
    if (!span) throw new Error("fixture did not produce a span");

    const redacted = redactSpan({
      ...span,
      attributes: { ...span.attributes, access_tokens: "opaque-secret" },
    });

    expect(redacted.attributes.access_tokens).toBe("[REDACTED]");
  });

  it("preserves numeric cache token attributes", () => {
    const span = parseOtlpJson(validOtlpJson)[0];
    if (!span) throw new Error("fixture did not produce a span");

    const redacted = redactSpan({
      ...span,
      attributes: {
        ...span.attributes,
        "gen_ai.usage.cache_read.input_tokens": 12,
        "gen_ai.usage.cache_creation.input_tokens": 3,
      },
    });

    expect(redacted.attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(12);
    expect(redacted.attributes["gen_ai.usage.cache_creation.input_tokens"]).toBe(3);
  });
});
