import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Normalizes dashboard payload for Grafana HTTP API (/api/dashboards/db).
 * Accepts either wrapped format ({ dashboard: { ... }, overwrite: true })
 * or raw Grafana export format ({ id: null, uid: "...", ... }).
 *
 * @param {string | object} input JSON string or parsed object
 * @param {{ folderUid?: string, message?: string, overwrite?: boolean, datasourceUids?: DatasourceUids }} [options]
 * @returns {{ dashboard: object, folderUid: string, message: string, overwrite: boolean }}
 */
export function prepareDashboardPayload(input, options = {}) {
  const data = typeof input === "string" ? JSON.parse(input) : input;
  if (!data || typeof data !== "object") {
    throw new Error("Invalid dashboard JSON: expected an object");
  }

  const isWrapped = Boolean(
    data.dashboard && typeof data.dashboard === "object",
  );
  const dashboard = isWrapped ? data.dashboard : data;

  if (!dashboard.title && !dashboard.uid) {
    throw new Error("Invalid dashboard JSON: missing title or uid");
  }

  return {
    dashboard: options.datasourceUids
      ? rewriteGrafanaDatasourceUids(dashboard, options.datasourceUids)
      : dashboard,
    folderUid:
      options.folderUid ??
      (isWrapped && data.folderUid !== undefined ? data.folderUid : ""),
    message:
      options.message ??
      (isWrapped && data.message !== undefined
        ? data.message
        : "graft-ai dashboard sync (see git log for change details)"),
    overwrite:
      options.overwrite ??
      (isWrapped && typeof data.overwrite === "boolean"
        ? data.overwrite
        : true),
  };
}

const DEFAULT_DATASOURCE_UIDS = Object.freeze({
  prometheus: "otel-prometheus",
  loki: "otel-loki",
  tempo: "otel-tempo",
});

/**
 * @typedef {{ prometheus: string, loki: string, tempo: string }} DatasourceUids
 */

/**
 * Resolves datasource UIDs from environment variables while preserving the
 * self-hosted provisioning defaults.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {DatasourceUids}
 */
export function resolveGrafanaDatasourceUids(env = process.env) {
  const configured = {
    prometheus: env.GRAFANA_OTEL_PROMETHEUS_DATASOURCE_UID?.trim(),
    loki: env.GRAFANA_OTEL_LOKI_DATASOURCE_UID?.trim(),
    tempo: env.GRAFANA_OTEL_TEMPO_DATASOURCE_UID?.trim(),
  };
  const required =
    env.GRAFANA_OTEL_DATASOURCE_UIDS_REQUIRED?.trim().toLowerCase() === "true";

  if (required) {
    const missing = Object.entries(configured)
      .filter(([, uid]) => !uid)
      .map(([signal]) => `GRAFANA_OTEL_${signal.toUpperCase()}_DATASOURCE_UID`);
    if (missing.length > 0) {
      throw new Error(
        `Grafana Cloud OTel datasource UIDs are required when GRAFANA_OTEL_DATASOURCE_UIDS_REQUIRED=true. Missing: ${missing.join(", ")}`,
      );
    }
  } else {
    const provided = Object.values(configured).filter(Boolean);
    if (provided.length > 0 && provided.length < 3) {
      throw new Error(
        "Partial Grafana Cloud OTel datasource UID configuration is not allowed. Provide all three UIDs or none.",
      );
    }
  }

  return {
    prometheus: configured.prometheus || DEFAULT_DATASOURCE_UIDS.prometheus,
    loki: configured.loki || DEFAULT_DATASOURCE_UIDS.loki,
    tempo: configured.tempo || DEFAULT_DATASOURCE_UIDS.tempo,
  };
}

/**
 * Rewrites only datasource references from the self-hosted OTel dashboard.
 * The input is not mutated.
 *
 * @param {unknown} value
 * @param {DatasourceUids} overrides
 * @returns {unknown}
 */
export function rewriteGrafanaDatasourceUids(value, overrides) {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteGrafanaDatasourceUids(item, overrides));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const source = /** @type {Record<string, unknown>} */ (value);
  const rewritten = {};
  for (const [key, item] of Object.entries(source)) {
    const replacement =
      key === "uid" || key === "datasourceUid"
        ? datasourceUidReplacement(item, overrides)
        : item;
    rewritten[key] = rewriteGrafanaDatasourceUids(replacement, overrides);
  }
  return rewritten;
}

/**
 * @param {unknown} value
 * @param {DatasourceUids} overrides
 * @returns {unknown}
 */
function datasourceUidReplacement(value, overrides) {
  if (value === DEFAULT_DATASOURCE_UIDS.prometheus) {
    return overrides.prometheus;
  }
  if (value === DEFAULT_DATASOURCE_UIDS.loki) {
    return overrides.loki;
  }
  if (value === DEFAULT_DATASOURCE_UIDS.tempo) {
    return overrides.tempo;
  }
  return value;
}

