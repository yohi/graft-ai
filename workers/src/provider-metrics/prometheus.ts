import type { ProviderId, ProviderMetricsEnv, ProviderResult, QuotaWindow } from "./types";
import { postWithRetry, validatePrometheusConfig } from "../http-retry";

interface PrometheusEnv {
  GRAFANA_CLOUD_PROMETHEUS_URL: ProviderMetricsEnv["GRAFANA_CLOUD_PROMETHEUS_URL"];
  GRAFANA_CLOUD_PROMETHEUS_USERNAME: ProviderMetricsEnv["GRAFANA_CLOUD_PROMETHEUS_USERNAME"];
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: ProviderMetricsEnv["GRAFANA_CLOUD_ACCESS_POLICY_TOKEN"];
}

export interface ProviderMetricsPushInput {
  results: ProviderResult[];
  healthMetrics: Record<string, unknown>[];
  nowUnixNano: string;
  nowSeconds: number;
}

type Metric = Record<string, unknown>;
type MetricSpec = readonly [string, number | undefined, Record<string, unknown>[]?];
type MetricBuildContext = { readonly metrics: Metric[]; readonly nowUnixNano: string };

function attr(key: string, value: string): Record<string, unknown> {
  return { key, value: { stringValue: value } };
}

function gaugeMetric(
  name: string,
  attributes: Record<string, unknown>[],
  value: number,
  nowUnixNano: string,
): Metric {
  return {
    name,
    gauge: {
      dataPoints: [{ attributes, asDouble: value, timeUnixNano: nowUnixNano }],
    },
  };
}

