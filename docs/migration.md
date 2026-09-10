# Migration

This document is the human-facing entry point for migrations that affect `graft-ai` deployments.

## Payload Store

The dedicated OTel Worker supports payload-store compatibility rules defined in [`../SPEC.md`](../SPEC.md).

The current default payload store is D1. Legacy payload references may still require compatibility with older KV or R2-backed data depending on the deployed schema/version.

Do not rewrite compatibility rules in migration notes; treat `SPEC.md` as the canonical contract.

## Moving to D1

When moving an existing deployment to D1:

1. Provision the D1 database and required schema.
2. Configure the Worker D1 binding.
3. Set the payload-store selector to D1.
4. Apply the repository's remote migration workflow.
5. Deploy the Worker.
6. Verify new payload writes and reads.
7. Verify any required legacy pointer reads before retiring older storage.

Use the dedicated OTel Worker runbook and deployment workflow for concrete commands.

## Rollback

Before changing or removing a previous payload-store backend, confirm that:

- new writes are succeeding on the target backend;
- queued items can still resolve their payload references;
- legacy payload references required by in-flight work remain readable;
- rollback configuration is available.

## Deployment-Path Changes

Moving between Free Tier proxy-only, Logpush, and the dedicated OTel Worker changes observability architecture rather than only configuration.

Use [Deployment](deployment.md) to choose the target path, then follow the path-specific runbook.

## Canonical Sources

- Normative compatibility and storage semantics: [`../SPEC.md`](../SPEC.md)
- Configuration reference: [Configuration](configuration.md)
- Deployment procedures: [Deployment](deployment.md)
- Operational recovery: [Operations](operations.md)
