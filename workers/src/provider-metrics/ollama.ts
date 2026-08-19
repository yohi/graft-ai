// workers/src/provider-metrics/ollama.ts

import type { OllamaFetchResult } from "./types";
import { getWithRetry } from "../http-retry";

const OLLAMA_SETTINGS_URL = "https://ollama.com/settings";

export class OllamaFetchError extends Error {
  readonly name = "OllamaFetchError";

  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

interface ParsedUsageBlock {
  usedPercent: number;
  resetTimestampSeconds?: number;
}

const PRIMARY_USAGE_LABELS = ["Session usage", "Hourly usage"];
const USAGE_LABELS = [...PRIMARY_USAGE_LABELS, "Weekly usage"];

function firstCapture(text: string, regex: RegExp): string | null {
  const match = regex.exec(text);
  return match && match[1] ? match[1] : null;
}

function parsePlanName(html: string): string | undefined {
  const pattern = /Cloud Usage\s*<\/span>\s*<span[^>]*>([^<]+)<\/span>/i;
  const raw = firstCapture(html, pattern);
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseAccountEmail(html: string): string | undefined {
  const pattern = /id="header-email"[^>]*>([^<]+)</i;
  const raw = firstCapture(html, pattern);
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.includes("@") ? trimmed : undefined;
}

function parsePercent(text: string): number | null {
  const usedPattern = /(\d+(?:\.\d+)?)\s*%\s*used/i;
  const usedMatch = firstCapture(text, usedPattern);
  if (usedMatch !== null) {
    const val = Number(usedMatch);
    if (Number.isFinite(val)) return val;
  }

  const widthPattern = /width:\s*(\d+(?:\.\d+)?)\s*%/i;
  const widthMatch = firstCapture(text, widthPattern);
  if (widthMatch !== null) {
    const val = Number(widthMatch);
    if (Number.isFinite(val)) return val;
  }

  return null;
}

function parseISODateSeconds(text: string): number | undefined {
  const pattern = /data-time="([^"]+)"/i;
  const raw = firstCapture(text, pattern);
  if (!raw) return undefined;

  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return undefined;
  return Math.floor(ms / 1000);
}

function usageBlockWindow(afterLabel: string, tail: string): string {
  const maxLength = 4000;
  let minIndex = maxLength;

  for (const otherLabel of USAGE_LABELS) {
    if (otherLabel === afterLabel) continue;
    const idx = tail.indexOf(otherLabel);
    if (idx !== -1 && idx < minIndex) {
      minIndex = idx;
    }
  }

  return tail.slice(0, minIndex);
}

function parseUsageBlock(label: string, html: string): ParsedUsageBlock | null {
  const labelIndex = html.indexOf(label);
  if (labelIndex === -1) return null;

  const tail = html.slice(labelIndex + label.length);
  const blockWindow = usageBlockWindow(label, tail);

  const usedPercent = parsePercent(blockWindow);
  if (usedPercent === null || usedPercent < 0 || usedPercent > 100) return null;

  const resetTimestampSeconds = parseISODateSeconds(blockWindow);

  return {
    usedPercent,
    resetTimestampSeconds,
  };
}

function parseUsageBlockWithLabels(
  labels: readonly string[],
  html: string,
): ParsedUsageBlock | null {
  for (const label of labels) {
    const parsed = parseUsageBlock(label, html);
    if (parsed !== null) return parsed;
  }
  return null;
}

function looksSignedOut(html: string): boolean {
  const lower = html.toLowerCase();
  const hasSignInHeading =
    lower.includes("sign in to ollama") || lower.includes("log in to ollama");
  const hasAuthRoute = lower.includes("/api/auth/signin") || lower.includes("/auth/signin");
  const hasLoginRoute =
    lower.includes('action="/login"') ||
    lower.includes("action='/login'") ||
    lower.includes('href="/login"') ||
    lower.includes("href='/login'") ||
    lower.includes('action="/signin"') ||
    lower.includes("action='/signin'") ||
    lower.includes('href="/signin"') ||
    lower.includes("href='/signin'");
  const hasPasswordField = lower.includes('type="password"') || lower.includes("name='password'");
  const hasEmailField = lower.includes('type="email"') || lower.includes("name='email'");
  const hasAuthForm = lower.includes("<form");
  const hasAuthEndpoint = hasAuthRoute || hasLoginRoute;

  if (hasSignInHeading || (hasAuthForm && (hasEmailField || hasPasswordField || hasAuthEndpoint))) {
    return true;
  }
  return false;
}

export function parseOllamaUsageHtml(html: string): OllamaFetchResult {
  const sessionBlock = parseUsageBlockWithLabels(PRIMARY_USAGE_LABELS, html);
  const weeklyBlock = parseUsageBlock("Weekly usage", html);

  if (sessionBlock === null && weeklyBlock === null) {
    if (looksSignedOut(html)) {
      throw new OllamaFetchError(
        "Ollama session cookie is invalid or expired (signed out page returned)",
        401,
      );
    }
    throw new OllamaFetchError("Could not find Ollama Cloud usage data in settings page HTML");
  }

  const plan = parsePlanName(html);
  const email = parseAccountEmail(html);

  return {
    sessionUsageRatio: sessionBlock ? sessionBlock.usedPercent / 100 : undefined,
    weeklyUsageRatio: weeklyBlock ? weeklyBlock.usedPercent / 100 : undefined,
    sessionResetTimestampSeconds: sessionBlock ? sessionBlock.resetTimestampSeconds : undefined,
    weeklyResetTimestampSeconds: weeklyBlock ? weeklyBlock.resetTimestampSeconds : undefined,
    plan,
    email,
  };
}

export async function fetchOllamaMetrics(
  sessionCookie: string,
  fetchFn: typeof fetch = fetch,
): Promise<OllamaFetchResult> {
  const trimmedCookie = sessionCookie.trim();
  if (trimmedCookie.length === 0) {
    throw new OllamaFetchError("Ollama session cookie is empty", 401);
  }

  const cookieHeader = trimmedCookie.includes("=")
    ? trimmedCookie
    : `ollama_session=${trimmedCookie}; wos-session=${trimmedCookie}`;

  const headers: Record<string, string> = {
    Cookie: cookieHeader,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  };

  const response = await getWithRetry({
    url: OLLAMA_SETTINGS_URL,
    headers,
    logLabel: "Ollama Cloud settings",
    isRetryableStatus: (status) => status === 429 || status >= 500,
    fetchFn,
  });

  if (!response.ok) {
    let bodySnippet = "";
    try {
      const text = await response.text();
      bodySnippet = ` — ${text.replace(/\s+/g, " ").trim().slice(0, 200)}`;
    } catch {
      await response.body?.cancel().catch(() => undefined);
    }
    throw new OllamaFetchError(
      `Ollama settings request failed: HTTP ${response.status}${bodySnippet}`,
      response.status,
    );
  }

  const html = await response.text();
  return parseOllamaUsageHtml(html);
}
