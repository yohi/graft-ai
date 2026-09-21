// workers/src/provider-metrics/types.ts

export interface ProviderMetricsEnv {
  // Grafana Cloud Prometheus (shared with OllamaCloudEnv pattern)
  GRAFANA_CLOUD_PROMETHEUS_URL: string;
  GRAFANA_CLOUD_PROMETHEUS_USERNAME: string;
  GRAFANA_CLOUD_ACCESS_POLICY_TOKEN: string;

  // OpenAI API
  OPENAI_ADMIN_API_KEY?: string;
  OPENAI_API_HISTORY_DAYS?: string; // デフォルト "1"

  // Codex OAuth
  CODEX_ACCESS_TOKEN?: string;
  CODEX_ACCOUNT_ID?: string; // optional workspace account id
  CODEX_PROXY_URL?: string; // optional residential/forward proxy URL
  CODEX_PROXY_SECRET?: string; // optional shared secret for residential proxy auth
  CODEX_API_BASE_URL?: string; // optional custom base URL (default: https://chatgpt.com)

  // OpenCodeGo
  OPENCODEGO_API_KEY?: string;
  OPENCODEGO_SESSION_COOKIE?: string;
  OPENCODEGO_WORKSPACE_ID?: string; // optional override, fetched if missing

  // Ollama Cloud
  OLLAMA_API_KEY?: string;
  OLLAMA_SESSION_COOKIE?: string;

  COMMAND_CODE_API_KEY?: string;

  // Cloudflare Browser Rendering (Headless Chromium)
  MYBROWSER?: Fetcher;
}

export type ProviderId =
  | "openai_api"
  | "codex"
  | "opencodego"
  | "ollama_cloud"
  | "commandcode";

export type SupportLevel = "official-public" | "official-internal" | "web-internal" | "scraping";
export type SourceRole = "primary" | "enrichment" | "fallback";
export type QuotaPeriod = "session" | "weekly" | "monthly" | "rolling";

export interface ProviderSource {
  id: string;
  supportLevel: SupportLevel;
  role: SourceRole;
}

export interface QuotaWindow {
  period: QuotaPeriod;
  rawPeriod?: string;
  usageRatio?: number;
  used?: number;
  limit?: number;
  resetTimestampSeconds?: number;
  exceeded?: boolean;
}

export interface ProviderCredits {
  remaining?: number;
  monthly?: number;
  purchased?: number;
  free?: number;
  resetCredits?: number;
  resetCreditsAvailableCount?: number;
}

export interface ProviderSubscription {
  status?: string;
  billingPeriodEndSeconds?: number;
}

export interface ProviderUsageSummary {
  costUSD?: number;
  requests?: number;
  tokens?: number;
}

export interface OpenAICostMetric {
  /** line_item ラベル値（costs エンドポイント由来） */
  lineItem: string;
  /** OPENAI_API_HISTORY_DAYS で指定した UTC 日数分のコスト USD */
  costUSD: number;
}

export interface ProviderModelUsage {
  /** model ラベル値（completions エンドポイント由来） */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  requests: number;
}

export interface ProviderModelRequest {
  period: "session" | "weekly";
  model: string;
  requestCount: number;
}

export interface ProviderResultBase<P extends ProviderId> {
  provider: P;
  sources: ProviderSource[];
  windows: QuotaWindow[];
}

export type ProviderResult =
  | (ProviderResultBase<"openai_api"> & {
      costs: OpenAICostMetric[];
      modelUsage: ProviderModelUsage[];
    })
  | (ProviderResultBase<"codex"> & {
      plan?: string;
      credits?: ProviderCredits;
    })
  | (ProviderResultBase<"opencodego"> & {
      zenBalanceUSD?: number;
    })
  | (ProviderResultBase<"ollama_cloud"> & {
      plan?: string;
      modelRequests: ProviderModelRequest[];
      activityCostUSD?: number;
    })
  | (ProviderResultBase<"commandcode"> & {
      plan?: string;
      subscription?: ProviderSubscription;
      credits?: ProviderCredits;
      usage?: ProviderUsageSummary;
    });

