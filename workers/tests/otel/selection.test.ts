import { describe, expect, it } from "vitest";
import samplingFixtures from "../../../deploy/otel/contracts/sampling-fixtures.json";
import { parseOtlpJson } from "../../src/otel/otlp";
import { redactSpan } from "../../src/otel/redaction";
import { selectRequestSpan, shouldSampleTrace } from "../../src/otel/selection";
import { validOtlpJson } from "./fixtures";

describe("selection and sampling", () => {
  it("selects the earliest request candidate with a deterministic span-ID tie-break", () => {
    const parsed = parseOtlpJson(validOtlpJson);
    const firstSpan = parsed[0];
    if (!firstSpan) throw new Error("fixture did not produce a span");
    const base = redactSpan(firstSpan);
    const selected = selectRequestSpan([
      { ...base, spanId: "ffffffffffffffff", startTimeUnixNano: "10" },
      { ...base, spanId: "0000000000000001", startTimeUnixNano: "10" },
      {
        ...base,
        spanId: "0000000000000000",
        startTimeUnixNano: "1",
        attributes: { ...base.attributes, "span.kind": "client" },
      },
    ]);

    expect(selected.requestSpan?.spanId).toBe("0000000000000001");
    expect(
      selected.spans.filter((span) => span.attributes["graft_ai.request_span"] === true),
    ).toHaveLength(1);
    expect(
      selected.spans.find((span) => span.spanId === "0000000000000001")?.attributes[
        "graft_ai.request_span"
      ],
    ).toBe(true);
  });

  it("does not treat a child server span without a request ID as a request candidate", () => {
    const parsed = parseOtlpJson(validOtlpJson);
    const firstSpan = parsed[0];
    if (!firstSpan) throw new Error("fixture did not produce a span");
    const base = redactSpan(firstSpan);
    const childAttributes = Object.fromEntries(
      Object.entries(base.attributes).filter(([key]) => key !== "request_id"),
    );
    const selected = selectRequestSpan([
      { ...base, spanId: "0000000000000001", parentSpanId: "", startTimeUnixNano: "10" },
      {
        ...base,
        spanId: "0000000000000002",
        parentSpanId: "0000000000000001",
        startTimeUnixNano: "1",
        attributes: childAttributes,
      },
    ]);

    expect(selected.requestSpan?.spanId).toBe("0000000000000001");
    expect(
      selected.spans.find((span) => span.spanId === "0000000000000002")?.attributes[
        "graft_ai.request_span"
      ],
    ).toBe(false);
  });

  it("keeps RED metrics for a sampled-out trace", async () => {
    const parsed = parseOtlpJson(validOtlpJson);
    const firstSpan = parsed[0];
    if (!firstSpan) throw new Error("fixture did not produce a span");
    const selected = selectRequestSpan([redactSpan(firstSpan)]);

    expect(await shouldSampleTrace(selected.traceId, "0.5")).toBe(false);
  });

  it("matches every fixed sampling fixture using integer arithmetic", async () => {
    for (const fixture of samplingFixtures.traceIds) {
      for (const rate of samplingFixtures.rates) {
        await expect(shouldSampleTrace(fixture.traceId, rate.decimal)).resolves.toBe(
          Object.entries(fixture.decisions).find(([decimal]) => decimal === rate.decimal)?.[1],
        );
      }
    }
  });
});
