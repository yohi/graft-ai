// workers/src/provider-metrics/opencodego-parser.ts

export type OpenCodeGoUsage = {
  readonly rollingUsageRatio: number;
  readonly weeklyUsageRatio?: number;
  readonly monthlyUsageRatio?: number;
  readonly rollingResetSeconds?: number;
  readonly weeklyResetSeconds?: number;
  readonly monthlyResetSeconds?: number;
};

const PERCENT_KEYS = [
  "rollingUsagePercent",
  "rollingUsedPercent",
  "rolling_usage_percent",
  "rollingUsage",
  "rolling",
  "usagePercent",
  "usedPercent",
  "percentUsed",
  "percent",
  "usage_percent",
  "used_percent",
  "utilization",
  "utilizationPercent",
  "utilization_percent",
  "usage",
] as const;

const WEEKLY_PERCENT_KEYS = [
  "weeklyUsagePercent",
  "weeklyUsedPercent",
  "weekly_usage_percent",
  "weeklyUsage",
  "weekly",
] as const;

const MONTHLY_PERCENT_KEYS = [
  "monthlyUsagePercent",
  "monthlyUsedPercent",
  "monthly_usage_percent",
  "monthlyUsage",
  "monthly",
] as const;

const RESET_KEYS = [
  "rollingResetInSec",
  "rollingResetInSeconds",
  "rollingResetSeconds",
  "rolling_reset_in_sec",
  "resetInSec",
  "resetInSeconds",
  "resetSeconds",
  "reset_sec",
  "reset_in_sec",
  "resetsInSec",
  "resetsInSeconds",
  "resetIn",
  "resetSec",
] as const;

const WEEKLY_RESET_KEYS = [
  "weeklyResetInSec",
  "weeklyResetInSeconds",
  "weekly_reset_in_sec",
  "weeklyResetSeconds",
] as const;

const MONTHLY_RESET_KEYS = [
  "monthlyResetInSec",
  "monthlyResetInSeconds",
  "monthly_reset_in_sec",
  "monthlyResetSeconds",
] as const;

const USAGE_KEYS = [
  ...PERCENT_KEYS,
  ...WEEKLY_PERCENT_KEYS,
  ...MONTHLY_PERCENT_KEYS,
  ...RESET_KEYS,
  ...WEEKLY_RESET_KEYS,
  ...MONTHLY_RESET_KEYS,
  "rollingUsage",
  "weeklyUsage",
  "monthlyUsage",
] as const;

const UNSAFE_TRAVERSAL_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class OpenCodeGoResponseError extends Error {
  readonly name = "OpenCodeGoResponseError";

  constructor(readonly detail: string) {
    super(detail);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUsageKey(record: Record<string, unknown>): boolean {
  return USAGE_KEYS.some((key) => Object.hasOwn(record, key));
}

function findUsageRecords(value: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!isRecord(candidate)) return;
    if (hasUsageKey(candidate)) records.push(candidate);
    for (const [key, item] of Object.entries(candidate)) {
      if (!UNSAFE_TRAVERSAL_KEYS.has(key)) visit(item);
    }
  };

  visit(value);
  return records;
}

function parseJsonUsage(source: string): Record<string, unknown>[] | null {
  try {
    const value: unknown = JSON.parse(source);
    const records = findUsageRecords(value);
    return records.length > 0 ? records : null;
  } catch {
    return null;
  }
}

function extractFromScriptTags(html: string): Record<string, unknown>[] | null {
  const allRecords: Record<string, unknown>[] = [];
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    const source = match[1]?.trim();
    if (source === undefined || source.length === 0) continue;
    const records = parseJsonUsage(source);
    if (records !== null) allRecords.push(...records);
  }
  return allRecords.length > 0 ? allRecords : null;
}

function extractFromNextData(html: string): Record<string, unknown>[] | null {
  const source = html
    .match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)?.[1]
    ?.trim();
  return source === undefined || source.length === 0 ? null : parseJsonUsage(source);
}

