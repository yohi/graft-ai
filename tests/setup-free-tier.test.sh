#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
setup_source="${repo_root}/scripts/setup-free-tier.sh"
parser_source="${repo_root}/scripts/parse-jsonc.mjs"
readonly proxy_secret="abcdefghijklmnopqrstuvwxyzABCDEF"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

create_fixture() {
  local name="$1"
  local gateway_id="$2"
  local fixture_root="${tmpdir}/${name}"

  mkdir -p "${fixture_root}/bin" "${fixture_root}/scripts" "${fixture_root}/workers"
  cp "$setup_source" "${fixture_root}/scripts/setup-free-tier.sh"
  cp "$parser_source" "${fixture_root}/scripts/parse-jsonc.mjs"
  cat > "${fixture_root}/bin/npx" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${NPX_CALL_LOG:?}"
EOF
  chmod 700 "${fixture_root}/bin/npx"
  cat > "${fixture_root}/workers/wrangler.proxy.jsonc" <<EOF
{
  "vars": {
    "CF_ACCOUNT_ID": "0123456789abcdef0123456789abcdef",
    "AI_GATEWAY_ID": "${gateway_id}"
  }
}
EOF
  printf '%s\n' "$fixture_root"
}

create_jsonc_fixture() {
  local fixture_root
  fixture_root="$(create_fixture accepts-jsonc actual-gateway)"
  cat > "${fixture_root}/workers/wrangler.proxy.jsonc" <<'EOF'
{
  // Keep this URL to ensure comment stripping does not alter string values.
  "vars": {
    "CF_ACCOUNT_ID": "0123456789abcdef0123456789abcdef",
    "AI_GATEWAY_ID": "actual-gateway",
    "UPSTREAM_URL": "https://example.test/api",
  },
}
EOF
  printf '%s\n' "$fixture_root"
}

run_setup() {
  local fixture_root="$1"
  PATH="${fixture_root}/bin:${PATH}" \
    NPX_CALL_LOG="${fixture_root}/npx.log" \
    PROXY_SECRET="$proxy_secret" \
    bash "${fixture_root}/scripts/setup-free-tier.sh"
}

test_accepts_main_gateway_id() {
  local fixture_root
  fixture_root="$(create_fixture accepts-main main)"

  run_setup "$fixture_root" >/dev/null
  [[ -e "${fixture_root}/npx.log" ]] || fail 'setup did not invoke npx for a valid main gateway'
}

test_rejects_gateway_placeholder() {
  local fixture_root output
  fixture_root="$(create_fixture rejects-placeholder replace-with-ai-gateway-id)"

  if output="$(run_setup "$fixture_root" 2>&1)"; then
    fail 'setup accepted the AI_GATEWAY_ID placeholder'
  fi

  [[ "$output" == *'Set AI_GATEWAY_ID'* ]] || fail 'missing AI_GATEWAY_ID validation error'
  [[ ! -e "${fixture_root}/npx.log" ]] || fail 'setup invoked npx before validation'
}

test_replaces_secret_preserving_other_keys_and_mode() {
  local fixture_root actual expected mode
  fixture_root="$(create_fixture replaces-secret actual-gateway)"
  cat > "${fixture_root}/workers/.dev.vars" <<'EOF'
EXISTING_KEY=kept
PROXY_SECRET=previous-secret
ANOTHER_KEY=also-kept
EOF

  run_setup "$fixture_root" >/dev/null

  actual="$(<"${fixture_root}/workers/.dev.vars")"
  expected=$'EXISTING_KEY=kept\nPROXY_SECRET=abcdefghijklmnopqrstuvwxyzABCDEF\nANOTHER_KEY=also-kept'
  [[ "$actual" == "$expected" ]] || fail '.dev.vars did not preserve non-PROXY_SECRET keys'
  if stat --version >/dev/null 2>&1; then
    mode="$(stat -c '%a' "${fixture_root}/workers/.dev.vars")"
  else
    mode="$(stat -f '%Lp' "${fixture_root}/workers/.dev.vars")"
  fi
  [[ "$mode" == '600' ]] || fail ".dev.vars mode was ${mode}, expected 600"
}

test_appends_secret_preserving_existing_keys() {
  local fixture_root actual expected
  fixture_root="$(create_fixture appends-secret actual-gateway)"
  cat > "${fixture_root}/workers/.dev.vars" <<'EOF'
EXISTING_KEY=kept
ANOTHER_KEY=also-kept
EOF

  run_setup "$fixture_root" >/dev/null

  actual="$(<"${fixture_root}/workers/.dev.vars")"
  expected=$'EXISTING_KEY=kept\nANOTHER_KEY=also-kept\nPROXY_SECRET=abcdefghijklmnopqrstuvwxyzABCDEF'
  [[ "$actual" == "$expected" ]] || fail '.dev.vars did not append PROXY_SECRET only'
}

test_accepts_jsonc_configuration() {
  local fixture_root
  fixture_root="$(create_jsonc_fixture)"

  run_setup "$fixture_root" >/dev/null || fail 'setup rejected valid JSONC configuration'
  [[ -e "${fixture_root}/npx.log" ]] || fail 'setup did not invoke npx for valid JSONC configuration'
}

test_accepts_main_gateway_id
test_rejects_gateway_placeholder
test_replaces_secret_preserving_other_keys_and_mode
test_appends_secret_preserving_existing_keys
test_accepts_jsonc_configuration
printf 'PASS: setup-free-tier regression tests\n'