/**
 * Resolves Grafana URL from environment or explicit option.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function resolveGrafanaUrl(env = process.env) {
  let url = env.GRAFANA_URL || env.GRAFANA_INSTANCE_URL;
  if (!url && env.GRAFANA_STACK_SLUG) {
    url = `https://${env.GRAFANA_STACK_SLUG}.grafana.net`;
  }
  if (!url) {
    throw new Error(
      "Grafana URL is missing. Set GRAFANA_URL or GRAFANA_STACK_SLUG environment variable.",
    );
  }
  return url.replace(/\/+$/, "");
}

/**
 * Resolves Grafana API token from environment.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function resolveGrafanaToken(env = process.env) {
  const token =
    env.GRAFANA_API_KEY ||
    env.GRAFANA_SERVICE_ACCOUNT_TOKEN ||
    env.GRAFANA_TOKEN ||
    env.GRAFANA_CLOUD_API_KEY;
  if (!token) {
    throw new Error(
      "Grafana token is missing. Set GRAFANA_API_KEY or GRAFANA_SERVICE_ACCOUNT_TOKEN environment variable.",
    );
  }
  return token.trim();
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Deploys a dashboard JSON file to Grafana Cloud / Grafana instance.
 *
 * @param {string} filePath Path to dashboard JSON file
 * @param {{
 *   grafanaUrl?: string,
 *   token?: string,
 *   folderUid?: string,
 *   datasourceUids?: DatasourceUids,
 *   dryRun?: boolean,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 * }} options
 */
export async function deployDashboard(filePath, options = {}) {
  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Dashboard file not found: ${filePath}`);
  }

  const rawContent = readFileSync(resolvedPath, "utf8");
  const payload = prepareDashboardPayload(rawContent, {
    folderUid: options.folderUid,
    datasourceUids: options.datasourceUids,
  });

  const title = payload.dashboard.title || "Untitled";
  const uid = payload.dashboard.uid || "no-uid";

  if (options.dryRun) {
    return {
      success: true,
      dryRun: true,
      uid,
      title,
      filePath,
      status: "validated",
    };
  }

  const grafanaUrl = options.grafanaUrl || resolveGrafanaUrl();
  const token = options.token || resolveGrafanaToken();
  const fetchFn = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = options.signal ?? AbortSignal.timeout(timeoutMs);

  const endpoint = `${grafanaUrl}/api/dashboards/db`;
  const response = await fetchFn(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });

  const responseText = await response.text();
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    result = { raw: responseText };
  }

  if (!response.ok) {
    const errorMsg =
      result.message ||
      result.error ||
      responseText ||
      `HTTP ${response.status}`;
    throw new Error(
      `Failed to deploy dashboard "${title}" (${uid}): ${response.status} - ${errorMsg}`,
    );
  }

  return {
    success: true,
    dryRun: false,
    uid: result.uid || uid,
    title,
    url: result.url ? `${grafanaUrl}${result.url}` : undefined,
    status: result.status || "success",
    version: result.version,
    filePath,
  };
}

/**
 * Parses and validates CLI arguments.
 *
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
      if (arg === "--dry-run") {
        dryRun = true;
      }
    } else {
      targetFiles.push(arg);
    }
  }

  const defaultFiles = [
    "grafana/dashboards/graft-ai-overview.json",
    "grafana/dashboards/graft-ai-ollama-cloud.json",
    "grafana/dashboards/graft-ai-provider-metrics.json",
    "grafana/dashboards/graft-ai-otel.json",
  ];

  return {
    dryRun,
    targetFiles: targetFiles.length > 0 ? targetFiles : defaultFiles,
  };
}

/**
 * Main entry point for CLI usage.
 */
export async function main(args = process.argv.slice(2), env = process.env) {
  let parsed;
  try {
    parsed = parseCliArgs(args);
  } catch (err) {
    console.error(
      `[ERROR] ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const { dryRun, targetFiles } = parsed;

  let grafanaUrl;
  let token;
  let datasourceUids;
  try {
    datasourceUids = resolveGrafanaDatasourceUids(env);
  } catch (err) {
    console.error(
      `[ERROR] ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (!dryRun) {
    try {
      grafanaUrl = resolveGrafanaUrl(env);
      token = resolveGrafanaToken(env);
    } catch (err) {
      console.error(
        `[ERROR] ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  }

  let hasError = false;

  for (const file of targetFiles) {
    try {
      const res = await deployDashboard(file, {
        grafanaUrl,
        token,
        dryRun,
        folderUid: env.GRAFANA_FOLDER_UID,
        datasourceUids,
      });

      if (res.dryRun) {
        console.log(
          `[DRY-RUN] Validated "${res.title}" (uid: ${res.uid}) from ${file}`,
        );
      } else {
        console.log(
          `[OK] Deployed "${res.title}" (uid: ${res.uid}) - status: ${res.status}${res.url ? ` (${res.url})` : ""}`,
        );
      }
    } catch (err) {
      console.error(
        `[ERROR] ${err instanceof Error ? err.message : String(err)}`,
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
