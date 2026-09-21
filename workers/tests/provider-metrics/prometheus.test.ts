import { describe, expect, it, vi } from "vitest";
import {
  buildProviderMetrics,
  pushProviderMetrics,
  type ProviderMetricsPushInput,
} from "../../src/provider-metrics/prometheus";
import type { ProviderResult } from "../../src/provider-metrics/types";

const env = {
  GRAFANA_CLOUD_PROMETHEUS_URL: "https://otlp-gateway-prod-us-central1.grafana.net/otlp",
  GRAFANA_CLOUD_PROMETHEUS_USERNAME: "123456",
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: "test-token",
};

const nowUnixNano = "1000000000000";
const nowSeconds = 1_000;

const sampleResults: ProviderResult[] = [
  {
    provider: "openai_api",
    sources: [],
    windows: [],
    costs: [{ lineItem: "tokens", costUSD: 0.42 }],
    modelUsage: [
      { model: "gpt-5", inputTokens: 1_000, outputTokens: 500, cachedTokens: 100, requests: 10 },
    ],
  },
  {
    provider: "opencodego",
    sources: [],
    windows: [{ period: "weekly", usageRatio: 0.2, resetTimestampSeconds: 1_250 }],
    zenBalanceUSD: 23.45,
  },
  {
    provider: "ollama_cloud",
    sources: [],
    windows: [],
    modelRequests: [{ period: "session", model: "glm-5.3-flash", requestCount: 54 }],
    activityCostUSD: 12.34,
  },
];

type Metric = {
  readonly name: string;
  readonly gauge: {
    readonly dataPoints: readonly {
      readonly attributes?: readonly {
        readonly key: string;
        readonly value: { readonly stringValue: string };
      }[];
      readonly asDouble: number;
      readonly timeUnixNano?: string;
    }[];
  };
};

function metricObjects(metrics: readonly Record<string, unknown>[], name: string): Metric[] {
  return metrics.filter((metric) => metric.name === name) as Metric[];
}

function metricValues(metrics: readonly Record<string, unknown>[], name: string): number[] {
  return metricObjects(metrics, name).flatMap((metric) =>
    metric.gauge.dataPoints.map((dataPoint) => dataPoint.asDouble),
  );
}

function attributeValue(metric: Metric | undefined, key: string): string | undefined {
  return metric?.gauge.dataPoints[0]?.attributes?.find((attribute) => attribute.key === key)?.value
    .stringValue;
}

function payloadMetrics(fetchFn: ReturnType<typeof vi.fn>): Metric[] {
  const call = fetchFn.mock.calls[0];
  if (call === undefined) {
    throw new Error("Expected one metrics request");
  }
  const init = call[1] as RequestInit;
  const body = JSON.parse(init.body as string) as {
    resourceMetrics: { scopeMetrics: { metrics: Metric[] }[] }[];
  };
  const resourceMetric = body.resourceMetrics[0];
  const scopeMetric = resourceMetric?.scopeMetrics[0];
  if (scopeMetric === undefined) {
    throw new Error("Expected OTLP scope metrics");
  }
  return scopeMetric.metrics;
}

function pushInput(
  results: ProviderResult[],
  healthMetrics: Record<string, unknown>[],
): ProviderMetricsPushInput {
  return { results, healthMetrics, nowUnixNano, nowSeconds };
}

describe("buildProviderMetrics", () => {
  it("emits exact provider metric names, labels, and values", () => {
    const metrics = buildProviderMetrics(sampleResults, nowUnixNano, nowSeconds);

    const cost = metricObjects(metrics, "openai_api_cost_usd")[0];
    expect(cost).toBeDefined();
    expect(attributeValue(cost, "line_item")).toBe("tokens");
    expect(metricValues(metrics, "openai_api_cost_usd")).toEqual([0.42]);
    expect(cost?.gauge.dataPoints[0]?.timeUnixNano).toBe(nowUnixNano);

    const inputTokens = metricObjects(metrics, "openai_api_input_tokens")[0];
    expect(attributeValue(inputTokens, "model")).toBe("gpt-5");
    expect(metricValues(metrics, "openai_api_input_tokens")).toEqual([1_000]);
    expect(metricValues(metrics, "openai_api_output_tokens")).toEqual([500]);
    expect(metricValues(metrics, "openai_api_cached_tokens")).toEqual([100]);
    expect(metricValues(metrics, "openai_api_requests")).toEqual([10]);

    expect(metricValues(metrics, "opencodego_zen_balance_usd")).toEqual([23.45]);
    const remainingMetrics = metricObjects(metrics, "opencodego_reset_seconds_remaining");
    expect(remainingMetrics).toHaveLength(1);
    expect(attributeValue(remainingMetrics[0], "period")).toBe("weekly");
    expect(metricValues(metrics, "opencodego_reset_seconds_remaining")).toEqual([250]);

    const modelRequests = metricObjects(metrics, "ollama_cloud_model_requests");
    expect(modelRequests).toHaveLength(1);
    expect(attributeValue(modelRequests[0], "period")).toBe("session");
    expect(attributeValue(modelRequests[0], "model")).toBe("glm-5.3-flash");
    expect(metricValues(metrics, "ollama_cloud_model_requests")).toEqual([54]);
    expect(metricValues(metrics, "ollama_cloud_activity_cost_usd")).toEqual([12.34]);
  });
});

describe("pushProviderMetrics", () => {
  it("posts data and health metrics in one OTLP payload", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    const healthMetric = {
      name: "provider_metrics_scrape_success",
      gauge: { dataPoints: [{ asDouble: 1 }] },
    };

    await pushProviderMetrics(
      env,
      pushInput([sampleResults[0] as ProviderResult], [healthMetric]),
      mockFetch,
    );

    const metrics = payloadMetrics(mockFetch);
    expect(metrics.map((metric) => metric.name)).toEqual(
      expect.arrayContaining(["openai_api_cost_usd", "provider_metrics_scrape_success"]),
    );
  });

  it("keeps health metrics when there are no data results", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    const healthMetric = {
      name: "provider_metrics_scrape_duration_seconds",
      gauge: { dataPoints: [{ asDouble: 1.25 }] },
    };

    await pushProviderMetrics(env, pushInput([], [healthMetric]), mockFetch);

    expect(payloadMetrics(mockFetch).map((metric) => metric.name)).toContain(
      "provider_metrics_scrape_duration_seconds",
    );
  });

  it("rejects invalid Prometheus configuration before fetching", async () => {
    const mockFetch = vi.fn();

    await expect(
      pushProviderMetrics(
        { ...env, GRAFANA_CLOUD_PROMETHEUS_URL: "" },
        pushInput([], []),
        mockFetch,
      ),
    ).rejects.toThrow(/Prometheus configuration/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uses the configured endpoint and Basic Auth", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));

    await pushProviderMetrics(env, pushInput([], []), mockFetch);

    const call = mockFetch.mock.calls[0];
    if (call === undefined) {
      throw new Error("Expected one metrics request");
    }
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(call[0]).toBe("https://otlp-gateway-prod-us-central1.grafana.net/otlp/v1/metrics");
    expect(headers.Authorization).toBe(`Basic ${btoa("123456:test-token")}`);
  });
});
