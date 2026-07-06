import type { OllamaCloudEnv } from "../types";
import type { ResetCalculation } from "./calc";

type PrometheusEnv = Pick<
  OllamaCloudEnv,
  | "GRAFANA_CLOUD_PROMETHEUS_URL"
  | "GRAFANA_CLOUD_PROMETHEUS_USERNAME"
  | "GRAFANA_CLOUD_ACCESS_POLICY_TOKEN"
>;

const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 500;
const PER_ATTEMPT_TIMEOUT_MS = 15000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
      {
        name: "ollama_cloud_reset_seconds_remaining",
        gauge: {
          dataPoints: [
            {
              attributes: baseAttrs,
              asDouble: calc.remainingSeconds,
              timeUnixNano: nowUnixNano,
            },
          ],
        },
      },
      {
        name: "ollama_cloud_reset_timestamp_seconds",
        gauge: {
          dataPoints: [
            {
              attributes: baseAttrs,
              asDouble: calc.nextResetTimestampSeconds,
              timeUnixNano: nowUnixNano,
            },
          ],
        },
      },
      {
        name: "ollama_cloud_reset_progress_ratio",
        gauge: {
          dataPoints: [
            {
              attributes: baseAttrs,
              asDouble: calc.progressRatio,
              timeUnixNano: nowUnixNano,
            },
          ],
        },
      },
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

  let lastStatus = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
      await sleep(backoffMs);
    }

    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(PER_ATTEMPT_TIMEOUT_MS),
      });
      lastStatus = response.status;

      if (response.status >= 200 && response.status < 300) {
        return { ok: true, status: response.status };
      }

      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return { ok: false, status: response.status };
      }
    } catch (err) {
      lastStatus = 0;
      console.error(
        `Ollama Cloud metrics push attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { ok: false, status: lastStatus };
}
