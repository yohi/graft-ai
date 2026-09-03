import { describe, expect, it } from "vitest";
import { parseOtlpJson } from "../../src/otel/otlp";
import { redactSpan } from "../../src/otel/redaction";
import { toMetricSamples } from "../../src/otel/otlp-json";
import type { SelectedTrace } from "../../src/otel/types";
import { validOtlpJson } from "./fixtures";

describe("parseOtlpJson", () => {
  it("accepts OTLP JSON with valid 16-byte trace and 8-byte span IDs", () => {
    const spans = parseOtlpJson(validOtlpJson);

    expect(spans).toHaveLength(1);
    expect(spans[0]?.traceId).toBe("00112233445566778899aabbccddeeff");
    expect(spans[0]?.spanId).toBe("0112233445566778");
    expect(spans[0]?.attributes.model).toBe("smoke-model");
    expect(spans[0]?.attributes.provider).toBe("smoke-provider");
  });

  it("rejects an empty span set and malformed trace IDs", () => {
    expect(() => parseOtlpJson({ resourceSpans: [] })).toThrow(/span/i);
    expect(() =>
      parseOtlpJson({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [{ traceId: "not-a-trace-id", spanId: "0112233445566778" }],
              },
            ],
          },
        ],
      }),
    ).toThrow(/trace ID/i);
  });

  it("orders top-level and nested attribute keys by code point", () => {
    const spans = parseOtlpJson({
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "11111111111111111111111111111111",
                  spanId: "1111111111111111",
                  name: "ordered",
                  kind: "SPAN_KIND_SERVER",
                  startTimeUnixNano: "1",
                  endTimeUnixNano: "2",
                  status: { code: "STATUS_CODE_OK" },
                  attributes: [
                    { key: "z", value: { stringValue: "z" } },
                    { key: "a", value: { stringValue: "a" } },
                    { key: "ä", value: { stringValue: "umlaut" } },
                    {
                      key: "nested",
                      value: {
                        kvlistValue: {
                          values: [
                            { key: "z", value: { stringValue: "z" } },
                            { key: "a", value: { stringValue: "a" } },
                            { key: "ä", value: { stringValue: "umlaut" } },
                          ],
                        },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const attributes = spans[0]?.attributes;
    if (!attributes) throw new Error("parsed attributes missing");
    const nested = attributes.nested;
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
      throw new Error("nested attributes missing");
    }

    expect(Object.keys(attributes).filter((key) => ["a", "z", "ä"].includes(key))).toEqual([
      "a",
      "z",
      "ä",
    ]);
    expect(Object.keys(nested)).toEqual(["a", "z", "ä"]);
  });

  it("fills missing low-cardinality identity attributes with unknown", () => {
    const spans = parseOtlpJson({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "11111111111111111111111111111111",
                  spanId: "1111111111111111",
                  name: "minimal",
                  startTimeUnixNano: "1",
                  endTimeUnixNano: "2",
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(spans[0]?.attributes.model).toBe("unknown");
    expect(spans[0]?.attributes.provider).toBe("unknown");
    expect(spans[0]?.attributes.gateway).toBe("unknown");
    expect(spans[0]?.attributes.env).toBe("unknown");
    expect(spans[0]?.attributes.request_id).toBeUndefined();
  });
});

describe("toMetricSamples", () => {
  it("normalizes corrupted model name in metric labels", () => {
    const parsed = parseOtlpJson(validOtlpJson);
    const firstSpan = parsed[0];
    if (!firstSpan) throw new Error("fixture did not produce a span");
    const span = redactSpan(firstSpan);
    const trace: SelectedTrace = {
      traceId: span.traceId,
      spans: [span],
      requestSpan: {
        ...span,
        attributes: {
          ...span.attributes,
          model: "kimi-k2.7-codemoonshotai/Kimi-K2.7-Code",
        },
      },
    };
    const samples = toMetricSamples(trace);
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      expect(sample.labels.model).toBe("kimi-k2.7-code");
    }
  });
});
