export type OpenCodeGoUsage = {
  readonly rollingUsageRatio: number;
  readonly weeklyUsageRatio?: number;
  readonly monthlyUsageRatio?: number;
  readonly rollingResetSeconds: number;
  readonly weeklyResetSeconds?: number;
  readonly monthlyResetSeconds?: number;
};

const PERCENT_KEYS = [
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
] as const;
const MONTHLY_PERCENT_KEYS = [
  "monthlyUsagePercent",
  "monthlyUsedPercent",
  "monthly_usage_percent",
] as const;
const RESET_KEYS = [
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
] as const;
const MONTHLY_RESET_KEYS = [
  "monthlyResetInSec",
  "monthlyResetInSeconds",
  "monthly_reset_in_sec",
] as const;
const USAGE_KEYS = [...PERCENT_KEYS, ...WEEKLY_PERCENT_KEYS, ...MONTHLY_PERCENT_KEYS] as const;
const UNSAFE_TRAVERSAL_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type UsageRecords = readonly Record<string, unknown>[];

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

function findUsageRecords(value: unknown): UsageRecords | null {
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
  return records.length === 0 ? null : records;
}

function parseJsonUsage(source: string): UsageRecords | null {
  try {
    const value: unknown = JSON.parse(source);
    return findUsageRecords(value);
  } catch {
    return null;
  }
}

function extractFromNextData(html: string): UsageRecords | null {
  const source = html
    .match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)?.[1]
    ?.trim();
  return source === undefined || source.length === 0 ? null : parseJsonUsage(source);
}

function extractFromScriptTags(html: string): UsageRecords | null {
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    const source = match[1]?.trim();
    if (source === undefined || source.length === 0) continue;
    const records = parseJsonUsage(source);
    if (records !== null) return records;
  }
  return null;
}

function extractFromRscHydration(html: string): UsageRecords | null {
  const records: Record<string, unknown>[] = [];
  for (const match of html.matchAll(
    /"(?:rollingUsage|weeklyUsage|monthlyUsage)"\s*,\s*(\{[^{}]+\})/g,
  )) {
    const source = match[1];
    if (source === undefined) continue;
    try {
      const value: unknown = JSON.parse(source);
      if (isRecord(value) && hasUsageKey(value)) records.push(value);
    } catch {
      continue;
    }
  }
  return records.length === 0 ? null : records;
}

function extractFromTextFallback(html: string): UsageRecords | null {
  const usageText = html.match(
    /"(?:usagePercent|rollingUsagePercent|usedPercent)"\s*:\s*(\d+(?:\.\d+)?)/,
  )?.[1];
  if (usageText === undefined) return null;
  const resetText = html.match(/"resetInSec(?:onds)?"\s*:\s*(\d+)/)?.[1];
  const record: Record<string, unknown> = { usagePercent: Number(usageText) };
  if (resetText !== undefined) record["resetInSec"] = Number(resetText);
  return [record];
}

function extractUsageRecords(html: string): UsageRecords | null {
  return (
    extractFromNextData(html) ??
    parseJsonUsage(html.trim()) ??
    extractFromScriptTags(html) ??
    extractFromRscHydration(html) ??
    extractFromTextFallback(html)
  );
}

function findOwnValues(records: UsageRecords, keys: readonly string[]): readonly unknown[] {
  const values: unknown[] = [];
  for (const key of keys) {
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index];
      if (record !== undefined && Object.hasOwn(record, key)) values.push(record[key]);
    }
  }
  return values;
}

function parsePercentage(records: UsageRecords, keys: readonly string[], required: true): number;
function parsePercentage(
  records: UsageRecords,
  keys: readonly string[],
  required: false,
): number | undefined;
function parsePercentage(
  records: UsageRecords,
  keys: readonly string[],
  required: boolean,
): number | undefined {
  const values = findOwnValues(records, keys);
  if (values.length === 0) {
    if (required)
      throw new OpenCodeGoResponseError(
        "OpenCodeGo response is missing required rolling usage or reset data",
      );
    return undefined;
  }
  let selected: number | null = null;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new OpenCodeGoResponseError(
        "OpenCodeGo usage percentage must be finite and between 0 and 100",
      );
    }
    if (selected === null) selected = value;
  }
  if (selected === null)
    throw new OpenCodeGoResponseError("OpenCodeGo response is missing usage data");
  return selected / 100;
}

function parseResetSeconds(records: UsageRecords, keys: readonly string[], required: true): number;
function parseResetSeconds(
  records: UsageRecords,
  keys: readonly string[],
  required: false,
): number | undefined;
function parseResetSeconds(
  records: UsageRecords,
  keys: readonly string[],
  required: boolean,
): number | undefined {
  const values = findOwnValues(records, keys);
  if (values.length === 0) {
    if (required)
      throw new OpenCodeGoResponseError(
        "OpenCodeGo response is missing required rolling usage or reset data",
      );
    return undefined;
  }
  let selected: number | null = null;
  for (const value of values) {
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
  if (selected === null)
    throw new OpenCodeGoResponseError("OpenCodeGo response is missing reset data");
  return selected;
}

export function parseOpenCodeGoUsage(html: string): OpenCodeGoUsage {
  const records = extractUsageRecords(html);
  if (records === null) {
    throw new OpenCodeGoResponseError("OpenCodeGo: Could not parse usage data from page HTML");
  }
  return {
    rollingUsageRatio: parsePercentage(records, PERCENT_KEYS, true),
    weeklyUsageRatio: parsePercentage(records, WEEKLY_PERCENT_KEYS, false),
    monthlyUsageRatio: parsePercentage(records, MONTHLY_PERCENT_KEYS, false),
    rollingResetSeconds: parseResetSeconds(records, RESET_KEYS, true),
    weeklyResetSeconds: parseResetSeconds(records, WEEKLY_RESET_KEYS, false),
    monthlyResetSeconds: parseResetSeconds(records, MONTHLY_RESET_KEYS, false),
  };
}

export function extractWorkspaceId(html: string): string | null {
  return html.match(/"(wrk_[a-zA-Z0-9]+)"/)?.[1] ?? null;
}

export function extractZenBalance(html: string): number | null {
  const value = html.match(/"zenBalance"\s*:\s*([^,\s}<]+)/)?.[1];
  if (value === undefined) return null;
  const balance = Number(value);
  return Number.isFinite(balance) && balance >= 0 ? balance : null;
}
