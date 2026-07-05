#!/usr/bin/env bash
# scripts/setup-free-tier.sh
# -------------------------------------------------------------------
# ⚠️  DEPRECATED: This script is superseded by scripts/setup.sh
# ⚠️  WARNING: This script contains hardcoded URLs from the original
#     developer's environment. It is provided for reference only.
#     If you use this script, replace URLs with your own Workers URL.
#
# Free Tier Proxy Mode — fully automated setup script
#
# Authentication strategy (no extra API key needed):
#   - Grafana Loki write token  → created via gcx api (Service Account)
#   - Cloudflare Wrangler       → uses existing OAuth session (env -u CLOUDFLARE_API_TOKEN)
# -------------------------------------------------------------------
#
# What this script does:
#   1. Validates prerequisites (npx, curl, jq, gcx)
#   2. Creates a Grafana Service Account + token with Loki write access
#   3. Reads Loki URL and username from existing gcx datasource API
#   4. Generates a PROXY_SECRET (random)
#   5. Registers all secrets with Wrangler
#   6. Writes workers/.dev.vars for local dev
#   7. Deploys Tail Worker → Proxy Worker
#
# Usage (from repo root):
#   bash scripts/setup-free-tier.sh
# -------------------------------------------------------------------
set -euo pipefail

###############################################################################
# Colour helpers
###############################################################################
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

ask() {
  local var="$1" prompt="$2" secret="${3:-}" val
  if [[ -n "${!var:-}" ]]; then
    info "$var is already set — skipping prompt."
    return
  fi
  if [[ "$secret" == "secret" ]]; then
    read -r -s -p "$(echo -e "${YELLOW}[ASK]${NC}  $prompt: ")" val; echo
  else
    read -r -p "$(echo -e "${YELLOW}[ASK]${NC}  $prompt: ")" val
  fi
  [[ -z "$val" ]] && die "$var cannot be empty."
  export "$var"="$val"
}

###############################################################################
# 0. Prerequisites
###############################################################################
info "Checking prerequisites..."

for cmd in curl jq gcx npx; do
  command -v "$cmd" &>/dev/null || die "'$cmd' is not installed or not in PATH."
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKERS_DIR="${REPO_ROOT}/workers"
cd "$WORKERS_DIR"
npx wrangler --version &>/dev/null || die "wrangler not found. Run 'make install' first."
cd "$REPO_ROOT"
success "All prerequisites found."

###############################################################################
# 1. Verify gcx is logged in
###############################################################################
info "Verifying gcx login..."
GCX_USER=$(gcx api /api/user --json login 2>/dev/null || echo "")
[[ -z "$GCX_USER" ]] && die "gcx is not logged in. Run: gcx login"
success "Logged in as: $GCX_USER"

###############################################################################
# 2. Fetch Loki datasource info via gcx
###############################################################################
info "Fetching Loki datasource info..."

