import { extractWorkspaceId, extractZenBalance } from "../opencodego-parser";
import { getWithRetry } from "../../http-retry";

const BASE_URL = "https://opencode.ai";
const WORKSPACES_SERVER_ID = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";
export const LITE_SUBSCRIPTION_SERVER_ID =
  "c7389bd0e731f80f49593e5ee53835475f4e28594dd6bd83eb229bab753498cd";
export const SUBSCRIPTION_SERVER_ID =
  "7abeebee372f304e050aaaf92be863f4a86490e382f8c79db68fd94040d691b4";
export const BILLING_SERVER_ID = "c83b78a614689c38ebee981f9b39a8b377716db85c1fd7dbab604adc02d3313d";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const TIMEOUT_MS = 8000;

export type FetchContext = {
  readonly cookie: string;
  readonly fetchFn: typeof fetch;
};

export class OpenCodeGoFetchError extends Error {
  readonly name = "OpenCodeGoFetchError";

  constructor(readonly detail: string) {
    super(detail);
  }
}

function normalizeCookie(raw: string): string {
  let trimmed = raw.trim();
  while (trimmed.startsWith("'") || trimmed.startsWith('"')) {
    trimmed = trimmed.slice(1);
  }
  while (trimmed.endsWith("'") || trimmed.endsWith('"')) {
    trimmed = trimmed.slice(0, -1);
  }
  trimmed = trimmed.trim();
  if (trimmed.includes("=")) {
    return trimmed;
  }
  return `auth=${trimmed}; __Host-auth=${trimmed}`;
}

export function createFetchContext(rawCookie: string, fetchFn: typeof fetch): FetchContext {
  return { cookie: normalizeCookie(rawCookie), fetchFn };
}

function serverInstanceHeader(): string {
  return `server-fn:${crypto.randomUUID()}`;
}

export function isNullPayload(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed === "" ||
    trimmed === "null" ||
    trimmed === "{}" ||
    trimmed === "[]" ||
    trimmed.endsWith("=[],null)") ||
    trimmed.endsWith("=[], null)") ||
    trimmed.endsWith("=[],void 0)") ||
    trimmed.endsWith("=[], void 0)")
  );
}

export async function fetchServerRPC(
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

  const headers: Record<string, string> = {
    Cookie: context.cookie,
    "X-Server-Id": serverId,
    "X-Server-Instance": serverInstanceHeader(),
    "User-Agent": USER_AGENT,
    Origin: BASE_URL,
    Referer: referer,
    Accept: "text/javascript, application/json;q=0.9, */*;q=0.8",
  };

  const response = await getWithRetry({
    url,
    headers,
    fetchFn: context.fetchFn,
    logLabel: `OpenCodeGo RPC [${serverId.slice(0, 8)}]`,
    isRetryableStatus: (status) => status === 429 || status >= 500,
    perAttemptTimeoutMs: TIMEOUT_MS,
    redirect: "manual",
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location");
    if (!location) {
      throw new OpenCodeGoFetchError(
        `OpenCodeGo RPC [${serverId.slice(0, 8)}] redirected with HTTP ${response.status} but missing Location header`,
      );
    }
    const targetUrl = new URL(location, BASE_URL);
    if (targetUrl.origin !== new URL(BASE_URL).origin) {
      throw new OpenCodeGoFetchError(
        `OpenCodeGo RPC [${serverId.slice(0, 8)}] attempted cross-origin redirect to ${targetUrl.origin}`,
      );
    }
    const redirectResponse = await getWithRetry({
      url: targetUrl.toString(),
      headers,
      fetchFn: context.fetchFn,
      logLabel: `OpenCodeGo RPC redirect [${serverId.slice(0, 8)}]`,
      isRetryableStatus: (status) => status === 429 || status >= 500,
      perAttemptTimeoutMs: TIMEOUT_MS,
      redirect: "manual",
    });
    if (!redirectResponse.ok) {
      await redirectResponse.body?.cancel().catch(() => undefined);
      if (redirectResponse.status === 401 || redirectResponse.status === 403) {
        throw new OpenCodeGoFetchError(
          `OpenCodeGo: HTTP ${redirectResponse.status} — Cookie expired, update OPENCODEGO_SESSION_COOKIE`,
        );
      }
      throw new OpenCodeGoFetchError(
        `OpenCodeGo RPC [${serverId.slice(0, 8)}] HTTP ${redirectResponse.status}`,
      );
    }
    return redirectResponse.text();
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) {
      throw new OpenCodeGoFetchError(
        `OpenCodeGo: HTTP ${response.status} — Cookie expired, update OPENCODEGO_SESSION_COOKIE`,
      );
    }
    throw new OpenCodeGoFetchError(
      `OpenCodeGo RPC [${serverId.slice(0, 8)}] HTTP ${response.status}`,
    );
  }

  return response.text();
}

export async function fetchWorkspaceId(context: FetchContext): Promise<string> {
  const text = await fetchServerRPC(WORKSPACES_SERVER_ID, null, context);
  const workspaceId = extractWorkspaceId(text);

  if (workspaceId === null) {
    throw new OpenCodeGoFetchError(
      `OpenCodeGo: Could not extract workspace ID from response (response length: ${text.length})`,
    );
  }
  return workspaceId;
}

export async function fetchZenBalance(
  workspaceId: string,
  context: FetchContext,
): Promise<number | null> {
  try {
    const text = await fetchServerRPC(BILLING_SERVER_ID, [workspaceId], context, workspaceId);
    return extractZenBalance(text);
  } catch {
    return null;
  }
}

export async function fetchZenBalanceEnrichment(
  rawCookie: string,
  workspaceIdOverride?: string,
  fetchFn: typeof fetch = fetch,
): Promise<number | null> {
  try {
    const context = createFetchContext(rawCookie, fetchFn);
    const workspaceId = workspaceIdOverride?.trim() || (await fetchWorkspaceId(context));
    return await fetchZenBalance(workspaceId, context);
  } catch {
    return null;
  }
}
