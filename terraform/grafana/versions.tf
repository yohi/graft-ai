terraform {
  required_version = ">= 1.5.0"

  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "~> 3.0"
    }
  }

  # Remote backend — configure via `-backend-config=path/to/backend.hcl`
  # or `-backend-config="key=value"` flags at `terraform init` time.
  # Do NOT hardcode bucket/key/region here; each environment must supply
  # its own backend config (see terraform/grafana/README or root SPEC.md).
  backend "s3" {}
}
