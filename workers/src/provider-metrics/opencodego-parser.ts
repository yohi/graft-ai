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

function extractBlock(text: string, name: string): Record<string, unknown> | null {
  const blockRegex = new RegExp(
    String.raw`(?:"?${name}"?)\s*:\s*(?:\$R\[\d+\]\s*=\s*)?\{([^}]+)\}`,
  );
  const match = blockRegex.exec(text);
  if (!match?.[1]) return null;
  const body = match[1];
  const percentMatch = /(?:"?usagePercent"?)\s*:\s*(\d+(?:\.\d+)?)/.exec(body);
  const resetMatch = /(?:"?resetInSec"?)\s*:\s*(\d+)/.exec(body);
  const res: Record<string, unknown> = {};
  if (percentMatch?.[1] !== undefined) {
    res[`${name}Percent`] = Number(percentMatch[1]);
  }
  if (resetMatch?.[1] !== undefined) {
    res[`${name}ResetInSec`] = Number(resetMatch[1]);
  }
  return Object.keys(res).length > 0 ? res : null;
}

function extractSolidStartUsageBlocks(text: string): Record<string, unknown>[] | null {
  const rolling = extractBlock(text, "rollingUsage");
  const weekly = extractBlock(text, "weeklyUsage");
  const monthly = extractBlock(text, "monthlyUsage");

  const combined: Record<string, unknown> = {};
  if (rolling?.["rollingUsagePercent"] !== undefined) {
    combined["rollingUsagePercent"] = rolling["rollingUsagePercent"];
  }
  if (rolling?.["rollingUsageResetInSec"] !== undefined) {
    combined["rollingResetInSec"] = rolling["rollingUsageResetInSec"];
  }
  if (weekly?.["weeklyUsagePercent"] !== undefined) {
    combined["weeklyUsagePercent"] = weekly["weeklyUsagePercent"];
  }
  if (weekly?.["weeklyUsageResetInSec"] !== undefined) {
    combined["weeklyResetInSec"] = weekly["weeklyUsageResetInSec"];
  }
  if (monthly?.["monthlyUsagePercent"] !== undefined) {
    combined["monthlyUsagePercent"] = monthly["monthlyUsagePercent"];
  }
  if (monthly?.["monthlyUsageResetInSec"] !== undefined) {
    combined["monthlyResetInSec"] = monthly["monthlyUsageResetInSec"];
  }
  return Object.keys(combined).length > 0 ? [combined] : null;
}

function extractFromSolidStart(html: string): Record<string, unknown>[] | null {
  const records: Record<string, unknown>[] = [];
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
  }

  return records.length === 0 ? null : records;
}

function parseDurationText(text: string): number | null {
  let seconds = 0;
  let matched = false;

  const daysMatch = /(\d+)\s*(?:日|days?|d\b)/i.exec(text);
  if (daysMatch?.[1] !== undefined) {
    seconds += Number(daysMatch[1]) * 86400;
    matched = true;
  }

  const hoursMatch = /(\d+)\s*(?:時間|hours?|h\b)/i.exec(text);
  if (hoursMatch?.[1] !== undefined) {
    seconds += Number(hoursMatch[1]) * 3600;
    matched = true;
  }

  const minsMatch = /(\d+)\s*(?:分|mins?|minutes?|m\b)/i.exec(text);
  if (minsMatch?.[1] !== undefined) {
    seconds += Number(minsMatch[1]) * 60;
    matched = true;
  }

  const secsMatch = /(\d+)\s*(?:秒|secs?|seconds?|s\b)/i.exec(text);
  if (secsMatch?.[1] !== undefined) {
    seconds += Number(secsMatch[1]);
    matched = true;
  }

  return matched ? seconds : null;
}

function extractPeriodFromDomText(
  text: string,
  labelRegex: RegExp,
): { percent: number; resetSec?: number } | null {
  const match = labelRegex.exec(text);
  if (!match?.[1]) return null;
  const percent = Number(match[1]);
  const durationText = match[2];
  const resetSec =
    durationText !== undefined ? (parseDurationText(durationText) ?? undefined) : undefined;
  return { percent, resetSec };
}

