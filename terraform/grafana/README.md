# terraform/grafana

Grafana Cloud provider module: manages the `grafana_cloud_access_policy`
(`logs:write` scope) and its `grafana_cloud_access_policy_token`, used by the
Free Tier proxy mode Tail Worker to push logs to Grafana Cloud Loki.

## Backend configuration

`versions.tf` declares an **empty** `# backend "s3" {}` block (currently
commented out). This is intentional and differs by execution path:

- **`scripts/setup.sh` (one-command setup):** runs `terraform init -input=false`
  directly with no `-backend-config` flags, so an active S3 backend block would
  either hang waiting for interactive backend input or fail outright. The
  backend block is kept commented out so `setup.sh` always falls back to the
  default **local** backend and completes non-interactively.
- **`scripts/tf-apply-grafana.sh` (manual/team/CI re-run):** requires
  `TF_BACKEND_CONFIG_FILE` to point at a `backend.hcl` supplying
  `bucket` / `key` / `region` (and optionally `dynamodb_table`) for a real S3
  backend, so state can be shared across machines. **Note:** because the
  `backend "s3" {}` block itself is commented out, `-backend-config` currently
  has no effect — Terraform still falls back to a local backend even when
  `TF_BACKEND_CONFIG_FILE` is set. If you need a real shared remote backend,
  uncomment the `backend "s3" {}` block in `versions.tf` before running
  `tf-apply-grafana.sh`, then re-run `terraform init -backend-config=...` to
  migrate the existing local state into S3 (Terraform will prompt to copy
  state on backend change — answer `yes`).

## Where does `terraform.tfstate` live?

With the local backend (the default when running `scripts/setup.sh`), state is
written to `terraform/grafana/terraform.tfstate` on the machine where the
script was run. This file (and `.terraform/`) is excluded from git via the
root `.gitignore` (`terraform/**/terraform.tfstate`, `terraform/**/.terraform/`).

**This means the state is machine-local and is *not* shared automatically.**
If you re-run `scripts/setup.sh` (or `tf-apply-grafana.sh`) on a different
machine, in CI, or after deleting `terraform/grafana/terraform.tfstate`,
Terraform has no record of the previously created Grafana resources and will
attempt to create a new `grafana_cloud_access_policy` /
`grafana_cloud_access_policy_token` with the same name, which the Grafana
Cloud API will reject (or create a duplicate, depending on the API's
uniqueness rules).

## Recovering / avoiding duplicate resource creation

Before re-running Terraform against an environment that may already have
these resources provisioned:

1. Check the Grafana Cloud Portal → **Administration → Cloud access policies**
   (`https://{stack}.grafana.net/admin/access-policies`) for an existing
   policy named `graft-ai-loki-write` and copy its **policy ID** and region.
   If a token named `graft-ai-loki-write-token` also exists, note its
   **token ID** too.
2. Import the existing resources into local state instead of letting
   `terraform apply` try to create them fresh:

   ```bash
   cd terraform/grafana
   terraform init -input=false
   terraform import grafana_cloud_access_policy.loki_write "<region_slug>:<policy_id>"
   terraform import grafana_cloud_access_policy_token.loki_write "<region_slug>:<token_id>"
   ```

   (`<region_slug>` is the stack's region, e.g. `prod-ap-northeast-0`.)
3. Run `terraform plan` to confirm no changes (or only expected changes, e.g.
   `expires_at` which is set to `ignore_changes`) before applying.

If you don't have (or don't want) the old token, delete the stale Access
Policy from the Grafana Cloud Portal first, then let `terraform apply` create
a fresh one — do not try to import a policy you intend to delete.

See also the root [`SPEC.md`](../../SPEC.md) for the general remote-backend
recommendation before production use.
