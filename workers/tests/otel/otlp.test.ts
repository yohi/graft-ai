import { describe, expect, it } from "vitest";
import { parseOtlpJson } from "../../src/otel/otlp";
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
