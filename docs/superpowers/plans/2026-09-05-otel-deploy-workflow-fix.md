# OTel Deploy Workflow Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the production OTel deployment workflow with the merged D1 payload-store contract while preserving the required daily Cron Trigger.

**Architecture:** Terraform provisions the D1 database alongside the existing KV namespace and exports its ID. The deployment job receives both IDs, renders a complete Worker configuration, applies the remote D1 migration, and deploys that configuration. Contract tests inspect the workflow text to prevent a silent return to the KV-only path.

**Tech Stack:** GitHub Actions YAML, Terraform, Node.js ESM contract tests, Wrangler, Cloudflare Workers D1 and Cron Triggers.

## Global Constraints

- Preserve `triggers.crons: ["0 4 * * *"]` for expired D1 payload cleanup.
- Do not suppress Schedule API failures with `continue-on-error`.
- Keep credentials in GitHub secrets; never add secret values to configuration or tests.
- Preserve the existing KV binding for legacy pointer reads and explicit KV deployments.
- Use the repository verification gates: `make test`, `make typecheck`, `make fmt`, and `make validate`.
- Do not perform a production deployment during local verification.

---

### Task 1: Add Failing Workflow Contract Assertions

**Files:**
- Modify: `tests/deployment-contracts.test.mjs:349-367`

**Interfaces:**
- Consumes: the current `.github/workflows/deploy.yml` text loaded as `deploy`.
- Produces: assertions for the D1 default, infrastructure target/output, D1 ID propagation, migration ordering, and generated-config deployment.

- [ ] **Step 1: Update the contract test expectations before changing the workflow**

Change the test name from `CI and deployment select KV by default and render explicit R2 modes` to `CI and deployment select D1 by default and render explicit KV/R2 modes`. Replace the `deploy` default assertion with:

```javascript
assert.match(
  deploy,
  /OTEL_PAYLOAD_STORE: \$\{\{ vars\.OTEL_PAYLOAD_STORE \|\| 'd1' \}\}/,
);
```

Add assertions that the workflow contains all of these exact deployment contracts:

```javascript
assert.match(deploy, /-target=cloudflare_d1_database\.otel_payloads/);
assert.match(deploy, /otel_payload_d1_database_id/);
assert.match(deploy, /OTEL_PAYLOAD_D1_DATABASE_ID/);
assert.match(deploy, /--d1-database-id/);
assert.match(
  deploy,
  /npx wrangler d1 migrations apply graft-ai-aig-otel-payloads-v1 --remote/,
);
```

Keep the existing R2 drain, renderer, KV ID, and generated-config assertions.

- [ ] **Step 2: Run the focused contract test and verify the expected failure**

Run:

```bash
node --test tests/deployment-contracts.test.mjs
```

Expected: the renamed test fails because `.github/workflows/deploy.yml` still uses the `kv` default and lacks the D1 propagation/migration strings.

---

### Task 2: Align OTel Deployment Workflow With D1

**Files:**
- Modify: `.github/workflows/deploy.yml:10-226`

**Interfaces:**
- Consumes: Terraform outputs `otel_payload_kv_namespace_id` and `otel_payload_d1_database_id`.
- Produces: a rendered OTel Worker configuration containing the selected storage binding and a migration-ready D1 database before deployment.

- [ ] **Step 1: Update workflow-level selector and validation**

Change the workflow fallback to:

```yaml
OTEL_PAYLOAD_STORE: ${{ vars.OTEL_PAYLOAD_STORE || 'd1' }}
```

Change the validation case from `kv|r2` to `d1|kv|r2`, preserving the existing R2 drain checks.

- [ ] **Step 2: Provision and expose the D1 database ID**

Add `otel_payload_d1_database_id` to the `apply-cloudflare-infrastructure` job outputs:

```yaml
otel_payload_d1_database_id: ${{ steps.read_otel_d1_database.outputs.database_id }}
```

Add `-target=cloudflare_d1_database.otel_payloads` to the unconditional Terraform target list. Add a following step with ID `read_otel_d1_database` that runs in `terraform`, reads `terraform output -raw otel_payload_d1_database_id`, validates it as a 32-character hexadecimal or UUID database ID, and writes `database_id=...` to `$GITHUB_OUTPUT`.

- [ ] **Step 3: Pass the D1 ID and apply the migration**

Add this environment variable to `deploy-otel-worker`:

```yaml
OTEL_PAYLOAD_D1_DATABASE_ID: ${{ needs.apply-cloudflare-infrastructure.outputs.otel_payload_d1_database_id }}
```

In `Render deployable OTel Worker config`, validate the new environment variable when `OTEL_PAYLOAD_STORE` is `d1`, append `--d1-database-id "$OTEL_PAYLOAD_D1_DATABASE_ID"` to `render_args`, and retain the conditional R2 flag.

Add a step after rendering and before secret sync/deployment:

```yaml
- name: Apply OTel D1 migrations
  working-directory: workers
  run: npx wrangler d1 migrations apply graft-ai-aig-otel-payloads-v1 --remote --config .wrangler/otel.generated.jsonc
```

The migration uses the same generated configuration that the deployment uses, so the database binding and database name cannot drift between the migration and Worker upload.

- [ ] **Step 4: Run the focused contract test and verify it passes**

Run:

```bash
node --test tests/deployment-contracts.test.mjs
```

Expected: all deployment contract tests pass.

---

### Task 3: Run Repository Verification

**Files:**
- Verify: `.github/workflows/deploy.yml`
- Verify: `tests/deployment-contracts.test.mjs`
- Verify: `docs/superpowers/specs/2026-09-05-otel-deploy-workflow-fix-design.md`

**Interfaces:**
- Consumes: the corrected workflow and contract tests.
- Produces: local evidence that repository tests, types, formatting, and Terraform validation pass without a production deployment.

- [ ] **Step 1: Run the required repository gates**

Run each command from the repository root:

```bash
make test
make typecheck
make fmt
make validate
```

Expected: each command exits with status 0. If `make fmt` changes files, inspect the changes and keep only formatter output belonging to this task.

- [ ] **Step 2: Validate workflow syntax and changed-file secrets hygiene**

Run the repository's workflow checks through `make test` and inspect the changed-file diff. Confirm that only secret names and GitHub expressions appear; no token, password, private key, or credential value is present.

- [ ] **Step 3: Record the remaining Cloudflare prerequisite**

Report separately that a Cloudflare account at its Cron Trigger limit can still reject the Schedule API request. The operator must remove an unused account-wide Cron Trigger or upgrade the plan before rerunning the deployment; the workflow must continue to fail rather than conceal that condition.
