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
const otelTerraform = readFileSync(resolve(root, "terraform/otel.tf"), "utf8");
const makefile = readFileSync(resolve(root, "Makefile"), "utf8");
const setup = readFileSync(resolve(root, "scripts/setup.sh"), "utf8");
const grafanaMain = readFileSync(
  resolve(root, "terraform/grafana/main.tf"),
  "utf8",
);
const grafanaReadme = readFileSync(
  resolve(root, "terraform/grafana/README.md"),
  "utf8",
);
const tfApplyGrafana = readFileSync(
  resolve(root, "scripts/tf-apply-grafana.sh"),
  "utf8",
);
const alerts = JSON.parse(
  readFileSync(
    resolve(root, "grafana/alerts/graft-ai-otel-rules.json"),
    "utf8",
  ),
);
const freeTierOtelGuide = readFileSync(
  resolve(root, "docs/free-tier-ai-gateway-otel.md"),
  "utf8",
);
const otelRunbook = readFileSync(
  resolve(root, "docs/cloudflare-worker-ai-gateway-otel.md"),
  "utf8",
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

test("Free Tier OTel DLQs use the Cloudflare Queue retention limit", () => {
  const dlqBlock =
    otelTerraform.match(
      /resource "cloudflare_queue" "otel_dlq"[\s\S]*?(?=\nresource |\s*$)/,
    )?.[0] ?? "";
  assert.match(dlqBlock, /message_retention_period\s*=\s*86400/);
  assert.doesNotMatch(dlqBlock, /message_retention_period\s*=\s*345600/);
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

test("Grafana Cloud deployment uses OTEL datasource variables in required mode", () => {
  assert.equal(
    (deploy.match(/GRAFANA_OTEL_DATASOURCE_UIDS_REQUIRED/g) ?? []).length,
    2,
  );
  for (const name of [
    "GRAFANA_OTEL_PROMETHEUS_DATASOURCE_UID",
    "GRAFANA_OTEL_LOKI_DATASOURCE_UID",
    "GRAFANA_OTEL_TEMPO_DATASOURCE_UID",
  ]) {
    assert.match(deploy, new RegExp(name));
  }
  assert.doesNotMatch(
    deploy,
    /GRAFANA_(PROMETHEUS|LOKI|TEMPO)_DATASOURCE_UID(?!S_REQUIRED)/,
  );
});

test("OTel Worker deployment renders the Terraform-created KV namespace config", () => {
  assert.match(
    deploy,
    /-target=cloudflare_workers_kv_namespace\.otel_payloads/,
  );
  assert.match(deploy, /otel_payload_kv_namespace_id/);
  assert.match(deploy, /render-otel-worker-config\.mjs/);
  assert.match(deploy, /\.wrangler\/otel\.generated\.jsonc/);
  assert.match(
    deploy,
    /secret put "\$name" --config \.wrangler\/otel\.generated\.jsonc/,
  );
  assert.match(
    deploy,
    /command: deploy --config \.wrangler\/otel\.generated\.jsonc/,
  );

  assert.match(makefile, /render-otel-worker-config:/);
  assert.match(makefile, /OTEL_PAYLOAD_KV_NAMESPACE_ID/);
  assert.match(makefile, /render-otel-worker-config\.mjs/);
  assert.match(makefile, /workers\/\.wrangler\/otel\.generated\.jsonc/);

  assert.match(
    otelRunbook,
    /-target=cloudflare_workers_kv_namespace\.otel_payloads/,
  );
  assert.match(otelRunbook, /otel_payload_kv_namespace_id/);
  assert.match(otelRunbook, /make render-otel-worker-config/);
  assert.match(otelRunbook, /\.wrangler\/otel\.generated\.jsonc/);
});

test("Terraform separates the Loki-only token from the telemetry token", () => {
  const lokiPolicyStart = grafanaMain.indexOf(
    'resource "grafana_cloud_access_policy" "loki_ingest"',
  );
  const lokiTokenStart = grafanaMain.indexOf(
    'resource "grafana_cloud_access_policy_token" "loki_ingest"',
  );
  assert.ok(lokiPolicyStart >= 0);
  assert.ok(lokiTokenStart > lokiPolicyStart);

  const lokiPolicy = grafanaMain.slice(lokiPolicyStart, lokiTokenStart);
  assert.match(lokiPolicy, /scopes\s*=\s*\["logs:write"\]/);
  assert.doesNotMatch(lokiPolicy, /metrics:write|traces:write/);
  assert.match(
    grafanaMain,
    /output "grafana_loki_write_token"[\s\S]*grafana_cloud_access_policy_token\.loki_ingest\.token/,
  );
  assert.match(
    grafanaMain,
    /output "grafana_telemetry_write_token"[\s\S]*grafana_cloud_access_policy_token\.telemetry_write\.token/,
  );
});

test("Terraform migration and setup scripts use the current resource addresses", () => {
  assert.match(
    grafanaMain,
    /moved\s*\{[\s\S]*from\s*=\s*grafana_cloud_access_policy\.loki_write[\s\S]*to\s*=\s*grafana_cloud_access_policy\.telemetry_write[\s\S]*\}/,
  );
  assert.match(
    grafanaMain,
    /moved\s*\{[\s\S]*from\s*=\s*grafana_cloud_access_policy_token\.loki_write[\s\S]*to\s*=\s*grafana_cloud_access_policy_token\.telemetry_write[\s\S]*\}/,
  );
  assert.match(setup, /-target=grafana_cloud_access_policy\.telemetry_write/);
  assert.match(setup, /-target=grafana_cloud_access_policy\.loki_ingest/);
  assert.match(
    setup,
    /terraform output -raw grafana_loki_write_token[\s\S]*terraform output -raw grafana_telemetry_write_token/,
  );
  assert.doesNotMatch(setup, /-target=.*\.loki_write/);
  assert.match(
    grafanaReadme,
    /terraform import grafana_cloud_access_policy\.telemetry_write/,
  );
  assert.match(
    grafanaReadme,
    /terraform import grafana_cloud_access_policy\.loki_ingest/,
  );
  assert.match(tfApplyGrafana, /grafana_loki_write_token/);
  assert.match(tfApplyGrafana, /grafana_telemetry_write_token/);
});

test("Free Tier OTel guide uses the Tunnel and does not require Logpush", () => {
  for (const text of [
    "https://<otel-public-hostname>/v1/traces",
    "Authorization: Bearer <OTEL_INGEST_TOKEN>",
    "OTEL_GRAFANA_CLOUD_LOGS_RETENTION",
    "OTEL_INGEST_TOKEN must be set and non-empty",
    "OTEL_RATE_LIMIT_HMAC_KEY must be set and non-empty",
    "CLOUDFLARED_TUNNEL_TOKEN must be set and non-empty",
    "OTEL_INGEST_TOKEN and OTEL_RATE_LIMIT_HMAC_KEY must differ",
    "set -euo pipefail",
    "chmod 600 deploy/otel/.env.grafana-cloud",
    "grafana_admin_password",
    "graft-ai-otel-observability",
    "graft-ai-aig-overview",
  ]) {
    assert.match(
      freeTierOtelGuide,
      new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  assert.match(freeTierOtelGuide, /does not use Workers Logpush/);
});
