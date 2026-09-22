import { getWithRetry, HttpTransportError } from "../http-retry";
import type {
  AdapterOutcome,
  OpenAIMetric,
  OpenAITokenMetric,
  ProviderAdapter,
  ProviderContext,
  ProviderErrorKind,
  ProviderMetricsEnv,
  ProviderResult,
  ProviderSource,
} from "./types";

const COSTS_URL = "https://api.openai.com/v1/organization/costs";
const COMPLETIONS_URL = "https://api.openai.com/v1/organization/usage/completions";
const MAX_PAGES = 100;
const TIMEOUT_MS = 20000;
const DAY_SECONDS = 86400;
const SOURCE_ID = "openai-organization-api";

const PRIMARY_SOURCE = {
  id: SOURCE_ID,
  supportLevel: "official-public",
  role: "primary",
} as const satisfies ProviderSource;

type CostBucket = {
  readonly results: readonly OpenAIMetric[];
};

type CompletionBucket = {
  readonly results: readonly OpenAITokenMetric[];
};

type PageResponse<T> = {
  readonly data: readonly T[];
  readonly hasMore: boolean;
  readonly nextPage: string | null;
};

type EndpointLocation = {
  readonly baseUrl: string;
  readonly groupBy: string;
};

type PageEndpoint<T> = EndpointLocation & {
  readonly parseBucket: (value: unknown, path: string) => T;
};

type OpenAIClient = {
  readonly apiKey: string;
  readonly fetchFn: typeof fetch;
};

type HistoryWindow = {
  readonly startTime: number;
  readonly endTime: number;
};

type OpenAIResult = Extract<ProviderResult, { provider: "openai_api" }>;
type OpenAIResponseFailureKind = Extract<ProviderErrorKind, "schema" | "parse">;

class OpenAIResponseError extends Error {
  readonly name = "OpenAIResponseError";

  constructor(
    readonly kind: OpenAIResponseFailureKind,
    detail: string,
  ) {
    super(`Invalid OpenAI API response: ${detail}`);
  }
}

class OpenAIHttpError extends Error {
  readonly name = "OpenAIHttpError";

  constructor(readonly statusCode: number) {
    super("OpenAI API request failed");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(detail: string): never {
  throw new OpenAIResponseError("schema", detail);
}

function parseFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidResponse(`${path} must be a finite number`);
  }
  return value;
}

function parseOptionalNumber(record: Record<string, unknown>, key: string, path: string): number {
  const value = record[key];
  return value === undefined ? 0 : parseFiniteNumber(value, `${path}.${key}`);
}

function parseOptionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    invalidResponse(`${path}.${key} must be a string`);
  }
  return value;
}

function parseCostBucket(value: unknown, path: string): CostBucket {
  if (!isRecord(value) || !Array.isArray(value["results"])) {
    invalidResponse(`${path}.results must be an array`);
  }
  const results = value["results"].map((result, index): OpenAIMetric => {
    const resultPath = `${path}.results[${index}]`;
    if (!isRecord(result)) invalidResponse(`${resultPath} must be an object`);
    const amount = result["amount"];
    if (amount !== undefined && !isRecord(amount)) {
      invalidResponse(`${resultPath}.amount must be an object`);
    }
    return {
      lineItem: parseOptionalString(result, "line_item", resultPath) ?? "Unknown",
      costUSD:
        amount === undefined ? 0 : parseFiniteNumber(amount["value"], `${resultPath}.amount.value`),
    };
  });
  return { results };
}

function parseCompletionBucket(value: unknown, path: string): CompletionBucket {
  if (!isRecord(value) || !Array.isArray(value["results"])) {
    invalidResponse(`${path}.results must be an array`);
  }
  const results = value["results"].map((result, index): OpenAITokenMetric => {
    const resultPath = `${path}.results[${index}]`;
    if (!isRecord(result)) invalidResponse(`${resultPath} must be an object`);
    return {
      model: parseOptionalString(result, "model", resultPath) ?? "unknown",
      inputTokens:
        parseOptionalNumber(result, "input_tokens", resultPath) +
        parseOptionalNumber(result, "input_audio_tokens", resultPath),
      outputTokens:
        parseOptionalNumber(result, "output_tokens", resultPath) +
        parseOptionalNumber(result, "output_audio_tokens", resultPath),
      cachedTokens: parseOptionalNumber(result, "input_cached_tokens", resultPath),
      requests: parseOptionalNumber(result, "num_model_requests", resultPath),
    };
  });
  return { results };
}

function parsePage<T>(value: unknown, endpoint: PageEndpoint<T>): PageResponse<T> {
  if (!isRecord(value) || !Array.isArray(value["data"])) {
    invalidResponse("data must be an array");
  }
  const hasMore = value["has_more"];
  if (typeof hasMore !== "boolean") invalidResponse("has_more must be a boolean");
  const nextPage = value["next_page"];
  if (nextPage !== null && typeof nextPage !== "string") {
    invalidResponse("next_page must be a string or null");
  }
  if (hasMore && (nextPage === null || nextPage.length === 0)) {
    invalidResponse("next_page must be a non-empty string when has_more is true");
  }
  return {
    data: value["data"].map((bucket, index) => endpoint.parseBucket(bucket, `data[${index}]`)),
    hasMore,
    nextPage,
  };
}

