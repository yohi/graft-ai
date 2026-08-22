# Grafana Cloud OTel Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure the existing OTel collector to send all three signals to Grafana Cloud and deploy Cloud-compatible dashboards and alert rules without breaking the self-hosted reference stack.

**Architecture:** Keep the current Alloy payload encoders, queues, retries, and self-hosted defaults. Add optional Cloud endpoint/auth interpolation to Compose, add `traces:write` to the Terraform Access Policy, and apply deployment-time datasource UID mapping to dashboard and alert payloads. The GitHub Cloud deployment must fail before any Grafana API call when required Cloud UIDs are missing.

**Tech Stack:** Go custom Alloy collector, Docker Compose, Terraform Grafana provider, Node.js ESM scripts, GitHub Actions, Node test runner.

## Global Constraints

- Preserve self-hosted defaults: `http://tempo:4318/v1/traces`, `http://loki:3100/loki/api/v1/push`, and `http://prometheus:9090/api/v1/otlp/v1/metrics`.
- Keep OTel Loki labels limited to `model`, `status_code`, `env`, and `gateway`.
- Never store credentials in tracked files, dashboard JSON, Terraform variables, or URLs.
- Grafana Cloud ingestion requires `logs:write`, `metrics:write`, and `traces:write` on the Cloud Access Policy token.
- Grafana dashboard and alert provisioning uses the existing Grafana Service Account token, not the telemetry Access Policy token.
- Run `make test`, `make typecheck`, `make fmt`, and `make validate` before completion.

---

### Task 1: Add datasource UID override helper

**Files:**
- Create: `scripts/grafana-datasource-overrides.mjs`
- Create: `tests/grafana-datasource-overrides.test.mjs`
- Modify: `Makefile:9,25`

**Interfaces:**
- `resolveGrafanaDatasourceOverrides(env = process.env)` returns an object mapping the self-hosted UIDs to Cloud UIDs. No variables returns `{}`; a partial set throws a clear configuration error; `GRAFANA_OTEL_DATASOURCE_UIDS_REQUIRED=true` with no complete set throws before network access.
- `rewriteGrafanaDatasourceUids(value, overrides)` returns a cloned JSON-compatible value and replaces only `uid` and `datasourceUid` values equal to `otel-prometheus`, `otel-loki`, or `otel-tempo`. It must preserve expression UID `-100` and unrelated UIDs.

- [ ] **Step 1: Write failing tests**

```js
test("maps all self-hosted OTel datasource UIDs", () => {
  const result = rewriteGrafanaDatasourceUids(
    { datasource: { uid: "otel-prometheus" }, data: [{ datasourceUid: "otel-loki" }] },
    { "otel-prometheus": "cloud-prom", "otel-loki": "cloud-loki" },
  );
  assert.deepEqual(result, {
    datasource: { uid: "cloud-prom" },
    data: [{ datasourceUid: "cloud-loki" }],
  });
});

test("requires all Cloud UIDs when Cloud mode is enabled", () => {
  assert.throws(
    () => resolveGrafanaDatasourceOverrides({ GRAFANA_OTEL_DATASOURCE_UIDS_REQUIRED: "true" }),
    /all three Grafana Cloud OTel datasource UID variables/,
  );
});
```

- [ ] **Step 2: Run the focused test and confirm the expected missing-export failure**

Run: `node --test tests/grafana-datasource-overrides.test.mjs`

Expected: FAIL because the helper module and exported functions do not exist yet.

- [ ] **Step 3: Implement the minimal pure helper**

Use the exact environment keys `GRAFANA_OTEL_PROMETHEUS_DATASOURCE_UID`, `GRAFANA_OTEL_LOKI_DATASOURCE_UID`, and `GRAFANA_OTEL_TEMPO_DATASOURCE_UID`. Return a new array/object recursively; do not mutate parsed dashboard or alert objects.

- [ ] **Step 4: Run the focused test and confirm it passes**

Run: `node --test tests/grafana-datasource-overrides.test.mjs`

