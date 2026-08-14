#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info() { printf '%b\n' "${CYAN}[INFO]${NC}  $*"; }
success() { printf '%b\n' "${GREEN}[OK]${NC}    $*"; }
die() { printf '%b\n' "${RED}[ERROR]${NC} $*" >&2; exit 1; }

command -v npx >/dev/null 2>&1 || die "npx is required."
command -v node >/dev/null 2>&1 || die "node is required."
command -v jq >/dev/null 2>&1 || die "jq is required."
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
workers_dir="${repo_root}/workers"
proxy_config="${workers_dir}/wrangler.proxy.jsonc"
dev_vars="${workers_dir}/.dev.vars"

[[ -f "$proxy_config" ]] || die "Missing ${proxy_config}."

jsonc_to_json() {
  node - "$proxy_config" <<'NODE'
const fs = require("node:fs");

const input = fs.readFileSync(process.argv[2], "utf8");
let withoutComments = "";
let inString = false;
let escaped = false;
let inLineComment = false;
let inBlockComment = false;

for (let index = 0; index < input.length; index += 1) {
  const character = input[index];
  const next = input[index + 1];

  if (inLineComment) {
    if (character === "\n") {
      inLineComment = false;
      withoutComments += character;
    }
    continue;
  }

  if (inBlockComment) {
    if (character === "*" && next === "/") {
      inBlockComment = false;
      index += 1;
    } else if (character === "\n") {
      withoutComments += character;
    }
    continue;
  }

  if (!inString && character === "/" && next === "/") {
    inLineComment = true;
    index += 1;
    continue;
  }

  if (!inString && character === "/" && next === "*") {
    inBlockComment = true;
    index += 1;
    continue;
  }

  withoutComments += character;
  if (character === '"' && !escaped) {
    inString = !inString;
  }
  escaped = character === "\\" && !escaped;
  if (character !== "\\") {
    escaped = false;
  }
}

let withoutTrailingCommas = "";
for (let index = 0; index < withoutComments.length; index += 1) {
  const character = withoutComments[index];

  if (character === '"' && !escaped) {
    inString = !inString;
  }

  if (!inString && character === ",") {
    let next = index + 1;
    while (/\s/.test(withoutComments[next] ?? "")) {
      next += 1;
    }
    if (withoutComments[next] === "}" || withoutComments[next] === "]") {
      escaped = false;
      continue;
    }
  }

  withoutTrailingCommas += character;
  escaped = character === "\\" && !escaped;
  if (character !== "\\") {
    escaped = false;
  }
}

process.stdout.write(withoutTrailingCommas);
NODE
}

if ! proxy_json="$(jsonc_to_json)"; then
  die "Unable to parse ${proxy_config} as JSONC."
fi

proxy_var() {
  local query="$1"
  local value
  if ! value="$(jq -r "$query" <<<"$proxy_json" 2>/dev/null)"; then
    die "Unable to parse normalized contents of ${proxy_config}."
  fi
  printf '%s\n' "$value"
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
    command -v openssl >/dev/null 2>&1 || die "python3 or openssl is required to generate PROXY_SECRET."
    PROXY_SECRET="$(openssl rand -hex 24)"
  fi
fi

[[ -n "$PROXY_SECRET" ]] || die "PROXY_SECRET must not be empty."
[[ "$PROXY_SECRET" =~ ^[A-Za-z0-9_-]+$ ]] || die "PROXY_SECRET must contain only URL-safe characters."
[[ ${#PROXY_SECRET} -ge 32 ]] || die "PROXY_SECRET must contain at least 32 URL-safe characters."

cd "$workers_dir"
info "Registering PROXY_SECRET on graft-ai-aig-proxy..."
printf '%s' "$PROXY_SECRET" | npx --no-install wrangler secret put PROXY_SECRET --config wrangler.proxy.jsonc

umask 077
tmp_vars="$(mktemp "${dev_vars}.tmp.XXXXXX")"
chmod 600 "$tmp_vars"
trap 'rm -f "$tmp_vars"' EXIT

proxy_secret_written=false
if [[ -f "$dev_vars" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == PROXY_SECRET=* ]]; then
      printf 'PROXY_SECRET=%s\n' "$PROXY_SECRET" >> "$tmp_vars"
      proxy_secret_written=true
    else
      printf '%s\n' "$line" >> "$tmp_vars"
    fi
  done < "$dev_vars"
fi

if [[ "$proxy_secret_written" == false ]]; then
  printf 'PROXY_SECRET=%s\n' "$PROXY_SECRET" >> "$tmp_vars"
fi

mv "$tmp_vars" "$dev_vars"
trap - EXIT
success "Wrote ${dev_vars} for local development."

info "Deploying graft-ai-aig-proxy..."
npx --no-install wrangler deploy --config wrangler.proxy.jsonc
success "Proxy-only setup complete."

cat <<'SUMMARY'

Proxy-only mode does not use Workers Logpush, a Tail Worker, Terraform Logpush,
RSA_PRIVATE_KEY_PEM, ORIGIN_SECRET, or Grafana Loki secrets.
Only requests sent through the proxy Worker are available to the upstream
AI Gateway; access logs are not forwarded to Grafana Loki in this mode.
SUMMARY
