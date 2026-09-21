import { fetchOllamaApiUsage } from "./api-usage";
import {
  fetchOllamaSettingsHtml,
  OllamaFetchError,
  type OllamaSettingsHtmlContribution,
} from "./settings-html";
import type {
  AdapterOutcome,
  OllamaFetchResult,
  ProviderAdapter,
  ProviderErrorKind,
  ProviderResult,
  QuotaPeriod,
  QuotaWindow,
} from "../types";

const OLLAMA_SETTINGS_HTML_SOURCE_ID = "ollama-settings-html";

export { fetchOllamaApiUsage, fetchOllamaSettingsHtml, OllamaFetchError };
export type { OllamaSettingsHtmlContribution, OllamaSettingsHtmlOutcome } from "./settings-html";

type OllamaResult = Extract<ProviderResult, { provider: "ollama_cloud" }>;

export async function fetchOllamaMetrics(
  sessionCookie: string,
  fetchFn: typeof fetch = fetch,
): Promise<OllamaFetchResult> {
  const outcome = await fetchOllamaSettingsHtml(sessionCookie, fetchFn);
  if (outcome.status === "failed") {
    throw new OllamaFetchError("Ollama settings request failed", outcome.error.statusCode);
  }

  const { contribution } = outcome;
  if (contribution.windows.length === 0) {
    throw new OllamaFetchError("Could not find Ollama Cloud usage data in settings page HTML");
  }

  const windowForPeriod = (period: QuotaPeriod): QuotaWindow | undefined =>
    contribution.windows.find((window) => window.period === period);
  const session = windowForPeriod("session");
  const weekly = windowForPeriod("weekly");
  return {
    ...(session?.usageRatio === undefined ? {} : { sessionUsageRatio: session.usageRatio }),
    ...(weekly?.usageRatio === undefined ? {} : { weeklyUsageRatio: weekly.usageRatio }),
    ...(session?.resetTimestampSeconds === undefined
      ? {}
      : { sessionResetTimestampSeconds: session.resetTimestampSeconds }),
    ...(weekly?.resetTimestampSeconds === undefined
      ? {}
      : { weeklyResetTimestampSeconds: weekly.resetTimestampSeconds }),
    ...(contribution.plan === undefined ? {} : { plan: contribution.plan }),
    ...(contribution.email === undefined ? {} : { email: contribution.email }),
  };
}

function assertNever(value: never): never {
  throw new Error(`Unexpected Ollama provider error kind: ${String(value)}`);
}

function shouldTrySettingsHtml(kind: ProviderErrorKind): boolean {
  switch (kind) {
    case "network":
    case "timeout":
    case "auth":
    case "forbidden":
    case "upstream_4xx":
    case "rate_limit":
    case "upstream_5xx":
      return true;
    case "schema":
    case "parse":
    case "internal":
      return false;
    default:
      return assertNever(kind);
  }
}

function hasFallbackContribution(contribution: OllamaSettingsHtmlContribution): boolean {
  return contribution.windows.length > 0 || contribution.plan !== undefined;
}

function mergeSettingsEnrichment(
  result: OllamaResult,
  contribution: OllamaSettingsHtmlContribution,
): OllamaResult {
  let addedReset = false;
  const windows = result.windows.map((window) => {
    if (window.resetTimestampSeconds !== undefined) return window;

    const htmlWindow = contribution.windows.find((candidate) => candidate.period === window.period);
    if (htmlWindow?.resetTimestampSeconds === undefined) return window;

    addedReset = true;
    return { ...window, resetTimestampSeconds: htmlWindow.resetTimestampSeconds };
  });
  const addedPlan = result.plan === undefined && contribution.plan !== undefined;

  if (!addedReset && !addedPlan) return result;

  return {
    ...result,
    windows,
    ...(addedPlan && contribution.plan !== undefined ? { plan: contribution.plan } : {}),
    sources: [
      ...result.sources,
      { id: OLLAMA_SETTINGS_HTML_SOURCE_ID, supportLevel: "scraping", role: "enrichment" },
    ],
  };
}

function fallbackResult(contribution: OllamaSettingsHtmlContribution): AdapterOutcome {
  return {
    status: "success",
    result: {
      provider: "ollama_cloud",
      sources: [{ id: OLLAMA_SETTINGS_HTML_SOURCE_ID, supportLevel: "scraping", role: "fallback" }],
      windows: [...contribution.windows],
      modelRequests: [],
      ...(contribution.plan === undefined ? {} : { plan: contribution.plan }),
    },
  };
}

export const ollamaAdapter: ProviderAdapter = async (env, context) => {
  const apiOutcome = await fetchOllamaApiUsage(env.OLLAMA_API_KEY ?? "", context);
  if (apiOutcome.status === "empty") return apiOutcome;

  const sessionCookie = env.OLLAMA_SESSION_COOKIE?.trim();
  if (apiOutcome.status === "success") {
    if (sessionCookie === undefined || sessionCookie === "") return apiOutcome;
    if (apiOutcome.result.provider !== "ollama_cloud") return apiOutcome;

    const htmlOutcome = await fetchOllamaSettingsHtml(sessionCookie, context.fetchFn);
    if (htmlOutcome.status === "failed") return apiOutcome;
    return {
      status: "success",
      result: mergeSettingsEnrichment(apiOutcome.result, htmlOutcome.contribution),
    };
  }

  if (!shouldTrySettingsHtml(apiOutcome.error.kind)) return apiOutcome;
  if (sessionCookie === undefined || sessionCookie === "") return apiOutcome;

  const htmlOutcome = await fetchOllamaSettingsHtml(sessionCookie, context.fetchFn);
  if (htmlOutcome.status === "failed" || !hasFallbackContribution(htmlOutcome.contribution)) {
    return apiOutcome;
  }
  return fallbackResult(htmlOutcome.contribution);
};
