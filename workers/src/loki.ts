import type { LokiPushPayload, TailEnv } from "./types";
import { postWithRetry } from "./http-retry";

type LokiEnv = Pick<
  TailEnv,
  "GRAFANA_CLOUD_LOKI_URL" | "GRAFANA_CLOUD_LOKI_USERNAME" | "GRAFANA_CLOUD_ACCESS_POLICY_TOKEN"
>;

export async function pushToLoki(
  env: LokiEnv,
  payload: LokiPushPayload,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  const url = `${env.GRAFANA_CLOUD_LOKI_URL}/loki/api/v1/push`;
  const basicAuth = btoa(
    `${env.GRAFANA_CLOUD_LOKI_USERNAME}:${env.GRAFANA_CLOUD_ACCESS_POLICY_TOKEN}`,
  );
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Basic ${basicAuth}`,
  };
  const body = JSON.stringify(payload);

  return postWithRetry({
    url,
    headers,
    body,
    fetchFn,
    logLabel: "Loki push",
    // Retry transient Loki failures here; Tail Workers cannot signal upstream retries.
    isRetryableStatus: (status) => status === 429 || status >= 500,
  });
}
