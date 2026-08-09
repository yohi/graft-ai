import type { ProviderMetricsEnv, OpenAIFetchResult, CodexFetchResult, OpenCodeGoFetchResult } from "./types";
import { postWithRetry } from "../http-retry";

type PrometheusEnv = Pick<
  ProviderMetricsEnv,
  | "GRAFANA_CLOUD_PROMETHEUS_URL"
  | "GRAFANA_CLOUD_PROMETHEUS_USERNAME"
  | "GRAFANA_CLOUD_ACCESS_POLICY_TOKEN"
>;

interface MetricResults {
  openai?: OpenAIFetchResult;
  codex?: CodexFetchResult;
  openCodeGo?: OpenCodeGoFetchResult;
}

function attr(key: string, value: string): Record<string, unknown> {
  return { key, value: { stringValue: value } };
}

function gaugeMetric(
  name: string,
  attributes: Record<string, unknown>[],
  value: number,
  nowUnixNano: string,
): Record<string, unknown> {
  return {
    name,
    gauge: {
      dataPoints: [{ attributes, asDouble: value, timeUnixNano: nowUnixNano }],
    },
  };
}

function buildMetrics(results: MetricResults, nowUnixNano: string): Record<string, unknown>[] {
  const metrics: Record<string, unknown>[] = [];

  if (results.openai) {
    for (const cost of results.openai.costs) {
      metrics.push(
        gaugeMetric(
          "openai_api_cost_usd",
          [attr("line_item", cost.lineItem)],
          cost.costUSD,
          nowUnixNano,
        ),
      );
    }
    for (const token of results.openai.tokens) {
      const modelAttr = [attr("model", token.model)];
      metrics.push(gaugeMetric("openai_api_input_tokens", modelAttr, token.inputTokens, nowUnixNano));
      metrics.push(gaugeMetric("openai_api_output_tokens", modelAttr, token.outputTokens, nowUnixNano));
      metrics.push(gaugeMetric("openai_api_cached_tokens", modelAttr, token.cachedTokens, nowUnixNano));
      metrics.push(gaugeMetric("openai_api_requests", modelAttr, token.requests, nowUnixNano));
    }
  }

  if (results.codex) {
    const c = results.codex;
    for (const [period, ratio, reset] of [
      ["session", c.sessionUsageRatio, c.sessionResetTimestampSeconds],
      ["weekly", c.weeklyUsageRatio, c.weeklyResetTimestampSeconds],
    ] as [string, number, number][]) {
      const periodAttr = [attr("period", period)];
      metrics.push(gaugeMetric("codex_usage_ratio", periodAttr, ratio, nowUnixNano));
      metrics.push(gaugeMetric("codex_reset_timestamp_seconds", periodAttr, reset, nowUnixNano));
    }
    if (c.creditsRemaining !== null) {
      metrics.push(gaugeMetric("codex_credits_remaining", [], c.creditsRemaining, nowUnixNano));
    }
    if (c.resetCredits) {
      metrics.push(gaugeMetric("codex_reset_credits", [], c.resetCredits.credits, nowUnixNano));
      metrics.push(
        gaugeMetric(
          "codex_reset_credits_available_count",
          [],
          c.resetCredits.availableCount,
          nowUnixNano,
        ),
      );
    }
    metrics.push(gaugeMetric("codex_plan_info", [attr("plan", c.plan)], 1, nowUnixNano));
  }

  if (results.openCodeGo) {
    const g = results.openCodeGo;
    for (const [period, ratio, remaining] of [
      ["rolling", g.rollingUsageRatio, g.rollingResetSeconds],
      ["weekly", g.weeklyUsageRatio, g.weeklyResetSeconds],
      ["monthly", g.monthlyUsageRatio, g.monthlyResetSeconds],
    ] as [string, number | undefined, number | undefined][]) {
      if (ratio === undefined || remaining === undefined) continue;
      const periodAttr = [attr("period", period)];
      metrics.push(gaugeMetric("opencodego_usage_ratio", periodAttr, ratio, nowUnixNano));
      metrics.push(
        gaugeMetric("opencodego_reset_seconds_remaining", periodAttr, remaining, nowUnixNano),
      );
    }
    if (g.zenBalanceUSD !== null) {
      metrics.push(gaugeMetric("opencodego_zen_balance_usd", [], g.zenBalanceUSD, nowUnixNano));
    }
  }

  return metrics;
}

function buildOtlpPayload(results: MetricResults, nowUnixNano: string): Record<string, unknown> {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "graft-ai-provider-metrics" } }],
        },
        scopeMetrics: [
          {
            scope: { name: "graft-ai-provider-metrics" },
            metrics: buildMetrics(results, nowUnixNano),
          },
        ],
      },
    ],
  };
}

export async function pushProviderMetrics(
  env: PrometheusEnv,
  results: MetricResults,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  const url = `${env.GRAFANA_CLOUD_PROMETHEUS_URL}/v1/metrics`;
  const basicAuth = btoa(
    `${env.GRAFANA_CLOUD_PROMETHEUS_USERNAME}:${env.GRAFANA_CLOUD_ACCESS_POLICY_TOKEN}`,
  );
  const nowUnixNano = `${Date.now()}000000`;
  const body = JSON.stringify(buildOtlpPayload(results, nowUnixNano));

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
