# terraform/grafana

Grafana Cloud provider module: manages the `grafana_cloud_access_policy`
(`logs:write` scope) and its `grafana_cloud_access_policy_token`, used by the
Free Tier proxy mode Tail Worker to push logs to Grafana Cloud Loki.

## Terraform Cloud backend

`versions.tf` uses the Terraform Cloud organization `graft-ai` and workspace
`graft-ai-grafana`. All normal Grafana Terraform commands therefore use the
Terraform Cloud workspace state; do not pass S3 `-backend-config` arguments or
set `TF_BACKEND_CONFIG_FILE`.

Authenticate the Terraform CLI before the first initialization:

```bash
terraform login app.terraform.io
```

For non-interactive environments, provide a Terraform Cloud API token through
the standard `TF_TOKEN_app_terraform_io` environment variable instead. The
Terraform Cloud token is separate from `TF_VAR_grafana_cloud_api_key`, which
authenticates the Grafana provider.

The normal setup paths preserve the provider selected in
`.terraform.lock.hcl`:

```bash
make setup-free-tier
make setup-grafana
make apply-grafana
```

These paths run `terraform init` without `-upgrade`. To intentionally upgrade
the Grafana provider, use an explicit procedure from this directory:

```bash
terraform login app.terraform.io
terraform init -upgrade
terraform plan
```

Review the resulting `.terraform.lock.hcl` change before applying it.

## Migrating existing local state

The Terraform Cloud backend configuration is already present in
`versions.tf`. If a previous setup created
`terraform/grafana/terraform.tfstate` locally, migrate it before running an
automated setup command on that checkout:

1. Authenticate to Terraform Cloud as described above and confirm access to
   organization `graft-ai` and workspace `graft-ai-grafana`.
2. From this directory, make a backup of the local state outside the repository
   or in a protected location.
3. Initialize the configured backend and approve the state copy when prompted:

   ```bash
   cd terraform/grafana
   terraform init -migrate-state
   ```

4. Confirm the state is available in the `graft-ai-grafana` workspace, then run
   `terraform plan` to check for unexpected changes.
5. After migration, remove the local `terraform.tfstate` and any backup only
   after verifying that the Terraform Cloud state is complete and usable.

If Terraform reports that the local state is absent, the workspace may already
be initialized remotely. Run `terraform init` and continue with `terraform
plan`; do not recreate resources solely because a local state file is missing.

## Existing resources and state recovery

If resources were created by a previous local state that cannot be recovered,
check the Grafana Cloud Portal → **Administration → Cloud access policies**
(`https://{stack}.grafana.net/admin/access-policies`) before applying. An
existing policy or token may need to be imported into the Terraform Cloud
workspace:

```bash
cd terraform/grafana
terraform init
terraform import grafana_cloud_access_policy.loki_write "<region_slug>:<policy_id>"
terraform import grafana_cloud_access_policy_token.loki_write "<region_slug>:<token_id>"
terraform plan
```

`<region_slug>` is the stack's region, for example
`prod-ap-northeast-0`. If the old token is intentionally discarded, delete the
stale Access Policy from the Grafana Cloud Portal first and let Terraform
create a fresh one instead of importing it.

See also the root [`SPEC.md`](../../SPEC.md) for the general Terraform backend
and security requirements.
