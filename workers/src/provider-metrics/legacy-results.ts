import type {
  CodexFetchResult,
  OpenAIFetchResult,
  OpenCodeGoFetchResult,
  OllamaFetchResult,
  ProviderResult,
  QuotaPeriod,
  QuotaWindow,
} from "./types";

export interface LegacyProviderResults {
  readonly openai?: OpenAIFetchResult;
  readonly codex?: CodexFetchResult;
  readonly openCodeGo?: OpenCodeGoFetchResult;
  readonly ollama?: OllamaFetchResult;
}

function quotaWindow(
  period: QuotaPeriod,
  usageRatio: number | undefined,
  resetTimestampSeconds: number | undefined,
): QuotaWindow | undefined {
  if (usageRatio === undefined && resetTimestampSeconds === undefined) return undefined;
  return {
    period,
    ...(usageRatio === undefined ? {} : { usageRatio }),
    ...(resetTimestampSeconds === undefined ? {} : { resetTimestampSeconds }),
  };
}

function presentWindows(windows: readonly (QuotaWindow | undefined)[]): QuotaWindow[] {
  return windows.filter((window): window is QuotaWindow => window !== undefined);
}

function appendOpenAIResult(results: ProviderResult[], value: OpenAIFetchResult): void {
  if (value.costs.length === 0 && value.tokens.length === 0) return;
  results.push({
    provider: "openai_api",
    sources: [],
    windows: [],
    costs: value.costs,
    modelUsage: value.tokens,
  });
}

function appendCodexResult(results: ProviderResult[], value: CodexFetchResult): void {
  const credits =
    value.creditsRemaining === null && value.resetCredits === undefined
      ? undefined
      : {
          ...(value.creditsRemaining === null ? {} : { remaining: value.creditsRemaining }),
          ...(value.resetCredits === undefined
            ? {}
            : {
                resetCredits: value.resetCredits.credits,
                resetCreditsAvailableCount: value.resetCredits.availableCount,
              }),
        };
  results.push({
    provider: "codex",
    sources: [],
    windows: presentWindows([
      quotaWindow("session", value.sessionUsageRatio, value.sessionResetTimestampSeconds),
      quotaWindow("weekly", value.weeklyUsageRatio, value.weeklyResetTimestampSeconds),
    ]),
    plan: value.plan,
    ...(credits === undefined ? {} : { credits }),
  });
}

function appendOpenCodeGoResult(
  results: ProviderResult[],
  value: OpenCodeGoFetchResult,
  nowSeconds: number,
): void {
  results.push({
    provider: "opencodego",
    sources: [],
    windows: presentWindows([
      quotaWindow(
        "rolling",
        value.rollingUsageRatio,
        value.rollingResetSeconds === undefined
          ? undefined
          : nowSeconds + value.rollingResetSeconds,
      ),
      quotaWindow(
        "weekly",
        value.weeklyUsageRatio,
        value.weeklyResetSeconds === undefined ? undefined : nowSeconds + value.weeklyResetSeconds,
      ),
      quotaWindow(
        "monthly",
        value.monthlyUsageRatio,
        value.monthlyResetSeconds === undefined
          ? undefined
          : nowSeconds + value.monthlyResetSeconds,
      ),
    ]),
    ...(value.zenBalanceUSD === null ? {} : { zenBalanceUSD: value.zenBalanceUSD }),
  });
}

function appendOllamaResult(results: ProviderResult[], value: OllamaFetchResult): void {
  results.push({
    provider: "ollama_cloud",
    sources: [],
    windows: presentWindows([
      quotaWindow("session", value.sessionUsageRatio, value.sessionResetTimestampSeconds),
      quotaWindow("weekly", value.weeklyUsageRatio, value.weeklyResetTimestampSeconds),
    ]),
    modelRequests: [],
    ...(value.plan === undefined ? {} : { plan: value.plan }),
  });
}

export function toProviderResults(
  legacy: LegacyProviderResults,
  nowSeconds: number,
): ProviderResult[] {
  const results: ProviderResult[] = [];
  if (legacy.openai !== undefined) appendOpenAIResult(results, legacy.openai);
  if (legacy.codex !== undefined) appendCodexResult(results, legacy.codex);
  if (legacy.openCodeGo !== undefined) {
    appendOpenCodeGoResult(results, legacy.openCodeGo, nowSeconds);
  }
  if (legacy.ollama !== undefined) appendOllamaResult(results, legacy.ollama);
  return results;
}
