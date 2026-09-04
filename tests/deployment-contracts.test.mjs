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
const terraformVariables = readFileSync(
  resolve(root, "terraform/variables.tf"),
  "utf8",
);
const terraformOutputs = readFileSync(
  resolve(root, "terraform/outputs.tf"),
  "utf8",
);
const makefile = readFileSync(resolve(root, "Makefile"), "utf8");
const otelStorage = readFileSync(
  resolve(root, "workers/src/otel/storage.ts"),
  "utf8",
);
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
const readme = readFileSync(resolve(root, "README.md"), "utf8");
const readmeJa = readFileSync(resolve(root, "README.ja.md"), "utf8");
const spec = readFileSync(resolve(root, "SPEC.md"), "utf8");
const specJa = readFileSync(resolve(root, "SPEC.ja.md"), "utf8");
const otelRunbook = readFileSync(
  resolve(root, "docs/cloudflare-worker-ai-gateway-otel.md"),
  "utf8",
);
const validateDeploymentJob =
  deploy.match(
    /  validate-deployment:\n[\s\S]*?(?=\n  apply-cloudflare-infrastructure:)/,
  )?.[0] ?? "";
const otelDeploymentJob =
  deploy.match(
    /  deploy-otel-worker:\n[\s\S]*?(?=\n  deploy-proxy-worker:)/,
  )?.[0] ?? "";

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

test("OTel config rendering validates payload controls before namespace resolution", () => {
  const renderTarget =
    makefile.match(
      /render-otel-worker-config:\n([\s\S]*?)(?=\n\ndeploy-otel-worker:)/,
    )?.[1] ?? "";
  const namespaceResolution = renderTarget.indexOf("namespace_id=");
  const validationSteps = [
    'case "$(OTEL_PAYLOAD_STORE)" in d1|kv|r2)',
    'case "$(OTEL_PAYLOAD_R2_DRAIN)" in true|false)',
    'if [ "$(OTEL_PAYLOAD_STORE)" = r2 ] && [ "$(OTEL_PAYLOAD_R2_DRAIN)" = true ]',
  ];

  assert.notEqual(namespaceResolution, -1);
  for (const validationStep of validationSteps) {
    const validationPosition = renderTarget.indexOf(validationStep);
    assert.notEqual(
      validationPosition,
      -1,
      `missing validation: ${validationStep}`,
    );
    assert.ok(
      validationPosition < namespaceResolution,
      `validation must precede namespace resolution: ${validationStep}`,
    );
  }
});

test("OTel config rendering falls back to both Terraform payload IDs", () => {
  const renderTarget =
    makefile.match(
      /render-otel-worker-config:\n([\s\S]*?)(?=\n\ndeploy-otel-worker:)/,
    )?.[1] ?? "";
  const namespaceAssignment = renderTarget.indexOf(
    'namespace_id="$(OTEL_PAYLOAD_KV_NAMESPACE_ID)";',
  );
  const namespaceFallback = renderTarget.indexOf(
    "terraform -chdir=terraform output -raw otel_payload_kv_namespace_id 2>/dev/null || true",
  );
  const d1Assignment = renderTarget.indexOf(
    'd1_id="$(OTEL_PAYLOAD_D1_DATABASE_ID)";',
  );
  const d1Fallback = renderTarget.indexOf(
    "terraform -chdir=terraform output -raw otel_payload_d1_database_id 2>/dev/null || true",
  );

  assert.ok(namespaceAssignment >= 0);
  assert.ok(namespaceFallback > namespaceAssignment);
  assert.ok(d1Assignment >= 0);
  assert.ok(d1Fallback > d1Assignment);
});

