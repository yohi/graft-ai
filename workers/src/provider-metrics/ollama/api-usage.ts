import { getWithRetry } from "../../http-retry";
import type {
  AdapterOutcome,
  ProviderContext,
  ProviderErrorKind,
  ProviderModelRequest,
  ProviderResult,
  QuotaWindow,
} from "../types";
import { classifyOllamaTransportError } from "./transport-errors";

const USAGE_URL = "https://ollama.com/api/usage";
const SOURCE_ID = "ollama-api-usage";
const TIMEOUT_MS = 10_000;
const MODEL_NAME_PATTERN = /^[A-Za-z0-9._:/-]+$/;
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

type OllamaResult = Extract<ProviderResult, { provider: "ollama_cloud" }>;

interface ParsedLimits {
  readonly windows: QuotaWindow[];
  readonly modelRequests: ProviderModelRequest[];
  readonly contributes: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failed(kind: ProviderErrorKind, statusCode?: number): AdapterOutcome {
  return {
    status: "failed",
    error: {
      kind,
      provider: "ollama_cloud",
      sourceId: SOURCE_ID,
      ...(statusCode === undefined ? {} : { statusCode }),
    },
  };
}

function httpFailureKind(status: number): ProviderErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "upstream_5xx";
  return "upstream_4xx";
}

function parseUsageRatio(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return undefined;
  }
  return value;
}

function isValidModelName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return (
    value === trimmed &&
    trimmed.length >= 1 &&
    trimmed.length <= 128 &&
    MODEL_NAME_PATTERN.test(value)
  );
}

function parseRequestCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

function parseModelRequests(value: unknown, period: "session" | "weekly"): ProviderModelRequest[] {
  if (!Array.isArray(value)) return [];

  const counts = new Map<string, number>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const modelName = entry["name"];
    const requestCount = parseRequestCount(entry["request_count"]);
    if (!isValidModelName(modelName) || requestCount === undefined) continue;
    counts.set(modelName, (counts.get(modelName) ?? 0) + requestCount);
  }

  return [...counts.entries()]
    .filter(([, requestCount]) => Number.isSafeInteger(requestCount))
    .map(([model, requestCount]) => ({ period, model, requestCount }));
}

function parseLimits(value: unknown): ParsedLimits {
  if (!isRecord(value)) return { windows: [], modelRequests: [], contributes: false };

  const windows: QuotaWindow[] = [];
  const modelRequests: ProviderModelRequest[] = [];
  for (const period of ["session", "weekly"] as const) {
    const limit = value[period];
    if (!isRecord(limit)) continue;

    const usageRatio = parseUsageRatio(limit["usage"]);
    if (usageRatio !== undefined) windows.push({ period, usageRatio });
    modelRequests.push(...parseModelRequests(limit["models"], period));
  }

  return {
    windows,
    modelRequests,
    contributes: windows.length > 0 || modelRequests.length > 0,
  };
}

function parseActivityCost(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const cost = value["cost"];
  if (typeof cost !== "string" || !DECIMAL_PATTERN.test(cost)) return undefined;
  const parsed = Number(cost);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseBody(value: unknown): AdapterOutcome {
  if (!isRecord(value)) return failed("schema");

  const limits = parseLimits(value["limits"]);
  const activityCostUSD = parseActivityCost(value["activity"]);
  if (!limits.contributes && activityCostUSD === undefined) return failed("schema");

  const result: OllamaResult = {
    provider: "ollama_cloud",
    sources: [{ id: SOURCE_ID, supportLevel: "official-internal", role: "primary" }],
    windows: limits.windows,
    modelRequests: limits.modelRequests,
    ...(activityCostUSD === undefined ? {} : { activityCostUSD }),
  };
  return { status: "success", result };
}

export async function fetchOllamaApiUsage(
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
      logLabel: "Ollama Cloud usage API",
      isRetryableStatus: (status) => status === 429 || status >= 500,
      perAttemptTimeoutMs: TIMEOUT_MS,
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return failed(httpFailureKind(response.status), response.status);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      const transportKind = classifyOllamaTransportError(error);
      if (transportKind !== undefined) return failed(transportKind);
      if (error instanceof SyntaxError) return failed("parse");
      return failed("internal");
    }
    return parseBody(body);
  } catch (error) {
    const transportKind = classifyOllamaTransportError(error);
    if (transportKind !== undefined) return failed(transportKind);
    return failed("internal");
  }
}

export const fetchOllamaApiKey = fetchOllamaApiUsage;