# Read stack slug from gcx config
STACK_SLUG=$(grep 'stack:' "${HOME}/.config/gcx/config.yaml" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"' || echo "")
[[ -z "$STACK_SLUG" ]] && STACK_SLUG="micrococoa889" # Fallback to original default if config not found

LOKI_DS=$(gcx api /api/datasources -o json 2>/dev/null | \
  jq -r "[.[] | select(.type==\"loki\" and (.name | test(\"${STACK_SLUG}\")))] | first" || echo "")

GRAFANA_LOKI_URL=$(echo "$LOKI_DS" | jq -r '.url // empty' | sed 's|/$||')
# Loki username (tenant ID) is stored in basicAuthUser on the datasource JSON
GRAFANA_LOKI_USERNAME=$(echo "$LOKI_DS" | jq -r '.basicAuthUser // empty')

if [[ -z "$GRAFANA_LOKI_URL" ]]; then
  warn "Could not auto-detect Loki URL from datasource API."
  ask GRAFANA_LOKI_URL "Enter Grafana Loki push URL (e.g. https://logs-prod-030.grafana.net)"
else
  success "Loki URL: $GRAFANA_LOKI_URL"
fi

if [[ -z "$GRAFANA_LOKI_USERNAME" ]]; then
  warn "Could not auto-detect Loki username."
  ask GRAFANA_LOKI_USERNAME "Enter Grafana Loki username / tenant ID (numeric, e.g. 1656713)"
else
  success "Loki username: $GRAFANA_LOKI_USERNAME"
fi

###############################################################################
# 3. Create a Service Account for Loki write (if not already exists)
###############################################################################
SA_NAME="graft-ai-loki-writer"
info "Looking up service account '${SA_NAME}'..."

EXISTING_SA=$(gcx api /api/serviceaccounts/search -o json 2>/dev/null | \
  jq -r ".serviceAccounts[] | select(.name==\"${SA_NAME}\") | .id" || echo "")

if [[ -n "$EXISTING_SA" ]]; then
  SA_ID="$EXISTING_SA"
  info "Service account already exists (ID: ${SA_ID}) — reusing."
else
  info "Creating service account '${SA_NAME}'..."
  SA_RESP=$(gcx api /api/serviceaccounts \
    -d "{\"name\":\"${SA_NAME}\",\"role\":\"Viewer\",\"isDisabled\":false}" \
    -o json 2>/dev/null || echo "")
  SA_ID=$(echo "$SA_RESP" | jq -r '.id // empty')
  [[ -z "$SA_ID" ]] && die "Failed to create service account. Response: ${SA_RESP}"
  success "Service account created (ID: ${SA_ID})"
fi

###############################################################################
# 4. Generate a token for the Service Account
###############################################################################
info "Generating token for service account (ID: ${SA_ID})..."

TOKEN_RESP=$(gcx api "/api/serviceaccounts/${SA_ID}/tokens" \
  -d "{\"name\":\"graft-ai-loki-write-$(date +%Y%m%d%H%M%S)\"}" \
  -o json 2>/dev/null || echo "")

GRAFANA_CLOUD_ACCESS_POLICY_TOKEN=$(echo "$TOKEN_RESP" | jq -r '.key // empty')

if [[ -z "$GRAFANA_CLOUD_ACCESS_POLICY_TOKEN" ]]; then
  warn "Auto token generation failed. Response: ${TOKEN_RESP}"
  cat <<MSG

${YELLOW}--- Manual step required ---${NC}
Please create the token manually:
  1. Open https://${STACK_SLUG}.grafana.net/org/serviceaccounts
  2. Find or create a service account named '${SA_NAME}'
  3. Generate a token and paste it below.

MSG
  ask GRAFANA_CLOUD_ACCESS_POLICY_TOKEN "Paste the Service Account token" secret
else
  success "Token generated successfully."
fi

###############################################################################
# 5. Verify Loki write access
###############################################################################
info "Verifying Loki write access..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -u "${GRAFANA_LOKI_USERNAME}:${GRAFANA_CLOUD_ACCESS_POLICY_TOKEN}" \
  "${GRAFANA_LOKI_URL}/loki/api/v1/labels" || echo "000")

if [[ "$HTTP_STATUS" == "200" ]]; then
  success "Loki connection verified (HTTP ${HTTP_STATUS})"
elif [[ "$HTTP_STATUS" == "401" ]]; then
  warn "Loki auth failed (HTTP 401). Service Account token may lack Loki write permissions."
  warn "The Grafana Service Account approach requires Cloud Access Policy for Loki push."
  cat <<MSG

${YELLOW}--- Fallback: Cloud Access Policy token ---${NC}
A Grafana Cloud Access Policy token with 'logs:write' scope is required for Loki push.

Steps to create one:
  1. Go to ${CYAN}https://${STACK_SLUG}.grafana.net/admin/access-policies${NC}
     (Administration → Cloud access policies in the left menu)
  2. Click "Create access policy"
  3. Name: graft-ai-loki-write
  4. Scope: logs:write
  5. Click "Create", then "Add token" → generate and copy the token.

MSG
  ask GRAFANA_CLOUD_ACCESS_POLICY_TOKEN "Paste the Cloud Access Policy token (logs:write)" secret
else
  warn "Unexpected HTTP status ${HTTP_STATUS} from Loki labels endpoint — continuing anyway."
fi

###############################################################################
# 6. Proxy secret
###############################################################################
if [[ -z "${PROXY_SECRET:-}" ]]; then
  if command -v python3 &>/dev/null; then
    PROXY_SECRET=$(python3 -c "import secrets; print(secrets.token_urlsafe(36))")
  else
    # Temporarily disable pipefail to prevent SIGPIPE issues
    set +o pipefail
    PROXY_SECRET=$(LC_ALL=C tr -dc 'A-Za-z0-9_-' </dev/urandom | head -c 48)
    set -o pipefail
  fi
  info "Auto-generated PROXY_SECRET."
fi

###############################################################################
# 7. Register Wrangler secrets
###############################################################################
info "Registering Wrangler secrets..."
cd "$WORKERS_DIR"

register_secret() {
  local name="$1" value="$2" config="$3"
  echo "$value" | env -u CLOUDFLARE_API_TOKEN npx wrangler secret put "$name" --config "$config"
  success "Secret '$name' → $(grep '"name"' "$config" | head -1 | awk -F'"' '{print $4}')"
}

register_secret "GRAFANA_CLOUD_LOKI_URL"            "$GRAFANA_LOKI_URL"                      "wrangler.tail.jsonc"
register_secret "GRAFANA_CLOUD_LOKI_USERNAME"       "$GRAFANA_LOKI_USERNAME"                 "wrangler.tail.jsonc"
register_secret "GRAFANA_CLOUD_ACCESS_POLICY_TOKEN" "$GRAFANA_CLOUD_ACCESS_POLICY_TOKEN"     "wrangler.tail.jsonc"
register_secret "PROXY_SECRET"                      "$PROXY_SECRET"                          "wrangler.proxy.jsonc"

###############################################################################
# 8. Write .dev.vars
###############################################################################
DEV_VARS="${WORKERS_DIR}/.dev.vars"
info "Writing ${DEV_VARS} for local dev..."
cat > "$DEV_VARS" <<EOF
GRAFANA_CLOUD_LOKI_URL=${GRAFANA_LOKI_URL}
GRAFANA_CLOUD_LOKI_USERNAME=${GRAFANA_LOKI_USERNAME}
GRAFANA_CLOUD_ACCESS_POLICY_TOKEN=${GRAFANA_CLOUD_ACCESS_POLICY_TOKEN}
PROXY_SECRET=${PROXY_SECRET}
EOF
success ".dev.vars written."

###############################################################################
# 9. Deploy Workers
###############################################################################
info "Deploying Tail Worker (graft-ai-aig-tail)..."
env -u CLOUDFLARE_API_TOKEN npx wrangler deploy --config wrangler.tail.jsonc
success "Tail Worker deployed."

info "Deploying Proxy Worker (graft-ai-aig-proxy)..."
env -u CLOUDFLARE_API_TOKEN npx wrangler deploy --config wrangler.proxy.jsonc
success "Proxy Worker deployed."

cd "$REPO_ROOT"

###############################################################################
# 10. Summary
###############################################################################
cat <<SUMMARY

${GREEN}========================================${NC}
${GREEN}  graft-ai Free Tier setup complete!  ${NC}
${GREEN}========================================${NC}

Proxy Worker URL:
  ${CYAN}(Please check your Cloudflare Workers dashboard for the actual URL)${NC}
  ${YELLOW}Note: The URL below is a placeholder:${NC}
  ${CYAN}https://graft-ai-aig-proxy.<your-namespace>.workers.dev${NC}

X-Proxy-Secret (add this header to all client requests):
  ${CYAN}${PROXY_SECRET}${NC}

Test request (Cloudflare Workers AI — no external API key needed):
  curl -X POST <YOUR_PROXY_WORKER_URL>/workers-ai/v1/chat/completions \\
    -H 'Content-Type: application/json' \\
    -H 'X-Proxy-Secret: ${PROXY_SECRET}' \\
    -d '{"model":"@cf/meta/llama-3.1-8b-instruct","messages":[{"role":"user","content":"Hello graft-ai!"}]}'

Verify logs in Grafana Loki (Explore → Label filters):
  {gateway="main"}

${GREEN}========================================${NC}
SUMMARY
