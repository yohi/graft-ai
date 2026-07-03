#!/usr/bin/env bash
set -euo pipefail

missing=()

require_var() {
  local name="$1"
  local tf_name="TF_VAR_${name}"
  local value="${!name:-}"
  local tf_value="${!tf_name:-}"

  if [[ -z "$value" && -z "$tf_value" ]]; then
    missing+=("${name} (or ${tf_name})")
  fi
}

require_var "ORIGIN_SECRET"
require_var "RSA_PRIVATE_KEY_PEM"
require_var "GRAFANA_CLOUD_LOKI_URL"
require_var "GRAFANA_CLOUD_LOKI_USERNAME"
require_var "GRAFANA_CLOUD_ACCESS_POLICY_TOKEN"
require_var "CLOUDFLARE_API_TOKEN"
require_var "CLOUDFLARE_ACCOUNT_ID"

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing required environment variables for deployment:" >&2
  for name in "${missing[@]}"; do
    echo "  - $name" >&2
  done
  exit 1
fi

echo "All required deployment environment variables are set."
