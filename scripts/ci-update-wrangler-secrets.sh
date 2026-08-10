#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${GITHUB_WORKSPACE:-$(cd "$(dirname "$0")/.." && pwd)}"
WORKERS_DIR="${REPO_ROOT}/workers"

cd "$WORKERS_DIR"

printf '::add-mask::%s\n' "${GRAFANA_LOKI_URL:-}"
printf '::add-mask::%s\n' "${GRAFANA_LOKI_USERNAME:-}"
printf '::add-mask::%s\n' "${GRAFANA_LOKI_TOKEN:-}"
printf '::add-mask::%s\n' "${ORIGIN_SECRET:-}"
printf '::add-mask::%s\n' "${RSA_PRIVATE_KEY_PEM:-}"
printf '::add-mask::%s\n' "${PROXY_SECRET:-}"

register_secret() {
  local name="$1"
  local value="$2"
  local config="$3"

  if [[ -z "$value" ]]; then
    echo "[ERROR] secret value for $name is empty" >&2
    exit 1
  fi

  printf '%s' "$value" | npx wrangler secret put "$name" --config "$config"
}

# Loki secrets: Tail Worker + Logpush Worker
register_secret "GRAFANA_CLOUD_LOKI_URL" "$GRAFANA_LOKI_URL" "wrangler.tail.jsonc"
register_secret "GRAFANA_CLOUD_LOKI_USERNAME" "$GRAFANA_LOKI_USERNAME" "wrangler.tail.jsonc"
register_secret "GRAFANA_CLOUD_ACCESS_POLICY_TOKEN" "$GRAFANA_LOKI_TOKEN" "wrangler.tail.jsonc"

register_secret "GRAFANA_CLOUD_LOKI_URL" "$GRAFANA_LOKI_URL" "wrangler.jsonc"
register_secret "GRAFANA_CLOUD_LOKI_USERNAME" "$GRAFANA_LOKI_USERNAME" "wrangler.jsonc"
register_secret "GRAFANA_CLOUD_ACCESS_POLICY_TOKEN" "$GRAFANA_LOKI_TOKEN" "wrangler.jsonc"

# Logpush-only secrets
register_secret "ORIGIN_SECRET" "$ORIGIN_SECRET" "wrangler.jsonc"
register_secret "RSA_PRIVATE_KEY_PEM" "$RSA_PRIVATE_KEY_PEM" "wrangler.jsonc"

# Proxy secret
register_secret "PROXY_SECRET" "$PROXY_SECRET" "wrangler.proxy.jsonc"

echo "Wrangler secrets updated."