export interface ProviderContext {
  fetchFn: typeof fetch;
  scheduledTimeSeconds: number;
  openaiHistoryDays: number;
  nowSeconds: () => number;
  monotonicNowMs: () => number;
  browserBinding?: Fetcher;
}

export type AdapterOutcome =
  | { status: "success"; result: ProviderResult }
  | { status: "empty"; reason: "no-supported-window" | "no-activity" }
  | { status: "failed"; error: ProviderError };

export type ProviderAdapter = (
  env: ProviderMetricsEnv,
  ctx: ProviderContext,
) => Promise<AdapterOutcome>;

export type ProviderErrorKind =
  | "auth"
  | "forbidden"
  | "upstream_4xx"
  | "rate_limit"
  | "upstream_5xx"
  | "network"
  | "timeout"
  | "schema"
  | "parse"
  | "internal";

export interface ProviderError {
  kind: ProviderErrorKind;
  provider: ProviderId;
  sourceId: string;
  statusCode?: number;
}

export type OpenAIMetric = OpenAICostMetric;
export type OpenAITokenMetric = ProviderModelUsage;

export interface OpenAIFetchResult {
  costs: OpenAIMetric[];
  tokens: OpenAITokenMetric[];
}

/** Codex fetcher の結果 */
export interface CodexFetchResult {
  /** セッション(5h)使用率 0.0–1.0（レスポンスにウィンドウがない場合は undefined） */
  sessionUsageRatio?: number;
  /** 週次使用率 0.0–1.0（レスポンスにウィンドウがない場合は undefined） */
  weeklyUsageRatio?: number;
  /** セッションリセット Unix 秒（レスポンスにウィンドウがない場合は undefined） */
  sessionResetTimestampSeconds?: number;
  /** 週次リセット Unix 秒（レスポンスにウィンドウがない場合は undefined） */
  weeklyResetTimestampSeconds?: number;
  /** クレジット残高（取得できない場合は null） */
  creditsRemaining: number | null;
  /** リセットクレジット（補助エンドポイントが利用できない場合は undefined） */
  resetCredits?: {
    credits: number;
    availableCount: number;
  };
  /** プラン名 */
  plan: string;
}

/** OpenCodeGo fetcher の結果 */
export interface OpenCodeGoFetchResult {
  /** ローリング(5h)使用率 0.0–1.0 */
  rollingUsageRatio: number;
  /** 週次使用率 0.0–1.0（レスポンスにウィンドウがない場合は undefined） */
  weeklyUsageRatio?: number;
  /** 月次使用率 0.0–1.0（レスポンスにウィンドウがない場合は undefined） */
  monthlyUsageRatio?: number;
  /** ローリングリセット残秒（月間枠上限時は undefined） */
  rollingResetSeconds?: number;
  /** 週次リセット残秒（レスポンスにウィンドウがない場合は undefined） */
  weeklyResetSeconds?: number;
  /** 月次リセット残秒（レスポンスにウィンドウがない場合は undefined） */
  monthlyResetSeconds?: number;
  /** Zen クレジット残高 USD（取得できない場合は null） */
  zenBalanceUSD: number | null;
}

/** Ollama Cloud fetcher の結果 */
export interface OllamaFetchResult {
  /** セッション使用率 0.0–1.0（取得できない場合は undefined） */
  sessionUsageRatio?: number;
  /** 週次使用率 0.0–1.0（取得できない場合は undefined） */
  weeklyUsageRatio?: number;
  /** セッションリセット Unix 秒（取得できない場合は undefined） */
  sessionResetTimestampSeconds?: number;
  /** 週次リセット Unix 秒（取得できない場合は undefined） */
  weeklyResetTimestampSeconds?: number;
  /** プラン名（Free / Pro / Max 等） */
  plan?: string;
  /** アカウント Email */
  email?: string;
}
