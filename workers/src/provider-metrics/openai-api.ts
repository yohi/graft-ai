import type { OpenAIFetchResult, OpenAIMetric, OpenAITokenMetric } from "./types";

const COSTS_URL = "https://api.openai.com/v1/organization/costs";
const COMPLETIONS_URL = "https://api.openai.com/v1/organization/usage/completions";
const MAX_PAGES = 100;
const TIMEOUT_MS = 20000;

interface CostBucket {
  start_time: number;
  end_time: number;
  results: Array<{
    amount?: { value: number; currency: string };
    line_item?: string;
  }>;
}

interface CompletionBucket {
  start_time: number;
  end_time: number;
  results: Array<{
    model?: string;
    num_model_requests?: number;
    input_tokens?: number;
    input_cached_tokens?: number;
    output_tokens?: number;
    input_audio_tokens?: number;
    output_audio_tokens?: number;
  }>;
}

interface PageResponse<T> {
  data: T[];
  has_more: boolean;
  next_page: string | null;
}

async function fetchPage<T>(
  url: string,
  apiKey: string,
  fetchFn: typeof fetch,
): Promise<PageResponse<T>> {
  const response = await fetchFn(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`OpenAI API error: HTTP ${response.status} at ${url}`);
  }

  return response.json() as Promise<PageResponse<T>>;
}

function buildUrl(
  base: string,
  startTime: number,
  endTime: number,
  groupBy: string,
  page?: string,
): string {
  const params = new URLSearchParams({
    start_time: String(startTime),
    end_time: String(endTime),
    bucket_width: "1d",
    limit: "31",
    group_by: groupBy,
  });
  if (page) params.set("page", page);
  return `${base}?${params.toString()}`;
}

async function fetchAllPages<T>(
  baseUrl: string,
  groupBy: string,
  apiKey: string,
  startTime: number,
  endTime: number,
  fetchFn: typeof fetch,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    if (++pages > MAX_PAGES) throw new Error(`OpenAI API pagination exceeded ${MAX_PAGES} pages`);
    const url = buildUrl(baseUrl, startTime, endTime, groupBy, cursor);
    const page = await fetchPage<T>(url, apiKey, fetchFn);
    all.push(...page.data);
    cursor = page.has_more && page.next_page ? page.next_page : undefined;
  } while (cursor);

  return all;
}

export async function fetchOpenAIMetrics(
  apiKey: string,
  historyDays = 1,
  fetchFn: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<OpenAIFetchResult> {
  // scheduledTime を受け取り、指定した historyDays 分の完全 UTC 日を集計する
  const dayMs = 86400 * 1000;
  const todayUtcMs = Math.floor(nowMs / dayMs) * dayMs;
  const endTime = todayUtcMs / 1000;
  const startTime = endTime - historyDays * 86400;

  const [costBuckets, completionBuckets] = await Promise.all([
    fetchAllPages<CostBucket>(COSTS_URL, "line_item", apiKey, startTime, endTime, fetchFn),
    fetchAllPages<CompletionBucket>(COMPLETIONS_URL, "model", apiKey, startTime, endTime, fetchFn),
  ]);

  const costMap = new Map<string, number>();
  for (const bucket of costBuckets) {
    for (const r of bucket.results) {
      const lineItem = r.line_item ?? "Unknown";
      costMap.set(lineItem, (costMap.get(lineItem) ?? 0) + (r.amount?.value ?? 0));
    }
  }
  const costs: OpenAIMetric[] = [...costMap.entries()].map(([lineItem, costUSD]) => ({
    lineItem,
    costUSD,
  }));

  const tokenMap = new Map<string, OpenAITokenMetric>();
  for (const bucket of completionBuckets) {
    for (const r of bucket.results) {
      const model = r.model ?? "unknown";
      const existing = tokenMap.get(model) ?? {
        model,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        requests: 0,
      };
      tokenMap.set(model, {
        model,
        inputTokens: existing.inputTokens + (r.input_tokens ?? 0) + (r.input_audio_tokens ?? 0),
        outputTokens: existing.outputTokens + (r.output_tokens ?? 0) + (r.output_audio_tokens ?? 0),
        cachedTokens: existing.cachedTokens + (r.input_cached_tokens ?? 0),
        requests: existing.requests + (r.num_model_requests ?? 0),
      });
    }
  }
  const tokens: OpenAITokenMetric[] = [...tokenMap.values()];

  return { costs, tokens };
}
