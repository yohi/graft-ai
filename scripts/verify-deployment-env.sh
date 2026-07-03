#!/usr/bin/env bash
set -euo pipefail

missing=()

require_terraform_var() {
  local tf_var_name="$1"
  local raw_name="${tf_var_name^^}"
  local tf_env_name="TF_VAR_${tf_var_name}"
  local raw_value="${!raw_name:-}"
  local tf_value="${!tf_env_name:-}"

  if [[ -z "$raw_value" && -z "$tf_value" ]]; then
    missing+=("${raw_name} (or ${tf_env_name})")
  fi
}

require_terraform_var "origin_secret"
require_terraform_var "rsa_private_key_pem"
require_terraform_var "grafana_cloud_loki_url"
require_terraform_var "grafana_cloud_loki_username"
require_terraform_var "grafana_cloud_access_policy_token"
require_terraform_var "cloudflare_api_token"
require_terraform_var "cloudflare_account_id"
require_terraform_var "workers_subdomain"

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing required environment variables for deployment:" >&2
  for name in "${missing[@]}"; do
    echo "  - $name" >&2
  done
  exit 1
fi

echo "All required deployment environment variables are set."
