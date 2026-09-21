const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_INITIAL_BACKOFF_MS = 500;
const DEFAULT_PER_ATTEMPT_TIMEOUT_MS = 15000;

export type HttpTransportErrorKind = "network" | "timeout";

export class HttpTransportError extends Error {
  readonly kind: HttpTransportErrorKind;

  constructor(kind: HttpTransportErrorKind) {
    super(`HTTP transport failed (${kind})`);
    this.name = "HttpTransportError";
    this.kind = kind;
  }
}

export function validatePrometheusConfig(
  endpoint: string,
  username: string,
  accessPolicyToken: string,
): string {
  const normalizedEndpoint = endpoint.trim();
  if (normalizedEndpoint === "" || username.trim() === "" || accessPolicyToken.trim() === "") {
    throw new Error("Prometheus configuration is incomplete");
  }

  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(normalizedEndpoint);
  } catch {
    throw new Error("Prometheus configuration has an invalid URL");
  }
  if (parsedEndpoint.protocol !== "https:") {
    throw new Error("Prometheus configuration requires an HTTPS URL");
  }

  parsedEndpoint.pathname = `${parsedEndpoint.pathname.replace(/\/+$/, "")}/v1/metrics`;
  return parsedEndpoint.toString();
}

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

export interface GetWithRetryOptions {
  url: string;
  headers: Record<string, string>;
  fetchFn?: typeof fetch;
  logLabel: string;
  isRetryableStatus: (status: number) => boolean;
  maxRetries?: number;
  initialBackoffMs?: number;
  perAttemptTimeoutMs?: number;
  redirect?: "error" | "follow" | "manual";
}

export async function getWithRetry({
  url,
  headers,
  fetchFn = fetch,
  logLabel,
  isRetryableStatus,
  maxRetries = DEFAULT_MAX_RETRIES,
  initialBackoffMs = DEFAULT_INITIAL_BACKOFF_MS,
  perAttemptTimeoutMs = DEFAULT_PER_ATTEMPT_TIMEOUT_MS,
  redirect,
}: GetWithRetryOptions): Promise<Response> {
  let lastResponse: Response | undefined;
  let lastErrorKind: HttpTransportErrorKind | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(initialBackoffMs * Math.pow(2, attempt - 1));
    }

    lastErrorKind = undefined;

    try {
      const response = await fetchFn(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(perAttemptTimeoutMs),
        ...(redirect === undefined ? {} : { redirect }),
      });

      const retryable = !response.ok && isRetryableStatus(response.status);
      if (!retryable) {
        lastResponse = response;
        return response;
      }
      if (attempt < maxRetries) {
        await response.body?.cancel().catch(() => undefined);
      } else {
        lastResponse = response;
      }
    } catch (err) {
      lastErrorKind =
        err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")
          ? "timeout"
          : "network";
      console.error(`${logLabel} attempt ${attempt + 1} failed (${lastErrorKind})`);
    }
  }

  if (lastErrorKind !== undefined) throw new HttpTransportError(lastErrorKind);
  if (lastResponse !== undefined) return lastResponse;
  throw new HttpTransportError("network");
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
      // Release the response body stream before returning or retrying so it
      // does not leak on the Workers runtime.
      await response.body?.cancel().catch(() => undefined);

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