function extractFromDomText(html: string): Record<string, unknown>[] | null {
  const text = html.replace(/<[^>]+>/g, "\n");
  const record: Record<string, unknown> = {};

  const rolling = extractPeriodFromDomText(
    text,
    /(?:ローリング利用量|ローリング|Rolling\s*Usage)[^\d%]*(\d+(?:\.\d+)?)\s*%[\s\S]{0,200}?(?:リセットまで|Resets?\s*in)\s*([^\n\r]+)/i,
  );
  if (rolling) {
    record["rollingUsagePercent"] = rolling.percent;
    if (rolling.resetSec !== undefined) record["rollingResetInSec"] = rolling.resetSec;
  }

  const weekly = extractPeriodFromDomText(
    text,
    /(?:週間利用量|週間|Weekly\s*Usage)[^\d%]*(\d+(?:\.\d+)?)\s*%[\s\S]{0,200}?(?:リセットまで|Resets?\s*in)\s*([^\n\r]+)/i,
  );
  if (weekly) {
    record["weeklyUsagePercent"] = weekly.percent;
    if (weekly.resetSec !== undefined) record["weeklyResetInSec"] = weekly.resetSec;
  }

  const monthly = extractPeriodFromDomText(
    text,
    /(?:月間利用量|月間|Monthly\s*Usage)[^\d%]*(\d+(?:\.\d+)?)\s*%[\s\S]{0,200}?(?:リセットまで|Resets?\s*in)\s*([^\n\r]+)/i,
  );
  if (monthly) {
    record["monthlyUsagePercent"] = monthly.percent;
    if (monthly.resetSec !== undefined) record["monthlyResetInSec"] = monthly.resetSec;
  }

  return Object.keys(record).length > 0 ? [record] : null;
}

function extractFromTextFallback(html: string): Record<string, unknown>[] | null {
  const usageMatch =
    /"(?:usagePercent|rollingUsagePercent|usedPercent)"\s*:\s*(\d+(?:\.\d+)?)/i.exec(html);
  if (!usageMatch?.[1]) return null;
  const resetMatch = /"resetInSec(?:onds)?"\s*:\s*(\d+)/i.exec(html);
  const record: Record<string, unknown> = { usagePercent: Number(usageMatch[1]) };
  if (resetMatch?.[1] !== undefined) record["resetInSec"] = Number(resetMatch[1]);
  return [record];
}

function extractUsageRecords(html: string): Record<string, unknown>[] | null {
  return (
    extractFromSolidStart(html) ??
    extractFromNextData(html) ??
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
    for (const record of records) {
      if (Object.hasOwn(record, key)) {
        values.push(record[key]);
      }
    }
  }
  return values;
}

function parsePercentage(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
  required: boolean,
): number | undefined {
  const values = findOwnValues(records, keys);
  let selected: number | undefined;

  for (const value of values) {
    if (typeof value !== "number") continue;
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new OpenCodeGoResponseError(
        "OpenCodeGo usage percentage must be finite and between 0 and 100",
      );
    }
    selected ??= value / 100;
  }

  if (selected === undefined && required) {
    throw new OpenCodeGoResponseError(
      "OpenCodeGo response is missing required rolling usage or reset data",
    );
  }

  return selected;
}

function parseResetSeconds(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
  required: boolean,
): number | undefined {
  const values = findOwnValues(records, keys);
  let selected: number | undefined;

  for (const value of values) {
    if (typeof value !== "number") continue;
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
      throw new OpenCodeGoResponseError(
        "OpenCodeGo reset seconds must be a finite non-negative safe integer",
      );
    }
    selected ??= value;
  }

  if (selected === undefined && required) {
    throw new OpenCodeGoResponseError(
      "OpenCodeGo response is missing required rolling usage or reset data",
    );
  }

  return selected;
}

