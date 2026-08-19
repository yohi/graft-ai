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
  CODEX_API_BASE_URL?: string; // optional custom base URL (default: https://chatgpt.com)

  // OpenCodeGo
  OPENCODEGO_SESSION_COOKIE?: string;
  OPENCODEGO_WORKSPACE_ID?: string; // optional override, fetched if missing

  // Cloudflare Browser Rendering (Headless Chromium)
  MYBROWSER?: Fetcher;
}

/** OpenAI API fetcher の結果 */
export interface OpenAIMetric {
  /** line_item ラベル値（costs エンドポイント由来） */
  lineItem: string;
  /** OPENAI_API_HISTORY_DAYS で指定した UTC 日数分のコスト USD */
  costUSD: number;
}

export interface OpenAITokenMetric {
  /** model ラベル値（completions エンドポイント由来） */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  requests: number;
}

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
  /** ローリングリセット残秒 */
  rollingResetSeconds: number;
  /** 週次リセット残秒（レスポンスにウィンドウがない場合は undefined） */
  weeklyResetSeconds?: number;
  /** 月次リセット残秒（レスポンスにウィンドウがない場合は undefined） */
  monthlyResetSeconds?: number;
  /** Zen クレジット残高 USD（取得できない場合は null） */
  zenBalanceUSD: number | null;
}
