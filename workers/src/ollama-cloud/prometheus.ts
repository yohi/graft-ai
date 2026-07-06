import type { OllamaCloudEnv } from "../types";
import type { ResetCalculation } from "./calc";
import { postWithRetry } from "../http-retry";

type PrometheusEnv = Pick<
  OllamaCloudEnv,
  | "GRAFANA_CLOUD_PROMETHEUS_URL"
  | "GRAFANA_CLOUD_PROMETHEUS_USERNAME"
  | "GRAFANA_CLOUD_ACCESS_POLICY_TOKEN"
>;

function intervalAttribute(
  calculations: ResetCalculation[],
  period: "session" | "weekly",
  key: string,
  defaultValue: number,
): Record<string, unknown> {
  return {
    key,
    value: {
      stringValue: String(
        calculations.find((c) => c.period === period)?.intervalSeconds ?? defaultValue,
      ),
    },
  };
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
      dataPoints: [
        {
          attributes,
          asDouble: value,
          timeUnixNano: nowUnixNano,
        },
      ],
    },
  };
}

function buildOtlpPayload(
  calculations: ResetCalculation[],
  plan: string,
  nowUnixNano: string,
): Record<string, unknown> {
  const metrics = calculations.flatMap((calc) => {
    const baseAttrs: Record<string, unknown>[] = [
      { key: "period", value: { stringValue: calc.period } },
    ];
    return [
      gaugeMetric(
        "ollama_cloud_reset_seconds_remaining",
        baseAttrs,
        calc.remainingSeconds,
        nowUnixNano,
      ),
      gaugeMetric(
        "ollama_cloud_reset_timestamp_seconds",
        baseAttrs,
        calc.nextResetTimestampSeconds,
        nowUnixNano,
      ),
      gaugeMetric("ollama_cloud_reset_progress_ratio", baseAttrs, calc.progressRatio, nowUnixNano),
    ];
  });

  metrics.push({
    name: "ollama_cloud_plan_info",
    gauge: {
      dataPoints: [
        {
          attributes: [
            { key: "plan", value: { stringValue: plan } },
            intervalAttribute(calculations, "session", "session_interval", 18000),
            intervalAttribute(calculations, "weekly", "weekly_interval", 604800),
          ],
          asDouble: 1,
          timeUnixNano: nowUnixNano,
        },
      ],
    },
  });

  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: "graft-ai-ollama-cloud" },
            },
          ],
        },
        scopeMetrics: [
          {
            scope: { name: "graft-ai-ollama-cloud" },
            metrics,
          },
        ],
      },
    ],
  };
}

export async function pushMetrics(
  env: PrometheusEnv,
  calculations: ResetCalculation[],
  plan: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  const url = `${env.GRAFANA_CLOUD_PROMETHEUS_URL}/v1/metrics`;
  const basicAuth = btoa(
    `${env.GRAFANA_CLOUD_PROMETHEUS_USERNAME}:${env.GRAFANA_CLOUD_ACCESS_POLICY_TOKEN}`,
  );
  const nowUnixNano = `${Date.now()}000000`;
  const body = JSON.stringify(buildOtlpPayload(calculations, plan, nowUnixNano));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Basic ${basicAuth}`,
  };

  return postWithRetry({
    url,
    headers,
    body,
    fetchFn,
    logLabel: "Ollama Cloud metrics push",
    // 4xx (except 429) fail immediately; 429 and 5xx are retried.
    isRetryableStatus: (status) => !(status >= 400 && status < 500 && status !== 429),
  });
}