function extractFromRscHydration(html: string): Record<string, unknown>[] | null {
  const records: Record<string, unknown>[] = [];
  for (const match of html.matchAll(
    /"(?:rollingUsage|weeklyUsage|monthlyUsage|usage|rateLimit|quota|limits)"\s*[,:]\s*(\{[^{}]+\})/gi,
  )) {
    const source = match[1];
    if (source === undefined) continue;
    try {
      const value: unknown = JSON.parse(source);
      if (isRecord(value)) records.push(value);
    } catch {
      continue;
    }
  }

  for (const match of html.matchAll(
    /\{(?:[^{}]*"(?:usagePercent|rollingUsagePercent|usedPercent)"[^{}]*)\}/gi,
  )) {
    try {
      const value: unknown = JSON.parse(match[0]);
      if (isRecord(value)) records.push(value);
    } catch {
      continue;
    }
  }

  return records.length === 0 ? null : records;
}

function extractSolidStartUsageBlocks(text: string): Record<string, unknown>[] | null {
  const extractBlock = (name: string): Record<string, unknown> | null => {
    const match = text.match(
      new RegExp(`(?:${name}|"${name}")\\s*:\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?\\{([^}]+)\\}`),
    );
    if (!match || match[1] === undefined) return null;
    const body = match[1];
    const percentMatch = body.match(/(?:usagePercent|"usagePercent")\s*:\s*([0-9.]+)/);
    const resetMatch = body.match(/(?:resetInSec|"resetInSec")\s*:\s*([0-9]+)/);
    const res: Record<string, unknown> = {};
    if (percentMatch && percentMatch[1] !== undefined) {
      res[`${name}Percent`] = Number(percentMatch[1]);
    }
    if (resetMatch && resetMatch[1] !== undefined) {
      res[`${name}ResetInSec`] = Number(resetMatch[1]);
    }
    return Object.keys(res).length > 0 ? res : null;
  };

  const rolling = extractBlock("rollingUsage");
  const weekly = extractBlock("weeklyUsage");
  const monthly = extractBlock("monthlyUsage");

  if (!rolling && !weekly && !monthly) return null;

  const combined: Record<string, unknown> = {};
  if (rolling) {
    if (rolling["rollingUsagePercent"] !== undefined) {
      combined["rollingUsagePercent"] = rolling["rollingUsagePercent"];
    }
    if (rolling["rollingUsageResetInSec"] !== undefined) {
      combined["rollingResetInSec"] = rolling["rollingUsageResetInSec"];
    }
  }
  if (weekly) {
    if (weekly["weeklyUsagePercent"] !== undefined) {
      combined["weeklyUsagePercent"] = weekly["weeklyUsagePercent"];
    }
    if (weekly["weeklyUsageResetInSec"] !== undefined) {
      combined["weeklyResetInSec"] = weekly["weeklyUsageResetInSec"];
    }
  }
  if (monthly) {
    if (monthly["monthlyUsagePercent"] !== undefined) {
      combined["monthlyUsagePercent"] = monthly["monthlyUsagePercent"];
    }
    if (monthly["monthlyUsageResetInSec"] !== undefined) {
      combined["monthlyResetInSec"] = monthly["monthlyUsageResetInSec"];
    }
  }
  return Object.keys(combined).length > 0 ? [combined] : null;
}

function extractFromSolidStart(html: string): Record<string, unknown>[] | null {
  const records: Record<string, unknown>[] = [];
  const direct = extractSolidStartUsageBlocks(html);
  if (direct !== null) records.push(...direct);

  const scriptChunks = html.split(/<\/\s*script\s*>/i);

  for (const chunk of scriptChunks) {
    const scriptIndex = chunk.toLowerCase().lastIndexOf("<script");
    if (scriptIndex === -1) continue;
    const bodyIndex = chunk.indexOf(">", scriptIndex);
    if (bodyIndex === -1) continue;
    const script = chunk.slice(bodyIndex + 1).trim();
    if (script.length === 0) continue;

    const block = extractSolidStartUsageBlocks(script);
    if (block !== null) records.push(...block);

    const jsonMatches = script.match(
      /\{[^{}]*"(?:usagePercent|rollingUsagePercent|usedPercent|weeklyUsagePercent|monthlyUsagePercent|usage|utilization|resetInSec)"[^{}]*\}/g,
    );
    if (jsonMatches !== null) {
      for (const raw of jsonMatches) {
        try {
          const parsed: unknown = JSON.parse(raw);
          const found = findUsageRecords(parsed);
          if (found.length > 0) records.push(...found);
        } catch {
          continue;
        }
      }
    }
  }

  return records.length === 0 ? null : records;
}

