import type { LokiPushPayload, TailEnv } from "./types";

type LokiEnv = Pick<
  TailEnv,
  "GRAFANA_CLOUD_LOKI_URL" | "GRAFANA_CLOUD_LOKI_USERNAME" | "GRAFANA_CLOUD_ACCESS_POLICY_TOKEN"
>;

const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 500;
const PER_ATTEMPT_TIMEOUT_MS = 15000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

      if (response.status !== 429) {
        // Non-429 errors: do not retry, let caller decide
        return { ok: false, status: response.status };
      }
      // 429: retry with backoff
    } catch (err) {
      // Network failures and timeouts are retryable.
      lastStatus = 0;
      console.error(
        `Loki push attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { ok: false, status: lastStatus };
}
