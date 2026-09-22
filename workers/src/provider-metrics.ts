import { codexAdapter } from "./provider-metrics/codex";
import { fetchOllamaMetrics, ollamaAdapter } from "./provider-metrics/ollama/index";
import { openaiAdapter } from "./provider-metrics/openai-api";
import { fetchOpenCodeGoMetrics } from "./provider-metrics/opencodego";
import { toProviderResults } from "./provider-metrics/legacy-results";
import { pushProviderMetrics } from "./provider-metrics/prometheus";
import type {
  AdapterOutcome,
  OllamaFetchResult,
  ProviderContext,
  ProviderError,
  ProviderMetricsEnv,
  ProviderResult,
} from "./provider-metrics/types";

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
    ollama?: {
      status: "skipped" | "success" | "failed";
      error?: string;
      sessionUsageRatio?: number;
      weeklyUsageRatio?: number;
      plan?: string;
    };
  };
  prometheusPush: { status: "skipped" | "success" | "failed"; statusCode?: number };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function adapterErrorMessage(error: ProviderError): string {
  return error.statusCode === undefined ? error.kind : `${error.kind} (${error.statusCode})`;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected provider adapter outcome: ${String(value)}`);
}

type OpenAIProviderResult = Extract<ProviderResult, { provider: "openai_api" }>;
type CodexProviderResult = Extract<ProviderResult, { provider: "codex" }>;
type OllamaProviderResult = Extract<ProviderResult, { provider: "ollama_cloud" }>;
type OllamaCollectionResult = AdapterOutcome | OllamaFetchResult | null;

function createProviderContext(
  env: ProviderMetricsEnv,
  scheduledTime: number,
  openaiHistoryDays: number,
): ProviderContext {
  return {
    fetchFn: fetch,
    scheduledTimeSeconds: Math.floor(scheduledTime / 1_000),
    openaiHistoryDays,
    nowSeconds: () => Math.floor(Date.now() / 1_000),
    monotonicNowMs: () => performance.now(),
    ...(env.MYBROWSER === undefined ? {} : { browserBinding: env.MYBROWSER }),
  };
}

function fetchOllamaCollection(
  env: ProviderMetricsEnv,
  apiKey: string | undefined,
  sessionCookie: string | undefined,
  scheduledTime: number,
  openaiHistoryDays: number,
): Promise<OllamaCollectionResult> {
  if (apiKey !== undefined && apiKey !== "") {
    return ollamaAdapter(env, createProviderContext(env, scheduledTime, openaiHistoryDays));
  }
  if (sessionCookie !== undefined && sessionCookie !== "") {
    return fetchOllamaMetrics(sessionCookie, fetch);
  }
  return Promise.resolve(null);
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
      ollama: { status: "skipped" },
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
  const ollamaApiKey = env.OLLAMA_API_KEY?.trim();
  const ollamaSessionCookie = env.OLLAMA_SESSION_COOKIE?.trim();
  const providerContext = createProviderContext(env, scheduledTime, historyDays ?? 1);
  const adapterEnv = {
    ...env,
    ...(openAiApiKey === undefined ? {} : { OPENAI_ADMIN_API_KEY: openAiApiKey }),
    ...(codexAccessToken === undefined ? {} : { CODEX_ACCESS_TOKEN: codexAccessToken }),
  } satisfies ProviderMetricsEnv;

  const [openai, codex, openCodeGo, ollama] = await Promise.allSettled([
    openAiApiKey !== undefined && openAiApiKey !== "" && historyDays !== undefined
      ? openaiAdapter(adapterEnv, providerContext)
      : Promise.resolve(null),
    codexAccessToken !== undefined && codexAccessToken !== ""
      ? codexAdapter(adapterEnv, providerContext)
      : Promise.resolve(null),
    openCodeGoSessionCookie !== undefined && openCodeGoSessionCookie !== ""
      ? fetchOpenCodeGoMetrics(openCodeGoSessionCookie, env.OPENCODEGO_WORKSPACE_ID, fetch)
      : Promise.resolve(null),
    fetchOllamaCollection(env, ollamaApiKey, ollamaSessionCookie, scheduledTime, historyDays ?? 1),
  ] as const);

  let openaiResult: OpenAIProviderResult | null = null;
  if (openai.status === "fulfilled") {
    const outcome = openai.value;
    if (outcome !== null) {
      switch (outcome.status) {
        case "success":
          if (outcome.result.provider !== "openai_api") {
            report.providers.openai = { status: "failed", error: "internal" };
            break;
          }
          openaiResult = outcome.result;
          report.providers.openai = {
            status: "success",
            count: { costs: openaiResult.costs.length, tokens: openaiResult.modelUsage.length },
          };
          break;
        case "empty":
          break;
        case "failed": {
          const err = adapterErrorMessage(outcome.error);
          console.error(`Provider metrics: OpenAI API fetch failed: ${err}`);
          report.providers.openai = { status: "failed", error: err };
          break;
        }
        default:
          assertNever(outcome);
      }
    }
  } else {
    const err = errorMessage(openai.reason);
    console.error(`Provider metrics: OpenAI API fetch failed: ${err}`);
    report.providers.openai = { status: "failed", error: err };
  }

  let codexResult: CodexProviderResult | null = null;
  if (codex.status === "fulfilled") {
    const outcome = codex.value;
    if (outcome !== null) {
      switch (outcome.status) {
        case "success":
          if (outcome.result.provider !== "codex") {
            report.providers.codex = { status: "failed", error: "internal" };
            break;
          }
          codexResult = outcome.result;
          report.providers.codex = { status: "success", plan: codexResult.plan };
          break;
        case "empty":
          break;
        case "failed": {
          const err = adapterErrorMessage(outcome.error);
          console.error(`Provider metrics: Codex fetch failed: ${err}`);
          report.providers.codex = { status: "failed", error: err };
          break;
        }
        default:
          assertNever(outcome);
      }
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

  let ollamaResult: OllamaFetchResult | null = null;
  let ollamaProviderResult: OllamaProviderResult | null = null;
  if (ollama.status === "fulfilled") {
    const value: OllamaCollectionResult = ollama.value;
    if (value !== null && "status" in value) {
      if (value.status === "success") {
        if (value.result.provider !== "ollama_cloud") {
          report.providers.ollama = { status: "failed", error: "internal" };
        } else {
          ollamaProviderResult = value.result;
          const sessionWindow = value.result.windows.find((window) => window.period === "session");
          const weeklyWindow = value.result.windows.find((window) => window.period === "weekly");
          report.providers.ollama = {
            status: "success",
            sessionUsageRatio: sessionWindow?.usageRatio,
            weeklyUsageRatio: weeklyWindow?.usageRatio,
            plan: value.result.plan,
          };
        }
      } else if (value.status === "failed") {
        const { kind, statusCode } = value.error;
        report.providers.ollama = {
          status: "failed",
          error: statusCode === undefined ? kind : `${kind} (${statusCode})`,
        };
      }
    } else {
      ollamaResult = value;
    }

    if (ollamaResult !== null) {
      report.providers.ollama = {
        status: "success",
        sessionUsageRatio: ollamaResult.sessionUsageRatio,
        weeklyUsageRatio: ollamaResult.weeklyUsageRatio,
        plan: ollamaResult.plan,
      };
    }
  } else {
    const err = errorMessage(ollama.reason);
    console.error(`Provider metrics: Ollama fetch failed: ${err}`);
    report.providers.ollama = { status: "failed", error: err };
  }

  const hasOpenAIMetrics =
    openaiResult !== null && (openaiResult.costs.length > 0 || openaiResult.modelUsage.length > 0);
  const hasMetrics =
    hasOpenAIMetrics ||
    codexResult !== null ||
    openCodeGoResult !== null ||
    ollamaResult !== null ||
    ollamaProviderResult !== null;

  if (!hasMetrics) {
    console.error("Provider metrics: No metrics to push (all providers skipped, failed, or empty)");
    return report;
  }

  const pushNowMs = Date.now();
  const nowSeconds = Math.floor(pushNowMs / 1_000);
  const providerResults: ProviderResult[] = [
    ...(hasOpenAIMetrics && openaiResult !== null ? [openaiResult] : []),
    ...(codexResult === null ? [] : [codexResult]),
    ...toProviderResults(
      {
        ...(openCodeGoResult === null ? {} : { openCodeGo: openCodeGoResult }),
        ...(ollamaResult === null ? {} : { ollama: ollamaResult }),
      },
      nowSeconds,
    ),
    ...(ollamaProviderResult === null ? [] : [ollamaProviderResult]),
  ];

  const pushResult = await pushProviderMetrics(env, {
    results: providerResults,
    healthMetrics: [],
    nowUnixNano: `${pushNowMs}000000`,
    nowSeconds,
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
