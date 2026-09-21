import { describe, expect, it } from "vitest";
import { buildHealthMetrics, type ScrapeHealthOutcome } from "../../src/provider-metrics/health";

function metricValue(metric: Record<string, unknown>): number {
  const gauge = metric.gauge as { dataPoints: Array<{ asDouble: number }> };
  return gauge.dataPoints[0]?.asDouble ?? Number.NaN;
}

function metricNames(metrics: readonly Record<string, unknown>[]): string[] {
  return metrics.map((metric) => metric.name as string);
}

describe("buildHealthMetrics", () => {
  it("emits success, duration, and timestamp metrics for a successful scrape", () => {
    const outcome: ScrapeHealthOutcome = {
      provider: "openai_api",
      status: "success",
      durationSeconds: 1.25,
      timestampSeconds: 1_700_000_000,
    };

    const metrics = buildHealthMetrics([outcome]);

    expect(metricNames(metrics)).toEqual([
      "provider_metrics_scrape_success",
      "provider_metrics_scrape_duration_seconds",
      "provider_metrics_scrape_timestamp_seconds",
    ]);
    expect(metricValue(metrics[0] ?? {})).toBe(1);
    expect(metricValue(metrics[1] ?? {})).toBe(1.25);
    expect(metricValue(metrics[2] ?? {})).toBe(1_700_000_000);
  });

  it("emits success, duration, and timestamp for an empty scrape", () => {
    const outcome: ScrapeHealthOutcome = {
      provider: "ollama_cloud",
      status: "empty",
      durationSeconds: 0.5,
      timestampSeconds: 1_700_000_001,
    };

    const metrics = buildHealthMetrics([outcome]);

    expect(metricNames(metrics)).toEqual([
      "provider_metrics_scrape_success",
      "provider_metrics_scrape_duration_seconds",
      "provider_metrics_scrape_timestamp_seconds",
    ]);
    expect(metricValue(metrics[0] ?? {})).toBe(1);
    expect(metricValue(metrics[1] ?? {})).toBe(0.5);
    expect(metricValue(metrics[2] ?? {})).toBe(1_700_000_001);
  });

  it("emits failure and duration without timestamp for a failed scrape", () => {
    const outcome: ScrapeHealthOutcome = {
      provider: "codex",
      status: "failed",
      durationSeconds: 2,
      timestampSeconds: 1_700_000_002,
    };

    const metrics = buildHealthMetrics([outcome]);

    expect(metricNames(metrics)).toEqual([
      "provider_metrics_scrape_success",
      "provider_metrics_scrape_duration_seconds",
    ]);
    expect(metricValue(metrics[0] ?? {})).toBe(0);
    expect(metricValue(metrics[1] ?? {})).toBe(2);
  });
});
