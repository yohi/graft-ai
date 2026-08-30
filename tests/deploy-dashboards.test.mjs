import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareDashboardPayload,
  resolveGrafanaUrl,
  resolveGrafanaToken,
  resolveGrafanaDatasourceUids,
  deployDashboard,
  parseCliArgs,
  main,
} from "../scripts/deploy-dashboards.mjs";

test("prepareDashboardPayload wraps raw dashboard JSON and sets overwrite to true", () => {
  const rawDashboard = {
    id: null,
    uid: "test-uid",
    title: "Test Dashboard",
    panels: [],
  };

  const payload = prepareDashboardPayload(rawDashboard);
  assert.equal(payload.overwrite, true);
  assert.equal(payload.folderUid, "");
  assert.equal(payload.dashboard.uid, "test-uid");
  assert.equal(payload.dashboard.title, "Test Dashboard");
});

test("prepareDashboardPayload handles wrapped dashboard JSON format", () => {
  const wrapped = {
    dashboard: {
      uid: "wrapped-uid",
      title: "Wrapped Dashboard",
    },
    folderUid: "custom-folder",
    overwrite: false,
    message: "custom message",
  };

  const payload = prepareDashboardPayload(wrapped);
  assert.equal(payload.overwrite, false);
  assert.equal(payload.folderUid, "custom-folder");
  assert.equal(payload.message, "custom message");
  assert.equal(payload.dashboard.uid, "wrapped-uid");
});

test("prepareDashboardPayload throws on missing title and uid", () => {
  assert.throws(() => prepareDashboardPayload({}), /missing title or uid/);
});

test("resolveGrafanaUrl prioritizes GRAFANA_URL over GRAFANA_STACK_SLUG", () => {
  assert.equal(
    resolveGrafanaUrl({
      GRAFANA_URL: "https://my-grafana.example.com/",
      GRAFANA_STACK_SLUG: "stack-slug",
    }),
    "https://my-grafana.example.com",
  );

  assert.equal(
    resolveGrafanaUrl({
      GRAFANA_STACK_SLUG: "my-stack",
    }),
    "https://my-stack.grafana.net",
  );
});

test("resolveGrafanaUrl throws when neither GRAFANA_URL nor GRAFANA_STACK_SLUG is set", () => {
  assert.throws(() => resolveGrafanaUrl({}), /Grafana URL is missing/);
});

test("resolveGrafanaToken resolves from available token env vars", () => {
  assert.equal(
    resolveGrafanaToken({ GRAFANA_SERVICE_ACCOUNT_TOKEN: "sa-token-123" }),
    "sa-token-123",
  );
  assert.equal(
    resolveGrafanaToken({ GRAFANA_API_KEY: "api-key-456" }),
    "api-key-456",
  );
  assert.equal(
    resolveGrafanaToken({ GRAFANA_CLOUD_API_KEY: "cloud-key-789" }),
    "cloud-key-789",
  );
});

test("resolveGrafanaToken throws when no token is present", () => {
  assert.throws(() => resolveGrafanaToken({}), /Grafana token is missing/);
});

test("resolveGrafanaDatasourceUids reads and trims Grafana Cloud OTel UID variables", () => {
  assert.deepEqual(
    resolveGrafanaDatasourceUids({
      GRAFANA_OTEL_PROMETHEUS_DATASOURCE_UID: "  cloud-prom  ",
      GRAFANA_OTEL_LOKI_DATASOURCE_UID: "cloud-loki",
      GRAFANA_OTEL_TEMPO_DATASOURCE_UID: " cloud-tempo",
    }),
    {
      prometheus: "cloud-prom",
      loki: "cloud-loki",
      tempo: "cloud-tempo",
    },
  );
});

test("resolveGrafanaDatasourceUids preserves self-hosted defaults when required mode is disabled", () => {
  assert.deepEqual(resolveGrafanaDatasourceUids({}), {
    prometheus: "otel-prometheus",
    loki: "otel-loki",
    tempo: "otel-tempo",
  });
  assert.deepEqual(
    resolveGrafanaDatasourceUids({
      GRAFANA_OTEL_DATASOURCE_UIDS_REQUIRED: "false",
    }),
    {
      prometheus: "otel-prometheus",
      loki: "otel-loki",
      tempo: "otel-tempo",
    },
  );
});

test("resolveGrafanaDatasourceUids rejects partial optional UID configuration", () => {
  assert.throws(
    () =>
      resolveGrafanaDatasourceUids({
        GRAFANA_OTEL_LOKI_DATASOURCE_UID: "cloud-loki",
      }),
    /Partial Grafana Cloud OTel datasource UID/,
  );
});

test("resolveGrafanaDatasourceUids rejects partial required-mode configuration", () => {
  assert.throws(
    () =>
      resolveGrafanaDatasourceUids({
        GRAFANA_OTEL_DATASOURCE_UIDS_REQUIRED: "true",
        GRAFANA_OTEL_PROMETHEUS_DATASOURCE_UID: "cloud-prom",
        GRAFANA_OTEL_LOKI_DATASOURCE_UID: " ",
        GRAFANA_OTEL_TEMPO_DATASOURCE_UID: "cloud-tempo",
      }),
    /Grafana Cloud OTel datasource UIDs are required.*GRAFANA_OTEL_LOKI_DATASOURCE_UID/s,
  );
});

