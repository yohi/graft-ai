import { fetchCodexMetrics } from "./provider-metrics/codex";
import { fetchOpenAIMetrics } from "./provider-metrics/openai-api";
import { fetchOpenCodeGoMetrics } from "./provider-metrics/opencodego";
import { pushProviderMetrics } from "./provider-metrics/prometheus";
import type { ProviderMetricsEnv } from "./provider-metrics/types";

export interface ProviderMetricsWorker {
  scheduled(event: ScheduledEvent, env: ProviderMetricsEnv, ctx: ExecutionContext): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settledValue<T>(provider: string, result: PromiseSettledResult<T>): T | null {
  switch (result.status) {
    case "fulfilled":
      return result.value;
    case "rejected":
      console.error(`Provider metrics: ${provider} fetch failed: ${errorMessage(result.reason)}`);
      return null;
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

const worker: ProviderMetricsWorker = {
  async scheduled(event, env, _ctx) {
    const rawHistoryDays = env.OPENAI_API_HISTORY_DAYS;
    const candidateHistoryDays = rawHistoryDays === undefined ? 1 : Number(rawHistoryDays);
    const historyDays =
      Number.isInteger(candidateHistoryDays) &&
      candidateHistoryDays >= 1 &&
      candidateHistoryDays <= 31
        ? candidateHistoryDays
        : undefined;

    if (rawHistoryDays !== undefined && historyDays === undefined) {
      console.error(
        `Provider metrics: OPENAI_API_HISTORY_DAYS="${rawHistoryDays}" は無効です。1 から 31 の整数が必要です。OpenAI fetch をスキップします。`,
      );
    }

    const openAiApiKey = env.OPENAI_ADMIN_API_KEY?.trim();
    const codexAccessToken = env.CODEX_ACCESS_TOKEN?.trim();
    const openCodeGoSessionCookie = env.OPENCODEGO_SESSION_COOKIE?.trim();

    const [openai, codex, openCodeGo] = await Promise.allSettled([
      openAiApiKey !== undefined && openAiApiKey !== "" && historyDays !== undefined
        ? fetchOpenAIMetrics(openAiApiKey, historyDays, fetch, event.scheduledTime)
        : Promise.resolve(null),
      codexAccessToken !== undefined && codexAccessToken !== ""
        ? fetchCodexMetrics(codexAccessToken, env.CODEX_ACCOUNT_ID)
        : Promise.resolve(null),
      openCodeGoSessionCookie !== undefined && openCodeGoSessionCookie !== ""
        ? fetchOpenCodeGoMetrics(openCodeGoSessionCookie, env.OPENCODEGO_WORKSPACE_ID)
        : Promise.resolve(null),
    ] as const);

    const openaiResult = settledValue("OpenAI API", openai);
    const codexResult = settledValue("Codex", codex);
    const openCodeGoResult = settledValue("OpenCodeGo", openCodeGo);
    const hasOpenAIMetrics =
      openaiResult !== null && (openaiResult.costs.length > 0 || openaiResult.tokens.length > 0);
    const hasMetrics = hasOpenAIMetrics || codexResult !== null || openCodeGoResult !== null;

    if (!hasMetrics) {
      console.error(
        "Provider metrics: No metrics to push (all providers skipped, failed, or empty)",
      );
      return;
    }

    const pushResult = await pushProviderMetrics(env, {
      ...(hasOpenAIMetrics ? { openai: openaiResult } : {}),
      ...(codexResult === null ? {} : { codex: codexResult }),
      ...(openCodeGoResult === null ? {} : { openCodeGo: openCodeGoResult }),
    });
    if (!pushResult.ok) {
      console.error(`Provider metrics: Prometheus push failed: status=${pushResult.status}`);
    }
  },
};

export default worker;
