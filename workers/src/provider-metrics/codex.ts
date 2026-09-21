import { getWithRetry, HttpTransportError } from "../http-retry";
import type {
  AdapterOutcome,
  ProviderAdapter,
  ProviderContext,
  ProviderErrorKind,
  ProviderResult,
  ProviderSource,
  QuotaWindow,
} from "./types";

const DEFAULT_BASE_URL = "https://chatgpt.com";
const TIMEOUT_MS = 30000;
const PRIMARY_SOURCE_ID = "codex-wham-usage";
const BROWSER_SOURCE_ID = "codex-browser-rendering";

const PRIMARY_SOURCE = {
  id: PRIMARY_SOURCE_ID,
  supportLevel: "official-internal",
  role: "primary",
} as const satisfies ProviderSource;

const BROWSER_SOURCE = {
  id: BROWSER_SOURCE_ID,
  supportLevel: "web-internal",
  role: "fallback",
} as const satisfies ProviderSource;

type WindowSnapshot = {
  readonly usedPercent: number;
  readonly resetAt: number;
  readonly limitWindowSeconds?: number;
};

type CodexUsageResponse = {
  readonly primaryWindow: WindowSnapshot | null;
  readonly secondaryWindow: WindowSnapshot | null;
  readonly creditsRemaining: number | null;
  readonly plan: string;
};

type ResetCredits = {
  readonly credits: number;
  readonly availableCount: number;
};

type CodexResult = Extract<ProviderResult, { provider: "codex" }>;
type CodexResponseFailureKind = Extract<ProviderErrorKind, "schema" | "parse">;

type CodexRequestOptions = {
  readonly accountId?: string;
  readonly baseUrl?: string;
  readonly proxySecret?: string;
};

class CodexResponseError extends Error {
  readonly name = "CodexResponseError";

  constructor(
    readonly kind: CodexResponseFailureKind,
    detail: string,
  ) {
    super(`Invalid Codex API response: ${detail}`);
  }
}

function invalidResponse(detail: string): never {
  throw new CodexResponseError("schema", detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidResponse(`${path} must be a finite number`);
  }
  return value;
}

function parseWindow(value: unknown, path: string): WindowSnapshot | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) invalidResponse(`${path} must be an object`);

  const usedPercent = parseFiniteNumber(value["used_percent"], `${path}.used_percent`);
  if (usedPercent < 0 || usedPercent > 100) {
    invalidResponse(`${path}.used_percent must be between 0 and 100`);
  }

  const resetAt = parseFiniteNumber(value["reset_at"], `${path}.reset_at`);
  if (!Number.isSafeInteger(resetAt) || resetAt < 0) {
    invalidResponse(`${path}.reset_at must be a non-negative integer`);
  }

  let limitWindowSeconds: number | undefined;
  if (value["limit_window_seconds"] !== undefined && value["limit_window_seconds"] !== null) {
    limitWindowSeconds = parseFiniteNumber(
      value["limit_window_seconds"],
      `${path}.limit_window_seconds`,
    );
  } else if (value["reset_after_seconds"] !== undefined && value["reset_after_seconds"] !== null) {
    limitWindowSeconds = parseFiniteNumber(
      value["reset_after_seconds"],
      `${path}.reset_after_seconds`,
    );
  }

  return { usedPercent, resetAt, limitWindowSeconds };
}

function parseCreditsRemaining(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) invalidResponse("credits must be an object or null");

  const balance = value["balance"];
  if (balance === undefined || balance === null) return null;
  if (typeof balance === "number") return parseFiniteNumber(balance, "credits.balance");
  if (typeof balance !== "string" || balance.trim().length === 0) {
    invalidResponse("credits.balance must be a number, numeric string, or null");
  }

  const parsedBalance = Number(balance);
  if (!Number.isFinite(parsedBalance)) {
    invalidResponse("credits.balance must be a finite numeric string");
  }
  return parsedBalance;
}

function parseUsageResponse(value: unknown): CodexUsageResponse {
  if (!isRecord(value)) invalidResponse("body must be an object");

  const rateLimit = value["rate_limit"];
  if (!isRecord(rateLimit)) invalidResponse("rate_limit must be an object");

  const planType = value["plan_type"];
  if (planType !== undefined && typeof planType !== "string") {
    invalidResponse("plan_type must be a string");
  }

  const primaryWindow = parseWindow(rateLimit["primary_window"], "rate_limit.primary_window");
  const secondaryWindow = parseWindow(rateLimit["secondary_window"], "rate_limit.secondary_window");
  if (primaryWindow === null && secondaryWindow === null) {
    invalidResponse("rate_limit must contain at least one valid window");
  }

  return {
    primaryWindow,
    secondaryWindow,
    creditsRemaining: parseCreditsRemaining(value["credits"]),
    plan: planType ?? "unknown",
  };
}