test("main fails required-mode UID validation before any Grafana API call", async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const errors = [];
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch must not be called");
  };
  console.error = (message) => errors.push(String(message));

  try {
    const exitCode = await main(["grafana/dashboards/graft-ai-overview.json"], {
      GRAFANA_URL: "https://grafana.example",
      GRAFANA_API_KEY: "test-token",
      GRAFANA_OTEL_DATASOURCE_UIDS_REQUIRED: "true",
      GRAFANA_OTEL_PROMETHEUS_DATASOURCE_UID: "cloud-prom",
      GRAFANA_OTEL_LOKI_DATASOURCE_UID: "cloud-loki",
    });

    assert.equal(exitCode, 1);
    assert.equal(fetchCalls, 0);
    assert.match(
      errors.join("\n"),
      /Grafana Cloud OTel datasource UIDs are required/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test("deployDashboard supports dry-run mode without making HTTP requests", async () => {
  const res = await deployDashboard(
    "grafana/dashboards/graft-ai-overview.json",
    {
      dryRun: true,
    },
  );
  assert.equal(res.success, true);
  assert.equal(res.dryRun, true);
  assert.equal(res.uid, "graft-ai-aig-overview");
});

test("deployDashboard sends HTTP POST to /api/dashboards/db and handles success", async () => {
  let capturedUrl = "";
  let capturedHeaders = {};
  let capturedBody = null;

  const mockFetch = async (url, options) => {
    capturedUrl = url;
    capturedHeaders = options.headers;
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          id: 1,
          slug: "graft-ai-overview",
          status: "success",
          uid: "graft-ai-aig-overview",
          url: "/d/graft-ai-aig-overview/graft-ai-overview",
          version: 2,
        }),
    };
  };

  const res = await deployDashboard(
    "grafana/dashboards/graft-ai-overview.json",
    {
      grafanaUrl: "https://my-stack.grafana.net",
      token: "test-token",
      fetchImpl: mockFetch,
    },
  );

  assert.equal(capturedUrl, "https://my-stack.grafana.net/api/dashboards/db");
  assert.equal(capturedHeaders.Authorization, "Bearer test-token");
  assert.equal(capturedBody.dashboard.uid, "graft-ai-aig-overview");
  assert.equal(res.status, "success");
  assert.equal(
    res.url,
    "https://my-stack.grafana.net/d/graft-ai-aig-overview/graft-ai-overview",
  );
});

test("deployDashboard throws meaningful error on HTTP failure", async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 403,
    text: async () => JSON.stringify({ message: "Access denied" }),
  });

  await assert.rejects(
    () =>
      deployDashboard("grafana/dashboards/graft-ai-overview.json", {
        grafanaUrl: "https://my-stack.grafana.net",
        token: "bad-token",
        fetchImpl: mockFetch,
      }),
    /Failed to deploy dashboard.*403 - Access denied/,
  );
});

test("main CLI runner returns 0 for successful dry-run", async () => {
  const exitCode = await main(["--dry-run"]);
  assert.equal(exitCode, 0);
});

test("parseCliArgs defaults to standard dashboard files and dryRun false", () => {
  const parsed = parseCliArgs([]);
  assert.equal(parsed.dryRun, false);
  assert.deepEqual(parsed.targetFiles, [
    "grafana/dashboards/graft-ai-overview.json",
    "grafana/dashboards/graft-ai-ollama-cloud.json",
    "grafana/dashboards/graft-ai-provider-metrics.json",
    "grafana/dashboards/graft-ai-otel.json",
  ]);
});

test("parseCliArgs parses --dry-run and positional arguments", () => {
  const parsed = parseCliArgs(["--dry-run", "custom/dashboard.json"]);
  assert.equal(parsed.dryRun, true);
  assert.deepEqual(parsed.targetFiles, ["custom/dashboard.json"]);
});

test("parseCliArgs rejects unsupported options", () => {
  assert.throws(() => parseCliArgs(["--dryrun"]), /Unknown option: --dryrun/);
  assert.throws(
    () => parseCliArgs(["--unsupported-flag"]),
    /Unknown option: --unsupported-flag/,
  );
});

test("main CLI runner returns 1 when unknown option like --dryrun is provided", async () => {
  const exitCode = await main(["--dryrun"]);
  assert.equal(exitCode, 1);
});

test("deployDashboard passes AbortSignal to fetchFn", async () => {
  let capturedSignal = null;
  const mockFetch = async (url, options) => {
    capturedSignal = options.signal;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ uid: "graft-ai-aig-overview", status: "success" }),
    };
  };

  await deployDashboard("grafana/dashboards/graft-ai-overview.json", {
    grafanaUrl: "https://my-stack.grafana.net",
    token: "test-token",
    fetchImpl: mockFetch,
  });

  assert.ok(capturedSignal instanceof AbortSignal);
});
