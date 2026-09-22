import type {
  AdapterOutcome,
  ProviderContext,
  ProviderError,
  ProviderAdapter,
  ProviderId,
  ProviderMetricsEnv,
} from "./types";
import type { ScrapeHealthOutcome } from "./health";
export type { AdapterOutcome, ProviderAdapter } from "./types";

export type ProviderCredentialKey =
  | "OPENAI_ADMIN_API_KEY"
  | "CODEX_ACCESS_TOKEN"
  | "OPENCODEGO_API_KEY"
  | "OLLAMA_API_KEY"
  | "COMMAND_CODE_API_KEY";

export interface RegisteredProvider {
  readonly provider: ProviderId;
  readonly credentialKey: ProviderCredentialKey;
  readonly primarySourceId: string;
  readonly adapter: ProviderAdapter;
}

export type ProviderExecutionRecord =
  | { readonly provider: ProviderId; readonly status: "skipped" }
  | {
      readonly provider: ProviderId;
      readonly status: "attempted";
      readonly outcome: AdapterOutcome;
      readonly health: ScrapeHealthOutcome;
    };

function internalFailure(entry: RegisteredProvider): AdapterOutcome {
  const error: ProviderError = {
    kind: "internal",
    provider: entry.provider,
    sourceId: entry.primarySourceId,
  };
  return { status: "failed", error };
}

async function executeAdapter(
  env: ProviderMetricsEnv,
  ctx: ProviderContext,
  entry: RegisteredProvider,
): Promise<ProviderExecutionRecord> {
  const startMs = ctx.monotonicNowMs();
  let outcome: AdapterOutcome;
  try {
    outcome = await entry.adapter(env, ctx);
  } catch {
    outcome = internalFailure(entry);
  }
  const endMs = ctx.monotonicNowMs();
  const health: ScrapeHealthOutcome = {
    provider: entry.provider,
    status: outcome.status,
    durationSeconds: (endMs - startMs) / 1_000,
    ...(outcome.status === "success" || outcome.status === "empty"
      ? { timestampSeconds: ctx.nowSeconds() }
      : {}),
  };
  return { provider: entry.provider, status: "attempted", outcome, health };
}

export async function runAdapters(
  env: ProviderMetricsEnv,
  ctx: ProviderContext,
  registry: readonly RegisteredProvider[],
): Promise<ProviderExecutionRecord[]> {
  const executions = registry.map((entry) => {
    const credential = env[entry.credentialKey];
    return credential?.trim()
      ? executeAdapter(env, ctx, entry)
      : Promise.resolve({ provider: entry.provider, status: "skipped" as const });
  });
  const settled = await Promise.allSettled(executions);
  return settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    const entry = registry[index];
    if (entry === undefined) throw new Error("adapter registry result length mismatch");
    return {
      provider: entry.provider,
      status: "attempted" as const,
      outcome: internalFailure(entry),
      health: {
        provider: entry.provider,
        status: "failed" as const,
        durationSeconds: 0,
      },
    };
  });
}