Expected: PASS with all mapping, preservation, partial-config, and required-mode cases green.

- [ ] **Step 5: Add the helper and test to repository formatting and test targets**

Extend the existing Prettier list in `Makefile:9` and the Node test list in `Makefile:25` with the new files.

---

### Task 2: Apply UID mapping to dashboard and alert API payloads

**Files:**
- Modify: `scripts/deploy-dashboards.mjs:14-35,92-101,200-233`
- Modify: `scripts/deploy-alert-rules.mjs:5-8,69-71,85-164,202-234`
- Modify: `tests/deploy-dashboards.test.mjs`
- Modify: `tests/deploy-alert-rules.test.mjs`

**Interfaces:**
- `prepareDashboardPayload(input, { datasourceOverrides })` applies the cloned mapping before returning `dashboard`.
- `deployDashboard(filePath, { datasourceOverrides })` passes the mapping to payload preparation.
- `prepareAlertRule(rule, orgId, datasourceOverrides)` applies the cloned mapping before injecting the active org ID.
- Both CLI `main` functions resolve overrides from `env` and pass them through. A required Cloud-mode configuration error returns exit code 1 before resolving credentials or calling `fetch`.

- [ ] **Step 1: Add failing dashboard and alert payload tests**

Add assertions that a Cloud mapping changes dashboard panel/template datasource UIDs, alert `data[].datasourceUid`, and nested dashboard links while leaving `-100` unchanged. Add a test that `main(["--dry-run"], required-cloud-env-without-uids)` returns 1 without making HTTP calls.

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run: `node --test tests/deploy-dashboards.test.mjs tests/deploy-alert-rules.test.mjs`

Expected: FAIL only on the new mapping and preflight assertions.

- [ ] **Step 3: Implement payload mapping and Cloud preflight**

Import the helper, extend existing JSDoc option shapes, and map the parsed payload in memory. Keep source JSON files untouched. For dry-run, validate the mapping and report the same files and rule counts as today.

- [ ] **Step 4: Run the focused tests and confirm they pass**

Run: `node --test tests/deploy-dashboards.test.mjs tests/deploy-alert-rules.test.mjs`

Expected: PASS, including existing POST/PUT behavior and fresh timeout behavior.

- [ ] **Step 5: Run a safe payload-level manual check**

Run the two scripts with `--dry-run` and Cloud UID variables set to non-secret test values. Confirm output is validation-only and no Grafana URL or token is required.

---

### Task 3: Configure Alloy Compose and Terraform for Cloud ingestion

**Files:**
- Modify: `deploy/otel/docker-compose.yml:26-34`
- Modify: `deploy/otel/env.example:6-8`
- Modify: `terraform/grafana/main.tf:24-31,83-85`
- Modify: `terraform/grafana/README.md:1-5`
- Create: `tests/otel-cloud-config.test.mjs`

**Interfaces:**
- Compose interpolation overrides `OTEL_TEMPO_URL`, `OTEL_LOKI_URL`, `OTEL_PROMETHEUS_URL`, and the three `OTEL_*_AUTHORIZATION` variables while retaining current defaults.
- Terraform resource `grafana_cloud_access_policy.telemetry_write` scopes become exactly `logs:write`, `metrics:write`, and `traces:write`.

- [ ] **Step 1: Add a failing Compose/Terraform contract test**

Assert that Compose contains each Cloud-overridable variable with the current self-hosted fallback, that Authorization variables are passed without inline values, and that Terraform contains `traces:write` in the telemetry policy.

- [ ] **Step 2: Run the contract test and confirm it fails**

Run: `node --test tests/otel-cloud-config.test.mjs`

Expected: FAIL because the Compose interpolation and Terraform scope are not yet present.

- [ ] **Step 3: Implement configuration interpolation**

Use Compose `${VARIABLE:-existing-default}` expressions. Document Cloud signal-specific paths and Basic Authorization header values only as examples with placeholders in `env.example`; never add a real token.

- [ ] **Step 4: Add the trace scope and update module documentation**

