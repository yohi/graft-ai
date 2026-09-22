import { getJsonWithRetry, HttpTransportError } from "../../http-retry";
import type {
  ProviderContext,
  ProviderCredits,
  ProviderError,
  ProviderErrorKind,
  ProviderUsageSummary,
  QuotaWindow,
} from "../types";

export const COMMAND_CODE_BASE_URL = "https://api.commandcode.ai";
export const COMMAND_CODE_SOURCE_IDS = {
  whoami: "commandcode-whoami",
  credits: "commandcode-billing-credits",
  subscriptions: "commandcode-billing-subscriptions",
  summary: "commandcode-usage-summary",
} as const;

const TIMEOUT_MS = 10_000;

type EndpointOutcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ProviderError };

type CommandCodeWhoami = { readonly orgId: string };

export type CommandCodeCredits = {
  readonly credits: ProviderCredits;
  readonly windows: QuotaWindow[];
};

export type CommandCodeSubscription = Partial<{
  readonly plan: string;
  readonly status: string;
  readonly currentPeriodStart: string;
  readonly billingPeriodEndSeconds: number;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function httpFailureKind(statusCode: number): ProviderErrorKind {
  if (statusCode === 401) return "auth";
  if (statusCode === 403) return "forbidden";
  if (statusCode === 429) return "rate_limit";
  if (statusCode >= 500) return "upstream_5xx";
  return "upstream_4xx";
}

function failure(source: string, kind: ProviderErrorKind, status?: number): EndpointOutcome<never> {
  const statusCode = status === undefined ? {} : { statusCode: status };
  return { ok: false, error: { kind, provider: "commandcode", sourceId: source, ...statusCode } };
}

function endpointUrl(path: string, query: readonly [string, string][]): string {
  const queryString = query
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `${COMMAND_CODE_BASE_URL}${path}${queryString === "" ? "" : `?${queryString}`}`;
}

interface EndpointRequest<T> {
  readonly path: string;
  readonly query: readonly [string, string][];
  readonly sourceId: string;
  readonly parse: (value: unknown) => T | null;
}

const jsonFailureKind = (error: unknown): ProviderErrorKind =>
  error instanceof HttpTransportError
    ? error.kind
    : error instanceof SyntaxError
      ? "parse"
      : "internal";

async function requestEndpoint<T>(
  apiKey: string,
  request: EndpointRequest<T>,
  context: ProviderContext,
): Promise<EndpointOutcome<T>> {
  let response: Response;
  let body: unknown;
  try {
    const result = await getJsonWithRetry({
      url: endpointUrl(request.path, request.query),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      fetchFn: context.fetchFn,
      logLabel: `CommandCode ${request.sourceId}`,
      isRetryableStatus: (status) => status === 429 || status >= 500,
      perAttemptTimeoutMs: TIMEOUT_MS,
    });
    response = result.response;
    body = result.body;
  } catch (error) {
    return failure(request.sourceId, jsonFailureKind(error));
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return failure(request.sourceId, httpFailureKind(response.status), response.status);
  }

  try {
    const parsed = request.parse(body);
    return parsed === null ? failure(request.sourceId, "schema") : { ok: true, value: parsed };
  } catch {
    return failure(request.sourceId, "internal");
  }
}

function parseWhoami(value: unknown): CommandCodeWhoami | null {
  if (!isRecord(value) || !isRecord(value["org"])) return null;
  const orgId = value["org"]["id"];
  return nonEmptyString(orgId) ? { orgId } : null;
}

function parseResetTimestamp(value: unknown): number | undefined {
  if (!isFiniteNonNegative(value)) return undefined;
  return value >= 1_000_000_000_000 ? Math.floor(value / 1_000) : Math.floor(value);
}

function parseQuotaWindow(value: unknown, period: QuotaWindow["period"]): QuotaWindow | null {
  if (!isRecord(value)) return null;
  const used = value["used"];
  const limit = value["cap"];
  if (!isFiniteNonNegative(used) || !isFiniteNonNegative(limit) || limit === 0) return null;

  const resetTimestampSeconds = parseResetTimestamp(value["resetAt"]);
  return {
    period,
    used,
    limit,
    usageRatio: Math.min(used / limit, 1),
    exceeded: used >= limit,
    ...(resetTimestampSeconds === undefined ? {} : { resetTimestampSeconds }),
  };
}

function parseWindowLimits(value: unknown): QuotaWindow[] | null {
  if (!isRecord(value)) return [];
  const limited = value["limited"];
  if (limited === false || typeof limited !== "boolean") return [];

  const session = parseQuotaWindow(value["fiveHour"], "session");
  const weekly = parseQuotaWindow(value["weekly"], "weekly");
  return session === null || weekly === null ? null : [session, weekly];
}

const optionalCredit = (value: unknown): number | undefined =>
  isFiniteNonNegative(value) ? value : undefined;

function parseCredits(value: unknown): CommandCodeCredits | null {
  if (!isRecord(value) || !isRecord(value["credits"])) return null;
  const monthly = value["credits"]["monthlyCredits"];
  if (!isFiniteNonNegative(monthly)) return null;

  const purchased = optionalCredit(value["credits"]["purchasedCredits"]);
  const free = optionalCredit(value["credits"]["freeCredits"]);
  const remaining = monthly + (purchased ?? 0) + (free ?? 0);
  const windows = parseWindowLimits(value["windowLimits"]);
  if (windows === null) return null;

  return {
    credits: {
      monthly,
      ...(purchased === undefined ? {} : { purchased }),
      ...(free === undefined ? {} : { free }),
      ...(Number.isFinite(remaining) ? { remaining } : {}),
    },
    windows,
  };
}

function parseIsoSeconds(value: unknown): number | undefined {
  if (!nonEmptyString(value)) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1_000) : undefined;
}

