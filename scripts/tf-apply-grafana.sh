#!/usr/bin/env bash
# scripts/tf-apply-grafana.sh
# -------------------------------------------------------------------
# After running setup-free-tier.sh (or setting the Grafana Cloud API
# key manually), this script:
#   1. Runs `terraform init` to download the Grafana provider
#   2. Runs `terraform apply -target` for grafana.tf resources only
#   3. Reads the Loki and OTLP credentials from Terraform output
#   4. Re-registers them as Wrangler secrets (overwrite)
#
# Usage (from repo root):
#   terraform login app.terraform.io
#   export TF_VAR_grafana_cloud_api_key="<your-org-api-key>"
#   bash scripts/tf-apply-grafana.sh
# -------------------------------------------------------------------
set -euo pipefail

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
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
# 0. Prereqs
###############################################################################
command -v terraform &>/dev/null || die "terraform is not installed."
(cd "$(dirname "$0")/../workers" && npx --no -- wrangler --version &>/dev/null) \
  || die "wrangler is not available via npx. Run 'make install' first."

###############################################################################
# 1. Grafana Cloud API key
###############################################################################
cat <<MSG

${YELLOW}--- Grafana Cloud org-level API Key ---${NC}
Required to manage Access Policies via Terraform.
Generate at: https://grafana.com/orgs/<your-org>/api-keys (role: Admin)

MSG
ask TF_VAR_grafana_cloud_api_key "Paste your Grafana Cloud API key" secret

# The Grafana provider also needs region set — read from tfvars or use default
TF_VAR_grafana_stack_region_slug="${TF_VAR_grafana_stack_region_slug:-prod-ap-northeast-0}"
export TF_VAR_grafana_stack_region_slug

