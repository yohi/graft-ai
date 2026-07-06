import { describe, it, expect } from "vitest";
import { computeReset } from "../../src/ollama-cloud/calc";

describe("computeReset", () => {
  it("computes session reset from anchor", () => {
    const result = computeReset(3600, 0, 18000, "session");
    expect(result.period).toBe("session");
    expect(result.intervalSeconds).toBe(18000);
    expect(result.remainingSeconds).toBe(14400);
    expect(result.nextResetTimestampSeconds).toBe(18000);
    expect(result.progressRatio).toBeCloseTo(0.2);
  });

  it("computes weekly reset from anchor", () => {
    const result = computeReset(86400, 0, 604800, "weekly");
    expect(result.period).toBe("weekly");
    expect(result.intervalSeconds).toBe(604800);
    expect(result.remainingSeconds).toBe(518400);
    expect(result.nextResetTimestampSeconds).toBe(604800);
    expect(result.progressRatio).toBeCloseTo(0.142857, 5);
  });

  it("wraps around after multiple intervals", () => {
    const result = computeReset(19000, 0, 18000, "session");
    expect(result.remainingSeconds).toBe(17000);
    expect(result.nextResetTimestampSeconds).toBe(36000);
    expect(result.progressRatio).toBeCloseTo(0.0556, 3);
  });

  it("handles negative elapsed time gracefully", () => {
    const result = computeReset(0, 3600, 18000, "session");
    expect(result.remainingSeconds).toBe(3600);
    expect(result.nextResetTimestampSeconds).toBe(3600);
  });

  it("throws on non-positive interval", () => {
    expect(() => computeReset(0, 0, 0, "session")).toThrow();
    expect(() => computeReset(0, 0, -1, "session")).toThrow();
  });
});