function parseResetCreditsResponse(value: unknown): ResetCredits {
  if (!isRecord(value)) invalidResponse("reset credits body must be an object");
  return {
    credits: parseFiniteNumber(value["credits"], "reset_credits.credits"),
    availableCount: parseFiniteNumber(value["available_count"], "reset_credits.available_count"),
  };
}

async function fetchResetCredits(
  baseUrl: string,
  headers: Readonly<Record<string, string>>,
  fetchFn: typeof fetch,
): Promise<ResetCredits | undefined> {
  try {
    const response = await getWithRetry({
      url: `${baseUrl}/backend-api/wham/rate-limit-reset-credits`,
      headers: { ...headers, "OpenAI-Beta": "codex-1", originator: "Codex Desktop" },
      fetchFn,
      logLabel: "Codex reset credits fetch",
      isRetryableStatus: (status) => status === 429 || status >= 500,
      perAttemptTimeoutMs: TIMEOUT_MS,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }

    const body: unknown = await response.json();
    return parseResetCreditsResponse(body);
  } catch {
    return undefined;
  }
}

async function fetchViaBrowserRendering(
  browserBinding: Fetcher,
  baseUrl: string,
  accessToken: string,
  accountId?: string,
  proxySecret?: string,
): Promise<CodexUsageResponse> {
  const puppeteerModule = await import("@cloudflare/puppeteer");
  const launcher =
    "launch" in puppeteerModule && typeof puppeteerModule.launch === "function"
      ? puppeteerModule
      : (puppeteerModule.default ?? puppeteerModule);
  const browser = await launcher.launch(browserBinding);
  try {
    const page = await browser.newPage();
    const targetUrl = `${baseUrl}/backend-api/wham/usage`;

    await page.setRequestInterception(true);
    page.on("request", (interceptedRequest) => {
      if (interceptedRequest.url() === targetUrl) {
        const headers = {
          ...interceptedRequest.headers(),
          Authorization: `Bearer ${accessToken}`,
          ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
          ...(proxySecret ? { "X-Proxy-Secret": proxySecret } : {}),
          "OpenAI-Beta": "codex-1",
          originator: "Codex Desktop",
          Accept: "application/json",
        };
        interceptedRequest.continue({ headers });
      } else {
        interceptedRequest.continue();
      }
    });

    const response = await page.goto(targetUrl, {
      waitUntil: "networkidle0",
      timeout: TIMEOUT_MS,
    });

    let rawText = response === null ? "" : await response.text();
    if (rawText.length === 0) {
      const evalResult = await page.evaluate("document.body.innerText");
      rawText = typeof evalResult === "string" ? evalResult : "";
    }

    let body: unknown;
    try {
      body = JSON.parse(rawText);
    } catch {
      throw new CodexResponseError("parse", "browser response was not valid JSON");
    }
    return parseUsageResponse(body);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" || error.name === "TimeoutError" || /timeout/i.test(error.message)
  );
}

function browserFailureKind(error: unknown): ProviderErrorKind {
  if (error instanceof HttpTransportError) return error.kind;
  if (error instanceof CodexResponseError) return error.kind;
  if (error instanceof SyntaxError) return "parse";
  return isTimeoutError(error) ? "timeout" : "network";
}

function primaryResponseFailureKind(error: unknown): CodexResponseFailureKind {
  return error instanceof CodexResponseError ? error.kind : "parse";
}

function failed(kind: ProviderErrorKind, sourceId: string, statusCode?: number): AdapterOutcome {
  return {
    status: "failed",
    error: {
      kind,
      provider: "codex",
      sourceId,
      ...(statusCode === undefined ? {} : { statusCode }),
    },
  };
}

function httpFailureKind(status: number): ProviderErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "upstream_5xx";
  return "upstream_4xx";
}

function classifyCodexWindow(window: WindowSnapshot | null): "weekly" | "session" | null {
  if (!window || window.limitWindowSeconds === undefined) return null;
  return window.limitWindowSeconds >= 86400 * 3 ? "weekly" : "session";
}

