import type { OpenCodeGoFetchResult, ProviderAdapter } from "../types";
import { extractZenBilling, parseOpenCodeGoUsage } from "../opencodego-parser";
import { fetchOpenCodeGoApiKey } from "./api-key";
import {
  BILLING_SERVER_ID,
  createFetchContext,
  fetchServerRPC,
  fetchWorkspaceId,
  fetchZenBalance,
  fetchZenBalanceEnrichment,
  type FetchContext,
  isNullPayload,
  LITE_SUBSCRIPTION_SERVER_ID,
  OpenCodeGoFetchError,
  SUBSCRIPTION_SERVER_ID,
} from "./zen-balance";

export { fetchOpenCodeGoApiKey } from "./api-key";
export { fetchZenBalanceEnrichment, OpenCodeGoFetchError } from "./zen-balance";

export const openCodeGoAdapter: ProviderAdapter = async (env, context) => {
  const quotaOutcome = await fetchOpenCodeGoApiKey(env.OPENCODEGO_API_KEY ?? "", context);
  if (quotaOutcome.status !== "success") return quotaOutcome;

  const sessionCookie = env.OPENCODEGO_SESSION_COOKIE?.trim();
  if (sessionCookie === undefined || sessionCookie === "") return quotaOutcome;

  const zenBalanceUSD = await fetchZenBalanceEnrichment(
    sessionCookie,
    env.OPENCODEGO_WORKSPACE_ID,
    context.fetchFn,
  );
  if (zenBalanceUSD === null) return quotaOutcome;

  if (quotaOutcome.result.provider !== "opencodego") return quotaOutcome;
  return {
    status: "success",
    result: {
      ...quotaOutcome.result,
      zenBalanceUSD,
      sources: [
        ...quotaOutcome.result.sources,
        { id: "opencodego-zen-rpc", supportLevel: "web-internal", role: "enrichment" },
      ],
    },
  };
};

export const opencodegoAdapter = openCodeGoAdapter;

async function tryFetchSubscriptionUsage(
  workspaceId: string,
  context: FetchContext,
  attempts: string[],
): Promise<OpenCodeGoFetchResult | null> {
  for (const serverId of [SUBSCRIPTION_SERVER_ID, LITE_SUBSCRIPTION_SERVER_ID]) {
    try {
      const subscriptionText = await fetchServerRPC(serverId, [workspaceId], context, workspaceId);
      attempts.push(`[${serverId.slice(0, 6)}:GET=len:${subscriptionText.length}]`);
      if (!isNullPayload(subscriptionText)) {
        const usage = parseOpenCodeGoUsage(subscriptionText);
        return {
          ...usage,
          zenBalanceUSD: await fetchZenBalance(workspaceId, context),
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push(`[${serverId.slice(0, 6)}:GET=err:${message}]`);
      if (error instanceof OpenCodeGoFetchError && error.detail.includes("Cookie expired")) {
        throw error;
      }
    }
  }
  return null;
}

async function tryFetchBillingUsage(
  workspaceId: string,
  context: FetchContext,
  attempts: string[],
): Promise<OpenCodeGoFetchResult | null> {
  try {
    const billingText = await fetchServerRPC(
      BILLING_SERVER_ID,
      [workspaceId],
      context,
      workspaceId,
    );
    attempts.push(`[bill:GET=len:${billingText.length}]`);
    const billing = extractZenBilling(billingText);
    if (!billing) return null;

    const limit = billing.monthlyLimitUSD;
    const usage = billing.monthlyUsageUSD;
    const ratio = limit !== null && limit > 0 ? Math.max(0, Math.min(1.0, usage / limit)) : 0;
    return {
      rollingUsageRatio: ratio,
      monthlyUsageRatio: ratio,
      zenBalanceUSD: billing.balanceUSD,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    attempts.push(`[bill:GET=err:${message}]`);
    return null;
  }
}

/** Compatibility entry for the legacy scheduled orchestrator until Task 12 migrates it. */
export async function fetchOpenCodeGoMetrics(
  rawCookie: string,
  workspaceIdOverride?: string,
  fetchFn: typeof fetch = fetch,
): Promise<OpenCodeGoFetchResult> {
  const context = createFetchContext(rawCookie, fetchFn);
  const workspaceId = workspaceIdOverride?.trim() || (await fetchWorkspaceId(context));

  const attempts: string[] = [];
  const subscriptionResult = await tryFetchSubscriptionUsage(workspaceId, context, attempts);
  if (subscriptionResult !== null) return subscriptionResult;

  const billingResult = await tryFetchBillingUsage(workspaceId, context, attempts);
  if (billingResult !== null) return billingResult;

  const balance = await fetchZenBalance(workspaceId, context);
  if (balance !== null) {
    return {
      rollingUsageRatio: 0,
      zenBalanceUSD: balance,
    };
  }

  throw new OpenCodeGoFetchError(
    `OpenCodeGo: Could not resolve subscription or billing usage for workspace ${workspaceId} (attempts: ${attempts.join(", ")})`,
  );
}
