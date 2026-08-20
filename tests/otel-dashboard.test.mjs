import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const datasources = readFileSync(
  resolve(root, "deploy/otel/config/grafana/provisioning/datasources/datasources.yaml"),
  "utf8",
);

test("OTel dashboard keeps separate datasources and canonical panels", () => {
  const dashboard = JSON.parse(
    readFileSync(resolve(root, "grafana/dashboards/graft-ai-otel.json"), "utf8"),
  ).dashboard;
  assert.equal(dashboard.uid, "graft-ai-otel-observability");
  const titles = new Set(dashboard.panels.map((panel) => panel.title));
  for (const title of [
    "Total Requests",
    "Error Rate",
    "Request Duration",
    "Input Tokens",
    "Output Tokens",
    "Estimated Cost",
    "Recent Traces",
    "Sampling & Payload Safety",
  ]) {
    assert.ok(titles.has(title), `missing panel ${title}`);
  }
  const expectedByTitle = {
    "Total Requests": {
      datasourceUid: "otel-prometheus",
      targetDatasourceUid: null,
    },
    "Error Rate": {
      datasourceUid: "otel-prometheus",
      targetDatasourceUid: null,
    },
    "Request Duration": {
      datasourceUid: "otel-prometheus",
      targetDatasourceUid: null,
    },
    "Recent Traces": {
      datasourceUid: "otel-tempo",
      targetDatasourceUid: null,
    },
  };
  for (const panel of dashboard.panels) {
    const expected = expectedByTitle[panel.title];
    if (!expected) continue;
    assert.equal(
      panel.datasource?.uid,
      expected.datasourceUid,
      `${panel.title}: datasource uid mismatch`,
    );
    if (expected.targetDatasourceUid) {
      assert.equal(
        panel.targets?.[0]?.datasource?.uid,
        expected.targetDatasourceUid,
        `${panel.title}: target datasource uid mismatch`,
      );
    }
  }
  const recentTraces = dashboard.panels.find((panel) => panel.title === "Recent Traces");
  assert.equal(recentTraces.type, "traces");
  assert.equal(recentTraces.targets?.[0]?.queryType, "traceql");
  assert.equal(recentTraces.targets?.[0]?.tableType, "traces");
  assert.match(recentTraces.targets?.[0]?.query ?? "", /graft_ai\.request_span/);
  assert.equal(recentTraces.targets?.[0]?.limit, 20);
  assert.equal(recentTraces.targets?.[0]?.datasource?.uid, "otel-tempo");
  const serialized = JSON.stringify(dashboard);
  assert.doesNotMatch(serialized, /(?:Bearer\s|sk-|api[_-]?key|password\s*[:=])/i);
  assert.match(datasources, /filterByTraceID: true/);
  assert.match(datasources, /spanStartTimeShift: -5m/);
  assert.match(datasources, /spanEndTimeShift: 5m/);
});
