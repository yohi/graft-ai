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

WRANGLER_SECRETS=()

load_wrangler_secrets() {
  local worker_name="${WORKER_NAME:-}"
  local wrangler_config="./wrangler.jsonc"
  local name_flag=()

  if [[ -n "$worker_name" ]]; then
    name_flag=(--name "$worker_name")
  fi

  local secret_list
  if ! secret_list=$(cd workers && npx wrangler secret list "${name_flag[@]:-}" --config "$wrangler_config" --format json 2>/dev/null); then
    echo "Warning: failed to list Wrangler secrets. Ensure CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are set." >&2
    return 1
  fi

  while IFS= read -r secret_name; do
    WRANGLER_SECRETS+=("$secret_name")
  done < <(printf '%s' "$secret_list" | jq -r '.[].name')
}

require_wrangler_secret() {
  local secret_name="$1"
  local found=0

  for s in "${WRANGLER_SECRETS[@]:-}"; do
    if [[ "$s" == "$secret_name" ]]; then
      found=1
      break
    fi
  done

  if [[ "$found" -eq 0 ]]; then
    missing+=("Wrangler secret: ${secret_name}")
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

if ! load_wrangler_secrets; then
  missing+=("Could not verify Wrangler secrets")
fi

require_wrangler_secret "ORIGIN_SECRET"
require_wrangler_secret "RSA_PRIVATE_KEY_PEM"
require_wrangler_secret "GRAFANA_CLOUD_LOKI_URL"
require_wrangler_secret "GRAFANA_CLOUD_LOKI_USERNAME"
require_wrangler_secret "GRAFANA_CLOUD_ACCESS_POLICY_TOKEN"

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing required environment variables for deployment:" >&2
  for name in "${missing[@]}"; do
    echo "  - $name" >&2
  done
  exit 1
fi

echo "All required deployment environment variables are set."
