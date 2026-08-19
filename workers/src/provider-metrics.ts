import { fetchCodexMetrics } from "./provider-metrics/codex";
import { fetchOpenAIMetrics } from "./provider-metrics/openai-api";
import { fetchOpenCodeGoMetrics } from "./provider-metrics/opencodego";
import { pushProviderMetrics } from "./provider-metrics/prometheus";
import type { ProviderMetricsEnv } from "./provider-metrics/types";

export interface ProviderMetricsWorker {
  scheduled(event: ScheduledEvent, env: ProviderMetricsEnv, ctx: ExecutionContext): Promise<void>;
  fetch?(request: Request, env: ProviderMetricsEnv, ctx: ExecutionContext): Promise<Response>;
}

export interface ProviderDiagnosticReport {
  timestamp: string;
  providers: {
    openai: {
      status: "skipped" | "success" | "failed";
      error?: string;
      count?: { costs: number; tokens: number };
    };
    codex: { status: "skipped" | "success" | "failed"; error?: string; plan?: string };
    openCodeGo: {
      status: "skipped" | "success" | "failed";
      error?: string;
      rollingUsageRatio?: number;
      zenBalanceUSD?: number | null;
    };
  };
  prometheusPush: { status: "skipped" | "success" | "failed"; statusCode?: number };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function collectAndPushProviderMetrics(
  env: ProviderMetricsEnv,
  scheduledTime: number = Date.now(),
): Promise<ProviderDiagnosticReport> {
  const report: ProviderDiagnosticReport = {
    timestamp: new Date(scheduledTime).toISOString(),
    providers: {
      openai: { status: "skipped" },
      codex: { status: "skipped" },
      openCodeGo: { status: "skipped" },
    },
    prometheusPush: { status: "skipped" },
  };

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
      ? fetchOpenAIMetrics(openAiApiKey, historyDays, fetch, scheduledTime)
      : Promise.resolve(null),
    codexAccessToken !== undefined && codexAccessToken !== ""
      ? fetchCodexMetrics(
          codexAccessToken,
          env.CODEX_ACCOUNT_ID,
          fetch,
          env.CODEX_PROXY_URL || env.CODEX_API_BASE_URL,
          env.MYBROWSER,
        )
      : Promise.resolve(null),
    openCodeGoSessionCookie !== undefined && openCodeGoSessionCookie !== ""
      ? fetchOpenCodeGoMetrics(openCodeGoSessionCookie, env.OPENCODEGO_WORKSPACE_ID)
      : Promise.resolve(null),
  ] as const);

  let openaiResult = null;
  if (openai.status === "fulfilled") {
    openaiResult = openai.value;
    if (openaiResult !== null) {
      report.providers.openai = {
        status: "success",
        count: { costs: openaiResult.costs.length, tokens: openaiResult.tokens.length },
      };
    }
  } else {
    const err = errorMessage(openai.reason);
    console.error(`Provider metrics: OpenAI API fetch failed: ${err}`);
    report.providers.openai = { status: "failed", error: err };
  }

  let codexResult = null;
  if (codex.status === "fulfilled") {
    codexResult = codex.value;
    if (codexResult !== null) {
      report.providers.codex = { status: "success", plan: codexResult.plan };
    }
  } else {
    const err = errorMessage(codex.reason);
    console.error(`Provider metrics: Codex fetch failed: ${err}`);
    report.providers.codex = { status: "failed", error: err };
  }

  let openCodeGoResult = null;
  if (openCodeGo.status === "fulfilled") {
    openCodeGoResult = openCodeGo.value;
    if (openCodeGoResult !== null) {
      report.providers.openCodeGo = {
        status: "success",
        rollingUsageRatio: openCodeGoResult.rollingUsageRatio,
        zenBalanceUSD: openCodeGoResult.zenBalanceUSD,
      };
    }
  } else {
    const err = errorMessage(openCodeGo.reason);
    console.error(`Provider metrics: OpenCodeGo fetch failed: ${err}`);
    report.providers.openCodeGo = { status: "failed", error: err };
  }

  const hasOpenAIMetrics =
    openaiResult !== null && (openaiResult.costs.length > 0 || openaiResult.tokens.length > 0);
  const hasMetrics = hasOpenAIMetrics || codexResult !== null || openCodeGoResult !== null;

  if (!hasMetrics) {
    console.error("Provider metrics: No metrics to push (all providers skipped, failed, or empty)");
    return report;
  }

  const pushResult = await pushProviderMetrics(env, {
    ...(hasOpenAIMetrics && openaiResult !== null ? { openai: openaiResult } : {}),
    ...(codexResult === null ? {} : { codex: codexResult }),
    ...(openCodeGoResult === null ? {} : { openCodeGo: openCodeGoResult }),
  });

  if (pushResult.ok) {
    report.prometheusPush = { status: "success", statusCode: pushResult.status };
  } else {
    console.error(`Provider metrics: Prometheus push failed: status=${pushResult.status}`);
    report.prometheusPush = { status: "failed", statusCode: pushResult.status };
  }

  return report;
}

const worker: ProviderMetricsWorker = {
  async scheduled(event, env, _ctx) {
    await collectAndPushProviderMetrics(env, event.scheduledTime);
  },
  async fetch(_request, env, _ctx) {
    const report = await collectAndPushProviderMetrics(env, Date.now());
    return new Response(JSON.stringify(report, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  },
};

export default worker;
