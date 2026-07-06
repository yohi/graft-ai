const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_INITIAL_BACKOFF_MS = 500;
const DEFAULT_PER_ATTEMPT_TIMEOUT_MS = 15000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PostWithRetryOptions {
  url: string;
  headers: Record<string, string>;
  body: string;
  fetchFn?: typeof fetch;
  /** Label used in the console.error message on network/timeout failures. */
  logLabel: string;
  /** Return true when a non-2xx status should be retried instead of returned immediately. */
  isRetryableStatus: (status: number) => boolean;
  maxRetries?: number;
  initialBackoffMs?: number;
  perAttemptTimeoutMs?: number;
}

/**
 * POSTs a pre-serialized body with exponential backoff retry, shared by the
 * Loki and Prometheus (OTLP) push clients.
 */
export async function postWithRetry({
  url,
  headers,
  body,
  fetchFn = fetch,
  logLabel,
  isRetryableStatus,
  maxRetries = DEFAULT_MAX_RETRIES,
  initialBackoffMs = DEFAULT_INITIAL_BACKOFF_MS,
  perAttemptTimeoutMs = DEFAULT_PER_ATTEMPT_TIMEOUT_MS,
}: PostWithRetryOptions): Promise<{ ok: boolean; status: number }> {
  let lastStatus = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoffMs = initialBackoffMs * Math.pow(2, attempt - 1);
      await sleep(backoffMs);
    }

    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(perAttemptTimeoutMs),
      });
      lastStatus = response.status;

      if (response.status >= 200 && response.status < 300) {
        return { ok: true, status: response.status };
      }

      if (!isRetryableStatus(response.status)) {
        return { ok: false, status: response.status };
      }
    } catch (err) {
      lastStatus = 0;
      console.error(
        `${logLabel} attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { ok: false, status: lastStatus };
}