test("classifyStoreFailure does not duplicate the temporary fallback", () => {
  assert.doesNotMatch(
    otelStorage,
    /if \(\/database is locked\|busy\|timeout\|network\/i\.test\(message\)\) \{\s*return new PayloadStoreTemporaryError\(`\$\{operation\} temporarily unavailable`\);\s*\}\s*return new PayloadStoreTemporaryError/,
  );
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

test("Grafana setup registers the OTLP endpoint credentials for scheduled metric Workers", () => {
  assert.match(
    tfApplyGrafana,
    /OTLP_USER=\$\(terraform output -raw grafana_otlp_username/,
  );
  assert.match(
    tfApplyGrafana,
    /OTLP_URL=\$\(terraform output -raw grafana_otlp_url/,
  );
  assert.match(tfApplyGrafana, /OTLP_URL="\$\{OTLP_URL%\//);

  for (const config of [
    "wrangler.ollama.jsonc",
    "wrangler.provider-metrics.jsonc",
  ]) {
    const escapedConfig = config.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      tfApplyGrafana,
      new RegExp(
        `echo "\\$\\{OTLP_URL\\}/otlp"[\\s\\S]*secret put GRAFANA_CLOUD_PROMETHEUS_URL[^\\r\\n]*--config ${escapedConfig}`,
      ),
    );
    assert.match(
      tfApplyGrafana,
      new RegExp(
        `echo "\\$OTLP_USER"[\\s\\S]*secret put GRAFANA_CLOUD_PROMETHEUS_USERNAME[^\\r\\n]*--config ${escapedConfig}`,
      ),
    );
  }
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

test("OTel infrastructure provisions a fixed KV namespace and exposes its ID", () => {
  assert.match(
    otelTerraform,
    /resource\s+"cloudflare_workers_kv_namespace"\s+"otel_payloads"/,
  );
  assert.match(
    otelTerraform,
    /title\s*=\s*var\.otel_payload_kv_namespace_title/,
  );
  assert.match(
    terraformVariables,
    /variable\s+"otel_payload_kv_namespace_title"[\s\S]*default\s*=\s*"graft-ai-aig-otel-payloads-v1"/,
  );
  assert.match(terraformVariables, /otel_payload_kv_namespace_title is fixed/);
  assert.match(
    terraformOutputs,
    /output\s+"otel_payload_kv_namespace_id"[\s\S]*cloudflare_workers_kv_namespace\.otel_payloads\.id/,
  );
});

test("OTel infrastructure provisions a fixed D1 database and exposes its ID", () => {
  assert.match(
    otelTerraform,
    /resource\s+"cloudflare_d1_database"\s+"otel_payloads"/,
  );
  assert.match(otelTerraform, /name\s*=\s*var\.otel_d1_database_name/);
  assert.match(
    terraformVariables,
    /variable\s+"otel_d1_database_name"[\s\S]*default\s*=\s*"graft-ai-aig-otel-payloads-v1"/,
  );
  assert.match(terraformVariables, /otel_d1_database_name is fixed/);
  assert.match(
    terraformOutputs,
    /output\s+"otel_payload_d1_database_id"[\s\S]*cloudflare_d1_database\.otel_payloads\.id/,
  );
  assert.match(makefile, /-target=cloudflare_d1_database\.otel_payloads/);
});

test("CI and deployment select D1 by default and render explicit KV/R2 modes", () => {
  assert.match(ci, /npm run test:otel:r2/);
  assert.match(ci, /npm run test:otel:kv-r2-drain/);
  assert.match(
    deploy,
    /OTEL_PAYLOAD_STORE: \$\{\{ vars\.OTEL_PAYLOAD_STORE \|\| 'd1' \}\}/,
  );
  assert.match(
    deploy,
    /OTEL_PAYLOAD_R2_DRAIN: \$\{\{ vars\.OTEL_PAYLOAD_R2_DRAIN \|\| 'false' \}\}/,
  );
  assert.match(
    validateDeploymentJob,
    /- name: Validate OTel payload store selection[\s\S]*?case "\$OTEL_PAYLOAD_STORE" in\s+d1\|kv\|r2\) ;;/,
  );
  assert.match(deploy, /render-otel-worker-config\.mjs/);
  assert.match(deploy, /otel_payload_kv_namespace_id/);
  assert.match(deploy, /-target=cloudflare_d1_database\.otel_payloads/);
  assert.match(deploy, /otel_payload_d1_database_id/);
  assert.match(deploy, /OTEL_PAYLOAD_D1_DATABASE_ID/);
  assert.match(makefile, /OTEL_PAYLOAD_STORE \?= d1/);
  assert.match(makefile, /OTEL_PAYLOAD_R2_DRAIN \?= false/);
  assert.match(makefile, /OTEL_PAYLOAD_KV_NAMESPACE_ID/);
  assert.match(makefile, /--include-r2-binding/);
});

test("OTel renderer scopes the D1 database ID to D1 deployments", () => {
  const renderStep =
    otelDeploymentJob.match(
      /- name: Render deployable OTel Worker config[\s\S]*?(?=\n      - name: Apply OTel D1 migrations)/,
    )?.[0] ?? "";
  const renderArgsStart = renderStep.indexOf("render_args=(");
  const d1BranchStart = renderStep.indexOf(
    'if [[ "$OTEL_PAYLOAD_STORE" == d1 ]]; then',
  );
  const r2BranchStart = renderStep.indexOf(
    'if [[ "$OTEL_PAYLOAD_STORE" == r2 || "$OTEL_PAYLOAD_R2_DRAIN" == true ]]; then',
  );

  assert.ok(renderArgsStart >= 0, "missing renderer argument block");
  assert.ok(d1BranchStart >= 0, "missing D1 renderer branch");
  assert.ok(r2BranchStart >= 0, "missing R2 renderer branch");
  assert.match(
    renderStep.slice(d1BranchStart, r2BranchStart),
    /render_args\+=\(--d1-database-id "\$OTEL_PAYLOAD_D1_DATABASE_ID"\)/,
  );
  assert.doesNotMatch(
    renderStep.slice(renderArgsStart, d1BranchStart),
    /--d1-database-id/,
  );
  const r2Branch = renderStep.slice(r2BranchStart);
  assert.match(r2Branch, /render_args\+=\(--include-r2-binding\)/);
  assert.doesNotMatch(r2Branch, /--d1-database-id/);
  assert.equal((renderStep.match(/--d1-database-id/g) ?? []).length, 1);
});

test("OTel D1 migration step receives credentials and uses the generated config before Worker deployment", () => {
  const migrationStep =
    otelDeploymentJob.match(
      /- name: Apply OTel D1 migrations[\s\S]*?(?=\n      - name: Sync dedicated OTel Worker secrets)/,
    )?.[0] ?? "";
  const migrationPosition = otelDeploymentJob.indexOf(
    "- name: Apply OTel D1 migrations",
  );
  const workerDeploymentPosition = otelDeploymentJob.indexOf(
    "- name: Deploy with Wrangler",
  );

  assert.ok(migrationPosition >= 0, "missing OTel D1 migration step");
  assert.ok(
    workerDeploymentPosition >= 0,
    "missing OTel Worker deployment step",
  );
  assert.ok(
    migrationPosition < workerDeploymentPosition,
    "D1 migration must precede OTel Worker deployment",
  );
  assert.match(
    migrationStep,
    /run:\s+\.\/node_modules\/\.bin\/wrangler d1 migrations apply graft-ai-aig-otel-payloads-v1 --remote --config \.wrangler\/otel\.generated\.jsonc/,
  );
  assert.match(
    migrationStep,
    /env:\s*\n\s+CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}\s*\n\s+CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/,
  );
});

test("OTel D1 migrations run only for the D1 payload store", () => {
  const migrationStep =
    otelDeploymentJob.match(
      /- name: Apply OTel D1 migrations[\s\S]*?(?=\n      - name: Sync dedicated OTel Worker secrets)/,
    )?.[0] ?? "";
  assert.match(migrationStep, /if:\s+env\.OTEL_PAYLOAD_STORE == 'd1'/);
});

test("OTel documentation defines KV as the default and documents quota-safe migration", () => {
  for (const text of [readme, spec]) {
    assert.match(text, /OTEL_PAYLOAD_STORE/);
    assert.match(text, /default.*KV|KV.*default/i);
    assert.match(text, /1 GB|1 GiB/);
    assert.match(text, /1,000.*writes.*day/i);
    assert.match(text, /100,000.*reads.*day/i);
    assert.match(text, /1,000.*deletes.*day/i);
    assert.match(text, /25 MiB/);
    assert.match(text, /60[- ]second/i);
    assert.match(text, /OTEL_OBJECTS/);
  }
  for (const text of [readmeJa, specJa]) {
    assert.match(text, /OTEL_PAYLOAD_STORE/);
    assert.match(text, /KV.*デフォルト|デフォルト.*KV/);
    assert.match(text, /1 GB|1 GiB/);
    assert.match(text, /1,000.*書き込み.*日/);
    assert.match(text, /100,000.*読み取り.*日/);
    assert.match(text, /1,000.*削除.*日/);
    assert.match(text, /25 MiB/);
    assert.match(text, /60秒|60 秒/);
    assert.match(text, /OTEL_OBJECTS/);
  }
  for (const [text, patterns] of [
    [readme, [/read/i, /write/i, /delete/i, /stored data/i]],
    [readmeJa, [/読み取り/, /書き込み/, /削除/, /保存データ/]],
  ]) {
    for (const pattern of patterns) assert.match(text, pattern);
  }
  assert.match(otelRunbook, /schema.?version.?1.*R2/i);
  assert.match(otelRunbook, /OTEL_PAYLOAD_R2_DRAIN/);
  assert.match(otelRunbook, /1,000.*writes.*day/i);
  assert.match(otelRunbook, /1,000.*delet.*day/i);
  assert.match(
    otelRunbook,
    /DEDUPLICATION_TOMBSTONE_MS.*PAYLOAD_RETENTION_FAILSAFE_MS/,
  );
  assert.doesNotMatch(
    readme,
    /R2 is required for the default OTel deployment/i,
  );
  assert.doesNotMatch(otelRunbook, /R2 lifecycle rule cleans up KV/i);
});