function parseDurationText(text: string): number | null {
  let seconds = 0;
  let matched = false;

  const daysMatch = text.match(/(\d+)\s*(?:日|days?|d\b)/i);
  if (daysMatch) {
    seconds += Number(daysMatch[1]) * 86400;
    matched = true;
  }

  const hoursMatch = text.match(/(\d+)\s*(?:時間|hours?|h\b)/i);
  if (hoursMatch) {
    seconds += Number(hoursMatch[1]) * 3600;
    matched = true;
  }

  const minsMatch = text.match(/(\d+)\s*(?:分|mins?|minutes?|m\b)/i);
  if (minsMatch) {
    seconds += Number(minsMatch[1]) * 60;
    matched = true;
  }

  const secsMatch = text.match(/(\d+)\s*(?:秒|secs?|seconds?|s\b)/i);
  if (secsMatch) {
    seconds += Number(secsMatch[1]);
    matched = true;
  }

  return matched ? seconds : null;
}

function extractFromDomText(html: string): Record<string, unknown>[] | null {
  const text = html.replace(/<[^>]+>/g, "\n");
  const record: Record<string, unknown> = {};
  let foundAny = false;

  const rollingMatch = text.match(
    /(?:ローリング利用量|ローリング|Rolling\s*Usage)[^\d%]*(\d+(?:\.\d+)?)\s*%[\s\S]*?(?:リセットまで|Resets?\s*in)\s*([^\n\r]+)/i,
  );
  if (rollingMatch !== null && rollingMatch[1] !== undefined) {
    record["rollingUsagePercent"] = Number(rollingMatch[1]);
    const durationText = rollingMatch[2];
    if (durationText !== undefined) {
      const sec = parseDurationText(durationText);
      if (sec !== null) record["rollingResetInSec"] = sec;
    }
    foundAny = true;
  }

  const weeklyMatch = text.match(
    /(?:週間利用量|週間|Weekly\s*Usage)[^\d%]*(\d+(?:\.\d+)?)\s*%[\s\S]*?(?:リセットまで|Resets?\s*in)\s*([^\n\r]+)/i,
  );
  if (weeklyMatch !== null && weeklyMatch[1] !== undefined) {
    record["weeklyUsagePercent"] = Number(weeklyMatch[1]);
    const durationText = weeklyMatch[2];
    if (durationText !== undefined) {
      const sec = parseDurationText(durationText);
      if (sec !== null) record["weeklyResetInSec"] = sec;
    }
    foundAny = true;
  }

  const monthlyMatch = text.match(
    /(?:月間利用量|月間|Monthly\s*Usage)[^\d%]*(\d+(?:\.\d+)?)\s*%[\s\S]*?(?:リセットまで|Resets?\s*in)\s*([^\n\r]+)/i,
  );
  if (monthlyMatch !== null && monthlyMatch[1] !== undefined) {
    record["monthlyUsagePercent"] = Number(monthlyMatch[1]);
    const durationText = monthlyMatch[2];
    if (durationText !== undefined) {
      const sec = parseDurationText(durationText);
      if (sec !== null) record["monthlyResetInSec"] = sec;
    }
    foundAny = true;
  }

  return foundAny ? [record] : null;
}

function extractFromTextFallback(html: string): Record<string, unknown>[] | null {
  const usageText = html.match(
    /"(?:usagePercent|rollingUsagePercent|usedPercent)"\s*:\s*(\d+(?:\.\d+)?)/i,
  )?.[1];
  if (usageText === undefined) return null;
  const resetText = html.match(/"resetInSec(?:onds)?"\s*:\s*(\d+)/i)?.[1];
  const record: Record<string, unknown> = { usagePercent: Number(usageText) };
  if (resetText !== undefined) record["resetInSec"] = Number(resetText);
  return [record];
}

function extractUsageRecords(html: string): Record<string, unknown>[] | null {
  return (
    extractFromNextData(html) ??
    parseJsonUsage(html.trim()) ??
    extractFromSolidStart(html) ??
    extractFromScriptTags(html) ??
    extractFromRscHydration(html) ??
    extractFromDomText(html) ??
    extractFromTextFallback(html)
  );
}

function findOwnValues(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
): readonly unknown[] {
  const values: unknown[] = [];
  for (const key of keys) {
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index];
      if (record !== undefined && Object.hasOwn(record, key)) {
        values.push(record[key]);
      }
    }
  }
  return values;
}