function normalizeCodexWindows(
  primary: WindowSnapshot | null,
  secondary: WindowSnapshot | null,
): { readonly sessionWindow: WindowSnapshot | null; readonly weeklyWindow: WindowSnapshot | null } {
  let sessionWindow: WindowSnapshot | null = null;
  let weeklyWindow: WindowSnapshot | null = null;

  const primaryType = classifyCodexWindow(primary);
  const secondaryType = classifyCodexWindow(secondary);
  if (primaryType === "weekly") weeklyWindow = primary;
  if (primaryType === "session") sessionWindow = primary;
  if (secondaryType === "weekly" && weeklyWindow === null) weeklyWindow = secondary;
  if (secondaryType === "session" && sessionWindow === null) sessionWindow = secondary;

  return { sessionWindow, weeklyWindow };
}

function buildResult(
  data: CodexUsageResponse,
  resetCredits: ResetCredits | undefined,
  source: ProviderSource,
): CodexResult {
  const { sessionWindow, weeklyWindow } = normalizeCodexWindows(
    data.primaryWindow,
    data.secondaryWindow,
  );
  const windows: QuotaWindow[] = [
    ...(sessionWindow === null
      ? []
      : [
          {
            period: "session" as const,
            usageRatio: sessionWindow.usedPercent / 100,
            resetTimestampSeconds: sessionWindow.resetAt,
          },
        ]),
    ...(weeklyWindow === null
      ? []
      : [
          {
            period: "weekly" as const,
            usageRatio: weeklyWindow.usedPercent / 100,
            resetTimestampSeconds: weeklyWindow.resetAt,
          },
        ]),
  ];
  const hasCredits = data.creditsRemaining !== null || resetCredits !== undefined;

  return {
    provider: "codex",
    sources: [source],
    windows,
    plan: data.plan,
    ...(hasCredits
      ? {
          credits: {
            ...(data.creditsRemaining === null ? {} : { remaining: data.creditsRemaining }),
            ...(resetCredits === undefined
              ? {}
              : {
                  resetCredits: resetCredits.credits,
                  resetCreditsAvailableCount: resetCredits.availableCount,
                }),
          },
        }
      : {}),
  };
}

function requestOptions(env: Parameters<ProviderAdapter>[0]): CodexRequestOptions {
  const baseUrl = env.CODEX_PROXY_URL || env.CODEX_API_BASE_URL;
  return {
    ...(env.CODEX_ACCOUNT_ID === undefined ? {} : { accountId: env.CODEX_ACCOUNT_ID }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(env.CODEX_PROXY_SECRET === undefined ? {} : { proxySecret: env.CODEX_PROXY_SECRET }),
  };
}

export async function fetchCodexMetrics(
  accessToken: string,
  context: ProviderContext,
  options: CodexRequestOptions = {},
): Promise<AdapterOutcome> {
  const baseUrl = (options.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
    "OpenAI-Beta": "codex-1",
    originator: "Codex Desktop",
  };
  if (options.accountId) headers["ChatGPT-Account-Id"] = options.accountId;
  if (options.proxySecret) headers["X-Proxy-Secret"] = options.proxySecret;

  try {
    const response = await getWithRetry({
      url: `${baseUrl}/backend-api/wham/usage`,
      headers,
      fetchFn: context.fetchFn,
      logLabel: "Codex usage fetch",
      isRetryableStatus: (status) => status === 429 || status >= 500,
      perAttemptTimeoutMs: TIMEOUT_MS,
    });

    let data: CodexUsageResponse;
    let source: ProviderSource = PRIMARY_SOURCE;
    if (!response.ok) {
      const statusCode = response.status;
      await response.body?.cancel().catch(() => undefined);
      if (statusCode !== 403 || context.browserBinding === undefined) {
        return failed(httpFailureKind(statusCode), PRIMARY_SOURCE_ID, statusCode);
      }

      try {
        data = await fetchViaBrowserRendering(
          context.browserBinding,
          baseUrl,
          accessToken,
          options.accountId,
          options.proxySecret,
        );
        source = BROWSER_SOURCE;
      } catch (error) {
        return failed(browserFailureKind(error), BROWSER_SOURCE_ID);
      }
    } else {
      try {
        const body: unknown = await response.json();
        data = parseUsageResponse(body);
      } catch (error) {
        return failed(primaryResponseFailureKind(error), PRIMARY_SOURCE_ID);
      }
    }

    const resetCredits = await fetchResetCredits(baseUrl, headers, context.fetchFn);
    return { status: "success", result: buildResult(data, resetCredits, source) };
  } catch (error) {
    if (error instanceof HttpTransportError) return failed(error.kind, PRIMARY_SOURCE_ID);
    return failed("internal", PRIMARY_SOURCE_ID);
  }
}

export const codexAdapter: ProviderAdapter = async (env, context) =>
  fetchCodexMetrics(env.CODEX_ACCESS_TOKEN ?? "", context, requestOptions(env));
