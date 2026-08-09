import type { OpenCodeGoFetchResult } from "./types";
import { extractWorkspaceId, extractZenBalance, parseOpenCodeGoUsage } from "./opencodego-parser";
import { getWithRetry } from "../http-retry";

const BASE_URL = "https://opencode.ai";
const WORKSPACES_SERVER_ID = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";
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

async function get(
  url: string,
  context: FetchContext,
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<Response> {
  return getWithRetry({
    url,
    headers: {
      Cookie: context.cookie,
      "User-Agent": USER_AGENT,
      Referer: BASE_URL,
      Origin: BASE_URL,
      ...extraHeaders,
    },
    fetchFn: context.fetchFn,
    logLabel: "OpenCodeGo fetch",
    isRetryableStatus: (status) => status === 429 || status >= 500,
    perAttemptTimeoutMs: TIMEOUT_MS,
    redirect: "manual",
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
  let response: Response;
  try {
    response = await get(`${BASE_URL}/_server?id=${BILLING_SERVER_ID}&args=${args}`, context, {
      "X-Server-Id": BILLING_SERVER_ID,
      "X-Server-Instance": serverInstanceHeader(),
      Accept: "text/javascript, application/json, */*",
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    await discardResponse(response);
    return null;
  }
  try {
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
  const workspaceId = workspaceIdOverride?.trim() || (await fetchWorkspaceId(context));
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

  const usage = parseOpenCodeGoUsage(await usageResponse.text());
  return {
    ...usage,
    zenBalanceUSD: await fetchZenBalance(workspaceId, context),
  };
}