function appendQuotaMetrics(
  provider: ProviderId,
  windows: readonly QuotaWindow[],
  context: MetricBuildContext,
): void {
  for (const window of windows) {
    const periodAttr = [attr("period", window.period)];
    appendOptionalMetrics(
      context.metrics,
      [
        [`${provider}_usage_ratio`, window.usageRatio, periodAttr],
        [`${provider}_reset_timestamp_seconds`, window.resetTimestampSeconds, periodAttr],
      ],
      context.nowUnixNano,
    );
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported provider: ${String(value)}`);
}

function appendOptionalMetrics(
  metrics: Metric[],
  specs: readonly MetricSpec[],
  nowUnixNano: string,
): void {
  for (const [name, value, attributes = []] of specs) {
    if (value !== undefined) metrics.push(gaugeMetric(name, attributes, value, nowUnixNano));
  }
}

export function buildProviderMetrics(
  results: ProviderResult[],
  nowUnixNano: string,
  nowSeconds: number,
): Metric[] {
  const metrics: Metric[] = [];
  const context = { metrics, nowUnixNano };

  for (const result of results) {
    appendQuotaMetrics(result.provider, result.windows, context);

    switch (result.provider) {
      case "openai_api":
        for (const cost of result.costs) {
          metrics.push(
            gaugeMetric(
              "openai_api_cost_usd",
              [attr("line_item", cost.lineItem)],
              cost.costUSD,
              nowUnixNano,
            ),
          );
        }
        for (const usage of result.modelUsage) {
          const modelAttr = [attr("model", usage.model)];
          metrics.push(
            gaugeMetric("openai_api_input_tokens", modelAttr, usage.inputTokens, nowUnixNano),
            gaugeMetric("openai_api_output_tokens", modelAttr, usage.outputTokens, nowUnixNano),
            gaugeMetric("openai_api_cached_tokens", modelAttr, usage.cachedTokens, nowUnixNano),
            gaugeMetric("openai_api_requests", modelAttr, usage.requests, nowUnixNano),
          );
        }
        break;
      case "codex":
        appendOptionalMetrics(
          metrics,
          [
            ["codex_credits_remaining", result.credits?.remaining],
            ["codex_reset_credits", result.credits?.resetCredits],
            ["codex_reset_credits_available_count", result.credits?.resetCreditsAvailableCount],
          ],
          nowUnixNano,
        );
        if (result.plan !== undefined) {
          metrics.push(gaugeMetric("codex_plan_info", [attr("plan", result.plan)], 1, nowUnixNano));
        }
        break;
      case "opencodego":
        for (const window of result.windows) {
          if (window.resetTimestampSeconds === undefined) continue;
          metrics.push(
            gaugeMetric(
              "opencodego_reset_seconds_remaining",
              [attr("period", window.period)],
              Math.max(window.resetTimestampSeconds - nowSeconds, 0),
              nowUnixNano,
            ),
          );
        }
        if (result.zenBalanceUSD !== undefined) {
          metrics.push(
            gaugeMetric("opencodego_zen_balance_usd", [], result.zenBalanceUSD, nowUnixNano),
          );
        }
        break;
      case "ollama_cloud":
        if (result.plan !== undefined) {
          metrics.push(
            gaugeMetric("ollama_cloud_plan_info", [attr("plan", result.plan)], 1, nowUnixNano),
          );
        }
        for (const request of result.modelRequests) {
          metrics.push(
            gaugeMetric(
              "ollama_cloud_model_requests",
              [attr("period", request.period), attr("model", request.model)],
              request.requestCount,
              nowUnixNano,
            ),
          );
        }
        if (result.activityCostUSD !== undefined) {
          metrics.push(
            gaugeMetric("ollama_cloud_activity_cost_usd", [], result.activityCostUSD, nowUnixNano),
          );
        }
        break;
      case "commandcode":
        appendOptionalMetrics(
          metrics,
          [
            ["commandcode_credits_remaining", result.credits?.remaining],
            ["commandcode_credits_monthly", result.credits?.monthly],
            ["commandcode_credits_purchased", result.credits?.purchased],
            ["commandcode_credits_free", result.credits?.free],
          ],
          nowUnixNano,
        );
        if (result.plan !== undefined) {
          metrics.push(
            gaugeMetric("commandcode_plan_info", [attr("plan", result.plan)], 1, nowUnixNano),
          );
        }
        if (result.subscription?.status !== undefined && result.plan !== undefined) {
          metrics.push(
            gaugeMetric(
              "commandcode_subscription_info",
              [attr("plan", result.plan), attr("status", result.subscription.status)],
              1,
              nowUnixNano,
            ),
          );
        }
        if (result.subscription?.billingPeriodEndSeconds !== undefined) {
          metrics.push(
            gaugeMetric(
              "commandcode_billing_period_end_seconds",
              [],
              result.subscription.billingPeriodEndSeconds,
              nowUnixNano,
            ),
          );
        }
        appendOptionalMetrics(
          metrics,
          [
            ["commandcode_usage_cost_usd", result.usage?.costUSD],
            ["commandcode_usage_requests", result.usage?.requests],
            ["commandcode_usage_tokens", result.usage?.tokens],
          ],
          nowUnixNano,
        );
        break;
      default:
        return assertNever(result);
    }
  }

  return metrics;
}

function buildOtlpPayload(input: ProviderMetricsPushInput): Record<string, unknown> {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "graft-ai-provider-metrics" } },
          ],
        },
        scopeMetrics: [
          {
            scope: { name: "graft-ai-provider-metrics" },
            metrics: [
              ...buildProviderMetrics(input.results, input.nowUnixNano, input.nowSeconds),
              ...input.healthMetrics,
            ],
          },
        ],
      },
    ],
  };
}

export async function pushProviderMetrics(
  env: PrometheusEnv,
  input: ProviderMetricsPushInput,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  const url = validatePrometheusConfig(
    env.GRAFANA_CLOUD_PROMETHEUS_URL,
    env.GRAFANA_CLOUD_PROMETHEUS_USERNAME,
    env.GRAFANA_CLOUD_ACCESS_POLICY_TOKEN,
  );
  const basicAuth = btoa(
    `${env.GRAFANA_CLOUD_PROMETHEUS_USERNAME}:${env.GRAFANA_CLOUD_ACCESS_POLICY_TOKEN}`,
  );
  const body = JSON.stringify(buildOtlpPayload(input));

  return postWithRetry({
    url,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${basicAuth}`,
    },
    body,
    fetchFn,
    logLabel: "Provider metrics push",
    isRetryableStatus: (status) => !(status >= 400 && status < 500 && status !== 429),
  });
}
