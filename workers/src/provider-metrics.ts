import { commandcodeAdapter } from "./provider-metrics/commandcode";
import {
  runAdapters,
  type ProviderExecutionRecord,
  type RegisteredProvider,
} from "./provider-metrics/adapters";
import { codexAdapter } from "./provider-metrics/codex";
import { buildHealthMetrics } from "./provider-metrics/health";
import { ollamaAdapter } from "./provider-metrics/ollama/index";
import { openaiAdapter } from "./provider-metrics/openai-api";
import { openCodeGoAdapter } from "./provider-metrics/opencodego/index";
import { pushProviderMetrics } from "./provider-metrics/prometheus";
import type {
  ProviderContext,
  ProviderError,
  ProviderId,
  ProviderMetricsEnv,
  ProviderResult,
} from "./provider-metrics/types";

export interface ProviderMetricsWorker {
  scheduled(event: ScheduledEvent, env: ProviderMetricsEnv, ctx: ExecutionContext): Promise<void>;
  fetch?(request: Request, env: ProviderMetricsEnv, ctx: ExecutionContext): Promise<Response>;
}

type ProviderDiagnosticError = Pick<ProviderError, "statusCode" | "provider" | "sourceId" | "kind">;
type ProviderDiagnostic = {
  readonly status: "skipped" | "success" | "empty" | "failed";
  readonly error?: ProviderDiagnosticError;
};

export interface ProviderDiagnosticReport {
  readonly timestamp: string;
  readonly providers: Readonly<Record<ProviderId, ProviderDiagnostic>>;
  prometheusPush: { status: "skipped" | "success" | "failed"; statusCode?: number };
}

const PROVIDER_REGISTRY = [
  {
    provider: "openai_api",
    credentialKey: "OPENAI_ADMIN_API_KEY",
    primarySourceId: "openai-organization-api",
    adapter: openaiAdapter,
  },
  {
    provider: "codex",
    credentialKey: "CODEX_ACCESS_TOKEN",
    primarySourceId: "codex-wham-usage",
    adapter: codexAdapter,
  },
  {
    provider: "opencodego",
    credentialKey: "OPENCODEGO_API_KEY",
    primarySourceId: "opencodego-usage-api",
    adapter: openCodeGoAdapter,
  },
  {
    provider: "ollama_cloud",
    credentialKey: "OLLAMA_API_KEY",
    primarySourceId: "ollama-api-usage",
    adapter: ollamaAdapter,
  },
  {
    provider: "commandcode",
    credentialKey: "COMMAND_CODE_API_KEY",
    primarySourceId: "commandcode-billing-credits",
    adapter: commandcodeAdapter,
  },
] as const satisfies readonly RegisteredProvider[];

function assertNever(value: never): never {
  throw new Error(`Unexpected provider execution state: ${String(value)}`);
}

function projectProviderError(error: ProviderError): ProviderDiagnosticError {
  return {
    ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
    provider: error.provider,
    sourceId: error.sourceId,
    kind: error.kind,
  };
}

function diagnosticFor(record: ProviderExecutionRecord): ProviderDiagnostic {
  switch (record.status) {
    case "skipped":
      return { status: "skipped" };
    case "attempted":
      switch (record.outcome.status) {
        case "success":
          return { status: "success" };
        case "empty":
          return { status: "empty" };
        case "failed": {
          const error = projectProviderError(record.outcome.error);
          console.error("Provider metrics: provider failed", error);
          return { status: "failed", error };
        }
        default:
          return assertNever(record.outcome);
      }
    default:
      return assertNever(record);
  }
}

function initialProviderDiagnostics(): Record<ProviderId, ProviderDiagnostic> {
  return {
    openai_api: { status: "skipped" },
    codex: { status: "skipped" },
    opencodego: { status: "skipped" },
    ollama_cloud: { status: "skipped" },
    commandcode: { status: "skipped" },
  };
}

function isValidHistoryDays(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 31;
}

export async function collectAndPushProviderMetrics(
  env: ProviderMetricsEnv,
  scheduledTimeMs: number = Date.now(),
): Promise<ProviderDiagnosticReport> {
  const rawHistoryDays = env.OPENAI_API_HISTORY_DAYS;
  const parsedHistoryDays = rawHistoryDays === undefined ? 1 : Number(rawHistoryDays);
  const historyDaysAreValid = isValidHistoryDays(parsedHistoryDays);
  const openaiHistoryDays = historyDaysAreValid ? parsedHistoryDays : 1;
  let adapterEnv = env;

  if (!historyDaysAreValid) {
    console.error("Provider metrics: invalid OpenAI history configuration; OpenAI skipped");
    adapterEnv = { ...env };
    delete adapterEnv.OPENAI_ADMIN_API_KEY;
  }

  const context: ProviderContext = {
    fetchFn: fetch,
    scheduledTimeSeconds: Math.floor(scheduledTimeMs / 1_000),
    openaiHistoryDays,
    nowSeconds: () => Math.floor(Date.now() / 1_000),
    monotonicNowMs: () => performance.now(),
    ...(env.MYBROWSER === undefined ? {} : { browserBinding: env.MYBROWSER }),
  };
  const records = await runAdapters(adapterEnv, context, PROVIDER_REGISTRY);
  const providers = initialProviderDiagnostics();
  const recordsByProvider = new Map(records.map((record) => [record.provider, record] as const));

  for (const entry of PROVIDER_REGISTRY) {
    const record = recordsByProvider.get(entry.provider);
    if (record === undefined) {
      const error: ProviderDiagnosticError = {
        provider: entry.provider,
        sourceId: entry.primarySourceId,
        kind: "internal",
      };
      console.error("Provider metrics: provider execution record missing", error);
      providers[entry.provider] = { status: "failed", error };
      continue;
    }
    providers[entry.provider] = diagnosticFor(record);
  }

  const report: ProviderDiagnosticReport = {
    timestamp: new Date(scheduledTimeMs).toISOString(),
    providers,
    prometheusPush: { status: "skipped" },
  };
  const attemptedRecords = records.filter(
    (record): record is Extract<ProviderExecutionRecord, { status: "attempted" }> =>
      record.status === "attempted",
  );

  if (attemptedRecords.length === 0) return report;

  const successfulResults: ProviderResult[] = attemptedRecords.flatMap((record) =>
    record.outcome.status === "success" ? [record.outcome.result] : [],
  );
  const healthMetrics = buildHealthMetrics(attemptedRecords.map((record) => record.health));
  const pushNowMs = Date.now();
  const pushResult = await pushProviderMetrics(env, {
    results: successfulResults,
    healthMetrics,
    nowUnixNano: `${pushNowMs}000000`,
    nowSeconds: Math.floor(pushNowMs / 1_000),
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
