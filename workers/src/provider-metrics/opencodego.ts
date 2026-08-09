import type { OpenCodeGoFetchResult } from "./types";

const BASE_URL = "https://opencode.ai";
const WORKSPACES_SERVER_ID = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";
const BILLING_SERVER_ID = "c83b78a614689c38ebee981f9b39a8b377716db85c1fd7dbab604adc02d3313d";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const TIMEOUT_MS = 20000;

const PERCENT_KEYS = [
  "usagePercent",
  "usedPercent",
  "percentUsed",
  "percent",
  "usage_percent",
  "used_percent",
  "utilization",
  "utilizationPercent",
  "utilization_percent",
  "usage",
] as const;
const WEEKLY_PERCENT_KEYS = [
  "weeklyUsagePercent",
  "weeklyUsedPercent",
  "weekly_usage_percent",
] as const;
const MONTHLY_PERCENT_KEYS = [
  "monthlyUsagePercent",
  "monthlyUsedPercent",
  "monthly_usage_percent",
] as const;
const RESET_IN_KEYS = [
  "resetInSec",
  "resetInSeconds",
  "resetSeconds",
  "reset_sec",
  "reset_in_sec",
  "resetsInSec",
  "resetsInSeconds",
  "resetIn",
  "resetSec",
] as const;
const WEEKLY_RESET_KEYS = [
  "weeklyResetInSec",
  "weeklyResetInSeconds",
  "weekly_reset_in_sec",
] as const;
const MONTHLY_RESET_KEYS = [
  "monthlyResetInSec",
  "monthlyResetInSeconds",
  "monthly_reset_in_sec",
] as const;
const USAGE_KEYS = [...PERCENT_KEYS, ...WEEKLY_PERCENT_KEYS, ...MONTHLY_PERCENT_KEYS] as const;

type FetchContext = {
  readonly cookie: string;
  readonly fetchFn: typeof fetch;
};

class OpenCodeGoFetchError extends Error {
  readonly name = "OpenCodeGoFetchError";

  constructor(readonly detail: string) {
    super(detail);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function findUsageObject(value: unknown): Record<string, unknown> | null {
  const matches: Record<string, unknown>[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!isRecord(candidate)) return;
    if (USAGE_KEYS.some((key) => key in candidate)) matches.push(candidate);
    for (const item of Object.values(candidate)) visit(item);
  };

  visit(value);
  return matches.length === 0 ? null : Object.assign({}, ...matches);
}

function parseUsageJson(source: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(source);
    return findUsageObject(parsed);
  } catch {
    return null;
  }
}

function extractFromNextData(html: string): Record<string, unknown> | null {
  const match = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  const source = match?.[1]?.trim();
  return source === undefined || source.length === 0 ? null : parseUsageJson(source);
}

function extractFromScriptTags(html: string): Record<string, unknown> | null {
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    const source = match[1]?.trim();
    if (source === undefined || source.length === 0) continue;
    const usage = parseUsageJson(source);
    if (usage !== null) return usage;
  }
  return null;
}

function extractFromRscHydration(html: string): Record<string, unknown> | null {
  const matches: Record<string, unknown>[] = [];
  for (const match of html.matchAll(
    /"(?:rollingUsage|weeklyUsage|monthlyUsage)"\s*,\s*(\{[^{}]+\})/g,
  )) {
    const source = match[1];
    if (source === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(source);
      if (isRecord(parsed)) matches.push(parsed);
    } catch {
      continue;
    }
  }
  return matches.length === 0 ? null : Object.assign({}, ...matches);
}

function extractFromTextFallback(html: string): Record<string, unknown> | null {
  const usageMatch = html.match(
    /"(?:usagePercent|rollingUsagePercent|usedPercent)"\s*:\s*(\d+(?:\.\d+)?)/,
  );
  const usagePercentText = usageMatch?.[1];
  if (usagePercentText === undefined) return null;

  const usagePercent = Number(usagePercentText);
  if (!Number.isFinite(usagePercent)) return null;
  const resetMatch = html.match(/"resetInSec(?:onds)?"\s*:\s*(\d+)/);
  const resetText = resetMatch?.[1];
  return resetText === undefined
    ? { usagePercent }
    : { usagePercent, resetInSec: Number(resetText) };
}

function extractUsageData(html: string): Record<string, unknown> | null {
  return (
    extractFromNextData(html) ??
    parseUsageJson(html.trim()) ??
    extractFromScriptTags(html) ??
    extractFromRscHydration(html) ??
    extractFromTextFallback(html)
  );
}

function extractWorkspaceId(html: string): string | null {
  return html.match(/"(wrk_[a-zA-Z0-9]+)"/)?.[1] ?? null;
}