function parsePercentage(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
  required: true,
): number;
function parsePercentage(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
  required: false,
): number | undefined;
function parsePercentage(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
  required: boolean,
): number | undefined {
  const values = findOwnValues(records, keys);
  if (values.length === 0) {
    if (required) {
      throw new OpenCodeGoResponseError(
        "OpenCodeGo response is missing required rolling usage or reset data",
      );
    }
    return undefined;
  }
  let selected: number | null = null;
  for (const value of values) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const nested = parsePercentage([value as Record<string, unknown>], PERCENT_KEYS, false);
      if (nested !== undefined) {
        if (selected === null) selected = nested * 100;
        continue;
      }
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new OpenCodeGoResponseError(
        "OpenCodeGo usage percentage must be finite and between 0 and 100",
      );
    }
    if (selected === null) selected = value;
  }
  if (selected === null) {
    if (required) {
      throw new OpenCodeGoResponseError("OpenCodeGo response is missing usage data");
    }
    return undefined;
  }
  return selected / 100;
}

function parseResetSeconds(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
  required: true,
): number;
function parseResetSeconds(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
  required: false,
): number | undefined;
function parseResetSeconds(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
  required: boolean,
): number | undefined {
  const values = findOwnValues(records, keys);
  if (values.length === 0) {
    if (required) {
      throw new OpenCodeGoResponseError(
        "OpenCodeGo response is missing required rolling usage or reset data",
      );
    }
    return undefined;
  }
  let selected: number | null = null;
  for (const value of values) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const nested = parseResetSeconds([value as Record<string, unknown>], RESET_KEYS, false);
      if (nested !== undefined) {
        if (selected === null) selected = nested;
        continue;
      }
    }
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new OpenCodeGoResponseError(
        "OpenCodeGo reset seconds must be a finite non-negative safe integer",
      );
    }
    if (selected === null) selected = value;
  }
  if (selected === null) {
    if (required) {
      throw new OpenCodeGoResponseError("OpenCodeGo response is missing reset data");
    }
    return undefined;
  }
  return selected;
}

export function parseOpenCodeGoUsage(html: string): OpenCodeGoUsage {
  const records = extractUsageRecords(html);
  if (records === null || records.length === 0) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
    const cleanSnippet = html
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    throw new OpenCodeGoResponseError(
      `OpenCodeGo: Could not parse usage data from page HTML (title: "${titleMatch ?? "none"}", length: ${html.length}, text: "${cleanSnippet}")`,
    );
  }

  // Look for nested rollingUsage / weeklyUsage / monthlyUsage sub-records
  for (const r of records) {
    if (r["rollingUsage"] && isRecord(r["rollingUsage"])) {
      records.push(r["rollingUsage"]);
    }
    if (r["weeklyUsage"] && isRecord(r["weeklyUsage"])) {
      records.push(r["weeklyUsage"]);
    }
    if (r["monthlyUsage"] && isRecord(r["monthlyUsage"])) {
      records.push(r["monthlyUsage"]);
    }
  }

  const rollingRatio = parsePercentage(records, PERCENT_KEYS, true);
  const rollingReset = parseResetSeconds(records, RESET_KEYS, true);

  const weeklyRatio = parsePercentage(records, WEEKLY_PERCENT_KEYS, false);
  const weeklyReset = parseResetSeconds(records, WEEKLY_RESET_KEYS, false);

  const monthlyRatio = parsePercentage(records, MONTHLY_PERCENT_KEYS, false);
  const monthlyReset = parseResetSeconds(records, MONTHLY_RESET_KEYS, false);

  const isMonthlyCapped = monthlyRatio !== undefined && monthlyRatio >= 1.0;
  const isWeeklyCapped = weeklyRatio !== undefined && weeklyRatio >= 1.0;

  const effectiveRollingRatio = isMonthlyCapped || isWeeklyCapped ? 1.0 : rollingRatio;
  const effectiveWeeklyRatio =
    weeklyRatio !== undefined ? (isMonthlyCapped ? 1.0 : weeklyRatio) : undefined;
  const effectiveRollingReset = isMonthlyCapped || isWeeklyCapped ? undefined : rollingReset;
  const effectiveWeeklyReset = isMonthlyCapped ? undefined : weeklyReset;

  return {
    rollingUsageRatio: effectiveRollingRatio,
    weeklyUsageRatio: effectiveWeeklyRatio,
    monthlyUsageRatio: monthlyRatio,
    rollingResetSeconds: effectiveRollingReset,
    weeklyResetSeconds: effectiveWeeklyReset,
    monthlyResetSeconds: monthlyReset,
  };
}