const COSTS_ENDPOINT = {
  baseUrl: COSTS_URL,
  groupBy: "line_item",
  parseBucket: parseCostBucket,
} as const satisfies PageEndpoint<CostBucket>;

const COMPLETIONS_ENDPOINT = {
  baseUrl: COMPLETIONS_URL,
  groupBy: "model",
  parseBucket: parseCompletionBucket,
} as const satisfies PageEndpoint<CompletionBucket>;

async function fetchPage<T>(
  url: string,
  client: OpenAIClient,
  endpoint: PageEndpoint<T>,
): Promise<PageResponse<T>> {
  const response = await getWithRetry({
    url,
    headers: {
      Authorization: `Bearer ${client.apiKey}`,
      Accept: "application/json",
    },
    fetchFn: client.fetchFn,
    logLabel: "OpenAI API fetch",
    isRetryableStatus: (status) => status === 429 || status >= 500,
    perAttemptTimeoutMs: TIMEOUT_MS,
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new OpenAIHttpError(response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new OpenAIResponseError("parse", "response body was not valid JSON");
    }
    throw error;
  }
  return parsePage(body, endpoint);
}

function buildUrl(endpoint: EndpointLocation, window: HistoryWindow, page?: string): string {
  const params = new URLSearchParams({
    start_time: String(window.startTime),
    end_time: String(window.endTime),
    bucket_width: "1d",
    limit: "31",
    group_by: endpoint.groupBy,
  });
  if (page) params.set("page", page);
  return `${endpoint.baseUrl}?${params.toString()}`;
}

async function fetchAllPages<T>(
  endpoint: PageEndpoint<T>,
  client: OpenAIClient,
  window: HistoryWindow,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    if (++pages > MAX_PAGES) {
      throw new OpenAIResponseError("schema", `pagination exceeded ${MAX_PAGES} pages`);
    }
    const url = buildUrl(endpoint, window, cursor);
    const page = await fetchPage(url, client, endpoint);
    all.push(...page.data);
    cursor = page.hasMore && page.nextPage ? page.nextPage : undefined;
  } while (cursor);

  return all;
}

function httpFailureKind(status: number): ProviderErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "upstream_5xx";
  return "upstream_4xx";
}

function failed(kind: ProviderErrorKind, statusCode?: number): AdapterOutcome {
  return {
    status: "failed",
    error: {
      kind,
      provider: "openai_api",
      sourceId: SOURCE_ID,
      ...(statusCode === undefined ? {} : { statusCode }),
    },
  };
}

function failureKind(error: unknown): ProviderErrorKind {
  if (error instanceof HttpTransportError) return error.kind;
  if (error instanceof OpenAIResponseError) return error.kind;
  if (error instanceof SyntaxError) return "parse";
  return "internal";
}

export async function fetchOpenAIMetrics(
  env: ProviderMetricsEnv,
  ctx: ProviderContext,
): Promise<AdapterOutcome> {
  try {
    const dayEnd = Math.floor(ctx.scheduledTimeSeconds / DAY_SECONDS) * DAY_SECONDS;
    const window = {
      startTime: dayEnd - ctx.openaiHistoryDays * DAY_SECONDS,
      endTime: dayEnd,
    } as const satisfies HistoryWindow;
    const client = {
      apiKey: env.OPENAI_ADMIN_API_KEY ?? "",
      fetchFn: ctx.fetchFn,
    } as const satisfies OpenAIClient;
    const [costBuckets, completionBuckets] = await Promise.all([
      fetchAllPages(COSTS_ENDPOINT, client, window),
      fetchAllPages(COMPLETIONS_ENDPOINT, client, window),
    ]);

    const costMap = new Map<string, number>();
    for (const bucket of costBuckets) {
      for (const r of bucket.results) {
        costMap.set(r.lineItem, (costMap.get(r.lineItem) ?? 0) + r.costUSD);
      }
    }
    const costs: OpenAIMetric[] = [...costMap.entries()].map(([lineItem, costUSD]) => ({
      lineItem,
      costUSD,
    }));

    const tokenMap = new Map<string, OpenAITokenMetric>();
    for (const bucket of completionBuckets) {
      for (const r of bucket.results) {
        const existing = tokenMap.get(r.model) ?? {
          model: r.model,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          requests: 0,
        };
        tokenMap.set(r.model, {
          model: r.model,
          inputTokens: existing.inputTokens + r.inputTokens,
          outputTokens: existing.outputTokens + r.outputTokens,
          cachedTokens: existing.cachedTokens + r.cachedTokens,
          requests: existing.requests + r.requests,
        });
      }
    }
    const modelUsage: OpenAITokenMetric[] = [...tokenMap.values()];
    const result: OpenAIResult = {
      provider: "openai_api",
      sources: [PRIMARY_SOURCE],
      windows: [],
      costs,
      modelUsage,
    };
    return { status: "success", result };
  } catch (error) {
    if (error instanceof OpenAIHttpError) {
      return failed(httpFailureKind(error.statusCode), error.statusCode);
    }
    return failed(failureKind(error));
  }
}

export const openaiAdapter: ProviderAdapter = fetchOpenAIMetrics;
