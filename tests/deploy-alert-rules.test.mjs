import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deployAlertRuleFile,
  parseCliArgs,
  prepareAlertRule,
} from "../scripts/deploy-alert-rules.mjs";

test("default alert deployment targets include Ollama and OTel rules", () => {
  const parsed = parseCliArgs([]);

  assert.deepEqual(parsed, {
    dryRun: false,
    targetFiles: [
      "grafana/alerts/graft-ai-ollama-cloud-rules.json",
      "grafana/alerts/graft-ai-otel-rules.json",
    ],
  });
});

test("prepareAlertRule replaces the file org id with the active Grafana org", () => {
  const rule = { uid: "example", orgId: 1, title: "Example" };

  assert.deepEqual(prepareAlertRule(rule, 42), {
    uid: "example",
    orgId: 42,
    title: "Example",
  });
});

test("dry-run validates an alert rule file without Grafana credentials", async () => {
  const result = await deployAlertRuleFile(
    "grafana/alerts/graft-ai-otel-rules.json",
    {
      dryRun: true,
    },
  );

  assert.equal(result.success, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.ruleCount, 4);
});

test("deploys existing alert rules with PUT and new rules with POST", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/api/org/")) {
      return jsonResponse({ id: 42 });
    }
    if (url.endsWith("/api/v1/provisioning/alert-rules")) {
      return jsonResponse([{ uid: "graft-otel-backend-export-exhausted" }]);
    }
    return jsonResponse({ status: "success" });
  };

  const result = await deployAlertRuleFile(
    "grafana/alerts/graft-ai-otel-rules.json",
    {
      grafanaUrl: "https://grafana.example",
      token: "test-token",
      fetchImpl,
    },
  );

  assert.equal(result.success, true);
  assert.equal(result.ruleCount, 4);
  assert.equal(calls.length, 6);
  assert.equal(calls[2].options.method, "PUT");
  assert.equal(calls[3].options.method, "POST");
  assert.equal(calls[4].options.method, "POST");
  assert.equal(calls[5].options.method, "POST");
  assert.equal(JSON.parse(calls[2].options.body).orgId, 42);
  assert.equal(calls[2].options.headers.Authorization, "Bearer test-token");
});

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(value);
    },
  };
}