export type OpenCodeZenBilling = {
  readonly monthlyUsageUSD: number;
  readonly monthlyLimitUSD: number | null;
  readonly balanceUSD: number | null;
  readonly hasSubscription: boolean;
};

const USD_SCALE = 100_000_000.0;

export function extractWorkspaceId(html: string): string | null {
  return html.match(/(wrk_[a-zA-Z0-9]+)/)?.[1] ?? null;
}

export function extractZenBilling(text: string): OpenCodeZenBilling | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      const usage = parsed["monthlyUsage"] ?? parsed["usage"];
      const limit = parsed["monthlyLimit"] ?? parsed["limit"];
      const balance = parsed["balance"] ?? parsed["zenBalance"];
      if (typeof usage === "number" && Number.isFinite(usage)) {
        return {
          monthlyUsageUSD: usage > 1000 ? usage / USD_SCALE : usage,
          monthlyLimitUSD:
            typeof limit === "number" && Number.isFinite(limit)
              ? limit > 1000
                ? limit / USD_SCALE
                : limit
              : null,
          balanceUSD:
            typeof balance === "number" && Number.isFinite(balance)
              ? balance > 1000
                ? balance / USD_SCALE
                : balance
              : null,
          hasSubscription: Boolean(parsed["hasSubscription"] ?? parsed["subscription"]),
        };
      }
    }
  } catch {
    // Continue regex
  }

  const monthlyUsageMatch = text.match(
    /(?:"monthlyUsage"|monthlyUsage)\s*:\s*(?:\$R\[\d+\]\s*=\s*)?(-?[0-9]+(?:\.[0-9]+)?)/,
  );
  if (monthlyUsageMatch === null) return null;

  const rawUsage = Number(monthlyUsageMatch[1]);
  if (!Number.isFinite(rawUsage)) return null;

  const monthlyLimitMatch = text.match(
    /(?:"monthlyLimit"|monthlyLimit)\s*:\s*(?:\$R\[\d+\]\s*=\s*)?(-?[0-9]+(?:\.[0-9]+)?)/,
  );
  const rawLimit = monthlyLimitMatch !== null ? Number(monthlyLimitMatch[1]) : null;

  const balanceMatch = text.match(
    /(?:"balance"|balance|"zenBalance"|zenBalance)\s*:\s*(?:\$R\[\d+\]\s*=\s*)?(-?[0-9]+(?:\.[0-9]+)?)/,
  );
  const rawBalance = balanceMatch !== null ? Number(balanceMatch[1]) : null;

  const hasSubscriptionMatch = text.match(
    /(?:"hasSubscription"|hasSubscription)\s*:\s*(?:\$R\[\d+\]\s*=\s*)?(true|false)/i,
  );
  const hasSubscription =
    hasSubscriptionMatch !== null ? hasSubscriptionMatch[1]?.toLowerCase() === "true" : false;

  return {
    monthlyUsageUSD: rawUsage > 1000 ? rawUsage / USD_SCALE : rawUsage,
    monthlyLimitUSD:
      rawLimit !== null && Number.isFinite(rawLimit) && rawLimit >= 0
        ? rawLimit > 1000
          ? rawLimit / USD_SCALE
          : rawLimit
        : null,
    balanceUSD:
      rawBalance !== null && Number.isFinite(rawBalance) && rawBalance >= 0
        ? rawBalance > 1000
          ? rawBalance / USD_SCALE
          : rawBalance
        : null,
    hasSubscription,
  };
}

export function extractZenBalance(text: string): number | null {
  const billing = extractZenBilling(text);
  if (billing && billing.balanceUSD !== null) {
    return billing.balanceUSD;
  }
  const match = text.match(
    /(?:"balance"|balance|"zenBalance"|zenBalance)\s*:\s*(?:\$R\[\d+\]\s*=\s*)?(-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/,
  );
  if (match) {
    const raw = Number(match[1]);
    if (Number.isFinite(raw) && raw >= 0) {
      return raw > 1000 ? raw / USD_SCALE : raw;
    }
  }
  return null;
}
