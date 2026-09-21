import {
  COMMAND_CODE_SOURCE_IDS,
  fetchCommandCodeCredits,
  fetchCommandCodeSubscription,
  fetchCommandCodeSummary,
  fetchCommandCodeWhoami,
} from "./billing";
import type { CommandCodeCredits, CommandCodeSubscription } from "./billing";
import type {
  AdapterOutcome,
  ProviderAdapter,
  ProviderResult,
  ProviderSource,
  ProviderUsageSummary,
} from "../types";

type CommandCodeResult = Extract<ProviderResult, { provider: "commandcode" }>;

function source(id: string, role: ProviderSource["role"]): ProviderSource {
  return { id, supportLevel: "official-internal", role };
}

function failed(
  outcome: Extract<Awaited<ReturnType<typeof fetchCommandCodeWhoami>>, { ok: false }>,
): AdapterOutcome {
  return { status: "failed", error: outcome.error };
}

function subscriptionContributes(subscription: CommandCodeSubscription): boolean {
  return (
    subscription.plan !== undefined ||
    subscription.status !== undefined ||
    subscription.billingPeriodEndSeconds !== undefined
  );
}

function buildResult(
  credits: CommandCodeCredits,
  subscription: CommandCodeSubscription | undefined,
  summary: ProviderUsageSummary | undefined,
): CommandCodeResult {
  const hasSubscription = subscription !== undefined && subscriptionContributes(subscription);
  const hasSubscriptionDetails =
    subscription !== undefined &&
    (subscription.status !== undefined || subscription.billingPeriodEndSeconds !== undefined);
  const sources: ProviderSource[] = [source(COMMAND_CODE_SOURCE_IDS.credits, "primary")];
  if (hasSubscription) {
    sources.push(source(COMMAND_CODE_SOURCE_IDS.subscriptions, "enrichment"));
  }
  if (summary !== undefined) {
    sources.push(source(COMMAND_CODE_SOURCE_IDS.summary, "enrichment"));
  }

  return {
    provider: "commandcode",
    sources,
    windows: credits.windows,
    credits: credits.credits,
    ...(subscription?.plan === undefined ? {} : { plan: subscription.plan }),
    ...(hasSubscriptionDetails && subscription !== undefined
      ? {
          subscription: {
            ...(subscription.status === undefined ? {} : { status: subscription.status }),
            ...(subscription.billingPeriodEndSeconds === undefined
              ? {}
              : { billingPeriodEndSeconds: subscription.billingPeriodEndSeconds }),
          },
        }
      : {}),
    ...(summary === undefined ? {} : { usage: summary }),
  };
}

export const commandcodeAdapter: ProviderAdapter = async (env, context) => {
  const apiKey = env.COMMAND_CODE_API_KEY ?? "";
  const whoami = await fetchCommandCodeWhoami(apiKey, context);
  if (!whoami.ok) return failed(whoami);

  const [credits, subscription] = await Promise.all([
    fetchCommandCodeCredits(apiKey, whoami.value.orgId, context),
    fetchCommandCodeSubscription(apiKey, whoami.value.orgId, context),
  ]);
  const summary = await fetchCommandCodeSummary(
    apiKey,
    whoami.value.orgId,
    subscription.ok ? subscription.value.currentPeriodStart : undefined,
    context,
  );

  if (!credits.ok) return { status: "failed", error: credits.error };
  return {
    status: "success",
    result: buildResult(
      credits.value,
      subscription.ok ? subscription.value : undefined,
      summary.ok ? summary.value : undefined,
    ),
  };
};

export const commandCodeAdapter = commandcodeAdapter;

export {
  COMMAND_CODE_SOURCE_IDS,
  fetchCommandCodeCredits,
  fetchCommandCodeSubscription,
  fetchCommandCodeSummary,
  fetchCommandCodeWhoami,
} from "./billing";
export type { CommandCodeCredits, CommandCodeSubscription } from "./billing";
