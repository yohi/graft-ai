import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");

test("OTel dashboard keeps separate datasources and canonical panels", () => {
  const dashboard = JSON.parse(
    readFileSync(resolve(root, "grafana/dashboards/graft-ai-otel.json"), "utf8"),
  ).dashboard;
  assert.equal(dashboard.uid, "graft-ai-otel-observability");
  const titles = new Set(dashboard.panels.map((panel) => panel.title));
  for (const title of ["Total Requests", "Error Rate", "Request Duration", "Redacted Payload Logs"]) {
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
    "Redacted Payload Logs": {
      datasourceUid: "otel-loki",
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
  const serialized = JSON.stringify(dashboard);
  assert.doesNotMatch(serialized, /(?:Bearer |sk-|api[_-]?key|password|token)/i);
});
