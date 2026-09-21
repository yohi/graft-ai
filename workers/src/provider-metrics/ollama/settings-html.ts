import { getWithRetry, HttpTransportError } from "../../http-retry";
import type { ProviderErrorKind, QuotaPeriod, QuotaWindow } from "../types";

const OLLAMA_SETTINGS_URL = "https://ollama.com/settings";
const PRIMARY_USAGE_LABELS = ["Session usage", "Hourly usage"] as const;
const USAGE_LABELS = [...PRIMARY_USAGE_LABELS, "Weekly usage", "Monthly usage"] as const;

type SettingsHtmlFailureKind = Extract<
  ProviderErrorKind,
  "auth" | "upstream_4xx" | "upstream_5xx" | "network" | "timeout" | "parse" | "internal"
>;

export interface OllamaSettingsHtmlContribution {
  readonly windows: readonly QuotaWindow[];
  readonly plan?: string;
  readonly email?: string;
}

export type OllamaSettingsHtmlOutcome =
  | { readonly status: "success"; readonly contribution: OllamaSettingsHtmlContribution }
  | {
      readonly status: "failed";
      readonly error: {
        readonly kind: SettingsHtmlFailureKind;
        readonly statusCode?: number;
      };
    };

export class OllamaFetchError extends Error {
  readonly name = "OllamaFetchError";

  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

function firstCapture(text: string, regex: RegExp): string | null {
  const match = regex.exec(text);
  return match?.[1] ?? null;
}

function parsePlanName(html: string): string | undefined {
  const raw = firstCapture(html, /Cloud Usage\s*<\/span>\s*<span[^>]*>([^<]+)<\/span>/i);
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseAccountEmail(html: string): string | undefined {
  const raw = firstCapture(html, /id="header-email"[^>]*>([^<]+)</i);
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.includes("@") ? trimmed : undefined;
}

function parsePercent(text: string): number | null {
  const usedMatch = firstCapture(text, /([0-9.]+)\s*%\s*used/i);
  if (usedMatch !== null) {
    const value = Number(usedMatch);
    if (Number.isFinite(value)) return value;
  }

  const widthMatch = firstCapture(text, /width:\s*([0-9.]+)\s*%/i);
  if (widthMatch !== null) {
    const value = Number(widthMatch);
    if (Number.isFinite(value)) return value;
  }

  return null;
}

function parseISODateSeconds(text: string): number | undefined {
  const raw = firstCapture(text, /data-time="([^"]+)"/i);
  if (!raw) return undefined;

  const milliseconds = Date.parse(raw);
  return Number.isNaN(milliseconds) ? undefined : Math.floor(milliseconds / 1000);
}

function usageBlockWindow(afterLabel: string, tail: string): string {
  const maxLength = 4_000;
  let minIndex = maxLength;

  for (const otherLabel of USAGE_LABELS) {
    if (otherLabel === afterLabel) continue;
    const index = tail.indexOf(otherLabel);
    if (index !== -1 && index < minIndex) minIndex = index;
  }

  return tail.slice(0, minIndex);
}

function parseUsageBlock(label: string, period: QuotaPeriod, html: string): QuotaWindow | null {
  const labelIndex = html.indexOf(label);
  if (labelIndex === -1) return null;

  const tail = html.slice(labelIndex + label.length);
  const blockWindow = usageBlockWindow(label, tail);
  const usedPercent = parsePercent(blockWindow);
  const resetTimestampSeconds = parseISODateSeconds(blockWindow);
  const hasValidUsage = usedPercent !== null && usedPercent >= 0 && usedPercent <= 100;

  if (!hasValidUsage && resetTimestampSeconds === undefined) return null;

  return {
    period,
    ...(hasValidUsage && usedPercent !== null ? { usageRatio: usedPercent / 100 } : {}),
    ...(resetTimestampSeconds === undefined ? {} : { resetTimestampSeconds }),
  };
}

function parseUsageBlockWithLabels(
  labels: readonly string[],
  period: QuotaPeriod,
  html: string,
): QuotaWindow | null {
  for (const label of labels) {
    const parsed = parseUsageBlock(label, period, html);
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

  return (
    hasSignInHeading || (hasAuthForm && (hasEmailField || hasPasswordField || hasAuthEndpoint))
  );
}

export function parseOllamaUsageHtml(html: string): OllamaSettingsHtmlContribution {
  if (looksSignedOut(html)) {
    throw new OllamaFetchError(
      "Ollama session cookie is invalid or expired (signed out page returned)",
      401,
    );
  }

  const windows = [
    parseUsageBlockWithLabels(PRIMARY_USAGE_LABELS, "session", html),
    parseUsageBlock("Weekly usage", "weekly", html),
    parseUsageBlock("Monthly usage", "monthly", html),
  ].filter((window): window is QuotaWindow => window !== null);
  const plan = parsePlanName(html);
  const email = parseAccountEmail(html);

  return {
    windows,
    ...(plan === undefined ? {} : { plan }),
    ...(email === undefined ? {} : { email }),
  };
}

function httpFailureKind(statusCode: number): SettingsHtmlFailureKind {
  if (statusCode === 401) return "auth";
  return statusCode >= 500 ? "upstream_5xx" : "upstream_4xx";
}

function failed(kind: SettingsHtmlFailureKind, statusCode?: number): OllamaSettingsHtmlOutcome {
  return {
    status: "failed",
    error: {
      kind,
      ...(statusCode === undefined ? {} : { statusCode }),
    },
  };
}

export async function fetchOllamaSettingsHtml(
  sessionCookie: string,
  fetchFn: typeof fetch = fetch,
): Promise<OllamaSettingsHtmlOutcome> {
  const trimmedCookie = sessionCookie.trim();
  if (trimmedCookie.length === 0) return failed("auth", 401);

  const cookieHeader = trimmedCookie.includes("=")
    ? trimmedCookie
    : `ollama_session=${trimmedCookie}; wos-session=${trimmedCookie}`;

  try {
    const response = await getWithRetry({
      url: OLLAMA_SETTINGS_URL,
      headers: {
        Cookie: cookieHeader,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      },
      logLabel: "Ollama Cloud settings",
      isRetryableStatus: (status) => status === 429 || status >= 500,
      fetchFn,
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return failed(httpFailureKind(response.status), response.status);
    }

    let html: string;
    try {
      html = await response.text();
    } catch (error) {
      if (error instanceof HttpTransportError) return failed(error.kind);
      return failed("parse");
    }

    try {
      return { status: "success", contribution: parseOllamaUsageHtml(html) };
    } catch (error) {
      if (error instanceof OllamaFetchError) {
        return failed(error.statusCode === 401 ? "auth" : "parse", error.statusCode);
      }
      return failed("internal");
    }
  } catch (error) {
    if (error instanceof HttpTransportError) return failed(error.kind);
    return failed("internal");
  }
}
