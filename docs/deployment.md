# Deployment

This document routes users to the correct deployment path. Detailed subsystem procedures remain in their dedicated runbooks.

## Free Tier Proxy

Use this first unless you specifically need Logpush or the dedicated OTel Worker.

```bash
make setup-free-tier
```

See [Free Tier AI Gateway + OTel](free-tier-ai-gateway-otel.md) for the complete walkthrough and verification steps.

## Logpush

Use Logpush when your Cloudflare plan and observability requirements call for AI Gateway log export.

See [Logpush Deployment](logpush.md) for first-time setup, secrets, Terraform inputs, deployment, and verification.

## Dedicated OTel Worker

Use the dedicated OTel Worker for the queue-backed ingestion path with payload storage and OTLP export.

See [Dedicated Cloudflare Worker AI Gateway OTel](cloudflare-worker-ai-gateway-otel.md).

Production-size payload handling on this path may require Workers Paid; follow the current runbook rather than assuming Free Tier limits are sufficient.

## Terraform

Terraform provisions shared Cloudflare resources used by the deployment paths.

Start with `terraform/terraform.tfvars.example`, then apply the repository's Terraform workflow for the path you are deploying.

## Verification

Every deployment path should finish with an observable success condition:

- Proxy: an authenticated request receives a successful AI Gateway response.
- Observability path: the expected trace/log/metric reaches the configured backend.
- Dedicated OTel Worker: ingestion, queue processing, and export complete according to the runbook.

For failure handling and rollback guidance, see [Operations](operations.md).