Change the Access Policy description and output description from logs/metrics-only to logs/metrics/traces. Keep the existing output names stable so current Worker consumers continue working.

- [ ] **Step 5: Run focused configuration validation**

Run: `node --test tests/otel-cloud-config.test.mjs`, `docker compose -f deploy/otel/docker-compose.yml config`, and `terraform -chdir=terraform/grafana validate`.

Expected: all commands exit 0 without requiring Cloud credentials.

---

### Task 4: Update GitHub Actions and operator documentation

**Files:**
- Modify: `.github/workflows/deploy.yml:221-233`
- Modify: `README.md` OTel/CI sections
- Modify: `README.ja.md` corresponding OTel/CI sections
- Modify: `SPEC.md:126-142,254-265`
- Modify: `SPEC.ja.md` corresponding OTel/security sections
- Create: `docs/grafana-cloud-otel.md`
- Modify: `tests/deployment-contracts.test.mjs`

**Interfaces:**
- Workflow passes `GRAFANA_OTEL_DATASOURCE_UIDS_REQUIRED=true` and the three GitHub Environment Variables to both dashboard and alert deployment steps.
- Documentation distinguishes telemetry Access Policy secrets from Grafana Service Account API secrets and gives the exact operator sequence.

- [ ] **Step 1: Add failing workflow contract assertions**

Assert that both Grafana deployment steps pass the required flag and all three UID variables, while retaining the existing URL and Service Account token expression.

- [ ] **Step 2: Run the contract test and confirm it fails**

Run: `node --test tests/deployment-contracts.test.mjs`

Expected: FAIL on the missing Cloud OTel variables.

- [ ] **Step 3: Update the workflow**

Add only non-secret GitHub Environment Variable references for the three datasource UIDs and the required-mode flag. Do not add endpoint or token values to the workflow; Alloy runtime secrets remain deployment-environment configuration.

- [ ] **Step 4: Write the operator guide**

Document: obtain region-specific Cloud OTLP and Loki URLs from the Grafana Cloud OpenTelemetry tile, create a Cloud Access Policy with the three write scopes, set the three Alloy endpoint/auth variables, obtain actual Grafana datasource UIDs, set the three `production` Environment Variables, ensure the Service Account has alert provisioning permissions, run local validation, deploy, and verify traces/logs/metrics independently.

- [ ] **Step 5: Update the English/Japanese architecture and security references**

State that Cloud OTel export is supported through tenant-specific endpoints and credentials, while self-hosted defaults remain the local reference topology. Keep the 14-day payload log retention and four-label constraints.

- [ ] **Step 6: Run the workflow contract test**

Run: `node --test tests/deployment-contracts.test.mjs`

Expected: PASS.

---

### Task 5: Full verification and manual operator-surface QA

**Files:**
- No additional source files.

- [ ] **Step 1: Run changed-file diagnostics**

Run `lsp_diagnostics` for every changed `.mjs`, `.go`, `.tf`, `.yml`, `.json`, and Markdown file. Markdown diagnostics may report that no Markdown server is configured; record that limitation rather than creating agent configuration.

- [ ] **Step 2: Run repository gates**

Run: `make test`, `make typecheck`, `make fmt`, and `make validate`.

- [ ] **Step 3: Run OTel-specific gates**

Run: `make otel-validate`, `make otel-contracts`, and `make -C deploy/otel/alloy test`.

- [ ] **Step 4: Run the Cloud-mode dry-run**

Set only non-secret test UIDs and `GRAFANA_OTEL_DATASOURCE_UIDS_REQUIRED=true`; run both deploy scripts with `--dry-run`. Confirm the scripts validate without making network requests and that tracked JSON files have not changed.

- [ ] **Step 5: Report the live Cloud steps that require user credentials**

The operator must run Terraform apply in the Terraform Cloud workspace, configure Alloy runtime environment/secrets, set GitHub `production` variables/secrets, and execute a real synthetic OTLP trace. These cannot be verified locally without the user's Grafana Cloud credentials and must not be simulated by printing secrets.
