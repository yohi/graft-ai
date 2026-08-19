import type { CodexFetchResult } from "./types";
import { getWithRetry } from "../http-retry";

const DEFAULT_BASE_URL = "https://chatgpt.com";
const TIMEOUT_MS = 30000;

type WindowSnapshot = {
  readonly usedPercent: number;
  readonly resetAt: number;
};

type CodexUsageResponse = {
  readonly primaryWindow: WindowSnapshot | null;
  readonly secondaryWindow: WindowSnapshot | null;
  readonly creditsRemaining: number | null;
  readonly plan: string;
};

class CodexResponseError extends Error {
  readonly name = "CodexResponseError";

  constructor(readonly detail: string) {
    super(`Invalid Codex API response: ${detail}`);
  }
}

function invalidResponse(detail: string): never {
  throw new CodexResponseError(detail);
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
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    invalidResponse(`${path} must be an object`);
  }

  const usedPercent = parseFiniteNumber(value["used_percent"], `${path}.used_percent`);
  if (usedPercent < 0 || usedPercent > 100) {
    invalidResponse(`${path}.used_percent must be between 0 and 100`);
  }

  const resetAt = parseFiniteNumber(value["reset_at"], `${path}.reset_at`);
  if (!Number.isSafeInteger(resetAt) || resetAt < 0) {
    invalidResponse(`${path}.reset_at must be a non-negative integer`);
  }

  return { usedPercent, resetAt };
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

function parseResetCreditsResponse(value: unknown): CodexFetchResult["resetCredits"] {
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
): Promise<CodexFetchResult["resetCredits"]> {
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
    // reset-credits is supplementary; usage metrics remain usable when it fails
    return undefined;
  }
}

async function fetchViaBrowserRendering(
  browserBinding: Fetcher,
  baseUrl: string,
  accessToken: string,
  accountId?: string,
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
      timeout: 30000,
    });

    let rawText = "";
    if (response !== null) {
      try {
        rawText = await response.text();
      } catch {
        rawText = "";
      }
    }
    if (rawText.length === 0) {
      const evalResult = await page.evaluate("document.body.innerText");
      rawText = typeof evalResult === "string" ? evalResult : "";
    }

    let body: unknown;
    try {
      body = JSON.parse(rawText);
    } catch {
      const snippet = rawText.replace(/\s+/g, " ").trim().slice(0, 200);
      throw new CodexResponseError(
        `Browser rendering returned non-JSON response (snippet: ${snippet || "<empty>"})`,
      );
    }
    return parseUsageResponse(body);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export async function fetchCodexMetrics(
  accessToken: string,
  accountId?: string,
  fetchFn: typeof fetch = fetch,
  proxyUrlOrBaseUrl?: string,
  browserBinding?: Fetcher,
): Promise<CodexFetchResult> {
  const baseUrl = (proxyUrlOrBaseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
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
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }

  let data: CodexUsageResponse;

  const response = await getWithRetry({
    url: `${baseUrl}/backend-api/wham/usage`,
    headers,
    fetchFn,
    logLabel: "Codex usage fetch",
    isRetryableStatus: (status) => status === 429 || status >= 500,
    perAttemptTimeoutMs: TIMEOUT_MS,
  });

  if (!response.ok) {
    if (response.status === 403 && browserBinding !== undefined) {
      // Fallback to Cloudflare Browser Rendering to solve interactive JS challenge
      data = await fetchViaBrowserRendering(browserBinding, baseUrl, accessToken, accountId);
    } else {
      let bodySnippet = "";
      try {
        const text = await response.text();
        bodySnippet = ` — ${text.replace(/\s+/g, " ").trim().slice(0, 200)}`;
      } catch {
        await response.body?.cancel().catch(() => undefined);
      }
      throw new Error(`Codex API error: HTTP ${response.status}${bodySnippet}`);
    }
  } else {
    const body: unknown = await response.json();
    data = parseUsageResponse(body);
  }

  const resetCredits = await fetchResetCredits(baseUrl, headers, fetchFn);

  return {
    sessionUsageRatio: data.primaryWindow ? data.primaryWindow.usedPercent / 100 : undefined,
    weeklyUsageRatio: data.secondaryWindow ? data.secondaryWindow.usedPercent / 100 : undefined,
    sessionResetTimestampSeconds: data.primaryWindow ? data.primaryWindow.resetAt : undefined,
    weeklyResetTimestampSeconds: data.secondaryWindow ? data.secondaryWindow.resetAt : undefined,
    creditsRemaining: data.creditsRemaining,
    resetCredits,
    plan: data.plan,
  };
}