function parseSubscription(value: unknown): CommandCodeSubscription | null {
  if (!isRecord(value) || !isRecord(value["data"])) return null;
  const data = value["data"];
  const currentPeriodStart = nonEmptyString(data["currentPeriodStart"])
    ? data["currentPeriodStart"]
    : undefined;
  const billingPeriodEndSeconds = parseIsoSeconds(data["currentPeriodEnd"]);
  return {
    ...(nonEmptyString(data["planId"]) ? { plan: data["planId"] } : {}),
    ...(nonEmptyString(data["status"]) ? { status: data["status"] } : {}),
    ...(currentPeriodStart !== undefined && parseIsoSeconds(currentPeriodStart) !== undefined
      ? { currentPeriodStart }
      : {}),
    ...(billingPeriodEndSeconds === undefined ? {} : { billingPeriodEndSeconds }),
  };
}

function parseSummary(value: unknown): ProviderUsageSummary | null {
  if (!isRecord(value)) return null;
  const costUSD = optionalCredit(value["totalCost"]);
  const requests = optionalCredit(value["totalCount"]);
  const rawTokens = value["totalTokens"];
  const tokens =
    typeof rawTokens === "number" && Number.isSafeInteger(rawTokens) && rawTokens >= 0
      ? rawTokens
      : undefined;
  if (costUSD === undefined && requests === undefined && tokens === undefined) return null;
  return {
    ...(costUSD === undefined ? {} : { costUSD }),
    ...(requests === undefined ? {} : { requests }),
    ...(tokens === undefined ? {} : { tokens }),
  };
}

const WHOAMI_REQUEST: EndpointRequest<CommandCodeWhoami> = {
  path: "/alpha/whoami",
  query: [["limits", "1"]],
  sourceId: COMMAND_CODE_SOURCE_IDS.whoami,
  parse: parseWhoami,
};

function orgRequest<T>(
  path: string,
  orgId: string,
  sourceId: string,
  parse: (value: unknown) => T | null,
): EndpointRequest<T> {
  return { path, query: [["orgId", orgId]], sourceId, parse };
}

function summaryRequest(
  orgId: string,
  currentPeriodStart: string | undefined,
): EndpointRequest<ProviderUsageSummary> {
  const query: [string, string][] = [["orgId", orgId]];
  if (currentPeriodStart !== undefined) query.push(["since", currentPeriodStart]);
  return {
    path: "/alpha/usage/summary",
    query,
    sourceId: COMMAND_CODE_SOURCE_IDS.summary,
    parse: parseSummary,
  };
}

export const fetchCommandCodeWhoami = (apiKey: string, context: ProviderContext) =>
  requestEndpoint(apiKey, WHOAMI_REQUEST, context);
export const fetchCommandCodeCredits = (apiKey: string, orgId: string, context: ProviderContext) =>
  requestEndpoint(
    apiKey,
    orgRequest("/alpha/billing/credits", orgId, COMMAND_CODE_SOURCE_IDS.credits, parseCredits),
    context,
  );
export const fetchCommandCodeSubscription = (
  apiKey: string,
  orgId: string,
  context: ProviderContext,
) =>
  requestEndpoint(
    apiKey,
    orgRequest(
      "/alpha/billing/subscriptions",
      orgId,
      COMMAND_CODE_SOURCE_IDS.subscriptions,
      parseSubscription,
    ),
    context,
  );
export const fetchCommandCodeSummary = (
  apiKey: string,
  orgId: string,
  currentPeriodStart: string | undefined,
  context: ProviderContext,
) => requestEndpoint(apiKey, summaryRequest(orgId, currentPeriodStart), context);
