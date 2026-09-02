#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly GRAFANA_DIR="${ROOT_DIR}/terraform/grafana"
readonly SCRIPT_DIR ROOT_DIR GRAFANA_DIR

admin_env="${ROOT_DIR}/admin.env"
repo="yohi/graft-ai"
dry_run=false
missing_inputs=()

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: bash scripts/sync-otel-github-secrets.sh [options]

Options:
  --admin-env PATH  Shell-style environment file (default: admin.env)
  --repo OWNER/REPO GitHub repository (default: yohi/graft-ai)
  --dry-run         Validate and list names without changing GitHub
  -h, --help        Show this help
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command is missing: $1"
}

read_option_value() {
  [[ $# -ge 2 && -n "$2" ]] || die "Option $1 requires a value."
  printf '%s' "$2"
}

while (($# > 0)); do
  case "$1" in
    --admin-env)
      admin_env="$(read_option_value "$1" "${2:-}")"
      shift 2
      ;;
    --repo)
      repo="$(read_option_value "$1" "${2:-}")"
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      die "Unknown option: $1"
      ;;
  esac
done

require_command terraform
require_command base64
require_command tr
if [[ "$dry_run" != true ]]; then
  require_command gh
fi

[[ -f "$admin_env" ]] || die "Environment file not found: $admin_env"
[[ ! -L "$admin_env" ]] || die "Environment file must not be a symlink: $admin_env"

# admin.env is a trusted shell-style assignment file. Keep it private before sourcing it.
chmod 600 "$admin_env" || die "Could not restrict permissions on $admin_env"

# shellcheck disable=SC1090
source "$admin_env"

[[ -z "${TF_VAR_grafana_cloud_api_key:-}" ]] || export TF_VAR_grafana_cloud_api_key
[[ -z "${TF_VAR_grafana_stack_slug:-}" ]] || export TF_VAR_grafana_stack_slug

terraform_output() {
  local name="$1"
  local value

  if ! value="$(terraform -chdir="$GRAFANA_DIR" output -no-color -raw "$name" 2>/dev/null)"; then
    die "Terraform output '$name' is unavailable. Run 'make plan-grafana', review it, then run 'make apply-grafana'."
  fi
  [[ -n "$value" ]] || die "Terraform output '$name' is empty. Run 'make apply-grafana' and retry."
  printf '%s' "$value"
}

require_secret() {
  local name="$1"
  local prompt="$2"
  local value

  if [[ -n "${!name:-}" ]]; then
    return
  fi
  if [[ "$dry_run" == true ]]; then
    missing_inputs+=("$name")
    return
  fi
  [[ -t 0 ]] || die "$name is missing from $admin_env and stdin is not interactive."
  printf '%s: ' "$prompt" >&2
  IFS= read -r -s value || die "Could not read $name."
  printf '\n' >&2
  [[ -n "$value" ]] || die "$name must not be empty."
  printf -v "$name" '%s' "$value"
}

basic_authorization() {
  local username="$1"
  local token="$2"
  printf 'Basic %s' "$(printf '%s:%s' "$username" "$token" | base64 | tr -d '\n')"
}

sync_secret() {
  local name="$1"
  local value="$2"

  if [[ "$dry_run" == true ]]; then
    printf 'DRY RUN: would set %s\n' "$name"
    return
  fi
  if ! printf '%s' "$value" | gh secret set "$name" --repo "$repo" >/dev/null; then
    die "Could not set GitHub repository secret '$name'."
  fi
  printf 'Set %s\n' "$name"
}

OTLP_BASE="$(terraform_output grafana_otlp_url)"
OTLP_BASE="${OTLP_BASE%/}"
OTLP_USER="$(terraform_output grafana_otlp_username)"
LOKI_URL="$(terraform_output grafana_loki_url)"
LOKI_USER="$(terraform_output grafana_loki_username)"
TELEMETRY_TOKEN="$(terraform_output grafana_telemetry_write_token)"
LOKI_TOKEN="$(terraform_output grafana_loki_write_token)"

require_secret OTEL_INGEST_TOKEN \
  'OTEL_INGEST_TOKEN (must match the AI Gateway Bearer token)'
require_secret OTEL_RATE_LIMIT_HMAC_KEY \
  'OTEL_RATE_LIMIT_HMAC_KEY (must be different from the ingest token)'

if ((${#missing_inputs[@]} > 0)); then
  printf 'Missing values in %s:\n' "$admin_env" >&2
  printf '  %s\n' "${missing_inputs[@]}" >&2
  printf '%s\n' 'Run without --dry-run to enter them through hidden prompts.' >&2
  exit 1
fi

[[ "$OTEL_INGEST_TOKEN" != "$OTEL_RATE_LIMIT_HMAC_KEY" ]] || \
  die 'OTEL_INGEST_TOKEN and OTEL_RATE_LIMIT_HMAC_KEY must differ.'

OTLP_AUTH="$(basic_authorization "$OTLP_USER" "$TELEMETRY_TOKEN")"
LOKI_AUTH="$(basic_authorization "$LOKI_USER" "$LOKI_TOKEN")"

sync_secret OTEL_INGEST_TOKEN "$OTEL_INGEST_TOKEN"
sync_secret OTEL_RATE_LIMIT_HMAC_KEY "$OTEL_RATE_LIMIT_HMAC_KEY"
sync_secret GRAFANA_CLOUD_OTLP_TRACES_URL "${OTLP_BASE}/otlp/v1/traces"
sync_secret GRAFANA_CLOUD_OTLP_METRICS_URL "${OTLP_BASE}/otlp/v1/metrics"
sync_secret GRAFANA_CLOUD_OTLP_AUTHORIZATION "$OTLP_AUTH"
sync_secret GRAFANA_CLOUD_PROMETHEUS_URL "${OTLP_BASE}/otlp"
sync_secret GRAFANA_CLOUD_PROMETHEUS_USERNAME "$OTLP_USER"
sync_secret GRAFANA_CLOUD_ACCESS_POLICY_TOKEN "$TELEMETRY_TOKEN"
sync_secret GRAFANA_CLOUD_LOKI_URL "${LOKI_URL%/}/loki/api/v1/push"
sync_secret GRAFANA_CLOUD_LOKI_AUTHORIZATION "$LOKI_AUTH"

unset OTEL_INGEST_TOKEN OTEL_RATE_LIMIT_HMAC_KEY OTLP_AUTH LOKI_AUTH
unset TELEMETRY_TOKEN LOKI_TOKEN

if [[ "$dry_run" == true ]]; then
  printf '%s\n' 'Dry run completed; GitHub was not changed.'
else
  printf 'GitHub repository secrets synchronized for %s.\n' "$repo"
fi