if [[ -z "${TF_VAR_grafana_stack_slug:-}" ]]; then
  DETECTED_SLUG=$(grep 'stack:' "${HOME}/.config/gcx/config.yaml" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"' || echo "yohi")
  read -r -p "$(echo -e "${YELLOW}[ASK]${NC}  Grafana Stack Slug [default: ${DETECTED_SLUG:-yohi}]: ")" input_slug
  export TF_VAR_grafana_stack_slug="${input_slug:-${DETECTED_SLUG:-yohi}}"
else
  export TF_VAR_grafana_stack_slug
fi

###############################################################################
# 2. terraform init + apply (Grafana resources only)
###############################################################################
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/terraform/grafana"

info "Running terraform init..."
terraform init -input=false

info "Running terraform apply (Grafana telemetry and Loki policies + tokens)..."
terraform apply \
  -target=grafana_cloud_access_policy.telemetry_write \
  -target=grafana_cloud_access_policy_token.telemetry_write \
  -target=grafana_cloud_access_policy.loki_ingest \
  -target=grafana_cloud_access_policy_token.loki_ingest \
  -auto-approve

###############################################################################
# 3. Read outputs
###############################################################################
info "Reading Terraform outputs..."

LOKI_URL=$(terraform output -raw grafana_loki_url       2>/dev/null || echo "")
LOKI_USER=$(terraform output -raw grafana_loki_username  2>/dev/null || echo "")
LOKI_TOKEN=$(terraform output -raw grafana_loki_write_token 2>/dev/null || echo "")
TELEMETRY_TOKEN=$(terraform output -raw grafana_telemetry_write_token 2>/dev/null || echo "")
OTLP_URL=$(terraform output -raw grafana_otlp_url 2>/dev/null || echo "")
OTLP_USER=$(terraform output -raw grafana_otlp_username 2>/dev/null || echo "")
OTLP_URL="${OTLP_URL%/}"

printf '::add-mask::%s\n' "$LOKI_URL"
printf '::add-mask::%s\n' "$LOKI_USER"
printf '::add-mask::%s\n' "$LOKI_TOKEN"
printf '::add-mask::%s\n' "$TELEMETRY_TOKEN"
printf '::add-mask::%s\n' "$OTLP_URL"
printf '::add-mask::%s\n' "$OTLP_USER"

[[ -z "$LOKI_URL"   ]] && die "Could not read grafana_loki_url from Terraform output."
[[ -z "$LOKI_USER"  ]] && die "Could not read grafana_loki_username from Terraform output."
[[ -z "$LOKI_TOKEN" ]] && die "Could not read grafana_loki_write_token from Terraform output."
[[ -z "$TELEMETRY_TOKEN" ]] && die "Could not read grafana_telemetry_write_token from Terraform output."
[[ -z "$OTLP_URL" ]] && die "Could not read grafana_otlp_url from Terraform output."
[[ -z "$OTLP_USER" ]] && die "Could not read grafana_otlp_username from Terraform output."

success "Grafana output retrieved."

###############################################################################
# 4. Re-register Wrangler secrets with the newly created token
###############################################################################
cd "$REPO_ROOT/workers"
info "Updating Wrangler secrets across Workers..."

echo "$LOKI_URL"   | env -u CLOUDFLARE_API_TOKEN npx wrangler secret put GRAFANA_CLOUD_LOKI_URL             --config wrangler.tail.jsonc
echo "$LOKI_USER"  | env -u CLOUDFLARE_API_TOKEN npx wrangler secret put GRAFANA_CLOUD_LOKI_USERNAME        --config wrangler.tail.jsonc
echo "$LOKI_TOKEN" | env -u CLOUDFLARE_API_TOKEN npx wrangler secret put GRAFANA_CLOUD_ACCESS_POLICY_TOKEN  --config wrangler.tail.jsonc
echo "$LOKI_URL"   | env -u CLOUDFLARE_API_TOKEN npx wrangler secret put GRAFANA_CLOUD_LOKI_URL             --config wrangler.jsonc
echo "$LOKI_USER"  | env -u CLOUDFLARE_API_TOKEN npx wrangler secret put GRAFANA_CLOUD_LOKI_USERNAME        --config wrangler.jsonc
echo "$LOKI_TOKEN" | env -u CLOUDFLARE_API_TOKEN npx wrangler secret put GRAFANA_CLOUD_ACCESS_POLICY_TOKEN  --config wrangler.jsonc

if [[ -f wrangler.ollama.jsonc ]]; then
  echo "${OTLP_URL}/otlp" | env -u CLOUDFLARE_API_TOKEN npx wrangler secret put GRAFANA_CLOUD_PROMETHEUS_URL --config wrangler.ollama.jsonc
  echo "$OTLP_USER"      | env -u CLOUDFLARE_API_TOKEN npx wrangler secret put GRAFANA_CLOUD_PROMETHEUS_USERNAME --config wrangler.ollama.jsonc
  echo "$TELEMETRY_TOKEN" | env -u CLOUDFLARE_API_TOKEN npx wrangler secret put GRAFANA_CLOUD_ACCESS_POLICY_TOKEN --config wrangler.ollama.jsonc
fi
if [[ -f wrangler.provider-metrics.jsonc ]]; then
  echo "${OTLP_URL}/otlp" | env -u CLOUDFLARE_API_TOKEN npx wrangler secret put GRAFANA_CLOUD_PROMETHEUS_URL --config wrangler.provider-metrics.jsonc
  echo "$OTLP_USER"      | env -u CLOUDFLARE_API_TOKEN npx wrangler secret put GRAFANA_CLOUD_PROMETHEUS_USERNAME --config wrangler.provider-metrics.jsonc
  echo "$TELEMETRY_TOKEN" | env -u CLOUDFLARE_API_TOKEN npx wrangler secret put GRAFANA_CLOUD_ACCESS_POLICY_TOKEN --config wrangler.provider-metrics.jsonc
fi

success "Secrets updated on Workers."

###############################################################################
# 5. Redeploy Tail Worker to pick up new secrets
###############################################################################
info "Redeploying Tail Worker..."
env -u CLOUDFLARE_API_TOKEN npx wrangler deploy --config wrangler.tail.jsonc
success "Tail Worker redeployed."

cat <<SUMMARY

${GREEN}========================================${NC}
${GREEN}  Grafana Access Policy setup complete ${NC}
${GREEN}========================================${NC}

Verify Loki connectivity:
  curl -u <tenant-id>:<token> "<loki-url>/loki/api/v1/labels"

Then send a test request through the Proxy Worker and check Grafana Explore:
  {gateway="main"}

${GREEN}========================================${NC}
SUMMARY
