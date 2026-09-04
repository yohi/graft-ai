# OTel Deploy Workflow Fix Design

## Context

GitHub Actions run `33907193888` failed only in the `Deploy dedicated OTel
Worker` job. The Worker upload and all configured bindings succeeded, but
Wrangler failed while updating the Cloudflare Schedule API at
`/accounts/{account}/workers/scripts/graft-ai-aig-otel/schedules`.

The merged D1 payload-store change also left `.github/workflows/deploy.yml`
on the previous KV-only deployment path. The workflow currently defaults to
`kv`, does not provision or expose the D1 database ID, and does not apply the
D1 migration before deployment. This can deploy a Worker that does not match
the source configuration and makes the scheduled D1 purge handler a no-op.

## Goals

- Make the production OTel deployment workflow consume the existing D1 payload
  store contract.
- Apply the D1 migration before deploying the Worker version that references
  the database.
- Preserve the daily Cron Trigger required for orphaned D1 payload cleanup.
- Add repository contract coverage so future workflow edits cannot silently
  revert to the KV-only path.
- Keep Cloudflare account-level Cron Trigger failures visible rather than
  suppressing them.

## Non-goals

- Do not remove or replace the daily Cron Trigger.
- Do not use `continue-on-error` for Schedule API failures.
- Do not change the OTel Worker runtime, D1 schema, or payload-store behavior.
- Do not include credentials or secret values in generated configuration,
  tests, or logs.
- Do not claim that the repository change resolves a Cloudflare account Cron
  Trigger quota. Free accounts allow five account-wide Cron Triggers and paid
  accounts allow 250; an exhausted account must be remediated in Cloudflare.

## Design

### Workflow configuration

Update `.github/workflows/deploy.yml` as follows:

1. Set the workflow-level `OTEL_PAYLOAD_STORE` fallback to `d1`.
2. Accept `d1` in the deployment-selection validation.
3. Add `cloudflare_d1_database.otel_payloads` to the Terraform targets used by
   `apply-cloudflare-infrastructure`.
4. Expose the Terraform output
   `otel_payload_d1_database_id` from the infrastructure job.
5. Pass that output to the OTel deployment job as
   `OTEL_PAYLOAD_D1_DATABASE_ID`.
6. Pass `--d1-database-id` to `render-otel-worker-config.mjs` when the D1
   selector is active.
7. Apply `graft-ai-aig-otel-payloads-v1` migrations remotely using the rendered
   configuration before the Worker deployment.

The existing KV namespace remains provisioned and passed to the renderer for
legacy pointer reads and explicit KV migrations. R2 remains conditional on
the existing selector and drain flag.

### Schedule handling

Keep `triggers.crons: ["0 4 * * *"]` in the generated configuration. This
trigger invokes the `scheduled` handler, which purges expired D1 rows outside
the request path. A Schedule API failure remains a deployment failure because
deploying without the cleanup trigger violates the D1 retention contract.

The current Wrangler release may display only the generic aggregated trigger
error. The workflow must not hide that failure; the operator should use the
Cloudflare account limits and dashboard/API response to remove an unused Cron
Trigger or upgrade the account plan when the account-wide limit is exhausted.

### Regression coverage

Extend `tests/deployment-contracts.test.mjs` to assert that the deployment
workflow contains:

- the `d1` default and selector validation;
- the D1 Terraform target and job output;
- the D1 database ID environment propagation;
- the renderer's `--d1-database-id` argument; and
- the remote migration command before deployment.

The existing OTel worker configuration tests continue to assert the daily
Cron Trigger and generated D1 binding contract.

## Verification

Run the focused deployment contract test first. Then run the repository gates
required by `AGENTS.md`:

- `make test`
- `make typecheck`
- `make fmt`
- `make validate`

Inspect the final diff and run secret scanning on changed file contents before
reporting completion. No production deployment is performed as part of local
verification.
