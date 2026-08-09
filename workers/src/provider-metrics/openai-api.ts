import type { OpenAIFetchResult, OpenAIMetric, OpenAITokenMetric } from "./types";

const COSTS_URL = "https://api.openai.com/v1/organization/costs";
const COMPLETIONS_URL = "https://api.openai.com/v1/organization/usage/completions";
const MAX_PAGES = 100;
const TIMEOUT_MS = 20000;

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

class OpenAIResponseError extends Error {
  readonly name = "OpenAIResponseError";

  constructor(readonly detail: string) {
    super(`Invalid OpenAI API response: ${detail}`);
  }
}

class InvalidHistoryDaysError extends RangeError {
  readonly name = "InvalidHistoryDaysError";

  constructor(readonly historyDays: number) {
    super(`historyDays must be a positive integer, received ${historyDays}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(detail: string): never {
  throw new OpenAIResponseError(detail);
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
  const response = await client.fetchFn(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${client.apiKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`OpenAI API error: HTTP ${response.status} at ${url}`);
  }

  const body: unknown = await response.json();
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
    if (++pages > MAX_PAGES) throw new Error(`OpenAI API pagination exceeded ${MAX_PAGES} pages`);
    const url = buildUrl(endpoint, window, cursor);
    const page = await fetchPage(url, client, endpoint);
    all.push(...page.data);
    cursor = page.hasMore && page.nextPage ? page.nextPage : undefined;
  } while (cursor);

  return all;
}

export async function fetchOpenAIMetrics(
  apiKey: string,
  historyDays = 1,
  fetchFn: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<OpenAIFetchResult> {
  if (!Number.isInteger(historyDays) || historyDays <= 0) {
    throw new InvalidHistoryDaysError(historyDays);
  }
  // scheduledTime を受け取り、指定した historyDays 分の完全 UTC 日を集計する
  const dayMs = 86400 * 1000;
  const todayUtcMs = Math.floor(nowMs / dayMs) * dayMs;
  const endTime = todayUtcMs / 1000;
  const startTime = endTime - historyDays * 86400;

  const client = { apiKey, fetchFn } as const satisfies OpenAIClient;
  const window = { startTime, endTime } as const satisfies HistoryWindow;
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
  const tokens: OpenAITokenMetric[] = [...tokenMap.values()];

  return { costs, tokens };
}
