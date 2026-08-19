#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
compose_file="${repo_root}/deploy/otel/docker-compose.yml"
temp_dir="$(mktemp -d)"
override_file="${temp_dir}/docker-compose.smoke.override.yml"

cleanup() {
  docker compose -f "$compose_file" -f "$override_file" --profile smoke down --volumes --remove-orphans >/dev/null 2>&1 || true
  node -e 'for (const path of process.argv.slice(1)) { try { require("node:fs").unlinkSync(path); } catch {} }' "$override_file" "$temp_dir/otel_ingest_token" "$temp_dir/otel_hmac_key" "$temp_dir/grafana_admin_password" "$temp_dir/cloudflared_token"
  rmdir "$temp_dir"
}
trap cleanup EXIT

printf '%s' 'smoke-token' >"$temp_dir/otel_ingest_token"
printf '%s' 'smoke-hmac-key' >"$temp_dir/otel_hmac_key"
printf '%s' 'smoke-admin-password' >"$temp_dir/grafana_admin_password"
printf '%s' 'unused-tunnel-token' >"$temp_dir/cloudflared_token"
cat >"$override_file" <<EOF
services:
  alloy:
    environment:
      OTEL_TRUSTED_PROXY_CIDRS: 172.30.0.20/32
  smoke:
    environment:
      OTEL_SMOKE_TOKEN: smoke-token
secrets:
  otel_ingest_token:
    file: ${temp_dir}/otel_ingest_token
  otel_hmac_key:
    file: ${temp_dir}/otel_hmac_key
  grafana_admin_password:
    file: ${temp_dir}/grafana_admin_password
  cloudflared_token:
    file: ${temp_dir}/cloudflared_token
EOF

docker compose -f "$compose_file" -f "$override_file" --profile smoke up --build --abort-on-container-exit --exit-code-from smoke smoke
