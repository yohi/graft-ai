import { getWithRetry, HttpTransportError } from "../../http-retry";
import type {
  AdapterOutcome,
  ProviderContext,
  ProviderErrorKind,
  ProviderResult,
  QuotaPeriod,
  QuotaWindow,
} from "../types";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const SOURCE_ID = "opencodego-usage-api";
const TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failed(kind: ProviderErrorKind, statusCode?: number): AdapterOutcome {
  return {
    status: "failed",
    error: {
      kind,
      provider: "opencodego",
      sourceId: SOURCE_ID,
      ...(statusCode === undefined ? {} : { statusCode }),
    },
  };
}

function parseResetTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1_000) : undefined;
}

function parseWindow(value: unknown, period: QuotaPeriod): QuotaWindow | null {
  if (!isRecord(value)) return null;

  const status = value["status"];
  if (typeof status !== "string" || status.trim().length === 0) return null;

  const percent = value["percent"];
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    return null;
  }

  const exceeded = status === "rate-limited" || status === "exhausted";
  if (exceeded && percent !== 100) return null;

  const resetTimestampSeconds = parseResetTimestamp(value["resetsAt"]);
  return {
    period,
    usageRatio: percent / 100,
    ...(resetTimestampSeconds === undefined ? {} : { resetTimestampSeconds }),
    exceeded,
  };
}

function parseUsageWindows(value: unknown): QuotaWindow[] | null {
  if (!isRecord(value)) return null;
  const usage = value["usage"];
  if (!isRecord(usage)) return null;

  const rolling = parseWindow(usage["rolling"], "rolling");
  const weekly = parseWindow(usage["weekly"], "weekly");
  const monthly = parseWindow(usage["monthly"], "monthly");
  if (rolling === null || weekly === null || monthly === null) return null;
  return [rolling, weekly, monthly];
}

function hasEntitlementType(value: unknown): boolean {
  if (!isRecord(value)) return value === "EntitlementError";
  return value["type"] === "EntitlementError" || value["name"] === "EntitlementError";
}

async function isEntitlementError(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.clone().json();
    if (!isRecord(body)) return false;
    return hasEntitlementType(body) || hasEntitlementType(body["error"]);
  } catch {
    return false;
  }
}

async function classifyHttpFailure(response: Response): Promise<AdapterOutcome> {
  const statusCode = response.status;
  if (statusCode === 403 && (await isEntitlementError(response))) {
    await response.body?.cancel().catch(() => undefined);
    return { status: "empty", reason: "no-supported-window" };
  }

  await response.body?.cancel().catch(() => undefined);
  if (statusCode === 401) return failed("auth", statusCode);
  if (statusCode === 403) return failed("forbidden", statusCode);
  if (statusCode === 429) return failed("rate_limit", statusCode);
  return failed(statusCode >= 500 ? "upstream_5xx" : "upstream_4xx", statusCode);
}

export async function fetchOpenCodeGoApiKey(
  apiKey: string,
  context: ProviderContext,
): Promise<AdapterOutcome> {
  try {
    const response = await getWithRetry({
      url: USAGE_URL,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      fetchFn: context.fetchFn,
      logLabel: "OpenCode Go usage API",
      isRetryableStatus: (status) => status === 429 || status >= 500,
      perAttemptTimeoutMs: TIMEOUT_MS,
    });

    if (!response.ok) return classifyHttpFailure(response);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return failed("parse");
    }

    const windows = parseUsageWindows(body);
    if (windows === null) return failed("schema");
    const result: ProviderResult = {
      provider: "opencodego",
      sources: [{ id: SOURCE_ID, supportLevel: "official-internal", role: "primary" }],
      windows,
    };
    return { status: "success", result };
  } catch (error) {
    if (error instanceof HttpTransportError) return failed(error.kind);
    throw error;
  }
}
