#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
script_path="${repo_root}/terraform/manage-cloudflare-logpush-job.sh"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

mkdir -p "${tmpdir}/bin"
cat > "${tmpdir}/bin/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "${CURL_ARGS_LOG:?}"
if [[ -n "${CURL_RESPONSE_JSON:-}" ]]; then
  printf '%s\n200' "$CURL_RESPONSE_JSON"
else
  printf '%s\n200' '{"success":true,"result":[]}'
fi
EOF
chmod 700 "${tmpdir}/bin/curl"

test_delete_requires_api_token() {
  local output
  if output="$(env -u CF_API_TOKEN CF_ACCOUNT_ID=0123456789abcdef0123456789abcdef JOB_NAME=test-job DATASET=ai_gateway_events bash "$script_path" delete 2>&1)"; then
    fail 'delete unexpectedly succeeded without CF_API_TOKEN'
  fi

  [[ "$output" == *'CF_API_TOKEN is not set; cannot delete'* ]] || fail 'missing CF_API_TOKEN requirement error'
}

test_requests_use_bounded_timeouts_without_network() {
  local args_log
  args_log="${tmpdir}/curl-args.log"

  PATH="${tmpdir}/bin:${PATH}" \
    CURL_ARGS_LOG="$args_log" \
    CF_API_TOKEN=test-token \
    CF_ACCOUNT_ID=0123456789abcdef0123456789abcdef \
    JOB_NAME=test-job \
    DATASET=ai_gateway_events \
    bash "$script_path" delete >/dev/null

  grep -Fx -- '--connect-timeout' "$args_log" >/dev/null || fail 'curl lacks --connect-timeout'
  grep -Fx -- '10' "$args_log" >/dev/null || fail 'curl lacks 10-second connect timeout'
  grep -Fx -- '--max-time' "$args_log" >/dev/null || fail 'curl lacks --max-time'
  grep -Fx -- '60' "$args_log" >/dev/null || fail 'curl lacks 60-second maximum time'
}

test_same_name_different_dataset_is_not_selected() {
  local response args_log output
  response='{"success":true,"result":[{"id":"other-id","name":"test-job","dataset":"other_dataset"}]}'
  args_log="${tmpdir}/same-name-upsert-args.log"

  PATH="${tmpdir}/bin:${PATH}" \
    CURL_ARGS_LOG="$args_log" \
    CURL_RESPONSE_JSON="$response" \
    CF_API_TOKEN=test-token \
    CF_ACCOUNT_ID=0123456789abcdef0123456789abcdef \
    JOB_NAME=test-job \
    DATASET=ai_gateway_events \
    PAYLOAD='{"name":"test-job","dataset":"ai_gateway_events"}' \
    bash "$script_path" upsert

  grep -Fx -- POST "$args_log" >/dev/null || fail 'upsert did not create a job for another dataset'
  if grep -Fx -- PUT "$args_log" >/dev/null; then
    fail 'upsert updated a job from another dataset'
  fi

  args_log="${tmpdir}/same-name-delete-args.log"
  output="$(PATH="${tmpdir}/bin:${PATH}" \
    CURL_ARGS_LOG="$args_log" \
    CURL_RESPONSE_JSON="$response" \
    CF_API_TOKEN=test-token \
    CF_ACCOUNT_ID=0123456789abcdef0123456789abcdef \
    JOB_NAME=test-job \
    DATASET=ai_gateway_events \
    bash "$script_path" delete)"

  [[ "$output" == *'No Logpush job named "test-job" found'* ]] || fail 'delete selected a job from another dataset'
  if grep -Fx -- DELETE "$args_log" >/dev/null; then
    fail 'delete removed a job from another dataset'
  fi
}

test_same_name_same_dataset_is_selected() {
  local response args_log
  response='{"success":true,"result":[{"id":"target-id","name":"test-job","dataset":"ai_gateway_events"}]}'
  args_log="${tmpdir}/same-name-same-dataset-upsert-args.log"

  PATH="${tmpdir}/bin:${PATH}" \
    CURL_ARGS_LOG="$args_log" \
    CURL_RESPONSE_JSON="$response" \
    CF_API_TOKEN=test-token \
    CF_ACCOUNT_ID=0123456789abcdef0123456789abcdef \
    JOB_NAME=test-job \
    DATASET=ai_gateway_events \
    PAYLOAD='{"name":"test-job","dataset":"ai_gateway_events"}' \
    bash "$script_path" upsert

  grep -Fx -- PUT "$args_log" >/dev/null || fail 'upsert did not update the matching dataset'
  grep -F '/jobs/target-id' "$args_log" >/dev/null || fail 'upsert used the wrong job ID'

  args_log="${tmpdir}/same-name-same-dataset-delete-args.log"
  PATH="${tmpdir}/bin:${PATH}" \
    CURL_ARGS_LOG="$args_log" \
    CURL_RESPONSE_JSON="$response" \
    CF_API_TOKEN=test-token \
    CF_ACCOUNT_ID=0123456789abcdef0123456789abcdef \
    JOB_NAME=test-job \
    DATASET=ai_gateway_events \
    bash "$script_path" delete >/dev/null

  grep -Fx -- DELETE "$args_log" >/dev/null || fail 'delete did not remove the matching dataset'
  grep -F '/jobs/target-id' "$args_log" >/dev/null || fail 'delete used the wrong job ID'
}

test_terraform_destroy_passes_helper_contract() {
  local destroy_block
  destroy_block="$(grep -A 10 -F 'when = destroy' "${repo_root}/terraform/main.tf")"
  [[ "$destroy_block" == *'DATASET'* ]] || fail 'terraform destroy does not pass DATASET'
}

test_delete_requires_api_token
test_requests_use_bounded_timeouts_without_network
test_same_name_different_dataset_is_not_selected
test_same_name_same_dataset_is_selected
test_terraform_destroy_passes_helper_contract
printf 'PASS: manage-cloudflare-logpush-job regression tests\n'
