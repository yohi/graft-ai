import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveGrafanaDatasourceUids,
  resolveGrafanaToken,
  resolveGrafanaUrl,
  rewriteGrafanaDatasourceUids,
} from "./deploy-dashboards.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_FILES = [
  "grafana/alerts/graft-ai-ollama-cloud-rules.json",
  "grafana/alerts/graft-ai-otel-rules.json",
];

/**
 * @param {string[]} args
 * @returns {{ dryRun: boolean, targetFiles: string[] }}
 */
export function parseCliArgs(args = []) {
  const supportedFlags = new Set(["--dry-run"]);
  let dryRun = false;
  const targetFiles = [];

  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (!supportedFlags.has(arg)) {
        throw new Error(`Unknown option: ${arg}`);
      }
      dryRun = true;
    } else {
      targetFiles.push(arg);
    }
  }

  return {
    dryRun,
    targetFiles: targetFiles.length > 0 ? targetFiles : DEFAULT_FILES,
  };
}

/**
 * @param {string | object} input
 * @returns {object[]}
 */
export function parseAlertRules(input) {
  const rules = typeof input === "string" ? JSON.parse(input) : input;
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error("Alert rule JSON must be a non-empty array");
  }

  for (const [index, rule] of rules.entries()) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error(`Alert rule at index ${index} must be an object`);
    }
    if (typeof rule.uid !== "string" || rule.uid.trim() === "") {
      throw new Error(`Alert rule at index ${index} must have a uid`);
    }
  }

  return rules;
}

/**
 * @param {object} rule
 * @param {number} orgId
 * @returns {object}
 */
export function prepareAlertRule(rule, orgId, datasourceUids) {
  const prepared = { ...rule, orgId };
  return datasourceUids
    ? rewriteGrafanaDatasourceUids(prepared, datasourceUids)
    : prepared;
}

/**
 * @param {string} filePath
 * @param {{
 *   grafanaUrl?: string,
 *   token?: string,
 *   datasourceUids?: import("./deploy-dashboards.mjs").DatasourceUids,
 *   dryRun?: boolean,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<object>}
 */
export async function deployAlertRuleFile(filePath, options = {}) {
  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Alert rule file not found: ${filePath}`);
  }

  const rules = parseAlertRules(readFileSync(resolvedPath, "utf8"));
  if (options.dryRun) {
    return {
      success: true,
      dryRun: true,
      filePath,
      ruleCount: rules.length,
      uids: rules.map((rule) => rule.uid),
    };
  }

  const grafanaUrl = options.grafanaUrl || resolveGrafanaUrl();
  const token = options.token || resolveGrafanaToken();
  const fetchFn = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestSignal = () => options.signal ?? AbortSignal.timeout(timeoutMs);
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const org = await requestJson(fetchFn, `${grafanaUrl}/api/org/`, {
    method: "GET",
    headers,
    signal: requestSignal(),
  });
  const orgId =
    org && typeof org === "object" && !Array.isArray(org) && "id" in org
      ? Number(org.id)
      : Number.NaN;
  if (!Number.isSafeInteger(orgId) || orgId <= 0) {
    throw new Error("Grafana organization response did not contain a valid id");
  }

  const rulesEndpoint = `${grafanaUrl}/api/v1/provisioning/alert-rules`;
  const existing = await requestJson(fetchFn, rulesEndpoint, {
    method: "GET",
    headers,
    signal: requestSignal(),
  });
  if (!Array.isArray(existing)) {
    throw new Error("Grafana alert rule response was not an array");
  }

  const existingUids = new Set(
    existing
      .filter((rule) => rule && typeof rule.uid === "string")
      .map((rule) => rule.uid),
  );
  const deployed = [];

  for (const rule of rules) {
    const exists = existingUids.has(rule.uid);
    const method = exists ? "PUT" : "POST";
    const endpoint = exists
      ? `${rulesEndpoint}/${encodeURIComponent(rule.uid)}`
      : rulesEndpoint;
    await requestJson(fetchFn, endpoint, {
      method,
      headers,
      signal: requestSignal(),
      body: JSON.stringify(
        prepareAlertRule(rule, orgId, options.datasourceUids),
      ),
    });
    deployed.push({ uid: rule.uid, method });
  }

  return {
    success: true,
    dryRun: false,
    filePath,
    ruleCount: rules.length,
    deployed,
  };
}

/**
 * @param {typeof fetch} fetchFn
 * @param {string} endpoint
 * @param {RequestInit} options
 * @returns {Promise<unknown>}
 */
async function requestJson(fetchFn, endpoint, options) {
  const response = await fetchFn(endpoint, options);
  const responseText = await response.text();
  let result = {};
  if (responseText.trim() !== "") {
    try {
      result = JSON.parse(responseText);
    } catch {
      result = {};
    }
  }

  if (!response.ok) {
    const message =
      result && typeof result === "object" && typeof result.message === "string"
        ? result.message
        : "request failed";
    throw new Error(
      `Grafana alert API request failed: ${response.status} - ${message}`,
    );
  }
  return result;
}

/**
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<number>}
 */
export async function main(args = process.argv.slice(2), env = process.env) {
  let parsed;
  try {
    parsed = parseCliArgs(args);
  } catch (error) {
    console.error(
      `[ERROR] ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  let grafanaUrl;
  let token;
  let datasourceUids;
  try {
    datasourceUids = resolveGrafanaDatasourceUids(env);
  } catch (error) {
    console.error(
      `[ERROR] ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  if (!parsed.dryRun) {
    try {
      grafanaUrl = resolveGrafanaUrl(env);
      token = resolveGrafanaToken(env);
    } catch (error) {
      console.error(
        `[ERROR] ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }

  let hasError = false;
  for (const file of parsed.targetFiles) {
    try {
      const result = await deployAlertRuleFile(file, {
        grafanaUrl,
        token,
        dryRun: parsed.dryRun,
        datasourceUids,
      });
      if (result.dryRun) {
        console.log(
          `[DRY-RUN] Validated ${result.ruleCount} alert rules from ${file}`,
        );
      } else {
        console.log(
          `[OK] Deployed ${result.ruleCount} alert rules from ${file}`,
        );
      }
    } catch (error) {
      console.error(
        `[ERROR] ${error instanceof Error ? error.message : String(error)}`,
      );
      hasError = true;
    }
  }

  return hasError ? 1 : 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().then((code) => {
    if (code !== 0) {
      process.exit(code);
    }
  });
}
