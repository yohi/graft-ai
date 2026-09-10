# Logpush Deployment

This runbook covers the Cloudflare AI Gateway Logpush path. It is an optional deployment path and is not part of the Free Tier proxy-only Quick Start.

## Requirements

- Node.js 22 and npm
- Terraform >= 1.5.0
- A Cloudflare account with AI Gateway and Logpush access
- A Grafana Cloud Loki endpoint, tenant username, and an Access Policy token with `logs:write`
- A Cloudflare API token with the permissions required by the Worker and Logpush/Terraform operations

Verify the exact Cloudflare token permissions against the current Cloudflare configuration and API before applying. Do not encode permission assumptions in application code.

## Data Flow

```text
Cloudflare AI Gateway
  -> Workers Logpush
  -> encrypted, gzip-compressed NDJSON
  -> graft-ai Logpush Worker
  -> decrypt and transform
  -> Grafana Cloud Loki
```

Technical contracts for authentication, decryption, labels, timestamp handling, retry behavior, and transformed log fields are canonical in [`SPEC.md`](../SPEC.md).

## First-Time Setup

From the repository root:

```bash
cd workers
npx wrangler login
cd ..
make install
cp workers/.dev.vars.example workers/.dev.vars
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
```

Keep `terraform/terraform.tfvars` limited to non-secret inputs. Set sensitive Terraform values with `TF_VAR_*` environment variables and Worker runtime secrets with Wrangler.

Register the Logpush Worker secrets from `workers/`:

```bash
cd workers
npx wrangler secret put ORIGIN_SECRET
npx wrangler secret put RSA_PRIVATE_KEY_PEM
npx wrangler secret put GRAFANA_CLOUD_LOKI_URL
npx wrangler secret put GRAFANA_CLOUD_LOKI_USERNAME
npx wrangler secret put GRAFANA_CLOUD_ACCESS_POLICY_TOKEN
cd ..
```

The corresponding Terraform-sensitive inputs include:

```bash
export TF_VAR_cloudflare_api_token="..."
export TF_VAR_cloudflare_account_id="..."
export TF_VAR_workers_subdomain="..."
export TF_VAR_origin_secret="..."
export TF_VAR_rsa_private_key_pem="..."
export TF_VAR_grafana_cloud_loki_url="..."
export TF_VAR_grafana_cloud_loki_username="..."
export TF_VAR_grafana_cloud_access_policy_token="..."
```

Before Terraform operations that invoke the Logpush cleanup helper, also provide `CF_API_TOKEN` in the shell used by the operation.

For non-secret Terraform inputs and current defaults, start from `terraform/terraform.tfvars.example`. The variable definitions in `terraform/variables.tf` are the machine-usable source for Terraform input names and validation.

## Validate and Deploy

Run the repository checks before deployment:

```bash
make typecheck
make test
make validate
```

Then deploy:

```bash
make deploy
```

`make deploy` deploys the Logpush Worker and applies the Terraform Logpush configuration. It is not the command for Free Tier proxy-only setup.

## Verification

Verify the path in stages:

1. Run `terraform plan` and inspect the planned Logpush changes.
2. Confirm the repository checks pass.
3. Exercise the Worker locally with a representative encrypted/gzipped NDJSON payload when changing ingestion behavior.
4. Send a real request through AI Gateway.
5. Confirm the resulting log reaches Loki.
6. Confirm the expected Grafana query/dashboard receives data.

If Logpush does not deliver, verify the configured dataset name against the Cloudflare account and confirm that the matching RSA public key is configured on the AI Gateway Logpush side.

## Security

- Never commit API tokens, Loki credentials, origin secrets, or RSA private keys.
- Upload only the RSA public key to the AI Gateway Logpush configuration.
- Keep the private key in secret storage.
- Use a Grafana Cloud Access Policy token scoped for Loki writes rather than a dashboard/service-account credential that is not intended for Loki ingestion.
- Optional request/response body collection can contain sensitive data; follow the redaction and payload contracts in [`SPEC.md`](../SPEC.md).

## Operations and Rollback

Monitor Worker errors, Logpush delivery status, and Loki/Grafana ingestion after deployment.

For general recovery and quota guidance, see [Operations](operations.md). For switching deployment paths or payload-store backends, see [Migration](migration.md).

## Related Sources

- `workers/wrangler.jsonc` — Logpush Worker deployment configuration
- `workers/src/index.ts` — Logpush ingress
- `terraform/variables.tf` — Terraform input definitions
- `terraform/terraform.tfvars.example` — non-secret example inputs
- [`SPEC.md`](../SPEC.md) — normative technical contracts
- [Configuration](configuration.md) — configuration ownership
