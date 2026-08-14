#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "upsert" && "${1:-}" != "delete" ]]; then
  printf 'usage: %s upsert|delete\n' "$0" >&2
  exit 2
fi

command -v jq >/dev/null 2>&1 || { printf 'jq is required\n' >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { printf 'curl is required\n' >&2; exit 1; }

readonly action="$1"

: "${CF_ACCOUNT_ID:?CF_ACCOUNT_ID is required}"
: "${JOB_NAME:?JOB_NAME is required}"

if [[ "$action" == "upsert" ]]; then
  : "${CF_API_TOKEN:?CF_API_TOKEN is required for upsert}"
  : "${PAYLOAD:?PAYLOAD is required for upsert}"
fi

if [[ "$action" == "delete" && -z "${CF_API_TOKEN:-}" ]]; then
  printf 'CF_API_TOKEN is not set; skipping Logpush job deletion.\n' >&2
  printf 'Export CF_API_TOKEN before running terraform destroy if you want the job removed.\n' >&2
  exit 0
fi

api_base_url="${CLOUDFLARE_API_BASE_URL:-https://api.cloudflare.com/client/v4}"
api_url="${api_base_url}/accounts/${CF_ACCOUNT_ID}/logpush/jobs"

api_request() {
  local method="$1" url="$2"
  shift 2
  local response status
  if ! response="$(curl --silent --show-error --connect-timeout 10 --max-time 60 --write-out $'\n%{http_code}' \
      -X "$method" "$url" \
      -H "Authorization: Bearer ${CF_API_TOKEN}" \
      -H 'Content-Type: application/json' \
      "$@")"; then
    printf 'Cloudflare API request failed: %s %s (curl error)\n' "$method" "$url" >&2
    return 1
  fi
  status="${response##*$'\n'}"
  response="${response%$'\n'*}"

  if [[ ! "$status" =~ ^[0-9]{3}$ ]]; then
    printf 'Cloudflare API request failed: %s %s (invalid HTTP status: %q)\n' \
      "$method" "$url" "$status" >&2
    return 1
  fi

  if [[ "$status" -lt 200 || "$status" -ge 300 ]]; then
    printf 'Cloudflare API request failed: %s %s (HTTP %s)\n' "$method" "$url" "$status" >&2
    jq -c '{errors: (.errors // []), messages: (.messages // [])}' <<<"$response" >&2 || \
      printf 'Cloudflare API returned a non-JSON error response.\n' >&2
    return 1
  fi

  printf '%s\n' "$response"
}

require_success() {
  local response="$1"
  jq -e '.success == true' <<<"$response" >/dev/null || {
    jq -c '.errors // .messages // .' <<<"$response" >&2
    return 1
  }
}

find_job_id() {
  local name="$1"
  local response
  response="$(api_request GET "$api_url")" || return 1
  require_success "$response" || return 1
  jq -r --arg name "$name" '
    [.result[]? | select(.name == $name) | .id] as $ids
    | if ($ids | length) > 1 then
        error("multiple Logpush jobs have the configured name")
      elif ($ids | length) == 1 then
        $ids[0]
      else
        ""
      end
  ' <<<"$response"
}

if [[ "$action" == "delete" ]]; then
  existing_id="$(find_job_id "$JOB_NAME")" || exit 1
  if [[ -z "$existing_id" ]]; then
    printf 'No Logpush job named "%s" found; nothing to delete.\n' "$JOB_NAME"
    exit 0
  fi
  response="$(api_request DELETE "${api_url}/${existing_id}")" || exit 1
  require_success "$response" || exit 1
  printf 'Deleted Logpush job "%s" (id %s).\n' "$JOB_NAME" "$existing_id"
  exit 0
fi

existing_id="$(find_job_id "$JOB_NAME")" || exit 1

if [[ -n "$existing_id" ]]; then
  response="$(api_request PUT "${api_url}/${existing_id}" --data-binary @- <<<"$PAYLOAD")"
else
  response="$(api_request POST "$api_url" --data-binary @- <<<"$PAYLOAD")"
fi

require_success "$response"
