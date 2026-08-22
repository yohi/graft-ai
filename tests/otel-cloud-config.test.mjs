import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  resolveGrafanaDatasourceUids,
  rewriteGrafanaDatasourceUids,
} from "../scripts/deploy-dashboards.mjs";
import { prepareAlertRule } from "../scripts/deploy-alert-rules.mjs";

test("resolves self-hosted datasource UID defaults and Cloud overrides", () => {
  assert.deepEqual(resolveGrafanaDatasourceUids({}), {
    prometheus: "otel-prometheus",
    loki: "otel-loki",
    tempo: "otel-tempo",
  });
  assert.deepEqual(
    resolveGrafanaDatasourceUids({
      GRAFANA_PROMETHEUS_DATASOURCE_UID: "grafanacloud-prom",
      GRAFANA_LOKI_DATASOURCE_UID: "grafanacloud-logs",
      GRAFANA_TEMPO_DATASOURCE_UID: "grafanacloud-traces",
    }),
    {
      prometheus: "grafanacloud-prom",
      loki: "grafanacloud-logs",
      tempo: "grafanacloud-traces",
    },
  );
});

test("rewrites only OTel datasource references and preserves expression UIDs", () => {
  const source = {
    datasource: { type: "prometheus", uid: "otel-prometheus" },
    nested: [
      { datasourceUid: "otel-loki" },
      { datasource: { type: "tempo", uid: "otel-tempo" } },
      { datasourceUid: "-100" },
      { uid: "unrelated-dashboard-uid" },
    ],
  };

  const rewritten = rewriteGrafanaDatasourceUids(source, {
    prometheus: "cloud-prom",
    loki: "cloud-loki",
    tempo: "cloud-tempo",
  });

  assert.deepEqual(rewritten, {
    datasource: { type: "prometheus", uid: "cloud-prom" },
    nested: [
      { datasourceUid: "cloud-loki" },
      { datasource: { type: "tempo", uid: "cloud-tempo" } },
      { datasourceUid: "-100" },
      { uid: "unrelated-dashboard-uid" },
    ],
  });
  assert.deepEqual(source.nested[0], { datasourceUid: "otel-loki" });
});

test("rewrites alert rule datasource UID while preserving expression datasource", () => {
  const rule = {
    uid: "example",
    data: [
      { datasourceUid: "otel-prometheus" },
      { datasourceUid: "-100", model: { datasource: { uid: "-100" } } },
    ],
  };

  assert.deepEqual(prepareAlertRule(rule, 42, { prometheus: "cloud-prom" }), {
    uid: "example",
    orgId: 42,
    data: [
      { datasourceUid: "cloud-prom" },
      { datasourceUid: "-100", model: { datasource: { uid: "-100" } } },
    ],
  });
});

test("Grafana Cloud Compose override requires external endpoints and auth headers", () => {
  const compose = readFileSync(
    "deploy/otel/docker-compose.grafana-cloud.yml",
    "utf8",
  );

  for (const variable of [
    "OTEL_TEMPO_URL",
    "OTEL_TEMPO_AUTHORIZATION",
    "OTEL_LOKI_URL",
    "OTEL_LOKI_AUTHORIZATION",
    "OTEL_PROMETHEUS_URL",
    "OTEL_PROMETHEUS_AUTHORIZATION",
  ]) {
    assert.match(compose, new RegExp(`\\$\\{${variable}:\\?`));
  }
  assert.doesNotMatch(compose, /Basic\\s+[A-Za-z0-9+/=]{20,}/);
  assert.match(compose, /depends_on: \[\]/);
});
