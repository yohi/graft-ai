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
printf '{"success":true,"result":[]}\n200'
EOF
chmod 700 "${tmpdir}/bin/curl"

test_delete_requires_api_token() {
  local output
  if output="$(env -u CF_API_TOKEN CF_ACCOUNT_ID=0123456789abcdef0123456789abcdef JOB_NAME=test-job bash "$script_path" delete 2>&1)"; then
    fail 'delete succeeded without CF_API_TOKEN'
  fi

  [[ "$output" == *'CF_API_TOKEN is not set'* ]] || fail 'missing CF_API_TOKEN requirement error'
}

test_requests_use_bounded_timeouts_without_network() {
  local args_log
  args_log="${tmpdir}/curl-args.log"

  PATH="${tmpdir}/bin:${PATH}" \
    CURL_ARGS_LOG="$args_log" \
    CF_API_TOKEN=test-token \
    CF_ACCOUNT_ID=0123456789abcdef0123456789abcdef \
    JOB_NAME=test-job \
    bash "$script_path" delete >/dev/null

  grep -Fx -- '--connect-timeout' "$args_log" >/dev/null || fail 'curl lacks --connect-timeout'
  grep -Fx -- '10' "$args_log" >/dev/null || fail 'curl lacks 10-second connect timeout'
  grep -Fx -- '--max-time' "$args_log" >/dev/null || fail 'curl lacks --max-time'
  grep -Fx -- '60' "$args_log" >/dev/null || fail 'curl lacks 60-second maximum time'
}

test_delete_requires_api_token
test_requests_use_bounded_timeouts_without_network
printf 'PASS: manage-cloudflare-logpush-job regression tests\n'