function extractZenBalance(html: string): number | null {
  const value = html.match(/"zenBalance"\s*:\s*(-?\d+(?:\.\d+)?)/)?.[1];
  if (value === undefined) return null;
  const balance = Number(value);
  return Number.isFinite(balance) ? balance : null;
}

async function get(
  url: string,
  context: FetchContext,
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<Response> {
  return context.fetchFn(url, {
    method: "GET",
    headers: {
      Cookie: context.cookie,
      "User-Agent": USER_AGENT,
      Referer: BASE_URL,
      Origin: BASE_URL,
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function serverInstanceHeader(): string {
  return `server-fn:${crypto.randomUUID()}`;
}

async function fetchWorkspaceId(context: FetchContext): Promise<string> {
  const response = await get(`${BASE_URL}/_server?id=${WORKSPACES_SERVER_ID}`, context, {
    "X-Server-Id": WORKSPACES_SERVER_ID,
    "X-Server-Instance": serverInstanceHeader(),
    Accept: "text/javascript, application/json, */*",
  });
  if (!response.ok) {
    await discardResponse(response);
    if (response.status === 401 || response.status === 403) {
      throw new OpenCodeGoFetchError(
        `OpenCodeGo: HTTP ${response.status} — Cookie expired, update OPENCODEGO_SESSION_COOKIE`,
      );
    }
    throw new OpenCodeGoFetchError(`OpenCodeGo workspace fetch failed: HTTP ${response.status}`);
  }

  const workspaceId = extractWorkspaceId(await response.text());
  if (workspaceId === null) {
    throw new OpenCodeGoFetchError("OpenCodeGo: Could not extract workspace ID from response");
  }
  return workspaceId;
}

async function fetchZenBalance(workspaceId: string, context: FetchContext): Promise<number | null> {
  const args = encodeURIComponent(JSON.stringify([workspaceId]));
  try {
    const response = await get(
      `${BASE_URL}/_server?id=${BILLING_SERVER_ID}&args=${args}`,
      context,
      {
        "X-Server-Id": BILLING_SERVER_ID,
        "X-Server-Instance": serverInstanceHeader(),
        Accept: "text/javascript, application/json, */*",
      },
    );
    if (!response.ok) {
      await discardResponse(response);
      return null;
    }
    return extractZenBalance(await response.text());
  } catch {
    return null;
  }
}

export async function fetchOpenCodeGoMetrics(
  cookie: string,
  workspaceIdOverride?: string,
  fetchFn: typeof fetch = fetch,
): Promise<OpenCodeGoFetchResult> {
  const context: FetchContext = { cookie, fetchFn };
  const workspaceId = workspaceIdOverride ?? (await fetchWorkspaceId(context));
  const usageResponse = await get(`${BASE_URL}/workspace/${workspaceId}/go`, context);
  if (!usageResponse.ok) {
    await discardResponse(usageResponse);
    if (usageResponse.status === 401 || usageResponse.status === 403) {
      throw new OpenCodeGoFetchError(
        `OpenCodeGo: HTTP ${usageResponse.status} — Cookie expired, update OPENCODEGO_SESSION_COOKIE`,
      );
    }
    throw new OpenCodeGoFetchError(
      `OpenCodeGo usage page fetch failed: HTTP ${usageResponse.status}`,
    );
  }

  const usage = extractUsageData(await usageResponse.text());
  if (usage === null) {
    throw new OpenCodeGoFetchError("OpenCodeGo: Could not parse usage data from page HTML");
  }
  const rollingPercent = pickNumber(usage, PERCENT_KEYS);
  const rollingReset = pickNumber(usage, RESET_IN_KEYS);
  if (rollingPercent === undefined || rollingReset === undefined) {
    throw new OpenCodeGoFetchError(
      "OpenCodeGo response is missing required rolling usage or reset data",
    );
  }

  const weeklyPercent = pickNumber(usage, WEEKLY_PERCENT_KEYS);
  const monthlyPercent = pickNumber(usage, MONTHLY_PERCENT_KEYS);
  const weeklyReset = pickNumber(usage, WEEKLY_RESET_KEYS);
  const monthlyReset = pickNumber(usage, MONTHLY_RESET_KEYS);
  return {
    rollingUsageRatio: rollingPercent / 100,
    weeklyUsageRatio: weeklyPercent === undefined ? undefined : weeklyPercent / 100,
    monthlyUsageRatio: monthlyPercent === undefined ? undefined : monthlyPercent / 100,
    rollingResetSeconds: Math.round(rollingReset),
    weeklyResetSeconds: weeklyReset === undefined ? undefined : Math.round(weeklyReset),
    monthlyResetSeconds: monthlyReset === undefined ? undefined : Math.round(monthlyReset),
    zenBalanceUSD: await fetchZenBalance(workspaceId, context),
  };
}
