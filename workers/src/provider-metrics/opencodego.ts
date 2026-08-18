import type { OpenCodeGoFetchResult } from "./types";
import { extractWorkspaceId, extractZenBalance, parseOpenCodeGoUsage } from "./opencodego-parser";
import { getWithRetry } from "../http-retry";

const BASE_URL = "https://opencode.ai";
const WORKSPACES_SERVER_ID = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";
const SUBSCRIPTION_SERVER_ID = "7abeebee372f304e050aaaf92be863f4a86490e382f8c79db68fd94040d691b4";
const BILLING_SERVER_ID = "c83b78a614689c38ebee981f9b39a8b377716db85c1fd7dbab604adc02d3313d";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const TIMEOUT_MS = 20000;

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

function normalizeCookie(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("=")) {
    return trimmed;
  }
  return `auth=${trimmed}; __Host-auth=${trimmed}`;
}

function serverInstanceHeader(): string {
  return `server-fn:${crypto.randomUUID()}`;
}

async function fetchServerRPC(
  serverId: string,
  args: readonly unknown[] | null,
  context: FetchContext,
  refererWorkspaceId?: string,
): Promise<string> {
  const referer = refererWorkspaceId
    ? `${BASE_URL}/workspace/${refererWorkspaceId}/billing`
    : BASE_URL;

  const url =
    args !== null && args.length > 0
      ? `${BASE_URL}/_server?id=${serverId}&args=${encodeURIComponent(JSON.stringify(args))}`
      : `${BASE_URL}/_server?id=${serverId}`;

  const response = await getWithRetry({
    url,
    headers: {
      Cookie: context.cookie,
      "X-Server-Id": serverId,
      "X-Server-Instance": serverInstanceHeader(),
      "User-Agent": USER_AGENT,
      Origin: BASE_URL,
      Referer: referer,
      Accept: "text/javascript, application/json;q=0.9, */*;q=0.8",
    },
    fetchFn: context.fetchFn,
    logLabel: `OpenCodeGo RPC [${serverId.slice(0, 8)}]`,
    isRetryableStatus: (status) => status === 429 || status >= 500,
    perAttemptTimeoutMs: TIMEOUT_MS,
    redirect: "manual",
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) {
      throw new OpenCodeGoFetchError(
        `OpenCodeGo: HTTP ${response.status} — Cookie expired, update OPENCODEGO_SESSION_COOKIE`,
      );
    }
    throw new OpenCodeGoFetchError(`OpenCodeGo RPC failed: HTTP ${response.status}`);
  }

  return response.text();
}

async function fetchWorkspaceId(context: FetchContext): Promise<string> {
  const text = await fetchServerRPC(WORKSPACES_SERVER_ID, null, context);
  const workspaceId = extractWorkspaceId(text);
  if (workspaceId === null) {
    throw new OpenCodeGoFetchError(
      `OpenCodeGo: Could not extract workspace ID from response (response length: ${text.length})`,
    );
  }
  return workspaceId;
}

async function fetchZenBalance(workspaceId: string, context: FetchContext): Promise<number | null> {
  try {
    const text = await fetchServerRPC(BILLING_SERVER_ID, [workspaceId], context, workspaceId);
    return extractZenBalance(text);
  } catch {
    return null;
  }
}

export async function fetchOpenCodeGoMetrics(
  rawCookie: string,
  workspaceIdOverride?: string,
  fetchFn: typeof fetch = fetch,
): Promise<OpenCodeGoFetchResult> {
  const cookie = normalizeCookie(rawCookie);
  const context: FetchContext = { cookie, fetchFn };
  const workspaceId = workspaceIdOverride?.trim() || (await fetchWorkspaceId(context));

  // 1. Fetch subscription usage via SolidStart server RPC
  let usageText: string;
  try {
    usageText = await fetchServerRPC(SUBSCRIPTION_SERVER_ID, [workspaceId], context, workspaceId);
  } catch (error) {
    // If subscription RPC fails, try scraping fallback or rethrow
    const errDetail = error instanceof Error ? error.message : String(error);
    throw new OpenCodeGoFetchError(`OpenCodeGo subscription fetch failed: ${errDetail}`);
  }

  const usage = parseOpenCodeGoUsage(usageText);
  return {
    ...usage,
    zenBalanceUSD: await fetchZenBalance(workspaceId, context),
  };
}
