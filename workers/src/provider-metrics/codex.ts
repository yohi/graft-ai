import type { CodexFetchResult } from "./types";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const TIMEOUT_MS = 30000;

interface WindowSnapshot {
  used_percent?: number;
  reset_at?: number;
  limit_window_seconds?: number;
}

interface RateLimitDetails {
  primary_window?: WindowSnapshot;
  secondary_window?: WindowSnapshot;
}

interface CreditDetails {
  has_credits?: boolean;
  unlimited?: boolean;
  balance?: number | string | null;
}

interface CodexUsageResponse {
  plan_type?: string;
  rate_limit?: RateLimitDetails;
  credits?: CreditDetails;
}

interface CodexResetCreditsResponse {
  credits: number;
  available_count: number;
}

export async function fetchCodexMetrics(
  accessToken: string,
  accountId?: string,
  fetchFn: typeof fetch = fetch,
): Promise<CodexFetchResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "graft-ai",
  };
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }

  const response = await fetchFn(USAGE_URL, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Codex API error: HTTP ${response.status}`);
  }

  const data = (await response.json()) as CodexUsageResponse;

  const primaryWindow = data.rate_limit?.primary_window;
  const secondaryWindow = data.rate_limit?.secondary_window;
  if (
    primaryWindow?.used_percent === undefined ||
    primaryWindow.reset_at === undefined ||
    secondaryWindow?.used_percent === undefined ||
    secondaryWindow.reset_at === undefined
  ) {
    throw new Error("Codex API response is missing a required window");
  }

  let resetCredits: CodexFetchResult["resetCredits"];
  try {
    const resetCreditsHeaders = {
      ...headers,
      "OpenAI-Beta": "codex-1",
      originator: "Codex Desktop",
    };
    const resetCreditsResponse = await fetchFn(RESET_CREDITS_URL, {
      method: "GET",
      headers: resetCreditsHeaders,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (resetCreditsResponse.ok) {
      const resetData = (await resetCreditsResponse.json()) as CodexResetCreditsResponse;
      if (typeof resetData.credits === "number" && typeof resetData.available_count === "number") {
        resetCredits = { credits: resetData.credits, availableCount: resetData.available_count };
      }
    } else {
      await resetCreditsResponse.body?.cancel().catch(() => undefined);
    }
  } catch {
    // reset-credits is supplementary; usage metrics remain usable when it fails
  }

  let creditsRemaining: number | null = null;
  if (data.credits?.balance !== undefined && data.credits?.balance !== null) {
    const rawBalance = data.credits.balance;
    const parsed = typeof rawBalance === "number" ? rawBalance : parseFloat(String(rawBalance));
    if (!Number.isNaN(parsed)) {
      creditsRemaining = parsed;
    }
  }

  return {
    sessionUsageRatio: primaryWindow.used_percent / 100,
    weeklyUsageRatio: secondaryWindow.used_percent / 100,
    sessionResetTimestampSeconds: primaryWindow.reset_at,
    weeklyResetTimestampSeconds: secondaryWindow.reset_at,
    creditsRemaining,
    resetCredits,
    plan: data.plan_type ?? "unknown",
  };
}
