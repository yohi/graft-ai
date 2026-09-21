import type { ProviderId } from "./types";

export interface ScrapeHealthOutcome {
  readonly provider: ProviderId;
  readonly status: "success" | "empty" | "failed";
  readonly durationSeconds: number;
  readonly timestampSeconds?: number;
}

function providerAttribute(provider: ProviderId): Record<string, unknown> {
  return { key: "provider", value: { stringValue: provider } };
}

function gaugeMetric(
  name: string,
  provider: ProviderId,
  value: number,
  nowUnixNano: string,
): Record<string, unknown> {
  return {
    name,
    gauge: {
      dataPoints: [
        { attributes: [providerAttribute(provider)], asDouble: value, timeUnixNano: nowUnixNano },
      ],
    },
  };
}

export function buildHealthMetrics(
  outcomes: readonly ScrapeHealthOutcome[],
  nowUnixNano: string,
): Record<string, unknown>[] {
  const metrics: Record<string, unknown>[] = [];

  for (const outcome of outcomes) {
    metrics.push(
      gaugeMetric(
        "provider_metrics_scrape_success",
        outcome.provider,
        outcome.status === "failed" ? 0 : 1,
        nowUnixNano,
      ),
      gaugeMetric(
        "provider_metrics_scrape_duration_seconds",
        outcome.provider,
        outcome.durationSeconds,
        nowUnixNano,
      ),
    );

    if (outcome.status !== "failed" && outcome.timestampSeconds !== undefined) {
      metrics.push(
        gaugeMetric(
          "provider_metrics_scrape_timestamp_seconds",
          outcome.provider,
          outcome.timestampSeconds,
          nowUnixNano,
        ),
      );
    }
  }

  return metrics;
}