export function parseOpenCodeGoUsage(html: string): OpenCodeGoUsage {
  const records = extractUsageRecords(html);
  if (records === null || records.length === 0) {
    throw new OpenCodeGoResponseError("OpenCodeGo: Could not parse usage data");
  }

  const rollingRatio = parsePercentage(records, PERCENT_KEYS, true);
  if (rollingRatio === undefined) {
    throw new OpenCodeGoResponseError(
      "OpenCodeGo response is missing required rolling usage or reset data",
    );
  }
  const rollingReset = parseResetSeconds(records, RESET_KEYS, false);

  const weeklyRatio = parsePercentage(records, WEEKLY_PERCENT_KEYS, false);
  const weeklyReset = parseResetSeconds(records, WEEKLY_RESET_KEYS, false);

  const monthlyRatio = parsePercentage(records, MONTHLY_PERCENT_KEYS, false);
  const monthlyReset = parseResetSeconds(records, MONTHLY_RESET_KEYS, false);

  const isMonthlyCapped = monthlyRatio !== undefined && monthlyRatio >= 1.0;
  const isWeeklyCapped = weeklyRatio !== undefined && weeklyRatio >= 1.0;

  let effectiveWeeklyRatio: number | undefined;
  if (weeklyRatio !== undefined) {
    effectiveWeeklyRatio = isMonthlyCapped ? 1.0 : weeklyRatio;
  }

  return {
    rollingUsageRatio: isMonthlyCapped || isWeeklyCapped ? 1.0 : rollingRatio,
    weeklyUsageRatio: effectiveWeeklyRatio,
    monthlyUsageRatio: monthlyRatio,
    rollingResetSeconds: isMonthlyCapped || isWeeklyCapped ? undefined : rollingReset,
    weeklyResetSeconds: isMonthlyCapped ? undefined : weeklyReset,
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

function cleanNumericString(raw: string): string {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function parseNumericValue(val: unknown): number | null {
  if (typeof val === "string") {
    val = Number(cleanNumericString(val));
  }
  if (typeof val !== "number" || !Number.isFinite(val)) return null;
  return val;
}

// OpenCodeGo monthlyUsage in billing RPC is represented in integer nano-units (10^8 = $1.00 USD).
function parseNanoUsd(val: unknown, allowNegative = false): number | null {
  const num = parseNumericValue(val);
  if (num === null) return null;
  if (num < 0) return allowNegative ? 0 : null;
  return num / USD_SCALE;
}

// OpenCodeGo monthlyLimit in billing RPC is represented as a normal USD dollar amount (e.g. 10, 20, 2500).
function parseDollarAmount(val: unknown): number | null {
  const num = parseNumericValue(val);
  if (num === null || num < 0) return null;
  return num;
}

// OpenCodeGo balance / zenBalance can be integer nano-units in billing RPC (e.g. 5000000000 = $50.00) or pre-scaled decimal dollars in HTML (e.g. 23.45).
function parseZenBalanceValue(val: unknown): number | null {
  const num = parseNumericValue(val);
  if (num === null || num < 0) return null;
  // Decimal floating-point numbers from HTML (e.g. 23.45) are pre-scaled USD amounts.
  // Integer numbers from billing RPC (e.g. 5000000000) are nano-unit integers.
  return Number.isInteger(num) ? num / USD_SCALE : num;
}

function parseJsonBilling(text: string): OpenCodeZenBilling | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;

    const rawUsage = parsed["monthlyUsage"] ?? parsed["usage"];
    const monthlyUsageUSD = parseNanoUsd(rawUsage, true);
    if (monthlyUsageUSD === null) return null;

    const rawBalance = parsed["balance"] ?? parsed["zenBalance"];

    return {
      monthlyUsageUSD,
      monthlyLimitUSD: parseDollarAmount(parsed["monthlyLimit"] ?? parsed["limit"]),
      balanceUSD: rawBalance !== undefined && rawBalance !== null ? parseZenBalanceValue(rawBalance) : null,
      hasSubscription: Boolean(parsed["hasSubscription"] ?? parsed["subscription"]),
    };
  } catch {
    return null;
  }
}

function parseRegexBilling(text: string): OpenCodeZenBilling | null {
  const usageMatch =
    /(?:"monthlyUsage"|monthlyUsage)\s*:\s*(?:\$R\[\d+\]\s*=\s*)?([^\s,;{}]+)/.exec(text);
  if (!usageMatch?.[1]) return null;

  const monthlyUsageUSD = parseNanoUsd(usageMatch[1], true);
  if (monthlyUsageUSD === null) return null;

  const limitMatch =
    /(?:"monthlyLimit"|monthlyLimit)\s*:\s*(?:\$R\[\d+\]\s*=\s*)?([^\s,;{}]+)/.exec(text);
  const balanceMatch =
    /(?:"balance"|balance|"zenBalance"|zenBalance)\s*:\s*(?:\$R\[\d+\]\s*=\s*)?([^\s,;{}]+)/.exec(
      text,
    );
  const subMatch =
    /(?:"hasSubscription"|hasSubscription)\s*:\s*(?:\$R\[\d+\]\s*=\s*)?(true|false)/i.exec(text);

  return {
    monthlyUsageUSD,
    monthlyLimitUSD: limitMatch?.[1] ? parseDollarAmount(limitMatch[1]) : null,
    balanceUSD: balanceMatch?.[1] ? parseZenBalanceValue(balanceMatch[1]) : null,
    hasSubscription: subMatch !== null && subMatch[1]?.toLowerCase() === "true",
  };
}

export function extractZenBilling(text: string): OpenCodeZenBilling | null {
  return parseJsonBilling(text) ?? parseRegexBilling(text);
}

export function extractZenBalance(text: string): number | null {
  const billing = extractZenBilling(text);
  if (billing && billing.balanceUSD !== null) return billing.balanceUSD;

  // Embedded HTML page JSON or direct RPC response
  const match =
    /(?:"balance"|balance|"zenBalance"|zenBalance)\s*:\s*(?:\$R\[\d+\]\s*=\s*)?([^\s,;{}]+)/.exec(
      text,
    );
  return match?.[1] ? parseZenBalanceValue(match[1]) : null;
}
