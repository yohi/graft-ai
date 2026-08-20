import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const deploy = readFileSync(
  resolve(root, ".github/workflows/deploy.yml"),
  "utf8",
);
const makefile = readFileSync(resolve(root, "Makefile"), "utf8");
const setup = readFileSync(resolve(root, "scripts/setup.sh"), "utf8");
const alerts = JSON.parse(
  readFileSync(
    resolve(root, "grafana/alerts/graft-ai-otel-rules.json"),
    "utf8",
  ),
);

test("PR Terraform plan uses read-only Grafana retention credentials", () => {
  assert.match(ci, /CLOUDFLARE_READONLY_API_TOKEN/);
  assert.match(ci, /GRAFANA_CLOUD_LOKI_READONLY_URL/);
  assert.match(ci, /GRAFANA_CLOUD_LOKI_READONLY_USERNAME/);
  assert.match(ci, /GRAFANA_CLOUD_LOKI_READONLY_TOKEN/);
  assert.doesNotMatch(
    ci,
    /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/,
  );
  assert.doesNotMatch(ci, /GRAFANA_CLOUD_ACCESS_POLICY_TOKEN/);
});

test("OTel backend alert rules cover exhaustion, drops, saturation, and ingress limiting", () => {
  const titles = new Set(alerts.map((rule) => rule.title));
  for (const title of [
    "OtelBackendExportExhausted",
    "OtelBackendDrops",
    "OtelBackendQueueSaturation",
    "OtelIngressRateLimited",
  ]) {
    assert.ok(titles.has(title), `missing alert ${title}`);
  }
  assert.ok(alerts.every((rule) => rule.for === "5m"));
});

test("Grafana deployment surfaces publish the OTel alert rules", () => {
  assert.match(deploy, /node scripts\/deploy-alert-rules\.mjs/);
  assert.match(makefile, /deploy-alert-rules:/);
  assert.match(setup, /graft-ai-otel\.json/);
  assert.match(setup, /graft-ai-otel-rules\.json/);
});
