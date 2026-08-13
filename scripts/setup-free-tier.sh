#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info() { printf '%b\n' "${CYAN}[INFO]${NC}  $*"; }
success() { printf '%b\n' "${GREEN}[OK]${NC}    $*"; }
die() { printf '%b\n' "${RED}[ERROR]${NC} $*" >&2; exit 1; }

command -v npx >/dev/null 2>&1 || die "npx is required."
command -v jq >/dev/null 2>&1 || die "jq is required."
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
workers_dir="${repo_root}/workers"
proxy_config="${workers_dir}/wrangler.proxy.jsonc"
dev_vars="${workers_dir}/.dev.vars"

[[ -f "$proxy_config" ]] || die "Missing ${proxy_config}."

proxy_var() {
  jq -r "$1" "$proxy_config" 2>/dev/null || true
}

cf_account_id="$(proxy_var '.vars.CF_ACCOUNT_ID // empty')"
ai_gateway_id="$(proxy_var '.vars.AI_GATEWAY_ID // empty')"

[[ -n "$cf_account_id" && "$cf_account_id" != "replace-with-cloudflare-account-id" ]] ||
  die "Set CF_ACCOUNT_ID in ${proxy_config} before deploying."
[[ "$cf_account_id" =~ ^[0-9a-fA-F]{32}$ ]] ||
  die "CF_ACCOUNT_ID must be a 32-character hex string."

[[ -n "$ai_gateway_id" && "$ai_gateway_id" != "replace-with-ai-gateway-id" ]] ||
  die "Set AI_GATEWAY_ID in ${proxy_config} before deploying."

if [[ -z "${PROXY_SECRET:-}" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    PROXY_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(36))')"
  else
    PROXY_SECRET="$(openssl rand -base64 36 | tr -dc 'A-Za-z0-9_-' | head -c 48)"
  fi
fi

[[ -n "$PROXY_SECRET" ]] || die "PROXY_SECRET must not be empty."
[[ "$PROXY_SECRET" =~ ^[A-Za-z0-9_-]+$ ]] || die "PROXY_SECRET must contain only URL-safe characters."
[[ ${#PROXY_SECRET} -ge 32 ]] || die "PROXY_SECRET must contain at least 32 URL-safe characters."

cd "$workers_dir"
info "Registering PROXY_SECRET on graft-ai-aig-proxy..."
printf '%s' "$PROXY_SECRET" | npx wrangler secret put PROXY_SECRET --config wrangler.proxy.jsonc

umask 077
if [[ -f "$dev_vars" ]]; then
  tmp_vars="${dev_vars}.tmp"
  if grep -q '^PROXY_SECRET=' "$dev_vars"; then
    sed "s/^PROXY_SECRET=.*/PROXY_SECRET=${PROXY_SECRET}/" "$dev_vars" > "$tmp_vars"
    mv "$tmp_vars" "$dev_vars"
  else
    printf 'PROXY_SECRET=%s\n' "$PROXY_SECRET" >> "$dev_vars"
  fi
else
  printf 'PROXY_SECRET=%s\n' "$PROXY_SECRET" > "$dev_vars"
fi
chmod 600 "$dev_vars"
success "Wrote ${dev_vars} for local development."

info "Deploying graft-ai-aig-proxy..."
npx wrangler deploy --config wrangler.proxy.jsonc
success "Proxy-only setup complete."

cat <<'SUMMARY'

Proxy-only mode does not use Workers Logpush, a Tail Worker, Terraform Logpush,
RSA_PRIVATE_KEY_PEM, ORIGIN_SECRET, or Grafana Loki secrets.
Only requests sent through the proxy Worker are available to the upstream
AI Gateway; access logs are not forwarded to Grafana Loki in this mode.
SUMMARY
